// Configuration settings for the application
import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // MLB API configuration
  mlbApi: {
    baseUrl: process.env.MLB_API_BASE_URL || 'https://statsapi.mlb.com/api/v1',
    timeout: parseInt(process.env.MLB_API_TIMEOUT || '5000', 10),
    retries: parseInt(process.env.MLB_API_RETRIES || '3', 10),
  },
  
  // Cache configuration
  cache: {
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || '0', 10),
    },
    ttl: {
      teams: parseInt(process.env.CACHE_TTL_TEAMS || '86400', 10), // 24 hours
      players: parseInt(process.env.CACHE_TTL_PLAYERS || '3600', 10), // 1 hour
      games: parseInt(process.env.CACHE_TTL_GAMES || '300', 10), // 5 minutes
      liveGames: parseInt(process.env.CACHE_TTL_GAMES_LIVE || '30', 10), // 30 seconds
      standings: parseInt(process.env.CACHE_TTL_STANDINGS || '3600', 10), // 1 hour
      schedule: parseInt(process.env.CACHE_TTL_SCHEDULE || '1800', 10), // 30 minutes
      stats: parseInt(process.env.CACHE_TTL_STATS || '3600', 10), // 1 hour
    },
  },
  
  // Database configuration
  database: {
    postgres: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'mlb_analytics',
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true',
    },
  },
  
  // External API configuration
  external: {
    weather: {
      apiKey: process.env.WEATHER_API_KEY || '',
      baseUrl: process.env.WEATHER_API_URL || 'https://api.openweathermap.org/data/2.5',
    },
    news: {
      apiKey: process.env.NEWS_API_KEY || '',
      baseUrl: process.env.NEWS_API_URL || 'https://newsapi.org/v2',
    },
  },
  
  // Rate limiting configuration
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '900000', 10), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // limit each IP to 100 requests per windowMs
  },
  
  // CORS configuration
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  },
  
  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
    file: {
      enabled: process.env.LOG_FILE_ENABLED === 'true',
      filename: process.env.LOG_FILE_NAME || 'app.log',
      maxSize: process.env.LOG_FILE_MAX_SIZE || '20m',
      maxFiles: parseInt(process.env.LOG_FILE_MAX_FILES || '14', 10),
    },
  },
  
  // Application features
  features: {
    realTimeUpdates: process.env.FEATURE_REALTIME_UPDATES !== 'false',
    advancedAnalytics: process.env.FEATURE_ADVANCED_ANALYTICS !== 'false',
    caching: process.env.FEATURE_CACHING !== 'false',
    compression: process.env.FEATURE_COMPRESSION !== 'false',
  },
  
  // Security configuration
  security: {
    helmet: {
      enabled: process.env.HELMET_ENABLED !== 'false',
    },
    jwt: {
      secret: process.env.JWT_SECRET || 'your-secret-key',
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    },
  },
  
  // Monitoring and metrics
  monitoring: {
    prometheus: {
      enabled: process.env.PROMETHEUS_ENABLED === 'true',
      port: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),
    },
    healthCheck: {
      enabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
      endpoint: process.env.HEALTH_CHECK_ENDPOINT || '/health',
    },
  },
};

// Validate required configuration
export function validateConfig(): void {
  const requiredEnvVars: string[] = [];
  
  if (config.nodeEnv === 'production') {
    requiredEnvVars.push(
      'MLB_API_BASE_URL',
      'REDIS_URL',
    );
  }
  
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export default config;
