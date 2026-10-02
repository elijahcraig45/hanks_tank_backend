/**
 * The hot legacy reads (player profile, game log, leaderboards, statcast, splits) were the only
 * public routes with no Cache-Control, so every crawler render and repeat visit reached an App
 * Engine instance and kept it billed. They are cached now; the live game surfaces are not.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// One stand-in handler for every legacy controller method, so the test exercises the routes
// file's own wiring (which routes carry the cache) and nothing downstream of it.
let handler: jest.Mock;
jest.mock('../controllers/legacy.controller', () => ({
  legacyController: new Proxy({}, {
    get: () => (req: any, res: any) => (global as any).__legacyHandler(req, res),
  }),
}));
jest.mock('../controllers/pipeline-health.controller', () => ({
  getSchedulerHealth: (_req: any, res: any) => res.json({ success: true }),
}));

import { cacheService } from '../services/cache.service';
import legacyRoutes from '../routes/legacy.routes';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api', legacyRoutes);
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
  handler = jest.fn((_req: any, res: any) => { n += 1; res.json({ success: true, value: n }); });
  (global as any).__legacyHandler = handler;
  await cacheService.flush();
});

const hit = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, cc: res.headers.get('cache-control'), cache: res.headers.get('x-cache'), body: await res.json() as any };
};

describe('cached legacy routes', () => {
  const cached = [
    '/api/players/660271/profile',
    '/api/players/660271/game-log?season=2026',
    '/api/player-batting?year=2025',
    '/api/PlayerBatting?year=2025',
    '/api/player-pitching?year=2025',
    '/api/PlayerPitching?year=2025',
    '/api/statcast?year=2025',
    '/api/splits?playerId=660271',
  ];

  it.each(cached)('sends a public max-age on %s and serves the repeat from cache', async (path) => {
    const first = await hit(path);
    expect(first.cc).toMatch(/^public, max-age=\d+$/);
    expect(Number(first.cc!.split('=')[1])).toBeGreaterThanOrEqual(3600);

    const second = await hit(path);
    expect(second.cache).toBe('HIT');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps different players, and different query strings, apart', async () => {
    await hit('/api/players/1/profile');
    await hit('/api/players/2/profile');
    await hit('/api/player-batting?year=2024');
    await hit('/api/player-batting?year=2025');
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('does not let a failure be cached by anyone', async () => {
    handler.mockImplementation((_req: any, res: any) => res.status(500).json({ success: false }));
    const first = await hit('/api/players/1/profile');
    expect(first.status).toBe(500);
    expect(first.cc).toBe('no-store');
    await hit('/api/players/1/profile');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('legacy routes left uncached on purpose', () => {
  it.each(['/api/games', '/api/games/745000', '/api/health/scheduler'])('adds no freshness header to %s', async (path) => {
    const res = await hit(path);
    expect(res.cc).toBeNull();
    expect(res.cache).toBeNull();
  });
});
