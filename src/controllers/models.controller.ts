/**
 * The Models section: every serious model per sport, scored the same honest way.
 *
 *   GET /api/models/:sport/compare        sport = mlb | nfl | cfb
 *       ?season=2026
 *       ?division=fbs|fcs                 (cfb)
 *       ?week=N                           (football: which week's games to list)
 *       ?date=YYYY-MM-DD&days=N           (mlb: list games from date-days+1 .. date)
 *
 *   GET /api/models/mlb/totals-props?date=YYYY-MM-DD
 *
 * The rules, all enforced here or in the pure modules it calls:
 *   1. Only rows written strictly before first pitch / kickoff are scored. Per game the
 *      latest such row is used (pickPrediction). A game whose only row is post-start is
 *      listed, flagged not-pregame, and never scored. This matters: the MLB table holds
 *      418 post-hoc backfill rows, and a "latest row per game" dedupe picks exactly them.
 *   2. The head-to-head scores every model on the same games.
 *   3. Every metric carries a 95% block-bootstrap CI and its n; below 100 games the
 *      response says small_sample.
 *   4. The live scoreboard and the stored research backtest are separate blocks. The
 *      backtest is labelled with its source and date and is never merged into live.
 *   5. A table that does not exist yet is a state (available:false + note), not a 500.
 *
 * Envelope is { success, data, meta } as everywhere else; BigQuery DATE/TIMESTAMP
 * wrappers are flattened before anything leaves.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';
import { getFootballSport, FootballSportConfig } from '../config/football.config';
import {
  MLB_DATASET, MLB_PROPS_TABLE, ModelSource, REFERENCE_MODEL, modelsForSport,
} from '../config/models.config';
import { isMissingTable } from '../utils/football-request';
import {
  marketProbability, pickPrediction, ModelRow, SpineRow, defaultWeek,
} from '../utils/football-compare';
import { spineSql } from './football-compare.controller';
import {
  ScoredGame, buildModelScoreboard, disagreement, ModelPick, SMALL_SAMPLE,
} from '../utils/model-scoring';
import { MLB_BACKTEST } from '../data/model-backtests/mlb';
import { NFL_BACKTEST } from '../data/model-backtests/nfl';
import { CFB_BACKTEST } from '../data/model-backtests/cfb';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const bigquery = new BigQuery({ projectId: PROJECT });
const table = (dataset: string, name: string) => `\`${PROJECT}.${dataset}.${name}\``;

const BACKTESTS: Record<string, any> = { mlb: MLB_BACKTEST, nfl: NFL_BACKTEST, cfb: CFB_BACKTEST };

export const RULE = 'Scored only on predictions written strictly before first pitch or '
  + 'kickoff; the latest such row per game. A game whose only prediction was written '
  + 'after the start is listed, flagged, and never scored. Ties and unplayed games are '
  + 'not scored. 95% intervals are block-bootstrap (whole days for MLB, whole weeks '
  + 'for football).';

export interface ModelStatus {
  key: string;
  label: string;
  role: string;
  available: boolean;
  planned: boolean;
  backtest_only: boolean;
  rows: number;
  has_margin: boolean;
  has_total: boolean;
  note: string | null;
}

export interface ModelGameRow {
  game_id: string;
  date: string | null;
  start_time: string | null;
  season: number;
  week: number | null;
  home_team_name: string;
  away_team_name: string;
  completed: boolean;
  home_score: number | null;
  away_score: number | null;
  home_won: number | null;
  actual_home_margin: number | null;
  actual_total: number | null;
  predictions: Record<string, ModelPick | null>;
  disagreement: { range: number | null; split_pick: boolean; models: number };
}

const finite = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toIso(v: any): string | null {
  const flat = normalizeBigQueryTemporalValue(v);
  if (flat == null) return null;
  const ms = new Date(flat as any).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toDate(v: any): string | null {
  const flat = normalizeBigQueryTemporalValue(v);
  if (flat == null) return null;
  const s = String(flat);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : toIso(s)?.slice(0, 10) ?? null;
}

/* ── SQL ─────────────────────────────────────────────────────────────── */

/**
 * MLB spine: one row per 2026 regular-season game with its result and first-pitch time.
 *
 * `games` inserts rather than upserts (a skeleton row when scheduled, a complete row once
 * final), hence the GROUP BY. The start time comes from the prediction rows, the only
 * table that carries it; MAX, because a postponed game's rows carry the rescheduled time
 * and the real start is the last one.
 */
