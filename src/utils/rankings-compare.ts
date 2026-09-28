/**
 * "Why is A above B" for any two teams on a power-rankings board.
 *
 * Mirrors pair_explanation() in the ML repo (src/rankings/explain.py) field for
 * field, so an arbitrary pair reads the same as the adjacent pairs the ML job stores
 * in `vs_next`. Everything comes from the two rows' stored fields: rating, its
 * prior/current split, rank bands, schedule rank and the per-game list. Nothing is
 * refitted here.
 *
 * One difference from the stored pairs: the bootstrap replicates are not persisted,
 * so an arbitrary pair has no `p_order` unless it is adjacent (then the stored one is
 * reused). Without it, "tied" is decided from the rank bands: each team's point rank
 * inside the other's 5-95% band, and the text says the ranges overlap instead of quoting
 * a share it does not have.
 */

export interface RankingGame {
  opp: string;
  won?: boolean;
  pf?: number | null;
  pa?: number | null;
  margin?: number | null;
  over?: number | null;
  w?: number;
  l?: number;
  [key: string]: any;
}

export interface OpponentSummary {
  w: number;
  l: number;
  margin?: number | null;
  over: number | null;
  games: string[];
}

const TIE_ORDER_P = 0.75;

/**
 * How firmly one team sits above another, from p = the share of bootstrap resamples
 * rating it higher. Same table as ORDER_BANDS in the ML repo's explain.py; keep them
 * identical. Banded on the displayed whole percentage:
 *   under 60% "a coin flip"; 60-74% "a slight edge"; 75-89% "a clear edge";
 *   90%+ "separated". Symmetric around 50: 40% and under reads as the band of 100 - p
 *   plus "the other way", because the resamples can disagree with the point rank.
 */
const ORDER_BANDS: [number, string][] = [
  [90, 'separated'], [75, 'a clear edge'], [60, 'a slight edge'],
];
const ORDER_COIN_FLIP = 'a coin flip';

/** Percent rounded half up, matching _pct() in explain.py. */
const pct = (p: number): number => Math.round(p * 100);

export function orderLabel(p: number): string {
  const shown = pct(p);
  const stronger = Math.max(shown, 100 - shown);
  for (const [floor, label] of ORDER_BANDS) {
    if (stronger >= floor) return shown >= 50 ? label : `${label} the other way`;
  }
  return ORDER_COIN_FLIP;
}
const MAX_COMMON_LISTED = 6;

