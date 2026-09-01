/**
 * Tests for the football response cache.
 *
 * The behaviour worth pinning is not "it caches" but the three judgement calls around
 * it: a completed season is frozen and gets a long TTL, an oversized body is served but
 * not stored, and a thrown error is never cached — a missing table must stay a missing
 * table rather than becoming a cached empty result.
 */

import express from 'express';
import { Server } from 'http';
import { cacheService } from '../services/cache.service';
import {
  serveCached,
  seasonAwareTTL,
  FootballCacheKeys,
} from '../utils/football-cache';

describe('seasonAwareTTL', () => {
  it('promotes a completed season to a day', () => {
    expect(seasonAwareTTL(3600, 2024, 2026)).toBe(86400);
  });

  it('leaves the current season on its base TTL', () => {
    expect(seasonAwareTTL(3600, 2026, 2026)).toBe(3600);
  });

  it('leaves a future season on its base TTL', () => {
    expect(seasonAwareTTL(3600, 2027, 2026)).toBe(3600);
  });

  it('leaves an unspecified season on its base TTL', () => {
    expect(seasonAwareTTL(3600, undefined, 2026)).toBe(3600);
  });

  it('never shortens a TTL that is already longer', () => {
    expect(seasonAwareTTL(172800, 2024, 2026)).toBe(172800);
  });
});

describe('FootballCacheKeys', () => {
  it('is order-independent, so equivalent requests share one entry', () => {
    const a = FootballCacheKeys.teamSeason('cfb', { season: 2025, team: 'OSU' });
    const b = FootballCacheKeys.teamSeason('cfb', { team: 'OSU', season: 2025 });
    expect(a).toBe(b);
  });

  it('separates sports', () => {
    expect(FootballCacheKeys.teamSeason('cfb', { season: 2025 }))
      .not.toBe(FootballCacheKeys.teamSeason('nfl', { season: 2025 }));
  });

  it('separates resources', () => {
    expect(FootballCacheKeys.teamSeason('cfb', {}))
      .not.toBe(FootballCacheKeys.teamWeek('cfb', {}));
  });
});

describe('serveCached', () => {
  let server: Server;
  let baseUrl: string;
  let produce: jest.Mock;

  beforeAll((done) => {
    const app = express();
    app.get('/probe', async (_req, res) => {
      await serveCached(res, 'test:probe', 60, produce as any);
    });
    app.get('/big', async (_req, res) => {
      // Comfortably past the 256KB store limit.
      const body = { success: true, data: 'x'.repeat(400 * 1024) };
      await serveCached(res, 'test:big', 60, async () => {
        (produce as any)();
        return body;
      });
    });
    app.get('/boom', async (_req, res) => {
      try {
        await serveCached(res, 'test:boom', 60, async () => {
          throw new Error('Not found: Table x');
        });
      } catch (err: any) {
        res.status(200).json({ success: true, meta: { note: 'handled' } });
      }
    });
    server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port bound');
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  beforeEach(async () => {
    produce = jest.fn().mockResolvedValue({ success: true, data: [1, 2, 3] });
    await cacheService.flush();
  });

  it('produces once and serves the second request from cache', async () => {
    const first = await fetch(`${baseUrl}/probe`);
    expect(first.headers.get('x-cache')).toBe('MISS');

    const second = await fetch(`${baseUrl}/probe`);
    expect(second.headers.get('x-cache')).toBe('HIT');

    expect(produce).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual({ success: true, data: [1, 2, 3] });
  });

  it('sets a shared Cache-Control, which outlives the per-instance Map', async () => {
    const res = await fetch(`${baseUrl}/probe`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('serves an oversized body but does not store it', async () => {
    const first = await fetch(`${baseUrl}/big`);
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/big`);
    expect(second.headers.get('x-cache')).toBe('MISS');
    // Produced twice: nothing was retained between the two requests.
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('lets a producer error propagate instead of caching a failure', async () => {
    const res = await fetch(`${baseUrl}/boom`);
    const body = await res.json() as any;
    // The handler's own error branch ran, not a cached empty result.
    expect(body.meta.note).toBe('handled');
    expect(await cacheService.get('test:boom')).toBeNull();
  });
});
