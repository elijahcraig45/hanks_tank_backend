# Hybrid Data Architecture Guide

## Overview

The Hanks Tank backend now features an intelligent hybrid data architecture that optimally routes requests between three data sources:

1. **Historical Data** - GCP BigQuery & Cloud Storage (for seasons older than 2 years)
2. **Live Data** - MLB StatsAPI (for current season dynamic content)
3. **Cached Data** - Redis/Memory cache (for frequently accessed data)

## Architecture Components

### Data Source Service (`src/services/data-source.service.ts`)

The core intelligence of the system that decides which data source to use based on:
- **Season Age**: Current season vs historical seasons
- **Data Type**: Static vs dynamic content (roster vs standings)
- **Cache Availability**: Cached data takes priority

#### Decision Matrix

| Data Type | Current Season | Previous Season | 2+ Years Old |
|-----------|---------------|-----------------|--------------|
| **Standings** | Live API | Historical | Historical |
| **Schedule** | Live API | Historical | Historical |
| **Roster** | Live API | Historical | Historical |
| **Team Stats** | Historical* | Historical | Historical |
| **Player Stats** | Historical* | Historical | Historical |

*Team/Player stats use historical data even for current season for performance

### GCP Integration

#### BigQuery Tables
Your existing table structure is preserved:
- `2024_teamBatting`, `2024_teamPitching`
- `2024_playerBatting`, `2024_playerPitching`
- `2023_teamBatting`, etc.

#### Cloud Storage Files
- News: `2025/braves_news.json`, `2025/mlb_news.json`
- Reports: `2025/team_reports.json`
- Analysis: `2025/analysis_data.json`

### Cache Strategy

#### TTL (Time To Live) Settings
- **Historical Data**: 24 hours (rarely changes)
- **Current Season**: 30 minutes (changes periodically)
- **Live Data**: 10 minutes (standings, schedules)

#### Cache Keys Format
```
data:{dataType}:{statType}:{season}:{teamId}:{playerId}
```

Examples:
- `data:team-stats:batting:2024:144:all`
- `data:standings:all:2025:all:all`

## API Endpoints

### V2 Hybrid Endpoints (`/api/v2/teams/`)

#### Basic Team Data
```bash
# Get all teams (intelligent sourcing)
GET /api/v2/teams?season=2024

# Get specific team
GET /api/v2/teams/144?season=2024

# Get team roster (live for current season)
GET /api/v2/teams/144/roster?season=2025

# Get team schedule (live for current season)
GET /api/v2/teams/144/schedule?season=2025
```

#### Statistics
```bash
# Team batting stats (from BigQuery for performance)
GET /api/v2/teams/144/stats?season=2024&statType=batting

# Team pitching stats
GET /api/v2/teams/144/stats?season=2024&statType=pitching
```

#### League Data
```bash
# Standings (live for current season)
GET /api/v2/teams/standings?season=2025

# News (from Cloud Storage)
GET /api/v2/teams/news?teamId=144
```

#### Administrative
```bash
# Sync historical data from MLB API to GCP
POST /api/v2/teams/admin/sync-historical
{
  "season": 2024,
  "dataTypes": ["team-stats", "player-stats"]
}

# Direct MLB API access (for comparison)
GET /api/v2/teams/direct/teams?season=2024
```

### Legacy V1 Endpoints (`/api/teams/`)

Original endpoints remain unchanged for backward compatibility.

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# Core GCP Settings
GCP_PROJECT_ID=mlb-414201
GCS_BUCKET_NAME=mlb_henry
BQ_DATASET=MLB_data

# Authentication
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# OR for production on GCP
USE_DEFAULT_GCP_CREDENTIALS=true

# Cache Settings
CACHE_TTL_HISTORICAL=86400  # 24 hours
CACHE_TTL_CURRENT=1800      # 30 minutes
CACHE_TTL_LIVE=600          # 10 minutes
```

### GCP Authentication

#### Development (Local)
1. Create a service account in your GCP project
2. Download the JSON key file
3. Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`

