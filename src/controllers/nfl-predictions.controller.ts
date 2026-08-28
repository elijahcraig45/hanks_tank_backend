/**
 * NFL Predictions Controller
 *
 * Reads predictions and searchable team stats from the nfl_* BigQuery datasets.
 * Deliberately a parallel implementation to predictions.controller.ts rather than a
 * parameterized one: the MLB controller selects ~90 baseball-specific columns and
 * joins lineup/matchup CTEs that have no football analogue.
 *
 * NFL never routes through DataSourceService — nflverse is batch-loaded to BigQuery,
 * so there is no live-API fallback path to reconcile.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const SEASON_DS = process.env.NFL_DATASET || 'nfl_season';
const HIST_DS = process.env.NFL_HIST_DATASET || 'nfl_historical';

const bigquery = new BigQuery({ projectId: PROJECT });

function normalizeRow(row: any): any {
  return {
    ...row,
    game_date: normalizeBigQueryTemporalValue(row.game_date),
    predicted_at: normalizeBigQueryTemporalValue(row.predicted_at),
  };
}

/** GET /api/nfl/predictions?season=&week=&team=&tier= */
export async function getNflPredictions(req: Request, res: Response): Promise<void> {
  try {
    const { season, week, team, tier } = req.query as Record<string, string>;

    const filters: string[] = [];
    const params: Record<string, any> = {};

    if (season) {
      filters.push('season = @season');
      params.season = parseInt(season, 10);
    }
    if (week) {
      filters.push('week = @week');
      params.week = parseInt(week, 10);
    }
    if (team) {
      filters.push('(home_team_name = @team OR away_team_name = @team)');
      params.team = team.toUpperCase();
    }
    if (tier) {
      filters.push('confidence_tier = @tier');
      params.tier = tier.toLowerCase();
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT *
      FROM \`${PROJECT}.${SEASON_DS}.game_predictions\`
      ${where}
      ORDER BY season DESC, week DESC, game_date
      LIMIT 500
    `;

    const [rows] = await bigquery.query({ query: sql, params });
    const data = rows.map(normalizeRow);

    res.json({
      success: true,
      data,
      meta: { count: data.length, season: params.season, week: params.week },
    });
  } catch (error: any) {
    logger.error('NFL predictions query failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'NFL_PREDICTIONS_ERROR', message: 'Failed to load NFL predictions' },
    });
  }
}

/** GET /api/nfl/predictions/accuracy?season= — model vs baselines, for the results view. */
export async function getNflAccuracy(req: Request, res: Response): Promise<void> {
  try {
    const season = parseInt((req.query.season as string) || '2025', 10);

    const sql = `
      WITH scored AS (
        SELECT
          p.season, p.week, p.confidence_tier, p.prediction_correct,
          p.home_win_probability, p.spread_line,
          g.home_won
        FROM \`${PROJECT}.${SEASON_DS}.game_predictions\` p
        JOIN \`${PROJECT}.${HIST_DS}.games\` g USING (game_id)
        WHERE p.season = @season AND p.prediction_correct IS NOT NULL
      )
      SELECT
        COUNT(*)                                              AS games,
        AVG(CAST(prediction_correct AS FLOAT64))              AS model_accuracy,
        AVG(CAST(home_won AS FLOAT64))                        AS always_home_accuracy,
        -- BigQuery has no BOOL->FLOAT64 cast, so score the favourite with IF().
        AVG(CASE WHEN spread_line IS NOT NULL AND spread_line != 0
                 THEN IF((spread_line > 0) = (home_won = 1), 1.0, 0.0) END)
                                                              AS vegas_accuracy
      FROM scored
    `;

    const tierSql = `
      SELECT confidence_tier,
             COUNT(*) AS games,
             AVG(CAST(prediction_correct AS FLOAT64)) AS accuracy
      FROM \`${PROJECT}.${SEASON_DS}.game_predictions\`
      WHERE season = @season AND prediction_correct IS NOT NULL
      GROUP BY confidence_tier
      ORDER BY accuracy DESC
    `;

    const [[overall]] = await bigquery.query({ query: sql, params: { season } });
    const [tiers] = await bigquery.query({ query: tierSql, params: { season } });

    res.json({ success: true, data: { season, overall, by_tier: tiers } });
  } catch (error: any) {
    logger.error('NFL accuracy query failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'NFL_ACCURACY_ERROR', message: 'Failed to load NFL accuracy' },
    });
  }
}

