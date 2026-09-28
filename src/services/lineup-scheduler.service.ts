/**
 * Lineup Scheduler Service
 *
 * Creates Cloud Tasks that trigger the ML Cloud Function's `pregame_v10` mode
 * at multiple checkpoints before each game's first pitch.
 *
 * Each task calls the ML Cloud Function endpoint with:
 *   { mode: "pregame_v10", game_pks: [pk], date: "YYYY-MM-DD", run_logit3: true }
 *
 * This chains: lineup fetch → matchup features → daily prediction.
 *
 * Task names are deterministic (a hash of queue, target, body and fire time), so
 * scheduling the same day twice is harmless: Cloud Tasks rejects the second copy with
 * ALREADY_EXISTS. Two callers do schedule every day (App Engine cron and the ML
 * function's mlb-2026-pregame-schedule job, both at 10:00 ET); before names, every task
 * ran twice from 2026-09-11 on, and concurrent twins wrote duplicate prediction rows.
 */

import { createHash } from 'crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import logger from '../utils/logger';

export interface PregameTaskPayload {
  game_pks: number[];
  game_date: string;
  delay_seconds?: number;
  /** Target the separate simulator-blend function instead of the pregame pipeline. */
  sim_blend?: boolean;
  /** Sim-blend late retry: an incomplete side uses the team's previous game's lineup. */
  lineup_fallback?: boolean;
  /**
   * Names the task deterministically from this key (plus queue, url, body, fire time).
   * Unset: Cloud Tasks picks a name and nothing is deduplicated (manual re-runs).
   */
  dedupe_key?: string;
}

export interface ScheduledTask {
  name: string;
  /** True when an identical task already existed and this enqueue was a no-op. */
  deduped: boolean;
}

