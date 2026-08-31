/**
 * Football predictions controller — serves both NFL and CFB off a sport registry.
 *
 * Mounted at /api/football/:sport/*. The legacy /api/nfl/* routes alias onto this so
 * nothing that already points at them breaks.
 *
 * Football never routes through DataSourceService: both feeds are batch-loaded into
 * BigQuery, so there is no live-API fallback to reconcile and no sportId to generalize.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';
import { getFootballSport, FootballSportConfig } from '../config/football.config';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

// Sortable player columns, allow-listed because BigQuery cannot parameterize an
// ORDER BY identifier and the value arrives from the query string.
const NFL_PLAYER_SORT_FIELDS = [
  'passing_yards', 'passing_tds', 'passing_epa', 'passing_interceptions',
  'completions', 'attempts', 'rushing_yards', 'rushing_tds', 'carries',
  'rushing_epa', 'receiving_yards', 'receiving_tds', 'receptions', 'targets',
  'receiving_epa', 'def_sacks', 'def_tackles_solo', 'def_interceptions',
  'def_pass_defended', 'games',
];

function resolveSport(req: Request, res: Response): FootballSportConfig | null {
  const key = (req.params.sport || 'nfl').toLowerCase();
  const sport = getFootballSport(key);
  if (!sport) {
    res.status(404).json({
      success: false,
      error: { code: 'UNKNOWN_SPORT', message: `Unknown football sport: ${key}` },
    });
    return null;
  }
  return sport;
}

function normalizeRow(row: any): any {
  return {
    ...row,
    game_date: normalizeBigQueryTemporalValue(row.game_date),
    predicted_at: normalizeBigQueryTemporalValue(row.predicted_at),
  };
}

/** GET /api/football/:sport/predictions?season=&week=&team=&tier=&division= */
export async function getPredictions(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  try {
    const { season, week, team, tier, division } = req.query as Record<string, string>;
    const filters: string[] = [];
    const params: Record<string, any> = {};

    if (season) { filters.push('season = @season'); params.season = parseInt(season, 10); }
    if (week) { filters.push('week = @week'); params.week = parseInt(week, 10); }
    if (team) {
      filters.push('(UPPER(home_team_name) LIKE @team OR UPPER(away_team_name) LIKE @team)');
      params.team = `%${team.toUpperCase()}%`;
    }
    if (tier) { filters.push('confidence_tier = @tier'); params.tier = tier.toLowerCase(); }
    if (division && sport.hasDivisions) {
      filters.push('division = @division');
      params.division = division.toLowerCase();
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT *
      FROM \`${PROJECT}.${sport.seasonDataset}.${sport.predictionsTable}\`
      ${where}
      ORDER BY season DESC, week DESC, game_date
      LIMIT 500
    `;

    const [rows] = await bigquery.query({ query: sql, params });
    const data = rows.map(normalizeRow);
    res.json({ success: true, data, meta: { sport: sport.key, count: data.length } });
  } catch (error: any) {
    logger.error('football predictions query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'PREDICTIONS_ERROR', message: 'Failed to load predictions' },
    });
  }
}

/** GET /api/football/:sport/predictions/accuracy?season=&division= */
export async function getAccuracy(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  try {
    const season = parseInt((req.query.season as string) || '2025', 10);
    const division = (req.query.division as string || '').toLowerCase();

    const params: Record<string, any> = { season };
    const extra: string[] = [];
    if (division && sport.hasDivisions) {
      extra.push('AND division = @division');
      params.division = division;
    }

    // Vegas baseline only exists where a spread was stored (NFL); CFB's free feed
    // carries no lines, so the column is absent and the baseline comes back null.
    const vegasExpr = sport.key === 'nfl'
      ? `AVG(CASE WHEN spread_line IS NOT NULL AND spread_line != 0
                  THEN IF((spread_line > 0) = (home_won = 1), 1.0, 0.0) END)`
      : 'CAST(NULL AS FLOAT64)';

    const sql = `
      SELECT
        COUNT(*)                                     AS games,
        AVG(CAST(prediction_correct AS FLOAT64))     AS model_accuracy,
        AVG(CAST(home_won AS FLOAT64))               AS always_home_accuracy,
        AVG(IF(elo_home_win_prob IS NULL, NULL,
               IF((elo_home_win_prob > 0.5) = (home_won = 1), 1.0, 0.0)))
                                                     AS elo_accuracy,
        ${vegasExpr}                                 AS vegas_accuracy
      FROM \`${PROJECT}.${sport.seasonDataset}.${sport.predictionsTable}\`
      WHERE season = @season AND prediction_correct IS NOT NULL ${extra.join(' ')}
    `;

    const tierSql = `
      SELECT confidence_tier,
             COUNT(*) AS games,
             AVG(CAST(prediction_correct AS FLOAT64)) AS accuracy
      FROM \`${PROJECT}.${sport.seasonDataset}.${sport.predictionsTable}\`
      WHERE season = @season AND prediction_correct IS NOT NULL ${extra.join(' ')}
      GROUP BY confidence_tier
    `;

    const [[overall]] = await bigquery.query({ query: sql, params });
    const [tiers] = await bigquery.query({ query: tierSql, params });

    res.json({
      success: true,
      data: { sport: sport.key, season, division: division || null, overall, by_tier: tiers },
    });
  } catch (error: any) {
    logger.error('football accuracy query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'ACCURACY_ERROR', message: 'Failed to load accuracy' },
    });
  }
}

