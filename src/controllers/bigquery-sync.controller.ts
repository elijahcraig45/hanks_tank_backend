/**
 * BigQuery Sync Controller
 * Handles API requests for syncing historical data to BigQuery
 */

import { Request, Response } from 'express';
import { bigQuerySyncService } from '../services/bigquery-sync.service';
import { statcastCollectorService } from '../services/statcast-collector.service';
import cloudTasksService from '../services/cloud-tasks.service';
import { gcpConfig } from '../config/gcp.config';
import { logger } from '../utils/logger';

export class BigQuerySyncController {
  
  /**
   * Validate year parameter is within acceptable range for historical data
   * Only completed seasons (minSeason through currentSeason - 1)
   */
  private validateYear(year: string | string[]): { isValid: boolean; yearNum?: number; error?: any } {
    const yearStr = Array.isArray(year) ? year[0] : year;
    const yearNum = parseInt(yearStr);
    const minYear = gcpConfig.dataSource.minSeason;
    const maxYear = gcpConfig.dataSource.currentSeason - 1;
    
    if (isNaN(yearNum) || yearNum < minYear || yearNum > maxYear) {
      return {
        isValid: false,
        error: {
          code: 'INVALID_YEAR',
          message: `Year must be between ${minYear} and ${maxYear} (completed seasons only)`
        }
      };
    }
    
    return { isValid: true, yearNum };
  }
  
  /**
   * GET /api/sync/status
   * Get sync status for all tables
   */
  async getSyncStatus(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Fetching BigQuery sync status');
      
      const status = await bigQuerySyncService.getSyncStatus();
      
      // Calculate summary statistics
      const summary = {
        totalTables: status.length,
        completelysynced: status.filter(s => s.isComplete).length,
        totalMissingYears: status.reduce((sum, s) => sum + s.missingYears.length, 0),
        totalRecords: status.reduce((sum, s) => sum + s.totalRecords, 0)
      };

      res.json({
        success: true,
        summary,
        tables: status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error fetching sync status', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_STATUS_ERROR',
          message: 'Failed to fetch sync status',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/missing
   * Sync all missing data for historical years
   */
  async syncMissingData(req: Request, res: Response): Promise<void> {
    try {
      const { forceRefresh = false, years = [], tables = [] } = req.body;

      logger.info('Starting sync of missing data', { forceRefresh, years, tables });

      // Start sync asynchronously (this can take a while)
      const results = await bigQuerySyncService.syncMissingData({
        forceRefresh,
        years: years.length > 0 ? years : undefined,
        tables: tables.length > 0 ? tables : undefined
      });

      const summary = {
        totalOperations: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        recordsAdded: results.reduce((sum, r) => sum + r.recordsAdded, 0)
      };

      res.json({
        success: true,
        summary,
        results,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing missing data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_ERROR',
          message: 'Failed to sync missing data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/teams/:year
   * Sync teams data for a specific year
   */
  async syncTeams(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing teams data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncTeams(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing teams data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_TEAMS_ERROR',
          message: 'Failed to sync teams data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/team-stats/:year
   * Sync team stats data for a specific year
   */
  async syncTeamStats(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing team stats data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncTeamStats(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing team stats data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_TEAM_STATS_ERROR',
          message: 'Failed to sync team stats data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/player-stats/:year
   * Sync player stats data for a specific year
   */
  async syncPlayerStats(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing player stats data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncPlayerStats(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing player stats data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_PLAYER_STATS_ERROR',
          message: 'Failed to sync player stats data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/standings/:year
   * Sync standings data for a specific year
   */
  async syncStandings(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing standings data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncStandings(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing standings data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_STANDINGS_ERROR',
          message: 'Failed to sync standings data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/rosters/:year
   * Sync rosters data for a specific year
   */
  async syncRosters(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing rosters data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncRosters(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing rosters data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_ROSTERS_ERROR',
          message: 'Failed to sync rosters data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/games/:year
   * Sync games data for a specific year
   */
  async syncGames(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { forceRefresh = false } = req.body;
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Syncing games data for ${yearNum}`, { year: yearNum, forceRefresh });

      const result = await bigQuerySyncService.syncGames(yearNum, forceRefresh);

      res.json({
        success: result.success,
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error syncing games data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_GAMES_ERROR',
          message: 'Failed to sync games data',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/statcast/:year
   * Sync Statcast pitch-by-pitch data for a specific year using Cloud Tasks
   */
  async syncStatcast(req: Request, res: Response): Promise<void> {
    try {
      const { year } = req.params;
      const { test = false } = req.body; // Add test mode for single month
      
      const validation = this.validateYear(year);
      if (!validation.isValid) {
        res.status(400).json({
          success: false,
          error: validation.error
        });
        return;
      }
      const yearNum = validation.yearNum!;

      logger.info(`Creating Cloud Tasks for Statcast data collection: ${yearNum}`, { year: yearNum, test });

      // Create Cloud Tasks for the season (one task per month)
      const taskNames = await cloudTasksService.createSeasonCollectionTasks(yearNum, test);

      const monthCount = test ? 1 : 8; // 8 months in MLB season
      res.json({
        success: true,
        result: {
          year: yearNum,
          tasksCreated: taskNames.length,
          expectedTasks: monthCount,
          message: test 
            ? `Test mode: Created ${taskNames.length} task for ${yearNum}. Collection will complete in ~5-10 minutes.`
            : `Created ${taskNames.length} tasks for ${yearNum} season. Collection will complete in ~2-3 hours. Monitor BigQuery for progress.`,
          queueName: 'statcast-collection'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error creating Statcast collection tasks', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SYNC_STATCAST_ERROR',
          message: 'Failed to create Statcast collection tasks',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * POST /api/sync/statcast/process-task
   * Process a single Statcast collection task (called by Cloud Tasks)
   */
  async processStatcastTask(req: Request, res: Response): Promise<void> {
    try {
      const { year, startDate, endDate, month } = req.body;

      if (!year || !startDate || !endDate) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TASK_PAYLOAD',
            message: 'Task payload must include year, startDate, and endDate'
          }
        });
        return;
      }

      logger.info(`Processing Statcast collection task`, {
        year,
        month,
        startDate,
        endDate
      });

      // Collect data for this specific date range
      const pitches = await statcastCollectorService.collectStatcastData(startDate, endDate);

      if (pitches.length > 0) {
        // Store the collected data
        await statcastCollectorService.storeStatcastData(pitches, year);
        
        logger.info(`Task completed: ${month} ${year}`, {
          year,
          month,
          pitchesCollected: pitches.length,
          dateRange: `${startDate} to ${endDate}`
        });

        res.json({
          success: true,
          result: {
            year,
            month,
            pitchesCollected: pitches.length,
            dateRange: `${startDate} to ${endDate}`
          }
        });
      } else {
        logger.info(`No pitches found for ${month} ${year}`, {
          year,
          month,
          startDate,
          endDate
        });

        res.json({
          success: true,
          result: {
            year,
            month,
            pitchesCollected: 0,
            message: 'No pitches found for this date range'
          }
        });
      }
    } catch (error) {
      logger.error('Error processing Statcast collection task', {
        error: error instanceof Error ? error.message : 'Unknown error',
        body: req.body
      });
      
      // Return 500 so Cloud Tasks will retry
      res.status(500).json({
        success: false,
        error: {
          code: 'TASK_PROCESSING_ERROR',
          message: 'Failed to process Statcast collection task',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }
}

export const bigQuerySyncController = new BigQuerySyncController();
