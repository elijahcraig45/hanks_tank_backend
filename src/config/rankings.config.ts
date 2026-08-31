/**
 * Power-rankings registry.
 *
 * Ratings are produced by one sport-neutral Bradley-Terry fit (rankings/build.py in the
 * ML repo) and land in a `power_rankings` table per sport, all with the same schema. So
 * unlike predictions — where football and baseball have genuinely different columns —
 * one controller can serve every sport, and this table is the only thing that differs.
 */

export interface RankingSportConfig {
  key: string;
  label: string;
  datasetEnv: string;
  defaultDataset: string;
  table: string;
  /** Boards are split per division (college); others rank one pool. */
  divisions: string[];
  /** Rendered as the method note so each sport can be honest about its own limits. */
  note?: string;
}

export const RANKING_SPORTS: Record<string, RankingSportConfig> = {
  nfl: {
    key: 'nfl',
    label: 'NFL',
    datasetEnv: 'NFL_DATASET',
    defaultDataset: 'nfl_season',
    table: 'power_rankings',
    divisions: [],
  },
  cfb: {
    key: 'cfb',
    label: 'College Football',
    datasetEnv: 'CFB_DATASET',
    defaultDataset: 'cfb_season',
    table: 'power_rankings',
    divisions: ['fbs', 'fcs'],
    note: 'FBS and FCS are fitted together so the two ladders stay comparable; '
      + 'ranks are numbered within a board and overall_rank spans both.',
  },
  mlb: {
    key: 'mlb',
    label: 'MLB',
    datasetEnv: 'MLB_RANKINGS_DATASET',
    defaultDataset: 'mlb_2026_season',
    table: 'power_rankings',
    divisions: [],
    // Stated because the number invites more confidence than it deserves: measured
    // walk-forward over 2023-2025, team strength moves baseball log loss from 0.6931
    // (a coin flip) only to 0.6808. The ordering is a fair summary of who has played
    // best; it is not a useful game predictor, and the rank ranges show why.
    note: 'Baseball separates far less than football — the rank range column is wide '
      + 'because the results genuinely do not distinguish these teams.',
  },
};

export function getRankingSport(key: string): RankingSportConfig | null {
  return RANKING_SPORTS[key?.toLowerCase()] || null;
}
