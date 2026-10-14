/**
 * Tests for GET /api/football/:sport/scouting.
 *
 * The slate builder has its own tests, so it is stubbed here with a canned two-game
 * week. What matters for this endpoint is the assembly around it: the full-name join
 * that ties rankings, players and injuries to a game, the pick and market summary, the
 * ordering, and, above all, that a failing enrichment never fails the report.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../services/model-control.service', () => ({
  ...jest.requireActual('../services/model-control.service'),
  getControl: jest.fn(async () => ({ available: false, version: 'none', models: {} })),
}));
jest.mock('../controllers/unified-predictions.controller', () => ({
  buildFootballSlate: jest.fn(),
}));
jest.mock('../services/espn.service', () => ({
  ...jest.requireActual('../services/espn.service'),
  getCfbInjuries: jest.fn(),
}));

import { mockQuery, rows, routeQueries } from './helpers/bq-mock';
import { cacheService } from '../services/cache.service';
import { buildFootballSlate } from '../controllers/unified-predictions.controller';
import { getCfbInjuries, parseInjuryFeed } from '../services/espn.service';
import { playersSql } from '../controllers/cfb-scouting.controller';
import footballRoutes from '../routes/football.routes';

const slateMock = buildFootballSlate as jest.Mock;
const injuriesMock = getCfbInjuries as jest.Mock;

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/football', footballRoutes);
  server = app.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const team = (id: string, name: string) => ({ id, name, abbr: id });
const pred = (p: number, margin: number | null) => ({
  home_win_prob: p, pregame: true, margin: margin == null ? null : { mean: margin }, total: null,
});

/** Game 1 is unranked-vs-unranked and earlier; game 2 is a ranked matchup. */
const slate = () => ({
  data: {
    season: 2026, week: 6, division: 'fbs', weeks: [5, 6], featured_default: 'xgb',
    models: [{ key: 'xgb', label: 'XGBoost' }, { key: 'ridge', label: 'Ridge' }, { key: 'market', label: 'Market' }],
    games: [
      {
        game_id: 'g1', start_time: '2026-10-10T16:00:00Z', status: 'scheduled', status_detail: null,
        result: { home_score: null, away_score: null },
        home: team('AKR', 'Akron'), away: team('BGSU', 'Bowling Green'),
        predictions: { xgb: pred(0.3, null), ridge: pred(0.4, -3), market: pred(0.45, -1.5) },
        consensus: { home_win_prob_mean: 0.35, spread: 0.1, models_n: 2 }, disagreement: 'low',
      },
      {
        game_id: 'g2', start_time: '2026-10-10T23:30:00Z', status: 'scheduled', status_detail: null,
        result: { home_score: null, away_score: null },
        home: team('ALA', 'Alabama'), away: team('UGA', 'Georgia'),
        predictions: { xgb: pred(0.7, null), ridge: pred(0.6, 5), market: null },
        consensus: { home_win_prob_mean: 0.65, spread: 0.1, models_n: 2 }, disagreement: 'low',
      },
    ],
  },
  isPast: false,
  meta: {},
});

const names = rows([
  { game_id: 'g1', home_team_name: 'Akron Zips', away_team_name: 'Bowling Green Falcons' },
  { game_id: 'g2', home_team_name: 'Alabama Crimson Tide', away_team_name: 'Georgia Bulldogs' },
]);
const ranks = rows([
  { team: 'Alabama Crimson Tide', rank: 1, overall_rank: 1, record: '5-0', playoff_pct: 93.8 },
  { team: 'Georgia Bulldogs', rank: 6, overall_rank: 6, record: '5-0', playoff_pct: 90.4 },
]);
const players = rows([
  { full_name: 'Alabama Crimson Tide', cat: 'def', player_name: 'L. Metz', position: 'LB', line: '36 tackles', rk: 1 },
  { full_name: 'Alabama Crimson Tide', cat: 'pass', player_name: 'K. Russell', position: 'QB', line: '1414 yds', rk: 1 },
]);

function route(overrides: Array<[RegExp, any]> = []) {
  routeQueries([
    ...overrides,
    [/__TABLES__/, rows([{ modified: { value: '2026-10-05T15:26:21.961Z' } }])],
    [/power_rankings/, ranks],
    [/player_season_stats/, players],
    [/game_predictions/, names],
  ]);
}

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any };
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  await cacheService.flush();
  slateMock.mockResolvedValue(slate());
  injuriesMock.mockResolvedValue({});
  route();
});

