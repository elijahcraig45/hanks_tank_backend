/**
 * FanGraphs API Service - Fallback service for data not available in historical BigQuery
 * Provides player statistics and advanced analytics from FanGraphs
 */

import axios from 'axios';
import { logger } from '../utils/logger';

export interface FanGraphsPlayerRequest {
  playerId: string;
  position?: string;
}

export interface FanGraphsStatcastRequest {
  year?: string;
  position?: string;
  playerId?: string;
  p_throws?: string;
  stands?: string;
  events?: string;
}

export class FanGraphsService {
  private readonly baseUrl = 'https://www.fangraphs.com/api';
  private readonly statcastBaseUrl = 'https://baseballsavant.mlb.com/statcast_search';

  constructor() {
    logger.info('FanGraphs Service initialized');
  }

  /**
   * Get player data from FanGraphs
   */
  async getPlayerData(request: FanGraphsPlayerRequest): Promise<any> {
    try {
      const { playerId, position = '' } = request;

      if (!playerId || playerId.length < 1) {
        throw new Error('Player ID is required');
      }

      const url = `${this.baseUrl}/players/stats?playerid=${playerId}&position=${position}`;
      
      logger.info('Fetching player data from FanGraphs', { playerId, position, url });

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Hanks-Tank-Backend/1.0'
        }
      });

      logger.info('FanGraphs player data fetched successfully', { 
        playerId, 
        dataSize: JSON.stringify(response.data).length 
      });

      return response.data;
    } catch (error: any) {
      logger.error('Error fetching FanGraphs player data', {
        playerId: request.playerId,
        error: error.message,
        response: error.response?.data
      });
      throw error;
    }
  }

  /**
   * Get Statcast data (fallback to Baseball Savant API)
   */
  async getStatcastData(request: FanGraphsStatcastRequest): Promise<any> {
    try {
      const {
        year = '2025',
        position = 'batter',
        playerId,
        p_throws = '',
        stands = '',
        events = ''
      } = request;

      let url = `${this.statcastBaseUrl}/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSea=${year}%7C&hfSit=&player_type=${position}&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=&game_date_lt=&hfInfield=&team=&position=&hfOutfield=&hfRO=&home_road=&hfFlag=&hfPull=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_pas=0&type=details&`;

      // Add player-specific parameters
      if (playerId) {
        if (position === 'pitcher') {
          url += `pitchers_lookup%5B%5D=${playerId}&`;
        } else {
          url += `batters_lookup%5B%5D=${playerId}&`;
        }
      }

      // Add additional filters
      if (p_throws) {
        url += `pitcher_throws=${p_throws}&`;
      }
      if (stands) {
        url += `batter_stands=${stands}&`;
      }
      if (events) {
        url += `hfPR=${events}&`;
      }

      logger.info('Fetching Statcast data', { year, position, playerId, url: url.substring(0, 100) + '...' });

      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Hanks-Tank-Backend/1.0'
        }
      });

      // Parse CSV response to JSON
      const csvData = response.data as string;
      const jsonData = this.parseCSVToJSON(csvData);

      logger.info('Statcast data fetched successfully', { 
        recordCount: jsonData.length,
        year,
        position 
      });

      return jsonData;

    } catch (error: any) {
      logger.error('Error fetching Statcast data', {
        error: error.message,
        request
      });
      throw error;
    }
  }

  /**
   * Get available stats (mock endpoint for compatibility)
   */
  async getAvailableStats(dataType: string): Promise<string[]> {
    // Mock implementation - in reality, you'd maintain a list of available stats
    // based on your data structure or make a call to discover available columns
    
    const availableStats: Record<string, string[]> = {
      'team-batting': [
        'Team', 'G', 'PA', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'CS', 
        'BB', 'SO', 'BA', 'OBP', 'SLG', 'OPS', 'OPS+', 'TB', 'GDP', 'HBP', 'SH', 'SF', 'IBB'
      ],
      'team-pitching': [
        'Team', 'W', 'L', 'ERA', 'G', 'GS', 'CG', 'SHO', 'SV', 'IP', 'H', 'R', 'ER', 
        'HR', 'BB', 'SO', 'WHIP', 'BAA', 'K/9', 'BB/9', 'K/BB', 'H/9'
      ],
      'player-batting': [
        'Name', 'Team', 'G', 'PA', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'CS',
        'BB', 'SO', 'BA', 'OBP', 'SLG', 'OPS', 'OPS+', 'wRC+', 'WAR', 'Spd', 'BABIP'
      ],
      'player-pitching': [
        'Name', 'Team', 'W', 'L', 'ERA', 'G', 'GS', 'CG', 'SHO', 'SV', 'IP', 'H', 'R', 'ER',
        'HR', 'BB', 'SO', 'WHIP', 'BABIP', 'FIP', 'xFIP', 'WAR', 'K/9', 'BB/9', 'K/BB'
      ]
    };

    return availableStats[dataType] || [];
  }

  /**
   * Helper method to parse CSV to JSON
   */
  private parseCSVToJSON(csvText: string): any[] {
    const lines = csvText.split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((header: string) => header.trim());
    const result: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(',');
      const obj: any = {};

      headers.forEach((header: string, index: number) => {
        const value = values[index]?.trim() || '';
        // Try to parse as number if it looks like one
        obj[header] = isNaN(Number(value)) ? value : Number(value);
      });

      result.push(obj);
    }

    return result;
  }
}

// Export instance for use in other modules
export const fanGraphsService = new FanGraphsService();
