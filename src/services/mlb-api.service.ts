// MLB StatsAPI Service
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { config } from '../config/app';
import { logger } from '../utils/logger';
import { cacheService } from './cache.service';
import { CacheKeys } from '../utils/cache-keys';

interface MLBApiResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
}

interface MLBTeam {
  id: number;
  name: string;
  link: string;
  season: number;
  venue: {
    id: number;
    name: string;
    link: string;
  };
  teamCode: string;
  fileCode: string;
  abbreviation: string;
  teamName: string;
  locationName: string;
  firstYearOfPlay: string;
  league: {
    id: number;
    name: string;
    link: string;
  };
  division: {
    id: number;
    name: string;
    link: string;
  };
}

interface MLBPlayer {
  id: number;
  fullName: string;
  link: string;
  firstName: string;
  lastName: string;
  primaryNumber: string;
  birthDate: string;
  currentAge: number;
  birthCity: string;
  birthStateProvince: string;
  birthCountry: string;
  height: string;
  weight: number;
  active: boolean;
  primaryPosition: {
    code: string;
    name: string;
    type: string;
    abbreviation: string;
  };
  useName: string;
  boxscoreName: string;
  nickName: string;
  mlbDebutDate: string;
  batSide: {
    code: string;
    description: string;
  };
  pitchHand: {
    code: string;
    description: string;
  };
  nameFirstLast: string;
  nameSlug: string;
  firstLastName: string;
  lastFirstName: string;
  lastInitName: string;
  initLastName: string;
  fullFMLName: string;
  fullLFMName: string;
}

interface MLBGame {
  gamePk: number;
  link: string;
  gameType: string;
  season: string;
  gameDate: string;
  status: {
    abstractGameState: string;
    codedGameState: string;
    detailedState: string;
    statusCode: string;
    startTimeTBD: boolean;
    abstractGameCode: string;
  };
  teams: {
    away: {
      score: number;
      team: MLBTeam;
      isWinner: boolean;
      splitSquad: boolean;
      seriesNumber: number;
    };
    home: {
      score: number;
      team: MLBTeam;
      isWinner: boolean;
      splitSquad: boolean;
      seriesNumber: number;
    };
  };
  venue: {
    id: number;
    name: string;
    link: string;
  };
  content: {
    link: string;
  };
  gameNumber: number;
  publicFacing: boolean;
  doubleHeader: string;
  gamedayType: string;
  tiebreaker: string;
  calendarEventID: string;
  seasonDisplay: string;
  dayNight: string;
  description: string;
  scheduledInnings: number;
  reverseHomeAwayStatus: boolean;
  inningBreakLength: number;
  gamesInSeries: number;
  seriesGameNumber: number;
  seriesDescription: string;
  recordSource: string;
  ifNecessary: string;
  ifNecessaryDescription: string;
}

class MLBApiService {
  private api: AxiosInstance;
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.mlbApi.baseUrl;
    this.api = axios.create({
      baseURL: this.baseUrl,
      timeout: config.mlbApi.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HanksTank/1.0',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor
    this.api.interceptors.request.use(
      (config) => {
        logger.debug('MLB API Request', {
          url: config.url,
          method: config.method,
          params: config.params,
        });
        return config;
      },
      (error) => {
        logger.error('MLB API Request Error', { error: error.message });
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.api.interceptors.response.use(
      (response: AxiosResponse) => {
        logger.debug('MLB API Response', {
          url: response.config.url,
          status: response.status,
          responseSize: JSON.stringify(response.data).length,
        });
        return response;
      },
      (error) => {
        logger.error('MLB API Response Error', {
          url: error.config?.url,
          status: error.response?.status,
          message: error.message,
          data: error.response?.data,
        });
        return Promise.reject(error);
      }
    );
  }

  private async makeRequest<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    try {
      const response = await this.api.get<T>(endpoint, { params });
      return response.data;
    } catch (error) {
      logger.error('MLB API request failed', {
        endpoint,
        params,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async getCachedOrFetch<T>(
    cacheKey: string,
    fetchFn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    if (config.features.caching) {
      const cached = await cacheService.get<T>(cacheKey);
      if (cached) {
        logger.debug('Cache hit', { cacheKey });
        return cached;
      }
    }

    const data = await fetchFn();
    
    if (config.features.caching && ttl) {
      await cacheService.set(cacheKey, data, ttl);
      logger.debug('Data cached', { cacheKey, ttl });
    }

    return data;
  }

  // Teams endpoints
  async getAllTeams(season?: number): Promise<{ teams: MLBTeam[] }> {
    const cacheKey = CacheKeys.teams.all(season);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest<{ teams: MLBTeam[] }>('/teams', { season }),
      config.cache.ttl.teams
    );
  }

  async getTeamById(teamId: number, season?: number): Promise<{ teams: MLBTeam[] }> {
    const cacheKey = CacheKeys.teams.byId(teamId, season);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest<{ teams: MLBTeam[] }>(`/teams/${teamId}`, { season }),
      config.cache.ttl.teams
    );
  }

  async getTeamRoster(teamId: number, season?: number): Promise<{ roster: any[] }> {
    const cacheKey = CacheKeys.teams.roster(teamId, season);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest<{ roster: any[] }>(`/teams/${teamId}/roster`, { season }),
      config.cache.ttl.teams
    );
  }

  async getTeamStats(teamId: number, season?: number, group?: string): Promise<any> {
    const cacheKey = CacheKeys.teams.stats(teamId, season, group);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/teams/${teamId}/stats`, { season, group }),
      config.cache.ttl.stats
    );
  }

  // Players endpoints
  async getPlayerById(playerId: number, season?: number): Promise<{ people: MLBPlayer[] }> {
    const cacheKey = CacheKeys.players.byId(playerId, season);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest<{ people: MLBPlayer[] }>(`/people/${playerId}`, { season }),
      config.cache.ttl.players
    );
  }

  async getPlayerStats(playerId: number, season?: number, group?: string): Promise<any> {
    const cacheKey = CacheKeys.players.stats(playerId, season, group);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/people/${playerId}/stats`, { season, group }),
      config.cache.ttl.stats
    );
  }

  // Games endpoints
  async getGameById(gameId: number): Promise<any> {
    const cacheKey = CacheKeys.game.byId(gameId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/game/${gameId}/feed/live`),
      config.cache.ttl.games
    );
  }

  async getGameBoxscore(gameId: number): Promise<any> {
    const cacheKey = CacheKeys.game.boxscore(gameId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/game/${gameId}/boxscore`),
      config.cache.ttl.games
    );
  }

