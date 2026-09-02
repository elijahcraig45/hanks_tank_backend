/**
 * Tests for the football schedule, scoreboard and game detail endpoints.
 *
 * These are the first live-data paths in the football stack, so the cases that matter
 * are the ones about degrading rather than the happy path: a league with no feed, a
 * missing key, a tier that does not cover an endpoint, and one panel failing without
 * taking the page with it.
 *
 * Several also pin parameter quirks that cost real debugging time and would silently
 * regress: /games/teams rejects a bare year+id, /drives cannot be filtered to a game at
 * all, and only /metrics/wp and /live/plays accept gameId.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

// Partial mock: the error classes and predicates stay real so the controller's
// instanceof checks behave, but the network call is replaced.
jest.mock('../services/cfbd.service', () => {
  const actual = jest.requireActual('../services/cfbd.service');
  return {
    ...actual,
    cfbdGet: jest.fn(),
    hasApiKey: jest.fn(() => true),
  };
});

import { mockQuery, rows } from './helpers/bq-mock';
import * as cfbd from '../services/cfbd.service';
import { cacheService } from '../services/cache.service';
import footballRoutes from '../routes/football.routes';

const cfbdGet = cfbd.cfbdGet as jest.Mock;
const hasApiKey = cfbd.hasApiKey as jest.Mock;

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
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
  hasApiKey.mockReturnValue(true);
  await cacheService.flush();
});

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any };
};

const boardGame = (over: any = {}) => ({
  id: 401856766,
  startDate: '2026-08-29T16:00:00.000Z',
  status: 'completed',
  tv: 'ESPN',
  neutralSite: false,
  conferenceGame: false,
  venue: { name: 'Amon G. Carter', city: 'Fort Worth', state: 'TX' },
  weather: { temperature: 70 },
  homeTeam: {
    name: 'TCU Horned Frogs', conference: 'Big 12', classification: 'fbs',
    points: 10, lineScores: [10, 0, 0, 0],
  },
  awayTeam: {
    name: 'North Carolina Tar Heels', conference: 'ACC', classification: 'fbs',
    points: 15, lineScores: [10, 2, 3, 0],
  },
  ...over,
});

/** Route cfbdGet by path so a test can describe several feeds at once. */
function routeCfbd(map: Record<string, any>) {
  cfbdGet.mockImplementation(async (path: string) => {
    if (!(path in map)) throw new Error(`unexpected CFBD path ${path}`);
    const value = map[path];
    if (value instanceof Error) throw value;
    return value;
  });
}

describe('GET /:sport/scoreboard', () => {
  it('serves live college games with linescores', async () => {
    routeCfbd({ '/scoreboard': [boardGame({ status: 'in_progress', period: 2 })] });
    const { status, body } = await get('/api/football/cfb/scoreboard?season=2026&week=1');

    expect(status).toBe(200);
    expect(body.meta.count).toBe(1);
    expect(body.meta.live).toBe(1);
    expect(body.data[0].home.line_scores).toEqual([10, 0, 0, 0]);
    expect(body.data[0].game_id).toBe('401856766');
  });

  it('drops the lower divisions the site does not cover', async () => {
    // CFBD returns DII and DIII alongside FBS/FCS.
    routeCfbd({
      '/scoreboard': [
        boardGame(),
        boardGame({
          id: 999,
          homeTeam: { name: 'Concord', classification: 'ii', lineScores: [] },
          awayTeam: { name: 'Charleston (WV)', classification: 'ii', lineScores: [] },
        }),
      ],
    });
    const { body } = await get('/api/football/cfb/scoreboard');
    expect(body.data.map((g: any) => g.game_id)).toEqual(['401856766']);
  });

  it('tells the caller the NFL has no live feed, without calling upstream', async () => {
    const { status, body } = await get('/api/football/nfl/scoreboard');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta.note).toMatch(/college-only/i);
    expect(cfbdGet).not.toHaveBeenCalled();
  });

  it('reports itself unavailable rather than failing when no key is configured', async () => {
    hasApiKey.mockReturnValue(false);
    const { status, body } = await get('/api/football/cfb/scoreboard');
    expect(status).toBe(200);
    expect(body.meta.note).toMatch(/API key/i);
    expect(cfbdGet).not.toHaveBeenCalled();
  });

  it('surfaces a tier restriction as unavailable, not as a 500', async () => {
    routeCfbd({ '/scoreboard': new cfbd.CfbdNotEntitled('/scoreboard') });
    const { status, body } = await get('/api/football/cfb/scoreboard');
    expect(status).toBe(200);
    expect(body.meta.note).toMatch(/tier does not include/i);
  });

  it('500s a genuine upstream failure with a generic message', async () => {
    routeCfbd({ '/scoreboard': new Error('upstream exploded: token abc123') });
    const { status, body } = await get('/api/football/cfb/scoreboard');
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/abc123/);
  });
});

