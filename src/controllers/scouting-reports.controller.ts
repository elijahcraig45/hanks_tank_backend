/**
 * Scouting Reports Controller
 * Serves pre-computed daily scouting reports from BigQuery.
 * Reports are built once per day by the ML cloud function.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';

const bigquery = new BigQuery({ projectId: 'hankstank' });
const PROJECT  = 'hankstank';
const DATASET  = 'mlb_2026_season';

class ScoutingReportsController {
  /**
   * GET /api/scouting-reports?date=YYYY-MM-DD
   * Returns all scouting reports for the given date (default: today).
   */
  async getReports(req: Request, res: Response): Promise<void> {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split('T')[0];

      // Basic date format validation
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        return;
      }

      const sql = `
        SELECT
          game_pk,
          game_date,
          home_team_id,
          away_team_id,
          home_team_name,
          away_team_name,
          report,
          generated_at
        FROM \`${PROJECT}.${DATASET}.game_scouting_reports\`
        WHERE game_date = '${date}'
        ORDER BY game_pk
      `;

      const [rows] = await bigquery.query({ query: sql });

      const reports = rows.map((row: any) => {
        let parsedReport = null;
        if (row.report) {
          try {
            parsedReport = typeof row.report === 'string'
              ? JSON.parse(row.report)
              : row.report;
          } catch {
            parsedReport = null;
          }
        }
        return {
          game_pk:        row.game_pk,
          game_date:      row.game_date?.value || row.game_date,
          home_team_id:   row.home_team_id,
          away_team_id:   row.away_team_id,
          home_team_name: row.home_team_name,
          away_team_name: row.away_team_name,
          generated_at:   row.generated_at,
          report:         parsedReport,
        };
      });

      res.json({
        date,
        count: reports.length,
        reports,
      });
    } catch (error) {
      logger.error('Error fetching scouting reports', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch scouting reports' });
    }
  }

  /**
   * GET /api/scouting-reports/:gamePk
   * Returns the scouting report for a single game.
   */
  async getReportByGame(req: Request, res: Response): Promise<void> {
    try {
      const gamePk = parseInt(req.params.gamePk, 10);
      if (isNaN(gamePk)) {
        res.status(400).json({ error: 'Invalid gamePk' });
        return;
      }

      const sql = `
        SELECT
          game_pk,
          game_date,
          home_team_id,
          away_team_id,
          home_team_name,
          away_team_name,
          report,
          generated_at
        FROM \`${PROJECT}.${DATASET}.game_scouting_reports\`
        WHERE game_pk = ${gamePk}
        ORDER BY generated_at DESC
        LIMIT 1
      `;

      const [rows] = await bigquery.query({ query: sql });

      if (!rows.length) {
        res.status(404).json({ error: 'No scouting report found for this game' });
        return;
      }

      const row = rows[0] as any;
      let parsedReport = null;
      if (row.report) {
        try {
          parsedReport = typeof row.report === 'string'
            ? JSON.parse(row.report)
            : row.report;
        } catch {
          parsedReport = null;
        }
      }

      res.json({
        game_pk:        row.game_pk,
        game_date:      row.game_date?.value || row.game_date,
        home_team_id:   row.home_team_id,
        away_team_id:   row.away_team_id,
        home_team_name: row.home_team_name,
        away_team_name: row.away_team_name,
        generated_at:   row.generated_at,
        report:         parsedReport,
      });
    } catch (error) {
      logger.error('Error fetching scouting report for game', {
        gamePk: req.params.gamePk,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch scouting report' });
    }
  }
}

export const scoutingReportsController = new ScoutingReportsController();
