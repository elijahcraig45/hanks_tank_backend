/**
 * /api/predictions/:sport/slate and /api/predictions/:sport/players against a mocked
 * BigQuery and MLB API. Pins the unified-predictions contract: the envelope, every
 * model present per game (null when it has no row), available:false for tables that do
 * not exist, the pregame rule (latest pregame row; post-start rows flagged, never used
 * for consensus), disagreement thresholds, the CSV export, player filtering and caching.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('../services/mlb-api.service', () => ({
  mlbApi: { getScheduleWithOptions: jest.fn() },
}));

import { routeQueries, sentQueries, mockQuery } from './helpers/bq-mock';
import predictionsRoutes from '../routes/predictions.routes';
import { cacheService } from '../services/cache.service';
import { mlbApi } from '../services/mlb-api.service';
import {
  consensusOf, csvField, disagreementLevel, exportFilename, toCsv, SLATE_CSV_HEADERS,
  distFromRow,
} from '../utils/unified-slate';
import { pickPlayerRows } from '../controllers/unified-predictions.controller';

const schedule = mlbApi.getScheduleWithOptions as jest.Mock;

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/predictions', predictionsRoutes);
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
  schedule.mockReset();
  await cacheService.flush();
});

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body, headers: res.headers, text };
};

const missing = (name: string) => () => {
  throw new Error(`Not found: Table hankstank:mlb_2026_season.${name} was not found in location US`);
};

/* ── MLB fixtures ─────────────────────────────────────────────────────── */

const DATE = '2030-06-15'; // in the future, so the slate is "upcoming"
const START_A = '2030-06-15T23:05:00.000Z';
const START_B = '2030-06-16T01:10:00.000Z';

const mlbSpine = [
  {
    game_pk: 1001, home_team_id: 144, away_team_id: 121, home_team_name: 'Atlanta Braves',
    away_team_name: 'New York Mets', home_abbr: 'ATL', away_abbr: 'NYM',
    game_time_utc: { value: START_A }, home_score: null, away_score: null, final: null, status: null,
  },
  {
    game_pk: 1002, home_team_id: 112, away_team_id: 138, home_team_name: 'Chicago Cubs',
    away_team_name: 'St. Louis Cardinals', home_abbr: 'CHC', away_abbr: 'STL',
    game_time_utc: { value: START_B }, home_score: null, away_score: null, final: null, status: null,
  },
];

