/**
 * Tests for /api/rankings/:sport.
 *
 * Pins the board's display contract: DATE/TIMESTAMP columns arrive as strings (BigQuery
 * returns { value } wrappers), meta carries the as-of date and computed time, and the
 * method text follows the model the board was fitted with.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import { rows, queue } from './helpers/bq-mock';
import rankingsRoutes from '../routes/rankings.routes';
import { cacheService } from '../services/cache.service';
import { normalizeRankingRow } from '../controllers/rankings.controller';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/rankings', rankingsRoutes);
  server = app.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });
beforeEach(async () => {
  jest.clearAllMocks();
  await cacheService.flush();
});

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any };
};

describe('normalizeRankingRow', () => {
  it('flattens BigQuery temporal wrappers and leaves other fields alone', () => {
    const out = normalizeRankingRow({
      team: 'Milwaukee Brewers',
      rating: 61.2,
      computed_at: { value: '2026-09-25T11:02:03.000Z' },
      as_of_date: { value: '2026-09-24' },
    });
    expect(out).toEqual({
      team: 'Milwaukee Brewers',
      rating: 61.2,
      computed_at: '2026-09-25T11:02:03.000Z',
      as_of_date: '2026-09-24',
    });
  });

  it('tolerates rows from tables that predate the columns', () => {
    expect(normalizeRankingRow({ team: 'X' })).toEqual({ team: 'X' });
  });
});

describe('GET /api/rankings/:sport', () => {
  it('exposes the as-of date, computed time and model in meta', async () => {
    queue(rows([{
      season: 2026, rank: 1, team: 'Milwaukee Brewers', as_of_week: 27,
      as_of_date: { value: '2026-09-24' },
      computed_at: { value: '2026-09-25T11:02:03.000Z' },
      model: 'margin', record_season: 2026,
    }]));
    const { status, body } = await get('/api/rankings/mlb?season=2026');

    expect(status).toBe(200);
    expect(body.data[0].as_of_date).toBe('2026-09-24');
    expect(body.meta.as_of_date).toBe('2026-09-24');
    expect(body.meta.computed_at).toBe('2026-09-25T11:02:03.000Z');
    expect(body.meta.model).toBe('margin');
    expect(body.meta.method).toMatch(/margin/);
  });

  it('describes older boards without a model column as Bradley-Terry', async () => {
    queue(rows([{ season: 2025, rank: 1, team: 'KC', as_of_week: 18, record_season: 2025 }]));
    const { body } = await get('/api/rankings/nfl?season=2025');

    expect(body.meta.model).toBe('bt');
    expect(body.meta.method).toMatch(/Bradley-Terry/);
    expect(body.meta.as_of_date).toBeNull();
  });
});

describe('rationale columns', () => {
  it('serves the JSON rationale columns parsed, under their short names', () => {
    const out = normalizeRankingRow({
      team: 'Notre Dame Fighting Irish',
      why_json: '{"best":[3],"worst":[],"tied_with":[{"rank":2,"p_order":0.485}]}',
      games_json: '[{"opp":"Purdue Boilermakers","won":true,"pf":49,"pa":10,"contrib":27.23}]',
      vs_next_json: null,
      summary: '#1 because: 4-0',
    });
    expect(out.why.best).toEqual([3]);
    expect(out.games[0].opp).toBe('Purdue Boilermakers');
    expect(out.vs_next).toBeNull();
    expect(out.summary).toBe('#1 because: 4-0');
    expect(out).not.toHaveProperty('why_json');
    expect(out).not.toHaveProperty('games_json');
  });

  it('degrades a malformed JSON column to null instead of throwing', () => {
    expect(normalizeRankingRow({ team: 'X', games_json: '{oops' }).games).toBeNull();
  });
});

const game = (opp: string, won: boolean, pf: number, pa: number, over = 0) => ({
  opp, won, pf, pa, margin: pf - pa, over, site: 'H',
});

const lsu = {
  season: 2026, rank: 11, team: 'LSU Tigers', division: 'fbs', as_of_week: 4,
  rating: 745.8, rating_from_prior: 122.0, rating_from_current: 623.8,
  rank_p05: 3, rank_p95: 33, sched_rank: 2,
  why_json: JSON.stringify({ points_per_rating: 0.06114 }),
  games_json: JSON.stringify([game('Ole Miss Rebels', false, 24, 32, -10.2),
    game('Clemson Tigers', true, 51, 10, 19.8)]),
  vs_next_json: JSON.stringify({ b: 'Florida Gators', p_order: 0.565 }),
};
const florida = {
  season: 2026, rank: 12, team: 'Florida Gators', division: 'fbs', as_of_week: 4,
  rating: 716.6, rating_from_prior: 54.8, rating_from_current: 661.8,
  rank_p05: 7, rank_p95: 37, sched_rank: 39,
  why_json: JSON.stringify({ points_per_rating: 0.06114 }),
  games_json: JSON.stringify([game('Ole Miss Rebels', true, 52, 28, 16.0)]),
  vs_next_json: null,
};

describe('GET /api/rankings/:sport/compare', () => {
  it('explains the higher-rated team first, whichever order it was asked in', async () => {
    queue(rows([florida, lsu]));
    const { status, body } = await get(
      '/api/rankings/cfb/compare?a=Florida%20Gators&b=LSU%20Tigers&season=2026'
    );

    expect(status).toBe(200);
    const pair = body.data;
    expect(pair.a).toBe('LSU Tigers');
    expect(pair.gap).toBeCloseTo(29.2, 1);
    expect(pair.gap_points).toBeCloseTo(1.8, 1);
    // The split of the gap adds back up to the gap.
    expect(pair.gap_from_prior + pair.gap_from_current).toBeCloseTo(pair.gap, 1);
    expect(pair.p_a_wins_neutral).toBeCloseTo(0.542, 2);
    expect(pair.h2h).toBeNull();
    expect(pair.common.map((c: any) => c.opp)).toEqual(['Ole Miss Rebels']);
    expect(pair.common[0].a.games).toEqual(['L 24-32']);
    expect(pair.common[0].b.games).toEqual(['W 52-28']);
    // Adjacent: the stored bootstrap order decides the tie.
    expect(pair.p_order).toBe(0.565);
    expect(pair.tied).toBe(true);
    expect(pair.tie_basis).toBe('bootstrap_order');
    expect(pair.text).toMatch(/Statistically tied/);
    expect(body.meta.has_rationale).toBe(true);
  });

  it('falls back to rank bands for a non-adjacent pair', async () => {
    const top = { ...lsu, team: 'A', rank: 1, rating: 900, rank_p05: 1, rank_p95: 2,
      vs_next_json: null };
    queue(rows([top, florida]));
    const { body } = await get('/api/rankings/cfb/compare?a=A&b=Florida%20Gators');

    expect(body.data.p_order).toBeNull();
    expect(body.data.tie_basis).toBe('rank_bands');
    expect(body.data.tied).toBe(false);
  });

  it('reports head to head from the higher team\'s side', async () => {
    const a = { ...lsu, team: 'A', games_json: JSON.stringify([game('B', true, 21, 14)]) };
    const b = { ...florida, team: 'B', games_json: JSON.stringify([game('A', false, 14, 21)]) };
    queue(rows([a, b]));
    const { body } = await get('/api/rankings/cfb/compare?a=B&b=A');

    expect(body.data.h2h).toMatchObject({ w: 1, l: 0, games: ['W 21-14'] });
    expect(body.data.text).toMatch(/head to head A went 1-0/);
  });

  it('rejects a missing or repeated team', async () => {
    const { status, body } = await get('/api/rankings/cfb/compare?a=A&b=A');
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_PAIR');
  });

  it('404s a team that is not on the board', async () => {
    queue(rows([lsu]));
    const { status, body } = await get('/api/rankings/cfb/compare?a=LSU%20Tigers&b=Nowhere');
    expect(status).toBe(404);
    expect(body.error.message).toMatch(/Nowhere/);
  });
});
