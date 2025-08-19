# Hank's Tank Backend - MLB StatsAPI Implementation Guide

## 🎯 Project Overview

This guide outlines the complete rebuilding of the Hank's Tank backend to leverage MLB's official StatsAPI instead of static database storage. The new architecture focuses on real-time data, intelligent caching, and advanced analytics.

## 🏗 Architecture Overview

```
Frontend (React) → API Gateway → Backend Services → MLB StatsAPI
                              ↓
                         Cache Layer (Redis)
                              ↓
                      Analytics Database (PostgreSQL)
                              ↓
                        Background Jobs
```

## 📋 Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- [ ] Set up Express.js server with TypeScript
- [ ] Implement caching layer with Redis
- [ ] Create MLB API wrapper service
- [ ] Set up error handling and logging
- [ ] Implement rate limiting

### Phase 2: Core Endpoints (Week 2)
- [ ] Teams endpoints
- [ ] Players endpoints  
- [ ] Games/Schedule endpoints
- [ ] Basic statistics endpoints
- [ ] Health checks and monitoring

### Phase 3: Advanced Features (Week 3)
- [ ] Real-time game data (WebSockets)
- [ ] Advanced analytics calculations
- [ ] News integration
- [ ] Predictive models
- [ ] Performance optimization

### Phase 4: Integration & Testing (Week 4)
- [ ] Frontend integration
- [ ] Load testing
- [ ] Performance monitoring
- [ ] Documentation
- [ ] Deployment

## 🛠 Technology Stack

### Core Technologies:
- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Language**: TypeScript
- **Cache**: Redis
- **Database**: PostgreSQL (for analytics only)
- **Queue**: Bull Queue (Redis-based)

### External Services:
- **MLB StatsAPI**: Primary data source
- **Weather API**: Game weather data
- **News APIs**: MLB news aggregation

### DevOps:
- **Containerization**: Docker
- **Orchestration**: Docker Compose / Kubernetes
- **Monitoring**: Prometheus + Grafana
- **Logging**: Winston + ELK Stack

## 📁 Project Structure

```
hanks_tank_backend/
├── src/
│   ├── controllers/          # Route handlers
│   │   ├── teams.controller.ts
│   │   ├── players.controller.ts
│   │   ├── games.controller.ts
│   │   ├── stats.controller.ts
│   │   └── analytics.controller.ts
│   ├── services/             # Business logic
│   │   ├── mlb-api.service.ts
│   │   ├── cache.service.ts
│   │   ├── analytics.service.ts
│   │   ├── weather.service.ts
│   │   └── news.service.ts
│   ├── models/               # Data models
│   │   ├── Player.ts
│   │   ├── Team.ts
│   │   ├── Game.ts
│   │   └── Stats.ts
│   ├── middleware/           # Express middleware
│   │   ├── auth.middleware.ts
│   │   ├── cache.middleware.ts
│   │   ├── rateLimit.middleware.ts
│   │   └── error.middleware.ts
│   ├── routes/               # API routes
│   │   ├── teams.routes.ts
│   │   ├── players.routes.ts
│   │   ├── games.routes.ts
│   │   ├── stats.routes.ts
│   │   └── analytics.routes.ts
│   ├── utils/                # Utility functions
│   │   ├── cache-keys.ts
│   │   ├── date-helpers.ts
│   │   ├── response-formatter.ts
│   │   └── validators.ts
│   ├── types/                # TypeScript types
│   │   ├── mlb-api.types.ts
│   │   ├── cache.types.ts
│   │   └── response.types.ts
│   ├── config/               # Configuration
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   ├── mlb-api.ts
│   │   └── app.ts
│   ├── jobs/                 # Background jobs
│   │   ├── data-refresh.job.ts
│   │   ├── analytics.job.ts
│   │   └── news-aggregation.job.ts
│   └── app.ts               # Main application
├── tests/                   # Test files
├── docs/                    # Documentation
├── docker/                  # Docker configuration
├── scripts/                 # Utility scripts
├── .env.example            # Environment variables template
├── package.json
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml
```

## 🚀 Quick Start Implementation

### 1. Initialize Project

```bash
mkdir hanks_tank_backend_v2
cd hanks_tank_backend_v2
npm init -y

# Install dependencies
npm install express cors helmet compression dotenv
npm install redis ioredis pg
npm install axios rate-limiter-flexible
npm install winston bull
npm install @types/express @types/cors @types/node
npm install typescript ts-node nodemon --save-dev

# Initialize TypeScript
npx tsc --init
```

