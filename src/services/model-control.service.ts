/**
 * Model control plane, READ side.
 *
 * The private lab (mllab) is the only writer of `control.model_control_events`; this
 * service only ever reads the `model_control_current` view. It decides what the site
 * SHOWS: hidden models, label / note / order overrides and a sport-wide banner. See
 * mllab docs/MODEL_CONTROL.md for the contract.
 *
 * Fail open, always. A missing dataset, an empty view, a slow or failing query all
 * resolve to `{ available: false, version: 'none', models: {} }`, which every consumer
 * treats as "no overrides": the site behaves exactly as it did before this existed. One
 * WARNING is logged per failed read (the failure result is itself cached briefly so a
 * dead control dataset costs one query and one log line per window, not one per request).
 *
 * Bounded cost: one small query per sport per 30 s per instance (or one query for all
 * three sports from /api/site-status). Concurrent callers share one in-flight read.
 *
 * Values are inert text. They are validated and length-limited here, never interpreted.
 */

import { createHash } from 'crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });

export const CONTROL_SPORTS = ['mlb', 'nfl', 'cfb'] as const;
export type ControlSport = typeof CONTROL_SPORTS[number];

export const CONTROL_TTL_MS = 30_000;
/** A failed read is remembered briefly, so recovery is quick but a dead view is not hammered. */
export const CONTROL_FAILURE_TTL_MS = 10_000;
export const CONTROL_TIMEOUT_MS = 2_500;

export const LIMITS = { label: 60, note: 300, banner: 240, sortMin: -1000, sortMax: 1000 } as const;

export type BannerLevel = 'info' | 'warn' | 'error';
export type ControlRole = 'live' | 'shadow' | 'archived';

export interface ModelControlEntry {
  visible: boolean;
  paused: boolean;
  role?: ControlRole;
  label?: string;
  note?: string;
  sortOrder?: number;
}

export interface ControlState {
  available: boolean;
  version: string;
  models: Record<string, ModelControlEntry>;
  banner?: { text: string; level: BannerLevel };
}

export const unavailable = (): ControlState => ({ available: false, version: 'none', models: {} });

/* ── clock (injectable for tests) ────────────────────────────────────── */

let now: () => number = () => Date.now();
export function setControlClock(fn: (() => number) | null): void {
  now = fn || (() => Date.now());
}

/* ── parsing ─────────────────────────────────────────────────────────── */

const KEY_RE = /^[a-z0-9_-]{1,40}$/i;
const ROLES = new Set(['live', 'shadow', 'archived']);
const LEVELS = new Set(['info', 'warn', 'error']);

/** Plain text: control characters become spaces, whitespace collapses, capped at `max`. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (v == null) return undefined;
  const s = String(v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

const lower = (v: unknown): string => (v == null ? '' : String(v).trim().toLowerCase());

function parseSortOrder(v: unknown): number | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!/^-?\d{1,5}$/.test(s)) return undefined;
  const n = parseInt(s, 10);
  return n >= LIMITS.sortMin && n <= LIMITS.sortMax ? n : undefined;
}

function parseEntry(row: any): ModelControlEntry {
  const e: ModelControlEntry = {
    // Only an explicit "false" hides; anything unrecognised keeps the default (visible).
    visible: lower(row.site_visible) !== 'false',
    paused: lower(row.run_state) === 'paused',
  };
  const role = lower(row.role);
  if (ROLES.has(role)) e.role = role as ControlRole;
  const label = cleanText(row.display_label, LIMITS.label);
  if (label) e.label = label;
  const note = cleanText(row.public_note, LIMITS.note);
  if (note) e.note = note;
  const so = parseSortOrder(row.sort_order);
  if (so !== undefined) e.sortOrder = so;
  return e;
}

function parseBanner(row: any): { text: string; level: BannerLevel } | undefined {
  const text = cleanText(row.banner, LIMITS.banner);
  if (!text) return undefined;
  const level = lower(row.banner_level);
  return { text, level: LEVELS.has(level) ? (level as BannerLevel) : 'info' };
}

const stable = (v: any): any => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
};

/** Short stable hash of the parsed state; key order and row order do not matter. */
export function versionOf(state: Pick<ControlState, 'models' | 'banner'>): string {
  return createHash('sha1').update(JSON.stringify(stable({
    models: state.models, banner: state.banner || null,
  }))).digest('hex').slice(0, 10);
}

