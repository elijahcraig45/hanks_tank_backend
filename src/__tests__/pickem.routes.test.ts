/**
 * Tests for the pick'em contest endpoints.
 *
 * The cases that matter are the ones a client must not be trusted with: the kickoff
 * lock, and the fact that a pick records a side rather than a team name. Both are
 * enforced server-side, and both are the kind of rule that quietly stops working.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Stand in for Google token verification. A token of 'good' is a signed-in user;
// anything else is anonymous.
jest.mock('../middleware/auth.middleware', () => {
  const actual = jest.requireActual('../middleware/auth.middleware');
  const USER = {
    userId: 'sub-123', email: 'picker@example.invalid',
    displayName: 'Picker', pictureUrl: null,
  };
  let configured = true;
  return {
    ...actual,
    __setConfigured: (v: boolean) => { configured = v; },
    isAuthConfigured: () => configured,
    // Mocked so the test never reaches real Secret Manager. It passed locally only
    // because a developer machine has application-default credentials; CI has none,
    // and a unit test should not be calling a cloud service either way.
    googleClientId: async () => (configured ? 'test-client-id.apps.googleusercontent.com' : null),
    attachUser: (req: any, _res: any, next: any) => {
      if (req.headers.authorization === 'Bearer good') req.user = USER;
      next();
    },
    requireUser: (req: any, res: any, next: any) => {
      if (!configured) {
        res.status(503).json({
          success: false,
          error: { code: 'AUTH_NOT_CONFIGURED', message: 'not configured' },
        });
        return;
      }
      if (req.headers.authorization !== 'Bearer good') {
        res.status(401).json({
          success: false,
          error: { code: 'SIGN_IN_REQUIRED', message: 'sign in' },
        });
        return;
      }
      req.user = USER;
      next();
    },
  };
});

import { mockQuery, rows, sentQueries, sentParamsFor } from './helpers/bq-mock';
import pickemRoutes from '../routes/pickem.routes';
import { __resetAdoptionMemo } from '../controllers/pickem.controller';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authMock = require('../middleware/auth.middleware');

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/pickem', pickemRoutes);
  server = app.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  authMock.__setConfigured(true);
  // The adoption memo is per-instance, so it would otherwise carry between tests.
  __resetAdoptionMemo();
});

async function call(path: string, init: any = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json() as any };
}
const signedIn = { headers: { Authorization: 'Bearer good' } };

const game = (over: any = {}) => ({
  game_id: 'g1', sport: 'nfl', division: null, season: 2026, week: 1,
  kickoff: { value: '2026-09-13T17:00:00.000Z' }, start_time_tbd: false,
  home_team: 'CAR', away_team: 'CHI',
  home_display: 'Carolina Panthers', away_display: 'Chicago Bears',
  home_conference: null, away_conference: null, neutral_site: false,
  spread_line: -2.5, total_line: 44.5,
  home_score: null, away_score: null, completed: false, locked: false,
  ...over,
});

describe('GET /config', () => {
  it('reports whether sign-in is available, so the UI can say so', async () => {
    const { status, body } = await call('/api/pickem/config');
    expect(status).toBe(200);
    expect(body.data).toEqual(expect.objectContaining({
      auth_configured: true,
      google_client_id: 'test-client-id.apps.googleusercontent.com',
      sports: ['nfl', 'cfb'],
      pick_types: ['ats', 'su'],
    }));
  });

  it('reports sign-in unavailable when no client id is configured', async () => {
    authMock.__setConfigured(false);
    const { body } = await call('/api/pickem/config');
    expect(body.data.auth_configured).toBe(false);
    expect(body.data.google_client_id).toBeNull();
  });
});

describe('GET /games', () => {
  it('serves the week and lists the weeks that exist', async () => {
    mockQuery
      .mockResolvedValueOnce(rows([game()]))          // games
      .mockResolvedValueOnce(rows([{ week: 1 }, { week: 2 }]));  // weeks

    const { status, body } = await call('/api/pickem/games?sport=nfl&week=1');
    expect(status).toBe(200);
    expect(body.meta.weeks).toEqual([1, 2]);
    expect(body.meta.signed_in).toBe(false);
    expect(body.data[0].kickoff).toBe('2026-09-13T17:00:00.000Z');
  });

  it('computes the lock in SQL, not from a client clock', async () => {
    mockQuery.mockResolvedValueOnce(rows([game()])).mockResolvedValueOnce(rows([]));
    await call('/api/pickem/games?sport=nfl&week=1');
    // The lock has to come from the server's own clock; a client-supplied time is
    // not evidence that a game has not started.
    expect(sentQueries()[0]).toMatch(/kickoff <= CURRENT_TIMESTAMP\(\)/);
  });

  it('defaults to the first week with an unplayed game', async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ week: 3 }]))     // week probe
      .mockResolvedValueOnce(rows([game({ week: 3 })]))
      .mockResolvedValueOnce(rows([{ week: 3 }]));
    const { body } = await call('/api/pickem/games?sport=nfl');
    expect(body.meta.week).toBe(3);
    expect(sentQueries()[0]).toMatch(/NOT completed/);
  });

  it("merges a signed-in user's own picks into the same response", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([game()]))
      .mockResolvedValueOnce(rows([{ week: 1 }]))
      .mockResolvedValueOnce(rows([{ n: 0 }]))   // adoption check
      .mockResolvedValueOnce(rows([{
        game_id: 'g1', pick_type: 'ats', selected: 'away',
        spread_at_pick: -2.5, updated_at: { value: '2026-09-01T00:00:00Z' },
      }]));
    const { body } = await call('/api/pickem/games?sport=nfl&week=1', signedIn);
    expect(body.meta.signed_in).toBe(true);
    expect(body.meta.picks[0]).toEqual(expect.objectContaining({
      game_id: 'g1', selected: 'away',
    }));
  });

  it('rejects an unknown sport', async () => {
    const { status, body } = await call('/api/pickem/games?sport=xfl');
    expect(status).toBe(400);
    expect(body.error.code).toBe('UNKNOWN_SPORT');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('PUT /picks', () => {
  const body = (picks: any[]) => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
    body: JSON.stringify({ sport: 'nfl', season: 2026, week: 1, picks }),
  });

  it('saves a valid pick as a side, never as a team name', async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ game_id: 'g1', spread_line: -2.5, locked: false }]))
      .mockResolvedValueOnce(rows([{ n: 0 }]))  // adoption: nothing to claim
      .mockResolvedValueOnce(rows([]))          // user upsert
      .mockResolvedValueOnce(rows([]));         // picks upsert

    const { status, body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'g1', pick_type: 'ats', selected: 'away' }]));

    expect(status).toBe(200);
    expect(res.data.accepted).toBe(1);
    // The stored value is a side. A team name would be a pick that a rename can orphan.
    const params = sentParamsFor(/MERGE .*picks/s);
    expect(params.selected0).toBe('away');
    expect(params.pickId0).toBe('sub-123|g1|ats');
  });

  it('refuses a game that has kicked off, and says which', async () => {
    mockQuery.mockResolvedValueOnce(
      rows([{ game_id: 'g1', spread_line: -2.5, locked: true }]),
    );
    const { body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'g1', pick_type: 'ats', selected: 'away' }]));

    expect(res.data.accepted).toBe(0);
    expect(res.data.rejected).toEqual([{ game_id: 'g1', reason: 'kicked off' }]);
    // Nothing was written.
    expect(sentQueries().some((q) => /MERGE/.test(q))).toBe(false);
  });

  it('saves the open games in a sheet where one has already started', async () => {
    // Partial success is the normal mid-week case, not a failure.
    mockQuery
      .mockResolvedValueOnce(rows([
        { game_id: 'g1', spread_line: -2.5, locked: true },
        { game_id: 'g2', spread_line: 3.0, locked: false },
      ]))
      .mockResolvedValueOnce(rows([{ n: 0 }]))  // adoption
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    const { body: res } = await call('/api/pickem/picks', body([
      { game_id: 'g1', pick_type: 'ats', selected: 'home' },
      { game_id: 'g2', pick_type: 'ats', selected: 'away' },
    ]));
    expect(res.data.accepted).toBe(1);
    expect(res.data.rejected).toHaveLength(1);
  });

  it('refuses an ATS pick on a game with no posted line', async () => {
    mockQuery.mockResolvedValueOnce(
      rows([{ game_id: 'g1', spread_line: null, locked: false }]),
    );
    const { body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'g1', pick_type: 'ats', selected: 'home' }]));
    expect(res.data.rejected).toEqual([
      { game_id: 'g1', reason: 'no spread posted' },
    ]);
  });

  it('allows a straight-up pick on a game with no line', async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ game_id: 'g1', spread_line: null, locked: false }]))
      .mockResolvedValueOnce(rows([{ n: 0 }]))  // adoption
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));
    const { body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'g1', pick_type: 'su', selected: 'home' }]));
    expect(res.data.accepted).toBe(1);
  });

  it('refuses a game that is not in the stated week', async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    const { body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'nope', pick_type: 'su', selected: 'home' }]));
    expect(res.data.rejected).toEqual([
      { game_id: 'nope', reason: 'not in this week' },
    ]);
  });

  it('validates the body before querying anything', async () => {
    const { status, body: res } = await call('/api/pickem/picks',
      body([{ game_id: 'g1', pick_type: 'parlay', selected: 'home' }]));
    expect(status).toBe(400);
    expect(res.error.code).toBe('BAD_PICK');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    const { status, body: res } = await call('/api/pickem/picks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport: 'nfl', season: 2026, week: 1, picks: [] }),
    });
    expect(status).toBe(401);
    expect(res.error.code).toBe('SIGN_IN_REQUIRED');
  });

  it('says it is the server that is unconfigured, not the caller', async () => {
    authMock.__setConfigured(false);
    const { status, body: res } = await call('/api/pickem/picks', body([]));
    expect(status).toBe(503);
    expect(res.error.code).toBe('AUTH_NOT_CONFIGURED');
  });
});

describe('GET /leaderboard', () => {
  it('is public and ranks by wins', async () => {
    mockQuery.mockResolvedValueOnce(rows([
      { user_id: 'a', display_name: 'A', wins: 9, losses: 1, win_pct: 0.9 },
      { user_id: 'b', display_name: 'B', wins: 7, losses: 3, win_pct: 0.7 },
    ]));
    const { status, body } = await call(
      '/api/pickem/leaderboard?sport=nfl&pick_type=ats',
    );
    expect(status).toBe(200);
    expect(body.data[0].rank).toBe(1);
    expect(body.meta.scope).toBe('season');
    expect(sentQueries()[0]).toMatch(/ORDER BY wins DESC/);
  });

  it('reads the weekly view when a week is given', async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    const { body } = await call('/api/pickem/leaderboard?sport=nfl&week=2');
    expect(body.meta.scope).toBe('week');
    expect(sentQueries()[0]).toMatch(/leaderboard_weekly/);
  });

  it('rejects a bad pick type', async () => {
    const { status, body } = await call(
      '/api/pickem/leaderboard?sport=nfl&pick_type=teaser',
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_PICK_TYPE');
  });
});

describe('GET /me', () => {
  it('returns a record with pushes and pending counted separately', async () => {
    mockQuery.mockResolvedValueOnce(rows([{ n: 0 }]));  // adoption check
    mockQuery.mockResolvedValueOnce(rows([
      { is_correct: true, is_push: false, kickoff: { value: '2026-09-13T17:00:00Z' } },
      { is_correct: false, is_push: false, kickoff: { value: '2026-09-13T17:00:00Z' } },
      { is_correct: null, is_push: true, kickoff: { value: '2026-09-13T17:00:00Z' } },
      { is_correct: null, is_push: false, kickoff: { value: '2026-09-20T17:00:00Z' } },
    ]));
    const { status, body } = await call('/api/pickem/me?season=2026', signedIn);
    expect(status).toBe(200);
    // A push is not a loss and an ungraded pick is not a loss either.
    expect(body.meta.record).toEqual({ wins: 1, losses: 1, pushes: 1, pending: 1 });
  });

  it('requires a signed-in user', async () => {
    const { status } = await call('/api/pickem/me');
    expect(status).toBe(401);
  });
});

describe('adopting imported picks', () => {
  it('claims spreadsheet picks on first sign-in, matching the verified email', async () => {
    // The contest ran in a spreadsheet first, so those picks were imported against
    // "email:<address>" and have no Google subject to key on.
    mockQuery
      .mockResolvedValueOnce(rows([{ n: 99 }]))  // 99 rows waiting to be claimed
      .mockResolvedValueOnce(rows([]))           // UPDATE
      .mockResolvedValueOnce(rows([]))           // DELETE leftover picks
      .mockResolvedValueOnce(rows([]))           // DELETE provisional user
      .mockResolvedValueOnce(rows([]));          // the actual /me query

    const { status } = await call('/api/pickem/me?season=2026', signedIn);
    expect(status).toBe(200);

    const update = sentQueries().find((q) => /UPDATE .*picks/s.test(q));
    expect(update).toBeDefined();
    // pick_id embeds the user, so taking ownership must rewrite both.
    expect(update).toMatch(/pick_id = CONCAT/);
    expect(sentParamsFor(/UPDATE .*picks/s).provisional)
      .toBe('email:picker@example.invalid');
  });

  it('does nothing when there is nothing to claim', async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ n: 0 }]))
      .mockResolvedValueOnce(rows([]));
    await call('/api/pickem/me?season=2026', signedIn);
    expect(sentQueries().some((q) => /UPDATE .*picks/s.test(q))).toBe(false);
  });
});

describe('adoption on the pick sheet', () => {
  it('claims an imported history on the sheet, not only on /me', async () => {
    // The bug this covers: signing in and going straight to the sheet showed no picks
    // until some other request happened to trigger the transfer.
    mockQuery
      .mockResolvedValueOnce(rows([game()]))       // games
      .mockResolvedValueOnce(rows([{ week: 1 }]))  // weeks
      .mockResolvedValueOnce(rows([{ n: 42 }]))    // 42 waiting
      .mockResolvedValueOnce(rows([]))             // UPDATE
      .mockResolvedValueOnce(rows([]))             // DELETE picks
      .mockResolvedValueOnce(rows([]))             // DELETE provisional user
      .mockResolvedValueOnce(rows([]));            // the user's picks

    const { status } = await call('/api/pickem/games?sport=nfl&week=1', signedIn);
    expect(status).toBe(200);
    expect(sentQueries().some((q) => /UPDATE .*picks/s.test(q))).toBe(true);
  });

  it('checks once per user rather than on every sheet request', async () => {
    // The sheet is the most-requested endpoint; a query per request would be waste.
    for (let i = 0; i < 3; i += 1) {
      mockQuery
        .mockResolvedValueOnce(rows([game()]))
        .mockResolvedValueOnce(rows([{ week: 1 }]))
        .mockResolvedValueOnce(rows([{ n: 0 }]))
        .mockResolvedValueOnce(rows([]));
    }
    await call('/api/pickem/games?sport=nfl&week=1', signedIn);
    await call('/api/pickem/games?sport=nfl&week=1', signedIn);
    await call('/api/pickem/games?sport=nfl&week=1', signedIn);

    const checks = sentQueries().filter((q) => /COUNT\(\*\) AS n[\s\S]*user_id = @provisional/.test(q));
    expect(checks).toHaveLength(1);
  });
});