describe('GET /:sport/schedule', () => {
  const fixture = {
    id: 401858225, season: 2026, week: 3, seasonType: 'regular',
    startDate: '2026-09-17T23:30:00.000Z', startTimeTBD: false, completed: false,
    neutralSite: false, conferenceGame: true, venue: 'Acrisure Stadium',
    homeTeam: 'Pittsburgh', homeConference: 'ACC', homeClassification: 'fbs',
    homePoints: null, homePregameElo: 1500,
    awayTeam: 'Syracuse', awayConference: 'ACC', awayClassification: 'fbs',
    awayPoints: null, awayPregameElo: 1450,
    excitementIndex: null,
  };

  it('returns upcoming fixtures and counts them', async () => {
    routeCfbd({ '/games': [fixture] });
    const { status, body } = await get('/api/football/cfb/schedule?season=2026&week=3');
    expect(status).toBe(200);
    expect(body.meta.upcoming).toBe(1);
    expect(body.data[0].home_school).toBe('Pittsburgh');
    expect(body.data[0].completed).toBe(false);
  });

  it('warns that its team names are school names, not the BigQuery key', async () => {
    // /games says "TCU" where /scoreboard and BigQuery say "TCU Horned Frogs", so
    // anything joining these rows has to join on game_id.
    routeCfbd({ '/games': [fixture] });
    const { body } = await get('/api/football/cfb/schedule');
    expect(body.meta.join_note).toMatch(/game_id/);
  });
});

