/**
 * Pure logic for the unified predictions slate (/api/predictions/:sport/slate) and the
 * player projections (/api/predictions/:sport/players): the Dist shape, per-model
 * prediction assembly, consensus/disagreement, and the CSV export.
 *
 * The pregame rule is not re-implemented here: rows are chosen upstream with
 * pickPrediction / pickLatestPregameRow (utils/football-compare), the same code the
 * Models pages use. No I/O; unit-tested directly.
 */

import { normalizeBigQueryTemporalValue } from './bq-normalize';
import { GamePrediction, pickLatestPregameRow } from './football-compare';

/* ── Dist ─────────────────────────────────────────────────────────────── */

export interface Dist {
  mean: number | null;
  sd: number | null;
  p05: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  n: number | null;
}

export const DIST_FIELDS: Array<keyof Dist> = [
  'mean', 'sd', 'p05', 'p25', 'p50', 'p75', 'p95', 'min', 'max', 'n',
];

export const finite = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round = (x: number | null, d = 4): number | null => (
  x == null ? null : Math.round(x * 10 ** d) / 10 ** d
);

/** A non-simulation model's point estimate: only `mean`, everything else null. */
export function meanDist(mean: any): Dist | null {
  const m = finite(mean);
  if (m == null) return null;
  return {
    mean: round(m), sd: null, p05: null, p25: null, p50: null, p75: null, p95: null,
    min: null, max: null, n: null,
  };
}

/**
 * Read one Dist from a flat sim row: `${prefix}_mean`, `${prefix}_sd`, ... The first
 * prefix whose `_mean` column is present wins, so `home_runs_*` (MLB), `home_points_*`
 * (NFL) and a bare `total_*` / `total_runs_*` are all read without per-sport code.
 */
export function distFromRow(row: Record<string, any>, prefixes: string[], n: any): Dist | null {
  const prefix = prefixes.find((p) => row[`${p}_mean`] !== undefined && row[`${p}_mean`] !== null);
  if (!prefix) return null;
  const get = (f: string) => finite(row[`${prefix}_${f}`]);
  return {
    mean: round(get('mean')),
    sd: round(get('sd')),
    p05: get('p05'),
    p25: get('p25'),
    p50: get('p50'),
    p75: get('p75'),
    p95: get('p95'),
    min: get('min'),
    max: get('max'),
    n: finite(n),
  };
}

function parseJsonMap(v: any): Record<string, number> | null {
  if (v == null || v === '') return null;
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(parsed)) {
      const n = finite(x);
      if (n != null) out[k] = n;
    }
    return out;
  } catch {
    return null;
  }
}

/* ── per-game predictions ─────────────────────────────────────────────── */

export interface SimDistRow {
  predicted_at: any;
  model_version?: string | null;
  n_sims?: number | null;
  p_home_win?: number | null;
  [col: string]: any;
}

export interface DistMeta {
  model_version: string | null;
  predicted_at: string | null;
  pregame: boolean;
  n_sims: number | null;
}

export interface SlatePrediction {
  home_win_prob: number | null;
  predicted_at: string | null;
  pregame: boolean;
  model_version: string | null;
  home_score: Dist | null;
  away_score: Dist | null;
  total: Dist | null;
  margin: Dist | null;
  /** Which simulation row the distributions came from; null for point-estimate models. */
  dist: DistMeta | null;
  extras: Record<string, any> | null;
  has_players?: boolean;
  /** Market only: which price the probability came from. */
  basis?: string;
}

const EXTRA_KEYS = ['p_extra_innings', 'p_home_cover_rl', 'p_ot', 'p_home_cover'];
const JSON_EXTRAS = ['p_over_by_line', 'margin_exact'];

