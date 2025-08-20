/**
 * Scheduler Service - Handles scheduled tasks
 * Manages news fetching at 8 AM and 8 PM daily
 */

import * as cron from 'node-cron';
import { newsService } from './news.service';
import { logger } from '../utils/logger';

export class SchedulerService {
  private newsJobInitialized = false;

  constructor() {
    this.initializeScheduledJobs();
  }

  /**
   * Initialize all scheduled jobs
   */
  private initializeScheduledJobs(): void {
    this.scheduleNewsJob();
    logger.info('Scheduler service initialized');
  }

  /**
   * Schedule news fetching job
   * Runs at 8 AM and 8 PM UTC daily
   */
  private scheduleNewsJob(): void {
    if (this.newsJobInitialized) {
      logger.warn('News job already initialized');
      return;
    }

    // Schedule for 8 AM and 8 PM UTC (0 8,20 * * *)
    const cronPattern = process.env.NEWS_FETCH_SCHEDULE || '0 8,20 * * *';
    
    try {
      cron.schedule(cronPattern, async () => {
        logger.info('Starting scheduled news fetch job');
        
        try {
          await newsService.scheduledNewsFetch();
          logger.info('Scheduled news fetch job completed successfully');
        } catch (error) {
          logger.error('Error in scheduled news fetch job', {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }, {
        timezone: 'UTC'
      });

      this.newsJobInitialized = true;
      logger.info('News fetch job scheduled', { 
        pattern: cronPattern,
        timezone: 'UTC',
        description: 'Runs at 8 AM and 8 PM UTC daily'
      });
    } catch (error) {
      logger.error('Failed to schedule news job', {
        error: error instanceof Error ? error.message : 'Unknown error',
        pattern: cronPattern
      });
    }
  }

  /**
   * Validate cron pattern
   */
  private validateCronPattern(pattern: string): boolean {
    return cron.validate(pattern);
  }

  /**
   * Stop all scheduled jobs
   */
  public stopAllJobs(): void {
    cron.getTasks().forEach((task) => {
      task.stop();
    });
    logger.info('All scheduled jobs stopped');
  }

  /**
   * Get status of all scheduled jobs
   */
  public getJobStatus(): Array<{ name: string; running: boolean }> {
    const tasks = cron.getTasks();
    const status: Array<{ name: string; running: boolean }> = [];

    tasks.forEach((task, index) => {
      status.push({
        name: `Job-${index}`,
        running: task.getStatus() === 'scheduled'
      });
    });

    return status;
  }

  /**
   * Manual trigger for testing (development only)
   */
  public async triggerNewsJob(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Manual job trigger not allowed in production');
    }

    logger.info('Manually triggering news job (development mode)');
    await newsService.scheduledNewsFetch();
  }
}

export const schedulerService = new SchedulerService();