/** GET /api/football/:sport/stats/teams — searchable advanced stats (NFL only today). */
export async function searchTeamStats(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  if (!sport.statsTable) {
    res.json({
      success: true,
      data: [],
      meta: {
        sport: sport.key, total: 0, count: 0, sortable_fields: [],
        note: 'No per-team advanced stats feed for this sport yet.',
      },
    });
    return;
  }

  try {
    const {
      season, week, team, search,
      sort = 'off_epa_play', direction = 'desc',
      limit = '100', offset = '0',
    } = req.query as Record<string, string>;

    if (!sport.sortableStatFields.includes(sort)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_SORT',
          message: `sort must be one of: ${sport.sortableStatFields.join(', ')}`,
        },
      });
      return;
    }

    const dir = direction.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const filters: string[] = [];
    const params: Record<string, any> = {
      limit: Math.min(parseInt(limit, 10) || 100, 500),
      offset: parseInt(offset, 10) || 0,
    };

    if (season) { filters.push('season = @season'); params.season = parseInt(season, 10); }
    if (week) { filters.push('week = @week'); params.week = parseInt(week, 10); }
    if (team) { filters.push('team = @team'); params.team = team.toUpperCase(); }
    if (search) { filters.push('LOWER(team) LIKE @search'); params.search = `%${search.toLowerCase()}%`; }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const table = `\`${PROJECT}.${sport.histDataset}.${sport.statsTable}\``;

    const [rows] = await bigquery.query({
      query: `SELECT * FROM ${table} ${where} ORDER BY ${sort} ${dir} LIMIT @limit OFFSET @offset`,
      params,
    });
    const [[{ total }]] = await bigquery.query({
      query: `SELECT COUNT(*) AS total FROM ${table} ${where}`,
      params,
    });

    res.json({
      success: true,
      data: rows,
      meta: {
        sport: sport.key, total, count: rows.length,
        limit: params.limit, offset: params.offset, sort, direction: dir,
        sortable_fields: sport.sortableStatFields,
      },
    });
  } catch (error: any) {
    logger.error('football stats search failed', { sport: sport.key, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'STATS_ERROR', message: 'Failed to search team stats' },
    });
  }
}

/** GET /api/football/:sport/stats/games — searchable game results. */
export async function searchGames(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  try {
    const {
      season, week, team, division,
      limit = '100', offset = '0',
    } = req.query as Record<string, string>;

    const filters: string[] = [];
    const params: Record<string, any> = {
      limit: Math.min(parseInt(limit, 10) || 100, 500),
      offset: parseInt(offset, 10) || 0,
    };

    if (season) { filters.push('season = @season'); params.season = parseInt(season, 10); }
    if (week) { filters.push('week = @week'); params.week = parseInt(week, 10); }
    if (team) {
      filters.push('(UPPER(home_team) LIKE @team OR UPPER(away_team) LIKE @team)');
      params.team = `%${team.toUpperCase()}%`;
    }
    if (division && sport.hasDivisions) {
      filters.push('division = @division');
      params.division = division.toLowerCase();
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT *
      FROM \`${PROJECT}.${sport.histDataset}.${sport.gamesTable}\`
      ${where}
      ORDER BY game_date DESC
      LIMIT @limit OFFSET @offset
    `;

    const [rows] = await bigquery.query({ query: sql, params });
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        ...r, game_date: normalizeBigQueryTemporalValue(r.game_date),
      })),
      meta: { sport: sport.key, count: rows.length, limit: params.limit, offset: params.offset },
    });
  } catch (error: any) {
    logger.error('football games search failed', { sport: sport.key, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'GAMES_ERROR', message: 'Failed to search games' },
    });
  }
}

/**
 * GET /api/football/:sport/stats/leaders?season=&category=&limit=
 *
 * Long-form: one row per (category, rank), so a client can render every category at
 * once or filter to one without a second shape to handle.
 */