const apiSchedule = {
  dates: [{
    games: [
      {
        gamePk: 1001, gameType: 'R', gameDate: '2030-06-15T23:05:00Z',
        status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
        teams: {
          home: { team: { id: 144, name: 'Atlanta Braves', abbreviation: 'ATL' } },
          away: { team: { id: 121, name: 'New York Mets', abbreviation: 'NYM' } },
        },
      },
      // Not predicted by anything yet: still listed, every model null.
      {
        gamePk: 1003, gameType: 'R', gameDate: '2030-06-15T17:10:00Z',
        status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
        teams: {
          home: { team: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET' } },
          away: { team: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT' } },
        },
      },
      { gamePk: 9999, gameType: 'S', gameDate: '2030-06-15T17:10:00Z', status: {}, teams: {} },
    ],
  }],
};

const v10Rows = [
  // 1001: an early and a later pregame row; the later one wins.
  { game_id: '1001', home_win_probability: 0.51, predicted_at: { value: '2030-06-15T14:00:00Z' }, model_version: 'v10' },
  { game_id: '1001', home_win_probability: 0.55, predicted_at: { value: '2030-06-15T21:30:00Z' }, model_version: 'v10' },
  // ...and a post-start backfill, which must never be used.
  { game_id: '1001', home_win_probability: 0.05, predicted_at: { value: '2030-06-17T10:00:00Z' }, model_version: 'v10' },
  // 1002: only a post-start row. Shown, flagged, not in the consensus.
  { game_id: '1002', home_win_probability: 0.62, predicted_at: { value: '2030-06-16T02:00:00Z' }, model_version: 'v10' },
];

const eloRows = [
  { game_id: '1001', home_win_probability: 0.66, predicted_at: { value: '2030-06-15T21:30:00Z' } },
];

const simBlendRows = [
  {
    game_id: '1001', home_win_probability: 0.58, predicted_home_margin: 0.4, predicted_total: 8.8,
    predicted_home_score: 4.6, predicted_away_score: 4.2,
    predicted_at: { value: '2030-06-15T21:00:00Z' }, model_version: 'sim_blend_v1',
  },
];

const distRow = {
  game_pk: 1001, game_date: { value: DATE }, predicted_at: { value: '2030-06-15T21:00:00Z' },
  model_version: 'pa_sim_v2', n_sims: 3000,
  home_runs_mean: 4.62, home_runs_sd: 2.91, home_runs_p05: 1, home_runs_p25: 2, home_runs_p50: 4,
  home_runs_p75: 6, home_runs_p95: 10, home_runs_min: 0, home_runs_max: 19,
  away_runs_mean: 4.1, away_runs_sd: 2.7, away_runs_p05: 1, away_runs_p25: 2, away_runs_p50: 4,
  away_runs_p75: 6, away_runs_p95: 9, away_runs_min: 0, away_runs_max: 17,
  total_mean: 8.72, total_sd: 4.0, total_p05: 3, total_p25: 6, total_p50: 8, total_p75: 11,
  total_p95: 16, total_min: 0, total_max: 30,
  margin_mean: 0.52, margin_sd: 4.1, margin_p05: -6, margin_p25: -2, margin_p50: 1,
  margin_p75: 3, margin_p95: 7, margin_min: -15, margin_max: 16,
  p_home_win: 0.57, p_extra_innings: 0.09, p_home_cover_rl: 0.41,
  p_over_by_line: '{"8.5": 0.47, "9.5": 0.38}',
};

function mlbRoutes(opts: { logit3Missing?: boolean; simMissing?: boolean; playersMissing?: boolean } = {}) {
  routeQueries([
    [/FULL OUTER JOIN g/, [mlbSpine]],
    [/game_sim_distributions/, opts.simMissing ? missing('game_sim_distributions') : [[distRow]]],
    [/player_sim_projections/, opts.playersMissing ? missing('player_sim_projections') : [[{ game_id: '1001' }]]],
    [/elo_home_win_prob AS home_win_probability/, [eloRows]],
    [/game_predictions_logit3/, opts.logit3Missing ? missing('game_predictions_logit3') : [[]]],
    [/game_predictions_sim_blend/, [simBlendRows]],
    [/game_predictions`/, [v10Rows]],
  ]);
}

describe('GET /api/predictions/mlb/slate', () => {
  it('returns the envelope, every model per game, and flags missing tables', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes({ logit3Missing: true });
    const { status, body } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual(expect.objectContaining({ sport: 'mlb', count: 3, cache_ttl: 300 }));

    const d = body.data;
    expect(d).toEqual(expect.objectContaining({
      sport: 'mlb', date: DATE, season: 2030, week: null, featured_default: 'v10',
    }));
    const byKey = Object.fromEntries(d.models.map((m: any) => [m.key, m]));
    expect(Object.keys(byKey)).toEqual(['v10', 'logit3', 'sim_blend', 'elo', 'market']);
    expect(byKey.v10).toEqual(expect.objectContaining({
      available: true, role: 'production', outputs: ['win_prob'], learn: '/learn/mlb-v10-features.html',
    }));
    expect(byKey.logit3.available).toBe(false);
    expect(byKey.logit3.note).toMatch(/game_predictions_logit3/);
    expect(byKey.market.available).toBe(false);
    expect(byKey.sim_blend.outputs).toContain('players');

    // Spring-training game dropped; unpredicted 1003 listed; sorted by start.
    expect(d.games.map((g: any) => g.game_id)).toEqual(['1003', '1001', '1002']);
    for (const g of d.games) {
      expect(Object.keys(g.predictions).sort()).toEqual(['elo', 'logit3', 'market', 'sim_blend', 'v10']);
    }
    const g1003 = d.games[0];
    expect(Object.values(g1003.predictions).every((p) => p === null)).toBe(true);
    expect(g1003.consensus).toEqual({ home_win_prob_mean: null, spread: null, models_n: 0 });
    expect(g1003.disagreement).toBeNull();
    expect(g1003.home).toEqual({ id: '116', name: 'Detroit Tigers', abbr: 'DET' });
    expect(g1003.status).toBe('scheduled');
    expect(g1003.result).toEqual({ home_score: null, away_score: null });
  });

  it('uses the latest pregame row, never a post-start backfill', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes();
    const { body } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    const g1001 = body.data.games.find((g: any) => g.game_id === '1001');
    expect(g1001.start_time).toBe(START_A);
    expect(g1001.predictions.v10).toEqual(expect.objectContaining({
      home_win_prob: 0.55, pregame: true, predicted_at: '2030-06-15T21:30:00.000Z',
      home_score: null, total: null, margin: null, dist: null,
    }));

    // 1002's only row is post-start: shown flagged, and out of the consensus.
    const g1002 = body.data.games.find((g: any) => g.game_id === '1002');
    expect(g1002.predictions.v10).toEqual(expect.objectContaining({ home_win_prob: 0.62, pregame: false }));
    expect(g1002.consensus.models_n).toBe(0);
    expect(g1002.predictions.elo).toBeNull();
  });

  it('attaches simulator distributions, extras and has_players to sim_blend', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes();
    const { body } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    const g = body.data.games.find((x: any) => x.game_id === '1001');
    const sb = g.predictions.sim_blend;
    expect(sb.home_win_prob).toBe(0.58); // the model's own row, not the sim's p_home_win
    expect(sb.home_score).toEqual({
      mean: 4.62, sd: 2.91, p05: 1, p25: 2, p50: 4, p75: 6, p95: 10, min: 0, max: 19, n: 3000,
    });
    expect(sb.total.p50).toBe(8);
    expect(sb.margin.min).toBe(-15);
    expect(sb.extras).toEqual(expect.objectContaining({
      p_extra_innings: 0.09, p_home_cover_rl: 0.41, p_over_by_line: { 8.5: 0.47, 9.5: 0.38 },
    }));
    expect(sb.dist).toEqual({
      model_version: 'pa_sim_v2', predicted_at: '2030-06-15T21:00:00.000Z', pregame: true, n_sims: 3000,
    });
    expect(sb.has_players).toBe(true);

    // v10 0.55, sim_blend 0.58, elo 0.66 -> spread 0.11 -> medium.
    expect(g.consensus).toEqual({ home_win_prob_mean: 0.5967, spread: 0.11, models_n: 3 });
    expect(g.disagreement).toBe('medium');
  });

  it('falls back to point estimates when the distributions table is missing', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes({ simMissing: true, playersMissing: true });
    const { body } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    const sb = body.data.games.find((x: any) => x.game_id === '1001').predictions.sim_blend;
    expect(sb.home_score).toEqual(expect.objectContaining({ mean: 4.6, sd: null, p50: null, n: null }));
    expect(sb.total.mean).toBe(8.8);
    expect(sb.dist).toBeNull();
    expect(sb.has_players).toBe(false);
    expect(body.meta.sim_distributions).toBe('missing');
  });

  it('still answers from BigQuery when the MLB API is down', async () => {
    schedule.mockRejectedValue(new Error('ECONNRESET'));
    mlbRoutes();
    const { status, body } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect(status).toBe(200);
    expect(body.data.games.map((g: any) => g.game_id)).toEqual(['1001', '1002']);
    expect(body.meta.schedule_source).toBe('bigquery');
  });

  it('parameterizes the date and caches (5 min upcoming, 1 h past)', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes();
    const first = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(first.headers.get('cache-control')).toBe('public, max-age=300');
    const calls = mockQuery.mock.calls.length;
    const second = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(mockQuery.mock.calls.length).toBe(calls);
    for (const q of sentQueries()) expect(q).not.toContain(DATE);
    expect(mockQuery.mock.calls.every((c) => !c[0].params || !('date' in c[0].params)
      || c[0].params.date === DATE)).toBe(true);

    const past = await get('/api/predictions/mlb/slate?date=2020-06-15');
    expect(past.body.meta.cache_ttl).toBe(3600);
    expect(past.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('validates input and 404s an unknown sport', async () => {
    expect((await get('/api/predictions/mlb/slate?date=2026-9-1')).status).toBe(400);
    expect((await get('/api/predictions/mlb/slate?format=xml')).status).toBe(400);
    expect((await get('/api/predictions/nba/slate')).status).toBe(404);
  });

  it('returns bare data with format=json', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes();
    const { body } = await get(`/api/predictions/mlb/slate?date=${DATE}&format=json`);
    expect(body.success).toBeUndefined();
    expect(body.sport).toBe('mlb');
    expect(body.games).toHaveLength(3);
  });

  it('exports the slate as long-format CSV with a dated filename', async () => {
    schedule.mockResolvedValue(apiSchedule);
    mlbRoutes();
    const res = await get(`/api/predictions/mlb/slate?date=${DATE}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="hankstank_mlb_slate_${DATE}.csv"`);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe(SLATE_CSV_HEADERS.join(','));
    expect(lines).toHaveLength(1 + 3 * 5); // header + games x models
    const header = lines[0].split(',');
    const col = (name: string, line: string) => line.split(',')[header.indexOf(name)];
    const sb = lines.find((l) => l.includes(',1001,') && l.includes(',sim_blend,'))!;
    expect(col('home_score_p95', sb)).toBe('10');
    expect(col('total_mean', sb)).toBe('8.72');
    expect(col('has_prediction', sb)).toBe('true');
    // The JSON map is quoted with its quotes doubled.
    expect(sb).toContain('"{""8.5"":0.47,""9.5"":0.38}"');
    const mk = lines.find((l) => l.includes(',1003,') && l.includes(',market,'))!;
    expect(col('has_prediction', mk)).toBe('false');
    expect(col('home_win_prob', mk)).toBe('');
  });
});

/* ── football ─────────────────────────────────────────────────────────── */

describe('GET /api/predictions/nfl/slate', () => {
  const KICK = '2030-09-28T17:00:00.000Z';
  const spine = [{
    game_id: '2030_03_KC_MIA', season: 2030, week: 3, division: null,
    home_team_name: 'MIA', away_team_name: 'KC', home_team_id: 'MIA', away_team_id: 'KC',
    home_display: 'Miami Dolphins', away_display: 'Kansas City Chiefs', game_pk: null,
    kickoff: { value: KICK }, home_score: null, away_score: null, home_won: null,
    spread_line: -10.5, total_line: 47.5, home_moneyline: null, away_moneyline: null,
    pk_home_score: null, pk_away_score: null, pk_completed: false, pred_spread_line: -10.5,
  }, {
    game_id: '2030_02_KC_BUF', season: 2030, week: 2, division: null,
    home_team_name: 'BUF', away_team_name: 'KC', home_team_id: 'BUF', away_team_id: 'KC',
    kickoff: { value: '2030-09-21T17:00:00.000Z' }, home_score: 20, away_score: 17, home_won: 1,
    spread_line: 2.5, total_line: 50,
  }];

  function nflRoutes() {
    routeQueries([
      [/WITH p AS/, [spine]],
      [/game_sim_distributions/, () => { throw new Error('Not found: Table hankstank:nfl_season.game_sim_distributions'); }],
      [/game_predictions_drive_sim/, () => { throw new Error('Not found: Table hankstank:nfl_season.game_predictions_drive_sim'); }],
      [/game_predictions_ridge_shadow/, [[{
        game_id: '2030_03_KC_MIA', home_win_probability: 0.33, predicted_home_margin: -5.45,
        predicted_at: { value: '2030-09-25T21:30:00Z' }, model_version: 'ridge_v1',
      }]]],
      [/fpi_game_predictions/, [[
        { game_id: '2030_03_KC_MIA', home_win_probability: 0.16, predicted_home_margin: -10.9, predicted_at: { value: '2030-09-24T10:00:00Z' } },
        { game_id: '2030_03_KC_MIA', home_win_probability: 0.145, predicted_home_margin: -11.2, predicted_at: { value: '2030-09-27T10:00:00Z' } },
        // A post-kickoff snapshot (in-game FPI) must not replace the pregame one.
        { game_id: '2030_03_KC_MIA', home_win_probability: 0.9, predicted_home_margin: 7, predicted_at: { value: '2030-09-28T19:00:00Z' } },
      ]]],
      [/game_predictions`/, [[{
        game_id: '2030_03_KC_MIA', home_win_probability: 0.32, predicted_at: { value: '2030-09-23T10:00:00Z' }, model_version: 'nfl_v1',
      }]]],
    ]);
  }

  it('lists every model, the market as spread/total, ridge and FPI margins', async () => {
    nflRoutes();
    const { status, body } = await get('/api/predictions/nfl/slate?season=2030&week=3');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const d = body.data;
    expect(d).toEqual(expect.objectContaining({ sport: 'nfl', season: 2030, week: 3, date: null, featured_default: 'xgb' }));
    expect(d.weeks).toEqual([2, 3]);
    const byKey = Object.fromEntries(d.models.map((m: any) => [m.key, m]));
    expect(byKey.drive_sim.available).toBe(false);
    expect(byKey.ridge.available).toBe(true);
    expect(byKey.market.available).toBe(true);
    expect(d.games).toHaveLength(1);
    const g = d.games[0];
    expect(g.home).toEqual({ id: 'MIA', name: 'Miami Dolphins', abbr: 'MIA' });
    expect(g.predictions.drive_sim).toBeNull();
    expect(g.predictions.market.margin.mean).toBe(-10.5);
    expect(g.predictions.market.total.mean).toBe(47.5);
    expect(g.predictions.market.pregame).toBe(true);
    expect(g.predictions.ridge.margin).toEqual(expect.objectContaining({ mean: -5.45, sd: null }));
    expect(g.predictions.fpi).toEqual(expect.objectContaining({
      home_win_prob: 0.145, pregame: true, predicted_at: '2030-09-27T10:00:00.000Z',
    }));
    expect(g.predictions.fpi.margin.mean).toBe(-11.2);
    expect(['low', 'medium', 'high']).toContain(g.disagreement);
    expect(g.consensus.models_n).toBe(4);
    // Model rows were read for the requested week only, with parameters.
    const ridgeCall = mockQuery.mock.calls.find((c) => /ridge_shadow/.test(c[0].query))![0];
    expect(ridgeCall.params).toEqual({ season: 2030, week: 3 });
    expect(ridgeCall.query).toMatch(/week = @week/);
  });

  it('defaults to the current week and names the CSV by season and week', async () => {
    nflRoutes();
    const { body } = await get('/api/predictions/nfl/slate?season=2030');
    expect(body.data.week).toBe(3);
    const csv = await get('/api/predictions/nfl/slate?season=2030&week=3&format=csv');
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="hankstank_nfl_slate_2030-week3.csv"');
  });

  it('cfb takes a division and rejects an unknown one', async () => {
    nflRoutes();
    await get('/api/predictions/cfb/slate?season=2030&week=3&division=fcs');
    const spineCall = mockQuery.mock.calls.find((c) => /WITH p AS/.test(c[0].query))![0];
    expect(spineCall.params.division).toBe('fcs');
    expect((await get('/api/predictions/cfb/slate?division=d2')).status).toBe(400);
  });
});

