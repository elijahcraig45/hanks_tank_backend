/**
 * Sport-neutral scoring for the Models pages: every model scored the same honest way.
 *
 * Input is a list of games, each carrying one pick per model (already chosen by
 * `pickPrediction`, i.e. the latest row written strictly before the start). This module
 * never looks at a row that is not flagged `pregame`, so the pregame rule is enforced in
 * one place upstream and cannot be bypassed here.
 *
 * What it returns, per model:
 *   log loss, accuracy, Brier           each with a 95% block-bootstrap CI and n
 *   spread MAE / total MAE              where the model produces a margin or a total
 *   calibration                         reliability bins (predicted vs actual, counts)
 *
 * and a head-to-head block on the games EVERY available model predicted pregame, with
 * paired log-loss deltas against a reference (the market where it exists).
 *
 * The bootstrap resamples whole blocks — a date for MLB, a week for football — because
 * games on one day or in one week share conditions and per-game resampling would give
 * CIs that are too narrow. It is seeded, so the same data always gives the same CI and
 * a cached response never disagrees with a fresh one.
 *
 * No I/O; unit-tested directly.
 */

export interface ModelPick {
  home_win_probability: number;
  predicted_home_margin?: number | null;
  predicted_total?: number | null;
  predicted_at?: string | null;
  pregame: boolean;
  model_version?: string | null;
  basis?: string;
}

export interface ScoredGame {
  game_id: string;
  /** Bootstrap block: game date (MLB) or season-week (football). */
  block: string;
  home_won: number | null;
  actual_home_margin: number | null;
  actual_total: number | null;
  predictions: Record<string, ModelPick | null | undefined>;
}

export interface Interval {
  value: number;
  lo: number;
  hi: number;
}

export interface CalibrationBin {
  /** Mean predicted home-win probability in the bin. */
  p: number;
  /** Observed home-win rate in the bin. */
  y: number;
  n: number;
  y_lo: number;
  y_hi: number;
}

export interface MetricLine {
  model: string;
  n: number;
  log_loss: Interval | null;
  accuracy: Interval | null;
  brier: Interval | null;
  spread_mae: Interval | null;
  spread_n: number;
  total_mae: Interval | null;
  total_n: number;
  small_sample: boolean;
}

export interface PairedDelta {
  model: string;
  reference: string;
  n: number;
  /** reference log loss - model log loss: positive means the model is better. */
  log_loss_gain: Interval | null;
  /** Share of bootstrap draws in which the model beat the reference. */
  p_better: number | null;
}

export const SMALL_SAMPLE = 100;
export const BOOT_REPS = 1000;
const EPS = 1e-6;
const clamp = (p: number) => Math.min(Math.max(p, EPS), 1 - EPS);

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round = (x: number, d = 5) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Block-bootstrap the means of several per-game series at once, with shared resamples
 * so paired statistics (differences) come out consistent with the single ones.
 */
export function blockBootstrap(
  blocks: string[],
  series: Record<string, number[]>,
  reps = BOOT_REPS,
  seed = 20260925,
): Record<string, number[]> {
  const index = new Map<string, number>();
  const blockOf = blocks.map((b) => {
    if (!index.has(b)) index.set(b, index.size);
    return index.get(b)!;
  });
  const k = index.size;
  const sizes = new Array(k).fill(0);
  blockOf.forEach((b) => { sizes[b] += 1; });
  const sums: Record<string, number[]> = {};
  for (const [name, values] of Object.entries(series)) {
    const s = new Array(k).fill(0);
    values.forEach((v, i) => { s[blockOf[i]] += v; });
    sums[name] = s;
  }
  const rand = prng(seed);
  const out: Record<string, number[]> = Object.fromEntries(Object.keys(series).map((n) => [n, []]));
  if (!k) return out;
  const pick = new Array(k);
  for (let r = 0; r < reps; r += 1) {
    let total = 0;
    for (let j = 0; j < k; j += 1) {
      pick[j] = Math.floor(rand() * k);
      total += sizes[pick[j]];
    }
    for (const name of Object.keys(series)) {
      let s = 0;
      for (let j = 0; j < k; j += 1) s += sums[name][pick[j]];
      out[name].push(s / total);
    }
  }
  return out;
}

