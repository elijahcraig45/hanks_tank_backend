# Statcast Data Collection Scripts

This directory contains scripts for collecting complete MLB Statcast pitch-by-pitch data from Baseball Savant and uploading to BigQuery.

## Overview

These scripts collect comprehensive Statcast data for the 2015-2025 MLB seasons using a parallel, daily-resolution approach to ensure complete and accurate data capture.

## Scripts

### `collect_statcast_parallel.py`
Main collection script for historical data (2015-2024).

**Features:**
- Daily resolution: One API call per calendar day to avoid Baseball Savant's 25,000 pitch limit
- Multithreaded: Uses ThreadPoolExecutor with 10 concurrent workers for parallel collection
- Monthly batching: Combines daily data and uploads once per month to reduce BigQuery API calls
- Progress tracking: Real-time progress updates every 10 days
- High-volume detection: Flags days with >20K pitches
- Thread-safe logging: Proper synchronization for parallel execution
- Retry logic: Automatic retries for failed requests

**Usage:**
```bash
cd /Users/VTNX82W/Documents/personalDev/hanks_tank_backend/local_data_processing
python3 -u collect_statcast_parallel.py > parallel_collection.log 2>&1 &
```

**Performance:**
- ~30-60 seconds per month
- ~15-20 minutes for complete 2015-2024 collection (~7M pitches)
- Processes 10 days concurrently

### `collect_statcast_2025.py`
Collection script for current 2025 season data.

**Features:**
- Same architecture as parallel collector
- Configured for 2025 season (March-October)
- Handles in-progress season gracefully

**Usage:**
```bash
python3 -u collect_statcast_2025.py > collection_2025.log 2>&1 &
```

## Data Destination

All data is uploaded to:
- **BigQuery Table:** `hankstank.mlb_historical_data.statcast_pitches`
- **Partitioned by:** `game_date`
- **Fields:** 58+ fields including:
  - Pitch characteristics (velocity, spin, movement)
  - Hit outcomes (exit velocity, launch angle, distance)
  - Game context (count, outs, runners, score)
  - Player identifications
  - Timestamps and metadata

## Technical Details

### Baseball Savant API Limitations
- **25,000 pitch limit** per query (hard limit)
- Daily queries guarantee staying under limit (typical day: 2-8K pitches, max ~15K)
- Rate limiting: Brief pauses between requests recommended

### SSL Certificates
Due to macOS Python 3.13 certificate verification issues:
- Uses `verify=False` in requests
- Disables SSL warnings with `urllib3.disable_warnings()`
- Required workaround for Baseball Savant SSL certificates

### Data Volume by Year
- **2015-2019:** ~700K-730K pitches/year
- **2020:** ~270K (COVID-shortened season)
- **2021-2024:** ~700K-730K pitches/year
- **2025:** In progress

## Architecture Evolution

### Version 1: Cloud Tasks (Abandoned)
- Queue-based approach with 70 tasks
- Successfully collected ~1.5M pitches
- Stalled unexpectedly, switched to local collection

### Version 2: pybaseball Library (Abandoned)
- Attempted to use official pybaseball library
- SSL certificate verification failures on macOS
- Unable to resolve with certificate installation

### Version 3: Weekly Chunking (Superseded)
- Direct requests to Baseball Savant with SSL disabled
- Weekly date ranges (7-day chunks)
- Issue: Some weeks exceeded 25K limit and got truncated
- Example: April 2015 had 104,863 pitches but weekly collection only got 98,309

### Version 4: Daily Parallel (Current)
- **Daily resolution:** One query per calendar day
- **Multithreading:** 10 concurrent workers
- **Complete accuracy:** No truncation, all pitches collected
- **Optimal performance:** 4-5x faster than sequential

## Monitoring Progress

Check collection progress:
```bash
# View live log
tail -f parallel_collection.log

# Check current data in BigQuery
bq query --use_legacy_sql=false \
  "SELECT year, COUNT(*) as pitches 
   FROM \`hankstank.mlb_historical_data.statcast_pitches\` 
   GROUP BY year ORDER BY year"

# Check total progress
bq query --use_legacy_sql=false \
  "SELECT COUNT(*) as total_pitches, 
          MIN(game_date) as earliest, 
          MAX(game_date) as latest 
   FROM \`hankstank.mlb_historical_data.statcast_pitches\`"
```

## Dependencies

```
requests
pandas
google-cloud-bigquery
pyarrow
db-dtypes
urllib3
```

Install with:
```bash
pip install requests pandas google-cloud-bigquery pyarrow db-dtypes
```

## Error Handling

- **Retry logic:** Up to 2 retries per day with 2-second delays
- **Failed months tracking:** Summary shows any months that failed all retries
- **Graceful degradation:** Continues processing even if individual days fail
- **Thread-safe error logging:** All errors properly synchronized

## Future Enhancements

1. **Incremental updates:** Daily cron job for ongoing 2025 season
2. **Data validation:** Verify completeness against official MLB game counts
3. **Backfill detection:** Identify and fill any gaps in historical data
4. **Performance monitoring:** Track API response times and success rates

## Notes

- Data load timestamp added to track when data was collected
- Year and month fields added for easy partitioning and queries
- Schema allows field additions for future Baseball Savant enhancements
- Process runs independently without manual intervention
- Clean, complete dataset without 25K truncation issues

## Completed Collections

- ✅ 2015-2024: Full historical data (~7M pitches)
- 🔄 2025: Current season (ongoing collection)

Last updated: December 19, 2025
