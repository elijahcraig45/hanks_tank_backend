/**
 * The models on the football comparison page, and where each one's predictions live.
 *
 * Every model table shares one contract, which is what lets a single query shape read
 * them all:
 *
 *   game_id               the same key the production table uses
 *   season, week          for the season filter
 *   home_win_probability  0-1, home side
 *   predicted_home_margin points, + = home favoured (optional; see hasMargin)
 *   predicted_at          TIMESTAMP when the prediction was written
 *
 * Tables may hold several rows per game (re-runs, repeated snapshots). The comparison
 * keeps the latest row written strictly BEFORE kickoff; a row written at or after
 * kickoff is shown, flagged, and never scored.
 *
 * EXTENSION POINT: a new model is one entry here plus a description card in the
 * frontend's config/footballModels.js. The drive simulation being built alongside this
 * is pre-registered as `planned`: it is listed (so the page can say it is coming) but
 * not queried. When its writer lands, point `table` at it, drop `planned`, and it is
 * scored like everything else — no controller change.
 *
 * The betting market is not in this list: it has no predictions table. It is derived
 * from the lines already stored with each game (see marketProbability).
 */

export interface CompareModelSource {
  key: string;
  label: string;
  /** Table in the sport's season dataset. */
  table: string;
  /** Does the table carry predicted_home_margin? Spread MAE needs it. */
  hasMargin: boolean;
  /** Sports this model exists for. */
  sports: string[];
  /** Listed but not queried yet. */
  planned?: boolean;
}

export const COMPARE_MODELS: CompareModelSource[] = [
  {
    key: 'xgb',
    label: 'Production XGBoost',
    table: 'game_predictions',
    // A classifier: it predicts who wins, not by how much.
    hasMargin: false,
    sports: ['nfl', 'cfb'],
  },
  {
    key: 'ridge',
    label: 'Margin ridge (shadow)',
    table: 'game_predictions_ridge_shadow',
    hasMargin: true,
    sports: ['nfl', 'cfb'],
  },
  {
    key: 'fpi',
    label: 'ESPN FPI',
    table: 'fpi_game_predictions',
    hasMargin: true,
    sports: ['nfl', 'cfb'],
  },
  {
    key: 'drive_sim',
    label: 'Drive simulation',
    table: 'game_predictions_drive_sim',
    hasMargin: true,
    sports: ['nfl', 'cfb'],
    planned: true,
  },
];

/** The pseudo-model scored alongside the others, from each game's stored line. */
export const MARKET_KEY = 'market';

/**
 * Spread -> win probability, Phi(spread / sigma), used where no moneyline exists.
 *
 * NFL 13.45 is the value the ML repo's walk-forward evaluation uses for the same
 * conversion. CFB 15.5 is the margin ridge's college sigma, tuned on 2022 — not on any
 * game this page scores — and slightly under-confident for the market, so it flatters
 * the market a little less than a fitted value would.
 */
export const MARKET_SPREAD_SIGMA: Record<string, number> = { nfl: 13.45, cfb: 15.5 };

export function modelsFor(sport: string): CompareModelSource[] {
  return COMPARE_MODELS.filter((m) => m.sports.includes(sport));
}
