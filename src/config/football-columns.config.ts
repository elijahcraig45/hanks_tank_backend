/**
 * Column catalogs for the football stats endpoints.
 *
 * Separate from football.config.ts on purpose. That file answers "which tables does this
 * sport have", in about ninety lines. This one is presentation metadata — hundreds of
 * entries of label, grouping and formatting — and merging the two would bury the registry
 * in it.
 *
 * The catalog is what lets one endpoint serve two sports whose column sets have almost
 * nothing in common. Rather than reconciling ESPN's 154 college columns with nflverse's
 * 136 NFL ones, each response carries `meta.columns` describing exactly the columns in
 * `data`, and the client renders headers, number formats and good/bad colouring from
 * that. RankingsBoard already works this way: it drops optional columns no row has a
 * value for.
 *
 * It doubles as the projection allow-list. `SELECT *` on a 154-column table is multi-MB
 * of JSON per request, so a caller gets `group=core` by default and has to name the
 * groups or fields it wants beyond that.
 */

/** How the client should render a value. Not a width or a unit — just a number shape. */
export type ColumnFormat =
  | 'text'
  | 'integer'
  | 'decimal1'
  | 'decimal2'
  | 'decimal3'
  | 'percent'   // already 0-100 in the source
  | 'rate';     // 0-1, render as a percentage

export interface ColumnSpec {
  key: string;
  label: string;
  group: string;
  format: ColumnFormat;
  /** Absent where "better" is not meaningful — identity columns, volume counts. */
  higherIsBetter?: boolean;
  /** True for a column describing what opponents did, so the UI can flip its colouring. */
  opponent?: boolean;
}

export interface ColumnGroup {
  key: string;
  label: string;
}

export interface ColumnCatalog {
  /** Always projected, whatever groups are requested — the row's identity. */
  identity: string[];
  groups: ColumnGroup[];
  columns: ColumnSpec[];
}

const g = (key: string, label: string): ColumnGroup => ({ key, label });

/* ------------------------------------------------------------------------- *
 * CFB team season stats — ESPN, 154 columns, camelCase, `opp_` opponent split
 * ------------------------------------------------------------------------- */

/**
 * ESPN publishes each stat twice: the team's own production and what its opponents did
 * against it (split 900). The opponent half is the only defensive information the feed
 * carries, which is why it is kept rather than dropped — but it means "higher is better"
 * inverts for every `opp_` column, so `opponent: true` marks them for the client.
 */