/**
 * GET /api/nfl/stats/teams
 * Searchable team stats. Supports season/week/team filters, free-text team search,
 * arbitrary sort field from an allowlist, and paging.
 */
const SORTABLE = new Set([
  'season', 'week', 'team', 'off_epa_play', 'def_epa_play', 'off_pass_epa',
  'off_rush_epa', 'def_pass_epa', 'def_rush_epa', 'off_success_rate',
  'def_success_rate', 'off_explosive_rate', 'def_explosive_rate',
  'off_turnovers', 'def_takeaways', 'off_plays', 'def_plays',
]);

export async function searchNflTeamStats(req: Request, res: Response): Promise<void> {
  try {
    const {
      season, week, team, search,
      sort = 'off_epa_play', direction = 'desc',
      limit = '100', offset = '0',
    } = req.query as Record<string, string>;

    if (!SORTABLE.has(sort)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_SORT',
          message: `sort must be one of: ${[...SORTABLE].join(', ')}`,
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

    if (season) {
      filters.push('season = @season');
      params.season = parseInt(season, 10);
    }
    if (week) {
      filters.push('week = @week');
      params.week = parseInt(week, 10);
    }
    if (team) {
      filters.push('team = @team');
      params.team = team.toUpperCase();
    }
    if (search) {
      filters.push('LOWER(team) LIKE @search');
      params.search = `%${search.toLowerCase()}%`;
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT *
      FROM \`${PROJECT}.${HIST_DS}.team_week_epa\`
      ${where}
      ORDER BY ${sort} ${dir}
      LIMIT @limit OFFSET @offset
    `;
    const countSql = `
      SELECT COUNT(*) AS total
      FROM \`${PROJECT}.${HIST_DS}.team_week_epa\`
      ${where}
    `;

    const [rows] = await bigquery.query({ query: sql, params });
    const [[{ total }]] = await bigquery.query({ query: countSql, params });

    res.json({
      success: true,
      data: rows,
      meta: {
        total, count: rows.length,
        limit: params.limit, offset: params.offset,
        sort, direction: dir,
        sortable_fields: [...SORTABLE],
      },
    });
  } catch (error: any) {
    logger.error('NFL team stats search failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'NFL_STATS_ERROR', message: 'Failed to search NFL team stats' },
    });
  }
}

/** GET /api/nfl/stats/games — searchable game results. */
export async function searchNflGames(req: Request, res: Response): Promise<void> {
  try {
    const {
      season, week, team, divisional,
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
      filters.push('(home_team = @team OR away_team = @team)');
      params.team = team.toUpperCase();
    }
    if (divisional === 'true') filters.push('div_game = 1');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT game_id, season, week, game_date, home_team, away_team,
             home_score, away_score, result, home_won, div_game,
             roof, surface, temp, wind, spread_line, total_line, stadium
      FROM \`${PROJECT}.${HIST_DS}.games\`
      ${where}
      ORDER BY game_date DESC
      LIMIT @limit OFFSET @offset
    `;

    const [rows] = await bigquery.query({ query: sql, params });
    res.json({
      success: true,
      data: rows.map((r: any) => ({
        ...r,
        game_date: normalizeBigQueryTemporalValue(r.game_date),
      })),
      meta: { count: rows.length, limit: params.limit, offset: params.offset },
    });
  } catch (error: any) {
    logger.error('NFL games search failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'NFL_GAMES_ERROR', message: 'Failed to search NFL games' },
    });
  }
}