describe('GET /api/football/cfb/scouting', () => {
  it('assembles picks, ranks and key players per game, ranked matchups first', async () => {
    const { status, body } = await get('/api/football/cfb/scouting?week=6');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.week).toBe(6);
    expect(body.data.games.map((g: any) => g.game_id)).toEqual(['g2', 'g1']);

    const g = body.data.games[0];
    expect(g.home.full_name).toBe('Alabama Crimson Tide');
    expect(g.home.ranking).toMatchObject({ overall_rank: 1, record: '5-0' });
    expect(g.away.ranking.overall_rank).toBe(6);
    // players are ordered passer first regardless of query order
    expect(g.home.key_players.map((p: any) => p.category)).toEqual(['pass', 'def']);
    expect(g.away.key_players).toEqual([]);
    expect(g.relevance).toBe(1);
    expect(body.meta.rankings_as_of_week).toBeNull(); // canned rows carry no as_of_week
    expect(body.meta.player_stats_updated).toBe('2026-10-05T15:26:21.961Z');
  });

  it('picks from the featured model and reports the market spread, not a made-up one', async () => {
    const { body } = await get('/api/football/cfb/scouting?week=6');
    const [ranked, unranked] = body.data.games;
    expect(ranked.pick).toMatchObject({ model: 'xgb', side: 'home', team: 'Alabama', win_prob: 0.7 });
    expect(ranked.market).toBeNull();
    expect(unranked.pick).toMatchObject({ side: 'away', team: 'Bowling Green' });
    expect(unranked.pick.win_prob).toBeCloseTo(0.7);
    expect(unranked.market.home_spread).toBe(-1.5);
    expect(unranked.models.map((m: any) => m.key)).toEqual(['xgb', 'ridge']);
  });

  it('attaches ESPN injuries by full team name and says whether any exist', async () => {
    injuriesMock.mockResolvedValue({
      'Alabama Crimson Tide': [{ player: 'A. Player', status: 'Out', detail: 'knee', reported: '2026-10-08T00:00:00Z' }],
    });
    const { body } = await get('/api/football/cfb/scouting?week=6');
    const [ranked, unranked] = body.data.games;
    expect(ranked.home.injuries).toHaveLength(1);
    expect(ranked.injuries_available).toBe(true);
    expect(unranked.injuries_available).toBe(false);
    expect(body.meta.injuries).toMatchObject({ teams_with_fresh_reports: 1, used_by_model: false });
  });

  it('still returns the report when ESPN is unreachable, and says so', async () => {
    injuriesMock.mockResolvedValue(null);
    const { status, body } = await get('/api/football/cfb/scouting?week=6');
    expect(status).toBe(200);
    expect(body.data.games).toHaveLength(2);
    expect(body.meta.parts.injuries).toBe(false);
    expect(body.meta.injuries.note).toMatch(/not a clean bill of health/);
  });

  it('still returns the report when the player and ranking tables are unavailable', async () => {
    // routeQueries returns the stored value, so failures are thrown lazily from a function
    routeQueries([
      [/__TABLES__/, () => { throw new Error('denied'); }],
      [/power_rankings/, () => { throw new Error('missing'); }],
      [/player_season_stats/, () => { throw new Error('missing'); }],
      [/game_predictions/, names],
    ]);
    const { status, body } = await get('/api/football/cfb/scouting?week=6');
    expect(status).toBe(200);
    expect(body.meta.parts).toMatchObject({ rankings: false, players: false });
    expect(body.data.games[0].home.ranking).toBeNull();
    expect(body.data.games[0].home.key_players).toEqual([]);
    expect(body.data.games[0].pick).not.toBeNull();
  });

  it('answers 500 with an error envelope only when the slate itself fails', async () => {
    slateMock.mockRejectedValue(new Error('bq down'));
    const { status, body } = await get('/api/football/cfb/scouting?week=6');
    expect(status).toBe(500);
    expect(body.error.code).toBe('SCOUTING_ERROR');
  });

  it('rejects other sports, a bad division and a bad week', async () => {
    expect((await get('/api/football/nfl/scouting')).status).toBe(404);
    expect((await get('/api/football/cfb/scouting?division=d3')).status).toBe(400);
    expect((await get('/api/football/cfb/scouting?week=abc')).status).toBe(400);
    expect(slateMock).not.toHaveBeenCalled();
  });

  it('passes season, week and division through to the slate', async () => {
    await get('/api/football/cfb/scouting?season=2025&week=3&division=all');
    expect(slateMock).toHaveBeenCalledWith(expect.anything(), 2025, 3, null, expect.anything());
  });
});

describe('player query', () => {
  it('matches a full team name to the longest school name it starts with', () => {
    const sql = playersSql('cfb_season');
    expect(sql).toMatch(/STARTS_WITH\(n, CONCAT\(pt\.team, ' '\)\)/);
    expect(sql).toMatch(/ORDER BY LENGTH\(pt\.team\) DESC/);
  });
});

describe('parseInjuryFeed', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const entry = (status: string, date: string) => ({
    status, date, shortComment: 'note', athlete: { displayName: 'A. Player' },
  });

  it('keeps recent non-Active entries and drops stale and Active ones', () => {
    const feed = parseInjuryFeed({
      injuries: [
        { displayName: 'Florida Gators', injuries: [
          entry('Out', '2026-10-07T00:00Z'),
          entry('Out', '2020-11-21T18:31Z'),
          entry('Active', '2026-10-08T00:00Z'),
        ] },
        { displayName: 'Rice Owls', injuries: [entry('Out', '2020-11-21T18:31Z')] },
      ],
    }, now);
    expect(Object.keys(feed)).toEqual(['Florida Gators']);
    expect(feed['Florida Gators']).toEqual([
      { player: 'A. Player', status: 'Out', detail: 'note', reported: '2026-10-07T00:00Z' },
    ]);
  });

  it('tolerates a malformed body', () => {
    expect(parseInjuryFeed(null, now)).toEqual({});
    expect(parseInjuryFeed({ injuries: 'nope' }, now)).toEqual({});
  });
});
