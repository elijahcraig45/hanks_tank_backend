/**
 * /api/season-sim/:sport and its export, against a mocked BigQuery and a temp fixture
 * directory. Pins: the envelope, sport validation, latest-season/latest-week defaults,
 * flattened temporal values, 404 for empty or missing tables, CSV export, fixture mode.
 */

import express from 'express';
import { Server } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import { routeQueries, sentQueries, sentParamsFor, mockQuery } from './helpers/bq-mock';
import seasonSimRoutes from '../routes/season-sim.routes';
import { cacheService } from '../services/cache.service';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/season-sim', seasonSimRoutes);
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
  mockQuery.mockReset();
  delete process.env.SEASON_SIM_FIXTURE_DIR;
  await cacheService.flush();
});

const get = async (p: string) => {
  const res = await fetch(`${baseUrl}${p}`);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body, headers: res.headers, text };
};

const COMPUTED = { value: '2026-09-28T09:00:00.000Z' };
const teamRow = (team: string, extra: Record<string, any> = {}) => ({
  sport: 'nfl', season: 2026, as_of_week: 4, computed_at: COMPUTED,
  model_version: 'season_sim_v1', n_sims: 10000, team, team_name: `${team} name`,
  conference: 'AFC', division: 'AFC West', wins: 3, losses: 1, ties: 0,
  rating: 4.2, rating_sd: 2.1, mean_wins: 11.2, wins_dist: '[0,0.1,0.9]',
  p_seed: '[0.3,0.2,0.1,0.1,0.05,0.05,0.05]', p_division: 0.6, p_playoffs: 0.85,
  p_champion: 0.12, ...extra,
});
const bracketRow = {
  sport: 'nfl', season: 2026, as_of_week: 4, computed_at: COMPUTED,
  bracket: 'AFC', round: 'seed', round_order: 0, slot: 1, slot_label: '#1 seed',
  team: 'KC', team_name: 'KC name', p_slot: 0.3, p_win: 0.3, is_modal: true,
  modal_opponent: null,
};

const slices = [
  { season: 2026, as_of_week: 4, computed_at: COMPUTED },
  { season: 2026, as_of_week: 3, computed_at: COMPUTED },
  { season: 2025, as_of_week: 18, computed_at: COMPUTED },
];

const missing = (name: string) => () => {
  throw new Error(`Not found: Table hankstank:nfl_season.${name} was not found in location US`);
};

function happy() {
  routeQueries([
    [/GROUP BY season, as_of_week/, [slices]],
    [/season_sim_team/, [[teamRow('KC'), teamRow('DEN', { team_name: 'Denver, "Broncos"' })]]],
    [/season_sim_bracket/, [[bracketRow]]],
  ]);
}