#### Production (App Engine/Cloud Run)
1. Set `USE_DEFAULT_GCP_CREDENTIALS=true`
2. Ensure your service has the required IAM roles:
   - BigQuery Data Viewer
   - BigQuery Job User
   - Storage Object Viewer

## Data Flow Examples

### Current Season Team Stats Request

```
GET /api/v2/teams/144/stats?season=2025&statType=batting

1. Check cache: data:team-stats:batting:2025:144:all
2. Cache miss → Determine data source
3. Season 2025 (current) + team-stats → Use Historical (BigQuery)
4. Query: SELECT * FROM `mlb-414201.MLB_data.2025_teamBatting` WHERE team_id = 144
5. Cache result with 30-minute TTL
6. Return formatted response
```

### Historical Data Request

```
GET /api/v2/teams/144/roster?season=2020

1. Check cache: data:roster:all:2020:144:all
2. Cache miss → Determine data source  
3. Season 2020 (5 years old) → Use Historical (BigQuery)
4. Query historical roster table
5. Cache result with 24-hour TTL
6. Return formatted response
```

### Live Data Request

```
GET /api/v2/teams/standings?season=2025

1. Check cache: data:standings:all:2025:all:all
2. Cache miss → Determine data source
3. Season 2025 (current) + standings → Use Live API
4. Fetch from statsapi.mlb.com/api/v1/standings
5. Cache result with 10-minute TTL
6. Return formatted response
```

## Performance Benefits

### Reduced API Calls
- Historical data served from BigQuery (faster than external API)
- Intelligent caching reduces redundant requests
- Bulk operations for data syncing

### Improved Response Times
- Local BigQuery queries: ~100-500ms
- Cached responses: ~10-50ms
- MLB API calls: ~500-2000ms

### Cost Optimization
- Fewer external API calls
- Efficient BigQuery queries with proper indexing
- Optimized cache TTLs based on data volatility

## Data Synchronization

### Automated Sync (Recommended)
Set up Cloud Scheduler to periodically sync data:

```bash
# Daily sync for previous day's games
curl -X POST https://your-app.run.app/api/v2/teams/admin/sync-historical \
  -H "Content-Type: application/json" \
  -d '{"season": 2025, "dataTypes": ["team-stats", "player-stats"]}'
```

### Manual Sync
Use the admin endpoint to sync specific seasons/data types as needed.

## Monitoring & Observability

### Health Check
```bash
GET /health

Response includes GCP configuration status:
{
  "status": "healthy",
  "gcp": {
    "configured": true,
    "errors": []
  }
}
```

### Logging
All requests include:
- Data source used (historical/live/cache)
- Response time
- Cache hit/miss status
- Query performance metrics

## Migration Strategy

### Phase 1: Parallel Operation
- V1 endpoints continue using direct MLB API
- V2 endpoints use hybrid architecture
- Compare performance and accuracy

### Phase 2: Gradual Migration
- Update frontend to use V2 endpoints
- Monitor for issues
- Keep V1 as fallback

### Phase 3: Full Migration
- Deprecate V1 endpoints
- Optimize BigQuery tables
- Implement advanced caching strategies

## Troubleshooting

### Common Issues

#### GCP Authentication Errors
```bash
# Check service account permissions
gcloud auth list
gcloud config list project

# Test BigQuery access
bq query --nouse_legacy_sql "SELECT 1"
```

#### Cache Performance
```bash
# Monitor Redis (if used)
redis-cli info memory
redis-cli monitor

# Check application logs for cache hit rates
```

#### Data Freshness
```bash
# Force cache clear for specific data
# (Implementation can be added as admin endpoint)
```

This hybrid architecture provides the best of both worlds: the performance of local historical data storage with the accuracy of live MLB data for current information.
