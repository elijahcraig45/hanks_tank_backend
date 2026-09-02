/**
 * Tests for the response cache middleware.
 *
 * Three properties matter, and one of them is a security property: a per-viewer
 * response must never be served to a different viewer. The pick sheet carries the
 * caller's own selections, so a URL-only key would hand them to the next person.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { cacheService } from '../services/cache.service';
import { cacheGet } from '../middleware/responseCache.middleware';

let server: Server;
let baseUrl: string;
let produce: jest.Mock;

beforeAll((done) => {
  const app = express();

  // Stands in for whatever attached req.user upstream.
  app.use((req: any, _res, next) => {
    const who = req.headers['x-test-user'];
    if (who) req.user = { userId: String(who) };
    next();
  });

  app.get('/plain', cacheGet({ ttl: 60 }), (_req, res) => {
    res.json({ success: true, value: produce() });
  });
  app.get('/mine', cacheGet({ ttl: 60, perViewer: true }), (req: any, res) => {
    res.json({ success: true, viewer: req.user?.userId ?? 'anon', value: produce() });
  });
  app.get('/boom', cacheGet({ ttl: 60 }), (_req, res) => {
    produce();
    res.status(500).json({ success: false, error: { code: 'X', message: 'no' } });
  });
  app.get('/soft-fail', cacheGet({ ttl: 60 }), (_req, res) => {
    produce();
    res.json({ success: false, error: { code: 'Y', message: 'no' } });
  });
  app.get('/huge', cacheGet({ ttl: 60 }), (_req, res) => {
    produce();
    res.json({ success: true, blob: 'x'.repeat(400 * 1024) });
  });
  app.put('/plain', cacheGet({ ttl: 60 }), (_req, res) => {
    res.json({ success: true, value: produce() });
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
  let n = 0;
  produce = jest.fn(() => { n += 1; return n; });
  await cacheService.flush();
});

const get = async (path: string, user?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: user ? { 'x-test-user': user } : {},
  });
  return { status: res.status, cache: res.headers.get('x-cache'), body: await res.json() as any };
};

describe('cacheGet', () => {
  it('runs the handler once and serves the repeat from cache', async () => {
    const a = await get('/plain');
    const b = await get('/plain');
    expect(a.cache).toBe('MISS');
    expect(b.cache).toBe('HIT');
    expect(produce).toHaveBeenCalledTimes(1);
    expect(b.body.value).toBe(a.body.value);
  });

  it('never serves one viewer a response produced for another', async () => {
    // The security property. The pick sheet carries the caller's own picks.
    const mine = await get('/mine', 'user-a');
    expect(mine.body.viewer).toBe('user-a');

    const theirs = await get('/mine', 'user-b');
    expect(theirs.cache).toBe('MISS');
    expect(theirs.body.viewer).toBe('user-b');

    const anon = await get('/mine');
    expect(anon.body.viewer).toBe('anon');

    // Three distinct viewers, three separate productions.
    expect(produce).toHaveBeenCalledTimes(3);
  });

  it('serves the same viewer from their own entry', async () => {
    await get('/mine', 'user-a');
    const again = await get('/mine', 'user-a');
    expect(again.cache).toBe('HIT');
    expect(again.body.viewer).toBe('user-a');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed response', async () => {
    // A transient failure served for a whole TTL would turn a blip into an outage.
    await get('/boom');
    const second = await get('/boom');
    expect(second.status).toBe(500);
    expect(second.cache).toBe('MISS');
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('does not cache a 200 that reports success: false', async () => {
    await get('/soft-fail');
    const second = await get('/soft-fail');
    expect(second.cache).toBe('MISS');
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('serves an oversized body without storing it', async () => {
    await get('/huge');
    const second = await get('/huge');
    expect(second.status).toBe(200);
    expect(second.cache).toBe('MISS');
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('sets a shared Cache-Control on a public route, which outlives the per-instance store', async () => {
    const res = await fetch(`${baseUrl}/plain`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  describe('what shared caches are allowed to do', () => {
    // App Engine serves through Google's frontend, so these headers are the difference
    // between a fast page and one visitor's picks appearing on another's screen.

    it('forbids shared caching of a per-viewer route, even anonymously', async () => {
      // Anonymous matters most: the URL is identical either way, so a publicly cached
      // anonymous body is what would then be served to everyone who signs in.
      const anon = await fetch(`${baseUrl}/mine`);
      expect(anon.headers.get('cache-control')).toBe('private, max-age=60');

      const signedIn = await fetch(`${baseUrl}/mine`, { headers: { 'x-test-user': 'user-a' } });
      expect(signedIn.headers.get('cache-control')).toBe('private, max-age=60');
    });

    it('varies a per-viewer route on Authorization', async () => {
      // `private` stops a shared cache storing it; this stops any cache answering a
      // signed-in request from an entry built for a different credential.
      const res = await fetch(`${baseUrl}/mine`);
      expect(res.headers.get('vary')).toMatch(/Authorization/i);
    });

    it('downgrades a public route to private once a viewer is attached', async () => {
      // Belt and braces: a route nobody remembered to declare per-viewer still must not
      // have a signed-in response stored in a shared cache.
      const res = await fetch(`${baseUrl}/plain`, { headers: { 'x-test-user': 'user-a' } });
      expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    });
  });

  it('leaves non-GET requests alone', async () => {
    // A PUT that returned a cached body would be a bug with teeth.
    await fetch(`${baseUrl}/plain`, { method: 'PUT' });
    const second = await fetch(`${baseUrl}/plain`, { method: 'PUT' });
    expect(second.headers.get('x-cache')).toBeNull();
    expect(produce).toHaveBeenCalledTimes(2);
  });
});