function interval(values: number[], draws: number[]): Interval | null {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...draws].sort((a, b) => a - b);
  return {
    value: round(mean),
    lo: round(sorted.length ? percentile(sorted, 0.025) : mean),
    hi: round(sorted.length ? percentile(sorted, 0.975) : mean),
  };
}

/** Per-game losses of one model over the given (decided, pregame) games. */
function losses(games: ScoredGame[], model: string) {
  const ll: number[] = []; const acc: number[] = []; const brier: number[] = [];
  const blocks: string[] = [];
  const spread: number[] = []; const spreadBlocks: string[] = [];
  const total: number[] = []; const totalBlocks: string[] = [];
  for (const g of games) {
    const p = g.predictions[model];
    if (!p || !p.pregame || g.home_won == null) continue;
    const y = g.home_won;
    const prob = clamp(p.home_win_probability);
    ll.push(y === 1 ? -Math.log(prob) : -Math.log(1 - prob));
    acc.push((prob > 0.5 ? 1 : 0) === y ? 1 : 0);
    brier.push((p.home_win_probability - y) ** 2);
    blocks.push(g.block);
    if (p.predicted_home_margin != null && g.actual_home_margin != null) {
      spread.push(Math.abs(p.predicted_home_margin - g.actual_home_margin));
      spreadBlocks.push(g.block);
    }
    if (p.predicted_total != null && g.actual_total != null) {
      total.push(Math.abs(p.predicted_total - g.actual_total));
      totalBlocks.push(g.block);
    }
  }
  return { ll, acc, brier, blocks, spread, spreadBlocks, total, totalBlocks };
}

export function scoreModel(games: ScoredGame[], model: string, reps = BOOT_REPS): MetricLine {
  const L = losses(games, model);
  const n = L.ll.length;
  const draws = blockBootstrap(L.blocks, { ll: L.ll, acc: L.acc, brier: L.brier }, n ? reps : 0);
  const sd = L.spread.length ? blockBootstrap(L.spreadBlocks, { m: L.spread }, reps).m : [];
  const td = L.total.length ? blockBootstrap(L.totalBlocks, { m: L.total }, reps).m : [];
  return {
    model,
    n,
    log_loss: interval(L.ll, draws.ll),
    accuracy: interval(L.acc, draws.acc),
    brier: interval(L.brier, draws.brier),
    spread_mae: interval(L.spread, sd),
    spread_n: L.spread.length,
    total_mae: interval(L.total, td),
    total_n: L.total.length,
    small_sample: n < SMALL_SAMPLE,
  };
}

/**
 * Reliability bins: quantile bins of the predicted probability, at least `minPerBin`
 * games each and at most `maxBins` bins. Quantile rather than fixed-width, because
 * baseball probabilities sit almost entirely inside 0.35-0.70 and ten fixed bins would
 * leave most of them empty. Same algorithm as the research export, so live and
 * backtest charts are comparable.
 */
export function calibrationBins(
  games: ScoredGame[], model: string, maxBins = 10, minPerBin = 30,
): CalibrationBin[] {
  const pairs = games
    .map((g) => ({ p: g.predictions[model], y: g.home_won }))
    .filter((x): x is { p: ModelPick; y: number } => Boolean(x.p && x.p.pregame) && x.y != null)
    .map((x) => ({ p: x.p.home_win_probability, y: x.y }))
    .sort((a, b) => a.p - b.p);
  const n = pairs.length;
  if (!n) return [];
  const bins = Math.max(1, Math.min(maxBins, Math.floor(n / minPerBin)));
  const out: CalibrationBin[] = [];
  // np.array_split semantics: the first (n % bins) chunks get one extra.
  const base = Math.floor(n / bins);
  const extra = n % bins;
  let start = 0;
  for (let b = 0; b < bins; b += 1) {
    const size = base + (b < extra ? 1 : 0);
    const chunk = pairs.slice(start, start + size);
    start += size;
    if (!chunk.length) continue;
    const p = chunk.reduce((s, x) => s + x.p, 0) / chunk.length;
    const y = chunk.reduce((s, x) => s + x.y, 0) / chunk.length;
    const se = Math.sqrt(Math.max(y * (1 - y), 1e-9) / chunk.length);
    out.push({
      p: round(p, 4),
      y: round(y, 4),
      n: chunk.length,
      y_lo: round(Math.max(0, y - 1.96 * se), 4),
      y_hi: round(Math.min(1, y + 1.96 * se), 4),
    });
  }
  return out;
}

