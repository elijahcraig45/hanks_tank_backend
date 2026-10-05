/**
 * Which ranking columns the board draws: the control plane's `rankings_show` /
 * `rankings_media` (sport-wide row), parsed by the control service and passed to the
 * frontend as meta.display. Unset means "no override"; only an explicit "none" empties a list.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('../services/model-control.service', () => ({
  ...jest.requireActual('../services/model-control.service'),
  getControl: jest.fn(),
}));

import { mockQuery, rows } from './helpers/bq-mock';
import rankingsRoutes from '../routes/rankings.routes';
import { cacheService } from '../services/cache.service';
import { displayFor } from '../controllers/rankings.controller';
import { RANKING_SPORTS } from '../config/rankings.config';
import {
  getControl, parseControlRows, parseKeyList, unavailable, versionOf, ControlState,
} from '../services/model-control.service';

const mockedControl = getControl as jest.Mock;

const star = (over: Record<string, any>, sport = 'cfb') => ({ sport, target: '*', ...over });

describe('parseKeyList', () => {
  it('keeps order, lower-cases and trims', () => {
    expect(parseKeyList(' Season , RESULTS ', 3)).toEqual(['season', 'results']);
  });
  it('dedupes', () => {
    expect(parseKeyList('results,season,results', 3)).toEqual(['results', 'season']);
  });
  it('caps at max, keeping the first ones', () => {
    expect(parseKeyList('a,b,c,d,e', 3)).toEqual(['a', 'b', 'c']);
  });
  it('reads "none" as an explicit empty list', () => {
    expect(parseKeyList('none', 3)).toEqual([]);
    expect(parseKeyList(' NONE ', 3)).toEqual([]);
  });
  it('drops junk entries and treats all-junk, blank and null as no override', () => {
    expect(parseKeyList('results,<b>,,bad key,season', 3)).toEqual(['results', 'season']);
    expect(parseKeyList('<<>>,;;', 3)).toBeUndefined();
    expect(parseKeyList('   ', 3)).toBeUndefined();
    expect(parseKeyList(null, 3)).toBeUndefined();
    expect(parseKeyList(undefined, 3)).toBeUndefined();
  });
});

describe('parseControlRows: rankings', () => {
  it('reads both fields off the sport-wide row', () => {
    const s = parseControlRows([star({ rankings_show: 'season,results', rankings_media: 'ap' })], 'cfb');
    expect(s.available).toBe(true);
    expect(s.rankings).toEqual({ show: ['season', 'results'], media: ['ap'] });
  });

  it('carries "none" through as empty lists', () => {
    const s = parseControlRows([star({ rankings_show: 'none', rankings_media: 'none' })], 'cfb');
    expect(s.rankings).toEqual({ show: [], media: [] });
  });

  it('sets only the field that is present', () => {
    expect(parseControlRows([star({ rankings_media: 'ap,coaches' })], 'cfb').rankings)
      .toEqual({ media: ['ap', 'coaches'] });
  });

  it('works against an old view that has neither column', () => {
    const s = parseControlRows([star({ banner: 'hello' }), { sport: 'cfb', target: 'xgb', site_visible: 'true' }], 'cfb');
    expect(s.available).toBe(true);
    expect(s.rankings).toBeUndefined();
    expect(s.banner?.text).toBe('hello');
  });

  it('ignores the fields on a model row (they are sport-wide only)', () => {
    const s = parseControlRows([{ sport: 'cfb', target: 'xgb', rankings_show: 'results' }], 'cfb');
    expect(s.rankings).toBeUndefined();
  });

  it('does not leak another sport\'s setting', () => {
    const s = parseControlRows([star({ rankings_show: 'results' }, 'nfl')], 'cfb');
    expect(s.rankings).toBeUndefined();
  });

  it('changes the version when the setting changes, and only then', () => {
    const none = parseControlRows([star({ banner: 'b' })], 'cfb');
    const a = parseControlRows([star({ banner: 'b', rankings_show: 'results' })], 'cfb');
    const b = parseControlRows([star({ banner: 'b', rankings_show: 'results,season' })], 'cfb');
    const a2 = parseControlRows([star({ banner: 'b', rankings_show: 'results' })], 'cfb');
    expect(new Set([none.version, a.version, b.version]).size).toBe(3);
    expect(a.version).toBe(a2.version);
  });

  it('keeps the pre-existing version for a state without rankings', () => {
    const state: Pick<ControlState, 'models' | 'banner'> = { models: {}, banner: undefined };
    expect(versionOf(state)).toBe(versionOf({ ...state, rankings: undefined }));
  });
});

describe('displayFor', () => {
  const cfb = RANKING_SPORTS.cfb;

  it('is null/null with no override', () => {
    expect(displayFor(cfb, undefined)).toEqual({ show: null, media: null });
  });

  it('passes a valid list through in order', () => {
    expect(displayFor(cfb, { show: ['resume', 'results'], media: ['coaches'] }))
      .toEqual({ show: ['resume', 'results'], media: ['coaches'] });
  });

  it('drops keys outside the catalog but keeps the rest', () => {
    expect(displayFor(cfb, { show: ['nope', 'season'] }).show).toEqual(['season']);
  });

  it('treats a list with nothing recognised as no override, never as hide-all', () => {
    expect(displayFor(cfb, { show: ['nope'], media: ['espn'] })).toEqual({ show: null, media: null });
  });

  it('keeps an explicit none as an empty list', () => {
    expect(displayFor(cfb, { show: [], media: [] })).toEqual({ show: [], media: [] });
  });

  it('is null for a sport whose catalog is empty', () => {
    expect(displayFor(RANKING_SPORTS.nfl, { show: ['results'], media: ['ap'] })).toEqual({ show: null, media: null });
    expect(displayFor(RANKING_SPORTS.mlb, { show: ['results'] }).show).toBeNull();
  });
});

describe('GET /api/rankings/:sport meta.display', () => {
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
    mockQuery.mockReset();
    await cacheService.flush();
    mockQuery.mockResolvedValue(rows([{ team: 'A', rank: 1, rating: 1, as_of_week: 5, season: 2026, model: 'margin' }]));
  });

  const meta = async (sport = 'cfb') => {
    const res = await fetch(`${baseUrl}/api/rankings/${sport}?season=2026`);
    return (await res.json() as any).meta;
  };

  it('reports the override, filtered to the catalog', async () => {
    mockedControl.mockResolvedValue({
      ...unavailable(), available: true, version: 'x', rankings: { show: ['season', 'bogus', 'results'], media: ['ap'] },
    });
    const m = await meta();
    expect(m.display).toEqual({ show: ['season', 'results'], media: ['ap'] });
    expect(m.catalog.custom.map((c: any) => c.key)).toEqual(['results', 'season', 'forecast', 'resume']);
    expect(m.catalog.media).toEqual(['ap', 'coaches']);
    expect(mockedControl).toHaveBeenCalledWith('cfb');
  });

  it('reports an explicit none', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: [], media: [] } });
    expect((await meta()).display).toEqual({ show: [], media: [] });
  });

  it('reports nulls when every key is unknown', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: ['zzz'] } });
    expect((await meta()).display).toEqual({ show: null, media: null });
  });

  it('reports nulls when control is unavailable (fail open)', async () => {
    mockedControl.mockResolvedValue(unavailable());
    expect((await meta()).display).toEqual({ show: null, media: null });
  });

  it('reports nulls for a sport with no custom catalog', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: ['results'] } });
    const m = await meta('nfl');
    expect(m.display).toEqual({ show: null, media: null });
    expect(m.catalog).toEqual({ custom: [], media: [] });
  });
});
