/**
 * The pick'em contest: pick sheet, submissions, and the public leaderboard.
 *
 * Two rules are enforced here and nowhere else, because a client cannot be trusted with
 * either:
 *
 *   The kickoff lock. A pick is editable until its own game starts — per game, not per
 *   week, so a Thursday game locks while Sunday's are still open. The cutoff is read
 *   from pickem.games at write time and compared against the server clock; a client
 *   clock is not evidence.
 *
 *   The side, not the team. A pick stores 'home' or 'away'. The two sports disagree
 *   about how a team is spelled, and the same feed disagrees with itself, so a stored
 *   team name is a pick that can be orphaned by a rename. The UI shows names; the
 *   record keeps sides.
 *
 * Grading lives in BigQuery views (pickem.graded_picks and the two leaderboards), so
 * this file never scores anything — a result landing in pickem.games grades the picks
 * that depend on it immediately, with nothing scheduled that can fall behind.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';
import { isMissingTable } from '../utils/football-request';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const DATASET = process.env.PICKEM_DATASET || 'pickem';
const bigquery = new BigQuery({ projectId: PROJECT });

const SPORTS = new Set(['nfl', 'cfb']);
const PICK_TYPES = new Set(['ats', 'su']);
const SIDES = new Set(['home', 'away']);

/** A week's sheet is capped: the college slate runs to hundreds of games. */
const MAX_GAMES = 400;
const MAX_PICKS_PER_REQUEST = 100;

const T = (name: string) => `\`${PROJECT}.${DATASET}.${name}\``;

function currentSeason(): number {
  const env = parseInt(process.env.CURRENT_SEASON || '', 10);
  return Number.isFinite(env) ? env : new Date().getFullYear();
}

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ success: false, error: { code, message } });
}

function normalizeGame(row: any): any {
  return {
    ...row,
    kickoff: normalizeBigQueryTemporalValue(row.kickoff),
    created_at: normalizeBigQueryTemporalValue(row.created_at),
    updated_at: normalizeBigQueryTemporalValue(row.updated_at),
  };
}

/**
 * GET /api/pickem/games?sport=&season=&week=
 *
 * The week's sheet. Every game carries `locked`, computed server-side, so the UI never
 * has to decide from a client clock whether a game is still open.
 *
 * Anonymous callers get the sheet without picks; a signed-in caller gets their own picks
 * merged in, which is what makes this one request rather than two.
 */
