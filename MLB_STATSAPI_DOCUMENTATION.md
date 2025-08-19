# MLB StatsAPI Complete Endpoint Documentation

## Overview

This document provides comprehensive documentation for rebuilding the Hank's Tank backend using the official MLB StatsAPI endpoints. This will replace the current PostgreSQL/BigQuery hybrid approach with a unified system that directly interfaces with MLB's live data APIs.

## Base URL
```
https://statsapi.mlb.com/api/v1/
```

## Core Architecture Philosophy

Instead of storing static data in databases, the new backend will:
1. **Cache intelligently** - Store frequently accessed data with appropriate TTL
2. **Stream live data** - Real-time game data, scores, and play-by-play
3. **Aggregate efficiently** - Pre-process complex queries for faster frontend response
4. **Scale dynamically** - Handle varying load during peak game times

---

# 📊 CORE DATA ENDPOINTS

## 1. Teams & Organizations

### `GET /teams`
**Purpose**: Retrieve all MLB teams with metadata
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/teams`

#### Parameters:
- `season` (optional): Specific season year
- `activeStatus` (optional): 'Yes', 'No', or 'Both'
- `leagueIds` (optional): Filter by league (103=AL, 104=NL)
- `sportId` (optional): Sport ID (1=MLB)
- `gameType` (optional): Game type filter
- `hydrate` (optional): Additional data fields
- `fields` (optional): Specific fields to return

#### Implementation Strategy:
```javascript
app.get('/api/teams', async (req, res) => {
  const { season = '2025', activeStatus = 'Yes', leagueIds, hydrate } = req.query;
  // Cache for 24 hours - team data rarely changes
  // Enrich with additional metadata (colors, logos, etc.)
});
```

#### Response Structure:
```json
{
  "teams": [
    {
      "id": 144,
      "name": "Atlanta Braves",
      "teamCode": "ATL",
      "fileCode": "atl",
      "abbreviation": "ATL",
      "teamName": "Braves",
      "locationName": "Atlanta",
      "firstYearOfPlay": "1966",
      "league": {
        "id": 104,
        "name": "National League"
      },
      "division": {
        "id": 204,
        "name": "National League East"
      },
      "venue": {
        "id": 4705,
        "name": "Truist Park"
      },
      "springVenue": {
        "id": 5380,
        "name": "CoolToday Park"
      },
      "teamStats": {},
      "springLeague": {},
      "allStarStatus": "",
      "active": true
    }
  ]
}
```

### `GET /teams/{teamId}`
**Purpose**: Individual team details with enhanced data
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/teams/{teamId}`

#### Enhanced Features:
- Historical performance trends
- Current roster integration
- Recent news and updates
- Social media integration
- Advanced analytics

---

### `GET /teams/{teamId}/roster`
**Purpose**: Current team roster with player details
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/teams/{teamId}/roster`

#### Parameters:
- `rosterType`: 'Active', '40Man', 'fullSeason', etc.
- `season`: Season year
- `date`: Specific date for historical rosters
- `hydrate`: Additional player data

#### Implementation:
```javascript
app.get('/api/teams/:teamId/roster', async (req, res) => {
  const { teamId } = req.params;
  const { rosterType = 'Active', season = '2025', date, hydrate } = req.query;
  // Cache for 6 hours during season, 24 hours off-season
  // Enrich with player stats and performance metrics
});
```

---

## 2. Player Data & Statistics

### `GET /people/{personId}`
**Purpose**: Individual player biographical and current information
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/people/{personId}`

#### Enhanced Implementation:
```javascript
app.get('/api/players/:personId', async (req, res) => {
  const { personId } = req.params;
  const { hydrate = 'stats(group=[hitting,pitching,fielding],type=[career,season])' } = req.query;
  
  // Multi-source data aggregation:
  // 1. Basic player info from MLB API
  // 2. Advanced stats calculations
  // 3. Performance trends
  // 4. Injury history
  // 5. Contract information (if available)
  // 6. Social media/news integration
});
```

