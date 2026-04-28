/**
 * Legacy Compatible Controller - Handles existing frontend endpoints
 * Provides backward compatibility while using new hybrid data architecture
 */

import { Request, Response } from 'express';
import { dataSourceService } from '../services/data-source.service';
import { newsService } from '../services/news.service';
import { mlbApi } from '../services/mlb-api.service';
import { logger } from '../utils/logger';

const SPLIT_FAMILY_MAP: Record<string, { label: string; sitCodes: string[] }> = {
  location: { label: 'Home / Away', sitCodes: ['h', 'a'] },
  handedness: { label: 'Handedness', sitCodes: ['vr', 'vl'] },
  time: { label: 'Day / Night', sitCodes: ['d', 'n'] },
};

function getSingleValue(value: unknown, fallback = ''): string {
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === 'string' ? firstValue : fallback;
  }

  return typeof value === 'string' ? value : fallback;
}

export class LegacyController {

  /**
   * GET /api/teamBatting
   * Legacy endpoint for team batting statistics
   */
  async getTeamBatting(req: Request, res: Response): Promise<void> {
    try {
      const { year = '2024', stats, orderBy = 'team_name', direction = 'asc' } = req.query;
      
      logger.info('Team batting request', { year, stats, orderBy, direction });

      const data = await dataSourceService.getData({
        dataType: 'team-batting',
        year: parseInt(year as string),
        stats: stats as string,
        orderBy: orderBy as string,
        direction: direction as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching team batting data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch team batting data' });
    }
  }

  /**
   * GET /api/TeamPitching
   * Legacy endpoint for team pitching statistics
   */
  async getTeamPitching(req: Request, res: Response): Promise<void> {
    try {
      const { year = '2024', stats, orderBy = 'team_name', direction = 'asc' } = req.query;
      
      logger.info('Team pitching request', { year, stats, orderBy, direction });

      const data = await dataSourceService.getData({
        dataType: 'team-pitching',
        year: parseInt(year as string),
        stats: stats as string,
        orderBy: orderBy as string,
        direction: direction as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching team pitching data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch team pitching data' });
    }
  }

  /**
   * GET /api/PlayerBatting
   * Legacy endpoint for player batting statistics
   */
  async getPlayerBatting(req: Request, res: Response): Promise<void> {
    try {
      const { 
        year = '2024', 
        stats, 
        orderBy, 
        sortStat, 
        direction = 'desc', 
        limit = '50' 
      } = req.query;
      
      // Support both legacy orderBy and new sortStat parameters
      const sortParam = (sortStat || orderBy || 'ops') as string;
      
      logger.info('Player batting request', { year, stats, sortParam, direction, limit });

      const data = await dataSourceService.getData({
        dataType: 'player-batting',
        year: parseInt(year as string),
        stats: stats as string,
        orderBy: sortParam,
        direction: direction as string,
        limit: limit as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching player batting data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch player batting data' });
    }
  }

  /**
   * GET /api/PlayerPitching
   * Legacy endpoint for player pitching statistics
   */
  async getPlayerPitching(req: Request, res: Response): Promise<void> {
    try {
      const { 
        year = '2024', 
        stats, 
        orderBy, 
        sortStat, 
        direction = 'asc', 
        limit = '50' 
      } = req.query;
      
      // Support both legacy orderBy and new sortStat parameters
      const sortParam = (sortStat || orderBy || 'era') as string;
      
      logger.info('Player pitching request', { year, stats, sortParam, direction, limit });

      const data = await dataSourceService.getData({
        dataType: 'player-pitching',
        year: parseInt(year as string),
        stats: stats as string,
        orderBy: sortParam,
        direction: direction as string,
        limit: limit as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching player pitching data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch player pitching data' });
    }
  }

  /**
   * GET /api/Standings
   * Legacy endpoint for league standings
   */
  async getStandings(req: Request, res: Response): Promise<void> {
    try {
      const { year = '2024' } = req.query;
      
      logger.info('Standings request', { year });

      const data = await dataSourceService.getData({
        dataType: 'standings',
        year: parseInt(year as string)
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching standings data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch standings data' });
    }
  }

  /**
   * GET /api/teamBatting/avaliableStats
   * GET /api/TeamBatting/avaliableStats  
   * GET /api/PlayerBatting/avaliableStats
   * GET /api/PlayerPitching/avaliableStats
   * Legacy endpoints for available statistics
   */
  async getAvailableStats(req: Request, res: Response): Promise<void> {
    try {
      const path = req.path.toLowerCase();
      let statsType = 'team-batting';

      if (path.includes('teampitching')) {
        statsType = 'team-pitching';
      } else if (path.includes('playerbatting')) {
        statsType = 'player-batting';
      } else if (path.includes('playerpitching')) {
        statsType = 'player-pitching';
      }

      logger.info('Available stats request', { statsType, path });

      const data = await dataSourceService.getData({
        dataType: 'available-stats',
        stats: statsType
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching available stats', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch available stats' });
    }
  }

  /**
   * GET /api/playerData
   * Legacy endpoint for individual player data (FanGraphs)
   */
  async getPlayerData(req: Request, res: Response): Promise<void> {
    try {
      const { playerId, position = '' } = req.query;

      if (!playerId) {
        res.status(400).json({ error: 'Player ID is required' });
        return;
      }

      logger.info('Player data request', { playerId, position });

      const data = await dataSourceService.getData({
        dataType: 'player-data',
        playerId: parseInt(playerId as string),
        position: position as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching player data', {
        error: error instanceof Error ? error.message : 'Unknown error',
        playerId: req.query.playerId
      });
      res.status(500).json({ error: 'Failed to fetch player data' });
    }
  }

  /**
   * GET /api/statcast
   * Legacy endpoint for Statcast data
   */
  async getStatcast(req: Request, res: Response): Promise<void> {
    try {
      const {
        year = '2025',
        position = 'batter',
        playerId,
        p_throws = '',
        stands = '',
        events = '',
        limit = '1500'
      } = req.query;

      logger.info('Statcast request', { year, position, playerId, p_throws, stands, events, limit });

      const data = await dataSourceService.getData({
        dataType: 'statcast',
        year: parseInt(year as string),
        position: position as string,
        playerId: playerId ? parseInt(playerId as string) : undefined,
        p_throws: p_throws as string,
        stands: stands as string,
        events: events as string,
        limit: limit as string
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching Statcast data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch Statcast data' });
    }
  }

  /**
   * GET /api/games
   * Same-origin schedule endpoint for frontend live surfaces
   */
  async getGames(req: Request, res: Response): Promise<void> {
    try {
      const { date, startDate, endDate, teamId } = req.query;
      const scheduleDate = (date as string) || new Date().toISOString().split('T')[0];

      logger.info('Games request', { date: scheduleDate, startDate, endDate, teamId });

      const data = await mlbApi.getScheduleWithOptions({
        date: startDate || endDate ? undefined : scheduleDate,
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        teamId: teamId ? parseInt(teamId as string, 10) : undefined,
        sportId: 1,
      });

      res.json(data);
    } catch (error) {
      logger.error('Error fetching games schedule', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch games schedule' });
    }
  }

  /**
   * GET /api/games/:gamePk
   * Same-origin game detail endpoint for live game surfaces
   */
  async getGameDetails(req: Request, res: Response): Promise<void> {
    try {
      const gamePk = parseInt(getSingleValue(req.params.gamePk), 10);

      logger.info('Game details request', { gamePk });

      const data = await mlbApi.getGameById(gamePk);
      res.json(data);
    } catch (error) {
      logger.error('Error fetching game details', {
        error: error instanceof Error ? error.message : 'Unknown error',
        gamePk: req.params.gamePk
      });
      res.status(500).json({ error: 'Failed to fetch game details' });
    }
  }

  /**
   * GET /api/players/:playerId/profile
   * Same-origin player profile endpoint for the player hub
   */
  async getPlayerProfile(req: Request, res: Response): Promise<void> {
    try {
      const playerId = parseInt(getSingleValue(req.params.playerId), 10);
      const season = getSingleValue(req.query.season);
      const hydrate = getSingleValue(req.query.hydrate, 'currentTeam');

      logger.info('Player profile request', { playerId, season, hydrate });

      const data = await mlbApi.getPlayerById(
        playerId,
        season ? parseInt(season, 10) : undefined,
        hydrate
      );

      res.json(data);
    } catch (error) {
      logger.error('Error fetching player profile', {
        error: error instanceof Error ? error.message : 'Unknown error',
        playerId: req.params.playerId
      });
      res.status(500).json({ error: 'Failed to fetch player profile' });
    }
  }

  /**
   * GET /api/players/:playerId/game-log
   * Same-origin player game log endpoint for recent performance context
   */
  async getPlayerGameLog(req: Request, res: Response): Promise<void> {
    try {
      const playerId = parseInt(getSingleValue(req.params.playerId), 10);
      const season = getSingleValue(req.query.season, '2026');
      const group = getSingleValue(req.query.group, 'hitting');

      logger.info('Player game log request', { playerId, season, group });

      const data = await mlbApi.getPlayerGameLog(
        playerId,
        parseInt(season, 10),
        group
      );

      res.json(data);
    } catch (error) {
      logger.error('Error fetching player game log', {
        error: error instanceof Error ? error.message : 'Unknown error',
        playerId: req.params.playerId
      });
      res.status(500).json({ error: 'Failed to fetch player game log' });
    }
  }

  /**
   * GET /api/splits
   * Same-origin split explorer endpoint for player/team context.
   */
  async getSplits(req: Request, res: Response): Promise<void> {
    try {
      const {
        entityType = 'player',
        entityId,
        season = '2026',
        group = 'hitting',
        family = 'location',
      } = req.query;

      const parsedEntityId = parseInt(entityId as string, 10);
      if (Number.isNaN(parsedEntityId)) {
        res.status(400).json({ error: 'entityId is required and must be numeric' });
        return;
      }

      const splitFamily = SPLIT_FAMILY_MAP[String(family)] || SPLIT_FAMILY_MAP.location;
      const parsedSeason = parseInt(season as string, 10);
      const normalizedEntityType = String(entityType) === 'team' ? 'team' : 'player';
      const normalizedGroup = String(group) === 'pitching' ? 'pitching' : 'hitting';

      logger.info('Split explorer request', {
        entityType: normalizedEntityType,
        entityId: parsedEntityId,
        season: parsedSeason,
        group: normalizedGroup,
        family: splitFamily.label,
      });

      const [baselineData, splitData] = await Promise.all(
        normalizedEntityType === 'team'
          ? [
              mlbApi.getTeamSeasonStats(parsedEntityId, parsedSeason, normalizedGroup),
              mlbApi.getTeamStatSplits(parsedEntityId, parsedSeason, normalizedGroup, splitFamily.sitCodes),
            ]
          : [
              mlbApi.getPlayerSeasonStats(parsedEntityId, parsedSeason, normalizedGroup),
              mlbApi.getPlayerStatSplits(parsedEntityId, parsedSeason, normalizedGroup, splitFamily.sitCodes),
            ]
      );

      const baselineSplit = baselineData?.stats?.[0]?.splits?.[0] || null;
      const splitRows = splitData?.stats?.[0]?.splits || [];
      const entity =
        normalizedEntityType === 'team'
          ? baselineSplit?.team || splitRows[0]?.team || null
          : baselineSplit?.player || splitRows[0]?.player || null;
      const team = baselineSplit?.team || splitRows[0]?.team || null;

      res.json({
        success: true,
        entityType: normalizedEntityType,
        group: normalizedGroup,
        season: parsedSeason,
        family: {
          id: String(family),
          label: splitFamily.label,
          sitCodes: splitFamily.sitCodes,
        },
        entity,
        team,
        baseline: baselineSplit,
        splits: splitRows,
      });
    } catch (error) {
      logger.error('Error fetching split explorer data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({ error: 'Failed to fetch split explorer data' });
    }
  }

  /**
   * GET /api/teamData
   * Legacy endpoint for aggregated team data
   */
  async getTeamData(req: Request, res: Response): Promise<void> {
    try {
      const { teamAbbr = 'ATL', year = '2025' } = req.query;

      logger.info('Team data request', { teamAbbr, year });

      // This would need to be implemented based on your specific team data requirements
      // For now, return a placeholder response
      res.json({
        message: 'Team data endpoint - implementation needed',
        teamAbbr,
        year
      });
    } catch (error) {
      logger.error('Error fetching team data', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch team data' });
    }
  }

  /**
   * GET /api/mlb-news
   * Legacy endpoint for MLB general news
   */
  async getMLBNews(req: Request, res: Response): Promise<void> {
    try {
      logger.info('MLB news request');

      const newsData = await newsService.getNews('mlb');
      
      if (!newsData) {
        res.status(404).json({ error: 'No MLB news data available' });
        return;
      }

      res.json(newsData);
    } catch (error) {
      logger.error('Error fetching MLB news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch MLB news' });
    }
  }

  /**
   * GET /api/braves-news
   * Legacy endpoint for Atlanta Braves news
   */
  async getBravesNews(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Braves news request');

      const newsData = await newsService.getNews('braves');
      
      if (!newsData) {
        res.status(404).json({ error: 'No Braves news data available' });
        return;
      }

      res.json(newsData);
    } catch (error) {
      logger.error('Error fetching Braves news', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to fetch Braves news' });
    }
  }

  /**
   * POST /api/news/refresh
   * Manual trigger for news refresh (for testing/admin use)
   */
  async refreshNews(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Manual news refresh triggered');

      await newsService.scheduledNewsFetch();
      
      res.json({ 
        message: 'News refresh completed',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error in manual news refresh', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({ error: 'Failed to refresh news' });
    }
  }
}

export const legacyController = new LegacyController();
