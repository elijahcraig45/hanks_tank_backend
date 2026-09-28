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
import { winLabel } from '../controllers/season-sim.controller';
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

const gameRow = (id: string, home: string, away: string, p: number, extra: Record<string, any> = {}) => ({
  sport: 'nfl', season: 2026, as_of_week: 4, computed_at: COMPUTED, model_version: 'season_sim_v1',
  n_sims: 10000, game_id: id, week: 5, game_date: { value: '2026-10-04' }, home, away,
  home_name: `${home} name`, away_name: `${away} name`, neutral: false,
  p_home_win: p, margin_mean: 3, margin_p10: -12, margin_p90: 18, ...extra,
});
const games = [
  gameRow('g1', 'KC', 'DEN', 0.78),
  gameRow('g2', 'LV', 'KC', 0.39, { week: 6, game_date: { value: '2026-10-11' }, margin_mean: -4 }),
  gameRow('g3', 'KC', 'BUF', 0.5, { week: 7, neutral: true, game_date: { value: '2026-10-18' } }),
  gameRow('g4', 'DEN', 'LV', 0.6, { week: 7 }),
];

function happy() {
  routeQueries([
    [/GROUP BY season, as_of_week/, [slices]],
    [/season_sim_games/, [games]],
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

  it('exports the games table with flattened dates', async () => {
    happy();
    const { status, text, headers } = await get('/api/season-sim/nfl/export?table=games&format=csv');
    expect(status).toBe(200);
    expect(headers.get('content-disposition')).toMatch(/_wk4_games\.csv/);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('sport,season,as_of_week,computed_at,model_version,n_sims,game_id,week,'
      + 'game_date,home,away,home_name,away_name,neutral,p_home_win,margin_mean,margin_p10,margin_p90');
    expect(lines).toHaveLength(5);
    expect(text).toContain('2026-10-04');
    expect(text).not.toContain('[object Object]');
    const json = await get('/api/season-sim/nfl/export?table=games&format=json');
    expect(json.body).toHaveLength(4);
  });

  it('keeps the new team columns in the CSV contract order', async () => {
    happy();
    const { text } = await get('/api/season-sim/nfl/export?table=team');
    expect(text.split('\r\n')[0]).toMatch(/rank_p90,rem_wins_mean,rem_wins_dist,projected_wins_games,modal_sequence,modal_sequence_freq,modal_sequence_record_p/);
  });

  it('validates table and format', async () => {
    expect((await get('/api/season-sim/nfl/export?table=teams')).status).toBe(400);
    expect((await get('/api/season-sim/nfl/export?format=xml')).status).toBe(400);
  });

  it('404s the export when there is no data', async () => {
    routeQueries([[/season_sim_team/, missing('season_sim_team')]]);
    const { status, body } = await get('/api/season-sim/cfb/export');
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

describe('GET /api/season-sim/:sport/team/:team', () => {
  const kc = teamRow('KC', {
    rem_wins_mean: 1.67, rem_wins_dist: '[0.1,0.3,0.4,0.2]',
    projected_wins_games: '["g1","g3"]', modal_sequence: 'WLW', modal_sequence_freq: 0.19,
    modal_sequence_record_p: 0.4,
  });
  function teamHappy() {
    routeQueries([
      [/GROUP BY season, as_of_week/, [slices]],
      [/season_sim_games/, [games]],
      [/season_sim_team/, [[kc, teamRow('DEN')]]],
      [/season_sim_bracket/, [[bracketRow]]],
    ]);
  }

  it("returns the team's row and only its games, from its side", async () => {
    teamHappy();
    const { status, body } = await get('/api/season-sim/nfl/team/KC');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.meta).toEqual(expect.objectContaining({ sport: 'nfl', season: 2026, as_of_week: 4 }));
    expect(body.data.team.modal_sequence).toBe('WLW');
    expect(body.data.games.map((g: any) => g.game_id)).toEqual(['g1', 'g2', 'g3']);
    const [g1, g2, g3] = body.data.games;
    expect(g1).toEqual(expect.objectContaining({
      opponent: 'DEN', opponent_name: 'DEN name', site: 'home', p_win: 0.78, margin: 3,
      label: 'Likely W', projected_win: true, game_date: '2026-10-04',
    }));
    // Away: P(win) and the margin flip, and the percentiles swap.
    expect(g2.site).toBe('away');
    expect(g2.opponent).toBe('LV');
    expect(g2.p_win).toBeCloseTo(0.61);
    expect(g2).toEqual(expect.objectContaining({ margin: 4, margin_p10: -18, margin_p90: 12, label: 'Lean W', projected_win: false }));
    expect(g3).toEqual(expect.objectContaining({ site: 'neutral', label: 'Toss-up', projected_win: true }));
    // Per-game P(win) sums to the expected remaining wins the team row carries.
    const sum = body.data.games.reduce((a: number, g: any) => a + g.p_win, 0);
    expect(sum).toBeCloseTo(0.78 + 0.61 + 0.5);
  });

  it('reads the games slice with the resolved season and week, latest computed_at', async () => {
    teamHappy();
    await get('/api/season-sim/nfl/team/KC?week=3');
    expect(sentParamsFor(/FROM `hankstank.nfl_season.season_sim_games`\s+WHERE/)).toEqual({ season: 2026, week: 3 });
    const sql = sentQueries().find((q) => /season_sim_games/.test(q));
    expect(sql).toMatch(/computed_at = \(\s*SELECT MAX\(computed_at\)/);
    expect(sql).toMatch(/ORDER BY week, game_date, game_id/);
  });

  it('matches the team key case-insensitively and 404s an unknown team', async () => {
    teamHappy();
    expect((await get('/api/season-sim/nfl/team/kc')).body.data.team.team).toBe('KC');
    const miss = await get('/api/season-sim/nfl/team/XYZ');
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual({ success: false, error: expect.objectContaining({ code: 'UNKNOWN_TEAM' }) });
  });

  it('serves the team with no games and a note when the games table is missing', async () => {
    routeQueries([
      [/GROUP BY season, as_of_week/, [slices]],
      [/season_sim_games/, missing('season_sim_games')],
      [/season_sim_team/, [[kc]]],
      [/season_sim_bracket/, [[bracketRow]]],
    ]);
    const { status, body } = await get('/api/season-sim/nfl/team/KC');
    expect(status).toBe(200);
    expect(body.data.games).toEqual([]);
    expect(body.meta.note).toMatch(/Per-game/);
  });

  it('500s without leaking an unexpected games-table error', async () => {
    routeQueries([
      [/GROUP BY season, as_of_week/, [slices]],
      [/season_sim_games/, () => { throw new Error('quota exceeded'); }],
      [/season_sim_team/, [[kc]]],
      [/season_sim_bracket/, [[bracketRow]]],
    ]);
    const { status, body } = await get('/api/season-sim/nfl/team/KC');
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/quota/);
  });

  it('uses the cfb dataset and caches the games slice', async () => {
    teamHappy();
    await get('/api/season-sim/cfb/team/KC');
    expect(sentQueries().every((q) => /cfb_season\.season_sim_/.test(q))).toBe(true);
    const calls = mockQuery.mock.calls.length;
    await get('/api/season-sim/cfb/team/DEN');
    expect(mockQuery.mock.calls.length).toBe(calls);
  });
});

describe('winLabel', () => {
  it('uses the page thresholds', () => {
    expect([0.9, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.1].map(winLabel)).toEqual([
      'Likely W', 'Likely W', 'Lean W', 'Lean W', 'Toss-up', 'Lean L', 'Lean L', 'Likely L', 'Likely L']);
    expect(winLabel(null)).toBeNull();
  });
});

describe('fixture mode (SEASON_SIM_FIXTURE_DIR)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ssim-'));
    writeFileSync(path.join(dir, 'season_sim_nfl.json'), JSON.stringify({
      teams: [{ ...teamRow('KC'), computed_at: '2026-09-28T09:00:00Z' }],
      bracket: [{ ...bracketRow, computed_at: '2026-09-28T09:00:00Z' }],
      games: [{ ...games[0], computed_at: '2026-09-28T09:00:00Z', game_date: '2026-10-04' }],
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

  it('serves the team route from the fixture games', async () => {
    process.env.SEASON_SIM_FIXTURE_DIR = dir;
    const { status, body } = await get('/api/season-sim/nfl/team/KC');
    expect(status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(body.data.games).toHaveLength(1);
    expect(body.data.games[0].p_win).toBe(0.78);
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