describe('GET /:sport/games/:gameId', () => {
  const fullFeeds = {
    '/scoreboard': [boardGame()],
    '/metrics/wp': [{ playNumber: 1, homeWinProbability: 0.6 }],
    '/games/teams': [{ id: 401856766, teams: [{ team: 'TCU', points: 10, stats: [] }] }],
    '/games/players': [{ id: 401856766, teams: [{ team: 'TCU', categories: [] }] }],
    '/drives': [
      { gameId: 401856766, driveNumber: 1 },
      { gameId: 999999, driveNumber: 1 },
    ],
  };

  it('assembles every panel and reports which are present', async () => {
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([{ week: 1, game_id: '401856766' }]));

    const { status, body } = await get('/api/football/cfb/games/401856766?season=2026');
    expect(status).toBe(200);
    expect(body.meta.available).toEqual(
      expect.arrayContaining(['win_probability', 'team_box', 'player_box', 'drives']),
    );
    expect(body.data.game.home.line_scores).toEqual([10, 0, 0, 0]);
  });

  it('filters drives to this game, since /drives cannot be asked for one', async () => {
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));
    const { body } = await get('/api/football/cfb/games/401856766?season=2026');
    expect(body.data.drives).toHaveLength(1);
    expect(String(body.data.drives[0].gameId)).toBe('401856766');
  });

  it('passes week and id to the box score, never a bare year+id', async () => {
    // /games/teams answers "either week, team, or conference are required" otherwise.
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));
    await get('/api/football/cfb/games/401856766?season=2026&week=1');

    const call = cfbdGet.mock.calls.find((c) => c[0] === '/games/teams');
    expect(call).toBeDefined();
    expect(call![1]).toEqual(expect.objectContaining({ week: 1, id: '401856766' }));
  });

  it('prefers an explicit week over a BigQuery lookup', async () => {
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([]));
    await get('/api/football/cfb/games/401856766?season=2026&week=7');

    // The prediction lookup still runs; what must not is the week lookup.
    const sql = mockQuery.mock.calls.map((c) => c[0]?.query ?? '');
    expect(sql.some((q) => /SELECT week/i.test(q))).toBe(false);

    const call = cfbdGet.mock.calls.find((c) => c[0] === '/games/teams');
    expect(call![1]).toEqual(expect.objectContaining({ week: 7 }));
  });

  it('explains the week-scoped panels instead of failing when the week is unknown', async () => {
    routeCfbd({ '/scoreboard': [boardGame()], '/metrics/wp': [{ playNumber: 1 }] });
    mockQuery.mockResolvedValue(rows([]));   // not in either table

    const { status, body } = await get('/api/football/cfb/games/401856766?season=2026');
    expect(status).toBe(200);
    expect(body.meta.week).toBeNull();
    expect(body.meta.missing).toEqual(
      expect.arrayContaining(['team_box', 'player_box', 'drives']),
    );
    expect(body.meta.notes.team_box).toMatch(/week/i);
    // The panels that do not need a week still came through.
    expect(body.meta.available).toContain('win_probability');
  });

  it('keeps the page up when one panel fails', async () => {
    routeCfbd({
      ...fullFeeds,
      '/games/players': new Error('upstream 503'),
    });
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));

    const { status, body } = await get('/api/football/cfb/games/401856766?season=2026');
    expect(status).toBe(200);
    expect(body.meta.missing).toContain('player_box');
    expect(body.meta.notes.player_box).toMatch(/unavailable/i);
    expect(body.meta.available).toContain('team_box');
  });

  it('skips the live feed for a finished game', async () => {
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));
    await get('/api/football/cfb/games/401856766?season=2026');
    expect(cfbdGet.mock.calls.map((c) => c[0])).not.toContain('/live/plays');
  });

  it('asks for live plays while a game is in progress', async () => {
    routeCfbd({
      ...fullFeeds,
      '/scoreboard': [boardGame({ status: 'in_progress' })],
      '/live/plays': [{ playId: 'x' }],
    });
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));
    await get('/api/football/cfb/games/401856766?season=2026');
    expect(cfbdGet.mock.calls.map((c) => c[0])).toContain('/live/plays');
  });

  it('rejects a non-numeric game id before doing any work', async () => {
    const { status, body } = await get('/api/football/cfb/games/DROP-TABLE');
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_GAME_ID');
    expect(cfbdGet).not.toHaveBeenCalled();
  });

  it('404s an id nothing recognises, and does not cache it as a game', async () => {
    routeCfbd({
      '/scoreboard': [],
      '/metrics/wp': [],
      '/games/teams': [],
      '/games/players': [],
      '/drives': [],
    });
    mockQuery.mockResolvedValue(rows([]));

    const first = await get('/api/football/cfb/games/123456789?season=2026&week=1');
    expect(first.status).toBe(404);
    // A cached 404 would come back as a 200 with an empty body.
    const second = await get('/api/football/cfb/games/123456789?season=2026&week=1');
    expect(second.status).toBe(404);
  });

  it('serves a repeat view from cache', async () => {
    routeCfbd(fullFeeds);
    mockQuery.mockResolvedValue(rows([{ week: 1 }]));

    await get('/api/football/cfb/games/401856766?season=2026');
    const upstreamAfterFirst = cfbdGet.mock.calls.length;
    await get('/api/football/cfb/games/401856766?season=2026');

    expect(cfbdGet.mock.calls.length).toBe(upstreamAfterFirst);
  });
});
