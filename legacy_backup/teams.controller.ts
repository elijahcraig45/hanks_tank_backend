// Teams Controller - Simplified version for initial implementation
import { Request, Response, NextFunction } from 'express';
import { mlbApi } from '../services/mlb-api.service';
import { ResponseFormatter } from '../utils/response-formatter';
import { logger } from '../utils/logger';

export class TeamsController {
  
  // GET /api/teams - Get all MLB teams
  static async getAllTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { season } = req.query;
      
      // Fetch from MLB API
      const startTime = Date.now();
      const mlbData = await mlbApi.getAllTeams(season ? parseInt(season as string) : undefined);
      
      // Log performance
      const responseTime = Date.now() - startTime;
      logger.info('MLB API Response Time', {
        endpoint: 'getAllTeams',
        responseTime,
        dataSize: JSON.stringify(mlbData).length
      });

      // Transform data for our application
      const transformedData = {
        teams: mlbData.teams || [],
        metadata: {
          total: mlbData.teams?.length || 0,
          season: season || new Date().getFullYear(),
          responseTime,
          cached: false
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching teams', { error: error instanceof Error ? error.message : 'Unknown error' });
      next(error);
    }
  }

  // GET /api/teams/:id - Get specific team details
  static async getTeamById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season } = req.query;
      
      const teamIdNum = parseInt(teamId);
      if (isNaN(teamIdNum)) {
        res.status(400).json(ResponseFormatter.error('INVALID_TEAM_ID', 'Invalid team ID'));
        return;
      }

      // Fetch from MLB API
      const startTime = Date.now();
      const mlbData = await mlbApi.getTeamById(teamIdNum, season ? parseInt(season as string) : undefined);
      
      // Log performance
      const responseTime = Date.now() - startTime;
      logger.info('MLB API Response Time', {
        endpoint: 'getTeamById',
        teamId: teamIdNum,
        responseTime
      });

      if (!mlbData.teams || mlbData.teams.length === 0) {
        res.status(404).json(ResponseFormatter.error('TEAM_NOT_FOUND', 'Team not found'));
        return;
      }

      const team = mlbData.teams[0];
      const transformedData = {
        team,
        metadata: {
          teamId: teamIdNum,
          season: season || new Date().getFullYear(),
          responseTime,
          cached: false
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching team by ID', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/roster - Get team roster
  static async getTeamRoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season } = req.query;
      
      const teamIdNum = parseInt(teamId);
      if (isNaN(teamIdNum)) {
        res.status(400).json(ResponseFormatter.error('INVALID_TEAM_ID', 'Invalid team ID'));
        return;
      }

      // Fetch from MLB API
      const startTime = Date.now();
      const mlbData = await mlbApi.getTeamRoster(teamIdNum, season ? parseInt(season as string) : undefined);
      
      // Log performance
      const responseTime = Date.now() - startTime;
      logger.info('MLB API Response Time', {
        endpoint: 'getTeamRoster',
        teamId: teamIdNum,
        responseTime,
        rosterSize: mlbData.roster?.length || 0
      });

      const transformedData = {
        roster: mlbData.roster || [],
        metadata: {
          teamId: teamIdNum,
          season: season || new Date().getFullYear(),
          rosterSize: mlbData.roster?.length || 0,
          responseTime,
          cached: false
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching team roster', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/stats - Get team statistics
  static async getTeamStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { season, group } = req.query;
      
      const teamIdNum = parseInt(teamId);
      if (isNaN(teamIdNum)) {
        res.status(400).json(ResponseFormatter.error('INVALID_TEAM_ID', 'Invalid team ID'));
        return;
      }

      // Fetch from MLB API
      const startTime = Date.now();
      const mlbData = await mlbApi.getTeamStats(
        teamIdNum, 
        season ? parseInt(season as string) : undefined,
        group as string
      );
      
      // Log performance
      const responseTime = Date.now() - startTime;
      logger.info('MLB API Response Time', {
        endpoint: 'getTeamStats',
        teamId: teamIdNum,
        responseTime
      });

      const transformedData = {
        stats: mlbData,
        metadata: {
          teamId: teamIdNum,
          season: season || new Date().getFullYear(),
          group: group || 'hitting,pitching,fielding',
          responseTime,
          cached: false
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching team stats', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }

  // GET /api/teams/:id/schedule - Get team schedule
  static async getTeamSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id: teamId } = req.params;
      const { startDate, endDate } = req.query;
      
      const teamIdNum = parseInt(teamId);
      if (isNaN(teamIdNum)) {
        res.status(400).json(ResponseFormatter.error('INVALID_TEAM_ID', 'Invalid team ID'));
        return;
      }

      // Fetch from MLB API
      const startTime = Date.now();
      const mlbData = await mlbApi.getSchedule(
        startDate as string,
        endDate as string,
        teamIdNum
      );
      
      // Log performance
      const responseTime = Date.now() - startTime;
      logger.info('MLB API Response Time', {
        endpoint: 'getTeamSchedule',
        teamId: teamIdNum,
        responseTime,
        gameCount: mlbData.dates?.length || 0
      });

      const transformedData = {
        schedule: mlbData.dates || [],
        metadata: {
          teamId: teamIdNum,
          startDate,
          endDate,
          gameCount: mlbData.dates?.reduce((total, date) => total + (date.games?.length || 0), 0) || 0,
          responseTime,
          cached: false
        }
      };

      res.json(ResponseFormatter.success(transformedData));
      
    } catch (error) {
      logger.error('Error fetching team schedule', { 
        teamId: req.params.id,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      next(error);
    }
  }
}
