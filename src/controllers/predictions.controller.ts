/**
 * Predictions Controller
 * Returns today's game predictions and matchup feature signals from BigQuery.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { mlbApi } from '../services/mlb-api.service';
import { logger } from '../utils/logger';

const bigquery = new BigQuery({ projectId: 'hankstank' });

const PROJECT = 'hankstank';
const SEASON_DS = 'mlb_2026_season';
const MAX_DIAGNOSTIC_DAYS = 180;

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function dateDiffInDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T12:00:00Z`).getTime();
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(0.999999, Math.max(0.000001, value));
}

function isCompletedGame(game: any): boolean {
  return (
    game?.status?.abstractGameState === 'Final' ||
    game?.status?.detailedState === 'Final' ||
    ['F', 'O', 'R'].includes(game?.status?.statusCode)
  );
}

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

  /**
   * GET /api/predictions/diagnostics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   * Returns finalized predictions joined with actual outcomes over a date range.
   */
  async getPredictionDiagnostics(req: Request, res: Response): Promise<void> {
    try {
      const today = formatIsoDate(new Date());
      const endDate = String(req.query.endDate || today);
      const startDate = String(req.query.startDate || addDays(endDate, -29));

      if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATE_RANGE', message: 'startDate and endDate must use YYYY-MM-DD format.' },
        });
        return;
      }

      const daySpan = dateDiffInDays(startDate, endDate);
      if (daySpan < 0 || daySpan > MAX_DIAGNOSTIC_DAYS) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DATE_RANGE',
            message: `Date range must be between 0 and ${MAX_DIAGNOSTIC_DAYS} days.`,
          },
        });
        return;
      }

      const sql = `
        WITH latest_pred AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY game_pk
              ORDER BY predicted_at DESC
            ) AS rn
          FROM \`${PROJECT}.${SEASON_DS}.game_predictions\`
          WHERE game_date BETWEEN '${startDate}' AND '${endDate}'
        )
        SELECT
          game_pk,
          game_date,
          home_team_id,
          home_team_name,
          away_team_id,
          away_team_name,
          home_starter_id,
          home_starter_name,
          away_starter_id,
          away_starter_name,
          home_win_probability,
          away_win_probability,
          predicted_winner,
          confidence_tier,
          model_version,
          lineup_confirmed,
          game_time_utc,
          predicted_at
        FROM latest_pred
        WHERE rn = 1
        ORDER BY game_date ASC, game_time_utc ASC NULLS LAST
      `;

      const [predictionRows] = await bigquery.query({ query: sql });
      const scheduleData = await mlbApi.getScheduleWithOptions({
        startDate,
        endDate,
        sportId: 1,
      });

      const gamesByPk = new Map<number, any>();
      (scheduleData?.dates || []).forEach((dateEntry: any) => {
        (dateEntry.games || []).forEach((game: any) => {
          gamesByPk.set(Number(game.gamePk), game);
        });
      });

      const diagnostics = predictionRows
        .map((row: any) => {
          const game = gamesByPk.get(Number(row.game_pk));
          if (!game || !isCompletedGame(game)) {
            return null;
          }

          const homeScore = Number(game?.teams?.home?.score);
          const awayScore = Number(game?.teams?.away?.score);
          if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) {
            return null;
          }

          const homeWinProbability = clampProbability(Number(row.home_win_probability));
          const awayWinProbability = clampProbability(
            Number.isFinite(Number(row.away_win_probability))
              ? Number(row.away_win_probability)
              : 1 - homeWinProbability
          );
          const actualHomeWin = homeScore > awayScore;
          const predictedWinner =
            row.predicted_winner ||
            (homeWinProbability >= awayWinProbability ? row.home_team_name : row.away_team_name);
          const actualWinner = actualHomeWin ? row.home_team_name : row.away_team_name;
          const predictedWinnerIsHome = predictedWinner === row.home_team_name;
          const predictedWinProbability = predictedWinnerIsHome ? homeWinProbability : awayWinProbability;
          const correct = predictedWinner === actualWinner;
          const brierScore = Math.pow(homeWinProbability - (actualHomeWin ? 1 : 0), 2);
          const logLoss = actualHomeWin
            ? -Math.log(homeWinProbability)
            : -Math.log(clampProbability(1 - homeWinProbability));

          return {
            gamePk: Number(row.game_pk),
            gameDate: row.game_date,
            gameTimeUtc: row.game_time_utc || game.gameDate,
            status: game?.status?.detailedState || game?.status?.abstractGameState || 'Final',
            homeTeamId: Number(row.home_team_id),
            homeTeamName: row.home_team_name,
            awayTeamId: Number(row.away_team_id),
            awayTeamName: row.away_team_name,
            homeStarterId: row.home_starter_id ? Number(row.home_starter_id) : null,
            homeStarterName: row.home_starter_name || null,
            awayStarterId: row.away_starter_id ? Number(row.away_starter_id) : null,
            awayStarterName: row.away_starter_name || null,
            homeWinProbability,
            awayWinProbability,
            predictedWinner,
            predictedWinProbability,
            actualWinner,
            actualHomeWin,
            confidenceTier: row.confidence_tier || 'LOW',
            modelVersion: row.model_version || 'unknown',
            lineupConfirmed: Boolean(row.lineup_confirmed),
            edge: Math.abs(homeWinProbability - awayWinProbability),
            correct,
            brierScore,
            logLoss,
            homeScore,
            awayScore,
            predictedAt: row.predicted_at || null,
          };
        })
        .filter(Boolean);

      res.json({
        success: true,
        startDate,
        endDate,
        totalPredictions: predictionRows.length,
        completedGames: diagnostics.length,
        pendingGames: predictionRows.length - diagnostics.length,
        diagnostics,
      });
    } catch (error: any) {
      logger.error('Failed to fetch prediction diagnostics', { error: error.message });
      res.status(500).json({
        success: false,
        error: { code: 'PREDICTION_DIAGNOSTICS_ERROR', message: error.message },
      });
    }
  }
}

export const predictionsController = new PredictionsController();