export function mlbSpineSql(): string {
  return `
    WITH g AS (
      SELECT game_pk,
             ANY_VALUE(game_date) AS game_date,
             ANY_VALUE(home_team_name) AS home_team_name,
             ANY_VALUE(away_team_name) AS away_team_name,
             MAX(home_score) AS home_score,
             MAX(away_score) AS away_score,
             LOGICAL_OR(status IN ('Final', 'Game Over', 'Completed Early')
                        OR STARTS_WITH(status, 'Final')) AS final
      FROM ${table(MLB_DATASET, 'games')}
      WHERE game_type = 'R' AND EXTRACT(YEAR FROM game_date) = @season
      GROUP BY game_pk
    ),
    t AS (
      SELECT game_pk, MAX(game_time_utc) AS game_time_utc
      FROM ${table(MLB_DATASET, 'game_predictions')}
      WHERE EXTRACT(YEAR FROM game_date) = @season AND game_time_utc IS NOT NULL
      GROUP BY game_pk
    )
    SELECT g.game_pk, g.game_date, g.home_team_name, g.away_team_name,
           g.home_score, g.away_score, g.final, t.game_time_utc
    FROM g LEFT JOIN t USING (game_pk)
    ORDER BY g.game_date, t.game_time_utc, g.game_pk`;
}

/** One model's rows, through the shared contract. */
export function modelSql(sport: string, m: ModelSource, dataset: string): string {
  const prob = m.probColumn || 'home_win_probability';
  const margin = m.marginExpr || 'CAST(NULL AS FLOAT64)';
  const total = m.totalExpr || 'CAST(NULL AS FLOAT64)';
  const id = sport === 'mlb' ? 'CAST(game_pk AS STRING)' : 'game_id';
  const where = sport === 'mlb' ? 'EXTRACT(YEAR FROM game_date) = @season' : 'season = @season';
  return `
    SELECT ${id} AS game_id, ${prob} AS home_win_probability,
           ${margin} AS predicted_home_margin, ${total} AS predicted_total,
           predicted_at, model_version
    FROM ${table(dataset, m.table as string)}
    WHERE ${where} AND ${prob} IS NOT NULL`;
}

/* ── loading ─────────────────────────────────────────────────────────── */

async function loadModel(
  sport: string, m: ModelSource, dataset: string, params: Record<string, any>,
): Promise<{ rows: ModelRow[]; status: ModelStatus }> {
  const base = {
    key: m.key,
    label: m.label,
    role: m.role,
    planned: Boolean(m.planned),
    backtest_only: Boolean(m.backtestOnly),
    has_margin: Boolean(m.marginExpr) || m.key === 'market',
    has_total: Boolean(m.totalExpr),
  };
  if (m.planned || m.backtestOnly || !m.table) {
    return {
      rows: [],
      status: {
        ...base, available: false, rows: 0,
        note: m.note || (m.planned ? 'Planned — not built yet.' : null),
      },
    };
  }
  try {
    const [rows] = await bigquery.query({ query: modelSql(sport, m, dataset), params });
    return {
      rows: rows as ModelRow[],
      status: {
        ...base,
        available: rows.length > 0,
        rows: rows.length,
        note: rows.length ? null : `No ${m.label} predictions for this season yet.`,
      },
    };
  } catch (error: any) {
    if (!isMissingTable(error)) throw error;
    logger.warn('models: table unavailable', { sport, model: m.key, error: error.message });
    return {
      rows: [],
      status: {
        ...base, available: false, rows: 0,
        note: `${dataset}.${m.table} has not been created yet (shadow writer pending approval).`,
      },
    };
  }
}

