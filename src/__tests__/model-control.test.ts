/**
 * The model control plane, read side: the control service (parse, cache, fail open), the
 * registry overlay, and every route that lists models, against a mocked BigQuery.
 *
 * The property everything hangs on: with the control data missing, empty, slow or failing,
 * responses are exactly what they were before the feature existed.
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

import { routeQueries, mockQuery, sentQueries, sentParamsFor } from './helpers/bq-mock';
import modelsRoutes from '../routes/models.routes';
import footballRoutes from '../routes/football.routes';
import predictionsRoutes from '../routes/predictions.routes';
import siteStatusRoutes from '../routes/site-status.routes';
import { cacheService } from '../services/cache.service';
import { logger } from '../utils/logger';
import {
  getControl, getAllControl, parseControlRows, resetControlCache, setControlClock,
  versionOf, CONTROL_TTL_MS,
} from '../services/model-control.service';
import { applyControl, maskPredictionRow, orderByControl } from '../utils/model-overlay';
import { MLB_MODELS } from '../config/models.config';
import { cacheGet } from '../middleware/responseCache.middleware';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use('/api/models', modelsRoutes);
  app.use('/api/football', footballRoutes);
  app.use('/api/predictions', predictionsRoutes);
  app.use('/api/site-status', siteStatusRoutes);
  // A route with a function prefix and a cap, to pin the middleware contract on its own.
  let v = 'a';
  app.get('/probe', cacheGet({ ttl: 900, prefix: () => `probe:${v}`, maxAge: 60 }),
    (_req, res) => res.json({ success: true, v }));
  app.get('/probe/bump', (_req, res) => { v = 'b'; res.json({ ok: true }); });
  app.get('/probe-nocap', cacheGet({ ttl: 900 }), (_req, res) => res.json({ success: true }));
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
  clock = 1_000_000;
  setControlClock(() => clock);
  delete process.env.CONTROL_DATASET;
  await cacheService.flush();
});
afterEach(() => { setControlClock(null); jest.useRealTimers(); });

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any, headers: res.headers };
};

/* ── fixtures ─────────────────────────────────────────────────────────── */

type Row = Record<string, any>;
const crow = (sport: string, target: string, over: Row = {}): Row => ({
  sport, target, site_visible: null, run_state: null, role: null, display_label: null,
  public_note: null, sort_order: null, banner: null, banner_level: null, ...over,
});

/** What the control view returns for the test in progress. */
let controlResult: Row[] | Error | 'hang' = [];
const controlRoute: [RegExp, any] = [/model_control_current/, () => {
  if (controlResult === 'hang') return new Promise(() => { /* never settles */ });
  if (controlResult instanceof Error) throw controlResult;
  return [controlResult];
}];
const setControl = (r: typeof controlResult) => { controlResult = r; resetControlCache(); };
const withControl = (routes: Array<[RegExp, any]>, fallback: any = [[]]) =>
  routeQueries([controlRoute, ...routes], fallback);

