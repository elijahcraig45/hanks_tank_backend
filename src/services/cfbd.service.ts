/**
 * CollegeFootballData client — the first LIVE data path in the football stack.
 *
 * Everything football has done so far is batch: the ML pipeline writes BigQuery, the
 * backend reads it. That is stated at the top of football.controller.ts, and it is still
 * true for stats. Live scores are the exception, and deliberately so — a scoreboard
 * changes every few seconds, so routing it through BigQuery would add latency and cost
 * to data that is stale by the time it lands. This proxies upstream instead, the way
 * mlb-api.service.ts proxies MLB StatsAPI.
 *
 * Cost shape, which drives the caching below: the plan's Tier 2 subscription is 30,000
 * calls a month. One /scoreboard call returns every game in a week, so board polling is
 * cheap. But /live/plays, /metrics/wp and the box-score endpoints are PER GAME — a
 * single open game page polling every 20s for three hours is ~540 calls. So per-game
 * feeds are fetched on demand and cached server-side, which is what makes N concurrent
 * viewers of one game cost one upstream call rather than N.
 *
 * College only. CFBD reports products ["cfb","cbb"], so there is no NFL here; NFL live
 * data has to come from ESPN.
 *
 * Local development note: on a machine behind TLS inspection, Node's fetch fails here
 * with SELF_SIGNED_CERT_IN_CHAIN while curl to the same host succeeds — curl trusts the
 * corporate root through the OS keychain and Node does not. Export the root bundle and
 * point NODE_EXTRA_CA_CERTS at it. App Engine is not behind such a proxy, so this only
 * ever bites locally.
 */

import { cacheService } from './cache.service';
import { getCacheKey } from '../utils/cache-keys';
import { logger } from '../utils/logger';

const BASE = 'https://api.collegefootballdata.com';

/** Matches the football response cache. See football-cache.ts for the reasoning. */
const MAX_CACHED_BYTES = 256 * 1024;

/** Thrown when no key is configured, so handlers can answer 200 + note, not 500. */
export class CfbdKeyMissing extends Error {
  constructor() {
    super('CFBD_API_KEY is not configured');
    this.name = 'CfbdKeyMissing';
  }
}

/** Thrown on a 401/403, which for CFBD means the tier does not include the endpoint. */
export class CfbdNotEntitled extends Error {
  constructor(path: string) {
    super(`CFBD tier does not include ${path}`);
    this.name = 'CfbdNotEntitled';
  }
}

/**
 * Live TTLs in seconds. Short enough to feel live, long enough that a burst of viewers
 * is one upstream call. The scoreboard is the polling hot path; per-game feeds move more
 * slowly than the clock does, so they tolerate a little more.
 */
export const CfbdTTL = {
  scoreboard: 20,
  livePlays: 20,
  winProbability: 60,   // a completed game's curve never changes; see completedTTL
  boxScore: 60,
  drives: 60,
  schedule: 3600,       // kickoff times move rarely
} as const;

/**
 * A finished game is immutable, so its curve, box score and drives can be held for a
 * day instead of a minute. Without this, browsing last week's games would re-fetch
 * everything on every page view for no reason.
 */
export function completedTTL(base: number, isCompleted: boolean): number {
  return isCompleted ? 86400 : base;
}

let cachedKey: string | null | undefined;

/**
 * Resolve the key once per instance. Lazy on purpose: importing this module must not
 * require a key, so that the NFL paths and every batch endpoint keep working without one.
 */
function apiKey(): string {
  if (cachedKey === undefined) {
    cachedKey = process.env.CFBD_API_KEY || null;
    if (!cachedKey) {
      logger.warn('CFBD_API_KEY not set — live college endpoints will report unavailable');
    }
  }
  if (!cachedKey) throw new CfbdKeyMissing();
  return cachedKey;
}

export function hasApiKey(): boolean {
  try { apiKey(); return true; } catch { return false; }
}

/** Test seam. */
export function __resetKeyCache(): void {
  cachedKey = undefined;
}

function buildUrl(path: string, params: Record<string, any>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  return `${BASE}${path}${query ? `?${query}` : ''}`;
}

/**
 * GET a CFBD endpoint, cached.
 *
 * The key is never logged and never included in the cache key. A non-2xx is surfaced as
 * an error rather than cached, so a transient upstream failure does not stick around for
 * the length of the TTL.
 */
export async function cfbdGet<T = any>(
  path: string,
  params: Record<string, any> = {},
  ttl = 60,
): Promise<T> {
  const key = apiKey();
  const cacheKey = getCacheKey(`cfbd:${path}`, params);

  try {
    const hit = await cacheService.get<T>(cacheKey);
    if (hit) return hit;
  } catch (error: any) {
    logger.debug('cfbd cache read failed', { path, error: error?.message });
  }

  const url = buildUrl(path, params);
  const started = Date.now();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });

  if (res.status === 401 || res.status === 403) {
    // The key is valid but the Patreon tier does not cover this endpoint. Distinct from
    // a missing key, because the caller's answer is different: upgrade, not configure.
    logger.warn('cfbd endpoint not entitled', { path, status: res.status });
    throw new CfbdNotEntitled(path);
  }
  if (!res.ok) {
    throw new Error(`CFBD ${path} responded ${res.status}`);
  }

  const body = (await res.json()) as T;
  logger.debug('cfbd fetch', { path, ms: Date.now() - started });

  try {
    // Some responses are far too big to hold: /drives for a single week is ~924KB, and
    // the in-process store has no size bound. Callers that need a slice of a large
    // response should filter it and cache the slice themselves — see gameDrives.
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CACHED_BYTES) {
      logger.debug('cfbd response too large to cache', { path, size });
    } else {
      await cacheService.set(cacheKey, body, ttl);
    }
  } catch (error: any) {
    logger.debug('cfbd cache write failed', { path, error: error?.message });
  }
  return body;
}

/** True where the error means "we cannot serve this", not "something broke". */
export function isCfbdUnavailable(error: any): boolean {
  return error instanceof CfbdKeyMissing || error instanceof CfbdNotEntitled;
}