const CFB_OWN: Array<[string, string, string, ColumnFormat, boolean?]> = [
  // core
  ['gamesPlayed', 'G', 'core', 'integer'],
  ['totalPointsPerGame', 'PPG', 'core', 'decimal1', true],
  ['totalPoints', 'Pts', 'core', 'integer', true],
  ['yardsPerGame', 'Yds/G', 'core', 'decimal1', true],
  ['totalYards', 'Total Yds', 'core', 'integer', true],
  ['firstDowns', '1st Downs', 'core', 'integer', true],
  // passing
  ['passingYards', 'Pass Yds', 'passing', 'integer', true],
  ['passingYardsPerGame', 'Pass Yds/G', 'passing', 'decimal1', true],
  ['passingTouchdowns', 'Pass TD', 'passing', 'integer', true],
  ['completions', 'Cmp', 'passing', 'integer'],
  ['passingAttempts', 'Att', 'passing', 'integer'],
  ['completionPct', 'Cmp%', 'passing', 'percent', true],
  ['yardsPerPassAttempt', 'Y/A', 'passing', 'decimal2', true],
  ['QBRating', 'QB Rtg', 'passing', 'decimal1', true],
  ['interceptions', 'INT', 'passing', 'integer', false],
  ['sacks', 'Sacks Allowed', 'passing', 'integer', false],
  ['sackYardsLost', 'Sack Yds', 'passing', 'integer', false],
  ['longPassing', 'Long Pass', 'passing', 'integer'],
  ['firstDownsPassing', '1st Pass', 'passing', 'integer', true],
  // rushing
  ['rushingYards', 'Rush Yds', 'rushing', 'integer', true],
  ['rushingYardsPerGame', 'Rush Yds/G', 'rushing', 'decimal1', true],
  ['rushingTouchdowns', 'Rush TD', 'rushing', 'integer', true],
  ['rushingAttempts', 'Carries', 'rushing', 'integer'],
  ['yardsPerRushAttempt', 'Y/C', 'rushing', 'decimal2', true],
  ['longRushing', 'Long Rush', 'rushing', 'integer'],
  ['rushingFumbles', 'Rush Fum', 'rushing', 'integer', false],
  ['firstDownsRushing', '1st Rush', 'rushing', 'integer', true],
  // receiving
  ['receptions', 'Rec', 'receiving', 'integer'],
  ['receivingYards', 'Rec Yds', 'receiving', 'integer', true],
  ['receivingYardsPerGame', 'Rec Yds/G', 'receiving', 'decimal1', true],
  ['receivingTouchdowns', 'Rec TD', 'receiving', 'integer', true],
  ['yardsPerReception', 'Y/R', 'receiving', 'decimal2', true],
  ['longReception', 'Long Rec', 'receiving', 'integer'],
  // efficiency
  ['thirdDownConvPct', '3rd Down %', 'efficiency', 'percent', true],
  ['thirdDownConvs', '3rd Conv', 'efficiency', 'integer', true],
  ['thirdDownAttempts', '3rd Att', 'efficiency', 'integer'],
  ['fourthDownConvPct', '4th Down %', 'efficiency', 'percent', true],
  ['fourthDownConvs', '4th Conv', 'efficiency', 'integer', true],
  ['fourthDownAttempts', '4th Att', 'efficiency', 'integer'],
  ['fumblesRecovered', 'Fum Rec', 'efficiency', 'integer', true],
  ['totalPenalties', 'Penalties', 'efficiency', 'integer', false],
  ['totalPenaltyYards', 'Pen Yds', 'efficiency', 'integer', false],
  ['firstDownsPenalty', '1st by Pen', 'efficiency', 'integer'],
  // kicking
  ['fieldGoalsMade', 'FG', 'kicking', 'integer', true],
  ['fieldGoalAttempts', 'FGA', 'kicking', 'integer'],
  ['fieldGoalPct', 'FG%', 'kicking', 'percent', true],
  ['longFieldGoalMade', 'Long FG', 'kicking', 'integer', true],
  ['extraPointsMade', 'XP', 'kicking', 'integer', true],
  ['extraPointAttempts', 'XPA', 'kicking', 'integer'],
  ['extraPointPct', 'XP%', 'kicking', 'percent', true],
  ['fieldGoalsMade1_19', 'FG 1-19', 'kicking', 'integer', true],
  ['fieldGoalsMade20_29', 'FG 20-29', 'kicking', 'integer', true],
  ['fieldGoalsMade30_39', 'FG 30-39', 'kicking', 'integer', true],
  ['fieldGoalsMade40_49', 'FG 40-49', 'kicking', 'integer', true],
  ['fieldGoalsMade50', 'FG 50+', 'kicking', 'integer', true],
  ['fieldGoalAttempts1_19', 'FGA 1-19', 'kicking', 'integer'],
  ['fieldGoalAttempts20_29', 'FGA 20-29', 'kicking', 'integer'],
  ['fieldGoalAttempts30_39', 'FGA 30-39', 'kicking', 'integer'],
  ['fieldGoalAttempts40_49', 'FGA 40-49', 'kicking', 'integer'],
  ['fieldGoalAttempts50', 'FGA 50+', 'kicking', 'integer'],
  // returns
  ['kickReturns', 'KR', 'returns', 'integer'],
  ['kickReturnYards', 'KR Yds', 'returns', 'integer', true],
  ['yardsPerKickReturn', 'KR Avg', 'returns', 'decimal2', true],
  ['longKickReturn', 'Long KR', 'returns', 'integer'],
  ['kickReturnTouchdowns', 'KR TD', 'returns', 'integer', true],
  ['puntReturns', 'PR', 'returns', 'integer'],
  ['puntReturnYards', 'PR Yds', 'returns', 'integer', true],
  ['yardsPerPuntReturn', 'PR Avg', 'returns', 'decimal2', true],
  ['longPuntReturn', 'Long PR', 'returns', 'integer'],
  ['puntReturnTouchdowns', 'PR TD', 'returns', 'integer', true],
  // punting
  ['punts', 'Punts', 'punting', 'integer'],
  ['puntYards', 'Punt Yds', 'punting', 'integer'],
  ['grossAvgPuntYards', 'Gross Avg', 'punting', 'decimal2', true],
  ['netAvgPuntYards', 'Net Avg', 'punting', 'decimal2', true],
  ['longPunt', 'Long Punt', 'punting', 'integer'],
];