const missing = (name: string) => () => {
  throw new Error(`Not found: Table hankstank:x.${name} was not found in location US`);
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
const at = (s: string) => ({ value: s });

function mlbCompareRoutes() {
  withControl([
    [/WITH g AS/, [mlbSpine]],
    [/elo_home_win_prob AS home_win_probability/, [[
      { game_id: '1001', home_win_probability: 0.58, predicted_at: at('2026-09-20T20:00:00Z') },
      { game_id: '1002', home_win_probability: 0.61, predicted_at: at('2026-09-20T21:00:00Z') },
    ]]],
    [/game_predictions_logit3/, [[
      { game_id: '1001', home_win_probability: 0.5, predicted_at: at('2026-09-20T20:00:00Z') },
      { game_id: '1002', home_win_probability: 0.5, predicted_at: at('2026-09-20T20:00:00Z') },
    ]]],
    [/game_predictions_sim_blend/, missing('game_predictions_sim_blend')],
    [/game_predictions`/, [[
      { game_id: '1001', home_win_probability: 0.55, predicted_at: at('2026-09-20T20:00:00Z'), model_version: 'v10' },
      { game_id: '1002', home_win_probability: 0.52, predicted_at: at('2026-09-20T21:00:00Z'), model_version: 'v10' },
    ]]],
  ]);
}

const MLB_URL = '/api/models/mlb/compare?season=2026&date=2026-09-20';
const keysOf = (body: any) => body.data.models.map((m: any) => m.key);

const nflSpine = {
  game_id: '2026_03_BUF_MIA', season: 2026, week: 3, division: null,
  home_team_name: 'MIA', away_team_name: 'BUF',
  kickoff: at('2026-09-20T17:00:00.000Z'),
  home_score: 17, away_score: 24, home_won: 0,
  spread_line: -3, home_moneyline: 140, away_moneyline: -160,
  home_team_id: 'MIA', away_team_id: 'BUF', total_line: 44,
};
function nflRoutes() {
  withControl([
    [/WITH p AS/, [[nflSpine]]],
    [/game_sim_distributions/, missing('game_sim_distributions')],
    [/game_predictions_drive_sim/, [[{
      game_id: '2026_03_BUF_MIA', home_win_probability: 0.40, predicted_home_margin: -2.5,
      predicted_at: at('2026-09-18T10:00:00Z'), model_version: 'drive_sim_v1',
    }]]],
    [/game_predictions_ridge_shadow/, missing('ridge')],
    [/fpi_game_predictions/, missing('fpi')],
    [/game_predictions`/, [[{
      game_id: '2026_03_BUF_MIA', home_win_probability: 0.45, predicted_home_margin: null,
      predicted_at: at('2026-09-16T10:00:00Z'), model_version: 'nfl_v1',
    }]]],
  ]);
}

/* ── control service ──────────────────────────────────────────────────── */

describe('model-control.service', () => {
  it('reads the view with a parameterised query and CONTROL_DATASET (default control)', async () => {
    withControl([]);
    setControl([crow('mlb', 'logit3', { site_visible: 'false' })]);
    await getControl('mlb');
    expect(sentQueries()[0]).toMatch(/`hankstank\.control\.model_control_current`/);
    expect(sentParamsFor(/model_control_current/)).toEqual({ sports: ['mlb'] });
    expect(sentQueries()[0]).not.toContain('mlb');

    resetControlCache();
    process.env.CONTROL_DATASET = 'control_staging';
    await getControl('nfl');
    expect(sentQueries()[1]).toMatch(/hankstank\.control_staging\.model_control_current/);
  });

  it('parses, validates and truncates values; text stays inert', () => {
    const long = 'x'.repeat(500);
    const s = parseControlRows([
      crow('mlb', 'logit3', {
        site_visible: 'FALSE', run_state: 'paused', role: 'shadow', display_label: `  ${long}`,
        public_note: long, sort_order: '-5',
      }),
      crow('mlb', 'elo', { site_visible: 'maybe', role: 'wizard', sort_order: '99999' }),
      crow('mlb', 'bad key!', { site_visible: 'false' }),
      crow('mlb', '*', { banner: '<script>alert(1)</script>\nsecond   line', banner_level: 'loud' }),
    ], 'mlb');
    expect(s.available).toBe(true);
    expect(s.models.logit3).toEqual({
      visible: false, paused: true, role: 'shadow', lifecycle: 'shadow', label: 'x'.repeat(60), note: 'x'.repeat(300), sortOrder: -5,
    });
    expect(s.models.elo).toEqual({ visible: true, paused: false });
    expect(s.models['bad key!']).toBeUndefined();
    expect(s.banner).toEqual({ text: '<script>alert(1)</script> second line', level: 'info' });
    expect(typeof s.banner!.text).toBe('string');
  });

  it("applies '*' rows to every sport and lets the sport's own rows win", () => {
    const rows = [
      crow('mlb', '*', { banner: 'mlb only', banner_level: 'warn' }),
      crow('*', '*', { banner: 'everywhere', banner_level: 'error' }),
      crow('*', 'logit3', { site_visible: 'false' }),
      crow('nfl', 'logit3', { site_visible: 'true' }),
    ];
    expect(parseControlRows(rows, 'mlb').banner).toEqual({ text: 'mlb only', level: 'warn' });
    expect(parseControlRows(rows, 'cfb').banner).toEqual({ text: 'everywhere', level: 'error' });
    expect(parseControlRows(rows, 'cfb').models.logit3.visible).toBe(false);
    expect(parseControlRows(rows, 'nfl').models.logit3.visible).toBe(true);
  });

  it('no rows at all is unavailable, exactly like no control', () => {
    expect(parseControlRows([], 'mlb')).toEqual({ available: false, version: 'none', models: {} });
    expect(parseControlRows([crow('nfl', 'xgb')], 'mlb').available).toBe(false);
  });

  it('version is a short stable hash, independent of row order, and changes with the state', () => {
    const a = crow('mlb', 'logit3', { site_visible: 'false' });
    const b = crow('mlb', 'elo', { display_label: 'Elo!' });
    const v1 = parseControlRows([a, b], 'mlb').version;
    expect(parseControlRows([b, a], 'mlb').version).toBe(v1);
    expect(v1).toMatch(/^[0-9a-f]{10}$/);
    expect(parseControlRows([a], 'mlb').version).not.toBe(v1);
    expect(versionOf({ models: {} })).toBe(versionOf({ models: {} }));
  });

  it('makes one query per 30 s and re-reads after the clock passes the TTL', async () => {
    withControl([]);
    setControl([crow('mlb', 'logit3', { site_visible: 'false' })]);
    const first = await getControl('mlb');
    await getControl('mlb');
    await Promise.all([getControl('mlb'), getControl('mlb')]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(first.models.logit3.visible).toBe(false);

    clock += CONTROL_TTL_MS - 1;
    await getControl('mlb');
    expect(mockQuery).toHaveBeenCalledTimes(1);

    controlResult = [crow('mlb', 'logit3', { site_visible: 'true' })];
    clock += 1;
    const after = await getControl('mlb');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(after.models.logit3.visible).toBe(true);
    expect(after.version).not.toBe(first.version);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    withControl([]);
    setControl([crow('mlb', 'v10')]);
    await Promise.all(Array.from({ length: 10 }, () => getControl('mlb')));
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fails open on a query error and warns once, not per request', async () => {
    withControl([]);
    setControl(new Error('Access Denied: dataset control'));
    for (let i = 0; i < 5; i += 1) {
      expect(await getControl('mlb')).toEqual({ available: false, version: 'none', models: {} });
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fails open on a timeout', async () => {
    jest.useFakeTimers();
    withControl([]);
    setControl('hang');
    const p = getControl('mlb');
    await jest.advanceTimersByTimeAsync(2600);
    expect(await p).toEqual({ available: false, version: 'none', models: {} });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('an unknown sport never queries', async () => {
    withControl([]);
    expect((await getControl('xfl')).available).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads all three sports in ONE query', async () => {
    withControl([]);
    setControl([
      crow('mlb', '*', { banner: 'm' }), crow('nfl', 'xgb', { site_visible: 'false' }),
    ]);
    const all = await getAllControl();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(sentParamsFor(/model_control_current/).sports).toEqual(['mlb', 'nfl', 'cfb']);
    expect(all.mlb.banner?.text).toBe('m');
    expect(all.nfl.models.xgb.visible).toBe(false);
    expect(all.cfb.available).toBe(false);
    // ...and it primed the per-sport cache.
    await getControl('nfl');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

/* ── overlay ──────────────────────────────────────────────────────────── */

describe('applyControl', () => {
  const state = (rows: Row[]) => parseControlRows(rows, 'mlb');

  it('returns the same array when control is unavailable or changes nothing', () => {
    expect(applyControl(MLB_MODELS, parseControlRows([], 'mlb'))).toBe(MLB_MODELS);
    expect(applyControl(MLB_MODELS, state([crow('mlb', 'elo')]))).toBe(MLB_MODELS);
    expect(orderByControl(MLB_MODELS, state([crow('mlb', 'elo')]))).toBe(MLB_MODELS);
  });

  it('removes hidden keys, overrides label and note, and never mutates the registry', () => {
    const out = applyControl(MLB_MODELS, state([
      crow('mlb', 'logit3', { site_visible: 'false' }),
      crow('mlb', 'v10', { display_label: 'Main model', public_note: 'Plain note' }),
    ]));
    expect(out.map((m) => m.key)).toEqual(['v10', 'sim_blend', 'elo', 'market']);
    expect(out[0]).toEqual(expect.objectContaining({ label: 'Main model', labelOverride: 'Main model', note: 'Plain note', noteOverride: 'Plain note' }));
    expect(MLB_MODELS[0].label).toBe('V10 (production)');
    expect(MLB_MODELS.map((m) => m.key)).toContain('logit3');
  });

  it('sorts by sort_order, unset keeps registry position, ties stable', () => {
    const out = applyControl(MLB_MODELS, state([
      crow('mlb', 'elo', { sort_order: '-1' }),
      crow('mlb', 'market', { sort_order: '1' }),
    ]));
    // registry positions: v10 0, logit3 1, sim_blend 2, elo -1, market 1 (ties with logit3, registry order first)
    expect(out.map((m) => m.key)).toEqual(['elo', 'v10', 'logit3', 'market', 'sim_blend']);
  });

  it('masks prediction fields only where they exist and flags hidden', () => {
    const row = { game_id: 'g', home_win_probability: 0.6, predicted_winner: 'A', home_team_name: 'A', elo_home_win_prob: 0.5 };
    expect(maskPredictionRow(row)).toEqual({
      game_id: 'g', home_win_probability: null, predicted_winner: null, home_team_name: 'A',
      elo_home_win_prob: 0.5, hidden: true,
    });
  });
});

/* ── /api/models/:sport/compare ───────────────────────────────────────── */

describe('models compare with control', () => {
  it('fail open: an erroring, empty, or hanging control gives identical output', async () => {
    jest.setTimeout(15000);
    mlbCompareRoutes();
    setControl(new Error('boom'));
    const errored = await get(MLB_URL);
    expect(errored.status).toBe(200);

    await cacheService.flush();
    setControl([]);
    const empty = await get(MLB_URL);
    expect(empty.body).toEqual(errored.body);

    await cacheService.flush();
    setControl('hang');
    // Real timers: the 2.5 s control timeout elapses, then the request completes as if
    // control did not exist.
    const hung = (await get(MLB_URL)).body;
    expect(hung).toEqual(errored.body);

    expect(keysOf(errored.body)).toEqual(['v10', 'logit3', 'sim_blend', 'elo', 'market']);
    expect(errored.body.data.models.find((m: any) => m.key === 'logit3').label).toBe('3-feature logistic');
    expect(JSON.stringify(errored.body)).not.toMatch(/hidden/);
  });

  it('hiding a shadow removes it from models[], predictions{}, the scoreboard and disagreement', async () => {
    mlbCompareRoutes();
    setControl([crow('mlb', 'logit3', { site_visible: 'false' })]);
    const { body } = await get(MLB_URL);
    const d = body.data;
    expect(keysOf(body)).toEqual(['v10', 'sim_blend', 'elo', 'market']);
    for (const g of d.games) {
      expect(Object.keys(g.predictions)).not.toContain('logit3');
      expect(g.disagreement.models).toBe(2); // v10 + elo only
    }
    expect(d.scoreboard.per_model.map((r: any) => r.model)).toEqual(['v10', 'elo']);
    expect(Object.keys(d.scoreboard.calibration)).toEqual(['v10', 'elo']);
    expect(JSON.stringify(d.scoreboard)).not.toContain('logit3');
    // The hidden model's table is not even queried.
    expect(sentQueries().some((q) => /game_predictions_logit3/.test(q))).toBe(false);
  });

  it('overrides label, note and order; label and note reach the model status', async () => {
    mlbCompareRoutes();
    setControl([
      crow('mlb', 'logit3', { display_label: 'Simple model', public_note: 'Just three inputs.', sort_order: '-10' }),
    ]);
    const { body } = await get(MLB_URL);
    expect(keysOf(body)[0]).toBe('logit3');
    expect(body.data.models[0]).toEqual(expect.objectContaining({
      label: 'Simple model', note: 'Just three inputs.',
    }));
  });

  it('production hidden: spine games still served, v10 absent, reference falls to the next model', async () => {
    mlbCompareRoutes();
    setControl([crow('mlb', 'v10', { site_visible: 'false' })]);
    const { status, body } = await get(MLB_URL);
    expect(status).toBe(200);
    expect(keysOf(body)).not.toContain('v10');
    expect(body.data.games).toHaveLength(2);
    for (const g of body.data.games) expect(Object.keys(g.predictions)).not.toContain('v10');
    // 'market' is backtest-only and v10 is gone: no live reference, and no crash.
    expect(body.data.reference).toBeNull();
    expect(JSON.stringify(body.data.scoreboard.per_model)).not.toContain('"v10"');
    // The v10 query (game_predictions read without the Elo column) is never sent.
    expect(sentQueries().some((q) => /FROM `[^`]*\.game_predictions`/.test(q)
      && !/elo_home_win_prob/.test(q) && /model_version/.test(q))).toBe(false);
  });

  it('football: a hidden market disappears without crashing and the reference moves on', async () => {
    nflRoutes();
    setControl([crow('nfl', 'market', { site_visible: 'false' })]);
    const { status, body } = await get('/api/models/nfl/compare?season=2026');
    expect(status).toBe(200);
    expect(keysOf(body)).not.toContain('market');
    expect(body.data.games[0].predictions.market).toBeUndefined();
    expect(body.data.reference).toBe('xgb');
    expect(body.data.scoreboard.head_to_head.models).toEqual(['xgb', 'drive_sim']);
  });

  it('football: a hidden production key still serves the spine games', async () => {
    nflRoutes();
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const { body } = await get('/api/models/nfl/compare?season=2026');
    expect(keysOf(body)).not.toContain('xgb');
    expect(body.data.games).toHaveLength(1);
    expect(body.data.games[0].predictions.xgb).toBeUndefined();
    expect(body.data.games[0].predictions.market).toBeTruthy();
    expect(body.data.reference).toBe('market');
  });

  it('a hidden model is dropped from the stored backtest block too', async () => {
    mlbCompareRoutes();
    setControl([crow('mlb', 'sim_blend', { site_visible: 'false' })]);
    const { body } = await get(MLB_URL);
    for (const w of body.data.backtest.windows) {
      expect(w.models.map((m: any) => m.key)).not.toContain('sim_blend');
    }
  });

  it('cache key follows the control version; browser max-age is capped at 60 s', async () => {
    mlbCompareRoutes();
    setControl([crow('mlb', 'logit3', { site_visible: 'false' })]);
    const a = await get(MLB_URL);
    expect(a.headers.get('x-cache')).toBe('MISS');
    expect(a.headers.get('cache-control')).toBe('public, max-age=60');
    const b = await get(MLB_URL);
    expect(b.headers.get('x-cache')).toBe('HIT');

    // The lab un-hides logit3; within the TTL the old body is still served...
    controlResult = [crow('mlb', 'logit3', { site_visible: 'true' })];
    expect(keysOf((await get(MLB_URL)).body)).not.toContain('logit3');
    // ...and once the control read expires, the new version is a different key: a MISS.
    clock += CONTROL_TTL_MS + 1;
    const c = await get(MLB_URL);
    expect(c.headers.get('x-cache')).toBe('MISS');
    expect(keysOf(c.body)).toContain('logit3');
  });

  it('football compare and legacy routes are capped at 60 s too', async () => {
    nflRoutes();
    setControl([]);
    const r = await get('/api/models/nfl/compare?season=2026');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    const legacy = await get('/api/football/nfl/models/compare?season=2026');
    expect(legacy.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('hides the PA-simulator totals & props when sim_blend is hidden', async () => {
    withControl([[/game_props_sim/, [[{ game_pk: 7 }]]]]);
    setControl([crow('mlb', 'sim_blend', { site_visible: 'false' })]);
    const { body } = await get('/api/models/mlb/totals-props?date=2026-09-24');
    expect(body.data.available).toBe(false);
    expect(body.data.games).toEqual([]);
    expect(sentQueries().some((q) => /game_props_sim/.test(q))).toBe(false);
  });
});

/* ── legacy football compare ──────────────────────────────────────────── */

describe('legacy /api/football/:sport/models/compare with control', () => {
  it('fail open identical, hide removes from models/predictions/scoreboard', async () => {
    nflRoutes();
    setControl(new Error('down'));
    const base = await get('/api/football/nfl/models/compare?season=2026');
    await cacheService.flush();
    setControl([crow('nfl', 'drive_sim', { site_visible: 'false' }), crow('nfl', 'market', { site_visible: 'false' })]);
    const hid = await get('/api/football/nfl/models/compare?season=2026');
    expect(base.body.data.models.map((m: any) => m.key)).toEqual(['xgb', 'ridge', 'fpi', 'drive_sim', 'market']);
    expect(hid.body.data.models.map((m: any) => m.key)).toEqual(['xgb', 'ridge', 'fpi']);
    expect(Object.keys(hid.body.data.games[0].predictions).sort()).toEqual(['fpi', 'ridge', 'xgb']);
    expect(JSON.stringify(hid.body.data.scoreboard)).not.toMatch(/drive_sim|market/);
    expect(JSON.stringify(hid.body.data.week_scoreboard)).not.toMatch(/drive_sim|market/);
  });

  it('label, note and order overrides apply; production hidden keeps the games', async () => {
    nflRoutes();
    setControl([
      crow('nfl', 'fpi', { display_label: 'ESPN', public_note: 'External.', sort_order: '-1' }),
      crow('nfl', 'xgb', { site_visible: 'false' }),
    ]);
    const { body } = await get('/api/football/nfl/models/compare?season=2026');
    expect(body.data.models[0]).toEqual(expect.objectContaining({ key: 'fpi', label: 'ESPN', note: 'External.' }));
    expect(body.data.models.map((m: any) => m.key)).not.toContain('xgb');
    expect(body.data.games).toHaveLength(1);
  });
});

/* ── unified slate ────────────────────────────────────────────────────── */

describe('unified slate with control', () => {
  const DATE = '2030-06-15';
  const slateRoutes = () => withControl([
    [/FULL OUTER JOIN g/, [[{
      game_pk: 1001, home_team_id: 144, away_team_id: 121, home_team_name: 'Atlanta Braves',
      away_team_name: 'New York Mets', home_abbr: 'ATL', away_abbr: 'NYM',
      game_time_utc: at('2030-06-15T23:05:00.000Z'), home_score: null, away_score: null, final: null, status: null,
    }]]],
    [/game_sim_distributions/, missing('game_sim_distributions')],
    [/player_sim_projections/, [[{ game_id: '1001' }]]],
    [/elo_home_win_prob AS home_win_probability/, [[
      { game_id: '1001', home_win_probability: 0.66, predicted_at: at('2030-06-15T21:30:00Z') }]]],
    [/game_predictions_logit3/, [[
      { game_id: '1001', home_win_probability: 0.5, predicted_at: at('2030-06-15T21:30:00Z') }]]],
    [/game_predictions_sim_blend/, [[
      { game_id: '1001', home_win_probability: 0.58, predicted_at: at('2030-06-15T21:00:00Z') }]]],
    [/game_predictions`/, [[
      { game_id: '1001', home_win_probability: 0.55, predicted_at: at('2030-06-15T21:30:00Z'), model_version: 'v10' }]]],
  ]);

  it('hides a model from models[], predictions{}, consensus; featured_default follows', async () => {
    slateRoutes();
    setControl([crow('mlb', 'v10', { site_visible: 'false' }), crow('mlb', 'elo', { display_label: 'Elo (raw)' })]);
    const { body, headers } = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    const d = body.data;
    expect(d.models.map((m: any) => m.key)).toEqual(['logit3', 'sim_blend', 'elo', 'market']);
    expect(d.models.find((m: any) => m.key === 'elo').label).toBe('Elo (raw)');
    expect(Object.keys(d.games[0].predictions)).toEqual(['logit3', 'sim_blend', 'elo', 'market']);
    expect(d.games[0].consensus.models_n).toBe(3);
    // Production hidden: the stand-in (no graded games here, so the fixed order: sim_blend first).
    expect(d.featured_default).toBe('sim_blend');
    expect(d.stand_in).toMatchObject({
      model: 'sim_blend', reason: 'production_hidden', basis: 'fixed_order', n_games: null,
    });
    expect(d.games).toHaveLength(1); // spine intact
    expect(headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('fail open: identical to an empty control, featured_default stays production', async () => {
    slateRoutes();
    setControl(new Error('down'));
    const a = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    await cacheService.flush();
    setControl([]);
    const b = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    const strip = (x: any) => ({ ...x.body, meta: { ...x.body.meta, elapsed_ms: 0 } });
    expect(strip(a)).toEqual(strip(b));
    expect(a.body.data.featured_default).toBe('v10');
    expect(a.body.data.models.map((m: any) => m.key)).toEqual(['v10', 'logit3', 'sim_blend', 'elo', 'market']);
  });

  it('slate cache key changes with the control version', async () => {
    slateRoutes();
    setControl([crow('mlb', 'logit3', { site_visible: 'false' })]);
    const a = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect((await get(`/api/predictions/mlb/slate?date=${DATE}`)).headers.get('x-cache')).toBe('HIT');
    controlResult = [];
    clock += CONTROL_TTL_MS + 1;
    const c = await get(`/api/predictions/mlb/slate?date=${DATE}`);
    expect(c.headers.get('x-cache')).toBe('MISS');
    expect(a.body.data.models.length).toBe(4);
    expect(c.body.data.models.length).toBe(5);
  });

  it('football slate: hidden production key leaves the games; featured_default moves on', async () => {
    nflRoutes();
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const { body } = await get('/api/predictions/nfl/slate?season=2026&week=3');
    expect(body.data.models.map((m: any) => m.key)).not.toContain('xgb');
    expect(body.data.games).toHaveLength(1);
    expect(Object.keys(body.data.games[0].predictions)).not.toContain('xgb');
    expect(body.data.featured_default).not.toBe('xgb');
    expect(body.data.featured_default).toBeTruthy();
  });

  it('players are hidden with sim_blend', async () => {
    withControl([[/player_sim_projections/, [[{ game_pk: 1, player_id: 2, stat: 'h' }]]]]);
    setControl([crow('mlb', 'sim_blend', { site_visible: 'false' })]);
    const { body } = await get(`/api/predictions/mlb/players?date=${DATE}`);
    expect(body.data.available).toBe(false);
    expect(body.data.rows).toEqual([]);
    expect(sentQueries().some((q) => /player_sim_projections/.test(q))).toBe(false);
  });
});

/* ── legacy prediction endpoints, production hidden ───────────────────── */

describe('legacy prediction endpoints with the production model hidden', () => {
  it('football predictions: games returned, prediction fields null, hidden true', async () => {
    withControl([[/FROM `[^`]*\.game_predictions`/, [[{
      game_id: 'g1', home_team_name: 'MIA', away_team_name: 'BUF', week: 3, season: 2026,
      home_win_probability: 0.6, predicted_winner: 'MIA', confidence_tier: 'high',
      model_version: 'nfl_v1', elo_home_win_prob: 0.55,
    }]]]]);
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const { body } = await get('/api/football/nfl/predictions?season=2026');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(expect.objectContaining({
      game_id: 'g1', home_team_name: 'MIA', home_win_probability: null, predicted_winner: null,
      confidence_tier: null, model_version: null, hidden: true,
    }));
    expect(body.meta.hidden).toBe(true);
  });

  it('football predictions untouched when control is unavailable', async () => {
    withControl([[/FROM `[^`]*\.game_predictions`/, [[{ game_id: 'g1', home_win_probability: 0.6 }]]]]);
    setControl(new Error('down'));
    const { body } = await get('/api/football/nfl/predictions?season=2026');
    expect(body.data).toEqual([expect.objectContaining({ game_id: 'g1', home_win_probability: 0.6 })]);
    expect(body.data[0].hidden).toBeUndefined();
    expect(body.meta).toEqual({ sport: 'nfl', count: 1 });
  });

  it('football accuracy and diagnostics return the hidden state without querying predictions', async () => {
    withControl([]);
    setControl([crow('nfl', 'xgb', { site_visible: 'false' })]);
    const acc = await get('/api/football/nfl/predictions/accuracy?season=2025');
    expect(acc.body).toEqual(expect.objectContaining({ success: true, data: null }));
    expect(acc.body.meta.hidden).toBe(true);
    const diag = await get('/api/football/nfl/predictions/diagnostics?season=2025');
    expect(diag.body.diagnostics).toEqual([]);
    expect(diag.body.meta.hidden).toBe(true);
    expect(sentQueries().filter((q) => /game_predictions/.test(q))).toHaveLength(0);
  });

  it('MLB /api/predictions: games returned with prediction fields null', async () => {
    withControl([[/latest_pred/, [[{
      game_pk: 5, game_date: at('2026-09-20'), home_team_name: 'A', away_team_name: 'B',
      home_win_probability: 0.6, away_win_probability: 0.4, predicted_winner: 'A',
      confidence_tier: 'HIGH', model_version: 'v10', elo_home_win_prob: 0.5,
    }]]]]);
    setControl([crow('mlb', 'v10', { site_visible: 'false' })]);
    const { body } = await get('/api/predictions?date=2026-09-20');
    expect(body.count).toBe(1);
    expect(body.predictions[0]).toEqual(expect.objectContaining({
      game_pk: 5, home_team_name: 'A', home_win_probability: null, predicted_winner: null,
      model_version: null, hidden: true,
    }));
  });

  it('MLB /api/predictions untouched when control errors', async () => {
    withControl([[/latest_pred/, [[{ game_pk: 5, home_win_probability: 0.6, model_version: 'v10' }]]]]);
    setControl(new Error('down'));
    const { body } = await get('/api/predictions?date=2026-09-20');
    expect(body.predictions[0]).toEqual(expect.objectContaining({ home_win_probability: 0.6, model_version: 'v10' }));
    expect(body.predictions[0].hidden).toBeUndefined();
  });
});

/* ── site status ──────────────────────────────────────────────────────── */

describe('GET /api/site-status', () => {
  it('returns banners per sport as plain text, cached for 30 s', async () => {
    withControl([]);
    setControl([
      crow('mlb', '*', { banner: '<script>alert(1)</script>', banner_level: 'warn' }),
      crow('cfb', '*', { banner: 'CFB paused', banner_level: 'error' }),
    ]);
    const { status, body, headers } = await get('/api/site-status');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('public, max-age=30');
    expect(body.success).toBe(true);
    expect(body.data.control_available).toBe(true);
    expect(Date.parse(body.data.generated_at)).not.toBeNaN();
    expect(body.data.sports).toEqual({
      mlb: { banner: { text: '<script>alert(1)</script>', level: 'warn' } },
      nfl: { banner: null },
      cfb: { banner: { text: 'CFB paused', level: 'error' } },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('fails open: control unreadable -> 200, control_available false, no banners', async () => {
    withControl([]);
    setControl(new Error('down'));
    const { status, body, headers } = await get('/api/site-status');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('public, max-age=30');
    expect(body.data.control_available).toBe(false);
    expect(body.data.sports).toEqual({ mlb: { banner: null }, nfl: { banner: null }, cfb: { banner: null } });
  });

  it('exposes no write surface', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/api/site-status`, { method });
      expect(res.status).toBe(404);
    }
  });
});

/* ── response cache middleware ────────────────────────────────────────── */

describe('cacheGet prefix function and maxAge', () => {
  it('caps client max-age but keeps the server TTL; prefix function changes the key', async () => {
    const a = await get('/probe');
    expect(a.headers.get('cache-control')).toBe('public, max-age=60');
    expect(a.headers.get('x-cache')).toBe('MISS');
    expect((await get('/probe')).headers.get('x-cache')).toBe('HIT');
    await get('/probe/bump');
    const b = await get('/probe');
    expect(b.headers.get('x-cache')).toBe('MISS');
    expect(b.body.v).toBe('b');
  });

  it('without maxAge the header is the TTL, as before', async () => {
    const r = await get('/probe-nocap');
    expect(r.headers.get('cache-control')).toBe('public, max-age=900');
  });
});
