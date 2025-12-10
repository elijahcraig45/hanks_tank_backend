# BigQuery Data Sync System

## Overview

The BigQuery Sync System provides an intelligent, automated way to manage historical MLB data in BigQuery for long-term caching. It ensures that all historical seasons (2015-2025, excluding the current season) are properly stored in BigQuery without duplication or gaps.

## Key Features

- **Intelligent Gap Detection**: Automatically identifies missing years in historical data
- **Deduplication**: Prevents duplicate records by checking before syncing
- **Selective Sync**: Sync specific tables or years as needed
- **Force Refresh**: Option to refresh existing data
- **Comprehensive Status Reporting**: Monitor data coverage and completeness

## Architecture

### Data Tables

The system manages 6 BigQuery tables:

1. **teams_historical**: Team information (30 teams × years)
2. **team_stats_historical**: Team batting & pitching stats (60 records × years)
3. **player_stats_historical**: Top player batting & pitching stats (~100 records × years)
4. **standings_historical**: Final season standings (30 teams × years)
5. **games_historical**: Game results and scores (~2,500 games × years)
6. **rosters_historical**: Team rosters (not yet implemented)

### Historical Data Policy

- **Included Seasons**: 2015 through (current year - 1)
- **Excluded**: Current season (always fetched from live MLB API)
- **Rationale**: Historical data is stable and unchanging; current season is dynamic

## API Endpoints

### 1. Get Sync Status

```bash
GET /api/sync/status
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "totalTables": 6,
    "completelySynced": 4,
    "totalMissingYears": 5,
    "totalRecords": 35000
  },
  "tables": [
    {
      "tableName": "teams_historical",
      "yearsCovered": [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
      "totalRecords": 300,
      "missingYears": [],
      "isComplete": true
    },
    {
      "tableName": "team_stats_historical",
      "yearsCovered": [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
      "totalRecords": 600,
      "missingYears": [],
      "isComplete": true
    }
  ],
  "timestamp": "2025-12-10T15:30:00.000Z"
}
```

### 2. Sync Missing Data

Syncs all missing years across all tables.

```bash
POST /api/sync/missing
Content-Type: application/json

{
  "forceRefresh": false,
  "years": [],
  "tables": []
}
```

**Parameters:**
- `forceRefresh` (optional): If true, re-sync existing data. Default: false
- `years` (optional): Array of specific years to sync. Default: all missing years
- `tables` (optional): Array of table types to sync. Default: all tables

**Response:**
```json
{
  "success": true,
  "summary": {
    "totalOperations": 12,
    "successful": 12,
    "failed": 0,
    "recordsAdded": 1250
  },
  "results": [
    {
      "success": true,
      "tableName": "teams_historical",
      "year": 2023,
      "recordsAdded": 30,
      "recordsUpdated": 0
    }
  ],
  "timestamp": "2025-12-10T15:35:00.000Z"
}
```

### 3. Sync Specific Table by Year

Sync individual tables for a specific year.

```bash
# Teams
POST /api/sync/teams/2024
Content-Type: application/json
{ "forceRefresh": false }

# Team Stats
POST /api/sync/team-stats/2024
Content-Type: application/json
{ "forceRefresh": false }

# Player Stats
POST /api/sync/player-stats/2024
Content-Type: application/json
{ "forceRefresh": false }

# Standings
POST /api/sync/standings/2024
Content-Type: application/json
{ "forceRefresh": false }
```

**Response:**
```json
{
  "success": true,
  "result": {
    "success": true,
    "tableName": "teams_historical",
    "year": 2024,
    "recordsAdded": 30,
    "recordsUpdated": 0
  },
  "timestamp": "2025-12-10T15:40:00.000Z"
}
```

## Usage Examples

### Check Current Sync Status

```bash
curl https://hankstank.uc.r.appspot.com/api/sync/status
```

### Sync All Missing Data