/** Opponent-split labels that read as defense rather than as "their offense". */
const CFB_OPP_LABELS: Record<string, string> = {
  opp_totalPointsPerGame: 'PPG Allowed',
  opp_totalPoints: 'Pts Allowed',
  opp_yardsPerGame: 'Yds/G Allowed',
  opp_totalYards: 'Total Yds Allowed',
  opp_passingYards: 'Pass Yds Allowed',
  opp_passingYardsPerGame: 'Pass Yds/G Allowed',
  opp_rushingYards: 'Rush Yds Allowed',
  opp_rushingYardsPerGame: 'Rush Yds/G Allowed',
  opp_firstDowns: '1st Downs Allowed',
  opp_thirdDownConvPct: '3rd Down % Allowed',
  opp_interceptions: 'INT Forced',
  opp_sacks: 'Sacks Made',
  opp_completionPct: 'Cmp% Allowed',
  opp_QBRating: 'QB Rtg Allowed',
  opp_gamesPlayed: 'Opp G',
  opp_fumblesRecovered: 'Fum Lost',
  opp_totalPenalties: 'Opp Penalties',
  opp_totalPenaltyYards: 'Opp Pen Yds',
};

function cfbSeasonCatalog(): ColumnCatalog {
  // espn_team_id is the table's 154th column and is deliberately absent: it is an
  // internal join key, not a stat, and nothing should be sorting or displaying it.
  const columns: ColumnSpec[] = [
    { key: 'season', label: 'Season', group: 'core', format: 'integer' },
    { key: 'team', label: 'Team', group: 'core', format: 'text' },
    { key: 'team_abbr', label: 'Abbr', group: 'core', format: 'text' },
  ];

  for (const [key, label, group, format, higherIsBetter] of CFB_OWN) {
    columns.push({ key, label, group, format, higherIsBetter });
  }

  // The opponent split mirrors the own-production columns exactly, so it is derived
  // rather than retyped — 75 hand-copied rows is 75 chances to typo a key.
  for (const [key, label, group, format, higherIsBetter] of CFB_OWN) {
    const oppKey = `opp_${key}`;
    columns.push({
      key: oppKey,
      label: CFB_OPP_LABELS[oppKey] || `${label} Allowed`,
      group: 'defense',
      format,
      // What the opponent did: if more of it is good for them, it is bad for us.
      higherIsBetter:
        higherIsBetter === undefined ? undefined : !higherIsBetter,
      opponent: true,
    });
  }

  return {
    identity: ['season', 'team', 'team_abbr'],
    groups: [
      g('core', 'Overview'),
      g('passing', 'Passing'),
      g('rushing', 'Rushing'),
      g('receiving', 'Receiving'),
      g('efficiency', 'Efficiency & Penalties'),
      g('kicking', 'Kicking'),
      g('returns', 'Returns'),
      g('punting', 'Punting'),
      g('defense', 'Opponent (Defense)'),
    ],
    columns,
  };
}

/* ------------------------------------------------------------------------- *
 * NFL per-team, per-week EPA — nfl_historical.team_week_epa, 17 columns
 * ------------------------------------------------------------------------- */

