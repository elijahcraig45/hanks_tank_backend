/**
 * Football rest-of-season Monte Carlo (shadow model), read-only.
 *
 *   GET /api/season-sim/:sport?season=&week=                 sport = nfl | cfb
 *       -> { success, data: { teams, bracket }, meta: { sport, season, as_of_week,
 *            computed_at, n_sims, model_version, available_weeks, source, method_url } }
 *   GET /api/season-sim/:sport/team/:team?season=&week=
 *       -> { success, data: { team, games }, meta }: one team's row plus its remaining
 *          games, each with the team's side of it (opponent, site, p_win, margin, label,
 *          projected_win). meta is the slice meta, plus `note` if the games table is absent.
 *   GET /api/season-sim/:sport/export?season=&week=&table=team|bracket|games&format=csv|json
 *       -> CSV attachment, or a bare JSON array
 *
 * Tables: `${seasonDataset}.season_sim_team`, `season_sim_bracket` and `season_sim_games`
 * (nfl_season / cfb_season). The games table is read only by the team route and the
 * export (the whole-league view does not need 557 CFB game rows). The ML `season_sim` mode is the only writer; a rerun of a
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
  'rem_wins_mean', 'rem_wins_dist', 'projected_wins_games', 'modal_sequence',
  'modal_sequence_freq', 'modal_sequence_record_p',
];

export const GAME_COLUMNS = [
  'sport', 'season', 'as_of_week', 'computed_at', 'model_version', 'n_sims',
  'game_id', 'week', 'game_date', 'home', 'away', 'home_name', 'away_name', 'neutral',
  'p_home_win', 'margin_mean', 'margin_p10', 'margin_p90',
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

/* ── per-game rows ───────────────────────────────────────────────────── */

export interface SeasonSimGames {
  games: any[];
  note?: string;
}

/** Order the games table the way a schedule reads. */
const GAMES_ORDER = 'week, game_date, game_id';

async function loadGamesFromBigQuery(
  sport: FootballSportConfig, season: number, week: number,
): Promise<SeasonSimGames> {
  try {
    const [rows] = await bigquery.query({
      query: sliceRowsSql(table(sport.seasonDataset, 'season_sim_games'), GAMES_ORDER),
      params: { season, week },
    });
    return { games: (rows as any[]).map(normalizeSimRow) };
  } catch (error: any) {
    if (!isMissingTable(error)) throw error;
    return { games: [], note: 'Per-game table not available yet.' };
  }
}

async function loadGamesFromFixture(
  dir: string, sport: FootballSportConfig, season: number, week: number,
): Promise<SeasonSimGames> {
  try {
    const doc = JSON.parse(await fs.readFile(path.join(dir, `season_sim_${sport.key}.json`), 'utf8'));
    if (!Array.isArray(doc.games)) return { games: [], note: 'Per-game table not available yet.' };
    const match = (r: any) => (r.season == null || Number(r.season) === season)
      && (r.as_of_week == null || Number(r.as_of_week) === week);
    return { games: doc.games.filter(match).map(normalizeSimRow) };
  } catch {
    return { games: [], note: 'Per-game table not available yet.' };
  }
}

/** Every remaining game of one resolved slice, cached like the slice itself. */
export async function loadSeasonSimGames(
  sport: FootballSportConfig, season: number, week: number,
): Promise<SeasonSimGames> {
  const dir = process.env.SEASON_SIM_FIXTURE_DIR;
  if (dir) return loadGamesFromFixture(dir, sport, season, week);
  const key = getCacheKey(`ssim-games:${sport.key}`, { season, week });
  const hit = await cacheService.get<SeasonSimGames>(key);
  if (hit) return hit;
  const out = await loadGamesFromBigQuery(sport, season, week);
  try {
    if (!out.note && Buffer.byteLength(JSON.stringify(out)) <= MAX_CACHED_BYTES) {
      void cacheService.set(key, out, SEASON_SIM_TTL);
    }
  } catch (error: any) {
    logger.debug('season sim: games cache write failed', { key, error: error?.message });
  }
  return out;
}

/** The label thresholds the page shows: P(win) >= .65 likely, .55 lean, .45-.55 toss-up. */
export function winLabel(p: number | null | undefined): string | null {
  if (p == null || !Number.isFinite(Number(p))) return null;
  const x = Number(p);
  if (x >= 0.65) return 'Likely W';
  if (x >= 0.55) return 'Lean W';
  if (x > 0.45) return 'Toss-up';
  if (x > 0.35) return 'Lean L';
  return 'Likely L';
}