export async function getLeaders(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  if (!sport.leadersTable) {
    res.json({
      success: true,
      data: [],
      meta: { sport: sport.key, note: 'No league leaders for this sport yet.' },
    });
    return;
  }

  try {
    const season = parseInt((req.query.season as string) || '', 10);
    if (!Number.isFinite(season)) {
      res.status(400).json({
        success: false,
        error: { code: 'BAD_SEASON', message: 'season is required' },
      });
      return;
    }

    const category = (req.query.category as string) || '';
    const limit = Math.min(parseInt((req.query.limit as string) || '400', 10), 500);

    const filters = ['season = @season'];
    const params: Record<string, any> = { season, limit };
    if (category) {
      filters.push('category = @category');
      params.category = category;
    }

    const table = `${PROJECT}.${sport.seasonDataset}.${sport.leadersTable}`;
    const [rows] = await bigquery.query({
      query: `SELECT * FROM \`${table}\`
              WHERE ${filters.join(' AND ')}
              ORDER BY category_label, rank
              LIMIT @limit`,
      params,
    });

    const categories = Array.from(
      new Map(
        rows.map((r: any) => [r.category, r.category_label])
      ).entries()
    ).map(([key, label]) => ({ key, label }));

    res.json({
      success: true,
      data: rows,
      meta: { sport: sport.key, season, count: rows.length, categories },
    });
  } catch (error: any) {
    if (/not found|does not exist/i.test(error?.message || '')) {
      res.json({
        success: true,
        data: [],
        meta: { sport: sport.key, note: 'League leaders have not been built yet.' },
      });
      return;
    }
    logger.error('football leaders query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'LEADERS_ERROR', message: 'Failed to load league leaders' },
    });
  }
}

/**
 * GET /api/football/:sport/stats/players?season=&search=&position=&sort=&limit=
 *
 * A sport without a player table answers with its own note rather than an error — for
 * college that is a fact about the feed, not a failure.
 */
export async function searchPlayers(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  if (!sport.playerTable) {
    res.json({
      success: true,
      data: [],
      meta: {
        sport: sport.key,
        note: sport.playerNote || 'No per-player stats for this sport yet.',
      },
    });
    return;
  }

  try {
    const season = parseInt((req.query.season as string) || '', 10);
    if (!Number.isFinite(season)) {
      res.status(400).json({
        success: false,
        error: { code: 'BAD_SEASON', message: 'season is required' },
      });
      return;
    }

    const search = (req.query.search as string) || '';
    const position = (req.query.position as string) || '';
    const team = (req.query.team as string) || '';
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10), 0);

    // Sort is interpolated, not parameterized — BigQuery cannot bind an identifier — so
    // it is checked against an allow-list. Never pass the raw value through.
    const requested = (req.query.sort as string) || 'passing_yards';
    const sort = NFL_PLAYER_SORT_FIELDS.includes(requested) ? requested : 'passing_yards';
    const dir = ((req.query.direction as string) || 'desc').toLowerCase() === 'asc'
      ? 'ASC' : 'DESC';

    const filters = ['season = @season'];
    const params: Record<string, any> = { season, limit, offset };
    if (search) {
      filters.push('UPPER(player_display_name) LIKE @search');
      params.search = `%${search.toUpperCase()}%`;
    }
    if (position) {
      filters.push('UPPER(position) = @position');
      params.position = position.toUpperCase();
    }
    if (team) {
      filters.push('UPPER(recent_team) = @team');
      params.team = team.toUpperCase();
    }

    const table = `${PROJECT}.${sport.seasonDataset}.${sport.playerTable}`;
    const where = `WHERE ${filters.join(' AND ')}`;

    const [rows] = await bigquery.query({
      query: `SELECT * FROM \`${table}\` ${where}
              ORDER BY ${sort} ${dir} NULLS LAST
              LIMIT @limit OFFSET @offset`,
      params,
    });
    const [[{ total }]] = await bigquery.query({
      query: `SELECT COUNT(*) AS total FROM \`${table}\` ${where}`,
      params,
    }) as any;

    res.json({
      success: true,
      data: rows,
      meta: {
        sport: sport.key,
        season,
        total,
        count: rows.length,
        limit,
        offset,
        sort,
        direction: dir,
        sortable_fields: NFL_PLAYER_SORT_FIELDS,
      },
    });
  } catch (error: any) {
    if (/not found|does not exist/i.test(error?.message || '')) {
      res.json({
        success: true,
        data: [],
        meta: { sport: sport.key, note: 'Player stats have not been built yet.' },
      });
      return;
    }
    logger.error('football player search failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'PLAYERS_ERROR', message: 'Failed to load player stats' },
    });
  }
}

/**
 * GET /api/football/:sport/predictions/diagnostics
 *   ?season=&seasons=&division=&fromWeek=&toWeek=
 *
 * Scored predictions joined with what actually happened, one row per game, in the same
 * shape the MLB diagnostics page consumes so the frontend maths is shared.
 *
 * Unlike MLB this needs no external join: the football pipeline stores `home_won`,
 * `actual_winner` and `prediction_correct` when it scores a week. Brier and log loss
 * are computed here rather than stored, so a change to either definition does not
 * require rewriting history.
 */