const NFL_WEEK_EPA: ColumnSpec[] = [
  { key: 'season', label: 'Season', group: 'core', format: 'integer' },
  { key: 'week', label: 'Wk', group: 'core', format: 'integer' },
  { key: 'team', label: 'Team', group: 'core', format: 'text' },
  { key: 'off_epa_play', label: 'Off EPA', group: 'offense', format: 'decimal3', higherIsBetter: true },
  { key: 'off_pass_epa', label: 'Off Pass EPA', group: 'offense', format: 'decimal3', higherIsBetter: true },
  { key: 'off_rush_epa', label: 'Off Rush EPA', group: 'offense', format: 'decimal3', higherIsBetter: true },
  { key: 'off_success_rate', label: 'Off SR', group: 'offense', format: 'rate', higherIsBetter: true },
  { key: 'off_explosive_rate', label: 'Off Explosive', group: 'offense', format: 'rate', higherIsBetter: true },
  { key: 'off_turnovers', label: 'Turnovers', group: 'offense', format: 'integer', higherIsBetter: false },
  { key: 'off_plays', label: 'Off Plays', group: 'offense', format: 'integer' },
  // Defensive EPA is negative-is-better: it is the EPA the defense allowed.
  { key: 'def_epa_play', label: 'Def EPA', group: 'defense', format: 'decimal3', higherIsBetter: false },
  { key: 'def_pass_epa', label: 'Def Pass EPA', group: 'defense', format: 'decimal3', higherIsBetter: false },
  { key: 'def_rush_epa', label: 'Def Rush EPA', group: 'defense', format: 'decimal3', higherIsBetter: false },
  { key: 'def_success_rate', label: 'Def SR', group: 'defense', format: 'rate', higherIsBetter: false },
  { key: 'def_explosive_rate', label: 'Def Explosive', group: 'defense', format: 'rate', higherIsBetter: false },
  { key: 'def_takeaways', label: 'Takeaways', group: 'defense', format: 'integer', higherIsBetter: true },
  { key: 'def_plays', label: 'Def Plays', group: 'defense', format: 'integer' },
];

/* ------------------------------------------------------------------------- */

export const COLUMN_CATALOGS: Record<string, ColumnCatalog> = {
  cfb_team_season: cfbSeasonCatalog(),
  nfl_team_week: {
    identity: ['season', 'week', 'team'],
    groups: [g('core', 'Overview'), g('offense', 'Offense'), g('defense', 'Defense')],
    columns: NFL_WEEK_EPA,
  },
};

export function getColumnCatalog(name: string | null): ColumnCatalog | null {
  if (!name) return null;
  return COLUMN_CATALOGS[name] || null;
}

/**
 * Resolve a `group`/`fields` request into the columns to project.
 *
 * Identity columns are always included, so a row is never returned without enough of it
 * to identify what it describes. Unknown group and field names are reported back rather
 * than ignored — silently returning the default set for a typo'd `fields` is how a
 * caller ends up believing a column does not exist.
 */
export function resolveColumns(
  catalog: ColumnCatalog,
  opts: { fields?: string; group?: string },
): { columns: ColumnSpec[]; unknown: string[] } {
  const byKey = new Map(catalog.columns.map((c) => [c.key, c]));
  const unknown: string[] = [];

  const requestedFields = (opts.fields || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (requestedFields.length) {
    const picked = new Map<string, ColumnSpec>();
    for (const key of catalog.identity) {
      const spec = byKey.get(key);
      if (spec) picked.set(key, spec);
    }
    for (const key of requestedFields) {
      const spec = byKey.get(key);
      if (!spec) { unknown.push(key); continue; }
      picked.set(key, spec);
    }
    return { columns: [...picked.values()], unknown };
  }

  const validGroups = new Set(catalog.groups.map((gr) => gr.key));
  let requestedGroups = (opts.group || 'core')
    .split(',').map((s) => s.trim()).filter(Boolean);

  for (const key of requestedGroups) {
    if (key !== 'all' && !validGroups.has(key)) unknown.push(key);
  }
  requestedGroups = requestedGroups.filter(
    (key) => key === 'all' || validGroups.has(key),
  );
  if (!requestedGroups.length) requestedGroups = ['core'];

  const wanted = new Set(requestedGroups);
  const columns = wanted.has('all')
    ? catalog.columns
    : catalog.columns.filter(
        (c) => wanted.has(c.group) || catalog.identity.includes(c.key),
      );

  return { columns, unknown };
}
