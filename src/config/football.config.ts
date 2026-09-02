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

/**
 * Canonical stat key -> the column that holds it in this sport's table.
 *
 * The two sports measure the same ideas with different names — the NFL table stores
 * per-play EPA, the college one stores PPA — so the alias happens once in SQL and the
 * client only ever sees the canonical name. Teaching the frontend two vocabularies was
 * the alternative, and it is how the college stats page stayed empty for months.
 */
export type StatsFieldMap = Record<string, string>;

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
  /** Canonical -> physical column names for the per-week table. */
  statsFieldMap?: StatsFieldMap;
  /** Catalog key for the per-player table. */
  playerColumnCatalog: string | null;
  /** Canonical -> physical column names for the per-player table. */
  playerFieldMap?: StatsFieldMap;
  /** Sortable player columns, allow-listed for the ORDER BY. */
  playerSortFields: string[];
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
  /**
   * Betting lines, joined on game_id to score the Vegas baseline.
   *
   * Null where the sport stores its spread on the prediction row instead — the NFL
   * pipeline writes spread_line directly, because nflverse supplies it with the
   * schedule. College needs a join because its lines come from a separate feed.
   */
  linesTable: string | null;
  linesDataset: DatasetKind;
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
    // Identity: the NFL table already uses the canonical names.
    statsFieldMap: Object.fromEntries(NFL_STAT_FIELDS.map((f) => [f, f])),
    playerColumnCatalog: 'nfl_player_season',
    // nflverse's own names, mapped onto the canonical keys the catalog declares.
    playerFieldMap: {
      player_name: 'player_display_name',
      team: 'recent_team',
      passing_yds: 'passing_yards',
      passing_td: 'passing_tds',
      passing_int: 'passing_interceptions',
      passing_att: 'attempts',
      passing_completions: 'completions',
      rushing_yds: 'rushing_yards',
      rushing_td: 'rushing_tds',
      rushing_car: 'carries',
      receiving_yds: 'receiving_yards',
      receiving_rec: 'receptions',
      receiving_td: 'receiving_tds',
      defensive_sacks: 'def_sacks',
      defensive_solo: 'def_tackles_solo',
      interceptions_int: 'def_interceptions',
      defensive_pd: 'def_pass_defended',
      kicking_fgm: 'fg_made',
      kicking_fga: 'fg_att',
    },
    playerSortFields: [
      'passing_yds', 'passing_td', 'passing_epa', 'passing_int',
      'passing_completions', 'passing_att', 'rushing_yds', 'rushing_td',
      'rushing_car', 'rushing_epa', 'receiving_yds', 'receiving_td',
      'receiving_rec', 'targets', 'receiving_epa', 'defensive_sacks',
      'defensive_solo', 'interceptions_int', 'defensive_pd', 'games',
    ],
    hasDivisions: false,
    sortableStatFields: NFL_STAT_FIELDS,
    // nflverse publishes a 136-column team-season table; not ingested yet.
    teamSeasonTable: null,
    teamSeasonDataset: 'season',
    teamSeasonColumnCatalog: null,
    // nflverse ships spread_line on the schedule, so it is already a column on
    // nfl_season.game_predictions and needs no join.
    linesTable: null,
    linesDataset: 'season',
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
    // Per-team, per-game advanced stats from CollegeFootballData. The college answer
    // to team_week_epa, and a richer one — PPA plus line yards, stuff rate, havoc and
    // the down splits. Aliased below onto the NFL table's canonical names.
    statsTable: 'team_game_advanced',
    statsDataset: 'season',
    statsColumnCatalog: 'cfb_team_game',
    statsFieldMap: {
      season: 'season', week: 'week', team: 'team', opponent: 'opponent',
      off_epa_play: 'ppa',
      off_success_rate: 'success_rate',
      off_explosive_rate: 'explosiveness',
      off_plays: 'plays',
      off_drives: 'drives',
      off_line_yards: 'line_yards',
      off_second_level_yards: 'second_level_yards',
      off_open_field_yards: 'open_field_yards',
      off_stuff_rate: 'stuff_rate',
      off_power_success: 'power_success',
      off_standard_downs_ppa: 'standard_downs_ppa',
      off_passing_downs_ppa: 'passing_downs_ppa',
      off_rushing_plays_ppa: 'rushing_plays_ppa',
      off_passing_plays_ppa: 'passing_plays_ppa',
      def_epa_play: 'opp_ppa',
      def_success_rate: 'opp_success_rate',
      def_explosive_rate: 'opp_explosiveness',
      def_line_yards: 'opp_line_yards',
      def_stuff_rate: 'opp_stuff_rate',
      def_plays: 'opp_plays',
    },
    playerColumnCatalog: 'cfb_player_season',
    playerFieldMap: { player_name: 'player_name', team: 'team' },
    playerSortFields: [
      'passing_yds', 'passing_td', 'passing_att', 'passing_ypa', 'passing_pct',
      'rushing_yds', 'rushing_td', 'rushing_car', 'rushing_ypc',
      'receiving_yds', 'receiving_rec', 'receiving_td', 'receiving_ypr',
      'defensive_tot', 'defensive_solo', 'defensive_sacks', 'defensive_tfl',
      'interceptions_int', 'kicking_fgm', 'kicking_pts',
    ],
    hasDivisions: true,
    sortableStatFields: [
      'season', 'week', 'team', 'off_epa_play', 'def_epa_play',
      'off_success_rate', 'def_success_rate', 'off_explosive_rate',
      'def_explosive_rate', 'off_line_yards', 'off_stuff_rate',
      'off_power_success', 'off_plays', 'off_drives',
    ],
    teamSeasonTable: 'team_season_stats',
    teamSeasonDataset: 'season',
    teamSeasonColumnCatalog: 'cfb_team_season',
    teamSeasonCoverage: 'FBS only — the public feed does not publish an FCS season '
      + 'table, so FCS teams have no row here.',
    linesTable: 'betting_lines',
    linesDataset: 'season',
    // CFB has no team metadata table yet, so no logos or colours for college.
    teamsTable: null,
    teamsDataset: 'hist',
    playerTable: 'player_season_stats',
    leadersTable: 'stat_leaders',
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
