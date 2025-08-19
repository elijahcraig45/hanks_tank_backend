// Hybrid Teams Controller - Uses intelligent data source routing
import { Request, Response, NextFunction } from 'express';
import { dataSourceService } from '../services/data-source.service';
import { mlbApi } from '../services/mlb-api.service';
import { ResponseFormatter } from '../utils/response-formatter';
import { logger } from '../utils/logger';

export class HybridTeamsController {
  
  // GET /api/teams - Get all MLB teams with hybrid data sourcing
  static async getAllTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { season } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      // Use the hybrid data source service
      const data = await dataSourceService.getData({
        season: parsedSeason,
        dataType: 'team-stats'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Teams data fetched via hybrid service', {
        season: parsedSeason,
        responseTime,
        dataSize: JSON.stringify(data).length
      });

      const transformedData = {
        teams: Array.isArray(data) ? data : (data.teams || []),
        metadata: {
          total: Array.isArray(data) ? data.length : (data.teams?.length || 0),
          season: parsedSeason || new Date().getFullYear(),
          responseTime,
          source: 'hybrid',
          cached: false // This will be updated by the service
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching teams via hybrid service', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id - Get specific team details with hybrid sourcing
  static async getTeamById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        season: parsedSeason,
        teamId: parseInt(teamId),
        dataType: 'team-stats'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Team details fetched', {
        teamId,
        season: parsedSeason,
        responseTime
      });

      res.json(ResponseFormatter.success({
        team: data,
        metadata: {
          teamId: parseInt(teamId),
          season: parsedSeason || new Date().getFullYear(),
          responseTime,
          source: 'hybrid'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching team details', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/roster - Get team roster with intelligent sourcing
  static async getTeamRoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        season: parsedSeason,
        teamId: parseInt(teamId),
        dataType: 'roster'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Team roster fetched', {
        teamId,
        season: parsedSeason,
        responseTime
      });

      res.json(ResponseFormatter.success({
        roster: data,
        metadata: {
          teamId: parseInt(teamId),
          season: parsedSeason || new Date().getFullYear(),
          responseTime,
          source: 'hybrid'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching team roster', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/schedule - Get team schedule with hybrid sourcing
  static async getTeamSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        season: parsedSeason,
        teamId: parseInt(teamId),
        dataType: 'schedule'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Team schedule fetched', {
        teamId,
        season: parsedSeason,
        responseTime
      });

      res.json(ResponseFormatter.success({
        schedule: data,
        metadata: {
          teamId: parseInt(teamId),
          season: parsedSeason || new Date().getFullYear(),
          responseTime,
          source: 'hybrid'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching team schedule', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/stats - Get team statistics with intelligent data sourcing
  static async getTeamStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season, statType = 'batting' } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        season: parsedSeason,
        teamId: parseInt(teamId),
        dataType: 'team-stats',
        statType: statType as 'batting' | 'pitching' | 'fielding'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Team stats fetched', {
        teamId,
        season: parsedSeason,
        statType,
        responseTime
      });

      res.json(ResponseFormatter.success({
        stats: data,
        metadata: {
          teamId: parseInt(teamId),
          season: parsedSeason || new Date().getFullYear(),
          statType,
          responseTime,
          source: 'hybrid'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching team stats', { 
        teamId: req.params.id,
        statType: req.query.statType,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/standings - Get standings with hybrid sourcing
  static async getStandings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { season } = req.query;
      const parsedSeason = season ? parseInt(season as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        season: parsedSeason,
        dataType: 'standings'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('Standings fetched', {
        season: parsedSeason,
        responseTime
      });

      res.json(ResponseFormatter.success({
        standings: data,
        metadata: {
          season: parsedSeason || new Date().getFullYear(),
          responseTime,
          source: 'hybrid'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching standings', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/news - Get news with file-based sourcing
  static async getNews(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { teamId } = req.query;
      const parsedTeamId = teamId ? parseInt(teamId as string) : undefined;
      
      const startTime = Date.now();
      
      const data = await dataSourceService.getData({
        teamId: parsedTeamId,
        dataType: 'news'
      });
      
      const responseTime = Date.now() - startTime;
      
      logger.info('News fetched from storage', {
        teamId: parsedTeamId,
        responseTime
      });

      res.json(ResponseFormatter.success({
        news: data,
        metadata: {
          teamId: parsedTeamId,
          responseTime,
          source: 'cloud-storage'
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching news', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // POST /api/admin/sync-historical - Sync historical data from MLB API to GCP
  static async syncHistoricalData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { season, dataTypes } = req.body;
      
      if (!season) {
        res.status(400).json(ResponseFormatter.error('MISSING_SEASON', 'Season is required'));
        return;
      }

      logger.info('Starting historical data sync', { season, dataTypes });
      
      // This is an async operation that can take time
      dataSourceService.syncHistoricalData(season, dataTypes)
        .then(() => {
          logger.info('Historical data sync completed', { season, dataTypes });
        })
        .catch((error) => {
          logger.error('Historical data sync failed', { 
            season, 
            dataTypes, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        });

      res.json(ResponseFormatter.success({
        message: 'Historical data sync initiated',
        season,
        dataTypes: dataTypes || ['team-stats', 'player-stats']
      }));
      
    } catch (error) {
      logger.error('Error initiating historical data sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // Legacy controller methods for backward compatibility
  // These will gradually be replaced with hybrid versions

  // Direct MLB API access (for comparison and fallback)
  static async getDirectMLBData(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { endpoint } = req.params;
      const { season, teamId } = req.query;
      
      const startTime = Date.now();
      let data: any;

      switch (endpoint) {
        case 'teams':
          data = await mlbApi.getAllTeams(season ? parseInt(season as string) : undefined);
          break;
        case 'standings':
          data = await mlbApi.getStandings(season ? parseInt(season as string) : undefined);
          break;
        default:
          res.status(400).json(ResponseFormatter.error('INVALID_ENDPOINT', 'Invalid endpoint'));
          return;
      }
      
      const responseTime = Date.now() - startTime;
      
      res.json(ResponseFormatter.success({
        data,
        metadata: {
          source: 'direct-mlb-api',
          responseTime,
          endpoint
        }
      }));
      
    } catch (error) {
      logger.error('Error fetching direct MLB data', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }
}
