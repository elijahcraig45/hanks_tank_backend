/**
 * Pure logic for the football model comparison: pick each model's pregame prediction
 * per game, derive the market's, and score them.
 *
 * The one rule everything here serves: a prediction counts only if it was written
 * strictly before kickoff. Tables in this stack are known to mix pregame rows with
 * post-hoc backfills (the MLB table had 418 of them, some written 17 days after the
 * game), and the natural "latest row per game" dedupe picks exactly the contaminated
 * ones. So the latest row is chosen AMONG pregame rows, and a game with only a
 * post-kickoff row is shown flagged and left off the scoreboard.
 *
 * No I/O, so all of it is unit-tested directly.
 */

import { normalizeBigQueryTemporalValue } from './bq-normalize';
import { MARKET_KEY, MARKET_SPREAD_SIGMA } from '../config/football-models.config';

export interface SpineRow {
  game_id: string;
  season: number;
  week: number;
  division?: string | null;
  home_team_name: string;
  away_team_name: string;
  kickoff: any;
  home_score?: number | null;
  away_score?: number | null;
  home_won?: number | null;
  spread_line?: number | null;
  home_moneyline?: number | null;
  away_moneyline?: number | null;
}

export interface ModelRow {
  game_id: string;
  home_win_probability: number | null;
  predicted_home_margin?: number | null;
  predicted_at: any;
  model_version?: string | null;
}

export interface GamePrediction {
  home_win_probability: number;
  predicted_home_margin: number | null;
  predicted_at: string | null;
  /** Written strictly before kickoff. Only these are scored. */
  pregame: boolean;
  model_version?: string | null;
  /** Market only: which price the probability came from. */
  basis?: 'moneyline' | 'spread';
}

export interface ComparedGame {
  game_id: string;
  season: number;
  week: number;
  division: string | null;
  home_team_name: string;
  away_team_name: string;
  kickoff: string | null;
  completed: boolean;
  home_score: number | null;
  away_score: number | null;
  home_won: number | null;
  actual_home_margin: number | null;
  predictions: Record<string, GamePrediction | null>;
}

export interface ScoreLine {
  model: string;
  games: number;
  accuracy: number | null;
  log_loss: number | null;
  brier: number | null;
  /** Mean |predicted margin - actual margin|, over games where the model has a margin. */
  spread_mae: number | null;
  spread_games: number;
}

const EPS = 1e-6;
const clamp = (p: number) => Math.min(Math.max(p, EPS), 1 - EPS);

