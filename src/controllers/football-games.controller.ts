/**
 * Schedule, live scoreboard and game detail for football.
 *
 * College only for now: these read CollegeFootballData, which publishes no NFL data
 * (products are ["cfb","cbb"]). NFL equivalents need ESPN and are deliberately not
 * faked here — an NFL request gets a note saying so rather than an empty page.
 *
 * Three endpoints, three different natures:
 *
 *   /schedule          upcoming and past fixtures. Slow-moving, long TTL.
 *   /scoreboard        live scores, clock, possession. Short TTL, the polling hot path.
 *   /games/:gameId     one game in full. Fans out upstream, so it is the expensive one.
 *
 * The game detail handler is the only place in the football stack that fans out. That is
 * justified here and nowhere else: five sequential client round-trips against the
 * frontend's 60s timeout, on a cold instance, is the realistic failure mode for a page
 * someone opens from a score notification. It uses allSettled so one slow or
 * unentitled feed degrades that panel instead of the page.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { datasetFor } from '../config/football.config';
import {
  resolveSport,
  isMissingTable,
  respondUnavailable,
} from '../utils/football-request';
import {
  cfbdGet,
  CfbdTTL,
  completedTTL,
  isCfbdUnavailable,
  hasApiKey,
} from '../services/cfbd.service';
import { serveCached, serveCachedDynamic } from '../utils/football-cache';
import { getCacheKey } from '../utils/cache-keys';
import { cacheService } from '../services/cache.service';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

/** Classifications the site covers. CFBD also returns DII and DIII, which it does not. */
const SITE_CLASSIFICATIONS = new Set(['fbs', 'fcs']);

/** No feed and no table recognises this game id. */
class GameNotFound extends Error {
  constructor(gameId: string) {
    super(`No game found for id ${gameId}`);
    this.name = 'GameNotFound';
  }
}

/** A panel we cannot even ask for, because the game's week is unknown. */
class NeedsWeek extends Error {
  constructor(panel: string) {
    super(`Cannot load the ${panel} without knowing the game's week — `
      + 'pass ?week= or wait for the pipeline to record this game.');
    this.name = 'NeedsWeek';
  }
}

function seasonParam(req: Request): number {
  const raw = parseInt((req.query.season as string) || '', 10);
  if (Number.isFinite(raw)) return raw;
  const env = parseInt(process.env.CURRENT_SEASON || '', 10);
  return Number.isFinite(env) ? env : new Date().getFullYear();
}

/** Only CFB has a live feed; say so plainly rather than returning an empty scoreboard. */
function requireCollege(res: Response, sportKey: string, resource: string): boolean {
  if (sportKey === 'cfb') return true;
  res.json({
    success: true,
    data: [],
    meta: {
      sport: sportKey,
      count: 0,
      note: `Live ${resource} is college-only for now — the college feed publishes no `
        + 'NFL data, so the NFL equivalent needs a separate source.',
    },
  });
  return false;
}

/** One game, in the shape the scoreboard and schedule both present. */
function normalizeScoreboardGame(g: any) {
  return {
    game_id: String(g.id),
    start_date: g.startDate,
    start_time_tbd: Boolean(g.startTimeTBD),
    status: g.status,
    period: g.period ?? null,
    clock: g.clock ?? null,
    situation: g.situation ?? null,
    possession: g.possession ?? null,
    last_play: g.lastPlay ?? null,
    tv: g.tv ?? null,
    neutral_site: Boolean(g.neutralSite),
    conference_game: Boolean(g.conferenceGame),
    venue: g.venue
      ? { name: g.venue.name, city: g.venue.city, state: g.venue.state }
      : null,
    weather: g.weather ?? null,
    betting: g.betting ?? null,
    home: {
      // These names match the full display form already used as the key in
      // cfb_historical.games and power_rankings, so they join without a crosswalk.
      name: g.homeTeam?.name,
      conference: g.homeTeam?.conference,
      classification: g.homeTeam?.classification,
      points: g.homeTeam?.points ?? null,
      line_scores: g.homeTeam?.lineScores ?? null,
      win_probability: g.homeTeam?.winProbability ?? null,
    },
    away: {
      name: g.awayTeam?.name,
      conference: g.awayTeam?.conference,
      classification: g.awayTeam?.classification,
      points: g.awayTeam?.points ?? null,
      line_scores: g.awayTeam?.lineScores ?? null,
      win_probability: g.awayTeam?.winProbability ?? null,
    },
  };
}

