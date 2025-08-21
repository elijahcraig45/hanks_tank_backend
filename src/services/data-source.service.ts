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
import { fanGraphsService, FanGraphsService } from './fangraphs.service';
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
  dataType: 'team-stats' | 'player-stats' | 'schedule' | 'roster' | 'standings' | 'news' | 'reports' | 'analysis' | 'team-batting' | 'team-pitching' | 'player-batting' | 'player-pitching' | 'available-stats' | 'player-data' | 'statcast';
  statType?: 'batting' | 'pitching' | 'fielding';
  // Additional query parameters for legacy endpoints
  year?: number;
  stats?: string;
  orderBy?: string;
  direction?: string;
  limit?: string;
  position?: string;
  p_throws?: string;
  stands?: string;
  events?: string;
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
    const season = request.season || request.year || this.config.currentSeason;
    
    // Handle player data with special caching strategy (cache raw data, sort locally)
    if (request.dataType === 'player-batting' || request.dataType === 'player-stats') {
      const battingData = await this.getCachedPlayerBattingData(season);
      return this.sortAndLimitPlayerData(battingData, request.orderBy || 'ops', request.direction || 'desc', parseInt(request.limit || '100'));
    }
    
    if (request.dataType === 'player-pitching') {
      const pitchingData = await this.getCachedPlayerPitchingData(season);
      return this.sortAndLimitPlayerData(pitchingData, request.orderBy || 'era', request.direction || 'asc', parseInt(request.limit || '100'));
    }

    // Handle team data with special caching strategy (cache raw data, sort locally)
    if (request.dataType === 'team-batting' || request.dataType === 'team-stats') {
      const teamBattingData = await this.getCachedTeamBattingData(season);
      return this.sortAndLimitTeamData(teamBattingData, request.orderBy || 'avg', request.direction || 'desc', parseInt(request.limit || '30'));
    }
    
    if (request.dataType === 'team-pitching') {
      const teamPitchingData = await this.getCachedTeamPitchingData(season);
      return this.sortAndLimitTeamData(teamPitchingData, request.orderBy || 'era', request.direction || 'asc', parseInt(request.limit || '30'));
    }
    
    // For all other data types, use the original caching approach
    // Update request with computed season for consistent cache key generation
    const requestWithSeason = { ...request, season };
    const cacheKey = this.generateCacheKey(requestWithSeason);
    
    try {
      // Try cache first
      const cachedData = await cacheService.get(cacheKey);
      if (cachedData) {
        logger.info('Data served from cache', { cacheKey, dataType: requestWithSeason.dataType });
        return cachedData;
      }

      let data: any;
      
      // Determine data source based on season and data type
      if (this.shouldUseHistoricalData(season, requestWithSeason.dataType)) {
        logger.info('Fetching from historical data source', { season, dataType: requestWithSeason.dataType });
        data = await this.getHistoricalData(requestWithSeason);
      } else {
        logger.info('Fetching from live MLB API', { season, dataType: requestWithSeason.dataType });
        data = await this.getLiveData(requestWithSeason);
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
    // If GCP is not enabled, always use live data or FanGraphs fallback
    if (!this.gcpEnabled) {
      logger.info('GCP not available, using live data or FanGraphs fallback', { season, dataType });
      return false;
    }

    const currentSeason = this.config.currentSeason;
    const yearsOld = currentSeason - season;
    
    // Data types we have historical data for (2015-2024)
    const historicalDataTypes = ['team-stats', 'team-batting', 'team-pitching', 'standings'];
    
    // Player data types that should use MLB API (no historical player data yet)
    const playerDataTypes = ['player-stats', 'player-batting', 'player-pitching', 'roster'];
    
    // Check if this is a data type we have historical data for
    if (!historicalDataTypes.includes(dataType)) {
      logger.info('Data type not available in historical data, using MLB API', { dataType, season });
      return false;
    }
    
    // Check if the requested season is within our historical data range (2015-2024)
    if (season < 2015 || season > 2024) {
      logger.info('Season outside historical data range (2015-2024), using MLB API', { season, dataType });
      return false;
    }
    
    // For current season (2025), always use MLB API for live data
    if (season === currentSeason) {
      logger.info('Current season requested, using MLB API for live data', { season, dataType });
      return false;
    }

    // For seasons 2015-2024, use historical data for team stats
    logger.info('Using historical data for team stats', { season, dataType });
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
   * Fetch from BigQuery - Updated for our historical data tables
   */
  private async getFromBigQuery(request: DataRequest): Promise<any> {
    if (!this.bigquery) {
      throw new Error('BigQuery not available - GCP not configured');
    }

    const { season, teamId, dataType, statType, year } = request;
    const requestYear = year || season || this.config.currentSeason;
    
    let query = '';
    const options = {
      query: '',
      location: gcpConfig.bigQuery.location,
      jobTimeoutMs: gcpConfig.bigQuery.jobTimeoutMs,
    };

    // Build query based on request type using our actual historical data tables
    switch (dataType) {
      case 'team-stats':
      case 'team-batting':
        query = `
          SELECT 
            team_id, team_name, year, games_played,
            at_bats, runs, hits, doubles, triples, home_runs, rbi,
            stolen_bases, caught_stealing, walks, strikeouts, 
            batting_avg, obp, slg, ops, total_bases, hit_by_pitch,
            sac_flies, sac_bunts, left_on_base
          FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.team_stats_historical\`
          WHERE year = ${requestYear} AND stat_type = 'batting'
          ${teamId ? `AND team_id = ${teamId}` : ''}
          ORDER BY team_name
        `;
        break;

      case 'team-pitching':
        query = `
          SELECT 
            team_id, team_name, year, games_played,
            wins, losses, win_percentage, era, games_started, games_finished,
            complete_games, shutouts, saves, save_opportunities, holds, blown_saves,
            innings_pitched, hits_allowed, runs_allowed, earned_runs, 
            home_runs_allowed, walks_allowed, whip, batters_faced,
            wild_pitches, hit_batsmen, balks
          FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.team_stats_historical\`
          WHERE year = ${requestYear} AND stat_type = 'pitching'
          ${teamId ? `AND team_id = ${teamId}` : ''}
          ORDER BY team_name
        `;
        break;

      case 'player-stats':
      case 'player-batting':
        // For player stats, fallback to MLB API since we don't have player historical data yet
        throw new Error('Player stats not available in historical data - using MLB API fallback');

      case 'player-pitching':
        // For player stats, fallback to MLB API since we don't have player historical data yet
        throw new Error('Player pitching not available in historical data - using MLB API fallback');

      case 'standings':
        query = `
          SELECT * FROM \`${this.config.gcpProjectId}.${this.config.bigQueryDataset}.standings_historical\`
          WHERE year = ${requestYear}
          ORDER BY league_id, division_id, games_back
        `;
        break;

      case 'roster':
        // For rosters, fallback to MLB API for most current data
        throw new Error('Roster data not available in historical data - using MLB API fallback');

      default:
        throw new Error(`Unsupported data type for BigQuery: ${dataType}`);
    }

    options.query = query;

    try {
      const [job] = await this.bigquery.createQueryJob(options);
      const [rows] = await job.getQueryResults();

      logger.info('BigQuery data fetched', { 
        dataType,
        year: requestYear,
        rowCount: rows.length,
        jobId: job.id 
      });

      // Transform the data to match frontend expectations
      const transformedData = this.transformBigQueryData(rows, dataType);
      return transformedData;
    } catch (error) {
      logger.error('BigQuery query failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query: query.substring(0, 200) + '...',
        dataType,
        year: requestYear
      });
      throw error;
    }
  }

  /**
   * Transform BigQuery data to match frontend expectations
   */
  private transformBigQueryData(rows: any[], dataType: string): any[] {
    return rows.map(row => {
      if (dataType === 'team-batting' || dataType === 'team-stats') {
        return {
          Team: row.team_name || row.Team,
          G: row.games_played || row.G,
          AB: row.at_bats || row.AB,
          R: row.runs || row.R,
          H: row.hits || row.H,
          '2B': row.doubles || row['2B'],
          '3B': row.triples || row['3B'],
          HR: row.home_runs || row.HR,
          RBI: row.rbi || row.RBI,
          SB: row.stolen_bases || row.SB,
          CS: row.caught_stealing || row.CS,
          BB: row.walks || row.BB,
          SO: row.strikeouts || row.SO,
          AVG: row.batting_avg || row.AVG,
          OBP: row.obp || row.OBP,
          SLG: row.slg || row.SLG,
          OPS: row.ops || row.OPS,
          TB: row.total_bases || row.TB,
          HBP: row.hit_by_pitch || row.HBP,
          SF: row.sac_flies || row.SF,
          SH: row.sac_bunts || row.SH,
          LOB: row.left_on_base || row.LOB,
          team_id: row.team_id,
          year: row.year
        };
      } else if (dataType === 'team-pitching') {
        return {
          Team: row.team_name || row.Team,
          W: row.wins || row.W,
          L: row.losses || row.L,
          'W-L%': row.win_percentage || row['W-L%'],
          ERA: row.era || row.ERA,
          GS: row.games_started || row.GS,
          GF: row.games_finished || row.GF,
          CG: row.complete_games || row.CG,
          SHO: row.shutouts || row.SHO,
          SV: row.saves || row.SV,
          SVO: row.save_opportunities || row.SVO,
          HLD: row.holds || row.HLD,
          BS: row.blown_saves || row.BS,
          IP: row.innings_pitched || row.IP,
          H: row.hits_allowed || row.H,
          R: row.runs_allowed || row.R,
          ER: row.earned_runs || row.ER,
          HR: row.home_runs_allowed || row.HR,
          BB: row.walks_allowed || row.BB,
          WHIP: row.whip || row.WHIP,
          BF: row.batters_faced || row.BF,
          WP: row.wild_pitches || row.WP,
          HBP: row.hit_batsmen || row.HBP,
          BK: row.balks || row.BK,
          team_id: row.team_id,
          year: row.year
        };
      } else {
        // For other data types, return as-is
        return row;
      }
    });
  }

  /**
   * Transform MLB API team stats to match frontend expectations
   */
  private transformMLBTeamStats(splitObj: any, dataType: string): any {
    if (!splitObj || !splitObj.stat) {
      return {};
    }

    const stats = splitObj.stat;
    
    if (dataType === 'team-batting') {
      return {
        G: stats.gamesPlayed || 0,
        AB: stats.atBats || 0,
        R: stats.runs || 0,
        H: stats.hits || 0,
        '2B': stats.doubles || 0,
        '3B': stats.triples || 0,
        HR: stats.homeRuns || 0,
        RBI: stats.rbi || 0,
        SB: stats.stolenBases || 0,
        CS: stats.caughtStealing || 0,
        BB: stats.baseOnBalls || 0,
        SO: stats.strikeOuts || 0,
        AVG: stats.avg || '0.000',
        OBP: stats.obp || '0.000',
        SLG: stats.slg || '0.000',
        OPS: stats.ops || '0.000',
        TB: stats.totalBases || 0,
        HBP: stats.hitByPitch || 0,
        SF: stats.sacFlies || 0,
        SH: stats.sacBunts || 0,
        LOB: stats.leftOnBase || 0
      };
    } else if (dataType === 'team-pitching') {
      return {
        G: stats.gamesPlayed || 0,
        W: stats.wins || 0,
        L: stats.losses || 0,
        'W-L%': stats.winPercentage || '0.000',
        ERA: stats.era || '0.00',
        GS: stats.gamesStarted || 0,
        GF: stats.gamesFinished || 0,
        CG: stats.completeGames || 0,
        SHO: stats.shutouts || 0,
        SV: stats.saves || 0,
        SVO: stats.saveOpportunities || 0,
        HLD: stats.holds || 0,
        BS: stats.blownSaves || 0,
        IP: stats.inningsPitched || '0.0',
        H: stats.hits || 0,
        R: stats.runs || 0,
        ER: stats.earnedRuns || 0,
        HR: stats.homeRuns || 0,
        BB: stats.baseOnBalls || 0,
        WHIP: stats.whip || '0.00',
        BF: stats.battersFaced || 0,
        WP: stats.wildPitches || 0,
        HBP: stats.hitBatsmen || 0,
        BK: stats.balks || 0
      };
    }
    
    return {};
  }

  /**
   * Map frontend stat names to MLB API stat names
   */
  private mapStatNameToMLBAPI(statName: string, dataType: 'batting' | 'pitching'): string {
    if (dataType === 'batting') {
      const battingStatMap: Record<string, string> = {
        'avg': 'avg',
        'hr': 'homeRuns',
        'rbi': 'rbi',
        'ops': 'ops',
        'obp': 'onBasePercentage',
        'slg': 'sluggingPercentage',
        'runs': 'runs',
        'hits': 'hits',
        'doubles': 'doubles',
        'triples': 'triples',
        'homeRuns': 'homeRuns',
        'strikeouts': 'strikeOuts',
        'walks': 'baseOnBalls',
        'stolenBases': 'stolenBases'
      };
      return battingStatMap[statName.toLowerCase()] || statName;
    } else {
      const pitchingStatMap: Record<string, string> = {
        'era': 'era',
        'whip': 'whip',
        'wins': 'wins',
        'losses': 'losses',
        'saves': 'saves',
        'strikeouts': 'strikeOuts',
        'walks': 'baseOnBalls',
        'innings': 'inningsPitched',
        'hits': 'hits',
        'homeruns': 'homeRuns',
        'earnedRuns': 'earnedRuns'
      };
      return pitchingStatMap[statName.toLowerCase()] || statName;
    }
  }

  /**
   * Transform MLB API player stats to match frontend expectations
   */
  private transformMLBPlayerStats(stats: any, dataType: string): any {
    if (!stats) {
      return {};
    }
    
    if (dataType === 'batting') {
      return {
        G: stats.gamesPlayed || 0,
        AB: stats.atBats || 0,
        R: stats.runs || 0,
        H: stats.hits || 0,
        '2B': stats.doubles || 0,
        '3B': stats.triples || 0,
        HR: stats.homeRuns || 0,
        RBI: stats.rbi || 0,
        SB: stats.stolenBases || 0,
        CS: stats.caughtStealing || 0,
        BB: stats.baseOnBalls || 0,
        SO: stats.strikeOuts || 0,
        AVG: stats.avg || '0.000',
        OBP: stats.obp || '0.000',
        SLG: stats.slg || '0.000',
        OPS: stats.ops || '0.000',
        TB: stats.totalBases || 0,
        HBP: stats.hitByPitch || 0,
        SF: stats.sacFlies || 0,
        SH: stats.sacBunts || 0,
        BABIP: stats.babip || '0.000',
        PA: stats.plateAppearances || 0
      };
    } else if (dataType === 'pitching') {
      return {
        G: stats.gamesPitched || stats.gamesPlayed || 0,
        GS: stats.gamesStarted || 0,
        W: stats.wins || 0,
        L: stats.losses || 0,
        SV: stats.saves || 0,
        IP: stats.inningsPitched || '0.0',
        H: stats.hits || 0,
        R: stats.runs || 0,
        ER: stats.earnedRuns || 0,
        HR: stats.homeRuns || 0,
        BB: stats.baseOnBalls || 0,
        SO: stats.strikeOuts || 0,
        ERA: stats.era || '0.00',
        WHIP: stats.whip || '0.00',
        'K/9': stats.strikeoutsPer9Inn || '0.00',
        'BB/9': stats.walksPer9Inn || '0.00',
        'HR/9': stats.homeRunsPer9 || '0.00',
        BF: stats.battersFaced || 0,
        HBP: stats.hitBatsmen || 0,
        WP: stats.wildPitches || 0,
        BK: stats.balks || 0
      };
    }
    
    return {};
  }

  /**
   * Fetch from live MLB API or FanGraphs (fallback)
   */
  private async getLiveData(request: DataRequest): Promise<any> {
    const { season, teamId, dataType, playerId, position, year, stats, orderBy, direction, p_throws, stands, events } = request;

    // Handle FanGraphs-specific endpoints that we don't have historical data for
    switch (dataType) {
      case 'player-data':
        if (!playerId) throw new Error('Player ID required for player data');
        return await fanGraphsService.getPlayerData({ 
          playerId: playerId.toString(), 
          position 
        });

      case 'statcast':
        return await fanGraphsService.getStatcastData({
          year: (year || season)?.toString(),
          position,
          playerId: playerId?.toString(),
          p_throws,
          stands,
          events
        });

      case 'available-stats':
        // Return available stats for the requested data type
        return await fanGraphsService.getAvailableStats(stats || 'team-batting');

      // MLB API endpoints
      case 'team-stats':
      case 'team-batting':
      case 'team-pitching':
        if (teamId) {
          // Get stats for a specific team
          const statType = dataType === 'team-pitching' ? 'pitching' : 'hitting';
          if (statType === 'pitching') {
            return await mlbApi.getTeamPitchingStats(teamId, season);
          } else {
            return await mlbApi.getTeamBattingStats(teamId, season);
          }
        } else {
          // Get stats for all teams
          const allTeams = await mlbApi.getAllTeams(season);
          const teamStats = [];
          
          // Fetch stats for each team
          for (const team of allTeams.teams) {
            try {
              const statType = dataType === 'team-pitching' ? 'pitching' : 'hitting';
              let stats;
              if (statType === 'pitching') {
                stats = await mlbApi.getTeamPitchingStats(team.id, season);
              } else {
                stats = await mlbApi.getTeamBattingStats(team.id, season);
              }
              
              if (stats && stats.stats && stats.stats.length > 0 && stats.stats[0].splits && stats.stats[0].splits.length > 0) {
                // Transform the stats to match our expected format
                const teamStatData = {
                  Team: team.name,
                  team_id: team.id,
                  year: season,
                  ...this.transformMLBTeamStats(stats.stats[0].splits[0], dataType)
                };
                teamStats.push(teamStatData);
              }
            } catch (error) {
              logger.warn(`Failed to get stats for team ${team.name}`, { 
                teamId: team.id, 
                error: error instanceof Error ? error.message : 'Unknown error' 
              });
              // Continue with other teams even if one fails
            }
          }
          
          return teamStats;
        }

      case 'roster':
        if (!teamId) throw new Error('Team ID required for roster data');
        return await mlbApi.getTeamRoster(teamId, season);

      case 'schedule':
        if (!teamId) throw new Error('Team ID required for schedule data');
        return await mlbApi.getSchedule(teamId.toString(), season?.toString());

      case 'standings':
        // MLB API requires leagueId parameter - need both AL (103) and NL (104) for complete standings
        const [alStandings, nlStandings] = await Promise.all([
          mlbApi.getStandings(103, season), // American League
          mlbApi.getStandings(104, season)  // National League
        ]);
        
        // Combine standings from both leagues
        const combinedStandings: any = {
          records: []
        };
        
        if (alStandings && alStandings.records) {
          combinedStandings.records.push(...alStandings.records);
        }
        
        if (nlStandings && nlStandings.records) {
          combinedStandings.records.push(...nlStandings.records);
        }
        
        return combinedStandings;

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

  /**
   * Get cached player batting data (unsorted, large dataset)
   */
  private async getCachedPlayerBattingData(season: number): Promise<any[]> {
    const cacheKey = `player-batting-raw-${season}`;
    
    // Check cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData && Array.isArray(cachedData)) {
      logger.info('Retrieved cached player batting data', { season, count: cachedData.length });
      return cachedData;
    }

    // Fetch large dataset from MLB API (no sorting, large limit)
    logger.info('Fetching fresh player batting data from MLB API', { season });
    const battingLeaderboard = await mlbApi.getPlayerBattingLeaderboard(
      season, 
      1000, // Large limit to get comprehensive data including non-qualified players
      'ops', // Default sort for API call (we'll sort locally)
      'desc'
    );

    // Transform and cache the raw data
    if (battingLeaderboard && battingLeaderboard.stats && battingLeaderboard.stats[0] && battingLeaderboard.stats[0].splits) {
      const playerStats = battingLeaderboard.stats[0].splits.map((split: any) => ({
        Name: split.player.fullName,
        playerId: split.player.id,
        Team: split.team.name,
        ...this.transformMLBPlayerStats(split.stat, 'batting')
      }));
      
      // Cache for 1 hour
      await cacheService.set(cacheKey, playerStats, 3600);
      logger.info('Cached player batting data', { season, count: playerStats.length });
      
      return playerStats;
    }
    
    return [];
  }

  /**
   * Get cached player pitching data (unsorted, large dataset)
   */
  private async getCachedPlayerPitchingData(season: number): Promise<any[]> {
    const cacheKey = `player-pitching-raw-${season}`;
    
    // Check cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData && Array.isArray(cachedData)) {
      logger.info('Retrieved cached player pitching data', { season, count: cachedData.length });
      return cachedData;
    }

    // Fetch large dataset from MLB API (no sorting, large limit)
    logger.info('Fetching fresh player pitching data from MLB API', { season });
    const pitchingLeaderboard = await mlbApi.getPlayerPitchingLeaderboard(
      season,
      1000, // Large limit to get comprehensive data including non-qualified players
      'era', // Default sort for API call (we'll sort locally)
      'asc'
    );

    // Transform and cache the raw data
    if (pitchingLeaderboard && pitchingLeaderboard.stats && pitchingLeaderboard.stats[0] && pitchingLeaderboard.stats[0].splits) {
      const playerStats = pitchingLeaderboard.stats[0].splits.map((split: any) => ({
        Name: split.player.fullName,
        playerId: split.player.id,
        Team: split.team.name,
        ...this.transformMLBPlayerStats(split.stat, 'pitching')
      }));
      
      // Cache for 1 hour
      await cacheService.set(cacheKey, playerStats, 3600);
      logger.info('Cached player pitching data', { season, count: playerStats.length });
      
      return playerStats;
    }
    
    return [];
  }

  /**
   * Sort and limit player data in backend
   */
  private sortAndLimitPlayerData(data: any[], sortField: string, direction: string, limit: number): any[] {
    if (!data || data.length === 0) {
      return [];
    }

    logger.info('Sorting player data locally', { 
      sortField, 
      direction, 
      limit, 
      totalRecords: data.length 
    });

    // Map frontend field names to actual data field names
    const fieldMappings: { [key: string]: string } = {
      'avg': 'AVG',
      'homeRuns': 'HR',
      'rbi': 'RBI',
      'ops': 'OPS',
      'obp': 'OBP',
      'slg': 'SLG',
      'runs': 'R',
      'hits': 'H',
      'doubles': '2B',
      'triples': '3B',
      'stolenBases': 'SB',
      'strikeoutsBatting': 'SO', // batting strikeouts
      'walks': 'BB',
      'era': 'ERA',
      'whip': 'WHIP',
      'strikeoutsPitching': 'SO', // pitching strikeouts
      'wins': 'W',
      'saves': 'SV',
      'innings': 'IP',
      'fip': 'FIP'
    };

    const actualField = fieldMappings[sortField] || sortField.toUpperCase();
    
    // Sort the data
    const sortedData = [...data].sort((a, b) => {
      let aVal = a[actualField];
      let bVal = b[actualField];
      
      // Handle string numbers (remove commas, convert to number)
      if (typeof aVal === 'string') {
        aVal = parseFloat(aVal.replace(/,/g, '')) || 0;
      }
      if (typeof bVal === 'string') {
        bVal = parseFloat(bVal.replace(/,/g, '')) || 0;
      }
      
      // Handle null/undefined values
      if (aVal == null) aVal = direction === 'desc' ? -Infinity : Infinity;
      if (bVal == null) bVal = direction === 'desc' ? -Infinity : Infinity;
      
      // Sort direction
      return direction === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Add rank and limit
    const limitedData = sortedData.slice(0, limit).map((player, index) => ({
      ...player,
      rank: index + 1
    }));

    logger.info('Data sorted and limited', { 
      actualField, 
      direction, 
      originalCount: data.length, 
      finalCount: limitedData.length 
    });

    return limitedData;
  }

  /**
   * Get cached team batting data (unsorted, all teams)
   */
  private async getCachedTeamBattingData(season: number): Promise<any[]> {
    const cacheKey = `team-batting-raw-${season}`;
    
    // Check cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData && Array.isArray(cachedData)) {
      logger.info('Retrieved cached team batting data', { season, count: cachedData.length });
      return cachedData;
    }

    // Fetch fresh data from MLB API
    logger.info('Fetching fresh team batting data from MLB API', { season });
    const allTeams = await mlbApi.getAllTeams(season);
    const teamStats = [];
    
    // Fetch stats for each team
    for (const team of allTeams.teams) {
      try {
        const stats = await mlbApi.getTeamBattingStats(team.id, season);
        
        if (stats && stats.stats && stats.stats.length > 0 && stats.stats[0].splits && stats.stats[0].splits.length > 0) {
          // Transform the stats to match our expected format
          const teamStatData = {
            Team: team.name,
            team_id: team.id,
            year: season,
            ...this.transformMLBTeamStats(stats.stats[0].splits[0], 'team-batting')
          };
          teamStats.push(teamStatData);
        }
      } catch (error) {
        logger.warn(`Failed to get batting stats for team ${team.name}`, { 
          teamId: team.id, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        // Continue with other teams even if one fails
      }
    }
    
    // Cache for 1 hour
    await cacheService.set(cacheKey, teamStats, 3600);
    logger.info('Cached team batting data', { season, count: teamStats.length });
    
    return teamStats;
  }

  /**
   * Get cached team pitching data (unsorted, all teams)
   */
  private async getCachedTeamPitchingData(season: number): Promise<any[]> {
    const cacheKey = `team-pitching-raw-${season}`;
    
    // Check cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData && Array.isArray(cachedData)) {
      logger.info('Retrieved cached team pitching data', { season, count: cachedData.length });
      return cachedData;
    }

    // Fetch fresh data from MLB API
    logger.info('Fetching fresh team pitching data from MLB API', { season });
    const allTeams = await mlbApi.getAllTeams(season);
    const teamStats = [];
    
    // Fetch stats for each team
    for (const team of allTeams.teams) {
      try {
        const stats = await mlbApi.getTeamPitchingStats(team.id, season);
        
        if (stats && stats.stats && stats.stats.length > 0 && stats.stats[0].splits && stats.stats[0].splits.length > 0) {
          // Transform the stats to match our expected format
          const teamStatData = {
            Team: team.name,
            team_id: team.id,
            year: season,
            ...this.transformMLBTeamStats(stats.stats[0].splits[0], 'team-pitching')
          };
          teamStats.push(teamStatData);
        }
      } catch (error) {
        logger.warn(`Failed to get pitching stats for team ${team.name}`, { 
          teamId: team.id, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        // Continue with other teams even if one fails
      }
    }
    
    // Cache for 1 hour
    await cacheService.set(cacheKey, teamStats, 3600);
    logger.info('Cached team pitching data', { season, count: teamStats.length });
    
    return teamStats;
  }

  /**
   * Sort and limit team data in backend
   */
  private sortAndLimitTeamData(data: any[], sortField: string, direction: string, limit: number): any[] {
    if (!data || data.length === 0) {
      return [];
    }

    logger.info('Sorting team data locally', { 
      sortField, 
      direction, 
      limit, 
      totalRecords: data.length 
    });

    // Map frontend field names to actual data field names
    const fieldMappings: { [key: string]: string } = {
      'avg': 'AVG',
      'homeRuns': 'HR',
      'rbi': 'RBI',
      'ops': 'OPS',
      'obp': 'OBP',
      'slg': 'SLG',
      'runs': 'R',
      'hits': 'H',
      'doubles': '2B',
      'triples': '3B',
      'era': 'ERA',
      'whip': 'WHIP',
      'strikeouts': 'SO',
      'wins': 'W',
      'saves': 'SV',
      'innings': 'IP',
      'fip': 'FIP'
    };

    const actualField = fieldMappings[sortField] || sortField.toUpperCase();
    
    // Sort the data
    const sortedData = [...data].sort((a, b) => {
      let aVal = a[actualField];
      let bVal = b[actualField];
      
      // Handle string numbers (remove commas, convert to number)
      if (typeof aVal === 'string') {
        aVal = parseFloat(aVal.replace(/,/g, '')) || 0;
      }
      if (typeof bVal === 'string') {
        bVal = parseFloat(bVal.replace(/,/g, '')) || 0;
      }
      
      // Handle null/undefined values
      if (aVal == null) aVal = direction === 'desc' ? -Infinity : Infinity;
      if (bVal == null) bVal = direction === 'desc' ? -Infinity : Infinity;
      
      // Sort direction
      return direction === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Add rank and limit
    const limitedData = sortedData.slice(0, limit).map((team, index) => ({
      ...team,
      rank: index + 1
    }));

    logger.info('Team data sorted and limited', { 
      actualField, 
      direction, 
      originalCount: data.length, 
      finalCount: limitedData.length 
    });

    return limitedData;
  }
}

export const dataSourceService = new DataSourceService();
