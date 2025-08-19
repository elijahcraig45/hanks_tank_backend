export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    timestamp: string;
    source: string;
    cache?: {
      hit: boolean;
      ttl?: number;
    };
    analytics?: {
      enhanced: boolean;
      computeTime?: string;
    };
    realtime?: {
      lastUpdate: string;
      isLive: boolean;
    };
    version?: string;
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export class ResponseFormatter {
  private static readonly VERSION = '2.0';
  private static readonly SOURCE = 'hanks-tank-api';

  /**
   * Format successful response
   */
  static success<T>(
    data: T,
    meta?: Partial<ApiResponse['meta']>,
    pagination?: ApiResponse['pagination']
  ): ApiResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        source: this.SOURCE,
        version: this.VERSION,
        ...meta
      },
      ...(pagination && { pagination })
    };
  }

  /**
   * Format error response
   */
  static error(
    code: string,
    message: string,
    details?: any
  ): ApiResponse {
    return {
      success: false,
      error: {
        code,
        message,
        details
      },
      meta: {
        timestamp: new Date().toISOString(),
        source: this.SOURCE,
        version: this.VERSION
      }
    };
  }

  /**
   * Format cached response
   */
  static cached<T>(
    data: T,
    ttl?: number,
    meta?: Partial<ApiResponse['meta']>
  ): ApiResponse<T> {
    return this.success(data, {
      ...meta,
      cache: {
        hit: true,
        ttl
      }
    });
  }

  /**
   * Format paginated response
   */
  static paginated<T>(
    data: T,
    page: number,
    limit: number,
    total: number,
    meta?: Partial<ApiResponse['meta']>
  ): ApiResponse<T> {
    const hasNext = (page * limit) < total;
    const hasPrev = page > 1;

    return this.success(data, meta, {
      page,
      limit,
      total,
      hasNext,
      hasPrev
    });
  }

  /**
   * Format analytics-enhanced response
   */
  static enhanced<T>(
    data: T,
    computeTime: string,
    meta?: Partial<ApiResponse['meta']>
  ): ApiResponse<T> {
    return this.success(data, {
      ...meta,
      analytics: {
        enhanced: true,
        computeTime
      }
    });
  }

  /**
   * Format real-time response
   */
  static realtime<T>(
    data: T,
    lastUpdate: Date,
    meta?: Partial<ApiResponse['meta']>
  ): ApiResponse<T> {
    return this.success(data, {
      ...meta,
      realtime: {
        lastUpdate: lastUpdate.toISOString(),
        isLive: true
      }
    });
  }
}

// Common error codes
export const ErrorCodes = {
  // Client errors (4xx)
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  SEASON_NOT_FOUND: 'SEASON_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Server errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  MLB_API_ERROR: 'MLB_API_ERROR',
  MLB_API_TIMEOUT: 'MLB_API_TIMEOUT',
  CACHE_ERROR: 'CACHE_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Analytics errors
  CALCULATION_ERROR: 'CALCULATION_ERROR',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  MODEL_ERROR: 'MODEL_ERROR'
} as const;

// Common error messages
export const ErrorMessages = {
  [ErrorCodes.INVALID_REQUEST]: 'The request is invalid or malformed',
  [ErrorCodes.INVALID_PARAMETER]: 'One or more parameters are invalid',
  [ErrorCodes.MISSING_PARAMETER]: 'Required parameter is missing',
  [ErrorCodes.RESOURCE_NOT_FOUND]: 'The requested resource was not found',
  [ErrorCodes.PLAYER_NOT_FOUND]: 'Player not found',
  [ErrorCodes.TEAM_NOT_FOUND]: 'Team not found',
  [ErrorCodes.GAME_NOT_FOUND]: 'Game not found',
  [ErrorCodes.SEASON_NOT_FOUND]: 'Season not found',
  [ErrorCodes.UNAUTHORIZED]: 'Authentication required',
  [ErrorCodes.FORBIDDEN]: 'Access denied',
  [ErrorCodes.RATE_LIMITED]: 'Rate limit exceeded',
  [ErrorCodes.VALIDATION_ERROR]: 'Request validation failed',
  [ErrorCodes.INTERNAL_ERROR]: 'Internal server error',
  [ErrorCodes.MLB_API_ERROR]: 'MLB API error',
  [ErrorCodes.MLB_API_TIMEOUT]: 'MLB API timeout',
  [ErrorCodes.CACHE_ERROR]: 'Cache service error',
  [ErrorCodes.DATABASE_ERROR]: 'Database error',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 'External service error',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable',
  [ErrorCodes.CALCULATION_ERROR]: 'Analytics calculation error',
  [ErrorCodes.INSUFFICIENT_DATA]: 'Insufficient data for calculation',
  [ErrorCodes.MODEL_ERROR]: 'Predictive model error'
} as const;

