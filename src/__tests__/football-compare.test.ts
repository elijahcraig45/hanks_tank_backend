/**
 * Tests for the football model comparison.
 *
 * The property worth pinning above all: nothing written at or after kickoff is ever
 * scored. The stack's prediction tables mix pregame rows with post-hoc backfills, and
 * the obvious "latest row per game" dedupe selects exactly the backfilled ones — so the
 * tests below build that trap on purpose and check it is not fallen into.
 */

import express from 'express';
import { Server } from 'http';

jest.mock('@google-cloud/bigquery', () => require('./helpers/bq-mock').factory());
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import { routeQueries, sentQueries } from './helpers/bq-mock';
import footballRoutes from '../routes/football.routes';
import { cacheService } from '../services/cache.service';
import {
  buildComparison, buildScoreboard, defaultWeek, marketProbability, normalCdf,
  pickPrediction, scoreModel, SpineRow,
} from '../utils/football-compare';
import { COMPARE_MODELS } from '../config/football-models.config';

const KICK = '2026-09-27T17:00:00.000Z';
const before = (h: number) => new Date(Date.parse(KICK) - h * 3600e3).toISOString();
const after = (h: number) => new Date(Date.parse(KICK) + h * 3600e3).toISOString();

const game = (over: Partial<SpineRow> = {}): SpineRow => ({
  game_id: 'g1', season: 2026, week: 3, division: null,
  home_team_name: 'BUF', away_team_name: 'LAC',
  kickoff: { value: KICK },
  home_score: 27, away_score: 20, home_won: 1,
  spread_line: 3, home_moneyline: -150, away_moneyline: 130,
  ...over,
});

describe('pickPrediction', () => {
  it('prefers the latest pregame row over a later backfill', () => {
    const p = pickPrediction([
      { game_id: 'g1', home_win_probability: 0.55, predicted_at: before(72) },
      { game_id: 'g1', home_win_probability: 0.60, predicted_at: before(2) },
      // The trap: a backfill written after the game, knowing the result.
      { game_id: 'g1', home_win_probability: 0.99, predicted_at: after(48) },
    ], Date.parse(KICK));
    expect(p?.home_win_probability).toBe(0.6);
    expect(p?.pregame).toBe(true);
  });

  it('shows a post-kickoff-only prediction but flags it not pregame', () => {
    const p = pickPrediction([
      { game_id: 'g1', home_win_probability: 0.7, predicted_at: { value: after(1) } },
    ], Date.parse(KICK));
    expect(p?.home_win_probability).toBe(0.7);
    expect(p?.pregame).toBe(false);
  });

  it('treats a row written exactly at kickoff as not pregame', () => {
    const p = pickPrediction([
      { game_id: 'g1', home_win_probability: 0.7, predicted_at: KICK },
    ], Date.parse(KICK));
    expect(p?.pregame).toBe(false);
  });

  it('cannot prove pregame without a kickoff', () => {
    const p = pickPrediction([
      { game_id: 'g1', home_win_probability: 0.7, predicted_at: before(24) },
    ], null);
    expect(p?.pregame).toBe(false);
  });

  it('returns null when there is nothing usable', () => {
    expect(pickPrediction([], Date.parse(KICK))).toBeNull();
    expect(pickPrediction([
      { game_id: 'g1', home_win_probability: null, predicted_at: before(2) },
    ], Date.parse(KICK))).toBeNull();
  });
});

describe('marketProbability', () => {
  it('de-vigs moneylines when both exist', () => {
    const m = marketProbability('nfl', game());
    const h = 150 / 250; const a = 100 / 230;
    expect(m?.basis).toBe('moneyline');
    expect(m?.p).toBeCloseTo(h / (h + a), 10);
  });

  it('falls back to the spread, positive meaning home favoured', () => {
    const m = marketProbability('cfb', game({ home_moneyline: null, away_moneyline: null, spread_line: 7 }));
    expect(m?.basis).toBe('spread');
    expect(m?.p).toBeCloseTo(normalCdf(7 / 15.5), 10);
    expect(m!.p).toBeGreaterThan(0.5);
  });

  it('is null with no line at all', () => {
    expect(marketProbability('cfb', game({
      home_moneyline: null, away_moneyline: null, spread_line: null,
    }))).toBeNull();
  });

  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
  });
});

