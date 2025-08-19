/**
 * Data Source Service - Intelligent routing between historical and live data
 * 
 * This service decides whether to fetch data from:
 * 1. GCP BigQuery/Cloud Storage (for historical data)
 * 2. MLB-StatsAPI (for current/live data)
 * 3. Cache (for frequently accessed data)
 */

import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { mlbApi } from './mlb-api.service';
import { cacheService } from './cache.service';
import { logger } from '../utils/logger';
import { gcpConfig, validateGCPConfig } from '../config/gcp.config';

export interface DataSourceConfig {
  currentSeason: number;
  historicalDataCutoff: number; // Years to consider as historical
  gcpProjectId: string;
  gcpBucketName: string;
  bigQueryDataset: string;
}

export interface DataRequest {
  season?: number;
  teamId?: number;
  playerId?: number;
  dataType: 'team-stats' | 'player-stats' | 'schedule' | 'roster' | 'standings' | 'news' | 'reports' | 'analysis';
  statType?: 'batting' | 'pitching' | 'fielding';
}

export class DataSourceService {
  private bigquery: BigQuery | null = null;
  private storage: Storage | null = null;
  private config: DataSourceConfig;
  private gcpEnabled: boolean = false;

  constructor() {
    // Validate GCP configuration
    const validation = validateGCPConfig();
    
    if (!validation.isValid) {
      logger.warn('GCP configuration not available, running in development mode', { 
        errors: validation.errors 
      });
      this.gcpEnabled = false;
    } else {
      this.gcpEnabled = true;
      
      // Initialize GCP clients
      const gcpOptions: any = {
        projectId: gcpConfig.projectId,
      };

      if (gcpConfig.auth.keyFilename) {
        gcpOptions.keyFilename = gcpConfig.auth.keyFilename;
      }

      this.bigquery = new BigQuery(gcpOptions);
      this.storage = new Storage(gcpOptions);
    }
    
    // Use configuration from gcp.config.ts
    this.config = {
      currentSeason: gcpConfig.dataSource.currentSeason,
      historicalDataCutoff: gcpConfig.dataSource.historicalDataCutoff,
      gcpProjectId: gcpConfig.projectId,
      gcpBucketName: gcpConfig.storage.bucketName,
      bigQueryDataset: gcpConfig.bigQuery.dataset
    };

    logger.info('DataSourceService initialized', { 
      gcpEnabled: this.gcpEnabled,
      projectId: this.config.gcpProjectId,
      bucket: this.config.gcpBucketName,
      dataset: this.config.bigQueryDataset
    });
  }

