# Hanks Tank Backend - MLB Analytics API

A modern, scalable backend service for MLB analytics providing historical data, real-time statistics, and advanced analytics through a hybrid data architecture.

## 🏗️ Architecture Overview

This backend service implements a **hybrid data architecture** that intelligently routes requests between multiple data sources:

- **BigQuery Historical Data** (2015-2024): 35,000+ records of comprehensive historical MLB data
- **FanGraphs API**: Advanced player analytics and Statcast information
- **MLB API**: Real-time games and current season data

## 🚀 Deployment

**Production Service**: [https://hankstank.uc.r.appspot.com](https://hankstank.uc.r.appspot.com)

### Quick Start

```bash
# Health Check
curl https://hankstank.uc.r.appspot.com/health

# Team Batting Stats
curl "https://hankstank.uc.r.appspot.com/api/teamBatting?year=2024"

# Player Statistics
curl "https://hankstank.uc.r.appspot.com/api/PlayerBatting?year=2024"
```

## 📊 Data Sources & Coverage

### Historical Data (BigQuery)
- **Years**: 2015-2024
- **Teams**: Complete team statistics, standings, roster information
- **Players**: Batting and pitching statistics for all players
- **Games**: Game results, scores, and metadata
- **Total Records**: 35,000+ data points

### Live Data Sources
- **MLB API**: Official MLB statistics and real-time data
- **FanGraphs**: Advanced analytics, Statcast data, and sabermetrics
- **Baseball Savant**: Statcast pitch-by-pitch data

## 🛠️ Technology Stack

- **Runtime**: Node.js 22 with TypeScript
- **Framework**: Express.js with CORS support
- **Cloud Platform**: Google Cloud Platform (App Engine)
- **Database**: Google BigQuery for historical data
- **External APIs**: MLB API, FanGraphs, Baseball Savant
- **Build System**: TypeScript compiler with automated deployment

## 📡 API Endpoints

### Legacy Endpoints (Backward Compatible)

| Endpoint | Description | Parameters |
|----------|-------------|------------|
| `GET /health` | Service health check | None |
| `GET /api/teamBatting` | Team batting statistics | `year`, `team` |
| `GET /api/TeamPitching` | Team pitching statistics | `year`, `team` |
| `GET /api/PlayerBatting` | Player batting statistics | `year`, `player` |
| `GET /api/PlayerPitching` | Player pitching statistics | `year`, `player` |
| `GET /api/Standings` | League standings | `year`, `league` |

### Advanced Endpoints

| Endpoint | Description | Parameters |
|----------|-------------|------------|
| `GET /api/playerData` | FanGraphs player data | `playerId`, `position` |
| `GET /api/statcast` | Statcast pitch data | `year`, `playerId`, `position` |
| `GET /api/availableStats` | Available statistics | `dataType` |

## 🏛️ Project Structure

```
hanks_tank_backend/
├── src/
│   ├── app.ts                    # Main application entry point
│   ├── config/                   # Configuration files
│   ├── controllers/              # Request handlers
│   │   └── legacy.controller.ts  # Backward compatibility layer
│   ├── routes/                   # API route definitions
│   │   ├── legacy.routes.ts      # Legacy endpoint routes
│   │   └── hybrid-teams.routes.ts
│   ├── services/                 # Business logic layer
│   │   ├── data-source.service.ts    # Hybrid data routing
│   │   ├── fangraphs.service.ts      # FanGraphs API integration
│   │   ├── mlb-api.service.ts        # MLB API service
│   │   └── bigquery.service.ts       # BigQuery data access
│   └── utils/                    # Utility functions
├── data/                         # Historical data files
│   ├── teams/                    # Team statistics and info
│   ├── players/                  # Player statistics
│   ├── games/                    # Game results
│   └── standings/                # League standings
├── scripts/                      # Data collection scripts
└── deploy/                       # Deployment configuration
```

## 🔧 Development

### Prerequisites

- Node.js 22+
- TypeScript
- Google Cloud SDK (for deployment)
- BigQuery access (for historical data)

### Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start development server
npm run dev

# Run type checking
npm run type-check
```

### Environment Variables

```bash
# Server Configuration
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Google Cloud Platform
GOOGLE_CLOUD_PROJECT=hankstank
GCP_PROJECT_ID=hankstank
GCP_BUCKET_NAME=hanks_tank_data
BQ_DATASET=mlb_historical_data

# External APIs
MLB_API_BASE_URL=https://statsapi.mlb.com/api/v1
FANGRAPHS_BASE_URL=https://www.fangraphs.com/api
STATCAST_BASE_URL=https://baseballsavant.mlb.com/statcast_search
```

## 🚢 Deployment

### Google Cloud App Engine

```bash
# Deploy to production
npm run deploy

# Deploy with traffic promotion
npm run deploy:prod

# View logs
npm run gcp:logs

# Open in browser
npm run gcp:browse
```

### Manual Deployment

```bash
# Build the project
npm run build

# Deploy using gcloud
gcloud app deploy --quiet

# Check deployment status
gcloud app browse
```

## 📈 Data Collection

The project includes comprehensive data collection scripts for gathering historical MLB data:

### Historical Data Collector
```bash
python scripts/historical_data_collector.py
```

### Player Data Collector
```bash
python scripts/comprehensive_player_collector.py
```

### Incremental Updates
```bash
python scripts/incremental_collector.py
```

## 🔄 Data Flow

```
Frontend Request → Legacy Routes → Data Source Service → Intelligent Routing
                                                        ↓
                                        ┌─── BigQuery (Historical 2015-2024)
                                        ├─── MLB API (Live/Current)
                                        └─── FanGraphs (Advanced Analytics)
                                                        ↓
                                            Response Cache → JSON Response
```

## 🎯 Key Features

### Intelligent Data Routing
- Automatically selects optimal data source based on request parameters
- Fallback mechanisms for data availability
- Caching layer for improved performance

### Backward Compatibility
- All existing frontend endpoints preserved
- Seamless migration from legacy architecture
- No breaking changes to client applications

### Scalable Architecture
- Auto-scaling App Engine deployment
- Efficient BigQuery integration
- External API rate limiting and error handling

### Comprehensive Logging
- Structured logging with Winston
- Request/response tracking
- Error monitoring and alerting

## 📊 Performance Metrics

- **Response Time**: < 200ms for cached data
- **Availability**: 99.9% uptime SLA
- **Data Freshness**: Real-time for current season, historical for past seasons
- **Scaling**: 0-10 instances based on traffic

## 🔐 Security

- CORS configuration for web client access
- Environment-based configuration
- Secure credential management via GCP
- API rate limiting and request validation

## 📚 API Documentation

### Response Format

All endpoints return JSON in the following format:

```json
{
  "success": true,
  "data": [...],
  "metadata": {
    "source": "bigquery|mlb-api|fangraphs",
    "timestamp": "2025-08-19T20:00:00Z",
    "count": 30
  }
}
```

### Error Handling

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "No data found for the specified parameters"
  }
}
```

## 🛠️ Maintenance

### Monitoring
- Health check endpoint: `/health`
- GCP monitoring dashboard
- Structured logging for debugging

### Updates
- Rolling deployments with zero downtime
- Feature flag support for gradual rollouts
- Automated testing pipeline

## 📝 Changelog

### v2.0.0 (2025-08-19)
- **MAJOR**: Hybrid data architecture implementation
- **NEW**: BigQuery historical data integration (35K+ records)
- **NEW**: FanGraphs API service for advanced analytics
- **NEW**: Intelligent data source routing
- **NEW**: GCP App Engine deployment
- **ENHANCED**: Backward compatibility layer
- **ENHANCED**: Comprehensive logging and monitoring
- **ENHANCED**: TypeScript implementation with full type safety

### v1.x.x (Legacy)
- Original implementation with direct MLB API integration

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the ISC License - see the LICENSE file for details.

## 🏆 Acknowledgments

- MLB for providing comprehensive baseball data
- FanGraphs for advanced analytics and sabermetrics
- Google Cloud Platform for scalable infrastructure
- Baseball Savant for Statcast data

---

**Live Service**: https://hankstank.uc.r.appspot.com  
**Maintained by**: Elijah Craig  
**Last Updated**: August 19, 2025