describe('buildComparison + scoring', () => {
  const spine = [
    game(),
    game({ game_id: 'g2', home_score: 10, away_score: 24, home_won: 0, spread_line: -4 }),
    // Upcoming: shown, never scored.
    game({ game_id: 'g3', home_score: null, away_score: null, home_won: null, week: 4 }),
    // A tie has no winner and is not scored either.
    game({ game_id: 'g4', home_score: 20, away_score: 20, home_won: 0 }),
  ];
  const sources = {
    xgb: [
      { game_id: 'g1', home_win_probability: 0.8, predicted_at: before(48) },
      { game_id: 'g2', home_win_probability: 0.4, predicted_at: before(48) },
      { game_id: 'g3', home_win_probability: 0.5, predicted_at: before(48) },
      { game_id: 'g4', home_win_probability: 0.5, predicted_at: before(48) },
    ],
    ridge: [
      { game_id: 'g1', home_win_probability: 0.7, predicted_home_margin: 4, predicted_at: before(48) },
      // Backfilled after the game: must not count.
      { game_id: 'g2', home_win_probability: 0.1, predicted_home_margin: -14, predicted_at: after(24) },
    ],
  };
  const games = buildComparison('nfl', spine, sources);

  it('attaches every model plus the market to each game', () => {
    expect(Object.keys(games[0].predictions).sort()).toEqual(['market', 'ridge', 'xgb']);
    expect(games[0].kickoff).toBe(KICK);
    expect(games[0].actual_home_margin).toBe(7);
    expect(games[2].completed).toBe(false);
    expect(games[3].home_won).toBeNull();
  });

  it('scores only pregame predictions of decided games', () => {
    const x = scoreModel(games, 'xgb');
    expect(x.games).toBe(2);
    expect(x.accuracy).toBe(1);
    expect(x.log_loss).toBeCloseTo((-Math.log(0.8) - Math.log(0.6)) / 2, 10);
    expect(x.brier).toBeCloseTo(((0.2) ** 2 + (0.4) ** 2) / 2, 10);
    expect(x.spread_mae).toBeNull();

    const r = scoreModel(games, 'ridge');
    expect(r.games).toBe(1);
    expect(r.spread_mae).toBeCloseTo(3, 10);
  });

  it('head-to-head uses only games every scored model predicted pregame', () => {
    const board = buildScoreboard(games, ['xgb', 'ridge', 'fpi', 'market']);
    // fpi has no rows at all, so it is left out rather than emptying the set.
    expect(board.head_to_head.models).toEqual(['xgb', 'ridge', 'market']);
    expect(board.head_to_head.games).toBe(1);
    expect(board.head_to_head.rows.every((r) => r.games === 1)).toBe(true);
    expect(board.per_model.find((s) => s.model === 'fpi')?.games).toBe(0);
  });

  it('defaults to the earliest week with an unplayed game', () => {
    expect(defaultWeek(games, Date.parse('2026-09-20T00:00:00Z'))).toBe(4);
    expect(defaultWeek(games.filter((g) => g.week === 3))).toBe(3);
    expect(defaultWeek([])).toBeNull();
  });
});

describe('model registry', () => {
  it('pre-registers the drive simulation as planned, with the shared contract', () => {
    const sim = COMPARE_MODELS.find((m) => m.key === 'drive_sim');
    expect(sim?.planned).toBe(true);
    expect(sim?.hasMargin).toBe(true);
  });
});

/* ── the route ─────────────────────────────────────────────────────────── */

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
beforeEach(async () => {
  jest.clearAllMocks();
  await cacheService.flush();
});

const get = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /:sport/models/compare', () => {
  const spineRow = {
    game_id: '401858467', season: 2026, week: 4, division: 'fbs',
    home_team_name: 'Purdue Boilermakers', away_team_name: 'Notre Dame Fighting Irish',
    kickoff: { value: '2026-09-26T18:00:00.000Z' },
    home_score: 10, away_score: 38, home_won: 0,
    spread_line: -24.5, home_moneyline: null, away_moneyline: null,
  };

  it('returns the envelope, flattens BigQuery timestamps, and notes missing tables', async () => {
    routeQueries([
      [/WITH p AS/, [[spineRow]]],
      [/FROM `[^`]*\.game_predictions`/, [[{
        game_id: '401858467', home_win_probability: 0.1, predicted_home_margin: null,
        predicted_at: { value: '2026-09-22T10:00:00.000Z' }, model_version: 'cfb_v1',
      }]]],
      [/fpi_game_predictions/, () => {
        throw new Error('Not found: Table hankstank:cfb_season.fpi_game_predictions');
      }],
      [/ridge_shadow/, [[]]],
    ]);

    const { status, body } = await get('/api/football/cfb/models/compare?season=2026&division=fbs');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const d = body.data;
    expect(d.week).toBe(4);
    expect(d.games).toHaveLength(1);
    expect(d.games[0].kickoff).toBe('2026-09-26T18:00:00.000Z');
    expect(d.games[0].predictions.xgb.predicted_at).toBe('2026-09-22T10:00:00.000Z');
    expect(d.games[0].predictions.xgb.pregame).toBe(true);
    expect(d.games[0].predictions.market.basis).toBe('spread');

    const byKey = Object.fromEntries(d.models.map((m: any) => [m.key, m]));
    expect(byKey.fpi.available).toBe(false);
    expect(byKey.fpi.note).toMatch(/not been created/);
    expect(byKey.ridge.available).toBe(false);
    expect(byKey.drive_sim.planned).toBe(true);
    expect(byKey.market.available).toBe(true);

    const xgb = d.scoreboard.per_model.find((s: any) => s.model === 'xgb');
    expect(xgb.games).toBe(1);
    expect(xgb.accuracy).toBe(1);

    // The planned model is never queried.
    expect(sentQueries().some((q) => /drive_sim/.test(q))).toBe(false);
    // Every model query is season-scoped and parameterised.
    expect(sentQueries().filter((q) => /home_win_probability/.test(q))
      .every((q) => /season = @season/.test(q))).toBe(true);
  });

  it('404s an unknown sport', async () => {
    const { status } = await get('/api/football/xfl/models/compare');
    expect(status).toBe(404);
  });

  it('500s on a real failure without leaking it', async () => {
    routeQueries([[/WITH p AS/, () => { throw new Error('quota exceeded'); }]]);
    const { status, body } = await get('/api/football/nfl/models/compare?season=2026');
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/quota/);
  });
});