  /**
   * Main method to get data from appropriate source
   */
  async getData(request: DataRequest): Promise<any> {
    const season = request.season || this.config.currentSeason;
    const cacheKey = this.generateCacheKey(request);
    
    try {
      // Try cache first
      const cachedData = await cacheService.get(cacheKey);
      if (cachedData) {
        logger.info('Data served from cache', { cacheKey, dataType: request.dataType });
        return cachedData;
      }

      let data: any;
      
      // Determine data source based on season and data type
      if (this.shouldUseHistoricalData(season, request.dataType)) {
        logger.info('Fetching from historical data source', { season, dataType: request.dataType });
        data = await this.getHistoricalData(request);
      } else {
        logger.info('Fetching from live MLB API', { season, dataType: request.dataType });
        data = await this.getLiveData(request);
      }

      // Cache the result with appropriate TTL
      const ttl = this.getCacheTTL(season, request.dataType);
      await cacheService.set(cacheKey, data, ttl);

      return data;
      
    } catch (error) {
      logger.error('Error in data source service', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        request 
      });
      throw error;
    }
  }

  /**
   * Determine if we should use historical data sources
   */
  private shouldUseHistoricalData(season: number, dataType: string): boolean {
    // If GCP is not enabled, always use live data
    if (!this.gcpEnabled) {
      logger.info('GCP not available, using live data', { season, dataType });
      return false;
    }

    const currentSeason = this.config.currentSeason;
    const yearsOld = currentSeason - season;
    
    // Always use historical for data older than cutoff
    if (yearsOld > this.config.historicalDataCutoff) {
      return true;
    }

    // For current season, use live data for dynamic content
    if (season === currentSeason) {
      return ['schedule', 'roster', 'standings'].includes(dataType) ? false : true;
    }

    // For recent seasons (1-2 years old), prefer historical for performance
    return true;
  }

  /**
   * Fetch data from GCP BigQuery or Cloud Storage
   */
  private async getHistoricalData(request: DataRequest): Promise<any> {
    const { season, teamId, dataType, statType } = request;

    try {
      // For file-based data (like news, some stats)
      if (this.isFileBased(dataType)) {
        return await this.getFromCloudStorage(request);
      }

      // For structured data (team/player stats)
      return await this.getFromBigQuery(request);
      
    } catch (error) {
      logger.warn('Historical data not found, falling back to live API', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        request 
      });
      // Fallback to live data if historical data is not available
      return await this.getLiveData(request);
    }
  }

  /**
   * Fetch from Cloud Storage
   */
  private async getFromCloudStorage(request: DataRequest): Promise<any> {
    if (!this.storage) {
      throw new Error('Cloud Storage not available - GCP not configured');
    }

    const fileName = this.generateStorageFileName(request);
    const bucket = this.storage.bucket(this.config.gcpBucketName);
    const file = bucket.file(fileName);

    try {
      const [fileContents] = await file.download();
      return JSON.parse(fileContents.toString());
    } catch (error) {
      throw new Error(`File not found in storage: ${fileName}`);
    }
  }

  /**
   * Fetch from BigQuery
   */
  private async getFromBigQuery(request: DataRequest): Promise<any> {
    if (!this.bigquery) {
      throw new Error('BigQuery not available - GCP not configured');
    }

    const { season, teamId, dataType, statType } = request;
    const tableName = this.generateTableName(request);
    
    let query = '';
    const options = {
      query: '',
      location: gcpConfig.bigQuery.location,
      jobTimeoutMs: gcpConfig.bigQuery.jobTimeoutMs,
    };

    // Build query based on request type
    switch (dataType) {
      case 'team-stats':
        if (teamId) {
          query = `
            SELECT * FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.${tableName}\`
            WHERE team_id = ${teamId}
            ORDER BY date_created DESC
            LIMIT 100
          `;
        } else {
          query = `
            SELECT * FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.${tableName}\`
            ORDER BY date_created DESC
            LIMIT 100
          `;
        }
        break;

      case 'player-stats':
        query = `
          SELECT * FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.${tableName}\`
          ${teamId ? `WHERE team_id = ${teamId}` : ''}
          ORDER BY date_created DESC
          LIMIT 500
        `;
        break;

      default:
        throw new Error(`Unsupported data type for BigQuery: ${dataType}`);
    }

    options.query = query;

    const [job] = await this.bigquery.createQueryJob(options);
    const [rows] = await job.getQueryResults();

    logger.info('BigQuery data fetched', { 
      tableName, 
      rowCount: rows.length,
      jobId: job.id 
    });

    return rows;
  }

  /**
   * Fetch from live MLB API
   */
  private async getLiveData(request: DataRequest): Promise<any> {
    const { season, teamId, dataType } = request;

    switch (dataType) {
      case 'team-stats':
        if (teamId) {
          return await mlbApi.getTeamStats(teamId, season);
        }
        return await mlbApi.getAllTeams(season);

      case 'roster':
        if (!teamId) throw new Error('Team ID required for roster data');
        return await mlbApi.getTeamRoster(teamId, season);

      case 'schedule':
        if (!teamId) throw new Error('Team ID required for schedule data');
        return await mlbApi.getSchedule(teamId.toString(), season?.toString());

      case 'standings':
        return await mlbApi.getStandings(season);

      default:
        throw new Error(`Unsupported data type for live API: ${dataType}`);
    }
  }

  /**
   * Helper methods
   */
  private generateCacheKey(request: DataRequest): string {
    const { season, teamId, playerId, dataType, statType } = request;
    return `data:${dataType}:${statType || 'all'}:${season}:${teamId || 'all'}:${playerId || 'all'}`;
  }

  private getCacheTTL(season: number, dataType: string): number {
    const currentSeason = this.config.currentSeason;
    
    // Historical data (older seasons) - use configured TTL
    if (season < currentSeason - 1) {
      return gcpConfig.dataSource.cacheTTL.historical;
    }

    // Current season dynamic data - use shorter TTLs
    if (season === currentSeason) {
      switch (dataType) {
        case 'schedule':
        case 'standings':
          return gcpConfig.dataSource.cacheTTL.live; // 10 minutes
        case 'roster':
          return gcpConfig.dataSource.cacheTTL.current; // 30 minutes
        default:
          return gcpConfig.dataSource.cacheTTL.current; // 30 minutes
      }
    }

    // Recent season data - use current TTL
    return gcpConfig.dataSource.cacheTTL.current;
  }

  private isFileBased(dataType: string): boolean {
    return ['news', 'reports', 'analysis'].includes(dataType);
  }

  private generateStorageFileName(request: DataRequest): string {
    const { season, dataType, teamId } = request;
    
    // Examples of your existing file structure
    switch (dataType) {
      case 'news':
        return teamId ? `${season}/team_${teamId}_news.json` : `${season}/mlb_news.json`;
      default:
        return `${season}/${dataType}.json`;
    }
  }

  private generateTableName(request: DataRequest): string {
    const { season, dataType, statType } = request;
    
    // Based on your existing table naming convention
    switch (dataType) {
      case 'team-stats':
        return `${season}_team${statType ? statType.charAt(0).toUpperCase() + statType.slice(1) : 'Batting'}`;
      case 'player-stats':
        return `${season}_player${statType ? statType.charAt(0).toUpperCase() + statType.slice(1) : 'Batting'}`;
      default:
        return `${season}_${dataType}`;
    }
  }

  /**
   * Method to sync historical data from MLB API to GCP
   * This can be run periodically to update your historical data store
   */
  async syncHistoricalData(season: number, dataTypes: Array<DataRequest['dataType']> = ['team-stats', 'player-stats']): Promise<void> {
    logger.info('Starting historical data sync', { season, dataTypes });

    for (const dataType of dataTypes) {
      try {
        // Fetch from MLB API
        const liveData = await this.getLiveData({ season, dataType });
        
        // Store to BigQuery (you would implement the insert logic)
        await this.storeHistoricalData(season, dataType, liveData);
        
        logger.info('Historical data synced', { season, dataType });
      } catch (error) {
        logger.error('Error syncing historical data', { 
          season, 
          dataType, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }
  }

  private async storeHistoricalData(season: number, dataType: string, data: any): Promise<void> {
    // Implementation for storing data to BigQuery
    // This would involve creating proper table schemas and inserting data
    // You can implement this based on your existing data structure
    logger.info('Storing historical data', { season, dataType, recordCount: Array.isArray(data) ? data.length : 1 });
  }
}

export const dataSourceService = new DataSourceService();