export function toIso(v: any): string | null {
  const flat = normalizeBigQueryTemporalValue(v);
  if (flat == null) return null;
  const ms = new Date(flat as any).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The chosen sim row for one game (latest pregame, else latest flagged). */
export function pickDist(rows: SimDistRow[], startMs: number | null) {
  return pickLatestPregameRow(rows, startMs);
}

/**
 * One model's prediction for one game, from its picked table row and (for simulators)
 * its picked distribution row. Returns null when the model has neither: missing is
 * explicit, never a guess.
 */
export function buildPrediction(
  pick: GamePrediction | null,
  sim: { row: SimDistRow; pregame: boolean } | null,
  hasPlayers?: boolean,
): SlatePrediction | null {
  if (!pick && !sim) return null;
  const r = sim?.row;
  const n = r?.n_sims;
  const simDist = (prefixes: string[]) => (r ? distFromRow(r, prefixes, n) : null);

  const homeScore = simDist(['home_runs', 'home_points', 'home_score'])
    ?? meanDist(pick?.predicted_home_score);
  const awayScore = simDist(['away_runs', 'away_points', 'away_score'])
    ?? meanDist(pick?.predicted_away_score);
  const total = simDist(['total_runs', 'total_points', 'total'])
    ?? meanDist(pick?.predicted_total);
  const margin = simDist(['margin_runs', 'margin_points', 'margin'])
    ?? meanDist(pick?.predicted_home_margin);

  let extras: Record<string, any> | null = null;
  if (r) {
    extras = {};
    for (const k of EXTRA_KEYS) if (r[k] !== undefined) extras[k] = round(finite(r[k]));
    for (const k of JSON_EXTRAS) if (r[k] !== undefined) extras[k] = parseJsonMap(r[k]);
  }

  const out: SlatePrediction = {
    // The model's own table row is the win probability of record; a simulator whose
    // table row is missing falls back to its distribution's p_home_win.
    home_win_prob: pick ? round(pick.home_win_probability, 6) : round(finite(r?.p_home_win), 6),
    predicted_at: pick ? pick.predicted_at : toIso(r?.predicted_at),
    pregame: pick ? pick.pregame : Boolean(sim?.pregame),
    model_version: pick ? (pick.model_version ?? null) : (r?.model_version ?? null),
    home_score: homeScore,
    away_score: awayScore,
    total,
    margin,
    dist: sim ? {
      model_version: sim.row.model_version ?? null,
      predicted_at: toIso(sim.row.predicted_at),
      pregame: sim.pregame,
      n_sims: finite(sim.row.n_sims),
    } : null,
    extras,
  };
  if (hasPlayers !== undefined) out.has_players = hasPlayers;
  if (pick?.basis) out.basis = pick.basis;
  return out;
}

/* ── consensus & disagreement ─────────────────────────────────────────── */

export const DISAGREEMENT = { medium: 0.08, high: 0.15 } as const;

export function disagreementLevel(spread: number | null): 'low' | 'medium' | 'high' | null {
  if (spread == null) return null;
  if (spread < DISAGREEMENT.medium) return 'low';
  if (spread < DISAGREEMENT.high) return 'medium';
  return 'high';
}

export interface Consensus {
  home_win_prob_mean: number | null;
  spread: number | null;
  models_n: number;
}

/**
 * Mean and range of home_win_prob across the models that predicted the game pregame.
 * A post-start row never counts, and neither does a model that is not available. With
 * fewer than two models there is no spread to speak of, so `spread` (and hence the
 * disagreement level) is null.
 */
export function consensusOf(
  predictions: Record<string, SlatePrediction | null>, available: Set<string>,
): Consensus {
  const ps = Object.entries(predictions)
    .filter(([k, p]) => available.has(k) && p && p.pregame && p.home_win_prob != null)
    .map(([, p]) => (p as SlatePrediction).home_win_prob as number);
  if (!ps.length) return { home_win_prob_mean: null, spread: null, models_n: 0 };
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  return {
    home_win_prob_mean: round(mean),
    spread: ps.length >= 2 ? round(Math.max(...ps) - Math.min(...ps)) : null,
    models_n: ps.length,
  };
}

/* ── CSV ──────────────────────────────────────────────────────────────── */

/**
 * RFC 4180 field: quoted when it holds a comma, quote, CR or LF, quotes doubled. A
 * string starting with = + @ or a tab is prefixed with ' so a spreadsheet does not run
 * it as a formula (numbers are never touched, so negative margins stay numeric).
 */
export function csvField(v: any): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Record<string, any>>): string {
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvField(r[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const DIST_BLOCKS = ['home_score', 'away_score', 'total', 'margin'] as const;

export const SLATE_CSV_HEADERS: string[] = [
  'sport', 'date', 'season', 'week', 'division', 'game_id', 'start_time', 'status',
  'home_id', 'home_abbr', 'home_name', 'away_id', 'away_abbr', 'away_name',
  'result_home_score', 'result_away_score',
  'model', 'model_label', 'model_role', 'model_available', 'has_prediction',
  'home_win_prob', 'predicted_at', 'pregame', 'model_version', 'basis',
  ...DIST_BLOCKS.flatMap((b) => DIST_FIELDS.map((f) => `${b}_${f}`)),
  'dist_model_version', 'dist_predicted_at', 'dist_pregame', 'dist_n_sims',
  'p_extra_innings', 'p_home_cover_rl', 'p_ot', 'p_home_cover', 'p_over_by_line', 'margin_exact',
  'has_players',
  'consensus_home_win_prob_mean', 'consensus_spread', 'consensus_models_n', 'disagreement',
];

/** Long format: one row per game x model, including models with no prediction. */
export function slateCsvRows(data: any): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const g of data.games || []) {
    for (const m of data.models || []) {
      const p: SlatePrediction | null = g.predictions?.[m.key] ?? null;
      const row: Record<string, any> = {
        sport: data.sport,
        date: data.date,
        season: data.season,
        week: data.week,
        division: data.division ?? null,
        game_id: g.game_id,
        start_time: g.start_time,
        status: g.status,
        home_id: g.home?.id,
        home_abbr: g.home?.abbr,
        home_name: g.home?.name,
        away_id: g.away?.id,
        away_abbr: g.away?.abbr,
        away_name: g.away?.name,
        result_home_score: g.result?.home_score,
        result_away_score: g.result?.away_score,
        model: m.key,
        model_label: m.label,
        model_role: m.role,
        model_available: m.available,
        has_prediction: Boolean(p),
        consensus_home_win_prob_mean: g.consensus?.home_win_prob_mean,
        consensus_spread: g.consensus?.spread,
        consensus_models_n: g.consensus?.models_n,
        disagreement: g.disagreement,
      };
      if (p) {
        row.home_win_prob = p.home_win_prob;
        row.predicted_at = p.predicted_at;
        row.pregame = p.pregame;
        row.model_version = p.model_version;
        row.basis = p.basis ?? null;
        for (const b of DIST_BLOCKS) {
          const d = p[b];
          for (const f of DIST_FIELDS) row[`${b}_${f}`] = d ? d[f] : null;
        }
        row.dist_model_version = p.dist?.model_version;
        row.dist_predicted_at = p.dist?.predicted_at;
        row.dist_pregame = p.dist ? p.dist.pregame : null;
        row.dist_n_sims = p.dist?.n_sims;
        for (const k of [...EXTRA_KEYS, ...JSON_EXTRAS]) row[k] = p.extras?.[k] ?? null;
        row.has_players = p.has_players ?? null;
      }
      out.push(row);
    }
  }
  return out;
}

export const PLAYER_CSV_HEADERS: string[] = [
  'game_id', 'game_date', 'player_id', 'player_name', 'team_id', 'team_abbr', 'role',
  'batting_order', 'stat', ...DIST_FIELDS, 'p_at_least_1', 'calibrated', 'calibration_note',
  'model_version', 'predicted_at', 'pregame',
];

/* ── players ──────────────────────────────────────────────────────────── */

export interface PlayerRow {
  game_id: string;
  game_date: string | null;
  player_id: string;
  player_name: string | null;
  team_id: string | null;
  team_abbr: string | null;
  role: string | null;
  batting_order: number | null;
  stat: string;
  mean: number | null;
  sd: number | null;
  p05: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  n: number | null;
  p_at_least_1: number | null;
  calibrated: boolean | null;
  calibration_note: string | null;
  model_version: string | null;
  predicted_at: string | null;
  pregame: boolean;
}

/** Flatten one BigQuery player_sim_projections row (already pregame-picked in SQL). */
export function normalizePlayerRow(r: any): PlayerRow {
  const d = distFromRow({ x_mean: r.mean, x_sd: r.sd, x_p05: r.p05, x_p25: r.p25, x_p50: r.p50,
    x_p75: r.p75, x_p95: r.p95, x_min: r.min, x_max: r.max }, ['x'], r.n_sims);
  const date = normalizeBigQueryTemporalValue(r.game_date);
  return {
    game_id: String(r.game_pk ?? r.game_id),
    game_date: date == null ? null : String(date).slice(0, 10),
    player_id: String(r.player_id),
    player_name: r.player_name ?? null,
    team_id: r.team_id == null ? null : String(r.team_id),
    team_abbr: r.team_abbr ?? null,
    role: r.role ?? null,
    batting_order: finite(r.batting_order),
    stat: String(r.stat),
    mean: d?.mean ?? null,
    sd: d?.sd ?? null,
    p05: d?.p05 ?? null,
    p25: d?.p25 ?? null,
    p50: d?.p50 ?? null,
    p75: d?.p75 ?? null,
    p95: d?.p95 ?? null,
    min: d?.min ?? null,
    max: d?.max ?? null,
    n: finite(r.n_sims),
    p_at_least_1: round(finite(r.p_at_least_1)),
    calibrated: r.calibrated == null ? null : Boolean(r.calibrated),
    calibration_note: r.calibration_note ?? null,
    model_version: r.model_version ?? null,
    predicted_at: toIso(r.predicted_at),
    pregame: Boolean(r.pregame),
  };
}

/* ── filenames & TTL ──────────────────────────────────────────────────── */

export function exportFilename(
  kind: 'slate' | 'players',
  sport: string,
  opts: { date?: string | null; season?: number | null; week?: number | null;
    division?: string | null; gameId?: string | null },
): string {
  const parts = ['hankstank', sport];
  if (opts.division) parts.push(opts.division);
  parts.push(kind);
  if (opts.gameId) parts.push(`game-${opts.gameId}`);
  else if (opts.date) parts.push(opts.date);
  else if (opts.season != null) parts.push(`${opts.season}-week${opts.week ?? ''}`);
  return `${parts.join('_').replace(/[^A-Za-z0-9_.-]/g, '')}.csv`;
}

export const SLATE_TTL = { upcoming: 300, past: 3600 } as const;

/** 5 minutes for today and upcoming, 1 hour once the slate is entirely in the past. */
export function slateTtl(isPast: boolean): number {
  return isPast ? SLATE_TTL.past : SLATE_TTL.upcoming;
}