/** Games every listed model predicted pregame, with a result. */
export function commonGames(games: ScoredGame[], models: string[]): ScoredGame[] {
  if (!models.length) return [];
  return games.filter((g) => g.home_won != null
    && models.every((m) => g.predictions[m]?.pregame));
}

export function pairedDelta(
  games: ScoredGame[], model: string, reference: string, reps = BOOT_REPS,
): PairedDelta {
  const gain: number[] = []; const blocks: string[] = [];
  for (const g of commonGames(games, [model, reference])) {
    const y = g.home_won as number;
    const pm = clamp(g.predictions[model]!.home_win_probability);
    const pr = clamp(g.predictions[reference]!.home_win_probability);
    const lm = y === 1 ? -Math.log(pm) : -Math.log(1 - pm);
    const lr = y === 1 ? -Math.log(pr) : -Math.log(1 - pr);
    gain.push(lr - lm);
    blocks.push(g.block);
  }
  if (!gain.length) {
    return { model, reference, n: 0, log_loss_gain: null, p_better: null };
  }
  const d = blockBootstrap(blocks, { g: gain }, reps).g;
  return {
    model,
    reference,
    n: gain.length,
    log_loss_gain: interval(gain, d),
    p_better: round(d.filter((x) => x > 0).length / d.length, 3),
  };
}

/**
 * The full scoreboard.
 *
 *   per_model     every pregame prediction each model has — largest samples, but on
 *                 different games, so not a fair ranking on its own
 *   head_to_head  only games every model with any scored game predicted pregame
 *
 * Models with no scored game are left out of the head-to-head, otherwise one
 * not-yet-deployed shadow would empty it.
 */
export function buildModelScoreboard(
  games: ScoredGame[], models: string[], reference: string | null, reps = BOOT_REPS,
) {
  const per_model = models.map((m) => scoreModel(games, m, reps));
  const compared = per_model.filter((s) => s.n > 0).map((s) => s.model);
  const common = commonGames(games, compared);
  const ref = reference && compared.includes(reference) ? reference : (compared[0] ?? null);
  return {
    per_model,
    head_to_head: {
      models: compared,
      reference: ref,
      games: common.length,
      small_sample: common.length < SMALL_SAMPLE,
      rows: compared.map((m) => scoreModel(common, m, reps)),
      deltas: ref ? compared.filter((m) => m !== ref).map((m) => pairedDelta(common, m, ref, reps)) : [],
    },
    calibration: Object.fromEntries(models.map((m) => [m, calibrationBins(games, m)])),
    small_sample_threshold: SMALL_SAMPLE,
  };
}

/**
 * How much the models disagree on one game: the range of their pregame home-win
 * probabilities, and whether they pick different winners. The page highlights these.
 */
export function disagreement(predictions: Record<string, ModelPick | null | undefined>) {
  const ps = Object.values(predictions)
    .filter((p): p is ModelPick => Boolean(p && p.pregame))
    .map((p) => p.home_win_probability);
  if (ps.length < 2) return { range: null, split_pick: false, models: ps.length };
  const range = Math.max(...ps) - Math.min(...ps);
  const home = ps.filter((p) => p > 0.5).length;
  return {
    range: round(range, 4),
    split_pick: home > 0 && home < ps.length,
    models: ps.length,
  };
}
