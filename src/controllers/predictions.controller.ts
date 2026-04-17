/**
 * Predictions Controller
 * Returns today's game predictions and matchup feature signals from BigQuery.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';

const bigquery = new BigQuery({ projectId: 'hankstank' });

const PROJECT = 'hankstank';
const SEASON_DS = 'mlb_2026_season';

class PredictionsController {
  /**
   * GET /api/predictions?date=YYYY-MM-DD
   * Returns predictions + matchup features for all games on the given date.
   */
  async getPredictions(req: Request, res: Response): Promise<void> {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

      const sql = `
        WITH latest_pred AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY game_pk
              ORDER BY predicted_at DESC
            ) AS rn
          FROM \`${PROJECT}.${SEASON_DS}.game_predictions\`
          WHERE game_date = '${date}'
        ),
        latest_matchup AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY game_pk
              ORDER BY computed_at DESC
            ) AS rn
          FROM \`${PROJECT}.${SEASON_DS}.matchup_features\`
          WHERE game_date = '${date}'
        )
        SELECT
          -- All prediction columns (p.* minus the window-function rn column)
          p.game_pk, p.game_date,
          p.home_team_id, p.home_team_name,
          p.away_team_id, p.away_team_name,
          p.home_starter_id, p.home_starter_name,
          p.away_starter_id, p.away_starter_name,
          p.home_win_probability, p.away_win_probability,
          p.predicted_winner, p.confidence_tier,
          p.model_version, p.lineup_confirmed,
          p.matchup_advantage_home,
          p.home_lineup_woba_vs_hand, p.away_lineup_woba_vs_hand,
          p.home_starter_hand, p.away_starter_hand,
          p.h2h_data_available, p.game_time_utc, p.predicted_at,
          -- V7 pitcher arsenal + bullpen + moon + venue
          p.home_starter_mean_velo, p.away_starter_mean_velo,
          p.home_starter_velo_norm, p.away_starter_velo_norm,
          p.home_starter_k_bb_pct, p.away_starter_k_bb_pct,
          p.home_starter_xwoba_allowed, p.away_starter_xwoba_allowed,
          p.starter_arsenal_advantage,
          p.home_bullpen_fatigue_score, p.away_bullpen_fatigue_score,
          p.bullpen_fatigue_differential,
          p.home_closer_days_rest, p.away_closer_days_rest,
          p.moon_illumination, p.is_full_moon,
          p.home_starter_venue_era, p.away_starter_venue_era,
          p.starter_venue_era_differential,
          p.venue_woba_differential,
          -- V10 SP quality percentile ranks (Baseball Savant 0-100)
          p.home_sp_xera, p.away_sp_xera,
          p.home_sp_fbv_pct, p.away_sp_fbv_pct,
          p.home_sp_k_pct, p.away_sp_k_pct,
          p.home_sp_bb_pct, p.away_sp_bb_pct,
          p.home_sp_whiff_pct, p.away_sp_whiff_pct,
          p.home_sp_known, p.away_sp_known,
          p.sp_quality_composite_diff,
          -- V8 Elo + team form signals
          p.elo_differential, p.elo_home_win_prob,
          p.home_pythag_season, p.away_pythag_season, p.pythag_differential,
          p.home_run_diff_10g, p.away_run_diff_10g,
          p.home_current_streak, p.away_current_streak,
          p.h2h_win_pct_3yr, p.is_divisional,
          -- Matchup feature details (V6 batter/pitcher splits)
          m.home_h2h_woba, m.home_h2h_pa_total, m.home_h2h_k_pct,
          m.away_h2h_woba, m.away_h2h_pa_total, m.away_h2h_k_pct,
          m.home_top3_woba_vs_hand, m.away_top3_woba_vs_hand,
          m.home_starter_woba_allowed, m.home_starter_k_pct,
          m.away_starter_woba_allowed, m.away_starter_k_pct,
          m.home_pct_same_hand, m.away_pct_same_hand
        FROM latest_pred p
        LEFT JOIN latest_matchup m
          ON p.game_pk = m.game_pk AND m.rn = 1
        WHERE p.rn = 1
        ORDER BY p.game_time_utc ASC NULLS LAST
      `;

      const [rows] = await bigquery.query({ query: sql });

      res.json({
        success: true,
        date,
        count: rows.length,
        predictions: rows,
      });
    } catch (error: any) {
      logger.error('Failed to fetch predictions', { error: error.message });
      res.status(500).json({
        success: false,
        error: { code: 'PREDICTIONS_ERROR', message: error.message },
      });
    }
  }

  /**
   * GET /api/predictions/:gamePk
   * Returns prediction + matchup signals for a single game.
   */
  async getPredictionByGame(req: Request, res: Response): Promise<void> {
    try {
      const gamePk = parseInt(String(req.params.gamePk), 10);
      if (isNaN(gamePk)) {
        res.status(400).json({ success: false, error: { code: 'INVALID_GAME_PK' } });
        return;
      }

      const sql = `
        WITH latest_pred AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY game_pk ORDER BY predicted_at DESC) AS rn
          FROM \`${PROJECT}.${SEASON_DS}.game_predictions\`
          WHERE game_pk = ${gamePk}
        ),
        latest_matchup AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY game_pk ORDER BY computed_at DESC) AS rn
          FROM \`${PROJECT}.${SEASON_DS}.matchup_features\`
          WHERE game_pk = ${gamePk}
        )
        SELECT
          p.game_pk, p.game_date,
          p.home_team_id, p.home_team_name,
          p.away_team_id, p.away_team_name,
          p.home_starter_id, p.home_starter_name,
          p.away_starter_id, p.away_starter_name,
          p.home_win_probability, p.away_win_probability,
          p.predicted_winner, p.confidence_tier,
          p.model_version, p.lineup_confirmed,
          p.matchup_advantage_home,
          p.home_lineup_woba_vs_hand, p.away_lineup_woba_vs_hand,
          p.home_starter_hand, p.away_starter_hand,
          p.h2h_data_available, p.game_time_utc, p.predicted_at,
          p.home_starter_mean_velo, p.away_starter_mean_velo,
          p.home_starter_velo_norm, p.away_starter_velo_norm,
          p.home_starter_k_bb_pct, p.away_starter_k_bb_pct,
          p.home_starter_xwoba_allowed, p.away_starter_xwoba_allowed,
          p.starter_arsenal_advantage,
          p.home_bullpen_fatigue_score, p.away_bullpen_fatigue_score,
          p.bullpen_fatigue_differential,
          p.home_closer_days_rest, p.away_closer_days_rest,
          p.moon_illumination, p.is_full_moon,
          p.home_starter_venue_era, p.away_starter_venue_era,
          p.starter_venue_era_differential,
          p.venue_woba_differential,
          p.elo_differential, p.elo_home_win_prob,
          p.home_pythag_season, p.away_pythag_season, p.pythag_differential,
          p.home_run_diff_10g, p.away_run_diff_10g,
          p.home_current_streak, p.away_current_streak,
          p.h2h_win_pct_3yr, p.is_divisional,
          m.home_h2h_woba, m.home_h2h_pa_total, m.home_h2h_k_pct,
          m.away_h2h_woba, m.away_h2h_pa_total, m.away_h2h_k_pct,
          m.home_top3_woba_vs_hand, m.away_top3_woba_vs_hand,
          m.home_starter_woba_allowed, m.home_starter_k_pct,
          m.away_starter_woba_allowed, m.away_starter_k_pct,
          m.home_pct_same_hand, m.away_pct_same_hand
        FROM latest_pred p
        LEFT JOIN latest_matchup m ON p.game_pk = m.game_pk AND m.rn = 1
        WHERE p.rn = 1
        LIMIT 1
      `;

      const [rows] = await bigquery.query({ query: sql });

      if (!rows.length) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No prediction for game ${gamePk}` } });
        return;
      }

      res.json({ success: true, prediction: rows[0] });
    } catch (error: any) {
      logger.error('Failed to fetch game prediction', { error: error.message, gamePk: req.params.gamePk });
      res.status(500).json({ success: false, error: { code: 'PREDICTIONS_ERROR', message: error.message } });
    }
  }
}

export const predictionsController = new PredictionsController();