/**
 * Rows for one sport plus the sport-wide ('*') rows -> ControlState. Rows for the exact
 * sport override '*' rows. No usable rows at all -> unavailable (identical to no control).
 */
export function parseControlRows(rows: any[], sport: string): ControlState {
  const isGlobal = (r: any) => String(r?.sport ?? '').trim() === '*';
  const relevant = (rows || []).filter((r) => r && (lower(r.sport) === sport || isGlobal(r)));
  if (!relevant.length) return unavailable();
  // '*' first so that the sport's own rows win.
  const ordered = [...relevant.filter(isGlobal), ...relevant.filter((r) => !isGlobal(r))];
  const models: Record<string, ModelControlEntry> = {};
  let banner: ControlState['banner'];
  for (const r of ordered) {
    const target = String(r.target ?? '').trim();
    if (target === '*') {
      const b = parseBanner(r);
      if (b) banner = b;
    } else if (KEY_RE.test(target)) {
      models[target.toLowerCase()] = parseEntry(r);
    }
  }
  const state: ControlState = { available: true, version: '', models, ...(banner ? { banner } : {}) };
  state.version = versionOf(state);
  return state;
}

/* ── reading ─────────────────────────────────────────────────────────── */

const cache = new Map<string, { at: number; ttl: number; state: ControlState }>();
const inflight = new Map<string, Promise<Map<string, ControlState>>>();

export function resetControlCache(): void {
  cache.clear();
  inflight.clear();
}

const fresh = (sport: string): ControlState | null => {
  const hit = cache.get(sport);
  return hit && now() - hit.at < hit.ttl ? hit.state : null;
};

async function query(sports: string[]): Promise<any[]> {
  const dataset = process.env.CONTROL_DATASET || 'control';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`control read timed out after ${CONTROL_TIMEOUT_MS} ms`)),
      CONTROL_TIMEOUT_MS);
  });
  try {
    const read = bigquery.query({
      query: `SELECT * FROM \`${PROJECT}.${dataset}.model_control_current\`
              WHERE sport IN UNNEST(@sports) OR sport = '*'`,
      params: { sports },
    }).then(([rows]) => rows as any[]);
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One BigQuery read for `sports`; fills the cache for each. Never rejects. */
function load(sports: string[]): Promise<Map<string, ControlState>> {
  const id = [...sports].sort().join(',');
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = (async () => {
    const out = new Map<string, ControlState>();
    try {
      const rows = await query(sports);
      const at = now();
      for (const s of sports) {
        const state = parseControlRows(rows, s);
        out.set(s, state);
        cache.set(s, { at, ttl: CONTROL_TTL_MS, state });
      }
    } catch (error: any) {
      logger.warn('model control unavailable; serving without overrides', {
        sports, error: error?.message,
      });
      const at = now();
      for (const s of sports) {
        const state = unavailable();
        out.set(s, state);
        cache.set(s, { at, ttl: CONTROL_FAILURE_TTL_MS, state });
      }
    }
    return out;
  })().finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

/** Control state for one sport. Never throws. */
export async function getControl(sport: string): Promise<ControlState> {
  const s = String(sport || '').toLowerCase();
  if (!(CONTROL_SPORTS as readonly string[]).includes(s)) return unavailable();
  try {
    const hit = fresh(s);
    if (hit) return hit;
    return (await load([s])).get(s) || unavailable();
  } catch {
    return unavailable();
  }
}

/** All three sports from a single query (for /api/site-status). Never throws. */
export async function getAllControl(): Promise<Record<ControlSport, ControlState>> {
  try {
    const hits = CONTROL_SPORTS.map((s) => fresh(s));
    if (hits.every(Boolean)) {
      return Object.fromEntries(CONTROL_SPORTS.map((s, i) => [s, hits[i]])) as Record<ControlSport, ControlState>;
    }
    const all = await load([...CONTROL_SPORTS]);
    return Object.fromEntries(CONTROL_SPORTS.map((s) => [s, all.get(s) || unavailable()])) as
      Record<ControlSport, ControlState>;
  } catch {
    return { mlb: unavailable(), nfl: unavailable(), cfb: unavailable() };
  }
}
