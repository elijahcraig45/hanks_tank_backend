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
import { displayFor, normalizeRankingRow } from '../controllers/rankings.controller';
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
    expect(displayFor(cfb, undefined)).toEqual({ show: null, media: null, primary: 'resume' });
  });

  it('passes a valid list through in order', () => {
    expect(displayFor(cfb, { show: ['resume', 'results'], media: ['coaches'] }))
      .toEqual({ show: ['resume', 'results'], media: ['coaches'], primary: 'resume' });
  });

  it('drops keys outside the catalog but keeps the rest', () => {
    expect(displayFor(cfb, { show: ['nope', 'season'] }).show).toEqual(['season']);
  });

  it('treats a list with nothing recognised as no override, never as hide-all', () => {
    expect(displayFor(cfb, { show: ['nope'], media: ['espn'] })).toEqual({ show: null, media: null, primary: 'resume' });
  });

  it('keeps an explicit none as an empty list', () => {
    expect(displayFor(cfb, { show: [], media: [] })).toEqual({ show: [], media: [], primary: 'resume' });
  });

  it('is null for a sport whose catalog is empty', () => {
    expect(displayFor(RANKING_SPORTS.nfl, { show: ['results'], media: ['ap'] })).toEqual({ show: null, media: null, primary: 'rating' });
    expect(displayFor(RANKING_SPORTS.mlb, { show: ['results'] }).show).toBeNull();
  });
});

describe('resume columns on a row', () => {
  it('serves resume_games_json parsed as resume_games and keeps the numeric columns', () => {
    const row = normalizeRankingRow({
      team: 'A', resume_rank: 3, resume_sor: 1.1, resume_tie_lo: 1, resume_tie_hi: 7,
      resume_games_json: '[{"opp":"B","credit":0.3}]',
    });
    expect(row.resume_games).toEqual([{ opp: 'B', credit: 0.3 }]);
    expect(row.resume_games_json).toBeUndefined();
    expect(row).toMatchObject({ resume_rank: 3, resume_sor: 1.1, resume_tie_lo: 1, resume_tie_hi: 7 });
  });

  it('serves null resume_games for a board built before the column existed', () => {
    expect(normalizeRankingRow({ team: 'A', resume_games_json: null }).resume_games).toBeNull();
    expect(normalizeRankingRow({ team: 'A' }).resume_games).toBeUndefined();
  });
});

describe('primary order', () => {
  const cfb = RANKING_SPORTS.cfb;

  it('defaults to the resume for college football and the rating elsewhere', () => {
    expect(displayFor(cfb, undefined).primary).toBe('resume');
    expect(displayFor(RANKING_SPORTS.nfl, undefined).primary).toBe('rating');
    expect(displayFor(RANKING_SPORTS.mlb, undefined).primary).toBe('rating');
  });

  it('lets the control plane flip college football back to the rating', () => {
    expect(displayFor(cfb, { primary: 'rating' }).primary).toBe('rating');
    expect(displayFor(cfb, { primary: 'resume' }).primary).toBe('resume');
  });

  it('ignores an unsupported ask and a sport with no resume board', () => {
    expect(displayFor(cfb, { primary: 'vibes' }).primary).toBe('resume');
    expect(displayFor(RANKING_SPORTS.nfl, { primary: 'resume' }).primary).toBe('rating');
  });

  it('parses rankings_primary off the sport-wide row, case-insensitively, and drops junk', () => {
    expect(parseControlRows([star({ rankings_primary: ' Rating ' })], 'cfb').rankings).toEqual({ primary: 'rating' });
    expect(parseControlRows([star({ rankings_primary: 'nope' })], 'cfb').rankings).toBeUndefined();
    expect(parseControlRows([star({ rankings_primary: 'resume', rankings_show: 'results' })], 'cfb').rankings)
      .toEqual({ show: ['results'], primary: 'resume' });
  });

  it('changes the control version when the primary order changes', () => {
    const a = parseControlRows([star({ banner: 'b', rankings_primary: 'rating' })], 'cfb');
    const b = parseControlRows([star({ banner: 'b', rankings_primary: 'resume' })], 'cfb');
    expect(a.version).not.toBe(b.version);
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
    expect(m.display).toEqual({ show: ['season', 'results'], media: ['ap'], primary: 'resume' });
    expect(m.catalog.custom.map((c: any) => c.key)).toEqual(['results', 'season', 'forecast', 'resume']);
    expect(m.catalog.media).toEqual(['ap', 'coaches']);
    expect(mockedControl).toHaveBeenCalledWith('cfb');
  });

  it('reports an explicit none', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: [], media: [] } });
    expect((await meta()).display).toEqual({ show: [], media: [], primary: 'resume' });
  });

  it('reports nulls when every key is unknown', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: ['zzz'] } });
    expect((await meta()).display).toEqual({ show: null, media: null, primary: 'resume' });
  });

  it('reports nulls when control is unavailable (fail open)', async () => {
    mockedControl.mockResolvedValue(unavailable());
    expect((await meta()).display).toEqual({ show: null, media: null, primary: 'resume' });
  });

  it('reports the flipped primary order from the control plane', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { primary: 'rating' } });
    expect((await meta()).display.primary).toBe('rating');
  });

  it('reports nulls for a sport with no custom catalog', async () => {
    mockedControl.mockResolvedValue({ ...unavailable(), available: true, version: 'x', rankings: { show: ['results'] } });
    const m = await meta('nfl');
    expect(m.display).toEqual({ show: null, media: null, primary: 'rating' });
    expect(m.catalog).toEqual({ custom: [], media: [] });
  });
});
