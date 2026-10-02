/**
 * Model control plane: stand-in model, last-known-good control state, lifecycle field.
 * MLB compare and slate routes against a mocked BigQuery and an injected clock.
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
  mlbApi: { getScheduleWithOptions: jest.fn().mockResolvedValue(null) },
}));

import { routeQueries, mockQuery } from './helpers/bq-mock';
import modelsRoutes from '../routes/models.routes';
import predictionsRoutes from '../routes/predictions.routes';
import footballRoutes from '../routes/football.routes';
import { cacheService } from '../services/cache.service';
import { logger } from '../utils/logger';
import {
  getControl, parseControlRows, resetControlCache, setControlClock, CONTROL_LAST_GOOD_MS,
} from '../services/model-control.service';
import { resetStandInMemo } from '../controllers/models.controller';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/models', modelsRoutes);
  app.use('/api/predictions', predictionsRoutes);
  app.use('/api/football', footballRoutes);
  server = app.listen(0, () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

let clock = 1_000_000;
beforeEach(async () => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  resetControlCache();
  resetStandInMemo();
  clock = 1_000_000;
  setControlClock(() => clock);
  await cacheService.flush();
});
afterEach(() => setControlClock(null));

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any, headers: res.headers };
};

type Row = Record<string, any>;
const crow = (sport: string, target: string, over: Row = {}): Row => ({
  sport, target, site_visible: null, run_state: null, lifecycle: null, role: null, display_label: null,
  public_note: null, sort_order: null, banner: null, banner_level: null, ...over,
});

let controlResult: Row[] | Error = [];
const controlRoute: [RegExp, any] = [/model_control_current/, () => {
  if (controlResult instanceof Error) throw controlResult;
  return [controlResult];
}];
const setControl = (r: typeof controlResult) => { controlResult = r; resetControlCache(); };

const at = (s: string) => ({ value: s });
const missing = (name: string) => () => {
  throw new Error(`Not found: Table hankstank:x.${name} was not found in location US`);
};

/**
 * N graded games on one day. `probs[key](i, homeWon)` is that model's home-win
 * probability; a model missing from `probs` has no table (or, for v10, no rows).
 */