/** gRPC ALREADY_EXISTS, as google-gax reports it. */
function isAlreadyExists(error: unknown): boolean {
  const e = error as { code?: number; message?: string } | null;
  return e?.code === 6 || /ALREADY_EXISTS/i.test(e?.message || '');
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
  private simBlendQueueName: string;
  private mlFunctionUrl: string;
  private simBlendFunctionUrl: string;

  /**
   * Pregame checkpoints that probe for lineups before first pitch.
   * Clubs often publish lineups several hours early, so we refresh
   * repeatedly instead of waiting for a single late task.
   */
  private readonly PREGAME_CHECKPOINT_MINUTES = [360, 180, 90, 45];

  /**
   * The PA-simulator shadow: one run at T-80, ten minutes after the T-90 pregame task
   * has fetched lineups (pregame_v10 runs took 146 s mean, 213 s max on 2026-09-27; at
   * T-90 the two raced and the sim read incomplete lineups). A retry at T-35, after the
   * T-45 lineup fetch, with lineup_fallback: the function skips a game it already wrote,
   * and otherwise falls back to the previous game's lineup for a side still incomplete
   * (research 51_test_report: no measurable log-loss cost).
   */
  private readonly SIM_BLEND_CHECKPOINTS: Array<{ minutes: number; lineup_fallback: boolean }> = [
    { minutes: 80, lineup_fallback: false },
    { minutes: 35, lineup_fallback: true },
  ];

  constructor() {
    this.client = new CloudTasksClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'hankstank';
    this.location = process.env.TASK_QUEUE_LOCATION || 'us-central1';
    this.queueName = process.env.LINEUP_TASK_QUEUE || 'lineup-pregame';
    // The shadow has its own queue, so its backlog or failures never delay a pregame task
    // (it shared lineup-pregame, 5 concurrent dispatches, with a 1-instance function).
    this.simBlendQueueName = process.env.SIM_BLEND_TASK_QUEUE || 'sim-blend';
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
  ): Promise<ScheduledTask> {
    const queue = payload.sim_blend ? this.simBlendQueueName : this.queueName;
    const queuePath = this.client.queuePath(
      this.projectId,
      this.location,
      queue
    );

    // run_logit3: the 3-feature shadow writes game_predictions_logit3 only.
    const taskBody = payload.sim_blend
      ? {
          mode: 'sim_blend',
          game_pks: payload.game_pks,
          date: payload.game_date,
          ...(payload.lineup_fallback ? { lineup_fallback: true } : {}),
        }
      : {
          mode: 'pregame_v10',
          game_pks: payload.game_pks,
          date: payload.game_date,
          run_logit3: true,
        };
    const url = payload.sim_blend ? this.simBlendFunctionUrl : this.mlFunctionUrl;
    const bodyJson = JSON.stringify(taskBody);

    const task: any = {
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(bodyJson).toString('base64'),
        oidcToken: {
          serviceAccountEmail: `${this.projectId}@appspot.gserviceaccount.com`,
        },
      },
    };

    const delaySeconds = payload.delay_seconds ?? 0;
    let scheduleSeconds: number | null = null;
    if (delaySeconds > 0) {
      scheduleSeconds = Math.floor((Date.now() + delaySeconds * 1000) / 1000);
      task.scheduleTime = { seconds: scheduleSeconds };
    }
    if (payload.dedupe_key) {
      task.name = `${queuePath}/tasks/${this.taskId(payload, queue, url, bodyJson)}`;
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

      return { name: response.name || '', deduped: false };
    } catch (error) {
      if (task.name && isAlreadyExists(error)) {
        logger.info('Pre-game task already scheduled; not duplicated', {
          taskName: task.name,
          gamePks: payload.game_pks,
          dedupeKey: payload.dedupe_key,
        });
        return { name: task.name, deduped: true };
      }
      logger.error('Error creating pre-game Cloud Task', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });
      throw error;
    }
  }

  /**
   * Deterministic task id. The key names the checkpoint and the fire time it was
   * computed from (first pitch minus the checkpoint), so a second schedule-today call
   * produces the same id while a postponed game, whose first pitch moved, gets new
   * tasks. The hash leads the id, as Cloud Tasks recommends for spreading load.
   */
  private taskId(payload: PregameTaskPayload, queue: string, url: string, body: string): string {
    const h = createHash('sha256')
      .update([this.projectId, queue, url, body, payload.dedupe_key].join('|'))
      .digest('hex')
      .slice(0, 16);
    const safe = (payload.dedupe_key || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120);
    return `${h}-${safe}`;
  }

  /**
   * Given a list of today's games (with UTC start times), schedule one
   * immediate baseline task plus multiple pregame refreshes per game.
   *
   * Skips games where first pitch has already passed. Safe to call more than once a
   * day: every task is named, so repeats are counted as deduped, not enqueued.
   */
  async scheduleAllGamesForDate(games: GameScheduleItem[]): Promise<{
     scheduled: number;
     deduped: number;
     skipped: number;
     tasks: Array<{ game_pk: number; trigger_time: string; delay_seconds: number; phase: string; deduped?: boolean }>;
   }> {
     const now = Date.now();
     const scheduled: Array<{ game_pk: number; trigger_time: string; delay_seconds: number; phase: string; deduped?: boolean }> = [];
     let skipped = 0;
     let deduped = 0;
     const record = (game: GameScheduleItem, delaySeconds: number, phase: string, res: ScheduledTask) => {
       if (res?.deduped) deduped++;
       scheduled.push({
         game_pk: game.game_pk,
         trigger_time: new Date(now + delaySeconds * 1000).toISOString(),
         delay_seconds: delaySeconds,
         phase,
         ...(res?.deduped ? { deduped: true } : {}),
       });
     };

     for (const game of games) {
       const gameTimeMs = new Date(game.game_time_utc).getTime();
       if (!Number.isFinite(gameTimeMs)) {
         logger.warn('Invalid game_time_utc for game', { game_pk: game.game_pk });
         skipped++;
         continue;
       }

       if (gameTimeMs <= now) {
         logger.info('Skipping game %d — first pitch has already passed', game.game_pk);
         skipped++;
         continue;
       }
       const firstPitch = new Date(gameTimeMs).toISOString();

        try {
          const baseline = await this.schedulePregameTask({
            game_pks: [game.game_pk],
            game_date: game.game_date,
            delay_seconds: 0,
            dedupe_key: `${game.game_date}-${game.game_pk}-baseline`,
          });
          record(game, 0, 'baseline', baseline);

          for (const checkpointMinutes of this.PREGAME_CHECKPOINT_MINUTES) {
            const triggerMs = gameTimeMs - checkpointMinutes * 60 * 1000;
            if (triggerMs <= now) {
              continue;
            }

            const delaySeconds = Math.floor((triggerMs - now) / 1000);
            const res = await this.schedulePregameTask({
              game_pks: [game.game_pk],
              game_date: game.game_date,
              delay_seconds: delaySeconds,
              dedupe_key: `${game.game_date}-${game.game_pk}-t${checkpointMinutes}-${firstPitch}`,
            });
            record(game, delaySeconds, `lineup-refresh-${checkpointMinutes}m`, res);
          }
        } catch (err) {
          logger.error('Failed to schedule task for game', {
           game_pk: game.game_pk,
          error: err instanceof Error ? err.message : String(err),
        });
        skipped++;
      }

      if (this.simBlendFunctionUrl) {
        for (const cp of this.SIM_BLEND_CHECKPOINTS) {
          const triggerMs = gameTimeMs - cp.minutes * 60 * 1000;
          if (triggerMs <= now) continue;
          const delaySeconds = Math.floor((triggerMs - now) / 1000);
          // A failed shadow task must not cost the game its real pregame tasks.
          try {
            const res = await this.schedulePregameTask({
              game_pks: [game.game_pk],
              game_date: game.game_date,
              delay_seconds: delaySeconds,
              sim_blend: true,
              lineup_fallback: cp.lineup_fallback,
              dedupe_key: `${game.game_date}-${game.game_pk}-sim${cp.minutes}-${firstPitch}`,
            });
            record(game, delaySeconds, `sim-blend-${cp.minutes}m`, res);
          } catch (simErr) {
            logger.warn('Sim-blend shadow task not scheduled', {
              game_pk: game.game_pk,
              checkpoint: cp.minutes,
              error: simErr instanceof Error ? simErr.message : String(simErr),
            });
          }
        }
      }

      // Small stagger between task creations to avoid API rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return { scheduled: scheduled.length - deduped, deduped, skipped, tasks: scheduled };
  }
}

export const lineupSchedulerService = new LineupSchedulerService();
