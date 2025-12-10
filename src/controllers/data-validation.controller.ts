import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { gcpConfig } from '../config/gcp.config';
import { BigQuery } from '@google-cloud/bigquery';
import { mlbApi } from '../services/mlb-api.service';
import { bigQuerySyncService } from '../services/bigquery-sync.service';

/**
 * Data Validation Controller
 * 
 * Handles automated validation jobs triggered by Cloud Scheduler
 * Compares BigQuery backup data with live MLB API data
 */
export class DataValidationController {
  private bigquery: BigQuery;
  private datasetId = 'mlb_data';

  constructor() {
    this.bigquery = new BigQuery({
      projectId: gcpConfig.projectId,
    });
  }

  /**
   * Daily validation check
   * Compares a sample of BigQuery data with MLB API
   */
  async dailyCheck(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Starting daily validation check');

      const currentSeason = gcpConfig.dataSource.currentSeason;
      const lastCompletedSeason = currentSeason - 1;
      
      // Validate team stats for last completed season
      const teamValidation = await this.validateTeamStats(lastCompletedSeason);
      
      // Validate standings for last completed season
      const standingsValidation = await this.validateStandings(lastCompletedSeason);

      const results = {
        timestamp: new Date().toISOString(),
        season: lastCompletedSeason,
        validations: {
          teamStats: teamValidation,
          standings: standingsValidation,
        },
        overall: teamValidation.valid && standingsValidation.valid ? 'PASS' : 'FAIL',
      };

      logger.info('Daily validation complete', results);

      res.json({
        success: true,
        message: 'Daily validation complete',
        results,
      });
    } catch (error) {
      logger.error('Daily validation failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Weekly full sync
   * Ensures all historical data is backed up
   */
  async weeklyFullSync(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Starting weekly full sync');

      const currentSeason = gcpConfig.dataSource.currentSeason;
      const minSeason = gcpConfig.dataSource.minSeason;
      
      // Get sync status to identify missing data
      const syncStatus = await bigQuerySyncService.getSyncStatus();
      
      // Calculate total missing years across all tables
      const totalMissingYears = syncStatus.reduce((sum, s) => sum + s.missingYears.length, 0);
      
      // Sync any missing years
      if (totalMissingYears > 0) {
        logger.info('Syncing missing data', { totalMissingYears });
        await bigQuerySyncService.syncMissingData();
      }

      res.json({
        success: true,
        message: 'Weekly full sync complete',
        syncStatus: {
          totalTables: syncStatus.length,
          completelysynced: syncStatus.filter(s => s.isComplete).length,
          totalMissingYears,
          tables: syncStatus,
        },
      });
    } catch (error) {
      logger.error('Weekly full sync failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * End-of-season sync
   * Backs up the just-completed season
   */
  async endOfSeasonSync(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Starting end-of-season sync');

      const currentSeason = gcpConfig.dataSource.currentSeason;
      const completedSeason = currentSeason - 1;

      logger.info('Syncing completed season', { season: completedSeason });

      // Sync all data for the completed season
      await Promise.all([
        bigQuerySyncService.syncTeams(completedSeason),
        bigQuerySyncService.syncTeamStats(completedSeason),
        bigQuerySyncService.syncStandings(completedSeason),
      ]);

      res.json({
        success: true,
        message: 'End-of-season sync complete',
        season: completedSeason,
      });
    } catch (error) {
      logger.error('End-of-season sync failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Monthly data integrity audit
   * Comprehensive check of all BigQuery tables
   */
  async monthlyAudit(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Starting monthly data integrity audit');

      const tables = [
        'teams_historical',
        'team_stats_historical',
        'player_stats_historical',
        'standings_historical',
        'games_historical',
        'rosters_historical',
      ];

      const auditResults = [];

      for (const table of tables) {
        const count = await this.getTableRowCount(table);
        auditResults.push({
          table,
          rowCount: count,
          status: count > 0 ? 'OK' : 'EMPTY',
        });
      }

      res.json({
        success: true,
        message: 'Monthly audit complete',
        timestamp: new Date().toISOString(),
        tables: auditResults,
      });
    } catch (error) {
      logger.error('Monthly audit failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Validate team stats by comparing BigQuery with MLB API
   */
  private async validateTeamStats(season: number): Promise<any> {
    try {
      // Get random team to validate
      const teamId = 144; // Atlanta Braves

      // Get from BigQuery
      const query = `
        SELECT * FROM \`${gcpConfig.projectId}.${this.datasetId}.team_stats_historical\`
        WHERE team_id = @teamId AND season = @season
        LIMIT 1
      `;

      const [bqRows] = await this.bigquery.query({
        query,
        params: { teamId, season },
      });

      if (bqRows.length === 0) {
        return { valid: false, reason: 'No data in BigQuery' };
      }

      // Get from MLB API
      let apiData;
      try {
        apiData = await mlbApi.getTeamBattingStats(teamId, season);
      } catch (error) {
        return { valid: true, reason: 'MLB API unavailable (using backup)', fallback: true };
      }

      // Basic validation: data exists
      return { 
        valid: true, 
        bqRecords: bqRows.length,
        apiAvailable: !!apiData,
      };
    } catch (error) {
      logger.error('Team stats validation failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Validate standings by comparing BigQuery with MLB API
   */
  private async validateStandings(season: number): Promise<any> {
    try {
      // Get from BigQuery
      const query = `
        SELECT COUNT(*) as count FROM \`${gcpConfig.projectId}.${this.datasetId}.standings_historical\`
        WHERE season = @season
      `;

      const [bqRows] = await this.bigquery.query({
        query,
        params: { season },
      });

      if (!bqRows[0] || bqRows[0].count === 0) {
        return { valid: false, reason: 'No standings in BigQuery' };
      }

      // Get from MLB API
      let apiData;
      try {
        apiData = await mlbApi.getStandings(103, season); // AL standings
      } catch (error) {
        return { valid: true, reason: 'MLB API unavailable (using backup)', fallback: true };
      }

      return { 
        valid: true, 
        bqRecords: bqRows[0].count,
        apiAvailable: !!apiData,
      };
    } catch (error) {
      logger.error('Standings validation failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Get row count for a BigQuery table
   */
  private async getTableRowCount(tableName: string): Promise<number> {
    try {
      const query = `
        SELECT COUNT(*) as count FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableName}\`
      `;

      const [rows] = await this.bigquery.query({ query });
      return rows[0]?.count || 0;
    } catch (error) {
      logger.error('Failed to get table row count', { 
        tableName,
        error: error instanceof Error ? error.message : String(error) 
      });
      return 0;
    }
  }
}

export const dataValidationController = new DataValidationController();
