/**
 * Football rest-of-season Monte Carlo (shadow model), read-only.
 *
 *   GET /api/season-sim/:sport?season=&week=                 sport = nfl | cfb
 *       -> { success, data: { teams, bracket }, meta: { sport, season, as_of_week,
 *            computed_at, n_sims, model_version, available_weeks, source, method_url } }
 *   GET /api/season-sim/:sport/export?season=&week=&table=team|bracket&format=csv|json
 *       -> CSV attachment, or a bare JSON array
 *
 * Tables: `${seasonDataset}.season_sim_team` and `season_sim_bracket` (nfl_season /
 * cfb_season). The ML `season_sim` mode is the only writer; a rerun of a
 * (season, as_of_week) appends a new computed_at, so every read takes the latest
 * computed_at for the slice it serves.
 *
 * Defaults: season = the latest season in the team table, week = the latest as_of_week
 * in that season. No rows, or a table that does not exist yet, is a 404 envelope
 * ({ success:false, error }) rather than a 500 — the tables are created by the ML DDL
 * and may simply not be there.
 *
 * DEV-ONLY FIXTURE FALLBACK. When the env var SEASON_SIM_FIXTURE_DIR is set, the
 * handlers read `${SEASON_SIM_FIXTURE_DIR}/season_sim_${sport}.json` — shape
 * { teams: [...], bracket: [...], meta: {...} } — instead of BigQuery, and report
 * meta.source = 'fixture'. It exists so the page can be previewed locally before the
 * tables exist. Unset (as in production, where app.yaml never sets it) the code path is
 * inert and BigQuery is the only source.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';
import { getFootballSport, FootballSportConfig } from '../config/football.config';
import { isMissingTable } from '../utils/football-request';
import { toCsv } from '../utils/unified-slate';
import { cacheService } from '../services/cache.service';
import { getCacheKey } from '../utils/cache-keys';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });
const table = (dataset: string, name: string) => `\`${PROJECT}.${dataset}.${name}\``;

export const SEASON_SIM_SPORTS = ['nfl', 'cfb'];
export const METHOD_URL = '/learn/season-sim.html';
/** Seconds. The sim is rerun once a week; half an hour keeps a rerun visible quickly. */
export const SEASON_SIM_TTL = 1800;
/**
 * One slice per (sport, season, week), so a larger cap than the generic 256KB is safe:
 * the CFB slice (every FBS team plus the bracket rows) sits just past it.
 */
const MAX_CACHED_BYTES = 1024 * 1024;

export const TEAM_COLUMNS = [
  'sport', 'season', 'as_of_week', 'computed_at', 'model_version', 'n_sims',
  'team', 'team_name', 'conference', 'division',
  'wins', 'losses', 'ties', 'conf_wins', 'conf_losses',
  'rating', 'rating_sd', 'power_rank', 'remaining_games', 'remaining_sos',
  'mean_wins', 'mean_losses', 'wins_p10', 'wins_p50', 'wins_p90', 'wins_dist',
  'p_division', 'p_conf_game', 'p_conf_title', 'p_playoffs', 'p_bye', 'p_seed',
  'p_quarters', 'p_semis', 'p_final', 'p_champion',
  'exp_final_rank', 'rank_p10', 'rank_p90',
];

export const BRACKET_COLUMNS = [
  'sport', 'season', 'as_of_week', 'computed_at', 'model_version', 'n_sims',
  'bracket', 'round', 'round_order', 'slot', 'slot_label', 'team', 'team_name',
  'p_slot', 'p_win', 'is_modal', 'modal_opponent',
];

export interface SeasonSimSlice {
  teams: any[];
  bracket: any[];
  meta: {
    sport: string;
    season: number | null;
    as_of_week: number | null;
    computed_at: string | null;
    n_sims: number | null;
    model_version: string | null;
    available_weeks: number[];
    source: 'bigquery' | 'fixture';
    method_url: string;
    note?: string;
  };
}

class NotFound extends Error {}

const intParam = (v: any): number | null | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function toIso(v: any): string | null {
  const flat = normalizeBigQueryTemporalValue(v);
  if (flat == null) return null;
  const ms = new Date(flat as any).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(flat);
}

/** Flatten every { value } wrapper (computed_at, and any temporal column added later). */
export function normalizeSimRow(row: any): any {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k === 'computed_at') out[k] = toIso(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object)) {
      out[k] = normalizeBigQueryTemporalValue(v as any);
    } else out[k] = v;
  }
  return out;
}