/**
 * GET /api/football/:sport/scoreboard?season=&week=&division=
 *
 * The polling hot path. One upstream call covers every game in the week, so this stays
 * cheap however many people are watching.
 */
export async function getScoreboard(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;
  if (!requireCollege(res, sport.key, 'scoreboard')) return;

  if (!hasApiKey()) {
    respondUnavailable(
      res, sport, 'live scoreboard',
      'Live scores need a CollegeFootballData API key, which is not configured here.',
    );
    return;
  }

  try {
    const season = seasonParam(req);
    const week = req.query.week ? parseInt(req.query.week as string, 10) : undefined;
    const division = ((req.query.division as string) || '').toLowerCase();

    const raw = await cfbdGet<any[]>(
      '/scoreboard',
      { year: season, week, classification: division || undefined },
      CfbdTTL.scoreboard,
    );

    let games = (raw || []).map(normalizeScoreboardGame);
    // CFBD returns DII and DIII alongside FBS/FCS; the site covers only the top two.
    games = games.filter(
      (g) => SITE_CLASSIFICATIONS.has(g.home.classification)
        || SITE_CLASSIFICATIONS.has(g.away.classification),
    );
    if (division) {
      games = games.filter(
        (g) => g.home.classification === division || g.away.classification === division,
      );
    }

    const live = games.filter((g) => g.status === 'in_progress').length;

    res.set('Cache-Control', `public, max-age=${CfbdTTL.scoreboard}`);
    res.json({
      success: true,
      data: games,
      meta: {
        sport: sport.key,
        season,
        week: week ?? null,
        division: division || null,
        count: games.length,
        live,
        source: 'collegefootballdata',
      },
    });
  } catch (error: any) {
    if (isCfbdUnavailable(error)) {
      respondUnavailable(res, sport, 'live scoreboard', error.message);
      return;
    }
    logger.error('football scoreboard failed', { sport: sport.key, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'SCOREBOARD_ERROR', message: 'Failed to load the scoreboard' },
    });
  }
}

/**
 * GET /api/football/:sport/schedule?season=&week=&team=&division=
 *
 * Fixtures rather than scores. Served from the upstream schedule because the BigQuery
 * games tables hold completed games only — there is nothing there for an upcoming week.
 */
export async function getSchedule(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;
  if (!requireCollege(res, sport.key, 'schedule')) return;

  if (!hasApiKey()) {
    respondUnavailable(
      res, sport, 'schedule',
      'Schedules need a CollegeFootballData API key, which is not configured here.',
    );
    return;
  }

  const season = seasonParam(req);
  const week = req.query.week ? parseInt(req.query.week as string, 10) : undefined;
  const team = (req.query.team as string) || undefined;
  const division = ((req.query.division as string) || '').toLowerCase() || undefined;

  const cacheKey = getCacheKey('ftbl:cfb:sched', { season, week, team, division });

  try {
    await serveCached(res, cacheKey, CfbdTTL.schedule, async () => {
      const raw = await cfbdGet<any[]>(
        '/games',
        { year: season, week, team, classification: division },
        CfbdTTL.schedule,
      );

      const games = (raw || [])
        .filter((g) => SITE_CLASSIFICATIONS.has(g.homeClassification)
          || SITE_CLASSIFICATIONS.has(g.awayClassification))
        .map((g) => ({
          game_id: String(g.id),
          season: g.season,
          week: g.week,
          season_type: g.seasonType,
          start_date: g.startDate,
          start_time_tbd: Boolean(g.startTimeTBD),
          completed: Boolean(g.completed),
          neutral_site: Boolean(g.neutralSite),
          conference_game: Boolean(g.conferenceGame),
          venue: g.venue ?? null,
          // NOTE: /games returns the school ("TCU") where /scoreboard returns the full
          // display name ("TCU Horned Frogs"). The display name is what the BigQuery
          // tables key on, so anything joining these rows must join on game_id.
          home_school: g.homeTeam,
          home_conference: g.homeConference,
          home_classification: g.homeClassification,
          home_points: g.homePoints ?? null,
          home_pregame_elo: g.homePregameElo ?? null,
          away_school: g.awayTeam,
          away_conference: g.awayConference,
          away_classification: g.awayClassification,
          away_points: g.awayPoints ?? null,
          away_pregame_elo: g.awayPregameElo ?? null,
          excitement_index: g.excitementIndex ?? null,
        }))
        .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

      return {
        success: true,
        data: games,
        meta: {
          sport: sport.key,
          season,
          week: week ?? null,
          division: division || null,
          count: games.length,
          upcoming: games.filter((g) => !g.completed).length,
          source: 'collegefootballdata',
          join_note: 'Team fields here are school names; join to BigQuery on game_id.',
        },
      };
    });
  } catch (error: any) {
    if (isCfbdUnavailable(error)) {
      respondUnavailable(res, sport, 'schedule', error.message);
      return;
    }
    logger.error('football schedule failed', { sport: sport.key, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'SCHEDULE_ERROR', message: 'Failed to load the schedule' },
    });
  }
}