#### Response Enhancement:
```json
{
  "people": [
    {
      "id": 518516,
      "fullName": "Ronald Acuña Jr.",
      "link": "/api/v1/people/518516",
      "firstName": "Ronald",
      "lastName": "Acuña Jr.",
      "primaryNumber": "13",
      "birthDate": "1997-12-18",
      "currentAge": 27,
      "birthCity": "La Guaira",
      "birthCountry": "Venezuela",
      "height": "6' 0\"",
      "weight": 205,
      "active": true,
      "primaryPosition": {
        "code": "8",
        "name": "Outfielder",
        "type": "Outfielder",
        "abbreviation": "OF"
      },
      "useName": "Ronald",
      "middleName": "José",
      "boxscoreName": "Acuña Jr.",
      "nickName": "El Abusador",
      "gender": "M",
      "isPlayer": true,
      "isVerified": true,
      "draftYear": 2014,
      "mlbDebutDate": "2018-04-25",
      "batSide": {
        "code": "R",
        "description": "Right"
      },
      "pitchHand": {
        "code": "R",
        "description": "Right"
      },
      "nameFirstLast": "Ronald Acuña Jr.",
      "nameSlug": "ronald-acuna-jr-518516",
      "firstLastName": "Ronald Acuña Jr.",
      "lastFirstName": "Acuña Jr., Ronald",
      "lastInitName": "R. Acuña Jr.",
      "initLastName": "R. Acuña Jr.",
      "fullFMLName": "Ronald José Acuña Jr.",
      "fullLFMName": "Acuña Jr., Ronald José",
      "strikeZoneTop": 3.41,
      "strikeZoneBottom": 1.57,
      "currentTeam": {
        "id": 144,
        "name": "Atlanta Braves",
        "link": "/api/v1/teams/144"
      },
      "stats": [
        // Enhanced with calculated metrics, trends, projections
      ],
      "hanksAnalytics": {
        "projectedOPS": 0.925,
        "healthStatus": "Active",
        "trendingDirection": "UP",
        "seasonProjection": {
          "games": 155,
          "hits": 185,
          "homeRuns": 35,
          "rbi": 105,
          "stolenBases": 25
        }
      }
    }
  ]
}
```

### `GET /people/search`
**Purpose**: Player lookup and search functionality
**Implementation**: Custom endpoint using MLB lookup functions

#### Parameters:
- `name`: Full or partial name search
- `team`: Current team filter
- `position`: Position filter
- `active`: Active status filter

---

## 3. Game Data & Live Information

### `GET /schedule`
**Purpose**: Game schedules with comprehensive filtering
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/schedule`

#### Parameters:
- `date`: Specific date (YYYY-MM-DD)
- `startDate` / `endDate`: Date range
- `teamId`: Specific team
- `opponentId`: Opponent team
- `sportId`: Sport filter
- `gameTypes`: Game type filter
- `hydrate`: Additional data fields

#### Implementation Strategy:
```javascript
app.get('/api/schedule', async (req, res) => {
  const { 
    date, 
    startDate, 
    endDate, 
    teamId, 
    hydrate = 'team,linescore,decisions,person' 
  } = req.query;
  
  // Cache strategy:
  // - Future games: 4 hours
  // - Today's games: 15 minutes during game hours, 1 hour otherwise
  // - Past games: 24 hours
  
  // Enhancements:
  // - Weather data integration
  // - Probable pitchers with analytics
  // - Betting lines (if legal)
  // - Historical matchup data
  // - Attendance projections
});
```

#### Enhanced Response:
```json
{
  "dates": [
    {
      "date": "2025-08-19",
      "totalItems": 15,
      "totalEvents": 0,
      "totalGames": 15,
      "totalGamesInProgress": 2,
      "games": [
        {
          "gamePk": 747892,
          "link": "/api/v1/game/747892/feed/live",
          "gameType": "R",
          "season": "2025",
          "gameDate": "2025-08-19T23:20:00Z",
          "officialDate": "2025-08-19",
          "status": {
            "abstractGameState": "Live",
            "codedGameState": "I",
            "detailedState": "In Progress",
            "statusCode": "I",
            "startTimeTBD": false,
            "abstractGameCode": "L"
          },
          "teams": {
            "away": {
              "score": 3,
              "team": {
                "id": 144,
                "name": "Atlanta Braves"
              },
              "leagueRecord": {
                "wins": 78,
                "losses": 48,
                "pct": ".619"
              },
              "probablePitcher": {
                "id": 622491,
                "fullName": "Spencer Strider"
              }
            },
            "home": {
              "score": 2,
              "team": {
                "id": 121,
                "name": "New York Mets"
              },
              "leagueRecord": {
                "wins": 65,
                "losses": 61,
                "pct": ".516"
              }
            }
          },
          "venue": {
            "id": 3289,
            "name": "Citi Field"
          },
          "weather": {
            "condition": "Partly Cloudy",
            "temp": "78°F",
            "wind": "SW 8 mph"
          },
          "gameNotes": "NL East showdown with playoff implications",
          "hanksAnalytics": {
            "winProbability": {
              "away": 0.62,
              "home": 0.38
            },
            "totalExpectedRuns": 8.5,
            "keyPlayers": ["Ronald Acuña Jr.", "Pete Alonso"],
            "weatherImpact": "Minimal"
          }
        }
      ]
    }
  ]
}
```

### `GET /game/{gamePk}/feed/live`
**Purpose**: Live game data feed
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/game/{gamePk}/feed/live`

