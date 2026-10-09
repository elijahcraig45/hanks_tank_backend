/**
 * ESPN college-football injuries, league-wide.
 *
 * Probed 2026-10-09: the per-team endpoint (/teams/{id}/injuries) returns {} for every
 * team, and the league-wide one lists three teams, one entry dated 2020. ESPN does not
 * publish a usable CFB injury feed, so this is best-effort: it keeps only entries
 * reported in the last FRESH_DAYS days and not marked Active, and the scouting report
 * treats an empty result as "no data", never as "no injuries".
 *
 * One call returns every team, so there is no per-team fan-out and no team-id map; teams
 * are matched on ESPN's displayName ("Florida Gators"), which is the form the
 * predictions tables use.
 */

import { cacheService } from './cache.service';
import { getCacheKey } from '../utils/cache-keys';
import { logger } from '../utils/logger';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/injuries';
const FRESH_DAYS = 14;
const TTL_SECONDS = 3600;

export interface CfbInjury {
  player: string;
  status: string;
  detail: string | null;
  reported: string | null;
}

/** displayName → fresh injury entries. */
export type CfbInjuryFeed = Record<string, CfbInjury[]>;

export function parseInjuryFeed(body: any, nowMs = Date.now()): CfbInjuryFeed {
  const out: CfbInjuryFeed = {};
  const cutoff = nowMs - FRESH_DAYS * 86_400_000;
  for (const t of Array.isArray(body?.injuries) ? body.injuries : []) {
    const name = typeof t?.displayName === 'string' ? t.displayName : null;
    if (!name) continue;
    for (const i of Array.isArray(t.injuries) ? t.injuries : []) {
      const status = typeof i?.status === 'string' ? i.status : '';
      const when = i?.date ? Date.parse(i.date) : NaN;
      if (!status || status.toLowerCase() === 'active') continue;
      if (!Number.isFinite(when) || when < cutoff) continue;
      (out[name] ||= []).push({
        player: i?.athlete?.displayName ?? 'Unknown',
        status,
        detail: i?.shortComment ?? null,
        reported: i.date,
      });
    }
  }
  return out;
}

/**
 * Fresh injuries by team, or null when ESPN cannot be reached. Never throws: the report
 * must still render without it.
 */
export async function getCfbInjuries(): Promise<CfbInjuryFeed | null> {
  const key = getCacheKey('espn:cfb:injuries', {});
  try {
    const hit = await cacheService.get<CfbInjuryFeed>(key);
    if (hit) return hit;
  } catch (error: any) {
    logger.debug('espn cache read failed', { error: error?.message });
  }

  try {
    const res = await fetch(URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`ESPN injuries responded ${res.status}`);
    const feed = parseInjuryFeed(await res.json());
    try { await cacheService.set(key, feed, TTL_SECONDS); } catch { /* cache is optional */ }
    return feed;
  } catch (error: any) {
    logger.warn('espn cfb injuries unavailable', { error: error?.message });
    return null;
  }
}