/**
 * Which week a game belongs to.
 *
 * Needed because /games/teams, /games/players and /drives all require week (or team, or
 * conference) alongside year — an id alone fails validation — and /scoreboard does not
 * return a week field. The client normally knows it, having navigated from a scoreboard
 * or schedule, so it is a query param first; BigQuery is the fallback for a bookmarked
 * link. Where neither answers, the week-dependent panels are skipped with a note rather
 * than the whole page failing.
 */
async function resolveWeek(
  sport: any, gameId: string, fromQuery: string | undefined,
): Promise<number | null> {
  const asked = parseInt(fromQuery || '', 10);
  if (Number.isFinite(asked)) return asked;

  for (const [dataset, table] of [
    [sport.histDataset, sport.gamesTable],
    [sport.seasonDataset, sport.predictionsTable],
  ]) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT week FROM \`${PROJECT}.${dataset}.${table}\`
                WHERE game_id = @gameId LIMIT 1`,
        params: { gameId },
      });
      if (rows[0]?.week !== undefined && rows[0]?.week !== null) {
        return Number(rows[0].week);
      }
    } catch (error: any) {
      logger.debug('week lookup failed', { table, error: error?.message });
    }
  }
  return null;
}

/**
 * Drives for one game.
 *
 * /drives cannot be filtered to a game — it takes year and week, and a single week is
 * about 1,700 drives and 900KB to extract the ~20 that belong to one game. So the raw
 * response is deliberately not cached (it exceeds the store's size limit anyway); the
 * filtered slice is cached under a game-specific key instead, which is what makes the
 * second view of a game cheap.
 */
async function gameDrives(
  gameId: string, season: number, week: number, ttl: number,
): Promise<any[]> {
  const sliceKey = getCacheKey('cfbd:drives:game', { gameId });
  try {
    const hit = await cacheService.get<any[]>(sliceKey);
    if (hit) return hit;
  } catch { /* a cache miss is not a failure */ }

  const all = await cfbdGet<any[]>('/drives', { year: season, week }, ttl);
  const mine = (all || []).filter((d) => String(d.gameId) === gameId);

  try {
    await cacheService.set(sliceKey, mine, ttl);
  } catch { /* best effort */ }
  return mine;
}

/** The model's own pick for this game, if the pipeline has written one. */
async function loadPrediction(sport: any, gameId: string): Promise<any | null> {
  const dataset = sport.seasonDataset;
  const [rows] = await bigquery.query({
    query: `SELECT * FROM \`${PROJECT}.${dataset}.${sport.predictionsTable}\`
            WHERE game_id = @gameId LIMIT 1`,
    params: { gameId },
  });
  return rows[0] || null;
}

/**
 * GET /api/football/:sport/games/:gameId
 *
 * One game, assembled from every feed that has something to say about it. Each panel is
 * independent: a game with no model pick, or a box score the tier does not cover, still
 * renders everything else. `meta.available` and `meta.missing` tell the client which
 * panels to draw, generalising the meta.note convention to a multi-part payload.
 */