function groupRows(rows: ModelRow[]): Map<string, ModelRow[]> {
  const out = new Map<string, ModelRow[]>();
  for (const r of rows) {
    const id = String(r.game_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(r);
  }
  return out;
}

/* ── assembling games ────────────────────────────────────────────────── */

export function buildMlbGames(
  spine: any[], sources: Record<string, ModelRow[]>, season: number,
): Array<ModelGameRow & { block: string }> {
  const grouped = Object.fromEntries(Object.entries(sources).map(([k, r]) => [k, groupRows(r)]));
  return spine.map((g) => {
    const id = String(g.game_pk);
    const start = toIso(g.game_time_utc);
    const startMs = start ? Date.parse(start) : null;
    const hs = finite(g.home_score);
    const as = finite(g.away_score);
    const final = Boolean(g.final) && hs != null && as != null;
    const predictions: Record<string, ModelPick | null> = {};
    for (const key of Object.keys(sources)) {
      predictions[key] = pickPrediction(grouped[key].get(id) || [], startMs);
    }
    const date = toDate(g.game_date);
    return {
      game_id: id,
      block: date || id,
      date,
      start_time: start,
      season,
      week: null,
      home_team_name: g.home_team_name,
      away_team_name: g.away_team_name,
      completed: final,
      home_score: hs,
      away_score: as,
      home_won: final && hs !== as ? (hs! > as! ? 1 : 0) : null,
      actual_home_margin: final ? hs! - as! : null,
      actual_total: final ? hs! + as! : null,
      predictions,
      disagreement: disagreement(predictions),
    };
  });
}

export function buildFootballGames(
  sportKey: string, spine: SpineRow[], sources: Record<string, ModelRow[]>, withMarket: boolean,
): Array<ModelGameRow & { block: string }> {
  const grouped = Object.fromEntries(Object.entries(sources).map(([k, r]) => [k, groupRows(r)]));
  return spine.map((g) => {
    const id = String(g.game_id);
    const start = toIso(g.kickoff);
    const startMs = start ? Date.parse(start) : null;
    const hs = finite(g.home_score);
    const as = finite(g.away_score);
    const margin = hs != null && as != null ? hs - as : null;
    const hw = finite(g.home_won);
    const homeWon = margin === 0 ? null
      : (hw != null ? (hw === 1 ? 1 : 0) : (margin == null ? null : (margin > 0 ? 1 : 0)));
    const predictions: Record<string, ModelPick | null> = {};
    for (const key of Object.keys(sources)) {
      predictions[key] = pickPrediction(grouped[key].get(id) || [], startMs);
    }
    if (withMarket) {
      const m = marketProbability(sportKey, g);
      // A closing line is by nature the last price before kickoff.
      predictions.market = m ? {
        home_win_probability: m.p,
        predicted_home_margin: finite(g.spread_line),
        predicted_at: null,
        pregame: true,
        basis: m.basis,
      } : null;
    }
    return {
      game_id: id,
      block: `${g.season}-${g.week}`,
      date: start ? start.slice(0, 10) : null,
      start_time: start,
      season: Number(g.season),
      week: Number(g.week),
      home_team_name: g.home_team_name,
      away_team_name: g.away_team_name,
      completed: homeWon != null || margin === 0,
      home_score: hs,
      away_score: as,
      home_won: homeWon,
      actual_home_margin: margin,
      actual_total: hs != null && as != null ? hs + as : null,
      predictions,
      disagreement: disagreement(predictions),
    };
  });
}

function referenceFor(sport: string, statuses: ModelStatus[]): string | null {
  const live = new Set(statuses.filter((s) => s.available).map((s) => s.key));
  return (REFERENCE_MODEL[sport] || []).find((k) => live.has(k)) || null;
}

/** Strip the internal bootstrap block before a game leaves the server. */
const publicGame = ({ block, ...rest }: ModelGameRow & { block: string }): ModelGameRow => rest;

function backtestFor(sport: string, division: string | null) {
  const b = BACKTESTS[sport];
  if (!b) return null;
  return {
    ...b,
    label: 'Backtest — stored research results, not live predictions',
    scope_note: sport === 'cfb' && division === 'fcs'
      ? 'The college backtest covers FBS games only; there is no FCS backtest yet.'
      : null,
  };
}

/* ── handlers ────────────────────────────────────────────────────────── */

export async function getModelsCompare(req: Request, res: Response): Promise<void> {
  const sport = String(req.params.sport || '').toLowerCase();
  const registry = modelsForSport(sport);
  const football: FootballSportConfig | null = sport === 'mlb' ? null : getFootballSport(sport);
  if (!registry || (sport !== 'mlb' && !football)) {
    res.status(404).json({
      success: false,
      error: { code: 'UNKNOWN_SPORT', message: `Unknown sport: ${sport}` },
    });
    return;
  }

  const season = parseInt((req.query.season as string) || '', 10)
    || parseInt(process.env.CURRENT_SEASON || '', 10)
    || new Date().getUTCFullYear();
  const division = sport === 'cfb'
    ? String(req.query.division || 'fbs').toLowerCase()
    : null;

  try {
    const dataset = football ? football.seasonDataset : MLB_DATASET;
    const params: Record<string, any> = { season };
    const liveModels = registry.filter((m) => m.key !== 'market' || !football);
    const spinePromise = football
      ? bigquery.query({
        query: spineSql(football, football.hasDivisions),
        params: { season, sport, ...(football.hasDivisions ? { division } : {}) },
        types: football.hasDivisions ? { division: 'STRING' } : {},
      })
      : bigquery.query({ query: mlbSpineSql(), params });
    const [[spine], ...loaded] = await Promise.all([
      spinePromise,
      ...liveModels.map((m) => loadModel(sport, m, dataset, params)),
    ]);

    const sources: Record<string, ModelRow[]> = {};
    liveModels.forEach((m, i) => {
      if (loaded[i].status.available) sources[m.key] = loaded[i].rows;
    });
    const statuses: ModelStatus[] = loaded.map((l) => l.status);

    let games: Array<ModelGameRow & { block: string }>;
    if (football) {
      games = buildFootballGames(sport, spine as SpineRow[], sources, true);
      const mk = registry.find((m) => m.key === 'market')!;
      const n = games.filter((g) => g.predictions.market).length;
      statuses.unshift({
        key: 'market', label: mk.label, role: 'benchmark', available: n > 0,
        planned: false, backtest_only: false, rows: n, has_margin: true, has_total: false,
        note: n ? (sport === 'cfb' ? 'Win probability from the consensus spread, Φ(spread/15.5).'
          : 'De-vigged closing moneyline; the spread where no moneyline has landed.')
          : 'No lines stored for this season yet.',
      });
    } else {
      games = buildMlbGames(spine as any[], sources, season);
    }

    const scored = statuses.filter((s) => s.available).map((s) => s.key);
    const reference = referenceFor(sport, statuses);
    const scoreboard = buildModelScoreboard(games, scored, reference);

    // Which games to list.
    let listed: Array<ModelGameRow & { block: string }>;
    let window: Record<string, any>;
    if (football) {
      const weeks = [...new Set(games.map((g) => g.week as number))].sort((a, b) => a - b);
      const reqWeek = parseInt((req.query.week as string) || '', 10);
      const week = Number.isFinite(reqWeek) ? reqWeek
        : defaultWeek(games.map((g) => ({ ...g, kickoff: g.start_time })) as any);
      listed = games.filter((g) => g.week === week);
      window = { kind: 'week', week, weeks };
    } else {
      const dates = [...new Set(games.map((g) => g.date).filter(Boolean) as string[])].sort();
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const reqDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
        ? String(req.query.date) : null;
      const end = reqDate || [...dates].reverse().find((d) => d <= today) || dates[dates.length - 1] || null;
      const days = Math.min(Math.max(parseInt((req.query.days as string) || '3', 10) || 3, 1), 14);
      const startIdx = end ? Math.max(0, dates.filter((d) => d <= end).length - days) : 0;
      const from = end ? dates.filter((d) => d <= end)[startIdx] ?? end : null;
      listed = games.filter((g) => g.date && from && end && g.date >= from && g.date <= end);
      window = { kind: 'dates', from, to: end, days, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null };
    }

    const postStartOnly = games.filter((g) => Object.values(g.predictions)
      .some((p) => p && !p.pregame)).length;

    res.json({
      success: true,
      data: {
        sport,
        season,
        division,
        rule: RULE,
        reference,
        small_sample_threshold: SMALL_SAMPLE,
        models: statuses,
        scoreboard,
        games: listed.map(publicGame).reverse(),
        window,
        backtest: backtestFor(sport, division),
      },
      meta: {
        sport,
        season_games: games.length,
        decided_games: games.filter((g) => g.home_won != null).length,
        games_with_post_start_rows: postStartOnly,
        count: listed.length,
        rule: RULE,
      },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({
        success: true,
        data: null,
        meta: { sport, note: `${sport.toUpperCase()} predictions are not built yet.` },
      });
      return;
    }
    logger.error('models compare failed', { sport, error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'MODELS_COMPARE_ERROR', message: 'Failed to load the model comparison' },
    });
  }
}

/* ── MLB totals & props ──────────────────────────────────────────────── */

export function propsSql(): string {
  return `
    SELECT * EXCEPT(rn) FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY game_pk ORDER BY predicted_at DESC) AS rn
      FROM ${table(MLB_DATASET, MLB_PROPS_TABLE)}
      WHERE game_date = @d AND (game_time_utc IS NULL OR predicted_at < game_time_utc)
    ) WHERE rn = 1
    ORDER BY game_time_utc, game_pk`;
}

const arr = (v: any): number[] => (Array.isArray(v) ? v.map((x) => Number(x) || 0) : []);

/** P(X > line) for a half-point line, from a pmf indexed 0..N. */
export function pOver(pmf: number[], line: number): number | null {
  if (!pmf.length) return null;
  const total = pmf.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let over = 0;
  pmf.forEach((p, k) => { if (k > line) over += p; });
  return Math.round((over / total) * 10000) / 10000;
}

export function normalizePropsRow(r: any) {
  const pmf = arr(r.total_runs_pmf);
  const starter = (side: 'home' | 'away') => {
    const kpmf = arr(r[`${side}_starter_k_pmf`]);
    return {
      side,
      id: finite(r[`${side}_starter_id`]),
      name: r[`${side}_starter_name`] ?? null,
      k_mean: finite(r[`${side}_starter_k_mean`]),
      k_pmf: kpmf,
      p_over: Object.fromEntries([3.5, 4.5, 5.5, 6.5, 7.5].map((l) => [String(l), pOver(kpmf, l)])),
    };
  };
  return {
    game_pk: String(r.game_pk),
    game_date: toDate(r.game_date),
    game_time_utc: toIso(r.game_time_utc),
    predicted_at: toIso(r.predicted_at),
    home_team_name: r.home_team_name,
    away_team_name: r.away_team_name,
    model_version: r.model_version ?? null,
    n_episodes: finite(r.n_episodes),
    mean_home_runs: finite(r.mean_home_runs),
    mean_away_runs: finite(r.mean_away_runs),
    mean_total_runs: finite(r.mean_total_runs),
    total_runs_pmf: pmf,
    totals_calibrated: Boolean(r.totals_calibrated),
    total_bias_shift: finite(r.total_bias_shift),
    market_total_line: finite(r.market_total_line),
    p_over_market: finite(r.p_over_market),
    p_over: Object.fromEntries([6.5, 7.5, 8.5, 9.5, 10.5].map((l) => [String(l), pOver(pmf, l)])),
    starters: [starter('away'), starter('home')],
    // Batter props are over-predicted (P(>=1 hit) 64.5% vs 60.8% actual); never served
    // until they are calibrated, even if the writer stored them.
    batter_props: null,
  };
}

export async function getMlbTotalsProps(req: Request, res: Response): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
  const backtest = MLB_BACKTEST.extras || null;
  try {
    const [rows] = await bigquery.query({ query: propsSql(), params: { d: date } });
    res.json({
      success: true,
      data: {
        available: true,
        date,
        games: (rows as any[]).map(normalizePropsRow),
        batter_props: { shown: false, reason: 'Over-predicted: P(at least one hit) 64.5% predicted vs 60.8% actual in the 2020-26 backtest. Hidden until calibrated.' },
        backtest,
      },
      meta: { count: rows.length, table: `${MLB_DATASET}.${MLB_PROPS_TABLE}` },
    });
  } catch (error: any) {
    if (isMissingTable(error)) {
      res.json({
        success: true,
        data: {
          available: false,
          date,
          games: [],
          note: `${MLB_DATASET}.${MLB_PROPS_TABLE} has not been created yet — the simulator's `
            + 'shadow writer is built but not deployed (it needs more memory than the live '
            + 'Cloud Function has).',
          batter_props: { shown: false, reason: 'Over-predicted; hidden until calibrated.' },
          backtest,
        },
        meta: { count: 0 },
      });
      return;
    }
    logger.error('mlb totals/props failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'PROPS_ERROR', message: 'Failed to load totals and props' },
    });
  }
}