  async getGamePlayByPlay(gameId: number): Promise<any> {
    const cacheKey = CacheKeys.game.playByPlay(gameId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/game/${gameId}/playByPlay`),
      config.cache.ttl.games
    );
  }

  // Schedule endpoints
  async getSchedule(
    startDate?: string,
    endDate?: string,
    teamId?: number,
    sportId?: number
  ): Promise<{ dates: any[] }> {
    const cacheKey = CacheKeys.schedule.byDateRange(startDate, endDate, teamId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest<{ dates: any[] }>('/schedule', {
        startDate,
        endDate,
        teamId,
        sportId: sportId || 1, // MLB is sport ID 1
      }),
      config.cache.ttl.schedule
    );
  }

  async getTodaysGames(): Promise<{ dates: any[] }> {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = CacheKeys.schedule.today();
    return this.getCachedOrFetch(
      cacheKey,
      () => this.getSchedule(today, today),
      config.cache.ttl.games
    );
  }

  // Standings endpoints
  async getStandings(leagueId?: number, season?: number, standingsType?: string): Promise<any> {
    const cacheKey = CacheKeys.standings.byLeague(leagueId, season, standingsType);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest('/standings', {
        leagueId,
        season,
        standingsType: standingsType || 'regularSeason',
      }),
      config.cache.ttl.standings
    );
  }

  // Season/League info endpoints
  async getSeasons(sportId?: number): Promise<any> {
    const cacheKey = CacheKeys.seasons.all(sportId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest('/seasons', { sportId: sportId || 1 }),
      config.cache.ttl.teams // Seasons don't change often
    );
  }

  async getLeagues(): Promise<any> {
    const cacheKey = CacheKeys.leagues.all();
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest('/leagues'),
      config.cache.ttl.teams // Leagues don't change often
    );
  }

  async getDivisions(): Promise<any> {
    const cacheKey = CacheKeys.divisions.all();
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest('/divisions'),
      config.cache.ttl.teams // Divisions don't change often
    );
  }

  // Venues endpoints
  async getVenues(): Promise<any> {
    const cacheKey = CacheKeys.venues.all();
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest('/venues'),
      config.cache.ttl.teams // Venues don't change often
    );
  }

  async getVenueById(venueId: number): Promise<any> {
    const cacheKey = CacheKeys.venues.byId(venueId);
    return this.getCachedOrFetch(
      cacheKey,
      () => this.makeRequest(`/venues/${venueId}`),
      config.cache.ttl.teams
    );
  }

  // Health check method
  async healthCheck(): Promise<boolean> {
    try {
      await this.makeRequest('/teams');
      return true;
    } catch (error) {
      logger.error('MLB API health check failed', { error });
      return false;
    }
  }
}

export const mlbApi = new MLBApiService();
export { MLBTeam, MLBPlayer, MLBGame, MLBApiResponse };
export default mlbApi;
