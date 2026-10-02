/**
 * Response caching as route middleware.
 *
 * The earlier approach wrapped each handler's body in a `serveCached` call, which worked
 * — and then seven football handlers and every pick'em handler shipped without it,
 * because adding caching was a separate act of remembering per endpoint. Football was
 * paying full BigQuery latency on every request while MLB, which caches in its service
 * layer, felt instant. This makes caching a property of the route instead, so a new
 * endpoint cannot quietly arrive uncached.
 *
 * Two things make it safe rather than magic:
 *
 *   The key is the URL AND the viewer, not a guess. Some of these responses are
 *   per-person — the pick sheet carries the caller's own selections — and a URL-only key
 *   would hand one viewer's picks to the next.
 *
 *   Only a successful response is stored. A 500, a 404, or a body carrying
 *   `success: false` is passed through untouched, so a transient failure cannot be
 *   served for the length of a TTL.
 *
 * `serveCachedDynamic` still exists for the one case this cannot express: a response
 * whose freshness depends on its own content, like a game that is cacheable for a day
 * once it has finished and for seconds while it is being played.
 */

import { Request, Response, NextFunction } from 'express';
import { cacheService } from '../services/cache.service';
import { getCacheKey } from '../utils/cache-keys';
import { logger } from '../utils/logger';

/** Bodies past this are served but not stored; see football-cache for the reasoning. */
const MAX_CACHED_BYTES = 256 * 1024;

export interface CacheOptions {
  /** Seconds. Also sent as Cache-Control max-age, which is shared across instances. */
  ttl: number;
  /**
   * Prefix for readable keys. Defaults to the route path, which is usually enough.
   */
  prefix?: string | ((req: Request) => string);
  /**
   * Caps the Cache-Control max-age sent to browsers and edge caches. The server-side TTL
   * is unchanged. Used where a change (a model hidden from the control plane) must show
   * up in about a minute, not after the full TTL.
   */
  maxAge?: number;
  /**
   * Set on any route whose body can differ by who is asking.
   *
   * This controls what shared caches are allowed to do, which matters here because App
   * Engine serves through Google's frontend. Such a response is sent `private` so no
   * shared cache stores it at all, plus `Vary: Authorization` so a signed-in request is
   * never answered from an entry populated anonymously — that second one is the failure
   * `private` alone does not cover, since a cache keys on the URL and would otherwise
   * hand a signed-in visitor the anonymous pick sheet with none of their picks on it.
   *
   * The in-process key always carries the viewer regardless of this flag; this is only
   * about caches between here and the browser.
   */
  perViewer?: boolean;
}

export function cacheGet({ ttl, prefix, perViewer, maxAge }: CacheOptions) {
  return async function cacheGetMiddleware(
    req: Request, res: Response, next: NextFunction,
  ): Promise<void> {
    // Only idempotent reads. A PUT that returned a cached body would be a bug with
    // teeth, so this never applies to anything else.
    if (req.method !== 'GET' || ttl <= 0) return next();

    // A route declared per-viewer stays private even for an anonymous caller: the URL
    // is the same either way, so letting the anonymous response be publicly cached is
    // what would poison it for everyone who signs in.
    const scoped = perViewer || Boolean(req.user);
    const clientAge = maxAge != null ? Math.min(ttl, Math.max(0, maxAge)) : ttl;
    const cacheControl = `${scoped ? 'private' : 'public'}, max-age=${clientAge}`;
    // res.vary appends; res.set would replace, and CORS has already put Origin there.
    if (perViewer) res.vary('Authorization');

    // A prefix function is how a route folds per-request state (the model control
    // version) into its key. It must not throw: a failure means "no suffix".
    let resolved = typeof prefix === 'function' ? '' : prefix;
    if (typeof prefix === 'function') {
      try { resolved = prefix(req); } catch { resolved = ''; }
    }
    const key = getCacheKey(resolved || 'route', {
      url: req.originalUrl,
      // Anonymous callers share one bucket; they are identical by definition.
      viewer: req.user?.userId || 'anon',
    });

    try {
      const hit = await cacheService.get<any>(key);
      if (hit) {
        res.set('X-Cache', 'HIT');
        res.set('Cache-Control', cacheControl);
        res.json(hit);
        return;
      }
    } catch (error: any) {
      logger.debug('response cache read failed', { key, error: error?.message });
    }

    // Intercept the handler's own res.json so it needs no knowledge of caching.
    const send = res.json.bind(res);
    res.json = (body: any) => {
      const worthCaching = res.statusCode === 200 && body?.success !== false;
      res.set('X-Cache', 'MISS');
      // The freshness header follows the same test as the in-process store. Sent on a 500
      // it would let Google's frontend or a browser keep the failure for the whole TTL,
      // which the store above deliberately refuses to do.
      res.set('Cache-Control', worthCaching ? cacheControl : 'no-store');
      const out = send(body);

      if (worthCaching) {
        // After responding, so the caller never waits on the write.
        try {
          const size = Buffer.byteLength(JSON.stringify(body));
          if (size > MAX_CACHED_BYTES) {
            logger.debug('response too large to cache', { key, size });
          } else {
            void cacheService.set(key, body, ttl);
          }
        } catch (error: any) {
          logger.debug('response cache write failed', { key, error: error?.message });
        }
      }
      return out;
    };

    next();
  };
}
