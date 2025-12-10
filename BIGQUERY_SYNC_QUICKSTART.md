# BigQuery Sync System - Quick Start

## What is This?

An intelligent system for caching historical MLB data (2015-2025) in BigQuery, ensuring your backend has fast access to historical seasons while always fetching current season data from live APIs.

## Key Benefits

✅ **Automatic Gap Detection** - Knows what data is missing
✅ **No Duplicates** - Smart insert-or-replace logic
✅ **Fast Historical Queries** - BigQuery is much faster than repeated API calls
✅ **Current Season Always Live** - Never caches the current season
✅ **Easy Management** - Simple REST API for sync operations

## Quick Commands

### Check What's Missing
```bash
curl https://hankstank.uc.r.appspot.com/api/sync/status
```

### Sync Everything Missing
```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Sync Just 2024 Data
```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{"years": [2024]}'
```

## Current Status

Based on your existing BigQuery data:

- ✅ **teams_historical**: 300 records (2015-2024)
- ✅ **team_stats_historical**: 600 records (2015-2024)
- ⚠️ **player_stats_historical**: 968 records (limited to top 50-100 players per year)
- ✅ **standings_historical**: Exists
- ✅ **games_historical**: Exists
- ❌ **rosters_historical**: Exists but sync not implemented yet

## How It Works

1. **Historical Data (2015-2024)**: Stored in BigQuery, fast retrieval
2. **Current Season (2025)**: Always fetched from MLB API, never cached
3. **Gap Detection**: Automatically finds missing years
4. **Smart Sync**: Only syncs what's missing (unless you force refresh)

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sync/status` | GET | Check sync status for all tables |
| `/api/sync/missing` | POST | Sync all missing data |
| `/api/sync/teams/:year` | POST | Sync teams for specific year |
| `/api/sync/team-stats/:year` | POST | Sync team stats for specific year |
| `/api/sync/player-stats/:year` | POST | Sync player stats for specific year |
| `/api/sync/standings/:year` | POST | Sync standings for specific year |

## When to Sync

### End of Season (November)
After the World Series ends, sync the completed season:
```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{"years": [2024]}'
```

### Monthly Maintenance
Check for gaps:
```bash
curl https://hankstank.uc.r.appspot.com/api/sync/status
```

### On-Demand
If you notice missing or incorrect data, force refresh:
```bash
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/team-stats/2023 \
  -H "Content-Type: application/json" \
  -d '{"forceRefresh": true}'
```

## Example Response

### Status Check
```json
{
  "success": true,
  "summary": {
    "totalTables": 6,
    "completelySynced": 4,
    "totalMissingYears": 0,
    "totalRecords": 35000
  },
  "tables": [
    {
      "tableName": "teams_historical",
      "yearsCovered": [2015, 2016, ..., 2024],
      "totalRecords": 300,
      "missingYears": [],
      "isComplete": true
    }
  ]
}
```

### Sync Operation
```json
{
  "success": true,
  "summary": {
    "totalOperations": 4,
    "successful": 4,
    "failed": 0,
    "recordsAdded": 120
  },
  "results": [
    {
      "success": true,
      "tableName": "teams_historical",
      "year": 2024,
      "recordsAdded": 30,
      "recordsUpdated": 0
    }
  ]
}
```

## Troubleshooting

### No Data Returns
- Check GCP credentials: `USE_DEFAULT_GCP_CREDENTIALS=true`
- Verify dataset exists: `mlb_historical_data`
- Check project ID: `hankstank`

### Sync Fails
- Check MLB API is available
- Review server logs for detailed errors
- Try syncing one year at a time

### Slow Performance
- BigQuery queries are fast, but API fetching takes time
- ~1 second delay between MLB API calls (rate limiting)
- Expect ~30 seconds to sync a full year across all tables

## Security Note

⚠️ **Production Recommendation**: Add authentication to sync endpoints
```typescript
// In your routes file
import { requireAuth } from '../middleware/auth';
router.post('/missing', requireAuth, controller.syncMissingData);
```

## Complete Documentation

See [BIGQUERY_SYNC_GUIDE.md](./BIGQUERY_SYNC_GUIDE.md) for full details including:
- Architecture deep dive
- All API endpoint examples
- Error handling strategies
- Monitoring best practices
- Future enhancements

## Need Help?

1. Check sync status endpoint
2. Review BigQuery console for table data
3. Check server logs for errors
4. Verify MLB API connectivity

---

**Made with ⚾ for Hanks Tank MLB Analytics**
