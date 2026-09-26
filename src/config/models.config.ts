/**
 * The model registry behind /api/models/:sport/compare — every serious model, per sport,
 * and where its pregame predictions live.
 *
 * Roles, which the page uses to frame each model honestly:
 *   production  what the live site serves
 *   shadow      written alongside production, never served; an experiment
 *   benchmark   the betting market: the bar to beat, not a model of ours
 *   reference   someone else's model (ESPN FPI) or a component (Elo): context, not a target
 *
 * Status, orthogonal to role:
 *   planned        listed, never queried (no writer yet)
 *   backtestOnly   no live source at all; the page shows its research backtest only
 *
 * Every live source is read through one contract (see modelSql in the controller):
 *   game id, home_win_probability, optional margin / total, predicted_at.
 * The controller keeps the latest row per game written strictly BEFORE the start;
 * anything written at or after it is shown flagged and never scored.
 *
 * EXTENSION POINT: a new model is one entry here plus a card in the frontend's
 * config/modelRegistry.js. A shadow table that has not been created yet costs nothing:
 * it comes back available:false with a note.
 */

export type ModelRole = 'production' | 'shadow' | 'benchmark' | 'reference';

export interface ModelSource {
  key: string;
  label: string;
  role: ModelRole;
  /** Table in the sport's season dataset. */
  table?: string;
  /** Column holding the home-win probability (default home_win_probability). */
  probColumn?: string;
  /** SQL expression for the predicted home margin, if the model has one. */
  marginExpr?: string;
  /** SQL expression for the predicted total, if the model has one. */
  totalExpr?: string;
  planned?: boolean;
  backtestOnly?: boolean;
  /** Shown with the model when it has no live rows. */
  note?: string;
  /** SQL expressions for predicted home / away score, where the model has them. */
  homeScoreExpr?: string;
  awayScoreExpr?: string;
  /**
   * Unified slate (/api/predictions/:sport/slate): what the model produces, a Learn page,
   * and whether its full distributions live in the sport's game_sim_distributions.
   */
  outputs?: string[];
  learn?: string | null;
  simDistributions?: boolean;
  /** Player projections live in player_sim_projections (MLB PA simulator). */
  hasPlayers?: boolean;
}

export const MLB_DATASET = process.env.MLB_2026_DATASET || 'mlb_2026_season';

export const MLB_MODELS: ModelSource[] = [
  {
    key: 'v10',
    label: 'V10 (production)',
    role: 'production',
    table: 'game_predictions',
    outputs: ['win_prob'],
    learn: '/learn/mlb-v10-features.html',
  },
  {
    key: 'logit3',
    label: '3-feature logistic',
    role: 'shadow',
    table: 'game_predictions_logit3',
    outputs: ['win_prob'],
    learn: '/learn/model-history.html',
  },
  {
    key: 'sim_blend',
    label: 'PA sim + strength blend',
    role: 'shadow',
    table: 'game_predictions_sim_blend',
    // Raw simulator totals run hot (+0.2 to +0.8 runs a game in 2022-26); the total is
    // scored so that shows, not hidden.
    totalExpr: 'mean_home_runs + mean_away_runs',
    marginExpr: 'mean_home_runs - mean_away_runs',
    homeScoreExpr: 'mean_home_runs',
    awayScoreExpr: 'mean_away_runs',
    outputs: ['win_prob', 'score', 'total', 'margin', 'dist', 'players'],
    learn: '/learn/mlb-pa-simulator.html',
    simDistributions: true,
    hasPlayers: true,
  },
  {
    key: 'elo',
    label: 'Elo',
    role: 'reference',
    // The production pipeline's own Elo, stored on the same pregame row as V10.
    table: 'game_predictions',
    probColumn: 'elo_home_win_prob',
    outputs: ['win_prob'],
    learn: '/learn/power-rankings.html',
  },
  {
    key: 'market',
    label: 'Betting market',
    role: 'benchmark',
    backtestOnly: true,
    outputs: [],
    learn: null,
    note: 'Live MLB odds are not collected yet. Stored closing lines cover 2012-2021, so '
      + 'the market is scored in the backtest only.',
  },
];

export const FOOTBALL_MODELS: Record<string, ModelSource[]> = {
  nfl: [
    {
      key: 'market', label: 'Betting market', role: 'benchmark',
      outputs: ['win_prob', 'margin', 'total'], learn: null,
    },
    {
      key: 'ridge', label: 'Margin ridge', role: 'shadow',
      table: 'game_predictions_ridge_shadow', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'margin'], learn: '/learn/football-model-compare.html',
    },
    {
      key: 'xgb', label: 'XGBoost (production)', role: 'production', table: 'game_predictions',
      outputs: ['win_prob'], learn: '/learn/football-models.html',
    },
    {
      key: 'fpi', label: 'ESPN FPI', role: 'reference',
      table: 'fpi_game_predictions', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'margin'], learn: '/learn/football-model-compare.html',
    },
    {
      key: 'drive_sim', label: 'Drive simulator', role: 'shadow',
      table: 'game_predictions_drive_sim', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'score', 'total', 'margin', 'dist'],
      learn: '/learn/football-drive-sim.html',
      simDistributions: true,
      // planned/backtestOnly keep /api/models/nfl/compare from querying it; the unified
      // slate queries any model with a table and reports a missing one as available:false.
      planned: true, backtestOnly: true,
      note: 'Experimental shadow: ties the ridge on winners; its value is the score and '
        + 'margin distributions. Live from 2026 week 3.',
    },
  ],
  cfb: [
    {
      key: 'market', label: 'Betting market', role: 'benchmark',
      outputs: ['win_prob', 'margin', 'total'], learn: null,
    },
    {
      key: 'fpi', label: 'ESPN FPI', role: 'reference',
      table: 'fpi_game_predictions', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'margin'], learn: '/learn/football-model-compare.html',
    },
    {
      key: 'ridge', label: 'Margin ridge', role: 'shadow',
      table: 'game_predictions_ridge_shadow', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'margin'], learn: '/learn/football-model-compare.html',
    },
    {
      key: 'xgb', label: 'XGBoost (legacy production)', role: 'production',
      table: 'game_predictions',
      outputs: ['win_prob'], learn: '/learn/football-models.html',
    },
    {
      key: 'drive_sim', label: 'Drive simulator', role: 'shadow',
      table: 'game_predictions_drive_sim', marginExpr: 'predicted_home_margin',
      outputs: ['win_prob', 'score', 'total', 'margin', 'dist'],
      learn: '/learn/football-drive-sim.html',
      simDistributions: true,
      // Not yet scored by /api/models/cfb/compare; the unified slate shows it.
      planned: true, backtestOnly: true,
      note: 'Experimental shadow: loses to the ridge, FPI and the market on winners '
        + '(2025 holdout); its measured gain is the exact-margin shape. Live from 2026 week 4.',
    },
  ],
};

export function modelsForSport(sport: string): ModelSource[] | null {
  if (sport === 'mlb') return MLB_MODELS;
  return FOOTBALL_MODELS[sport] || null;
}

/** The model paired deltas are measured against: the market where it has live rows. */
export const REFERENCE_MODEL: Record<string, string[]> = {
  mlb: ['market', 'v10'],
  nfl: ['market', 'xgb'],
  cfb: ['market', 'xgb'],
};

/** MLB totals & props shadow table (written by the PA simulator). */
export const MLB_PROPS_TABLE = 'game_props_sim';
