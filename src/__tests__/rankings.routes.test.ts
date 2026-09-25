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
