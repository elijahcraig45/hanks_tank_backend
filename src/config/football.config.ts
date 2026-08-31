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
  /** Per-team SEASON totals, including opponent splits (college only). */
  teamSeasonTable: string | null;
  /** Full per-player season table. NFL only — see playerNote for why. */
  playerTable: string | null;
  /** League leaders, long-form: one row per (category, rank). */
  leadersTable: string | null;
  /** Shown in place of a player search the sport cannot support. */
  playerNote?: string;
  sortableSeasonFields?: string[];
  /** CFB splits FBS/FCS via a division column; NFL has no such split. */
  hasDivisions: boolean;
  sortableStatFields: string[];
  /**
   * Bradley-Terry power rankings. Every sport now has a board; rankings themselves are
   * served by rankings.controller, so this only records that the sport has one.
   */
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
    teamSeasonTable: null,
    playerTable: 'player_season_stats',
    leadersTable: 'stat_leaders',
    rankingsTable: 'power_rankings',
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
    teamSeasonTable: 'team_season_stats',
    playerTable: null,
    leadersTable: 'stat_leaders',
    // No public ESPN endpoint returns a full college per-player season table: the
    // sortable athlete endpoint returns "-" for the very stat it sorts on, and passing
    // an explicit category 400s. Leaders are what the feed can actually support.
    playerNote: 'College player stats are limited to league leaders — the public feed '
      + 'does not publish a full per-player season table.',
    sortableSeasonFields: [
      'totalPointsPerGame', 'totalYards', 'passingYards', 'rushingYards',
      'yardsPerGame', 'completionPct', 'opp_totalPointsPerGame', 'opp_totalYards',
    ],
    rankingsTable: 'power_rankings',
  },
};

export function getFootballSport(key: string): FootballSportConfig | null {
  return FOOTBALL_SPORTS[key?.toLowerCase()] || null;
}