#### Real-time Implementation:
```javascript
app.get('/api/games/:gamePk/live', async (req, res) => {
  const { gamePk } = req.params;
  const { timecode } = req.query;
  
  // WebSocket integration for real-time updates
  // Cache: 30 seconds during live games, 1 hour for completed games
  // Enhanced with:
  // - Play prediction algorithms
  // - Real-time win probability
  // - Advanced pitch analytics
  // - Player performance in real-time
});
```

### `GET /game/{gamePk}/boxscore`
**Purpose**: Detailed game boxscore
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/game/{gamePk}/boxscore`

### `GET /game/{gamePk}/playByPlay`
**Purpose**: Play-by-play data with enhanced analytics
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/game/{gamePk}/playByPlay`

---

## 4. Statistics & Analytics

### `GET /stats`
**Purpose**: Comprehensive player and team statistics
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/stats`

#### Parameters:
- `stats`: Stat type ('season', 'career', 'gameLog')
- `group`: Stat group ('hitting', 'pitching', 'fielding')
- `gameType`: Game type filter
- `season`: Season year
- `playerPool`: Player pool filter
- `position`: Position filter
- `teamId`: Team filter
- `leagueId`: League filter
- `limit`: Result limit
- `offset`: Pagination offset

#### Enhanced Implementation:
```javascript
app.get('/api/stats', async (req, res) => {
  const {
    stats = 'season',
    group = 'hitting',
    season = '2025',
    teamId,
    playerPool = 'All',
    sortStat,
    order = 'desc',
    limit = 50
  } = req.query;
  
  // Advanced features:
  // - Calculated advanced metrics (wOBA, xwOBA, etc.)
  // - Situational splits
  // - Trend analysis
  // - Projection algorithms
  // - Historical comparisons
  // - League rankings and percentiles
});
```

### `GET /stats/leaders`
**Purpose**: Statistical leaders with enhanced context
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/stats/leaders`

#### Parameters:
- `leaderCategories`: Stat categories
- `season`: Season year
- `leagueId`: League filter
- `sportId`: Sport filter
- `limit`: Number of leaders
- `statGroup`: Stat group filter

---

## 5. Standings & Records

### `GET /standings`
**Purpose**: League standings with enhanced analytics
**MLB Endpoint**: `https://statsapi.mlb.com/api/v1/standings`

#### Enhanced Features:
```javascript
app.get('/api/standings', async (req, res) => {
  const { 
    leagueId = '103,104', 
    season = '2025', 
    standingsTypes = 'regularSeason',
    date 
  } = req.query;
  
  // Enhancements:
  // - Playoff probability calculations
  // - Strength of schedule analysis
  // - Recent trend analysis (L10, etc.)
  // - Division race analytics
  // - Wild card positioning
  // - Remaining schedule difficulty
});
```