### 2. Create Core Configuration

**tsconfig.json**:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**package.json scripts**:
```json
{
  "scripts": {
    "dev": "nodemon src/app.ts",
    "build": "tsc",
    "start": "node dist/app.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint src/**/*.ts",
    "format": "prettier --write src/**/*.ts"
  }
}
```

### 3. Environment Configuration

**.env.example**:
```bash
# Server Configuration
NODE_ENV=development
PORT=3000
API_VERSION=v1

# MLB API Configuration
MLB_API_BASE_URL=https://statsapi.mlb.com/api/v1
MLB_API_TIMEOUT=5000
MLB_API_RETRY_ATTEMPTS=3

# Redis Configuration
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
REDIS_DB=0

# PostgreSQL Configuration (for analytics)
DATABASE_URL=postgresql://user:password@localhost:5432/hanks_tank
DB_POOL_MIN=2
DB_POOL_MAX=10

# Cache TTL Settings (in seconds)
CACHE_TTL_TEAMS=86400      # 24 hours
CACHE_TTL_PLAYERS=3600     # 1 hour
CACHE_TTL_GAMES_LIVE=30    # 30 seconds
CACHE_TTL_GAMES_FINAL=3600 # 1 hour
CACHE_TTL_STATS=1800       # 30 minutes
CACHE_TTL_SCHEDULE=900     # 15 minutes

# External APIs
WEATHER_API_KEY=your_weather_api_key
NEWS_API_KEY=your_news_api_key

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=1000

# Logging
LOG_LEVEL=info
LOG_FILE_PATH=./logs

# Monitoring
ENABLE_METRICS=true
METRICS_PORT=9090
```

### 4. Core Application Setup

**src/config/app.ts**:
```typescript
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    env: process.env.NODE_ENV || 'development',
    apiVersion: process.env.API_VERSION || 'v1'
  },
  mlbApi: {
    baseUrl: process.env.MLB_API_BASE_URL || 'https://statsapi.mlb.com/api/v1',
    timeout: parseInt(process.env.MLB_API_TIMEOUT || '5000'),
    retryAttempts: parseInt(process.env.MLB_API_RETRY_ATTEMPTS || '3')
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0')
  },
  cache: {
    ttl: {
      teams: parseInt(process.env.CACHE_TTL_TEAMS || '86400'),
      players: parseInt(process.env.CACHE_TTL_PLAYERS || '3600'),
      gamesLive: parseInt(process.env.CACHE_TTL_GAMES_LIVE || '30'),
      gamesFinal: parseInt(process.env.CACHE_TTL_GAMES_FINAL || '3600'),
      stats: parseInt(process.env.CACHE_TTL_STATS || '1800'),
      schedule: parseInt(process.env.CACHE_TTL_SCHEDULE || '900')
    }
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000')
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || './logs'
  }
};
```

### 5. MLB API Service Implementation

