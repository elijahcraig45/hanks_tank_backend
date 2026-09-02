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
let keyLoad: Promise<string | null> | null = null;
let keyRetryAfter = 0;

/**
 * How long to wait before re-reading a MISSING key. Same reasoning as the client id: a
 * key that is found never changes, but caching its absence forever means a transient
 * Secret Manager failure at cold start silently disables the live college endpoints on
 * that instance until it is replaced.
 */
const MISSING_RETRY_MS = 60_000;

const SECRET_NAME = process.env.CFBD_SECRET_NAME || 'cfbd-api-key';
const SECRET_PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';

/**
 * Resolve the key from Secret Manager, once per instance.
 *
 * Read at runtime rather than injected at deploy time, and that is the point: App
 * Engine already runs as the service account that holds secretAccessor on this secret,
 * so nothing about deploying needs to know the key. Injecting it would have made every
 * deploy — including CI's — depend on whoever ran it having the value to hand, which is
 * the opposite of autonomous.
 *
 * The promise is memoised so a burst of first requests on a cold instance makes one
 * Secret Manager call rather than one each.
 */
async function loadKey(): Promise<string | null> {
  // An explicit env var still wins, which is what local development uses.
  if (process.env.CFBD_API_KEY) return process.env.CFBD_API_KEY.trim();

  try {
    const { SecretManagerServiceClient } =
      await import('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const [version] = await client.accessSecretVersion({
      name: `projects/${SECRET_PROJECT}/secrets/${SECRET_NAME}/versions/latest`,
    });
    const value = version.payload?.data?.toString().trim() || null;
    if (value) {
      logger.info('CFBD key loaded from Secret Manager', { secret: SECRET_NAME });
    }
    return value;
  } catch (error: any) {
    // Not fatal. Every college live endpoint answers "unavailable" with a note, and
    // nothing that reads BigQuery is affected.
    logger.warn('could not load the CFBD key from Secret Manager', {
      secret: SECRET_NAME, error: error?.message,
    });
    return null;
  }
}

async function apiKey(): Promise<string> {
  if (!cachedKey) {
    if (cachedKey === null && Date.now() < keyRetryAfter) throw new CfbdKeyMissing();

    if (!keyLoad) {
      keyLoad = loadKey().then((value) => {
        cachedKey = value;
        keyRetryAfter = value ? 0 : Date.now() + MISSING_RETRY_MS;
        keyLoad = null;
        return value;
      }).catch((error) => {
        cachedKey = null;
        keyRetryAfter = Date.now() + MISSING_RETRY_MS;
        keyLoad = null;
        throw error;
      });
    }

    try {
      await keyLoad;
    } catch {
      throw new CfbdKeyMissing();
    }
  }
  if (!cachedKey) throw new CfbdKeyMissing();
  return cachedKey;
}

/** Whether a key is available. Resolves it if that has not happened yet. */
export async function hasApiKey(): Promise<boolean> {
  try { await apiKey(); return true; } catch { return false; }
}

/** Test seam. */
export function __resetKeyCache(): void {
  cachedKey = undefined;
  keyLoad = null;
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
  const key = await apiKey();
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