---

# 🎯 ADVANCED ANALYTICS ENDPOINTS

## 1. Real-time Analytics

### `GET /analytics/win-probability/{gamePk}`
**Purpose**: Real-time win probability tracking
**Custom Implementation**: Combine multiple MLB endpoints

### `GET /analytics/player-performance/{personId}`
**Purpose**: Advanced player performance metrics
**Features**:
- xStats (Expected Statistics)
- Situational performance
- Clutch performance metrics
- Injury risk analysis
- Contract value assessment

### `GET /analytics/team-matchups`
**Purpose**: Team vs team historical and projected analytics
**Features**:
- Head-to-head records
- Pitching matchup advantages
- Lineup optimization
- Weather impact analysis

## 2. Predictive Analytics

### `GET /predictions/game/{gamePk}`
**Purpose**: Game outcome predictions
**Implementation**: Machine learning models using historical data

### `GET /predictions/season/{teamId}`
**Purpose**: Season projections for teams
**Features**:
- Projected wins/losses
- Playoff probability
- Division title probability
- Award predictions

---

# 🚀 SPECIALIZED ENDPOINTS

## 1. News & Content Integration

### `GET /news/team/{teamId}`
**Purpose**: Team-specific news aggregation
**Sources**: MLB.com, team websites, social media

### `GET /news/player/{personId}`
**Purpose**: Player-specific news and updates

## 2. Social Media Integration

### `GET /social/team/{teamId}`
**Purpose**: Team social media feed aggregation

### `GET /social/trending`
**Purpose**: Trending MLB topics and discussions

## 3. Historical Data

### `GET /history/player/{personId}`
**Purpose**: Comprehensive player history
**Features**:
- Career timeline
- Transaction history
- Award history
- Milestone tracking

### `GET /history/team/{teamId}`
**Purpose**: Team historical data
**Features**:
- Franchise history
- Stadium history
- Championship history
- Notable players

---

# 🔧 TECHNICAL IMPLEMENTATION STRATEGY

## Caching Strategy

### Cache Levels:
1. **Browser Cache**: Static data (team info, player bios) - 24 hours
2. **CDN Cache**: Semi-static data (standings, schedules) - 4 hours
3. **Redis Cache**: Dynamic data (live games, stats) - 30 seconds to 1 hour
4. **Application Cache**: Computed analytics - 15 minutes to 6 hours

### Cache Keys:
```javascript
const getCacheKey = (endpoint, params) => {
  const sortedParams = Object.keys(params).sort().map(key => `${key}:${params[key]}`).join('|');
  return `mlb:${endpoint}:${sortedParams}`;
};
```

## Data Refresh Strategy

### Real-time Data (WebSocket Implementation):
```javascript
// Live game updates every 30 seconds
// Score updates every 15 seconds during active innings
// Play-by-play updates real-time during at-bats
```

### Scheduled Updates:
```javascript
// Team rosters: Daily at 6 AM ET
// Season stats: Every 4 hours during season
// Historical data: Weekly during off-season
// News feeds: Every 15 minutes
```

## Error Handling & Resilience

### Circuit Breaker Pattern:
```javascript
const CircuitBreaker = require('opossum');

const options = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
};

const breaker = new CircuitBreaker(mlbApiCall, options);
```

### Fallback Strategies:
1. **Cached Data**: Serve stale data with appropriate headers
2. **Graceful Degradation**: Basic data when advanced features fail
3. **Retry Logic**: Exponential backoff for transient failures

## Rate Limiting

### MLB API Limits:
- Respect MLB's rate limits
- Implement intelligent request queuing
- Use batch requests where possible
- Monitor usage patterns

