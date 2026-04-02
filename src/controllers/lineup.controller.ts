/**
 * Lineup Controller
 *
 * Endpoints:
 *   POST /api/lineup/schedule-task
 *     Called by the ML Cloud Function's schedule_pregame_tasks mode.
 *     Creates a Cloud Task for the pre-game pipeline.
 *
 *   POST /api/lineup/trigger-pregame
 *     Internal/cron endpoint to trigger the ML pregame pipeline directly
 *     (used as fallback if Cloud Task creation fails).
 *
 *   GET /api/lineup/schedule-today
 *     Manually trigger scheduling for all of today's games.
 *     Usually invoked by cron at ~10 AM ET.
 */

import { Request, Response } from 'express';
import mlbApiService from '../services/mlb-api.service';
import { lineupSchedulerService } from '../services/lineup-scheduler.service';
import logger from '../utils/logger';

export class LineupController {
  /**
   * POST /api/lineup/schedule-task
   * Body: { game_pks: number[], game_date: string, delay_seconds?: number }
   *
   * Creates a Cloud Task that will trigger the ML pregame pipeline at
   * (now + delay_seconds).
   */
  async scheduleTask(req: Request, res: Response): Promise<void> {
    const { game_pks, game_date, delay_seconds } = req.body as {
      game_pks?: number[];
      game_date?: string;
      delay_seconds?: number;
    };

    if (!game_pks || !Array.isArray(game_pks) || game_pks.length === 0) {
      res.status(400).json({ error: 'game_pks array is required' });
      return;
    }
    if (!game_date || !/^\d{4}-\d{2}-\d{2}$/.test(game_date)) {
      res.status(400).json({ error: 'game_date required (YYYY-MM-DD)' });
      return;
    }

    try {
      const taskName = await lineupSchedulerService.schedulePregameTask({
        game_pks,
        game_date,
        delay_seconds: delay_seconds ?? 0,
      });

      res.json({
        ok: true,
        task_name: taskName,
        game_pks,
        game_date,
        delay_seconds: delay_seconds ?? 0,
      });
    } catch (err) {
      logger.error('schedule-task error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        error: 'Failed to create Cloud Task',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * GET /api/lineup/schedule-today
   * Fetches today's schedule from MLB API and schedules per-game Cloud Tasks.
   * Safe to call multiple times (duplicate tasks won't cause double-predictions
   * since the ML pipeline uses upsert logic).
   */
  async scheduleToday(req: Request, res: Response): Promise<void> {
    const dateParam = (req.query.date as string) || new Date().toISOString().slice(0, 10);

    try {
      // Fetch schedule from MLB API
      const scheduleData = await mlbApiService.getSchedule(dateParam, dateParam, undefined, 1);

      const games: Array<{
        game_pk: number;
        game_date: string;
        game_time_utc: string;
        home_team_name: string;
        away_team_name: string;
      }> = [];

      for (const day of scheduleData?.dates ?? []) {
        for (const g of day.games ?? []) {
          // Skip already-finished games
          if (g.status?.abstractGameState === 'Final') continue;

          const gameTimeRaw: string = g.gameDate ?? '';
          const gameTimeUtc = gameTimeRaw.endsWith('Z')
            ? gameTimeRaw
            : gameTimeRaw + 'Z';

          games.push({
            game_pk: g.gamePk,
            game_date: dateParam,
            game_time_utc: gameTimeUtc,
            home_team_name: g.teams?.home?.team?.name ?? '',
            away_team_name: g.teams?.away?.team?.name ?? '',
          });
        }
      }

      if (games.length === 0) {
        res.json({ ok: true, message: 'No upcoming games today', scheduled: 0, skipped: 0 });
        return;
      }

      const result = await lineupSchedulerService.scheduleAllGamesForDate(games);

      logger.info('Scheduled pregame tasks', {
        date: dateParam,
        ...result,
      });

      res.json({ ok: true, date: dateParam, games_found: games.length, ...result });
    } catch (err) {
      logger.error('schedule-today error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        error: 'Failed to schedule today\'s pre-game tasks',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const lineupController = new LineupController();
