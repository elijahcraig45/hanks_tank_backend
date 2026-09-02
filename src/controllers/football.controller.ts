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
import { FootballSportConfig, datasetFor } from '../config/football.config';
import { getColumnCatalog, resolveColumns } from '../config/football-columns.config';
import {
  resolveSport,
  normalizeRow,
  isMissingTable,
} from '../utils/football-request';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

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
    // A sport whose predictions table has not been built yet is an expected state, not
    // an outage. Every other football handler already answered that with a note; this
    // one went straight to 500, so a missing table read as a server error.
    if (isMissingTable(error)) {
      logger.warn('football accuracy table unavailable', {
        sport: sport.key, error: error.message,
      });
      res.json({
        success: true,
        data: null,
        meta: {
          sport: sport.key,
          label: sport.label,
          note: `${sport.label} predictions are not built yet.`,
        },
      });
      return;
    }
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
    // Says what IS available rather than only what is not. The old wording — "no
    // per-team advanced stats feed for this sport yet" — was already false: college
    // season totals were sitting in BigQuery the whole time, just unreachable.
    const seasonPath = sport.teamSeasonTable
      ? `/api/football/${sport.key}/stats/teams/season`
      : null;
    res.json({
      success: true,
      data: [],
      meta: {
        sport: sport.key, label: sport.label, scope: 'week',
        total: 0, count: 0, sortable_fields: [],
        season_endpoint: seasonPath,
        note: seasonPath
          ? `${sport.label} has no per-week feed yet — season totals are at ${seasonPath}.`
          : `${sport.label} has no per-week stats feed yet.`,
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

    const physical = (key: string) => (sport.statsFieldMap || {})[key] || key;

    if (season) { filters.push('season = @season'); params.season = parseInt(season, 10); }
    if (week) { filters.push('week = @week'); params.week = parseInt(week, 10); }
    if (team) {
      // College team names are full display names ("Ohio State Buckeyes"); NFL are
      // abbreviations. Matching case-insensitively on a prefix serves both without the
      // caller needing to know which convention a sport uses.
      filters.push(`LOWER(\`${physical('team')}\`) LIKE @team`);
      params.team = `${team.toLowerCase()}%`;
    }
    if (search) {
      filters.push(`LOWER(\`${physical('team')}\`) LIKE @search`);
      params.search = `%${search.toLowerCase()}%`;
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const table =
      `\`${PROJECT}.${datasetFor(sport, sport.statsDataset)}.${sport.statsTable}\``;

    // Projected from the catalog rather than SELECT *. This table is only 17 columns,
    // so the win is not payload size — it is that both stats endpoints now describe
    // what they returned in meta.columns, and the client renders from that instead of
    // hardcoding one sport's column names.
    const catalog = getColumnCatalog(sport.statsColumnCatalog);
    const projection = catalog ? catalog.columns : [];
    const fieldMap = sport.statsFieldMap || {};

    // Physical column AS canonical name. This is the whole mechanism that lets one
    // client table render both sports: the NFL table stores per-play EPA and the
    // college one stores PPA, and the alias reconciles them here rather than in the UI.
    const select = projection.length
      ? projection
        .map((c) => {
          const physical = fieldMap[c.key] || c.key;
          return physical === c.key
            ? `\`${c.key}\``
            : `\`${physical}\` AS \`${c.key}\``;
        })
        .join(', ')
      : '*';

    // ORDER BY has to name the physical column; the allow-list validated the canonical
    // one, so the interpolated value is still never caller-controlled.
    const sortColumn = fieldMap[sort] || sort;

    const [rows] = await bigquery.query({
      query: `SELECT ${select} FROM ${table} ${where} `
        + `ORDER BY \`${sortColumn}\` ${dir} LIMIT @limit OFFSET @offset`,
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
        sport: sport.key, label: sport.label, scope: 'week',
        total, count: rows.length,
        limit: params.limit, offset: params.offset, sort, direction: dir,
        sortable_fields: sport.sortableStatFields,
        groups: catalog
          ? catalog.groups.map((gr) => ({
              key: gr.key,
              label: gr.label,
              count: catalog.columns.filter((c) => c.group === gr.key).length,
            }))
          : [],
        columns: projection.map((c) => ({
          key: c.key,
          label: c.label,
          group: c.group,
          format: c.format,
          higher_is_better: c.higherIsBetter ?? null,
          opponent: c.opponent ?? false,
        })),
        season_endpoint: sport.teamSeasonTable
          ? `/api/football/${sport.key}/stats/teams/season`
          : null,
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
    // Default sized to hold every board: college now publishes 17 categories at 25
    // deep, which is 425 rows and overflowed the old 400.
    const limit = Math.min(parseInt((req.query.limit as string) || '600', 10), 1200);

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

    // Derived from a DISTINCT rather than from the rows just returned. Building the
    // client's category tabs out of a limited page means a truncating limit silently
    // drops whole boards from the UI, which is a bug that looks like missing data.
    const [categoryRows] = await bigquery.query({
      query: `SELECT DISTINCT category, category_label,
                     ANY_VALUE(higher_is_better) AS higher_is_better,
                     ANY_VALUE(qualifier) AS qualifier
              FROM \`${table}\`
              WHERE season = @season
              GROUP BY category, category_label
              ORDER BY category_label`,
      params: { season },
    });

    const categories = categoryRows.map((r: any) => ({
      key: r.category,
      label: r.category_label,
      higher_is_better: r.higher_is_better ?? null,
      // Present where a board has a volume floor, so a short board can explain itself
      // rather than looking broken.
      qualifier: r.qualifier ?? null,
    }));

    res.json({
      success: true,
      data: rows,
      meta: { sport: sport.key, season, count: rows.length, categories },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
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
    // it is checked against the sport's allow-list. Never pass the raw value through.
    const allowedSort = sport.playerSortFields;
    const requested = (req.query.sort as string) || allowedSort[0];
    const sort = allowedSort.includes(requested) ? requested : allowedSort[0];
    const dir = ((req.query.direction as string) || 'desc').toLowerCase() === 'asc'
      ? 'ASC' : 'DESC';

    // The two sports name their identity columns differently — nflverse calls them
    // player_display_name and recent_team, the college pivot calls them player_name and
    // team — so the filters resolve through the sport's map rather than hardcoding one.
    const pf = sport.playerFieldMap || {};
    const nameCol = pf.player_name || 'player_name';
    const teamCol = pf.team || 'team';

    const filters = ['season = @season'];
    const params: Record<string, any> = { season, limit, offset };
    if (search) {
      filters.push(`UPPER(\`${nameCol}\`) LIKE @search`);
      params.search = `%${search.toUpperCase()}%`;
    }
    if (position) {
      filters.push('UPPER(position) = @position');
      params.position = position.toUpperCase();
    }
    if (team) {
      filters.push(`UPPER(\`${teamCol}\`) LIKE @team`);
      params.team = `${team.toUpperCase()}%`;
    }

    const table = `${PROJECT}.${sport.seasonDataset}.${sport.playerTable}`;
    const where = `WHERE ${filters.join(' AND ')}`;

    const catalog = getColumnCatalog(sport.playerColumnCatalog);
    // Same group/fields narrowing as the team endpoints: the NFL table is 148 columns
    // wide, so a default that sends all of them would be the site's heaviest response.
    const resolved = catalog
      ? resolveColumns(catalog, {
        fields: req.query.fields as string,
        group: req.query.group as string,
      })
      : { columns: [], unknown: [] as string[] };

    // The sort column has to be in the projection for BigQuery to order by it.
    const picked = new Map(resolved.columns.map((c) => [c.key, c]));
    if (catalog && !picked.has(sort)) {
      const spec = catalog.columns.find((c) => c.key === sort);
      if (spec) picked.set(sort, spec);
    }
    const projectionCols = [...picked.values()];

    const projection = projectionCols.length
      ? projectionCols.map((c) => {
        const phys = pf[c.key] || c.key;
        return phys === c.key ? `\`${c.key}\`` : `\`${phys}\` AS \`${c.key}\``;
      }).join(', ')
      : '*';

    const [rows] = await bigquery.query({
      query: `SELECT ${projection} FROM \`${table}\` ${where}
              ORDER BY \`${pf[sort] || sort}\` ${dir} NULLS LAST
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
        sortable_fields: allowedSort,
        columns: projectionCols.map((c) => ({
          key: c.key, label: c.label, group: c.group, format: c.format,
          higher_is_better: c.higherIsBetter ?? null,
          opponent: c.opponent ?? false,
        })),
        groups: catalog
          ? catalog.groups.map((gr) => ({
            key: gr.key,
            label: gr.label,
            count: catalog.columns.filter((c) => c.group === gr.key).length,
          }))
          : [],
        group: req.query.fields ? null : ((req.query.group as string) || 'core'),
        ...(resolved.unknown.length ? { unknown_fields: resolved.unknown } : {}),
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
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
    if (isMissingTable(error)) {
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
