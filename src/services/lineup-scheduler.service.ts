/**
 * Lineup Scheduler Service
 *
 * Creates Cloud Tasks that trigger the ML Cloud Function's `pregame` mode
 * approximately 90 minutes before each game's first pitch.
 *
 * Each task calls the ML Cloud Function endpoint with:
 *   { mode: "pregame", game_pks: [pk], date: "YYYY-MM-DD" }
 *
 * This chains: lineup fetch → matchup features → daily prediction.
 */

import { CloudTasksClient } from '@google-cloud/tasks';
import logger from '../utils/logger';

export interface PregameTaskPayload {
  game_pks: number[];
  game_date: string;
  delay_seconds?: number;
}

interface GameScheduleItem {
  game_pk: number;
  game_date: string;
  game_time_utc: string; // ISO string
  home_team_name: string;
  away_team_name: string;
}

export class LineupSchedulerService {
  private client: CloudTasksClient;
  private projectId: string;
  private location: string;
  private queueName: string;
  private mlFunctionUrl: string;

  /**
   * How many minutes before first pitch to trigger the pre-game pipeline.
   * 90 min gives time for lineup data to be posted by the club.
   */
  private readonly PREGAME_MINUTES_BEFORE = 90;

  constructor() {
    this.client = new CloudTasksClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'hankstank';
    this.location = process.env.TASK_QUEUE_LOCATION || 'us-central1';
    this.queueName = process.env.LINEUP_TASK_QUEUE || 'lineup-pregame';
    // ML Cloud Function URL
    this.mlFunctionUrl = process.env.ML_FUNCTION_URL ||
      `https://us-central1-${this.projectId}.cloudfunctions.net/daily_pipeline`;
  }

  /**
   * Schedule a pre-game Cloud Task for one or more game PKs.
   * delaySeconds: if provided, schedule after this delay from now.
   *               if not provided, the task fires immediately.
   */
  async schedulePregameTask(
    payload: PregameTaskPayload
  ): Promise<string> {
    const queuePath = this.client.queuePath(
      this.projectId,
      this.location,
      this.queueName
    );

    const taskBody = {
      mode: 'pregame_v10',
      game_pks: payload.game_pks,
      date: payload.game_date,
    };

    const task: any = {
      httpRequest: {
        httpMethod: 'POST',
        url: this.mlFunctionUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(taskBody)).toString('base64'),
        oidcToken: {
          serviceAccountEmail: `${this.projectId}@appspot.gserviceaccount.com`,
        },
      },
    };

    const delaySeconds = payload.delay_seconds ?? 0;
    if (delaySeconds > 0) {
      const scheduleTime = new Date(Date.now() + delaySeconds * 1000);
      task.scheduleTime = {
        seconds: Math.floor(scheduleTime.getTime() / 1000),
      };
    }

    try {
      const [response] = await this.client.createTask({
        parent: queuePath,
        task,
      });

      logger.info('Created pre-game task', {
        taskName: response.name,
        gamePks: payload.game_pks,
        gameDate: payload.game_date,
        delaySeconds,
        triggerAt: delaySeconds > 0
          ? new Date(Date.now() + delaySeconds * 1000).toISOString()
          : 'immediately',
      });

      return response.name || '';
    } catch (error) {
      logger.error('Error creating pre-game Cloud Task', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });
      throw error;
    }
  }

  /**
   * Given a list of today's games (with UTC start times), schedule one
   * Cloud Task per game, each targeting 90 minutes before first pitch.
   *
   * Skips games where the 90-min window has already passed.
   * For games where we're between 0–30 min past the trigger window,
   * schedules an immediate task instead (line-ups may still be available).
   */
  async scheduleAllGamesForDate(games: GameScheduleItem[]): Promise<{
    scheduled: number;
    skipped: number;
    tasks: Array<{ game_pk: number; trigger_time: string; delay_seconds: number }>;
  }> {
    const now = Date.now();
    const scheduled: Array<{ game_pk: number; trigger_time: string; delay_seconds: number }> = [];
    let skipped = 0;

    for (const game of games) {
      let gameTimeMs: number;
      try {
        gameTimeMs = new Date(game.game_time_utc).getTime();
      } catch {
        logger.warn('Invalid game_time_utc for game', { game_pk: game.game_pk });
        skipped++;
        continue;
      }

      const triggerMs = gameTimeMs - this.PREGAME_MINUTES_BEFORE * 60 * 1000;
      const delayMs = triggerMs - now;

      let delaySeconds: number;
      if (delayMs >= 0) {
        // Normal case: task fires in the future
        delaySeconds = Math.floor(delayMs / 1000);
      } else if (delayMs >= -30 * 60 * 1000) {
        // Up to 30 min late — run immediately
        delaySeconds = 0;
        logger.info('Game %d trigger window slightly passed — scheduling immediately', game.game_pk);
      } else {
        // More than 30 min past the window — skip
        logger.info('Skipping game %d — pre-game window has passed', game.game_pk);
        skipped++;
        continue;
      }

      const triggerTime = new Date(now + delaySeconds * 1000).toISOString();

      try {
        await this.schedulePregameTask({
          game_pks: [game.game_pk],
          game_date: game.game_date,
          delay_seconds: delaySeconds,
        });
        scheduled.push({ game_pk: game.game_pk, trigger_time: triggerTime, delay_seconds: delaySeconds });
      } catch (err) {
        logger.error('Failed to schedule task for game', {
          game_pk: game.game_pk,
          error: err instanceof Error ? err.message : String(err),
        });
        skipped++;
      }

      // Small stagger between task creations to avoid API rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return { scheduled: scheduled.length, skipped, tasks: scheduled };
  }
}

export const lineupSchedulerService = new LineupSchedulerService();