/* ── SQL ─────────────────────────────────────────────────────────────── */

export function slicesSql(teamTable: string, bySeason: boolean): string {
  return `
    SELECT season, as_of_week, MAX(computed_at) AS computed_at
    FROM ${teamTable}
    ${bySeason ? 'WHERE season = @season' : ''}
    GROUP BY season, as_of_week
    ORDER BY season DESC, as_of_week DESC`;
}

/** Latest computed_at of THIS table for the slice; the bracket may land after the teams. */
export function sliceRowsSql(tbl: string, order: string): string {
  return `
    SELECT *
    FROM ${tbl}
    WHERE season = @season AND as_of_week = @week
      AND computed_at = (
        SELECT MAX(computed_at) FROM ${tbl}
        WHERE season = @season AND as_of_week = @week)
    ORDER BY ${order}`;
}

/* ── loaders ─────────────────────────────────────────────────────────── */

async function loadFromBigQuery(
  sport: FootballSportConfig, season?: number, week?: number,
): Promise<SeasonSimSlice> {
  const teamTable = table(sport.seasonDataset, 'season_sim_team');
  const bracketTable = table(sport.seasonDataset, 'season_sim_bracket');

  let slices: any[];
  try {
    [slices] = await bigquery.query({
      query: slicesSql(teamTable, season != null),
      params: season != null ? { season } : {},
    });
  } catch (error: any) {
    if (isMissingTable(error)) throw new NotFound('Season simulation has not been published yet.');
    throw error;
  }
  if (!slices?.length) throw new NotFound('No season simulation for that season.');

  const chosenSeason = season ?? Number(slices[0].season);
  const inSeason = slices.filter((s) => Number(s.season) === chosenSeason);
  const weeks = [...new Set(inSeason.map((s) => Number(s.as_of_week)))].sort((a, b) => a - b);
  const chosenWeek = week ?? weeks[weeks.length - 1];
  if (!weeks.includes(chosenWeek)) throw new NotFound(`No season simulation as of week ${chosenWeek}.`);

  const params = { season: chosenSeason, week: chosenWeek };
  const [[teamRows], bracketResult] = await Promise.all([
    bigquery.query({
      query: sliceRowsSql(teamTable, 'conference, division, mean_wins DESC, team'),
      params,
    }),
    bigquery.query({
      query: sliceRowsSql(bracketTable, 'bracket, round_order, slot, p_slot DESC'),
      params,
    }).then((r) => ({ rows: r[0] as any[], note: undefined as string | undefined }))
      .catch((error: any) => {
        // Teams without a bracket is still a useful page; say so rather than failing.
        if (!isMissingTable(error)) throw error;
        return { rows: [] as any[], note: 'Bracket table not available yet.' };
      }),
  ]);
  if (!teamRows?.length) throw new NotFound('No season simulation for that week.');

  const teams = teamRows.map(normalizeSimRow);
  const bracket = bracketResult.rows.map(normalizeSimRow);
  const first = teams[0];
  return {
    teams,
    bracket,
    meta: {
      sport: sport.key,
      season: chosenSeason,
      as_of_week: chosenWeek,
      computed_at: first.computed_at ?? null,
      n_sims: first.n_sims != null ? Number(first.n_sims) : null,
      model_version: first.model_version ?? null,
      available_weeks: weeks,
      source: 'bigquery',
      method_url: METHOD_URL,
      ...(bracketResult.note ? { note: bracketResult.note } : {}),
    },
  };
}