**src/services/mlb-api.service.ts**:
```typescript
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { config } from '../config/app';
import { logger } from '../utils/logger';

export class MLBApiService {
  private client: AxiosInstance;
  private retryDelay = 1000; // Initial retry delay in ms

  constructor() {
    this.client = axios.create({
      baseURL: config.mlbApi.baseUrl,
      timeout: config.mlbApi.timeout,
      headers: {
        'User-Agent': 'HanksTank/2.0',
        'Accept': 'application/json'
      }
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`MLB API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('MLB API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling and retries
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`MLB API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      async (error) => {
        const { config: requestConfig, response } = error;
        
        // Don't retry if we've already retried too many times
        if (requestConfig.__retryCount >= config.mlbApi.retryAttempts) {
          logger.error('MLB API Max retries exceeded:', error);
          return Promise.reject(error);
        }

        // Initialize retry count
        requestConfig.__retryCount = requestConfig.__retryCount || 0;
        requestConfig.__retryCount++;

        // Only retry on network errors or 5xx errors
        if (!response || (response.status >= 500 && response.status < 600)) {
          logger.warn(`MLB API Retry ${requestConfig.__retryCount}/${config.mlbApi.retryAttempts}: ${error.message}`);
          
          // Exponential backoff
          const delay = this.retryDelay * Math.pow(2, requestConfig.__retryCount - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          return this.client(requestConfig);
        }

        return Promise.reject(error);
      }
    );
  }

  // Teams
  async getTeams(params?: any): Promise<any> {
    const response = await this.client.get('/teams', { params });
    return response.data;
  }

  async getTeam(teamId: number, params?: any): Promise<any> {
    const response = await this.client.get(`/teams/${teamId}`, { params });
    return response.data;
  }

  async getTeamRoster(teamId: number, params?: any): Promise<any> {
    const response = await this.client.get(`/teams/${teamId}/roster`, { params });
    return response.data;
  }

  // Players
  async getPlayer(personId: number, params?: any): Promise<any> {
    const response = await this.client.get(`/people/${personId}`, { params });
    return response.data;
  }

  async getPlayers(personIds: number[], params?: any): Promise<any> {
    const ids = personIds.join(',');
    const response = await this.client.get('/people', { 
      params: { personIds: ids, ...params } 
    });
    return response.data;
  }

  // Games & Schedule
  async getSchedule(params?: any): Promise<any> {
    const response = await this.client.get('/schedule', { params });
    return response.data;
  }

  async getGame(gamePk: number, params?: any): Promise<any> {
    const response = await this.client.get(`/game/${gamePk}/feed/live`, { params });
    return response.data;
  }

  async getGameBoxscore(gamePk: number, params?: any): Promise<any> {
    const response = await this.client.get(`/game/${gamePk}/boxscore`, { params });
    return response.data;
  }

  async getGamePlayByPlay(gamePk: number, params?: any): Promise<any> {
    const response = await this.client.get(`/game/${gamePk}/playByPlay`, { params });
    return response.data;
  }

  // Statistics
  async getStats(params?: any): Promise<any> {
    const response = await this.client.get('/stats', { params });
    return response.data;
  }

  async getStatsLeaders(params?: any): Promise<any> {
    const response = await this.client.get('/stats/leaders', { params });
    return response.data;
  }

  // Standings
  async getStandings(params?: any): Promise<any> {
    const response = await this.client.get('/standings', { params });
    return response.data;
  }

  // Utility method for custom endpoints
  async get(endpoint: string, params?: any): Promise<any> {
    const response = await this.client.get(endpoint, { params });
    return response.data;
  }
}

export const mlbApi = new MLBApiService();
```

### 6. Cache Service Implementation

**src/services/cache.service.ts**:
```typescript
import Redis from 'ioredis';
import { config } from '../config/app';
import { logger } from '../utils/logger';

export class CacheService {
  private redis: Redis;
  private isConnected = false;

  constructor() {
    this.redis = new Redis(config.redis.url, {
      password: config.redis.password,
      db: config.redis.db,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      logger.info('Redis connected');
      this.isConnected = true;
    });

    this.redis.on('error', (error) => {
      logger.error('Redis error:', error);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
    });
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isConnected) {
      logger.warn('Redis not connected, skipping cache get');
      return null;
    }

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        logger.debug(`Cache hit: ${key}`);
        return JSON.parse(cached);
      }
      logger.debug(`Cache miss: ${key}`);
      return null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
    if (!this.isConnected) {
      logger.warn('Redis not connected, skipping cache set');
      return false;
    }

    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, serialized);
      } else {
        await this.redis.set(key, serialized);
      }
      logger.debug(`Cache set: ${key} (TTL: ${ttlSeconds || 'none'})`);
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      return false;
    }
  }

  async del(key: string): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      await this.redis.del(key);
      logger.debug(`Cache deleted: ${key}`);
      return true;
    } catch (error) {
      logger.error('Cache delete error:', error);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Cache exists error:', error);
      return false;
    }
  }

  async flush(): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      await this.redis.flushdb();
      logger.info('Cache flushed');
      return true;
    } catch (error) {
      logger.error('Cache flush error:', error);
      return false;
    }
  }

  async getTTL(key: string): Promise<number> {
    if (!this.isConnected) {
      return -1;
    }

    try {
      return await this.redis.ttl(key);
    } catch (error) {
      logger.error('Cache TTL error:', error);
      return -1;
    }
  }

  isReady(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    await this.redis.disconnect();
    this.isConnected = false;
  }
}

export const cacheService = new CacheService();
```

### 7. Response Formatter Utility

**src/utils/response-formatter.ts**:
```typescript
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
        source: 'mlb-statsapi',
        ...meta
      },
      ...(pagination && { pagination })
    };
  }

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
        source: 'mlb-statsapi'
      }
    };
  }

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
}
```

This implementation guide provides a solid foundation for rebuilding your backend. The next steps would be to implement specific controllers and routes for each major functionality area. Would you like me to continue with specific controller implementations or focus on any particular aspect of the architecture?