### Client Rate Limiting:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP'
});
```

---

# 📊 DATA MODELS & SCHEMAS

## Core Data Structures

### Player Model:
```javascript
const PlayerSchema = {
  id: Number,
  fullName: String,
  firstName: String,
  lastName: String,
  primaryNumber: String,
  birthDate: Date,
  birthCity: String,
  birthCountry: String,
  height: String,
  weight: Number,
  active: Boolean,
  primaryPosition: {
    code: String,
    name: String,
    abbreviation: String
  },
  currentTeam: {
    id: Number,
    name: String
  },
  mlbDebutDate: Date,
  batSide: Object,
  pitchHand: Object,
  stats: Array,
  // Enhanced fields
  analytics: {
    projectedStats: Object,
    performanceTrends: Array,
    injuryRisk: Number,
    clutchRating: Number
  }
};
```

### Game Model:
```javascript
const GameSchema = {
  gamePk: Number,
  gameDate: Date,
  officialDate: String,
  gameType: String,
  season: String,
  status: Object,
  teams: {
    away: Object,
    home: Object
  },
  venue: Object,
  weather: Object,
  // Enhanced fields
  analytics: {
    winProbability: Object,
    totalExpectedRuns: Number,
    keyMatchups: Array,
    predictedOutcome: Object
  }
};
```

---

# 🚦 API RESPONSE STANDARDS

## Standard Response Format:
```javascript
{
  "success": true,
  "data": { /* Actual data */ },
  "meta": {
    "timestamp": "2025-08-19T12:00:00Z",
    "source": "mlb-statsapi",
    "cache": {
      "hit": true,
      "ttl": 3600
    },
    "analytics": {
      "enhanced": true,
      "computeTime": "45ms"
    }
  },
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 750,
    "hasNext": true
  }
}
```

## Error Response Format:
```javascript
{
  "success": false,
  "error": {
    "code": "PLAYER_NOT_FOUND",
    "message": "Player with ID 123456 not found",
    "details": {
      "timestamp": "2025-08-19T12:00:00Z",
      "path": "/api/players/123456",
      "suggestion": "Check player ID or try search endpoint"
    }
  }
}
```

---

# 🔐 SECURITY & AUTHENTICATION

## API Key Management:
```javascript
// Rate limiting per API key
// Usage analytics per key
// Automatic key rotation
// Scope-based permissions
```

## CORS Configuration:
```javascript
const corsOptions = {
  origin: [
    'https://hanks-tank.com',
    'https://staging.hanks-tank.com',
    'http://localhost:3000' // Development
  ],
  credentials: true,
  optionsSuccessStatus: 200
};
```

---

# 📈 MONITORING & ANALYTICS

## Key Metrics to Track:
1. **Response Times**: Per endpoint, percentiles
2. **Cache Hit Rates**: Per data type
3. **Error Rates**: By endpoint and error type
4. **MLB API Usage**: Rate limit compliance
5. **User Engagement**: Most requested data
6. **Data Freshness**: Age of cached data served

## Logging Strategy:
```javascript
const winston = require('winston');

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});
```

---

# 🚀 DEPLOYMENT & INFRASTRUCTURE

## Container Configuration:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## Environment Variables:
```bash
# MLB API Configuration
MLB_API_BASE_URL=https://statsapi.mlb.com/api/v1
MLB_API_TIMEOUT=5000

# Cache Configuration
REDIS_URL=redis://localhost:6379
CACHE_TTL_GAMES=1800
CACHE_TTL_STATS=3600
CACHE_TTL_TEAMS=86400

# Database Configuration (for analytics)
DATABASE_URL=postgresql://user:pass@localhost:5432/hanks_tank

# Application Configuration
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# External Services
WEATHER_API_KEY=your_weather_api_key
NEWS_API_KEY=your_news_api_key
```

---

This comprehensive documentation provides the foundation for rebuilding your backend with a modern, scalable architecture that leverages the full power of MLB's StatsAPI while adding intelligent caching, advanced analytics, and enhanced user experience features.

The new system will be:
- **More reliable**: Direct MLB data instead of static database
- **More current**: Real-time data with intelligent caching
- **More scalable**: Cloud-native architecture
- **More insightful**: Advanced analytics and predictions
- **More maintainable**: Clean API design and modern practices
