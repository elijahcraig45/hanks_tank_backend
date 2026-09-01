/**
 * Tests for the football stats endpoints.
 *
 * The first football tests in this repo. They pin the conventions rather than the
 * numbers: the three-tier error contract, the ORDER BY allow-list that is the only thing
 * between a query string and interpolated SQL, and the meta.columns contract the frontend
 * renders from.
 *
 * Two of these are direct regression tests for defects found in production:
 *   - `week` on the season endpoint used to reach SQL and 500 on `Unrecognized name`.
 *   - the CFB per-week note claimed no college stats existed while 154 columns of them
 *     sat in BigQuery.
 *
 * No supertest — it is not a dependency here. The router is mounted on a bare express app
 * and driven over a real ephemeral port with global fetch, matching
 * transactions.routes.test.ts. src/app.ts is never imported: it calls app.listen and
 * starts the scheduler at import time.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import {
  mockQuery, rows, count, queue, sentQueries, sentParams,
} from './helpers/bq-mock';
import footballRoutes from '../routes/football.routes';

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
beforeEach(() => { jest.clearAllMocks(); });

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /:sport/stats/teams/season', () => {
  const sampleRow = {
    season: 2025, team: 'Ohio State Buckeyes', team_abbr: 'OSU',
    gamesPlayed: 16, totalPointsPerGame: 35.5,
  };

  it('serves the college season table and describes its columns', async () => {
    queue(rows([sampleRow]), count(136));
    const { status, body } = await get(
      '/api/football/cfb/stats/teams/season?season=2025',
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.meta.scope).toBe('season');
    expect(body.meta.total).toBe(136);
    expect(Array.isArray(body.meta.columns)).toBe(true);
    expect(body.meta.columns.length).toBeGreaterThan(0);
    expect(body.meta.columns[0]).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        label: expect.any(String),
        group: expect.any(String),
        format: expect.any(String),
      }),
    );
  });

  it('states that the college table covers FBS only', async () => {
    queue(rows([sampleRow]), count(136));
    const { body } = await get('/api/football/cfb/stats/teams/season');
    expect(body.meta.coverage).toMatch(/FBS only/i);
  });

  it('ignores week and division instead of 500ing on Unrecognized name', async () => {
    // Regression: cfb_season.team_season_stats has neither column. Passing them through
    // raised `Unrecognized name: week`, which the old error guard did not match, so it
    // fell through to a 500.
    queue(rows([sampleRow]), count(136));
    const { status, body } = await get(
      '/api/football/cfb/stats/teams/season?week=5&division=fbs',
    );

    expect(status).toBe(200);
    expect(body.meta.ignored_params).toEqual(['week', 'division']);
    for (const sql of sentQueries()) {
      expect(sql).not.toMatch(/\bweek\b/);
      expect(sql).not.toMatch(/\bdivision\b/);
    }
  });

  it('rejects an off-list sort without touching BigQuery', async () => {
    const { status, body } = await get(
      '/api/football/cfb/stats/teams/season?sort=totalYards%3B+DROP+TABLE',
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_SORT');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('narrows the projection to the requested group', async () => {
    queue(rows([sampleRow]), count(136));
    await get('/api/football/cfb/stats/teams/season?group=passing');
    const select = sentQueries()[0];
    expect(select).toMatch(/`passingYards`/);
    // A kicking column must not ride along in a passing-only request.
    expect(select).not.toMatch(/`fieldGoalsMade`/);
  });

  it('reports an unknown field rather than silently dropping it', async () => {
    queue(rows([sampleRow]), count(136));
    const { body } = await get(
      '/api/football/cfb/stats/teams/season?fields=passingYards,nonsense',
    );
    expect(body.meta.unknown_fields).toEqual(['nonsense']);
  });

  it('caps limit at 200 however large the request', async () => {
    queue(rows([sampleRow]), count(136));
    await get('/api/football/cfb/stats/teams/season?limit=99999');
    expect(sentParams(0).limit).toBe(200);
  });

  it('answers 200 with a note where the sport has no season table', async () => {
    const { status, body } = await get('/api/football/nfl/stats/teams/season');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.meta.note).toMatch(/season stats/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats a missing table as an expected state, not a failure', async () => {
    mockQuery.mockRejectedValue(
      new Error('Not found: Table hankstank:cfb_season.team_season_stats'),
    );
    const { status, body } = await get('/api/football/cfb/stats/teams/season');
    expect(status).toBe(200);
    expect(body.meta.note).toMatch(/not built yet/i);
  });

  it('does not leak the underlying error message on a real failure', async () => {
    mockQuery.mockRejectedValue(
      new Error('quota exceeded for project hankstank, billing account 01ABCD'),
    );
    const { status, body } = await get('/api/football/cfb/stats/teams/season');
    expect(status).toBe(500);
    expect(body.error.code).toBe('STATS_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/quota|billing|01ABCD/i);
  });

  it('404s an unknown sport before querying anything', async () => {
    const { status, body } = await get('/api/football/xfl/stats/teams/season');
    expect(status).toBe(404);
    expect(body.error.code).toBe('UNKNOWN_SPORT');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('GET /:sport/stats/teams (per week)', () => {
  it('points at the season endpoint instead of denying college stats exist', async () => {
    // Regression: this note used to read "No per-team advanced stats feed for this sport
    // yet" while the college season table was already populated and configured.
    const { status, body } = await get('/api/football/cfb/stats/teams');
    expect(status).toBe(200);
    expect(body.meta.season_endpoint).toBe(
      '/api/football/cfb/stats/teams/season',
    );
    expect(body.meta.note).toContain('/api/football/cfb/stats/teams/season');
    expect(body.meta.note).not.toMatch(/no per-team advanced stats feed/i);
  });

  it('carries the same scope and columns contract as the season endpoint', async () => {
    queue(rows([{ season: 2025, week: 1, team: 'PHI', off_epa_play: 0.12 }]), count(32));
    const { body } = await get('/api/football/nfl/stats/teams?season=2025');
    expect(body.meta.scope).toBe('week');
    expect(body.meta.columns.length).toBe(17);
  });

  it('marks defensive EPA as lower-is-better', async () => {
    queue(rows([{ season: 2025, week: 1, team: 'PHI' }]), count(32));
    const { body } = await get('/api/football/nfl/stats/teams');
    const def = body.meta.columns.find((c: any) => c.key === 'def_epa_play');
    expect(def.higher_is_better).toBe(false);
    const off = body.meta.columns.find((c: any) => c.key === 'off_epa_play');
    expect(off.higher_is_better).toBe(true);
  });
});

describe('GET /:sport/teams', () => {
  const nflRow = {
    team_abbr: 'PHI', team_name: 'Philadelphia Eagles', team_nick: 'Eagles',
    team_conf: 'NFC', team_division: 'NFC East',
    team_color: '#004C54', team_color2: '#A5ACAF',
    team_logo_espn: 'https://example.test/phi.png',
    team_logo_squared: 'https://example.test/phi-sq.png',
    team_wordmark: 'https://example.test/phi-wm.png',
  };

  it('returns a canonical row with colours, logo and aliases', async () => {
    queue(rows([nflRow]));
    const { status, body } = await get('/api/football/nfl/teams');
    expect(status).toBe(200);
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        key: 'PHI',
        abbr: 'PHI',
        name: 'Philadelphia Eagles',
        primary_color: '#004C54',
        logo: 'https://example.test/phi.png',
      }),
    );
    // One matcher in one place: the other football tables disagree on team naming.
    expect(body.data[0].aliases).toEqual(
      expect.arrayContaining(['PHI', 'Philadelphia Eagles', 'Eagles']),
    );
  });

  it('restricts to the current league by default', async () => {
    // nfl_historical.teams holds 36 rows for 32 clubs: OAK, SD and STL persist.
    queue(rows([nflRow]));
    await get('/api/football/nfl/teams');
    expect(sentQueries()[0]).toMatch(/team_abbr IN \(/);
  });

  it('can be asked for the full historical set', async () => {
    queue(rows([nflRow]));
    const { body } = await get('/api/football/nfl/teams?active=false');
    expect(body.meta.active).toBe(false);
    expect(sentQueries()[0]).not.toMatch(/team_abbr IN \(/);
  });

  it('answers 200 with a note where the sport has no teams table', async () => {
    const { status, body } = await get('/api/football/cfb/teams');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta.note).toMatch(/team metadata/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
