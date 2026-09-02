/**
 * Power rankings for every sport.
 *
 * Served at /api/rankings/:sport, with /api/football/:sport/rankings delegating here so
 * the football tab keeps its existing URL. The tables share a schema across sports, so
 * the only per-sport knowledge lives in rankings.config.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { isMissingTable } from '../utils/football-request';
import { getRankingSport, RankingSportConfig } from '../config/rankings.config';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

const MAX_LIMIT = 400;

function datasetFor(sport: RankingSportConfig): string {
  return process.env[sport.datasetEnv] || sport.defaultDataset;
}

/**
 * GET /api/rankings/:sport?season=&division=&limit=
 *
 * A missing table is reported as an empty board with a note rather than a 500: a sport
 * whose ratings have not been built yet is an expected state, and the UI renders it as
 * "not available" instead of an error.
 */
export async function getRankings(req: Request, res: Response): Promise<void> {
  const key = (req.params.sport || '').toLowerCase();
  const sport = getRankingSport(key);

  if (!sport) {
    res.status(404).json({
      success: false,
      error: { code: 'UNKNOWN_SPORT', message: `No rankings for sport: ${key}` },
    });
    return;
  }

  // Defaults rather than 400s on a missing season: /api/football/:sport/rankings
  // already shipped with a default, and this handler took that path over, so
  // rejecting the omission would break existing callers.
  const requestedSeason = parseInt((req.query.season as string) || '', 10);
  const season = Number.isFinite(requestedSeason)
    ? requestedSeason
    : parseInt(process.env.CURRENT_SEASON || '', 10) || new Date().getFullYear();

  const limit = Math.min(
    parseInt((req.query.limit as string) || '50', 10) || 50,
    MAX_LIMIT
  );
  const division = ((req.query.division as string) || '').toLowerCase();

  const table = `${PROJECT}.${datasetFor(sport)}.${sport.table}`;
  const params: Record<string, any> = { season, limit };
  const filters = ['season = @season'];

  if (division && sport.divisions.includes(division)) {
    filters.push('division = @division');
    params.division = division;
  }

  // as_of_week lets the table keep a weekly history; take the latest snapshot only.
  const sql = `
    SELECT * FROM \`${table}\`
    WHERE ${filters.join(' AND ')}
      AND as_of_week = (
        SELECT MAX(as_of_week) FROM \`${table}\` WHERE season = @season
      )
    ORDER BY rank
    LIMIT @limit
  `;

  try {
    const [rows] = await bigquery.query({ query: sql, params });
    const first: any = rows[0] || {};

    res.json({
      success: true,
      data: rows,
      meta: {
        sport: sport.key,
        label: sport.label,
        season,
        division: params.division ?? null,
        count: rows.length,
        as_of_week: first.as_of_week ?? null,
        home_field_points: first.home_field_points ?? null,
        prior_weight: first.prior_weight ?? null,
        record_season: first.record_season ?? null,
        // No games played yet: the board is entirely last season's evidence, which the
        // UI must say out loud rather than presenting it as this season's form.
        is_preseason: first.record_season != null && first.record_season !== season,
        divisions: sport.divisions,
        method: 'Bradley-Terry, ridge-regularized, fitted globally over every game '
          + 'with an explicit home-field term and a decaying prior on last season',
        note: sport.note ?? null,
      },
    });
  } catch (error: any) {
    const missingTable = isMissingTable(error);
    if (missingTable) {
      logger.warn('power rankings table missing', { sport: sport.key, table });
      res.json({
        success: true,
        data: [],
        meta: {
          sport: sport.key,
          season,
          count: 0,
          note: `No power rankings built for ${sport.label} yet.`,
        },
      });
      return;
    }

    logger.error('power rankings query failed', {
      sport: sport.key, error: error.message,
    });
    res.status(500).json({
      success: false,
      error: { code: 'RANKINGS_ERROR', message: 'Failed to load power rankings' },
    });
  }
}
