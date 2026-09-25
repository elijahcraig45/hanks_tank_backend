/**
 * /api/models/:sport/compare and /api/models/mlb/totals-props, against a mocked
 * BigQuery. Pins the contract the Models pages read: the envelope, pregame-only
 * scoring (the backfill trap), flattened temporal values, available:false for tables
 * that do not exist yet, a separate labelled backtest block, and 404/500 behaviour.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import { routeQueries, sentQueries } from './helpers/bq-mock';
import modelsRoutes from '../routes/models.routes';
import footballRoutes from '../routes/football.routes';
import { cacheService } from '../services/cache.service';
import { normalizePropsRow, pOver } from '../controllers/models.controller';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/models', modelsRoutes);
  app.use('/api/football', footballRoutes);
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

const missing = (name: string) => () => {
  throw new Error(`Not found: Table hankstank:mlb_2026_season.${name} was not found`);
};

const START = '2026-09-20T23:05:00.000Z';
const mlbSpine = [
  {
    game_pk: 1001, game_date: { value: '2026-09-20' }, home_team_name: 'Atlanta Braves',
    away_team_name: 'New York Mets', home_score: 5, away_score: 2, final: true,
    game_time_utc: { value: START },
  },
  {
    game_pk: 1002, game_date: { value: '2026-09-20' }, home_team_name: 'Chicago Cubs',
    away_team_name: 'St. Louis Cardinals', home_score: 1, away_score: 4, final: true,
    game_time_utc: { value: START },
  },
];

describe('GET /api/models/mlb/compare', () => {
  beforeEach(() => {
    routeQueries([
      [/WITH g AS/, [mlbSpine]],
      // V10 and Elo read game_predictions; the backfill for 1002 must never be scored.
      [/elo_home_win_prob AS home_win_probability/, [[
        { game_id: '1001', home_win_probability: 0.58, predicted_at: { value: '2026-09-20T20:00:00Z' } },
        { game_id: '1002', home_win_probability: 0.61, predicted_at: { value: '2026-09-20T21:00:00Z' } },
      ]]],
      [/game_predictions_logit3/, missing('game_predictions_logit3')],
      [/game_predictions_sim_blend/, missing('game_predictions_sim_blend')],
      [/game_predictions`/, [[
        { game_id: '1001', home_win_probability: 0.55, predicted_at: { value: '2026-09-20T20:00:00Z' }, model_version: 'v10' },
        { game_id: '1002', home_win_probability: 0.52, predicted_at: { value: '2026-09-20T21:00:00Z' }, model_version: 'v10' },
        { game_id: '1002', home_win_probability: 0.05, predicted_at: { value: '2026-09-22T10:00:00Z' }, model_version: 'v10' },
      ]]],
    ]);
  });

  it('returns the envelope with statuses, a pregame-only scoreboard and flattened dates', async () => {
    const { status, body } = await get('/api/models/mlb/compare?season=2026&date=2026-09-20');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const d = body.data;
    const byKey = Object.fromEntries(d.models.map((m: any) => [m.key, m]));
    expect(byKey.v10.available).toBe(true);
    expect(byKey.elo.available).toBe(true);
    expect(byKey.logit3.available).toBe(false);
    expect(byKey.logit3.note).toMatch(/Not live yet/);
    expect(byKey.sim_blend.available).toBe(false);
    expect(byKey.market.backtest_only).toBe(true);
    expect(byKey.market.available).toBe(false);

    // The post-game backfill (0.05) is not what 1002 is scored on.
    const g1002 = d.games.find((g: any) => g.game_id === '1002');
    expect(g1002.predictions.v10.home_win_probability).toBe(0.52);
    expect(g1002.predictions.v10.pregame).toBe(true);
    expect(g1002.date).toBe('2026-09-20');
    expect(g1002.start_time).toBe(START);
    expect(g1002.disagreement.models).toBe(2);

    const v10 = d.scoreboard.per_model.find((r: any) => r.model === 'v10');
    expect(v10.n).toBe(2);
    expect(v10.small_sample).toBe(true);
    expect(v10.log_loss.value).toBeCloseTo((-Math.log(0.55) - Math.log(0.48)) / 2, 4);
    expect(d.scoreboard.head_to_head.games).toBe(2);
    expect(d.reference).toBe('v10');
    expect(d.scoreboard.calibration.v10.length).toBeGreaterThan(0);

    // Backtest is its own block, labelled, never mixed into live.
    expect(d.backtest.kind).toBe('backtest');
    expect(d.backtest.label).toMatch(/Backtest/);
    expect(d.backtest.windows.length).toBeGreaterThan(0);
    expect(d.backtest.windows[0].source).toBeTruthy();

    // Block keys stay internal.
    expect(d.games[0].block).toBeUndefined();
    // No query was sent for the backtest-only market.
    expect(sentQueries().every((q) => !/market/.test(q))).toBe(true);
  });
});

describe('GET /api/models/:sport/compare (football)', () => {
  const spineRow = {
    game_id: '2026_03_BUF_MIA', season: 2026, week: 3, division: null,
    home_team_name: 'MIA', away_team_name: 'BUF',
    kickoff: { value: '2026-09-20T17:00:00.000Z' },
    home_score: 17, away_score: 24, home_won: 0,
    spread_line: -3, home_moneyline: 140, away_moneyline: -160,
  };

  it('adds the market, lists the planned drive sim, and notes missing shadow tables', async () => {
    routeQueries([
      [/WITH p AS/, [[spineRow]]],
      [/game_predictions_ridge_shadow/, () => { throw new Error('Not found: Table x.ridge'); }],
      [/fpi_game_predictions/, () => { throw new Error('Not found: Table x.fpi'); }],
      [/game_predictions`/, [[{
        game_id: '2026_03_BUF_MIA', home_win_probability: 0.45,
        predicted_at: { value: '2026-09-16T10:00:00Z' }, model_version: 'nfl_v1',
      }]]],
    ]);
    const { status, body } = await get('/api/models/nfl/compare?season=2026');
    expect(status).toBe(200);
    const d = body.data;
    const byKey = Object.fromEntries(d.models.map((m: any) => [m.key, m]));
    expect(byKey.market.available).toBe(true);
    expect(byKey.market.role).toBe('benchmark');
    expect(byKey.drive_sim.planned).toBe(true);
    expect(byKey.drive_sim.backtest_only).toBe(true);
    expect(byKey.ridge.available).toBe(false);
    expect(d.reference).toBe('market');
    expect(d.window.week).toBe(3);
    expect(d.games[0].predictions.market.basis).toBe('moneyline');
    expect(d.scoreboard.head_to_head.models).toEqual(['market', 'xgb']);
    expect(d.backtest.sport).toBe('nfl');
    expect(sentQueries().some((q) => /drive_sim/.test(q))).toBe(false);
  });

  it('labels the college backtest as FBS-only on the FCS board', async () => {
    routeQueries([[/WITH p AS/, [[]]]]);
    const { body } = await get('/api/models/cfb/compare?season=2026&division=fcs');
    expect(body.data.division).toBe('fcs');
    expect(body.data.backtest.scope_note).toMatch(/FBS games only/);
  });

  it('keeps the old football route working', async () => {
    routeQueries([[/WITH p AS/, [[spineRow]]]]);
    const { status, body } = await get('/api/football/nfl/models/compare?season=2026');
    expect(status).toBe(200);
    expect(body.data.scoreboard.per_model).toBeDefined();
  });

  it('404s an unknown sport and 500s a real failure without leaking it', async () => {
    expect((await get('/api/models/xfl/compare')).status).toBe(404);
    routeQueries([[/WITH p AS/, () => { throw new Error('quota exceeded'); }]]);
    const { status, body } = await get('/api/models/nfl/compare?season=2026');
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/quota/);
  });
});

describe('GET /api/models/mlb/totals-props', () => {
  it('answers available:false with the backtest when the shadow table does not exist', async () => {
    routeQueries([[/game_props_sim/, missing('game_props_sim')]]);
    const { status, body } = await get('/api/models/mlb/totals-props?date=2026-09-24');
    expect(status).toBe(200);
    expect(body.data.available).toBe(false);
    expect(body.data.note).toMatch(/Not live yet/);
    expect(body.data.backtest.totals).toBeDefined();
    expect(body.data.batter_props.shown).toBe(false);
  });

  it('serves pregame rows only, normalised', async () => {
    routeQueries([[/game_props_sim/, [[{
      game_pk: 7, game_date: { value: '2026-09-24' }, game_time_utc: { value: START },
      predicted_at: { value: '2026-09-20T20:00:00Z' }, home_team_name: 'A', away_team_name: 'B',
      mean_total_runs: 8.9, total_runs_pmf: [0.1, 0.2, 0.3, 0.4],
      home_starter_k_pmf: [0.5, 0.5], home_starter_k_mean: 0.5,
      batter_props_json: '{"x":1}',
    }]]]]);
    const { body } = await get('/api/models/mlb/totals-props?date=2026-09-24');
    expect(body.data.available).toBe(true);
    const g = body.data.games[0];
    expect(g.game_date).toBe('2026-09-24');
    expect(g.predicted_at).toBe('2026-09-20T20:00:00.000Z');
    expect(g.batter_props).toBeNull();
    expect(sentQueries()[0]).toMatch(/predicted_at < game_time_utc/);
  });
});

describe('props helpers', () => {
  it('pOver sums the pmf strictly above a half-point line', () => {
    expect(pOver([0.25, 0.25, 0.25, 0.25], 1.5)).toBe(0.5);
    expect(pOver([], 8.5)).toBeNull();
  });

  it('normalizePropsRow never passes batter props through', () => {
    expect(normalizePropsRow({ game_pk: 1, batter_props_json: '{}' }).batter_props).toBeNull();
  });
});