```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Sync Specific Years

```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{"years": [2023, 2024]}'
```

### Force Refresh Existing Data

```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{"forceRefresh": true, "years": [2024]}'
```

### Sync Single Table for One Year

```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/team-stats/2024 \
  -H "Content-Type: application/json" \
  -d '{"forceRefresh": false}'
```

## How It Works

### 1. Gap Detection

The system queries each BigQuery table to identify:
- Which years have data
- Which years are missing
- Total record counts

### 2. Smart Syncing

For each missing year:
1. Check if data exists (unless `forceRefresh=true`)
2. If exists, skip and log
3. If missing, fetch from MLB API
4. Transform data to match schema
5. Delete existing records for that year (if any)
6. Insert new records
7. Return result summary

### 3. Rate Limiting

- 1 second delay between API calls
- Prevents MLB API rate limiting
- Safe for bulk operations

### 4. Error Handling

- Each year/table sync is independent
- Failed syncs don't stop the process
- Detailed error messages in response
- Full logging for debugging

## Data Flow

```
MLB StatsAPI 
    ↓
BigQuery Sync Service
    ↓
Transform & Validate
    ↓
BigQuery Tables
    ↓
Data Source Service (reads from BQ for historical data)
    ↓
Frontend API Endpoints
```

## Maintenance Schedule

### Recommended Sync Pattern

1. **End of Season** (November): Sync completed season data
2. **Monthly Check**: Run status check to identify gaps
3. **On-Demand**: Sync specific tables if discrepancies found

### Automated Sync (Future Enhancement)

Can be scheduled via:
- Cloud Scheduler (GCP)
- Cron job on server
- GitHub Actions

## Monitoring

### Key Metrics to Track

1. **Completeness**: Are all years 2015-(current-1) present?
2. **Record Counts**: Do counts match expected values?
3. **Last Sync Date**: When was data last updated?
4. **Error Rate**: Failed sync operations

### Expected Record Counts

- **teams_historical**: 30 teams × 10 years = 300 records
- **team_stats_historical**: 30 teams × 2 stat types × 10 years = 600 records
- **player_stats_historical**: ~100 leaders × 10 years = ~1,000 records
- **standings_historical**: 30 teams × 10 years = 300 records
- **games_historical**: ~2,500 games × 10 years = ~25,000 records

## Troubleshooting

### Data Not Syncing

1. Check GCP credentials: `GET /health`
2. Verify BigQuery dataset exists: `mlb_historical_data`
3. Check MLB API availability
4. Review error logs

### Duplicate Data

The system uses "insert-or-replace" logic:
1. Deletes all records for the target year
2. Inserts fresh data
3. No duplicates possible

### Missing Years

Run sync status to identify gaps:
```bash
curl https://hankstank.uc.r.appspot.com/api/sync/status
```

Then sync missing data:
```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing
```

## Security Considerations

### Access Control

- Sync endpoints should be protected in production
- Recommend adding authentication middleware
- Limit to admin users only

### Example Protection

```typescript
// Add to sync routes
import { requireAuth } from '../middleware/auth';

router.post('/missing', requireAuth, bigQuerySyncController.syncMissingData);
```

## Future Enhancements

1. **Automated Scheduling**: Daily/weekly sync jobs
2. **Roster Data**: Add roster sync functionality
3. **Game Details**: Enhanced game data with box scores
4. **Player Details**: Full player profiles and career stats
5. **Webhook Notifications**: Alert on sync completion/failure
6. **Dashboard UI**: Visual sync status and management
7. **Incremental Updates**: Only sync changed records

## Related Documentation

- [Hybrid Architecture Guide](./HYBRID_ARCHITECTURE.md)
- [Historical Data Summary](./HISTORICAL_DATA_SUMMARY.md)
- [MLB StatsAPI Documentation](./MLB_STATSAPI_DOCUMENTATION.md)

## Support

For issues or questions about the sync system:
1. Check sync status endpoint
2. Review server logs
3. Verify GCP configuration
4. Test MLB API connectivity