export async function getGameDetail(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;
  if (!requireCollege(res, sport.key, 'game detail')) return;

  const gameId = String(req.params.gameId || '').trim();
  if (!/^\d{4,12}$/.test(gameId)) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_GAME_ID', message: 'gameId must be a numeric game id' },
    });
    return;
  }

  if (!hasApiKey()) {
    respondUnavailable(
      res, sport, 'game detail',
      'Game detail needs a CollegeFootballData API key, which is not configured here.',
    );
    return;
  }

  const season = seasonParam(req);
  // Keyed on the game, not on the week hint: the same game must not occupy two entries
  // just because one caller happened to pass ?week=.
  const bodyKey = getCacheKey('ftbl:cfb:game', { gameId, season });

  try {
    await serveCachedDynamic(res, bodyKey, async () => {
    const week = await resolveWeek(sport, gameId, req.query.week as string);

    // Fetched first and alone: it tells us whether the game is finished, which decides
    // how long everything else may be cached. Narrowed by week when we know it.
    const board = await cfbdGet<any[]>(
      '/scoreboard',
      week !== null ? { year: season, week } : { year: season },
      CfbdTTL.scoreboard,
    );
    const boardGame = (board || []).find((g) => String(g.id) === gameId) || null;
    const isCompleted = boardGame?.status === 'completed';
    const boxTTL = completedTTL(CfbdTTL.boxScore, isCompleted);

    // Week-dependent panels. /games/teams, /games/players and /drives all reject a bare
    // year+id, so without a week these cannot be asked for at all.
    const weekScoped = week === null
      ? [
        Promise.reject(new NeedsWeek('team box score')),
        Promise.reject(new NeedsWeek('player box score')),
        Promise.reject(new NeedsWeek('drives')),
      ]
      : [
        cfbdGet<any[]>('/games/teams', { year: season, week, id: gameId }, boxTTL),
        cfbdGet<any[]>('/games/players', { year: season, week, id: gameId }, boxTTL),
        gameDrives(gameId, season, week,
          completedTTL(CfbdTTL.drives, isCompleted)),
      ];

    const settled = await Promise.allSettled([
      cfbdGet<any[]>('/metrics/wp', { gameId },
        completedTTL(CfbdTTL.winProbability, isCompleted)),
      ...weekScoped,
      isCompleted
        ? Promise.resolve([])
        : cfbdGet<any[]>('/live/plays', { gameId }, CfbdTTL.livePlays),
      loadPrediction(sport, gameId),
    ]);

    const panels = ['win_probability', 'team_box', 'player_box', 'drives',
      'live_plays', 'prediction'];
    const data: Record<string, any> = {};
    const available: string[] = [];
    const missing: string[] = [];
    const notes: Record<string, string> = {};

    settled.forEach((result, i) => {
      const panel = panels[i];
      if (result.status === 'fulfilled') {
        const value = result.value;
        const empty = value === null
          || (Array.isArray(value) && value.length === 0);
        data[panel] = value;
        if (empty) {
          missing.push(panel);
        } else {
          available.push(panel);
        }
        return;
      }
      const reason: any = result.reason;
      data[panel] = null;
      missing.push(panel);
      if (isCfbdUnavailable(reason) || reason?.name === 'NeedsWeek') {
        notes[panel] = reason.message;
      } else if (isMissingTable(reason)) {
        notes[panel] = 'Not built yet.';
      } else {
        // A real failure in one panel is logged but must not fail the page.
        logger.warn('football game detail panel failed', {
          sport: sport.key, gameId, panel, error: reason?.message,
        });
        notes[panel] = 'Temporarily unavailable.';
      }
    });

    // Nothing anywhere recognises this id. Thrown rather than answered here so a 404
    // is never cached as if it were a game.
    if (!boardGame && !available.length) {
      throw new GameNotFound(gameId);
    }

    return {
      ttl: isCompleted ? 86400 : CfbdTTL.scoreboard,
      body: {
        success: true,
        data: {
          game: boardGame ? normalizeScoreboardGame(boardGame) : null,
          ...data,
        },
        meta: {
          sport: sport.key,
          season,
          game_id: gameId,
          week,
          completed: isCompleted,
          available,
          missing,
          ...(Object.keys(notes).length ? { notes } : {}),
          source: 'collegefootballdata',
        },
      },
    };
    });
  } catch (error: any) {
    if (error?.name === 'GameNotFound') {
      res.status(404).json({
        success: false,
        error: { code: 'GAME_NOT_FOUND', message: error.message },
      });
      return;
    }
    if (isCfbdUnavailable(error)) {
      respondUnavailable(res, sport, 'game detail', error.message);
      return;
    }
    logger.error('football game detail failed', {
      sport: sport.key, gameId, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'GAME_DETAIL_ERROR', message: 'Failed to load the game' },
    });
  }
}