export async function getWeekGames(req: Request, res: Response): Promise<void> {
  const sport = String(req.query.sport || 'nfl').toLowerCase();
  if (!SPORTS.has(sport)) {
    return badRequest(res, 'UNKNOWN_SPORT', `sport must be one of: nfl, cfb`);
  }

  const season = parseInt(String(req.query.season || ''), 10) || currentSeason();
  const weekRaw = req.query.week;

  try {
    // No week given: the earliest week that still has an unplayed game, which is the
    // one a visitor almost always wants.
    let week = parseInt(String(weekRaw || ''), 10);
    if (!Number.isFinite(week)) {
      const [rows] = await bigquery.query({
        query: `SELECT MIN(week) AS week FROM ${T('games')}
                WHERE sport = @sport AND season = @season AND NOT completed`,
        params: { sport, season },
      });
      week = rows[0]?.week ?? 1;
    }

    const [games] = await bigquery.query({
      query: `
        SELECT
          game_id, sport, division, season, week, kickoff, start_time_tbd,
          home_team, away_team, home_display, away_display,
          home_conference, away_conference, neutral_site,
          spread_line, total_line, home_score, away_score, completed,
          -- The lock, decided by the server clock against this game's own kickoff.
          -- A game with no posted kickoff is treated as open until it completes,
          -- rather than locked forever by a null.
          (completed OR (kickoff IS NOT NULL AND kickoff <= CURRENT_TIMESTAMP()))
            AS locked
        FROM ${T('games')}
        WHERE sport = @sport AND season = @season AND week = @week
        ORDER BY kickoff NULLS LAST, home_display
        LIMIT ${MAX_GAMES}`,
      params: { sport, season, week },
    });

    // Weeks that exist at all, so the UI can build its week bar without guessing.
    const [weeks] = await bigquery.query({
      query: `SELECT DISTINCT week FROM ${T('games')}
              WHERE sport = @sport AND season = @season ORDER BY week`,
      params: { sport, season },
    });

    let picks: any[] = [];
    if (req.user) {
      const [rows] = await bigquery.query({
        query: `SELECT game_id, pick_type, selected, spread_at_pick, updated_at
                FROM ${T('picks')}
                WHERE user_id = @userId AND sport = @sport
                  AND season = @season AND week = @week`,
        params: { userId: req.user.userId, sport, season, week },
      });
      picks = rows.map((r: any) => ({
        ...r, updated_at: normalizeBigQueryTemporalValue(r.updated_at),
      }));
    }

    res.json({
      success: true,
      data: games.map(normalizeGame),
      meta: {
        sport,
        season,
        week,
        weeks: weeks.map((w: any) => w.week),
        count: games.length,
        open: games.filter((g: any) => !g.locked).length,
        signed_in: Boolean(req.user),
        picks,
        // Stated rather than implied: a sheet where most games have no line still
        // supports straight-up picks, and the UI should say so.
        with_spread: games.filter((g: any) => g.spread_line !== null).length,
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({
        success: true,
        data: [],
        meta: { sport, season, note: 'The contest tables are not built yet.' },
      });
      return;
    }
    logger.error('pickem games failed', { sport, season, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'PICKEM_GAMES_ERROR', message: 'Failed to load the week' },
    });
  }
}

/**
 * PUT /api/pickem/picks
 *
 * Body: { sport, season, week, picks: [{ game_id, pick_type, selected }] }
 *
 * Upsert, not append: pick_id is derived from (user, game, type), so re-submitting a
 * game replaces that pick rather than adding a second one. Locked games are rejected
 * individually and reported back — a sheet where one game has kicked off should still
 * save the other nine rather than failing wholesale.
 */
export async function submitPicks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { sport, season, week, picks } = req.body || {};

  const sportKey = String(sport || '').toLowerCase();
  if (!SPORTS.has(sportKey)) {
    return badRequest(res, 'UNKNOWN_SPORT', 'sport must be one of: nfl, cfb');
  }
  const seasonNum = parseInt(String(season), 10);
  const weekNum = parseInt(String(week), 10);
  if (!Number.isFinite(seasonNum) || !Number.isFinite(weekNum)) {
    return badRequest(res, 'BAD_WEEK', 'season and week are required');
  }
  if (!Array.isArray(picks) || !picks.length) {
    return badRequest(res, 'NO_PICKS', 'picks must be a non-empty array');
  }
  if (picks.length > MAX_PICKS_PER_REQUEST) {
    return badRequest(res, 'TOO_MANY_PICKS',
      `at most ${MAX_PICKS_PER_REQUEST} picks per request`);
  }

  // Shape-check everything before touching BigQuery, so a malformed body costs nothing.
  const cleaned: Array<{ gameId: string; pickType: string; selected: string }> = [];
  for (const p of picks) {
    const gameId = String(p?.game_id ?? '').trim();
    const pickType = String(p?.pick_type ?? '').toLowerCase();
    const selected = String(p?.selected ?? '').toLowerCase();
    if (!gameId || !PICK_TYPES.has(pickType) || !SIDES.has(selected)) {
      return badRequest(res, 'BAD_PICK',
        'each pick needs game_id, pick_type (ats|su) and selected (home|away)');
    }
    cleaned.push({ gameId, pickType, selected });
  }

  try {
    // The authoritative state of every game being picked: does it exist in this week,
    // has it kicked off, and what is the line right now. Trusting the body for any of
    // this would let a caller pick a game that has finished.
    const [gameRows] = await bigquery.query({
      query: `
        SELECT game_id, spread_line,
               (completed OR (kickoff IS NOT NULL AND kickoff <= CURRENT_TIMESTAMP()))
                 AS locked
        FROM ${T('games')}
        WHERE sport = @sport AND season = @season AND week = @week
          AND game_id IN UNNEST(@ids)`,
      params: {
        sport: sportKey, season: seasonNum, week: weekNum,
        ids: cleaned.map((c) => c.gameId),
      },
    });

    const byId = new Map(gameRows.map((g: any) => [String(g.game_id), g]));
    const accepted: any[] = [];
    const rejected: Array<{ game_id: string; reason: string }> = [];

    for (const c of cleaned) {
      const game = byId.get(c.gameId);
      if (!game) {
        rejected.push({ game_id: c.gameId, reason: 'not in this week' });
        continue;
      }
      if (game.locked) {
        rejected.push({ game_id: c.gameId, reason: 'kicked off' });
        continue;
      }
      if (c.pickType === 'ats' && game.spread_line === null) {
        // An ATS pick with no line has nothing to grade against.
        rejected.push({ game_id: c.gameId, reason: 'no spread posted' });
        continue;
      }
      accepted.push({
        pick_id: `${user.userId}|${c.gameId}|${c.pickType}`,
        user_id: user.userId,
        sport: sportKey,
        season: seasonNum,
        week: weekNum,
        game_id: c.gameId,
        pick_type: c.pickType,
        selected: c.selected,
        // The line as it stands now, which is what the user was shown. ATS grades
        // against this rather than the close, so a later move cannot lose their pick.
        spread_at_pick: game.spread_line,
      });
    }

    if (accepted.length) {
      await upsertUser(user);
      await upsertPicks(accepted);
    }

    res.json({
      success: true,
      data: { accepted: accepted.length, rejected },
      meta: {
        sport: sportKey, season: seasonNum, week: weekNum,
        // Partial success is the normal case mid-week, not an error.
        note: rejected.length
          ? `${accepted.length} saved, ${rejected.length} rejected.`
          : `${accepted.length} saved.`,
      },
    });
  } catch (error: any) {
    logger.error('pickem submit failed', { user: user.userId, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'PICKEM_SUBMIT_ERROR', message: 'Failed to save picks' },
    });
  }
}

