/**
 * Shared request/response helpers for the football controllers.
 *
 * Extracted so every football handler answers the same way. The three-tier convention
 * these encode is the important part:
 *
 *   404  the sport does not exist                     -> resolveSport
 *   200  the sport cannot answer this, or the table
 *        is not built yet, with meta.note explaining  -> respondUnavailable / isMissingTable
 *   500  anything else, logged, generic message out
 *
 * The middle tier is the one worth protecting. A sport whose feed does not cover a
 * resource is an expected state, not a failure, and 500ing it would make a normal gap
 * look like an outage.
 */

import { Request, Response } from 'express';
import { normalizeBigQueryTemporalValue } from './bq-normalize';
import {
  getFootballSport,
  FootballSportConfig,
} from '../config/football.config';

/** Resolve :sport or answer 404. Returns null once the response has been sent. */
export function resolveSport(
  req: Request,
  res: Response,
  fallback = 'nfl',
): FootballSportConfig | null {
  const key = (req.params.sport || fallback).toLowerCase();
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

/**
 * BigQuery hands back DATE/TIMESTAMP as { value: "..." }; the frontend expects strings.
 * Any new temporal column has to be added here or it reaches the client as an object.
 */
export function normalizeRow(row: any): any {
  return {
    ...row,
    game_date: normalizeBigQueryTemporalValue(row.game_date),
    predicted_at: normalizeBigQueryTemporalValue(row.predicted_at),
  };
}

/**
 * Is this error BigQuery telling us the table or a column is not there?
 *
 * Deliberately wider than "not found": querying a column a table lacks raises
 * `Unrecognized name: week at [4:13]`, which the original narrower test missed, so a
 * schema mismatch surfaced as a 500 rather than as an empty state. Both mean the same
 * thing to a caller — this data is not available — so both answer 200 with a note.
 */
export function isMissingTable(error: any): boolean {
  return /not found|does not exist|unrecognized name|no matching signature/i
    .test(error?.message || '');
}

/**
 * 200 with an explanation, for a resource this sport genuinely cannot serve.
 *
 * Takes the reason from config rather than hardcoding prose in a handler. A sentence
 * written into a handler asserting "this sport has no X feed" becomes a lie the moment
 * the config gains X, and nothing fails when it does — which is exactly how the college
 * team-stats endpoint spent months telling people a table that existed did not.
 */
export function respondUnavailable(
  res: Response,
  sport: FootballSportConfig,
  resource: string,
  reason?: string,
): void {
  res.json({
    success: true,
    data: [],
    meta: {
      sport: sport.key,
      label: sport.label,
      total: 0,
      count: 0,
      sortable_fields: [],
      note: reason
        || `${sport.label} has no ${resource} feed wired up yet.`,
    },
  });
}

/** Paging, with the caps applied. BigQuery will happily return 500 wide rows. */
export function parsePaging(
  query: Record<string, any>,
  defaults: { limit: number; max: number },
): { limit: number; offset: number } {
  const raw = parseInt(query.limit as string, 10);
  const limit = Math.min(
    Number.isFinite(raw) && raw > 0 ? raw : defaults.limit,
    defaults.max,
  );
  const rawOffset = parseInt(query.offset as string, 10);
  return {
    limit,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
  };
}

/**
 * Pick a sort column from an allow-list.
 *
 * BigQuery cannot parameterize an ORDER BY identifier, so the value has to be
 * interpolated — which makes the allow-list the only thing standing between a query
 * string and the SQL. Returns null for an off-list value so the caller can 400 rather
 * than quietly sorting by something else.
 */
export function pickSort(
  requested: string | undefined,
  allowed: string[],
  fallback: string,
): string | null {
  if (!requested) return fallback;
  return allowed.includes(requested) ? requested : null;
}

export function sortDirection(requested: string | undefined): 'ASC' | 'DESC' {
  return (requested || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}