/* ── players ──────────────────────────────────────────────────────────── */

describe('GET /api/predictions/:sport/players', () => {
  const rows = [
    // Two snapshots of the same player-stat; the later pregame one wins.
    { game_pk: 1001, game_date: { value: DATE }, player_id: 660670, player_name: 'Ronald Acuña Jr.',
      team_id: 144, team_abbr: 'ATL', role: 'batter', batting_order: 1, stat: 'H',
      mean: 1.02, sd: 0.9, p05: 0, p25: 0, p50: 1, p75: 2, p95: 3, min: 0, max: 5, n_sims: 3000,
      p_at_least_1: 0.66, calibrated: false, calibration_note: 'Over-predicted, "raw"',
      predicted_at: { value: '2030-06-15T15:00:00Z' }, game_time_utc: { value: START_A }, model_version: 'pa_sim_v2' },
    { game_pk: 1001, game_date: { value: DATE }, player_id: 660670, player_name: 'Ronald Acuña Jr.',
      team_id: 144, team_abbr: 'ATL', role: 'batter', batting_order: 1, stat: 'H',
      mean: 1.1, sd: 0.9, p05: 0, p25: 0, p50: 1, p75: 2, p95: 3, min: 0, max: 5, n_sims: 3000,
      p_at_least_1: 0.68, calibrated: false, calibration_note: 'Over-predicted, "raw"',
      predicted_at: { value: '2030-06-15T21:00:00Z' }, game_time_utc: { value: START_A }, model_version: 'pa_sim_v2' },
    // Post-start rerun: not used.
    { game_pk: 1001, game_date: { value: DATE }, player_id: 660670, player_name: 'Ronald Acuña Jr.',
      team_id: 144, team_abbr: 'ATL', role: 'batter', batting_order: 1, stat: 'H',
      mean: 3, predicted_at: { value: '2030-06-16T05:00:00Z' }, game_time_utc: { value: START_A } },
    { game_pk: 1001, game_date: { value: DATE }, player_id: 605141, player_name: 'Starter',
      team_id: 121, team_abbr: 'NYM', role: 'starter', batting_order: null, stat: 'K',
      mean: 6.1, sd: 2.1, p05: 3, p25: 5, p50: 6, p75: 8, p95: 10, min: 0, max: 14, n_sims: 3000,
      p_at_least_1: null, calibrated: true, calibration_note: null,
      predicted_at: { value: '2030-06-15T21:00:00Z' }, game_time_utc: { value: START_A } },
  ];

  it('filters by game_id with a parameter and keeps the latest pregame row per player-stat', async () => {
    schedule.mockResolvedValue(apiSchedule);
    routeQueries([[/player_sim_projections/, [rows]]]);
    const { status, body } = await get('/api/predictions/mlb/players?game_id=1001');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.available).toBe(true);
    expect(body.data.game_id).toBe('1001');
    const call = mockQuery.mock.calls.find((c) => /player_sim_projections/.test(c[0].query))![0];
    expect(call.params).toEqual({ game_id: '1001' });
    expect(call.query).toMatch(/CAST\(p\.game_pk AS STRING\) = @game_id/);
    expect(body.data.rows).toHaveLength(2);
    // Starters sort first within a team; here the teams differ, so by team id.
    const h = body.data.rows.find((r: any) => r.stat === 'H');
    expect(h).toEqual(expect.objectContaining({
      game_id: '1001', player_id: '660670', team_abbr: 'ATL', role: 'batter', batting_order: 1,
      mean: 1.1, p50: 1, n: 3000, p_at_least_1: 0.68, calibrated: false, pregame: true,
      predicted_at: '2030-06-15T21:00:00.000Z',
    }));
  });

  it('filters by date and exports CSV with escaping', async () => {
    schedule.mockResolvedValue(apiSchedule);
    routeQueries([[/player_sim_projections/, [rows]]]);
    const res = await get(`/api/predictions/mlb/players?date=${DATE}&format=csv`);
    const call = mockQuery.mock.calls.find((c) => /player_sim_projections/.test(c[0].query))![0];
    expect(call.params).toEqual({ date: DATE });
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="hankstank_mlb_players_${DATE}.csv"`);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('"Over-predicted, ""raw"""');
    expect(res.text).toContain('Ronald Acuña Jr.');
  });

  it('is available:false when the table does not exist, and for football', async () => {
    routeQueries([[/player_sim_projections/, missing('player_sim_projections')]]);
    const mlb = await get(`/api/predictions/mlb/players?date=${DATE}`);
    expect(mlb.status).toBe(200);
    expect(mlb.body.data).toEqual(expect.objectContaining({ available: false, rows: [] }));
    const nfl = await get('/api/predictions/nfl/players');
    expect(nfl.body.success).toBe(true);
    expect(nfl.body.data.available).toBe(false);
    expect((await get('/api/predictions/mlb/players?game_id=abc')).status).toBe(400);
  });

  it('flags a player row with no pregame snapshot', () => {
    const picked = pickPlayerRows([rows[2]], new Map());
    expect(picked[0].pregame).toBe(false);
  });
});

/* ── pure helpers ─────────────────────────────────────────────────────── */

describe('unified-slate helpers', () => {
  it('disagreement thresholds: low < 0.08 <= medium < 0.15 <= high', () => {
    expect(disagreementLevel(null)).toBeNull();
    expect(disagreementLevel(0)).toBe('low');
    expect(disagreementLevel(0.0799)).toBe('low');
    expect(disagreementLevel(0.08)).toBe('medium');
    expect(disagreementLevel(0.1499)).toBe('medium');
    expect(disagreementLevel(0.15)).toBe('high');
    expect(disagreementLevel(0.4)).toBe('high');
  });

  it('consensus counts available pregame models only, and needs two for a spread', () => {
    const p = (x: number, pregame = true) => ({
      home_win_prob: x, pregame, predicted_at: null, model_version: null, home_score: null,
      away_score: null, total: null, margin: null, dist: null, extras: null,
    });
    const available = new Set(['a', 'b', 'c']);
    expect(consensusOf({ a: p(0.5), b: p(0.6), c: p(0.9, false), d: p(0.1) }, available))
      .toEqual({ home_win_prob_mean: 0.55, spread: 0.1, models_n: 2 });
    expect(consensusOf({ a: p(0.5) }, available)).toEqual({ home_win_prob_mean: 0.5, spread: null, models_n: 1 });
  });

  it('escapes CSV fields', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(-3.5)).toBe('-3.5');
    expect(csvField(NaN)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField({ '8.5': 0.47 })).toBe('"{""8.5"":0.47}"');
    expect(toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }])).toBe('a,b\r\n1,"x,y"\r\n');
  });

  it('names export files', () => {
    expect(exportFilename('slate', 'mlb', { date: '2026-09-26' })).toBe('hankstank_mlb_slate_2026-09-26.csv');
    expect(exportFilename('slate', 'cfb', { season: 2026, week: 4, division: 'fbs' }))
      .toBe('hankstank_cfb_fbs_slate_2026-week4.csv');
    expect(exportFilename('players', 'mlb', { gameId: '824776' })).toBe('hankstank_mlb_players_game-824776.csv');
  });

  it('reads a Dist under whichever prefix the writer used', () => {
    expect(distFromRow({ home_points_mean: 24.1, home_points_p50: 24 }, ['home_runs', 'home_points'], 5000))
      .toEqual(expect.objectContaining({ mean: 24.1, p50: 24, sd: null, n: 5000 }));
    expect(distFromRow({}, ['home_runs'], 1)).toBeNull();
  });
});