/** Dev-only; see the header. Filters by season/week when the fixture rows carry them. */
async function loadFromFixture(
  dir: string, sport: FootballSportConfig, season?: number, week?: number,
): Promise<SeasonSimSlice> {
  const file = path.join(dir, `season_sim_${sport.key}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new NotFound(`No fixture at ${path.basename(file)}.`);
  }
  const doc = JSON.parse(raw);
  const fm = doc.meta || {};
  const match = (r: any) => (season == null || r.season == null || Number(r.season) === season)
    && (week == null || r.as_of_week == null || Number(r.as_of_week) === week);
  const teams = (doc.teams || []).filter(match).map(normalizeSimRow);
  const bracket = (doc.bracket || []).filter(match).map(normalizeSimRow);
  if (!teams.length) throw new NotFound('No season simulation in the fixture for that slice.');
  const first = teams[0];
  const weeks: number[] = Array.isArray(fm.available_weeks) && fm.available_weeks.length
    ? fm.available_weeks.map(Number)
    : [...new Set<number>(teams.map((t: any) => Number(t.as_of_week)))].sort((a, b) => a - b);
  return {
    teams,
    bracket,
    meta: {
      sport: sport.key,
      season: Number(fm.season ?? first.season ?? season) || null,
      as_of_week: Number(fm.as_of_week ?? first.as_of_week ?? week) || null,
      computed_at: toIso(fm.computed_at ?? first.computed_at),
      n_sims: fm.n_sims ?? first.n_sims ?? null,
      model_version: fm.model_version ?? first.model_version ?? null,
      available_weeks: weeks,
      source: 'fixture',
      method_url: METHOD_URL,
    },
  };
}

export async function loadSeasonSim(
  sport: FootballSportConfig, season?: number, week?: number,
): Promise<SeasonSimSlice> {
  const dir = process.env.SEASON_SIM_FIXTURE_DIR;
  if (dir) return loadFromFixture(dir, sport, season, week);

  const key = getCacheKey(`ssim:${sport.key}`, { season: season ?? 'latest', week: week ?? 'latest' });
  const hit = await cacheService.get<SeasonSimSlice>(key);
  if (hit) return hit;
  const slice = await loadFromBigQuery(sport, season, week);
  try {
    if (Buffer.byteLength(JSON.stringify(slice)) <= MAX_CACHED_BYTES) {
      void cacheService.set(key, slice, SEASON_SIM_TTL);
    }
  } catch (error: any) {
    logger.debug('season sim: cache write failed', { key, error: error?.message });
  }
  return slice;
}

/* ── handlers ────────────────────────────────────────────────────────── */

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ success: false, error: { code, message } });
}

/** Validates :sport, ?season and ?week. Returns null once an error has been sent. */
function parseRequest(req: Request, res: Response) {
  const key = String(req.params.sport || '').toLowerCase();
  const sport = SEASON_SIM_SPORTS.includes(key) ? getFootballSport(key) : null;
  if (!sport) {
    fail(res, 404, 'UNKNOWN_SPORT', `Season simulation is available for nfl and cfb, not "${key}".`);
    return null;
  }
  const season = intParam(req.query.season);
  const week = intParam(req.query.week);
  if (season === null || week === null) {
    fail(res, 400, 'BAD_REQUEST', 'season and week must be positive integers');
    return null;
  }
  return { sport, season: season ?? undefined, week: week ?? undefined };
}

async function withSlice(
  req: Request, res: Response, respond: (s: SeasonSimSlice) => void,
): Promise<void> {
  const parsed = parseRequest(req, res);
  if (!parsed) return;
  try {
    const slice = await loadSeasonSim(parsed.sport, parsed.season, parsed.week);
    res.set('Cache-Control', `public, max-age=${slice.meta.source === 'fixture' ? 0 : SEASON_SIM_TTL}`);
    respond(slice);
  } catch (error: any) {
    if (error instanceof NotFound) {
      fail(res, 404, 'NOT_AVAILABLE', error.message);
      return;
    }
    logger.error('season sim: load failed', { sport: parsed.sport.key, error: error?.message });
    fail(res, 500, 'INTERNAL', 'Failed to load season simulation');
  }
}

export async function getSeasonSim(req: Request, res: Response): Promise<void> {
  await withSlice(req, res, (s) => {
    res.json({ success: true, data: { teams: s.teams, bracket: s.bracket }, meta: s.meta });
  });
}

export async function exportSeasonSim(req: Request, res: Response): Promise<void> {
  const which = String(req.query.table || 'team').toLowerCase();
  const format = String(req.query.format || 'csv').toLowerCase();
  if (which !== 'team' && which !== 'bracket') {
    fail(res, 400, 'BAD_REQUEST', 'table must be team or bracket');
    return;
  }
  if (format !== 'csv' && format !== 'json') {
    fail(res, 400, 'BAD_FORMAT', 'format must be csv or json');
    return;
  }
  await withSlice(req, res, (s) => {
    const rows = which === 'team' ? s.teams : s.bracket;
    if (format === 'json') {
      res.json(rows);
      return;
    }
    const known = which === 'team' ? TEAM_COLUMNS : BRACKET_COLUMNS;
    // Keep the contract's column order; append anything newer the ML side adds.
    const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !known.includes(k));
    const filename = `season_sim_${s.meta.sport}_${s.meta.season}_wk${s.meta.as_of_week}_${which}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv([...known, ...extra], rows));
  });
}
