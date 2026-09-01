/**
 * Football sport registry.
 *
 * NFL and CFB share a prediction schema and query shape, so one controller serves both
 * off this table rather than two near-identical controllers. MLB deliberately stays
 * separate — its predictions table carries ~90 baseball-specific columns and lineup
 * joins that have no football analogue.
 *
 * A null table field means the sport structurally cannot answer that resource, and the
 * handler says so with a note instead of an error. That is different from a table that
 * is configured but not built yet, which surfaces as a caught missing-table. Keeping the
 * two distinguishable is why the fields are nullable rather than absent.
 */

/**
 * Which dataset a table lives in. Not derivable per sport: NFL's per-week stats are in
 * the historical dataset while CFB's season totals are in the season dataset, so a
 * handler cannot assume one dataset per resource kind.
 */
export type DatasetKind = 'season' | 'hist';

export interface FootballSportConfig {
  key: string;
  label: string;
  seasonDataset: string;
  histDataset: string;
  predictionsTable: string;
  gamesTable: string;
  /** Per-team, per-week advanced stats. NFL has EPA; CFB gets a PPA equivalent later. */
  statsTable: string | null;
  statsDataset: DatasetKind;
  /** Catalog key in football-columns.config for the per-week table. */
  statsColumnCatalog: string | null;
  /** Per-team SEASON totals, including opponent splits (college only for now). */
  teamSeasonTable: string | null;
  teamSeasonDataset: DatasetKind;
  /** Catalog key in football-columns.config for the season table. */
  teamSeasonColumnCatalog: string | null;
  /**
   * Stated where a sport's season table does not cover the whole league, so the UI can
   * say which teams are missing rather than showing an unexplained short table.
   */
  teamSeasonCoverage?: string;
  /** Team metadata: abbreviations, colours, logos. */
  teamsTable: string | null;
  teamsDataset: DatasetKind;
  /** Full per-player season table. NFL only for now. */
  playerTable: string | null;
  /** League leaders, long-form: one row per (category, rank). */
  leadersTable: string | null;
  /** Shown in place of a player search the sport cannot support. */
  playerNote?: string;
  sortableSeasonFields?: string[];
  /** CFB splits FBS/FCS via a division column; NFL has no such split. */
  hasDivisions: boolean;
  sortableStatFields: string[];
}

const NFL_STAT_FIELDS = [
  'season', 'week', 'team', 'off_epa_play', 'def_epa_play', 'off_pass_epa',
  'off_rush_epa', 'def_pass_epa', 'def_rush_epa', 'off_success_rate',
  'def_success_rate', 'off_explosive_rate', 'def_explosive_rate',
  'off_turnovers', 'def_takeaways', 'off_plays', 'def_plays',
];

/**
 * Sortable season columns. BigQuery cannot parameterize an ORDER BY identifier, so the
 * value from the query string is validated against this list and then interpolated.
 * Kept deliberately shorter than the 153-column catalog: these are the cuts anyone
 * actually sorts a league table by.
 */
const CFB_SEASON_SORT_FIELDS = [
  'totalPointsPerGame', 'totalPoints', 'yardsPerGame', 'totalYards', 'gamesPlayed',
  'passingYards', 'passingYardsPerGame', 'passingTouchdowns', 'completionPct',
  'yardsPerPassAttempt', 'QBRating',
  'rushingYards', 'rushingYardsPerGame', 'rushingTouchdowns', 'yardsPerRushAttempt',
  'receivingYards', 'receivingTouchdowns',
  'thirdDownConvPct', 'fourthDownConvPct', 'firstDowns',
  'totalPenalties', 'totalPenaltyYards',
  'fieldGoalPct', 'netAvgPuntYards',
  'opp_totalPointsPerGame', 'opp_totalPoints', 'opp_yardsPerGame', 'opp_totalYards',
  'opp_passingYards', 'opp_rushingYards', 'opp_thirdDownConvPct', 'opp_firstDowns',
  'opp_sacks', 'opp_interceptions',
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
    statsDataset: 'hist',
    statsColumnCatalog: 'nfl_team_week',
    hasDivisions: false,
    sortableStatFields: NFL_STAT_FIELDS,
    // nflverse publishes a 136-column team-season table; not ingested yet.
    teamSeasonTable: null,
    teamSeasonDataset: 'season',
    teamSeasonColumnCatalog: null,
    teamsTable: 'teams',
    teamsDataset: 'hist',
    playerTable: 'player_season_stats',
    leadersTable: 'stat_leaders',
  },
  cfb: {
    key: 'cfb',
    label: 'College Football',
    seasonDataset: process.env.CFB_DATASET || 'cfb_season',
    histDataset: process.env.CFB_HIST_DATASET || 'cfb_historical',
    predictionsTable: 'game_predictions',
    gamesTable: 'games',
    // No per-week feed yet: the college pipeline carries no play-by-play, so there is
    // no EPA equivalent of nfl_historical.team_week_epa.
    statsTable: null,
    statsDataset: 'hist',
    statsColumnCatalog: null,
    hasDivisions: true,
    sortableStatFields: [],
    teamSeasonTable: 'team_season_stats',
    teamSeasonDataset: 'season',
    teamSeasonColumnCatalog: 'cfb_team_season',
    teamSeasonCoverage: 'FBS only — the public feed does not publish an FCS season '
      + 'table, so FCS teams have no row here.',
    // CFB has no team metadata table yet, so no logos or colours for college.
    teamsTable: null,
    teamsDataset: 'hist',
    playerTable: null,
    leadersTable: 'stat_leaders',
    // No public ESPN endpoint returns a full college per-player season table: the
    // sortable athlete endpoint returns "-" for the very stat it sorts on, and passing
    // an explicit category 400s. Leaders are what the feed can actually support.
    playerNote: 'College player stats are limited to league leaders — the public feed '
      + 'does not publish a full per-player season table.',
    sortableSeasonFields: CFB_SEASON_SORT_FIELDS,
  },
};

export function getFootballSport(key: string): FootballSportConfig | null {
  return FOOTBALL_SPORTS[key?.toLowerCase()] || null;
}

/** Resolve a table's dataset name for a sport. */
export function datasetFor(sport: FootballSportConfig, kind: DatasetKind): string {
  return kind === 'season' ? sport.seasonDataset : sport.histDataset;
}