/** Record who the leaderboard is naming. Upsert so a renamed account updates. */
async function upsertUser(user: any): Promise<void> {
  await bigquery.query({
    query: `
      MERGE ${T('users')} AS t
      USING (SELECT @userId AS user_id, @email AS email,
                    @displayName AS display_name, @pictureUrl AS picture_url) AS s
      ON t.user_id = s.user_id
      WHEN MATCHED THEN UPDATE SET
        email = s.email, display_name = s.display_name,
        picture_url = s.picture_url, last_seen_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN INSERT
        (user_id, email, display_name, picture_url, created_at, last_seen_at)
        VALUES (s.user_id, s.email, s.display_name, s.picture_url,
                CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    params: {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      pictureUrl: user.pictureUrl,
    },
  });
}

/**
 * Upsert a batch of picks in one statement.
 *
 * One MERGE rather than a statement per pick: BigQuery meters DML per table per day,
 * and a ten-game sheet saved a few times over a week would otherwise be a hundred
 * statements instead of a handful.
 */
async function upsertPicks(rows: any[]): Promise<void> {
  const values = rows.map((_, i) => `(
      @pickId${i}, @userId${i}, @sport${i}, @season${i}, @week${i},
      @gameId${i}, @pickType${i}, @selected${i}, @spread${i}
    )`).join(', ');

  const params: Record<string, any> = {};
  const types: Record<string, any> = {};
  rows.forEach((r, i) => {
    params[`pickId${i}`] = r.pick_id;
    params[`userId${i}`] = r.user_id;
    params[`sport${i}`] = r.sport;
    params[`season${i}`] = r.season;
    params[`week${i}`] = r.week;
    params[`gameId${i}`] = r.game_id;
    params[`pickType${i}`] = r.pick_type;
    params[`selected${i}`] = r.selected;
    params[`spread${i}`] = r.spread_at_pick;
    // Declared because a null spread is otherwise an untyped parameter BigQuery rejects.
    types[`spread${i}`] = 'FLOAT64';
  });

  await bigquery.query({
    query: `
      MERGE ${T('picks')} AS t
      USING (
        SELECT * FROM UNNEST([
          STRUCT<pick_id STRING, user_id STRING, sport STRING, season INT64,
                 week INT64, game_id STRING, pick_type STRING, selected STRING,
                 spread_at_pick FLOAT64>
          ${values}
        ])
      ) AS s
      ON t.pick_id = s.pick_id
      WHEN MATCHED THEN UPDATE SET
        selected = s.selected,
        spread_at_pick = s.spread_at_pick,
        updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN INSERT
        (pick_id, user_id, sport, season, week, game_id, pick_type, selected,
         spread_at_pick, created_at, updated_at)
        VALUES (s.pick_id, s.user_id, s.sport, s.season, s.week, s.game_id,
                s.pick_type, s.selected, s.spread_at_pick,
                CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
    params,
    types,
  });
}

/**
 * GET /api/pickem/leaderboard?sport=&season=&week=&pick_type=
 *
 * Public. Omit `week` for season standings.
 *
 * Every row carries the market's record on that user's own games, which is the only
 * honest comparison — someone who picked six games is not comparable to the market
 * across sixty.
 */
export async function getLeaderboard(req: Request, res: Response): Promise<void> {
  const sport = String(req.query.sport || 'nfl').toLowerCase();
  if (!SPORTS.has(sport)) {
    return badRequest(res, 'UNKNOWN_SPORT', 'sport must be one of: nfl, cfb');
  }
  const pickType = String(req.query.pick_type || 'ats').toLowerCase();
  if (!PICK_TYPES.has(pickType)) {
    return badRequest(res, 'BAD_PICK_TYPE', 'pick_type must be ats or su');
  }
  const season = parseInt(String(req.query.season || ''), 10) || currentSeason();
  const week = parseInt(String(req.query.week || ''), 10);
  const weekly = Number.isFinite(week);

  try {
    const [rows] = await bigquery.query({
      query: weekly
        ? `SELECT * FROM ${T('leaderboard_weekly')}
           WHERE season=@season AND sport=@sport AND pick_type=@pickType AND week=@week
           ORDER BY wins DESC, win_pct DESC, picks_graded DESC LIMIT 200`
        : `SELECT * FROM ${T('leaderboard_season')}
           WHERE season=@season AND sport=@sport AND pick_type=@pickType
           ORDER BY wins DESC, win_pct DESC, picks_graded DESC LIMIT 200`,
      params: weekly
        ? { season, sport, pickType, week }
        : { season, sport, pickType },
    });

    res.json({
      success: true,
      data: rows.map((r: any, i: number) => ({ rank: i + 1, ...r })),
      meta: {
        sport, season, pick_type: pickType,
        week: weekly ? week : null,
        scope: weekly ? 'week' : 'season',
        count: rows.length,
        you: req.user?.userId ?? null,
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({
        success: true,
        data: [],
        meta: { sport, season, note: 'No picks have been made yet.' },
      });
      return;
    }
    logger.error('pickem leaderboard failed', { sport, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'PICKEM_LEADERBOARD_ERROR', message: 'Failed to load the leaderboard' },
    });
  }
}

/**
 * GET /api/pickem/me?sport=&season=&week=
 *
 * The signed-in user's own graded picks, which the leaderboard cannot show: it
 * aggregates, and someone reviewing their week wants the individual results.
 */
export async function getMyPicks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const sport = String(req.query.sport || '').toLowerCase();
  const season = parseInt(String(req.query.season || ''), 10) || currentSeason();
  const week = parseInt(String(req.query.week || ''), 10);

  const filters = ['user_id = @userId', 'season = @season'];
  const params: Record<string, any> = { userId: user.userId, season };
  if (SPORTS.has(sport)) { filters.push('sport = @sport'); params.sport = sport; }
  if (Number.isFinite(week)) { filters.push('week = @week'); params.week = week; }

  try {
    const [rows] = await bigquery.query({
      query: `
        SELECT sport, season, week, game_id, pick_type, selected,
               graded_spread, closing_spread, margin, home_display, away_display,
               home_score, away_score, completed, kickoff,
               winning_side, covering_side, is_correct, is_push,
               vegas_side, vegas_correct, took_underdog, updated_at
        FROM ${T('graded_picks')}
        WHERE ${filters.join(' AND ')}
        ORDER BY week DESC, kickoff
        LIMIT 500`,
      params,
    });

    const graded = rows.filter((r: any) => r.is_correct !== null);
    res.json({
      success: true,
      data: rows.map(normalizeGame),
      meta: {
        season,
        sport: SPORTS.has(sport) ? sport : null,
        week: Number.isFinite(week) ? week : null,
        count: rows.length,
        record: {
          wins: graded.filter((r: any) => r.is_correct === true).length,
          losses: graded.filter((r: any) => r.is_correct === false).length,
          pushes: rows.filter((r: any) => r.is_push).length,
          pending: rows.length - graded.length - rows.filter((r: any) => r.is_push).length,
        },
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({ success: true, data: [], meta: { note: 'No picks yet.' } });
      return;
    }
    logger.error('pickem me failed', { user: user.userId, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'PICKEM_ME_ERROR', message: 'Failed to load your picks' },
    });
  }
}

/** GET /api/pickem/config — what the browser needs to render a sign-in button. */
export function getConfig(_req: Request, res: Response): void {
  res.json({
    success: true,
    data: {
      google_client_id: process.env.GOOGLE_CLIENT_ID || null,
      auth_configured: Boolean(process.env.GOOGLE_CLIENT_ID),
      season: currentSeason(),
      sports: ['nfl', 'cfb'],
      pick_types: ['ats', 'su'],
    },
  });
}
