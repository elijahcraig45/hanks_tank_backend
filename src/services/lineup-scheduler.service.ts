/**
 * Lineup Scheduler Service
 *
 * Creates Cloud Tasks that trigger the ML Cloud Function's `pregame` mode
 * at multiple checkpoints before each game's first pitch.
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
  /** Target the separate simulator-blend function instead of the pregame pipeline. */
  sim_blend?: boolean;
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
  private simBlendFunctionUrl: string;

  /**
   * Pregame checkpoints that probe for lineups before first pitch.
   * Clubs often publish lineups several hours early, so we refresh
   * repeatedly instead of waiting for a single late task.
   */
  private readonly PREGAME_CHECKPOINT_MINUTES = [360, 180, 90, 45];

  /**
   * The PA-simulator shadow runs once per game, at this checkpoint only: each cold
   * start loads ~2M plate appearances, and lineups are usually posted by then (a
   * missing lineup falls back to the previous game's, measured to cost nothing).
   */
  private readonly SIM_BLEND_CHECKPOINT_MINUTES = 90;

  constructor() {
    this.client = new CloudTasksClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'hankstank';
    this.location = process.env.TASK_QUEUE_LOCATION || 'us-central1';
    this.queueName = process.env.LINEUP_TASK_QUEUE || 'lineup-pregame';
    // ML Cloud Function URL
    this.mlFunctionUrl = process.env.ML_FUNCTION_URL ||
      `https://us-central1-${this.projectId}.cloudfunctions.net/daily_pipeline`;
    // Separate 4 GiB function; unset means the simulator shadow is not scheduled.
    this.simBlendFunctionUrl = process.env.SIM_BLEND_FUNCTION_URL || '';
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

    // run_logit3: the 3-feature shadow writes game_predictions_logit3 only.
    const taskBody = payload.sim_blend
      ? { mode: 'sim_blend', game_pks: payload.game_pks, date: payload.game_date }
      : {
          mode: 'pregame_v10',
          game_pks: payload.game_pks,
          date: payload.game_date,
          run_logit3: true,
        };

    const task: any = {
      httpRequest: {
        httpMethod: 'POST',
        url: payload.sim_blend ? this.simBlendFunctionUrl : this.mlFunctionUrl,
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
   * immediate baseline task plus multiple pregame refreshes per game.
   *
   * Skips games where first pitch has already passed.
   */
  async scheduleAllGamesForDate(games: GameScheduleItem[]): Promise<{
     scheduled: number;
     skipped: number;
     tasks: Array<{ game_pk: number; trigger_time: string; delay_seconds: number; phase: string }>;
   }> {
     const now = Date.now();
     const scheduled: Array<{ game_pk: number; trigger_time: string; delay_seconds: number; phase: string }> = [];
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

       if (gameTimeMs <= now) {
         logger.info('Skipping game %d — first pitch has already passed', game.game_pk);
         skipped++;
         continue;
       }

        try {
          await this.schedulePregameTask({
            game_pks: [game.game_pk],
            game_date: game.game_date,
            delay_seconds: 0,
          });
          scheduled.push({
            game_pk: game.game_pk,
            trigger_time: new Date(now).toISOString(),
            delay_seconds: 0,
            phase: 'baseline',
          });

          for (const checkpointMinutes of this.PREGAME_CHECKPOINT_MINUTES) {
            const triggerMs = gameTimeMs - checkpointMinutes * 60 * 1000;
            if (triggerMs <= now) {
              continue;
            }

            const delaySeconds = Math.floor((triggerMs - now) / 1000);
            await this.schedulePregameTask({
              game_pks: [game.game_pk],
              game_date: game.game_date,
              delay_seconds: delaySeconds,
            });
            scheduled.push({
              game_pk: game.game_pk,
              trigger_time: new Date(now + delaySeconds * 1000).toISOString(),
              delay_seconds: delaySeconds,
              phase: `lineup-refresh-${checkpointMinutes}m`,
            });

            if (this.simBlendFunctionUrl && checkpointMinutes === this.SIM_BLEND_CHECKPOINT_MINUTES) {
              // A failed shadow task must not cost the game its real pregame tasks.
              try {
                await this.schedulePregameTask({
                  game_pks: [game.game_pk],
                  game_date: game.game_date,
                  delay_seconds: delaySeconds,
                  sim_blend: true,
                });
                scheduled.push({
                  game_pk: game.game_pk,
                  trigger_time: new Date(now + delaySeconds * 1000).toISOString(),
                  delay_seconds: delaySeconds,
                  phase: `sim-blend-${checkpointMinutes}m`,
                });
              } catch (simErr) {
                logger.warn('Sim-blend shadow task not scheduled', {
                  game_pk: game.game_pk,
                  error: simErr instanceof Error ? simErr.message : String(simErr),
                });
              }
            }
          }
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
