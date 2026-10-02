/**
 * Tests for GET /api/health/scheduler.
 *
 * These are regression tests for a real outage. The CFB pipeline ran every
 * Tuesday for eight days, exited zero each time, and re-predicted a week that
 * had already been played - two week-1 games were cancelled and postponed, so
 * `home_won` stayed NULL and the "next unplayed week" cursor never advanced.
 * This endpoint reported `status: 'ok'` throughout, because all it ever checked
 * was whether the in-process node-cron news task was registered.
 *
 * So the assertions below are about the endpoint being *able to fail*. The
 * clock is frozen on purpose: seasonality is part of the logic, and a test that
 * passes in September and fails in June is not a test.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The real service registers a cron task at import time.
jest.mock('../services/scheduler.service', () => ({
  schedulerService: { getJobStatus: () => [{ name: 'Job-0', running: true }] },
}));

import { mockQuery, rows } from './helpers/bq-mock';
import legacyRoutes from '../routes/legacy.routes';

let server: Server;
let baseUrl: string;

/** Mid-season: MLB, NFL and both college divisions are all producing. */
const IN_SEASON = new Date('2026-09-10T20:00:00Z');
/** Deep summer: football legitimately has nothing on file. */
const OFF_SEASON = new Date('2026-06-15T20:00:00Z');

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api', legacyRoutes);
  server = app.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

afterAll((done) => { jest.useRealTimers(); server.close(() => done()); });
beforeEach(() => { mockQuery.mockReset(); });

/** `hours` before the frozen clock, in the shape BigQuery hands back. */
function aged(league: string, hours: number, extra: Record<string, any> = {}) {
  const at = new Date(Date.now() - hours * 3_600_000).toISOString();
  return { league, latest: { value: at }, predictions: 100, newest_slate: '2', ...extra };
}

async function health() {
  const res = await fetch(`${baseUrl}/api/health/scheduler`);
  return { status: res.status, body: await res.json() as any };
}

function leagueNamed(body: any, key: string) {
  return body.pipelines.leagues.find((l: any) => l.key === key);
}

describe('GET /api/health/scheduler', () => {
  it('reports ok when every in-season pipeline is fresh', async () => {
    jest.useFakeTimers().setSystemTime(IN_SEASON);
    mockQuery.mockResolvedValue(rows([
      aged('mlb', 2), aged('nfl', 30), aged('cfb', 25), aged('fcs', 25),
    ]));

    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.pipelines.stale).toBeNull();
    expect(leagueNamed(body, 'cfb').age_hours).toBeCloseTo(25, 1);
  });

  it('catches the eight-day CFB stall that used to read as ok', async () => {
    jest.useFakeTimers().setSystemTime(IN_SEASON);
    // 194h is where the real stall actually sat when it was found.
    mockQuery.mockResolvedValue(rows([
      aged('mlb', 2), aged('nfl', 30), aged('cfb', 194, { newest_slate: '1' }), aged('fcs', 194),
    ]));

    const { body } = await health();
    expect(body.status).toBe('degraded');
    expect(body.pipelines.status).toBe('stale');
    expect(body.pipelines.stale).toEqual(['cfb', 'fcs']);
    expect(leagueNamed(body, 'cfb').stale).toBe(true);
    // The week cursor stuck at 1 is the tell that distinguishes a stall from a
    // quiet week, so it has to reach the response.
    expect(leagueNamed(body, 'cfb').newest).toBe('1');
    // MLB was fine throughout; one stalled league must not smear onto the rest.
    expect(leagueNamed(body, 'mlb').stale).toBe(false);
  });

  it('does not cry stale for a league that is simply out of season', async () => {
    jest.useFakeTimers().setSystemTime(OFF_SEASON);
    // June: MLB is producing, football has written nothing at all.
    mockQuery.mockResolvedValue(rows([aged('mlb', 2)]));

    const { body } = await health();
    expect(body.status).toBe('ok');
    const nfl = leagueNamed(body, 'nfl');
    expect(nfl.in_season).toBe(false);
    expect(nfl.stale).toBe(false);
    expect(nfl.predicted_at).toBeNull();
    expect(nfl.predictions).toBe(0);
  });

  it('treats an in-season league with no rows at all as stale', async () => {
    jest.useFakeTimers().setSystemTime(IN_SEASON);
    mockQuery.mockResolvedValue(rows([aged('mlb', 2), aged('nfl', 30), aged('cfb', 25)]));

    const { body } = await health();
    // FCS is in season and absent from the result - that is a pipeline that has
    // never written, not a pipeline that is up to date.
    expect(leagueNamed(body, 'fcs').stale).toBe(true);
    expect(body.pipelines.stale).toEqual(['fcs']);
  });

  it('says unknown rather than ok when the freshness query fails', async () => {
    jest.useFakeTimers().setSystemTime(IN_SEASON);
    mockQuery.mockRejectedValue(new Error('quota exceeded'));

    const { status, body } = await health();
    expect(status).toBe(200);
    // Not being able to read freshness is not the same as being healthy.
    expect(body.status).toBe('degraded');
    expect(body.pipelines.status).toBe('unknown');
    expect(body.pipelines.error).toMatch(/quota/);
  });

  it('still serves the node-cron job list the wall display reads', async () => {
    jest.useFakeTimers().setSystemTime(IN_SEASON);
    mockQuery.mockResolvedValue(rows([aged('mlb', 2)]));

    const { body } = await health();
    expect(body.scheduler.jobs).toEqual([{ name: 'Job-0', running: true }]);
    expect(typeof body.scheduler.timestamp).toBe('string');
  });

  it('asks BigQuery for the season the calendar is actually in', async () => {
    // January belongs to the season that started the previous August; asking for
    // 2027 in January would empty the board during the playoffs.
    jest.useFakeTimers().setSystemTime(new Date('2027-01-05T20:00:00Z'));
    mockQuery.mockResolvedValue(rows([aged('nfl', 30)]));

    await health();
    expect(mockQuery.mock.calls[0][0].params).toEqual({ season: 2026 });
  });
});