describe('GET /api/season-sim/:sport', () => {
  it('returns the contract envelope with flattened temporal values', async () => {
    happy();
    const { status, body } = await get('/api/season-sim/nfl');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.teams).toHaveLength(2);
    expect(body.data.bracket).toHaveLength(1);
    expect(body.data.teams[0].computed_at).toBe('2026-09-28T09:00:00.000Z');
    expect(body.data.bracket[0].computed_at).toBe('2026-09-28T09:00:00.000Z');
    expect(body.meta).toEqual({
      sport: 'nfl', season: 2026, as_of_week: 4,
      computed_at: '2026-09-28T09:00:00.000Z', n_sims: 10000,
      model_version: 'season_sim_v1', available_weeks: [3, 4],
      source: 'bigquery', method_url: '/learn/season-sim.html',
    });
  });

  it('defaults to the latest season and week, and takes the latest computed_at', async () => {
    happy();
    await get('/api/season-sim/nfl');
    expect(sentParamsFor(/FROM `hankstank.nfl_season.season_sim_team`\s+WHERE season = @season AND/))
      .toEqual({ season: 2026, week: 4 });
    const teamSql = sentQueries().find((q) => /SELECT \*/.test(q) && /season_sim_team/.test(q));
    expect(teamSql).toMatch(/computed_at = \(\s*SELECT MAX\(computed_at\)/);
  });

  it('honours explicit season and week, parameterised', async () => {
    happy();
    const { body } = await get('/api/season-sim/nfl?season=2026&week=3');
    expect(body.meta.as_of_week).toBe(3);
    expect(sentParamsFor(/GROUP BY season, as_of_week/)).toEqual({ season: 2026 });
    for (const q of sentQueries()) expect(q).not.toMatch(/2026|= 3\b/);
  });

  it('uses the cfb dataset for cfb', async () => {
    happy();
    await get('/api/season-sim/cfb');
    expect(sentQueries().every((q) => /cfb_season\.season_sim_/.test(q))).toBe(true);
  });

  it('rejects an unknown sport with 404 and a bad week with 400', async () => {
    const mlb = await get('/api/season-sim/mlb');
    expect(mlb.status).toBe(404);
    expect(mlb.body.success).toBe(false);
    expect(mlb.body.error.code).toBe('UNKNOWN_SPORT');
    const bad = await get('/api/season-sim/nfl?week=abc');
    expect(bad.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('404s when the table does not exist', async () => {
    routeQueries([[/season_sim_team/, missing('season_sim_team')]]);
    const { status, body } = await get('/api/season-sim/nfl');
    expect(status).toBe(404);
    expect(body).toEqual({ success: false, error: expect.objectContaining({ code: 'NOT_AVAILABLE' }) });
  });

  it('404s when the table is empty or the week is absent', async () => {
    routeQueries([[/GROUP BY/, [[]]]]);
    expect((await get('/api/season-sim/nfl')).status).toBe(404);
    await cacheService.flush();
    happy();
    expect((await get('/api/season-sim/nfl?week=9')).status).toBe(404);
  });

  it('still serves teams when only the bracket table is missing', async () => {
    routeQueries([
      [/GROUP BY season, as_of_week/, [slices]],
      [/season_sim_bracket/, missing('season_sim_bracket')],
      [/season_sim_team/, [[teamRow('KC')]]],
    ]);
    const { status, body } = await get('/api/season-sim/nfl');
    expect(status).toBe(200);
    expect(body.data.bracket).toEqual([]);
    expect(body.meta.note).toMatch(/Bracket/);
  });

  it('500s on an unexpected BigQuery error without leaking it', async () => {
    routeQueries([[/GROUP BY/, () => { throw new Error('quota exceeded'); }]]);
    const { status, body } = await get('/api/season-sim/nfl');
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/quota/);
  });

  it('caches the slice', async () => {
    happy();
    await get('/api/season-sim/nfl');
    const calls = mockQuery.mock.calls.length;
    await get('/api/season-sim/nfl');
    expect(mockQuery.mock.calls.length).toBe(calls);
  });
});

describe('GET /api/season-sim/:sport/export', () => {
  it('downloads the team table as CSV in contract column order', async () => {
    happy();
    const { status, headers, text } = await get('/api/season-sim/nfl/export?table=team&format=csv');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/text\/csv/);
    expect(headers.get('content-disposition'))
      .toBe('attachment; filename="season_sim_nfl_2026_wk4_team.csv"');
    const lines = text.trim().split('\r\n');
    expect(lines[0].startsWith('sport,season,as_of_week,computed_at,model_version,n_sims,team,')).toBe(true);
    expect(lines).toHaveLength(3);
    expect(text).toContain('"Denver, ""Broncos"""');
    expect(text).toContain('2026-09-28T09:00:00.000Z');
  });

  it('returns the bracket as a bare JSON array', async () => {
    happy();
    const { status, body } = await get('/api/season-sim/nfl/export?table=bracket&format=json');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].slot_label).toBe('#1 seed');
  });

  it('validates table and format', async () => {
    expect((await get('/api/season-sim/nfl/export?table=games')).status).toBe(400);
    expect((await get('/api/season-sim/nfl/export?format=xml')).status).toBe(400);
  });

  it('404s the export when there is no data', async () => {
    routeQueries([[/season_sim_team/, missing('season_sim_team')]]);
    const { status, body } = await get('/api/season-sim/cfb/export');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

describe('fixture mode (SEASON_SIM_FIXTURE_DIR)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ssim-'));
    writeFileSync(path.join(dir, 'season_sim_nfl.json'), JSON.stringify({
      teams: [{ ...teamRow('KC'), computed_at: '2026-09-28T09:00:00Z' }],
      bracket: [{ ...bracketRow, computed_at: '2026-09-28T09:00:00Z' }],
      meta: { season: 2026, as_of_week: 4, n_sims: 500, model_version: 'fixture_v1', available_weeks: [4] },
    }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the fixture instead of BigQuery and says so', async () => {
    process.env.SEASON_SIM_FIXTURE_DIR = dir;
    const { status, body } = await get('/api/season-sim/nfl');
    expect(status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(body.meta.source).toBe('fixture');
    expect(body.meta.n_sims).toBe(500);
    expect(body.meta.computed_at).toBe('2026-09-28T09:00:00.000Z');
    expect(body.data.teams[0].team).toBe('KC');
  });

  it('404s for a sport with no fixture file', async () => {
    process.env.SEASON_SIM_FIXTURE_DIR = dir;
    const { status } = await get('/api/season-sim/cfb');
    expect(status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is inert when the env var is unset', async () => {
    happy();
    const { body } = await get('/api/season-sim/nfl');
    expect(body.meta.source).toBe('bigquery');
    expect(mockQuery).toHaveBeenCalled();
  });
});
