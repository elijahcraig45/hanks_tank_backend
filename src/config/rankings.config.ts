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
  /**
   * Our own orderings the board can show beside the rating, each a column on the board
   * row. Which of them (at most three) the site draws is a control-plane setting
   * (`rankings_show`); see mllab docs/MODEL_CONTROL.md.
   */
  customRankers: CustomRanker[];
  /** Media polls, each one or more board columns (`rankings_media`). */
  mediaPolls: MediaPoll[];
}

export interface CustomRanker {
  key: string;
  column: string;
  label: string;
}

export interface MediaPoll {
  key: string;
  columns: string[];
}

export const RANKING_SPORTS: Record<string, RankingSportConfig> = {
  nfl: {
    key: 'nfl',
    label: 'NFL',
    datasetEnv: 'NFL_DATASET',
    defaultDataset: 'nfl_season',
    table: 'power_rankings',
    divisions: [],
    customRankers: [],
    mediaPolls: [],
  },
  cfb: {
    key: 'cfb',
    label: 'College Football',
    datasetEnv: 'CFB_DATASET',
    defaultDataset: 'cfb_season',
    table: 'power_rankings',
    divisions: ['fbs', 'fcs'],
    customRankers: [
      { key: 'results', column: 'results_rank', label: 'Results' },
      { key: 'season', column: 'season_rank', label: 'This season' },
      { key: 'forecast', column: 'forecast_rank', label: 'Forecast' },
      { key: 'resume', column: 'resume_rank', label: 'Resume' },
    ],
    mediaPolls: [
      { key: 'ap', columns: ['ap_rank'] },
      { key: 'coaches', columns: ['coaches_rank', 'fcs_coaches_rank'] },
    ],
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
    customRankers: [],
    mediaPolls: [],
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
