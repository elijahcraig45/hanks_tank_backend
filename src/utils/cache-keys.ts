/**
 * Cache key generation utilities for consistent cache key formatting
 */

export const getCacheKey = (prefix: string, params: Record<string, any>): string => {
  // Remove undefined/null values and sort keys for consistency
  const cleanParams = Object.entries(params)
    .filter(([_, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');

  return `hank:${prefix}:${cleanParams}`;
};

export const CacheKeys = {
  // Teams
  teams: {
    all: (season?: number) => `teams:all:${season || 'current'}`,
    byId: (teamId: number, season?: number) => `team:${teamId}:${season || 'current'}`,
    roster: (teamId: number, season?: number) => `team:${teamId}:roster:${season || 'current'}`,
    stats: (teamId: number, season?: number, group?: string) => `team:${teamId}:stats:${season || 'current'}:${group || 'all'}`,
    schedule: (teamId: number, params?: any) => `team:${teamId}:schedule:${JSON.stringify(params || {})}`,
  },
  
  // Players
  players: {
    byId: (playerId: number, season?: number) => `player:${playerId}:${season || 'current'}`,
    stats: (playerId: number, season?: number, group?: string) => `player:${playerId}:stats:${season || 'current'}:${group || 'all'}`,
    search: (query: string, params?: any) => `players:search:${query}:${JSON.stringify(params || {})}`,
    leaderboard: (season?: number, group?: string, sortStat?: string, limit?: number) => 
      `players:leaderboard:${season || 'current'}:${group || 'hitting'}:${sortStat || 'ops'}:${limit || 100}`,
  },
  
  // Games
  game: {
    byId: (gameId: number) => `game:${gameId}:details`,
    boxscore: (gameId: number) => `game:${gameId}:boxscore`,
    playByPlay: (gameId: number) => `game:${gameId}:playbyplay`,
    live: (gameId: number) => `game:${gameId}:live`,
  },
  
  // Schedule
  schedule: {
    byDateRange: (startDate?: string, endDate?: string, teamId?: number) => {
      const key = `schedule:${startDate || 'any'}:${endDate || 'any'}`;
      return teamId ? `${key}:team:${teamId}` : key;
    },
    today: () => {
      const today = new Date().toISOString().split('T')[0];
      return `schedule:today:${today}`;
    },
    byTeam: (teamId: number, params?: any) => `schedule:team:${teamId}:${JSON.stringify(params || {})}`,
  },
  
  // Standings
  standings: {
    byLeague: (leagueId?: number, season?: number, standingsType?: string) => 
      `standings:${leagueId || 'all'}:${season || 'current'}:${standingsType || 'regular'}`,
    wildcard: (season?: number) => `standings:wildcard:${season || 'current'}`,
  },
  
  // Leagues and Divisions
  leagues: {
    all: () => `leagues:all`,
    byId: (leagueId: number) => `league:${leagueId}`,
  },
  
  divisions: {
    all: () => `divisions:all`,
    byId: (divisionId: number) => `division:${divisionId}`,
  },
  
  // Venues
  venues: {
    all: () => `venues:all`,
    byId: (venueId: number) => `venue:${venueId}`,
  },
  
  // Seasons
  seasons: {
    all: (sportId?: number) => `seasons:${sportId || 'mlb'}`,
    current: () => `season:current`,
  },
  
  // Stats
  stats: (type: string, params: any) => `stats:${type}:${JSON.stringify(params)}`,
  
  // Advanced Analytics
  analytics: {
    winProbability: (gameId: number) => `analytics:winprob:${gameId}`,
    playerPerformance: (playerId: number, params?: any) => `analytics:player:${playerId}:${JSON.stringify(params || {})}`,
    teamMatchups: (params: any) => `analytics:matchups:${JSON.stringify(params)}`,
  },
  
  // News and External Data
  news: (source: string, params?: any) => `news:${source}:${JSON.stringify(params || {})}`,
  weather: (venueId: number, date: string) => `weather:${venueId}:${date}`,
  
  // Transactions
  transactions: (params?: any) => `transactions:${JSON.stringify(params || {})}`,
  
  // Predictions
  predictions: (type: string, params: any) => `predictions:${type}:${JSON.stringify(params)}`,
  
  // Aggregated Data
  leaderboards: (category: string, params: any) => `leaderboards:${category}:${JSON.stringify(params)}`,
  rankings: (type: string, params: any) => `rankings:${type}:${JSON.stringify(params)}`,
  
  // Live Data
  liveScores: () => `live:scores`,
  liveUpdates: (gameId: number) => `live:updates:${gameId}`,
  
  // User-specific (for future use)
  userFavorites: (userId: string) => `user:${userId}:favorites`,
  userSettings: (userId: string) => `user:${userId}:settings`,
  
  // System
  health: () => `system:health`,
  metrics: (type: string) => `system:metrics:${type}`,
  
  // Scores and Results
  scores: () => `scores:latest`,
};

export const CacheTTL = {
  // Static data (rarely changes)
  teams: 86400, // 24 hours
  venues: 86400, // 24 hours
  positions: 86400, // 24 hours
  seasons: 86400, // 24 hours

  // Semi-static data (changes daily)
  rosters: 3600, // 1 hour
  playerBios: 3600, // 1 hour
  teamInfo: 3600, // 1 hour

  // Dynamic data (changes frequently)
  stats: 1800, // 30 minutes
  standings: 900, // 15 minutes
  schedule: 900, // 15 minutes
  news: 900, // 15 minutes
  transactions: 3600, // 1 hour

  // Live data (changes very frequently)
  liveGames: 30, // 30 seconds
  scores: 15, // 15 seconds
  playByPlay: 10, // 10 seconds

  // Analytics (computed data)
  analytics: 3600, // 1 hour
  projections: 21600, // 6 hours
  historicalAnalytics: 86400, // 24 hours
};

/**
 * Get appropriate TTL based on data type and current context
 */
export const getContextualTTL = (dataType: string, context?: any): number => {
  const baseTTL = CacheTTL[dataType as keyof typeof CacheTTL] || 3600;

  // Adjust TTL based on context
  if (context?.isLive) {
    return Math.min(baseTTL, 30); // Max 30 seconds for live data
  }

  if (context?.isHistorical) {
    return Math.max(baseTTL, 86400); // Min 24 hours for historical data
  }

  // During active game hours, reduce TTL for game-related data
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour >= 17 && hour <= 6 && (dataType.includes('game') || dataType.includes('score'))) {
    return Math.floor(baseTTL / 2);
  }

  return baseTTL;
};

/**
 * Pattern matching for cache invalidation
 */
export const getCachePattern = (pattern: string): string => {
  return `hank:${pattern}*`;
};

export const CachePatterns = {
  allTeams: () => getCachePattern('team*'),
  allPlayers: () => getCachePattern('player*'),
  allGames: () => getCachePattern('game*'),
  allStats: () => getCachePattern('stats*'),
  teamData: (teamId: number) => getCachePattern(`*team*${teamId}*`),
  playerData: (personId: number) => getCachePattern(`*player*${personId}*`),
  gameData: (gamePk: number) => getCachePattern(`*game*${gamePk}*`),
  dateData: (date: string) => getCachePattern(`*${date}*`),
  seasonData: (season: string) => getCachePattern(`*${season}*`),
};