function toMs(value: any): number | null {
  const flat = normalizeBigQueryTemporalValue(value);
  if (flat == null) return null;
  const ms = new Date(flat as any).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: any): string | null {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

const finite = (v: any): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

export const normalCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

function impliedFromMoneyline(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

/**
 * The market's home win probability. De-vigged moneylines where both exist (NFL, from
 * nflverse), else Phi(spread / sigma) from the consensus spread (college, and NFL games
 * whose moneyline has not landed yet). Positive spread = home favoured.
 */
export function marketProbability(
  sport: string, game: SpineRow,
): { p: number; basis: 'moneyline' | 'spread' } | null {
  const hml = finite(game.home_moneyline);
  const aml = finite(game.away_moneyline);
  if (hml != null && aml != null && hml !== 0 && aml !== 0) {
    const h = impliedFromMoneyline(hml);
    const a = impliedFromMoneyline(aml);
    return { p: h / (h + a), basis: 'moneyline' };
  }
  const spread = finite(game.spread_line);
  const sigma = MARKET_SPREAD_SIGMA[sport];
  if (spread == null || !sigma) return null;
  return { p: normalCdf(spread / sigma), basis: 'spread' };
}

/**
 * The prediction to show and score for one game: the latest row written before
 * kickoff; failing that, the latest row at all, flagged not-pregame. Unknown kickoff
 * means pregame cannot be proven, so it is treated as not pregame.
 */
export function pickPrediction(rows: ModelRow[], kickoffMs: number | null): GamePrediction | null {
  let best: { row: ModelRow; at: number } | null = null;
  let latest: { row: ModelRow; at: number } | null = null;
  for (const row of rows) {
    if (finite(row.home_win_probability) == null) continue;
    const at = toMs(row.predicted_at) ?? -Infinity;
    if (!latest || at > latest.at) latest = { row, at };
    if (kickoffMs != null && at < kickoffMs && (!best || at > best.at)) best = { row, at };
  }
  const chosen = best || latest;
  if (!chosen) return null;
  return {
    home_win_probability: Number(chosen.row.home_win_probability),
    predicted_home_margin: finite(chosen.row.predicted_home_margin),
    predicted_at: toIso(chosen.row.predicted_at),
    pregame: Boolean(best),
    model_version: chosen.row.model_version ?? null,
  };
}

function groupByGame(rows: ModelRow[]): Map<string, ModelRow[]> {
  const out = new Map<string, ModelRow[]>();
  for (const r of rows) {
    const id = String(r.game_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(r);
  }
  return out;
}

/** A game is scorable once it has a winner. Ties have none and are skipped. */
function outcome(game: SpineRow): { homeWon: number | null; margin: number | null } {
  const hs = finite(game.home_score);
  const as = finite(game.away_score);
  const margin = hs != null && as != null ? hs - as : null;
  if (margin === 0) return { homeWon: null, margin };
  const hw = finite(game.home_won);
  if (hw != null) return { homeWon: hw === 1 ? 1 : 0, margin };
  return { homeWon: margin == null ? null : (margin > 0 ? 1 : 0), margin };
}

export function buildComparison(
  sport: string,
  spine: SpineRow[],
  sources: Record<string, ModelRow[]>,
): ComparedGame[] {
  const grouped = Object.fromEntries(
    Object.entries(sources).map(([k, rows]) => [k, groupByGame(rows)]),
  );

  return spine.map((g) => {
    const kickoffMs = toMs(g.kickoff);
    const { homeWon, margin } = outcome(g);
    const predictions: Record<string, GamePrediction | null> = {};
    for (const key of Object.keys(sources)) {
      predictions[key] = pickPrediction(grouped[key].get(String(g.game_id)) || [], kickoffMs);
    }
    const market = marketProbability(sport, g);
    // The line is a pre-kickoff price by nature: a closing line is the last one
    // quoted before the game starts, and nothing ingests in-game odds.
    predictions[MARKET_KEY] = market
      ? {
        home_win_probability: market.p,
        predicted_home_margin: finite(g.spread_line),
        predicted_at: null,
        pregame: true,
        basis: market.basis,
      }
      : null;

    return {
      game_id: String(g.game_id),
      season: Number(g.season),
      week: Number(g.week),
      division: g.division ?? null,
      home_team_name: g.home_team_name,
      away_team_name: g.away_team_name,
      kickoff: toIso(g.kickoff),
      completed: homeWon != null || margin === 0,
      home_score: finite(g.home_score),
      away_score: finite(g.away_score),
      home_won: homeWon,
      actual_home_margin: margin,
      predictions,
    };
  });
}

/** Pregame, scored predictions of one model. */
function scoredPairs(games: ComparedGame[], model: string, only?: Set<string>) {
  return games
    .filter((g) => g.home_won != null && (!only || only.has(g.game_id)))
    .map((g) => ({ g, p: g.predictions[model] }))
    .filter((x): x is { g: ComparedGame; p: GamePrediction } => Boolean(x.p && x.p.pregame));
}

export function scoreModel(games: ComparedGame[], model: string, only?: Set<string>): ScoreLine {
  const pairs = scoredPairs(games, model, only);
  if (!pairs.length) {
    return {
      model, games: 0, accuracy: null, log_loss: null, brier: null,
      spread_mae: null, spread_games: 0,
    };
  }
  let correct = 0; let ll = 0; let brier = 0; let mae = 0; let maeN = 0;
  for (const { g, p } of pairs) {
    const y = g.home_won as number;
    const prob = clamp(p.home_win_probability);
    if ((prob > 0.5 ? 1 : 0) === y) correct += 1;
    ll += y === 1 ? -Math.log(prob) : -Math.log(1 - prob);
    brier += (p.home_win_probability - y) ** 2;
    if (p.predicted_home_margin != null && g.actual_home_margin != null) {
      mae += Math.abs(p.predicted_home_margin - g.actual_home_margin);
      maeN += 1;
    }
  }
  const n = pairs.length;
  return {
    model,
    games: n,
    accuracy: correct / n,
    log_loss: ll / n,
    brier: brier / n,
    spread_mae: maeN ? mae / maeN : null,
    spread_games: maeN,
  };
}

/**
 * Two scoreboards, because they answer different questions:
 *
 *   per_model     every pregame prediction each model has. Largest samples, but the
 *                 models are scored on different games — a model that only ran for the
 *                 easy weeks would look better than it is.
 *   head_to_head  only games every compared model predicted pregame. The fair
 *                 comparison; its sample is the smallest of the lot.
 *
 * Models with no scored game are left out of the head-to-head set, otherwise one
 * not-yet-deployed shadow would empty it.
 */
export function buildScoreboard(games: ComparedGame[], models: string[]) {
  const per_model = models.map((m) => scoreModel(games, m));
  const compared = per_model.filter((s) => s.games > 0).map((s) => s.model);
  const common = new Set(
    games
      .filter((g) => g.home_won != null
        && compared.every((m) => g.predictions[m]?.pregame))
      .map((g) => g.game_id),
  );
  return {
    per_model,
    head_to_head: {
      models: compared,
      games: compared.length ? common.size : 0,
      rows: compared.length ? compared.map((m) => scoreModel(games, m, common)) : [],
    },
  };
}

/** The week a visitor means by "now": earliest week with an unplayed game, else the last. */
export function defaultWeek(games: ComparedGame[], nowMs = Date.now()): number | null {
  const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
  if (!weeks.length) return null;
  const upcoming = games
    .filter((g) => !g.completed && (toMs(g.kickoff) ?? Infinity) >= nowMs)
    .map((g) => g.week);
  return upcoming.length ? Math.min(...upcoming) : weeks[weeks.length - 1];
}