const num = (v: any): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function parseJsonList(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const out = JSON.parse(v);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * A game from `team`'s side: opponent, site, and P(win)/margin flipped when it is away.
 * The margin percentiles swap too (the away side's 10th percentile is minus the home
 * side's 90th).
 */
export function teamView(game: any, team: string, projected: Set<string>): any {
  const home = game.home === team;
  const pHome = num(game.p_home_win);
  const m = num(game.margin_mean);
  const p10 = num(game.margin_p10);
  const p90 = num(game.margin_p90);
  const flip = (v: number | null) => (v == null ? null : -v);
  const pWin = pHome == null ? null : (home ? pHome : 1 - pHome);
  return {
    ...game,
    opponent: home ? game.away : game.home,
    opponent_name: home ? game.away_name : game.home_name,
    site: game.neutral === true || game.neutral === 'true' ? 'neutral' : (home ? 'home' : 'away'),
    is_home: home,
    p_win: pWin,
    margin: home ? m : flip(m),
    margin_p10: home ? p10 : flip(p90),
    margin_p90: home ? p90 : flip(p10),
    label: winLabel(pWin),
    projected_win: projected.has(String(game.game_id)),
  };
}

/** Case-insensitive team lookup by the team key the table uses (NFL code / ESPN abbr). */
export function findTeam(teams: any[], key: string): any | undefined {
  const k = key.trim();
  return teams.find((t) => t.team === k)
    ?? teams.find((t) => String(t.team).toLowerCase() === k.toLowerCase());
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
  req: Request, res: Response, respond: (s: SeasonSimSlice) => void | Promise<void>,
): Promise<void> {
  const parsed = parseRequest(req, res);
  if (!parsed) return;
  try {
    const slice = await loadSeasonSim(parsed.sport, parsed.season, parsed.week);
    res.set('Cache-Control', `public, max-age=${slice.meta.source === 'fixture' ? 0 : SEASON_SIM_TTL}`);
    await respond(slice);
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

export async function getSeasonSimTeam(req: Request, res: Response): Promise<void> {
  const key = String(req.params.team || '');
  if (!key || key.length > 40) {
    fail(res, 400, 'BAD_REQUEST', 'team is required');
    return;
  }
  await withSlice(req, res, async (s) => {
    const team = findTeam(s.teams, key);
    if (!team) {
      fail(res, 404, 'UNKNOWN_TEAM', `No team "${key}" in this simulation.`);
      return;
    }
    const { games, note } = await loadSeasonSimGames(
      getFootballSport(s.meta.sport)!, Number(s.meta.season), Number(s.meta.as_of_week));
    const projected = new Set(parseJsonList(team.projected_wins_games).map(String));
    const mine = games
      .filter((g) => g.home === team.team || g.away === team.team)
      .map((g) => teamView(g, team.team, projected));
    res.json({
      success: true,
      data: { team, games: mine },
      meta: { ...s.meta, ...(note ? { note } : {}) },
    });
  });
}

export async function exportSeasonSim(req: Request, res: Response): Promise<void> {
  const which = String(req.query.table || 'team').toLowerCase();
  const format = String(req.query.format || 'csv').toLowerCase();
  if (which !== 'team' && which !== 'bracket' && which !== 'games') {
    fail(res, 400, 'BAD_REQUEST', 'table must be team, bracket or games');
    return;
  }
  if (format !== 'csv' && format !== 'json') {
    fail(res, 400, 'BAD_FORMAT', 'format must be csv or json');
    return;
  }
  await withSlice(req, res, async (s) => {
    const rows = which === 'team' ? s.teams
      : which === 'bracket' ? s.bracket
        : (await loadSeasonSimGames(getFootballSport(s.meta.sport)!,
          Number(s.meta.season), Number(s.meta.as_of_week))).games;
    if (format === 'json') {
      res.json(rows);
      return;
    }
    const known = which === 'team' ? TEAM_COLUMNS : which === 'bracket' ? BRACKET_COLUMNS : GAME_COLUMNS;
    // Keep the contract's column order; append anything newer the ML side adds.
    const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !known.includes(k));
    const filename = `season_sim_${s.meta.sport}_${s.meta.season}_wk${s.meta.as_of_week}_${which}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv([...known, ...extra], rows));
  });
}