const round = (v: number | null | undefined, digits = 1): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Neutral-site win probability from two Elo-scale ratings (core.win_prob). */
export function winProb(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

function gameBrief(g: RankingGame, sport: string): string {
  if (sport === 'mlb') return `${g.w}-${g.l}`;
  if (g.pf != null && g.pa != null) return `${g.won ? 'W' : 'L'} ${g.pf}-${g.pa}`;
  return g.won ? 'W' : 'L';
}

export function opponentSummary(entries: RankingGame[], sport: string): OpponentSummary {
  if (sport === 'mlb') {
    const w = entries.reduce((s, e) => s + (e.w || 0), 0);
    const l = entries.reduce((s, e) => s + (e.l || 0), 0);
    return {
      w, l, over: round(entries.reduce((s, e) => s + (e.over || 0), 0), 2), games: [`${w}-${l}`],
    };
  }
  const w = entries.filter((e) => e.won).length;
  const margins = entries.map((e) => e.margin).filter((m): m is number => m != null);
  return {
    w,
    l: entries.length - w,
    margin: margins.length ? round(margins.reduce((s, m) => s + m, 0)) : null,
    over: round(entries.reduce((s, e) => s + (e.over || 0), 0)),
    games: entries.map((e) => gameBrief(e, sport)),
  };
}

function byOpponent(games: RankingGame[]): Map<string, RankingGame[]> {
  const out = new Map<string, RankingGame[]>();
  for (const g of games) {
    if (!out.has(g.opp)) out.set(g.opp, []);
    out.get(g.opp)!.push(g);
  }
  return out;
}

const within = (rank: number | null | undefined, band: (number | null)[]): boolean =>
  rank != null && band[0] != null && band[1] != null && rank >= band[0] && rank <= band[1];

const signed = (v: number | null): string =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

export function pairText(p: Record<string, any>, sport: string): string {
  const unit = p.gap_points != null
    ? `${p.gap.toFixed(1)} rating points (${p.gap_points.toFixed(1)} points of expected margin)`
    : `${p.gap.toFixed(1)} rating points`;
  const parts = [
    `${p.a} is ${unit} above ${p.b}; P(${p.a} wins at a neutral site) = `
      + `${pct(p.p_a_wins_neutral)}%`,
  ];
  if (p.gap_from_prior != null && p.gap_from_current != null) {
    parts.push(`${signed(p.gap_from_prior)} of the gap comes from last season's games `
      + `and ${signed(p.gap_from_current)} from this season's`);
  }
  if (p.h2h) {
    parts.push(`head to head ${p.a} went ${p.h2h.w}-${p.h2h.l}`
      + (sport !== 'mlb' ? ` (${p.h2h.games.join(', ')})` : ''));
  } else {
    parts.push('they have not played each other this season');
  }
  const common = p.common || [];
  const totals = p.common_totals || {};
  if (common.length && sport !== 'mlb' && common.length <= 3) {
    parts.push('common opponents: ' + common.map((c: any) =>
      `${c.opp}: ${p.a} ${c.a.games.join(', ')}, ${p.b} ${c.b.games.join(', ')}`).join('; '));
  } else if (totals.n) {
    parts.push(`against ${totals.n} common opponents ${p.a} went ${totals.a_w}-${totals.a_l} `
      + `and ${p.b} ${totals.b_w}-${totals.b_l}`);
  }
  let text = `${parts.join('; ')}.`;
  if (p.p_order != null) {
    text += ` ${p.a} ranks ahead of ${p.b} in ${pct(p.p_order)}% of resamples `
      + `(${orderLabel(p.p_order)}).`;
  } else if (p.tied) {
    // Non-adjacent pair: no stored resample share, so say only what the bands show.
    text += ' Their rank ranges overlap: each rank sits inside the other\'s 5-95% range.';
  }
  return text;
}

/**
 * Compare two board rows (as served, i.e. with `games` and `why` already parsed).
 * The higher-rated team is always `a`, so the explanation reads "why A is above B".
 */
export function comparePair(
  x: Record<string, any>, y: Record<string, any>, sport: string
): Record<string, any> {
  const [a, b] = (x.rating ?? 0) >= (y.rating ?? 0) ? [x, y] : [y, x];
  const gap = a.rating - b.rating;
  const pointsPerRating = a.why?.points_per_rating ?? b.why?.points_per_rating ?? null;

  // Adjacent on the same board: reuse the stored pair, which has the bootstrap order.
  const stored = a.vs_next && a.vs_next.b === b.team ? a.vs_next : null;
  const pOrder: number | null = stored?.p_order ?? null;
  const sameBoard = (a.division ?? null) === (b.division ?? null);
  const aBand = [a.rank_p05 ?? null, a.rank_p95 ?? null];
  const bBand = [b.rank_p05 ?? null, b.rank_p95 ?? null];
  const tied = pOrder != null
    ? pOrder < TIE_ORDER_P
    : sameBoard && within(a.rank, bBand) && within(b.rank, aBand);

  const diff = (k: string) => (a[k] != null && b[k] != null ? round(a[k] - b[k]) : null);
  const out: Record<string, any> = {
    a: a.team, b: b.team, a_rank: a.rank, b_rank: b.rank,
    a_division: a.division ?? null, b_division: b.division ?? null,
    gap: round(gap),
    gap_points: pointsPerRating ? round(gap * pointsPerRating) : null,
    p_a_wins_neutral: round(winProb(a.rating, b.rating), 3),
    p_order: pOrder,
    tied,
    order_label: pOrder != null ? orderLabel(pOrder) : null,
    tie_basis: pOrder != null ? 'bootstrap_order' : (sameBoard ? 'rank_bands' : null),
    gap_from_prior: diff('rating_from_prior'),
    gap_from_current: diff('rating_from_current'),
    a_band: aBand,
    b_band: bBand,
    a_sched_rank: a.sched_rank ?? null,
    b_sched_rank: b.sched_rank ?? null,
  };

  const aOpp = byOpponent(a.games || []);
  const bOpp = byOpponent(b.games || []);
  out.h2h = aOpp.has(b.team) ? opponentSummary(aOpp.get(b.team)!, sport) : null;
  const common = [...aOpp.keys()]
    .filter((o) => bOpp.has(o) && o !== a.team && o !== b.team)
    .map((o) => ({
      opp: o,
      a: opponentSummary(aOpp.get(o)!, sport),
      b: opponentSummary(bOpp.get(o)!, sport),
    }));
  out.common_totals = {
    n: common.length,
    a_w: common.reduce((s, c) => s + c.a.w, 0),
    a_l: common.reduce((s, c) => s + c.a.l, 0),
    b_w: common.reduce((s, c) => s + c.b.w, 0),
    b_l: common.reduce((s, c) => s + c.b.l, 0),
    a_over: round(common.reduce((s, c) => s + (c.a.over || 0), 0), 2),
    b_over: round(common.reduce((s, c) => s + (c.b.over || 0), 0), 2),
  };
  out.common = common.length <= MAX_COMMON_LISTED ? common : [];
  out.text = pairText(out, sport);
  return out;
}