// Helper functions for common error responses
export const CommonErrors = {
  invalidTeamId: (teamId: string) => 
    ResponseFormatter.error(
      ErrorCodes.INVALID_PARAMETER,
      `Invalid team ID: ${teamId}. Team ID must be a valid number.`,
      { parameter: 'teamId', value: teamId }
    ),

  invalidPlayerId: (playerId: string) =>
    ResponseFormatter.error(
      ErrorCodes.INVALID_PARAMETER,
      `Invalid player ID: ${playerId}. Player ID must be a valid number.`,
      { parameter: 'playerId', value: playerId }
    ),

  invalidGameId: (gameId: string) =>
    ResponseFormatter.error(
      ErrorCodes.INVALID_PARAMETER,
      `Invalid game ID: ${gameId}. Game ID must be a valid number.`,
      { parameter: 'gameId', value: gameId }
    ),

  invalidSeason: (season: string) =>
    ResponseFormatter.error(
      ErrorCodes.INVALID_PARAMETER,
      `Invalid season: ${season}. Season must be a 4-digit year.`,
      { parameter: 'season', value: season }
    ),

  invalidDateRange: (startDate: string, endDate: string) =>
    ResponseFormatter.error(
      ErrorCodes.INVALID_PARAMETER,
      'Invalid date range. Start date must be before end date.',
      { startDate, endDate }
    ),

  teamNotFound: (teamId: number) =>
    ResponseFormatter.error(
      ErrorCodes.TEAM_NOT_FOUND,
      `Team with ID ${teamId} not found.`,
      { teamId }
    ),

  playerNotFound: (playerId: number) =>
    ResponseFormatter.error(
      ErrorCodes.PLAYER_NOT_FOUND,
      `Player with ID ${playerId} not found.`,
      { playerId }
    ),

  gameNotFound: (gameId: number) =>
    ResponseFormatter.error(
      ErrorCodes.GAME_NOT_FOUND,
      `Game with ID ${gameId} not found.`,
      { gameId }
    ),

  mlbApiError: (statusCode: number, message: string) =>
    ResponseFormatter.error(
      ErrorCodes.MLB_API_ERROR,
      `MLB API error (${statusCode}): ${message}`,
      { statusCode, source: 'mlb-api' }
    ),

  cacheError: (operation: string, key: string) =>
    ResponseFormatter.error(
      ErrorCodes.CACHE_ERROR,
      `Cache ${operation} operation failed for key: ${key}`,
      { operation, key }
    ),

  rateLimited: (resetTime: Date) =>
    ResponseFormatter.error(
      ErrorCodes.RATE_LIMITED,
      'API rate limit exceeded. Please try again later.',
      { resetTime: resetTime.toISOString() }
    ),

  serviceUnavailable: (service: string, retryAfter?: number) =>
    ResponseFormatter.error(
      ErrorCodes.SERVICE_UNAVAILABLE,
      `${service} is temporarily unavailable.`,
      { service, retryAfter }
    ),

  validationError: (field: string, rule: string, value: any) =>
    ResponseFormatter.error(
      ErrorCodes.VALIDATION_ERROR,
      `Validation failed for field '${field}': ${rule}`,
      { field, rule, value }
    ),

  insufficientData: (dataType: string, requiredSample: number, availableSample: number) =>
    ResponseFormatter.error(
      ErrorCodes.INSUFFICIENT_DATA,
      `Insufficient ${dataType} data for analysis. Required: ${requiredSample}, Available: ${availableSample}`,
      { dataType, requiredSample, availableSample }
    )
};

// Type guards for response validation
export const isSuccessResponse = <T>(response: ApiResponse<T>): response is ApiResponse<T> & { success: true, data: T } => {
  return response.success === true && response.data !== undefined;
};

export const isErrorResponse = (response: ApiResponse): response is ApiResponse & { success: false, error: NonNullable<ApiResponse['error']> } => {
  return response.success === false && response.error !== undefined;
};

// Response transformation utilities
export const transformMLBResponse = <T>(
  mlbData: any,
  transformer: (data: any) => T,
  meta?: Partial<ApiResponse['meta']>
): ApiResponse<T> => {
  try {
    const transformedData = transformer(mlbData);
    return ResponseFormatter.success(transformedData, meta);
  } catch (error) {
    return ResponseFormatter.error(
      ErrorCodes.INTERNAL_ERROR,
      'Failed to transform MLB API response',
      { originalError: error instanceof Error ? error.message : 'Unknown error' }
    );
  }
};
