import { CloudTasksClient } from '@google-cloud/tasks';
import logger from '../utils/logger';

interface StatcastTaskPayload {
  year: number;
  startDate: string;
  endDate: string;
  month: string;
}

export class CloudTasksService {
  private client: CloudTasksClient;
  private projectId: string;
  private location: string;
  private queueName: string;

  constructor() {
    this.client = new CloudTasksClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'hankstank';
    this.location = process.env.TASK_QUEUE_LOCATION || 'us-central1';
    this.queueName = process.env.TASK_QUEUE_NAME || 'statcast-collection';
  }

  /**
   * Create a Cloud Task for collecting Statcast data for a specific month
   */
  async createStatcastCollectionTask(
    payload: StatcastTaskPayload,
    delaySeconds: number = 0
  ): Promise<string> {
    const queuePath = this.client.queuePath(
      this.projectId,
      this.location,
      this.queueName
    );

    // Target URL for the task handler endpoint
    const url = `https://${this.projectId}.uc.r.appspot.com/api/sync/statcast/process-task`;

    const task: any = {
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
        },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        oidcToken: {
          serviceAccountEmail: `${this.projectId}@appspot.gserviceaccount.com`,
        },
      },
    };

    // Add delay if specified
    if (delaySeconds > 0) {
      const scheduleTime = new Date();
      scheduleTime.setSeconds(scheduleTime.getSeconds() + delaySeconds);
      task.scheduleTime = {
        seconds: Math.floor(scheduleTime.getTime() / 1000),
      };
    }

    try {
      const [response] = await this.client.createTask({
        parent: queuePath,
        task,
      });

      logger.info(`Created task: ${response.name}`, {
        year: payload.year,
        month: payload.month,
        startDate: payload.startDate,
        endDate: payload.endDate,
      });

      return response.name || '';
    } catch (error) {
      logger.error('Error creating Cloud Task', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });
      throw error;
    }
  }

  /**
   * Create tasks for all months in a season
   */
  async createSeasonCollectionTasks(
    year: number,
    testMode: boolean = false
  ): Promise<string[]> {
    const monthRanges = this.generateMonthlyRanges(year);
    const taskNames: string[] = [];
    
    // Limit to first month for test mode
    const ranges = testMode ? [monthRanges[0]] : monthRanges;

    logger.info(`Creating ${ranges.length} Cloud Tasks for ${year} season`, {
      year,
      testMode,
      totalMonths: ranges.length,
    });

    // Stagger task creation with small delays to avoid rate limits
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const delaySeconds = i * 10; // Stagger by 10 seconds each

      try {
        const taskName = await this.createStatcastCollectionTask(
          {
            year,
            startDate: range.startDate,
            endDate: range.endDate,
            month: range.month,
          },
          delaySeconds
        );
        taskNames.push(taskName);
      } catch (error) {
        logger.error(`Failed to create task for ${year} ${range.month}`, {
          error: error instanceof Error ? error.message : String(error),
          year,
          month: range.month,
        });
        // Continue creating other tasks even if one fails
      }
    }

    logger.info(`Created ${taskNames.length} tasks for ${year}`, {
      year,
      tasksCreated: taskNames.length,
      tasksExpected: ranges.length,
    });

    return taskNames;
  }

  /**
   * Generate monthly date ranges for MLB season
   * Same logic as StatcastCollectorService
   */
  private generateMonthlyRanges(year: number): Array<{
    startDate: string;
    endDate: string;
    month: string;
  }> {
    const ranges = [];

    // MLB regular season runs roughly March 20 - October 1
    const seasonStart = new Date(year, 2, 20); // March 20
    const seasonEnd = new Date(year, 9, 1); // October 1

    let currentDate = new Date(seasonStart);

    while (currentDate < seasonEnd) {
      const monthStart = new Date(currentDate);
      const monthEnd = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth() + 1,
        0
      );

      // Don't go past season end
      if (monthEnd > seasonEnd) {
        monthEnd.setTime(seasonEnd.getTime());
      }

      const month = monthStart.toLocaleString('en-US', { month: 'long' });

      ranges.push({
        startDate: this.formatDate(monthStart),
        endDate: this.formatDate(monthEnd),
        month: month,
      });

      // Move to next month
      currentDate = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth() + 1,
        1
      );
    }

    return ranges;
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get queue stats for monitoring
   */
  async getQueueStats(): Promise<any> {
    const queuePath = this.client.queuePath(
      this.projectId,
      this.location,
      this.queueName
    );

    try {
      const [queue] = await this.client.getQueue({ name: queuePath });
      return {
        name: queue.name,
        state: queue.state,
        rateLimits: queue.rateLimits,
        retryConfig: queue.retryConfig,
      };
    } catch (error) {
      logger.error('Error getting queue stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export default new CloudTasksService();
