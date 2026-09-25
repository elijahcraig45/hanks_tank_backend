/**
 * The Models page's scoring rules, pinned: pregame-only, same-games head-to-head,
 * CIs that contain the point estimate and are deterministic, reliability bins that
 * add up, and a disagreement flag that means what it says.
 */

import {
  blockBootstrap, buildModelScoreboard, calibrationBins, commonGames, disagreement,
  pairedDelta, prng, scoreModel, ScoredGame, SMALL_SAMPLE,
} from '../utils/model-scoring';

const pick = (p: number, pregame = true, extra: any = {}) => ({
  home_win_probability: p, pregame, ...extra,
});

function games(n: number, over: (i: number) => Partial<ScoredGame> = () => ({})): ScoredGame[] {
  return Array.from({ length: n }, (_, i) => ({
    game_id: `g${i}`,
    block: `d${Math.floor(i / 5)}`,
    home_won: i % 3 === 0 ? 0 : 1,
    actual_home_margin: i % 3 === 0 ? -2 : 3,
    actual_total: 9,
    predictions: { a: pick(0.6), b: pick(0.55) },
    ...over(i),
  }));
}

describe('prng / blockBootstrap', () => {
  it('is deterministic for a seed', () => {
    const r1 = prng(7); const r2 = prng(7);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('keeps every draw inside the range of block means', () => {
    const blocks = ['a', 'a', 'b', 'b', 'c'];
    const d = blockBootstrap(blocks, { x: [1, 1, 0, 0, 1] }, 200).x;
    expect(d).toHaveLength(200);
    d.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); });
  });
});

describe('scoreModel', () => {
  it('scores only pregame predictions of decided games', () => {
    const g = games(10, (i) => ({
      home_won: i === 9 ? null : (i % 2),
      predictions: { a: pick(0.7, i !== 0) },
    }));
    const s = scoreModel(g, 'a', 200);
    // game 0 is post-start, game 9 is undecided
    expect(s.n).toBe(8);
    expect(s.small_sample).toBe(true);
    expect(s.log_loss!.lo).toBeLessThanOrEqual(s.log_loss!.value);
    expect(s.log_loss!.hi).toBeGreaterThanOrEqual(s.log_loss!.value);
  });

  it('computes log loss, accuracy and Brier exactly', () => {
    const g: ScoredGame[] = [
      { game_id: '1', block: 'x', home_won: 1, actual_home_margin: 1, actual_total: 5, predictions: { a: pick(0.8) } },
      { game_id: '2', block: 'y', home_won: 0, actual_home_margin: -1, actual_total: 5, predictions: { a: pick(0.4) } },
    ];
    const s = scoreModel(g, 'a', 50);
    expect(s.log_loss!.value).toBeCloseTo((-Math.log(0.8) - Math.log(0.6)) / 2, 5);
    expect(s.accuracy!.value).toBe(1);
    expect(s.brier!.value).toBeCloseTo((0.04 + 0.16) / 2, 5);
  });

  it('adds spread and total MAE only where the model has them', () => {
    const g = games(4, () => ({
      predictions: { a: pick(0.6, true, { predicted_home_margin: 1, predicted_total: 8 }) },
    }));
    const s = scoreModel(g, 'a', 50);
    expect(s.spread_n).toBe(4);
    expect(s.total_mae!.value).toBeCloseTo(1, 5);
    expect(scoreModel(games(4), 'a', 50).spread_mae).toBeNull();
  });

  it('flags small samples below the threshold only', () => {
    expect(scoreModel(games(SMALL_SAMPLE), 'a', 20).small_sample).toBe(false);
    expect(scoreModel(games(SMALL_SAMPLE - 1), 'a', 20).small_sample).toBe(true);
  });

  it('is empty, not broken, for a model with no rows', () => {
    const s = scoreModel(games(5), 'zzz', 20);
    expect(s.n).toBe(0);
    expect(s.log_loss).toBeNull();
  });
});

describe('calibrationBins', () => {
  it('uses quantile bins whose counts add up to n', () => {
    const g = games(95, (i) => ({ predictions: { a: pick(0.3 + (i / 95) * 0.4) } }));
    const bins = calibrationBins(g, 'a');
    expect(bins).toHaveLength(3); // 95 / 30
    expect(bins.reduce((s, b) => s + b.n, 0)).toBe(95);
    for (let i = 1; i < bins.length; i += 1) expect(bins[i].p).toBeGreaterThan(bins[i - 1].p);
    bins.forEach((b) => { expect(b.y_lo).toBeLessThanOrEqual(b.y); expect(b.y_hi).toBeGreaterThanOrEqual(b.y); });
  });

  it('ignores post-start rows', () => {
    const g = games(40, () => ({ predictions: { a: pick(0.6, false) } }));
    expect(calibrationBins(g, 'a')).toEqual([]);
  });
});

describe('head-to-head', () => {
  it('scores every model on the same games', () => {
    const g = games(20, (i) => ({
      predictions: { a: pick(0.6), b: i < 5 ? null : pick(0.55) },
    }));
    expect(commonGames(g, ['a', 'b'])).toHaveLength(15);
    const sb = buildModelScoreboard(g, ['a', 'b'], 'a', 50);
    expect(sb.per_model.find((r) => r.model === 'a')!.n).toBe(20);
    expect(sb.head_to_head.games).toBe(15);
    expect(sb.head_to_head.rows.every((r) => r.n === 15)).toBe(true);
    expect(sb.head_to_head.deltas).toHaveLength(1);
    expect(sb.head_to_head.deltas[0].reference).toBe('a');
  });

  it('leaves a model with no scored games out of the head-to-head', () => {
    const sb = buildModelScoreboard(games(10), ['a', 'b', 'shadow'], 'a', 20);
    expect(sb.head_to_head.models).toEqual(['a', 'b']);
    expect(sb.head_to_head.games).toBe(10);
  });

  it('falls back to the first scored model when the reference has no rows', () => {
    const sb = buildModelScoreboard(games(10), ['a', 'b'], 'market', 20);
    expect(sb.head_to_head.reference).toBe('a');
  });

  it('paired delta is positive when the model is better, with a sane P(better)', () => {
    const g = games(60, (i) => ({
      home_won: 1,
      block: `d${i}`,
      predictions: { good: pick(0.7), ref: pick(0.5) },
    }));
    const d = pairedDelta(g, 'good', 'ref', 200);
    expect(d.log_loss_gain!.value).toBeCloseTo(Math.log(0.7) - Math.log(0.5), 5);
    expect(d.p_better).toBe(1);
  });
});

describe('disagreement', () => {
  it('reports the probability range and split picks across pregame models', () => {
    const d = disagreement({ a: pick(0.62), b: pick(0.45), c: pick(0.9, false), d: null });
    expect(d.models).toBe(2);
    expect(d.range).toBeCloseTo(0.17, 4);
    expect(d.split_pick).toBe(true);
  });

  it('is empty with fewer than two pregame models', () => {
    expect(disagreement({ a: pick(0.6) })).toEqual({ range: null, split_pick: false, models: 1 });
  });
});
