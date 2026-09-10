/**
 * Pipeline health — is each prediction pipeline actually producing, and how old
 * is the newest thing it produced.
 *
 * This exists because of a specific outage. In September 2026 the CFB pipeline
 * ran every Tuesday, exited zero, and predicted a week that had already been
 * played: two week-1 games were cancelled and postponed, so `home_won` stayed
 * permanently NULL and the "next unplayed week" cursor never advanced. Picks
 * went eight days stale while every signal anyone had said the job was fine.
 *
 * The lesson is in the shape of this check. `/health/scheduler` answered "are
 * the in-process cron tasks registered", which cannot fail for a pipeline that
 * does not run in this process at all — the six football jobs and the MLB one
 * are Cloud Scheduler, not node-cron. So the question here is not "did it run"
 * but "how old is the newest row", which is the only version of the question a
 * successful-but-wrong run cannot answer with a false yes.
 */

import { Request, Response } from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { normalizeBigQueryTemporalValue } from '../utils/bq-normalize';

const PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';
const MLB_DS = process.env.MLB_DATASET || 'mlb_2026_season';
const NFL_DS = process.env.NFL_DATASET || 'nfl_season';
const CFB_DS = process.env.CFB_DATASET || 'cfb_season';

const bigquery = new BigQuery({ projectId: PROJECT });

interface LeagueSpec {
  key: string;
  label: string;
  /** Hours the newest prediction may age before this is a fault. */
  thresholdHours: number;
  /** Calendar months (1-12) the league produces predictions in. */
  months: number[];
}

/**
 * Thresholds are set to catch ONE missed run, not two.
 *
 * Football predicts weekly, so picks legitimately reach ~168h just before the
 * next scheduled run; 192h means a skipped week surfaces a day later rather
 * than a week later. The real CFB stall was found at 194h — a 9-day threshold
 * would still have been silent, which is how you end up with an alarm that
 * agrees with the outage. MLB predicts daily: 24h normal, 36h with slack.
 */
const LEAGUES: LeagueSpec[] = [
  { key: 'mlb', label: 'MLB', thresholdHours: 36, months: [3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { key: 'nfl', label: 'NFL', thresholdHours: 192, months: [8, 9, 10, 11, 12, 1, 2] },
  { key: 'cfb', label: 'CFB (FBS)', thresholdHours: 192, months: [8, 9, 10, 11, 12, 1] },
  { key: 'fcs', label: 'CFB (FCS)', thresholdHours: 192, months: [8, 9, 10, 11, 12, 1] },
];

/** Football seasons are labelled by the year they START, so January's playoff
 *  games belong to the previous season. */
function seasonYear(now: Date): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() + 1 >= 7 ? year : year - 1;
}

/**
 * One BigQuery job for all four leagues. MAX + COUNT over a partitioned
 * timestamp column is cheap; four separate round trips on a health check are
 * not, and a health check that is expensive stops being called.
 */
function freshnessSql(): string {
  return `
    SELECT 'mlb' AS league, MAX(predicted_at) AS latest, COUNT(*) AS predictions,
           CAST(MAX(game_date) AS STRING) AS newest_slate
      FROM \`${PROJECT}.${MLB_DS}.game_predictions\`
    UNION ALL
    SELECT 'nfl', MAX(predicted_at), COUNT(*), CAST(MAX(week) AS STRING)
      FROM \`${PROJECT}.${NFL_DS}.game_predictions\` WHERE season = @season
    UNION ALL
    SELECT IF(division = 'fcs', 'fcs', 'cfb'), MAX(predicted_at), COUNT(*),
           CAST(MAX(week) AS STRING)
      FROM \`${PROJECT}.${CFB_DS}.game_predictions\` WHERE season = @season
     GROUP BY 1
  `;
}

function ageHours(latest: string | null, now: Date): number | null {
  if (!latest) return null;
  const when = Date.parse(latest);
  if (Number.isNaN(when)) return null;
  return Math.round(((now.getTime() - when) / 3_600_000) * 10) / 10;
}

/**
 * A league with no rows is only a fault if it should be producing. NFL has
 * written nothing in June for as long as there has been an NFL, and an alarm
 * that is red every summer is an alarm nobody reads in October.
 */
function judge(spec: LeagueSpec, row: any, now: Date) {
  const inSeason = spec.months.includes(now.getUTCMonth() + 1);
  const latest = row ? normalizeBigQueryTemporalValue(row.latest) : null;
  const age = ageHours(latest, now);
  const stale = inSeason && (age === null || age > spec.thresholdHours);
  return {
    key: spec.key,
    label: spec.label,
    in_season: inSeason,
    predicted_at: latest,
    age_hours: age,
    threshold_hours: spec.thresholdHours,
    stale,
    predictions: row ? Number(row.predictions) : 0,
    // Week for football, latest slate date for MLB. The CFB stall was visible
    // here first: the newest week on file stayed at 1 while the calendar moved.
    newest: row ? row.newest_slate : null,
  };
}

async function pipelineFreshness(now: Date) {
  const [rows] = await bigquery.query({
    query: freshnessSql(),
    params: { season: seasonYear(now) },
  });
  const byKey = new Map(rows.map((r: any) => [r.league, r]));
  return LEAGUES.map((spec) => judge(spec, byKey.get(spec.key), now));
}

/**
 * GET /api/health/scheduler
 *
 * Answers 200 even when a pipeline is stale, and says so in `status`. A 503
 * would read to the wall display as "the API is unreachable", which is a
 * different and untrue statement — the API is up, the data is old.
 */
export async function getSchedulerHealth(req: Request, res: Response): Promise<void> {
  const now = new Date();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { schedulerService } = require('../services/scheduler.service');

  let leagues: any[] = [];
  let error: string | null = null;
  try {
    leagues = await pipelineFreshness(now);
  } catch (err) {
    error = err instanceof Error ? err.message : 'unknown error';
    logger.error('Pipeline freshness check failed', { error });
  }

  const stale = leagues.filter((l) => l.stale).map((l) => l.key);
  res.json({
    // Unreadable freshness is not health. If the query failed we do not know
    // whether the pipelines are running, and "ok" would be a guess.
    status: error || stale.length ? 'degraded' : 'ok',
    // In-process node-cron only — the news fetch. Kept under its original key
    // so existing callers keep working, but it was never the pipelines.
    scheduler: {
      jobs: schedulerService.getJobStatus(),
      timestamp: now.toISOString(),
    },
    pipelines: {
      status: error ? 'unknown' : stale.length ? 'stale' : 'ok',
      season: seasonYear(now),
      leagues,
      stale: stale.length ? stale : null,
      error,
    },
  });
}
