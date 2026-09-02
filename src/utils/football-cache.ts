/**
 * Response caching for the football endpoints.
 *
 * Every football route queries BigQuery on every request today; nothing between the
 * handler and the warehouse. This adds the missing layer at the call site rather than as
 * middleware — src/middleware/cache.middleware.ts is a no-op placeholder, and a
 * middleware version would have to buffer res.json and guess a key from the URL, which
 * is both more magic and less accurate than the handler naming its own key.
 *
 * What this layer is and is not:
 *
 * The in-process store is a per-instance Map (Redis is disabled), and App Engine runs
 * with min_instances 0 and up to 10 instances. So the hit rate is at best 1 - 1/N across
 * warm instances and exactly zero on a cold start. It is a cost and latency
 * optimisation; nothing may depend on it for correctness or for rate limiting.
 *
 * The Cache-Control header is doing at least as much work as the Map. It is shared across
 * every instance by construction, which the Map is not, and for reference data like the
 * teams list it is the difference that matters.
 */

import { Response } from 'express';
import { cacheService } from '../services/cache.service';
import { getCacheKey } from './cache-keys';
import { logger } from './logger';

/**
 * Largest body worth holding in the in-process Map.
 *
 * cache.service's cleanup only evicts expired entries — there is no size bound and no
 * LRU — and this runs on a 512MB F2 instance. The diagnostics payload alone is
 * LIMIT 6000 rows wide, so caching it would be the fastest way to exhaust an instance.
 */
const MAX_CACHED_BYTES = 256 * 1024;

/** Per-endpoint TTLs in seconds, chosen from how often the pipeline rewrites each table. */
export const FootballCacheTTL = {
  predictions: 900,      // in-week picks move as lines and rosters do
  accuracy: 3600,
  teamWeek: 3600,        // rewritten weekly by the ingest
  teamSeason: 3600,
  teams: 86400,          // reference data; changes about once a year
  leaders: 3600,
  players: 1800,
  games: 3600,
} as const;

export const FootballCacheKeys = {
  predictions: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:preds`, p),
  accuracy: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:acc`, p),
  teamWeek: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:twk`, p),
  teamSeason: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:tsn`, p),
  teams: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:teams`, p),
  leaders: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:lead`, p),
  players: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:plyr`, p),
  games: (sport: string, p: Record<string, any>) =>
    getCacheKey(`ftbl:${sport}:games`, p),
};

/**
 * A completed season is frozen, so it can be cached for a day whatever the base TTL says.
 *
 * This is where the hit rate actually comes from. The diagnostics and stats pages default
 * to multi-season views, and 2024 is never going to change again. Mirrors the
 * isHistorical branch already in getContextualTTL.
 */
export function seasonAwareTTL(
  base: number,
  season: number | undefined,
  currentSeason: number,
): number {
  if (season !== undefined && Number.isFinite(season) && season < currentSeason) {
    return Math.max(base, 86400);
  }
  return base;
}

export function currentSeason(): number {
  const fromEnv = parseInt(process.env.CURRENT_SEASON || '', 10);
  return Number.isFinite(fromEnv) ? fromEnv : new Date().getFullYear();
}

/**
 * Serve `key` from cache, or run `produce` and store what it returns.
 *
 * `produce` returns the body to send; it must not write to the response itself. A thrown
 * error propagates untouched so the handler's own three-tier error branches still decide
 * what the caller sees — a missing table must not become a cached empty result.
 */
export async function serveCached<T>(
  res: Response,
  key: string,
  ttl: number,
  produce: () => Promise<T>,
): Promise<void> {
  let cached: T | null = null;
  try {
    cached = await cacheService.get<T>(key);
  } catch (error: any) {
    // A cache read failing is not a request failing.
    logger.debug('football cache read failed', { key, error: error?.message });
  }

  if (cached) {
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', `public, max-age=${ttl}`);
    res.json(cached);
    return;
  }

  const body = await produce();

  res.set('X-Cache', 'MISS');
  res.set('Cache-Control', `public, max-age=${ttl}`);
  res.json(body);

  // Stored after responding: the caller should never wait on the write, and a body too
  // large to hold is served normally rather than refused.
  try {
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CACHED_BYTES) {
      logger.debug('football response too large to cache', { key, size });
      return;
    }
    await cacheService.set(key, body, ttl);
  } catch (error: any) {
    logger.debug('football cache write failed', { key, error: error?.message });
  }
}

/**
 * Like serveCached, but the producer chooses the TTL.
 *
 * Needed where how long a response stays fresh depends on what is in it. A finished game
 * is immutable and can be held for a day; one in progress is stale in seconds — and
 * which it is only becomes known after fetching. Deciding the TTL up front would mean
 * either re-assembling finished games every 20 seconds or serving a live game minutes
 * late.
 */
export async function serveCachedDynamic<T>(
  res: Response,
  key: string,
  produce: () => Promise<{ body: T; ttl: number }>,
): Promise<void> {
  let cached: { body: T; ttl: number } | null = null;
  try {
    cached = await cacheService.get<{ body: T; ttl: number }>(key);
  } catch (error: any) {
    logger.debug('football cache read failed', { key, error: error?.message });
  }

  if (cached?.body) {
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', `public, max-age=${cached.ttl}`);
    res.json(cached.body);
    return;
  }

  const { body, ttl } = await produce();

  res.set('X-Cache', 'MISS');
  res.set('Cache-Control', `public, max-age=${ttl}`);
  res.json(body);

  try {
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CACHED_BYTES) {
      logger.debug('football response too large to cache', { key, size });
      return;
    }
    await cacheService.set(key, { body, ttl }, ttl);
  } catch (error: any) {
    logger.debug('football cache write failed', { key, error: error?.message });
  }
}