export async function getDiagnostics(req: Request, res: Response): Promise<void> {
  const sport = resolveSport(req, res);
  if (!sport) return;

  try {
    const { season, seasons, division, fromWeek, toWeek } = req.query as Record<string, string>;

    // home_won is required as well as prediction_correct: Brier and log loss are
    // derived from it, and a row scored without it would look correctly scored while
    // reporting the wrong error on every game.
    const filters = ['prediction_correct IS NOT NULL', 'home_won IS NOT NULL'];
    const params: Record<string, any> = {};

    // `seasons` takes a comma list so the page can compare years in one request;
    // `season` stays supported for a single year.
    const seasonList = (seasons || season || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter(Number.isFinite);
    if (seasonList.length) {
      filters.push('season IN UNNEST(@seasons)');
      params.seasons = seasonList;
    }

    if (division && sport.hasDivisions) {
      filters.push('division = @division');
      params.division = division.toLowerCase();
    }
    if (fromWeek) { filters.push('week >= @fromWeek'); params.fromWeek = parseInt(fromWeek, 10); }
    if (toWeek) { filters.push('week <= @toWeek'); params.toWeek = parseInt(toWeek, 10); }

    const table = `${PROJECT}.${sport.seasonDataset}.${sport.predictionsTable}`;
    const sql = `
      SELECT *
      FROM \`${table}\`
      WHERE ${filters.join(' AND ')}
      ORDER BY season, week, game_date
      LIMIT 6000
    `;

    const [rows] = await bigquery.query({ query: sql, params });

    // Clamped so a probability of exactly 0 or 1 cannot produce an infinite log loss.
    const clamp = (p: number) => Math.min(Math.max(p, 1e-6), 1 - 1e-6);

    const diagnostics = rows.map((r: any) => {
      const homeProb = clamp(Number(r.home_win_probability));
      const awayProb = 1 - homeProb;
      const homeWon = Number(r.home_won) === 1;
      const predictedWinner = r.predicted_winner
        || (homeProb >= 0.5 ? r.home_team_name : r.away_team_name);
      const predictedIsHome = predictedWinner === r.home_team_name;

      return {
        gameId: r.game_id,
        gameDate: normalizeBigQueryTemporalValue(r.game_date),
        season: r.season,
        week: r.week,
        division: r.division ?? null,
        homeTeamName: r.home_team_name,
        awayTeamName: r.away_team_name,
        homeWinProbability: homeProb,
        awayWinProbability: awayProb,
        predictedWinner,
        predictedWinProbability: predictedIsHome ? homeProb : awayProb,
        actualWinner: r.actual_winner,
        actualHomeWin: homeWon,
        confidenceTier: (r.confidence_tier || 'low').toUpperCase(),
        modelVersion: r.model_version || 'unknown',
        edge: Math.abs(homeProb - awayProb),
        correct: Number(r.prediction_correct) === 1,
        brierScore: (homeProb - (homeWon ? 1 : 0)) ** 2,
        logLoss: homeWon ? -Math.log(homeProb) : -Math.log(clamp(awayProb)),
        // Football-specific context the page can slice by.
        neutralSite: Boolean(r.neutral_site),
        isDivisional: Boolean(r.is_divisional),
        crossDivision: Boolean(r.cross_division),
        spreadLine: r.spread_line ?? null,
        vegasImpliedHomeProb: r.vegas_implied_home_prob ?? null,
        // Did the closing favourite win? Null wherever no line was stored (all of CFB).
        vegasCorrect: r.spread_line == null || Number(r.spread_line) === 0
          ? null
          : (Number(r.spread_line) > 0) === homeWon,
      };
    });

    const seasonsPresent = [...new Set(diagnostics.map((d: any) => d.season))].sort();
    const weeks = diagnostics.map((d: any) => d.week).filter((w: any) => w != null);
    const models = [...new Set(diagnostics.map((d: any) => d.modelVersion))];

    res.json({
      success: true,
      diagnostics,
      meta: {
        sport: sport.key,
        division: params.division ?? null,
        count: diagnostics.length,
        seasons: seasonsPresent,
        models,
        weekRange: weeks.length ? [Math.min(...weeks), Math.max(...weeks)] : null,
        hasVegas: diagnostics.some((d: any) => d.vegasCorrect !== null),
      },
    });
  } catch (error: any) {
    if (/not found|does not exist/i.test(error?.message || '')) {
      res.json({
        success: true,
        diagnostics: [],
        meta: { sport: sport.key, count: 0, note: 'No scored predictions yet.' },
      });
      return;
    }
    logger.error('football diagnostics query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'DIAGNOSTICS_ERROR', message: 'Failed to load diagnostics' },
    });
  }
}