type Probs = Record<string, ((i: number, won: boolean) => number) | null>;
function seasonFixture(n: number, probs: Probs) {
  const spine = Array.from({ length: n }, (_, i) => ({
    game_pk: 2000 + i, game_date: { value: '2026-09-20' }, home_team_name: `H${i}`,
    away_team_name: `A${i}`, home_score: i % 2 === 0 ? 5 : 1, away_score: i % 2 === 0 ? 2 : 4, final: true,
    game_time_utc: { value: '2026-09-20T23:05:00.000Z' },
  }));
  const rowsFor = (f: ((i: number, won: boolean) => number) | null | undefined, extra: Row = {}) => f == null
    ? [[]] : [spine.map((g, i) => ({
      game_id: String(g.game_pk), home_win_probability: f(i, i % 2 === 0),
      predicted_at: at('2026-09-20T20:00:00Z'), ...extra,
    }))];
  return [
    [/WITH g AS/, [spine]],
    [/elo_home_win_prob AS home_win_probability/, rowsFor(probs.elo)],
    [/game_predictions_logit3/, probs.logit3 === undefined ? missing('logit3') : rowsFor(probs.logit3)],
    [/game_predictions_sim_blend/, probs.sim_blend === undefined ? missing('sim_blend') : rowsFor(probs.sim_blend)],
    [/game_predictions`/, rowsFor(probs.v10, { model_version: 'v10' })],
  ] as Array<[RegExp, any]>;
}
const useRoutes = (extra: Array<[RegExp, any]>) => routeQueries([controlRoute, ...extra], [[]]);

/** Right by margin d: probability of the actual winner is 0.5 + d. */
const skill = (d: number) => (_i: number, won: boolean) => (won ? 0.5 + d : 0.5 - d);
const GOOD = skill(0.2); const OK = skill(0.05); const BAD = skill(-0.05);

const URL = '/api/models/mlb/compare?season=2026&date=2026-09-20';
const HIDE_V10 = [crow('mlb', 'v10', { site_visible: 'false' })];
const PAUSE_V10 = [crow('mlb', 'v10', { run_state: 'paused' })];

describe('stand-in: compare route', () => {
  it('picks the lowest season log loss when at least 50 games were scored by every candidate', async () => {
    useRoutes(seasonFixture(60, { v10: OK, logit3: GOOD, sim_blend: BAD, elo: GOOD }));
    setControl(HIDE_V10);
    const { body } = await get(URL);
    expect(body.data.stand_in).toEqual({
      model: 'logit3', label: '3-feature logistic', reason: 'production_hidden',
      basis: 'season_log_loss', n_games: 60,
    });
    expect(body.data.featured_default).toBe('logit3');
  });

  it('falls back to the fixed order below 50 games (sim_blend, then logit3)', async () => {
    useRoutes(seasonFixture(49, { v10: OK, logit3: GOOD, sim_blend: BAD }));
    setControl(HIDE_V10);
    const a = (await get(URL)).body.data;
    expect(a.stand_in).toMatchObject({ model: 'sim_blend', basis: 'fixed_order', n_games: null });

    await cacheService.flush();
    // sim_blend hidden as well: logit3 is next in the order.
    setControl([...HIDE_V10, crow('mlb', 'sim_blend', { site_visible: 'false' })]);
    const b = (await get(URL)).body.data;
    expect(b.stand_in).toMatchObject({ model: 'logit3', basis: 'fixed_order' });
    expect(b.featured_default).toBe('logit3');
  });

  it('a candidate with no rows is not eligible and does not shrink the common games', async () => {
    // sim_blend only exists as a table with no rows: logit3 is the sole candidate.
    useRoutes(seasonFixture(60, { v10: GOOD, logit3: OK, sim_blend: null }));
    setControl(HIDE_V10);
    expect((await get(URL)).body.data.stand_in).toMatchObject({ model: 'logit3', n_games: 60, basis: 'season_log_loss' });
  });

  it('never picks a derived model or the production key, even when they score best', async () => {
    useRoutes(seasonFixture(60, { v10: GOOD, logit3: BAD, sim_blend: BAD, elo: skill(0.4) }));
    setControl(PAUSE_V10);
    const s = (await get(URL)).body.data.stand_in;
    expect(['logit3', 'sim_blend']).toContain(s.model);
    expect(s.model).not.toBe('elo');
    expect(s.model).not.toBe('v10');
  });

  it('no candidate: no stand-in and the field is still present as null', async () => {
    useRoutes(seasonFixture(60, { v10: GOOD, elo: GOOD }));
    setControl(HIDE_V10);
    const d = (await get(URL)).body.data;
    expect(d).toHaveProperty('stand_in', null);
    expect(d).not.toHaveProperty('featured_default');
  });

  it('paused production triggers it, with the paused reason; v10 stays listed', async () => {
    useRoutes(seasonFixture(60, { v10: GOOD, logit3: OK, sim_blend: BAD }));
    setControl(PAUSE_V10);
    const d = (await get(URL)).body.data;
    expect(d.stand_in).toMatchObject({ model: 'logit3', reason: 'production_paused' });
    expect(d.models.map((m: any) => m.key)).toContain('v10');
  });

  it('a hidden candidate is not eligible', async () => {
    useRoutes(seasonFixture(60, { v10: OK, logit3: GOOD, sim_blend: BAD }));
    setControl([...HIDE_V10, crow('mlb', 'logit3', { site_visible: 'false' })]);
    expect((await get(URL)).body.data.stand_in).toMatchObject({ model: 'sim_blend' });
  });

  it('unhiding removes the stand-in', async () => {
    useRoutes(seasonFixture(60, { v10: OK, logit3: GOOD, sim_blend: BAD }));
    setControl(HIDE_V10);
    expect((await get(URL)).body.data.stand_in).not.toBeNull();
    setControl([]);
    clock += 60_000;
    const d = (await get(URL)).body.data;
    expect(d.stand_in).toBeNull();
    expect(d.models.map((m: any) => m.key)).toContain('v10');
  });

  it('is null (and present) when the production model merely has no rows', async () => {
    useRoutes(seasonFixture(60, { v10: null, logit3: GOOD, sim_blend: BAD }));
    setControl([crow('mlb', 'logit3', { display_label: 'L3' })]);
    const d = (await get(URL)).body.data;
    expect(d).toHaveProperty('stand_in', null);
    expect(d).not.toHaveProperty('featured_default');
  });

  it('empty or unavailable control: body identical to before apart from stand_in: null', async () => {
    useRoutes(seasonFixture(60, { v10: OK, logit3: GOOD, sim_blend: BAD }));
    setControl([]);
    const empty = (await get(URL)).body;
    await cacheService.flush();
    setControl(new Error('down'));
    const down = (await get(URL)).body;
    expect(down).toEqual(empty);
    expect(empty.data.stand_in).toBeNull();
    const { stand_in: _s, ...rest } = empty.data;
    expect(Object.keys(rest)).toEqual([
      'sport', 'season', 'division', 'rule', 'reference', 'small_sample_threshold', 'models',
      'scoreboard', 'games', 'window', 'backtest',
    ]);
  });

  it('football compare is unchanged: no stand_in field, hidden production keeps its games', async () => {
    useRoutes([[/spine|FROM `[^`]*\.games/, [[]]]]);
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const { body } = await get('/api/models/nfl/compare?season=2026');
    expect(JSON.stringify(body)).not.toContain('stand_in');
  });
});

describe('stand-in: slate route', () => {
  const DATE = '2030-06-15';
  const slate = (n: number, probs: Probs) => {
    const season = seasonFixture(n, probs);
    const slateRoutes: Array<[RegExp, any]> = [
      [/FULL OUTER JOIN g/, [[{
        game_pk: 2000, home_team_id: 144, away_team_id: 121, home_team_name: 'H0', away_team_name: 'A0',
        home_abbr: 'ATL', away_abbr: 'NYM', game_time_utc: at('2030-06-15T23:05:00.000Z'),
        home_score: null, away_score: null, final: null, status: null,
      }]]],
      [/game_sim_distributions/, missing('game_sim_distributions')],
      [/player_sim_projections/, [[]]],
    ];
    useRoutes([...slateRoutes, ...season]);
  };
  const SLATE = `/api/predictions/mlb/slate?date=${DATE}`;

  it('chooses by season log loss and makes it the featured default', async () => {
    slate(60, { v10: OK, logit3: BAD, sim_blend: GOOD });
    setControl(HIDE_V10);
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toEqual({
      model: 'sim_blend', label: 'PA sim + strength blend', reason: 'production_hidden',
      basis: 'season_log_loss', n_games: 60,
    });
    expect(d.featured_default).toBe('sim_blend');
    expect(d.games).toHaveLength(1);
  });

  it('log loss can pick logit3 over the fixed-order first choice', async () => {
    slate(60, { v10: OK, logit3: GOOD, sim_blend: BAD });
    setControl(PAUSE_V10);
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toMatchObject({ model: 'logit3', reason: 'production_paused', basis: 'season_log_loss' });
    expect(d.featured_default).toBe('logit3');
  });

  it('fixed order below 50 games; never a derived model', async () => {
    slate(10, { v10: GOOD, logit3: OK, sim_blend: BAD, elo: skill(0.4) });
    setControl(HIDE_V10);
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toMatchObject({ model: 'sim_blend', basis: 'fixed_order', n_games: null });
  });

  it('falls back to the fixed order when the season scoreboard cannot be read', async () => {
    slate(60, { v10: OK, logit3: GOOD, sim_blend: BAD });
    const inner = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (o: any) => {
      if (/WITH g AS/.test(o?.query ?? '')) throw new Error('boom');
      return inner(o);
    });
    setControl(HIDE_V10);
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toMatchObject({ model: 'sim_blend', basis: 'fixed_order' });
  });

  it('null and present with no hide/pause; identical to an empty control when control is down', async () => {
    slate(60, { v10: OK, logit3: GOOD, sim_blend: BAD });
    setControl(new Error('down'));
    const a = await get(SLATE);
    await cacheService.flush();
    setControl([]);
    const b = await get(SLATE);
    const strip = (x: any) => ({ ...x.body, meta: { ...x.body.meta, elapsed_ms: 0 } });
    expect(strip(a)).toEqual(strip(b));
    expect(a.body.data.stand_in).toBeNull();
    expect(a.body.data.featured_default).toBe('v10');
    // No season scoreboard is read when no stand-in applies.
    expect(mockQuery.mock.calls.some((c) => /WITH g AS/.test(c[0]?.query ?? ''))).toBe(false);
  });

  it('production without rows (not hidden, not paused) gets no stand-in', async () => {
    slate(60, { v10: null, logit3: GOOD, sim_blend: BAD });
    setControl([crow('mlb', 'sim_blend', { display_label: 'Sim' })]);
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toBeNull();
    expect(d.featured_default).toBe('v10');
  });

  it('unhiding removes it; the control version is in the cache key', async () => {
    slate(60, { v10: OK, logit3: GOOD, sim_blend: BAD });
    setControl(HIDE_V10);
    expect((await get(SLATE)).body.data.stand_in).not.toBeNull();
    setControl([]);
    clock += 60_000;
    const d = (await get(SLATE)).body.data;
    expect(d.stand_in).toBeNull();
    expect(d.featured_default).toBe('v10');
  });

  it('football slate has no stand_in even with the production key hidden', async () => {
    useRoutes([]);
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const { body } = await get('/api/predictions/nfl/slate?season=2026&week=3');
    expect(JSON.stringify(body)).not.toContain('stand_in');
  });
});

describe('last known good control state', () => {
  const HOUR = 3_600_000;
  const warnings = () => (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));

  async function primeGood() {
    useRoutes([]);
    setControl(HIDE_V10);
    const good = await getControl('mlb');
    expect(good.available).toBe(true);
    controlResult = new Error('bq down'); // keeps the cache; only the next read fails
    return good;
  }

  it('keeps applying the remembered state (same version) through failures within 6 h', async () => {
    const good = await primeGood();
    clock += 5 * HOUR;
    const during = await getControl('mlb');
    expect(during).toEqual(good);
    expect(during.version).toBe(good.version);
    // Failure result is cached ~10 s: no re-query, no second warning.
    clock += 5_000;
    expect(await getControl('mlb')).toEqual(good);
    clock += 30_000; // fails again, still the same window
    expect(await getControl('mlb')).toEqual(good);
    expect(warnings().filter((w) => /unavailable/.test(w))).toHaveLength(1);
  });

  it('fails open after 6 h and warns once more on expiry, never again in that window', async () => {
    await primeGood();
    clock += 5 * HOUR;
    await getControl('mlb');
    clock += 2 * HOUR; // 7 h since the good read
    expect(await getControl('mlb')).toEqual({ available: false, version: 'none', models: {} });
    clock += 30_000;
    await getControl('mlb');
    clock += 30_000;
    await getControl('mlb');
    const w = warnings();
    expect(w.filter((x) => /unavailable/.test(x))).toHaveLength(1);
    expect(w.filter((x) => /expired/.test(x))).toHaveLength(1);
    expect(CONTROL_LAST_GOOD_MS).toBe(6 * HOUR);
  });

  it('a successful read replaces the remembered state at once and opens a new window later', async () => {
    const good = await primeGood();
    clock += 2 * HOUR;
    expect(await getControl('mlb')).toEqual(good);
    controlResult = [crow('mlb', 'logit3', { site_visible: 'false' })];
    clock += 60_000;
    const next = await getControl('mlb');
    expect(next.models.logit3.visible).toBe(false);
    expect(next.models.v10).toBeUndefined();
    controlResult = new Error('again');
    clock += 60_000;
    expect(await getControl('mlb')).toEqual(next);
    expect(warnings().filter((x) => /unavailable/.test(x))).toHaveLength(2);
  });

  it('a failure before any good read fails open, one warning', async () => {
    useRoutes([]);
    setControl(new Error('never worked'));
    for (let i = 0; i < 4; i += 1) {
      expect(await getControl('mlb')).toEqual({ available: false, version: 'none', models: {} });
      clock += 11_000;
    }
    expect(warnings()).toHaveLength(1);
  });

  it('an empty view is a successful read: it clears the remembered state', async () => {
    await primeGood();
    controlResult = [];
    clock += 60_000;
    expect((await getControl('mlb')).available).toBe(false);
    controlResult = new Error('down');
    clock += 60_000;
    expect((await getControl('mlb')).available).toBe(false);
  });

  it('the stand-in survives a control outage within 6 h and disappears after', async () => {
    useRoutes(seasonFixture(60, { v10: OK, logit3: GOOD, sim_blend: BAD }));
    setControl(HIDE_V10);
    expect((await get(URL)).body.data.stand_in).not.toBeNull();
    controlResult = new Error('down');
    clock += 5 * HOUR;
    await cacheService.flush();
    expect((await get(URL)).body.data.stand_in).not.toBeNull();
    clock += 2 * HOUR;
    await cacheService.flush();
    const d = (await get(URL)).body.data;
    expect(d.stand_in).toBeNull();
    expect(d.models.map((m: any) => m.key)).toContain('v10');
  });
});

describe('lifecycle field', () => {
  const state = (row: Row) => parseControlRows([crow('mlb', 'logit3', row)], 'mlb').models.logit3;

  it('reads lifecycle and exposes it as lifecycle and role', () => {
    expect(state({ lifecycle: 'archived' })).toMatchObject({ lifecycle: 'archived', role: 'archived' });
  });

  it('falls back to the role column while the view carries only that', () => {
    expect(state({ role: 'live' })).toMatchObject({ lifecycle: 'live', role: 'live' });
  });

  it('lifecycle wins over role; junk falls through to the other column or is ignored', () => {
    expect(state({ lifecycle: 'shadow', role: 'live' })).toMatchObject({ lifecycle: 'shadow' });
    expect(state({ lifecycle: 'bogus', role: 'live' })).toMatchObject({ lifecycle: 'live' });
    const none = state({ lifecycle: 'bogus', role: 'nope' });
    expect(none.lifecycle).toBeUndefined();
    expect(none.role).toBeUndefined();
  });
});
