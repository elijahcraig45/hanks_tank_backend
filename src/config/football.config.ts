/**
 * Football sport registry.
 *
 * NFL and CFB share a prediction schema and query shape, so one controller serves both
 * off this table rather than two near-identical controllers. MLB deliberately stays
 * separate — its predictions table carries ~90 baseball-specific columns and lineup
 * joins that have no football analogue.
 */

export interface FootballSportConfig {
  key: string;
  label: string;
  seasonDataset: string;
  histDataset: string;
  predictionsTable: string;
  gamesTable: string;
  /** Per-team, per-week advanced stats. NFL has EPA; CFB has none from the free feed. */
  statsTable: string | null;
  /** CFB splits FBS/FCS via a division column; NFL has no such split. */
  hasDivisions: boolean;
  sortableStatFields: string[];
  /** Bradley-Terry power rankings. CFB only so far. */
  rankingsTable: string | null;
}

const NFL_STAT_FIELDS = [
  'season', 'week', 'team', 'off_epa_play', 'def_epa_play', 'off_pass_epa',
  'off_rush_epa', 'def_pass_epa', 'def_rush_epa', 'off_success_rate',
  'def_success_rate', 'off_explosive_rate', 'def_explosive_rate',
  'off_turnovers', 'def_takeaways', 'off_plays', 'def_plays',
];

export const FOOTBALL_SPORTS: Record<string, FootballSportConfig> = {
  nfl: {
    key: 'nfl',
    label: 'NFL',
    seasonDataset: process.env.NFL_DATASET || 'nfl_season',
    histDataset: process.env.NFL_HIST_DATASET || 'nfl_historical',
    predictionsTable: 'game_predictions',
    gamesTable: 'games',
    statsTable: 'team_week_epa',
    hasDivisions: false,
    sortableStatFields: NFL_STAT_FIELDS,
    rankingsTable: null,
  },
  cfb: {
    key: 'cfb',
    label: 'College Football',
    seasonDataset: process.env.CFB_DATASET || 'cfb_season',
    histDataset: process.env.CFB_HIST_DATASET || 'cfb_historical',
    predictionsTable: 'game_predictions',
    gamesTable: 'games',
    statsTable: null,
    hasDivisions: true,
    sortableStatFields: [],
    rankingsTable: 'power_rankings',
  },
};

export function getFootballSport(key: string): FootballSportConfig | null {
  return FOOTBALL_SPORTS[key?.toLowerCase()] || null;
}
