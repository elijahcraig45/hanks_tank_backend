# Automatic BigQuery Sync Setup

## Current State: Manual Sync Required ⚠️

Right now, your system can sync data to BigQuery, but it requires **manual API calls**.

## Make It Fully Automatic

### Option 1: GCP Cloud Scheduler (Recommended)

Deploy the cron job to run automatically every January 2nd:

```bash
# Deploy the cron schedule
gcloud app deploy cron.yaml

# Verify it's scheduled
gcloud scheduler jobs list
```

**What This Does:**
- Every January 2nd at 2 AM, calls `POST /api/sync/missing`
- Automatically syncs the previous year's completed season
- Zero manual intervention needed

### Option 2: Manual Sync (What You Have Now)

Call the API manually after each season ends:

```bash
# Check what's missing
curl https://hankstank.uc.r.appspot.com/api/sync/status

# Sync all missing data
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing

# Or sync specific year
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/teams/2024
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/team-stats/2024
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/standings/2024
```

## Timeline Example: How It Works

### January 1, 2026 (No Action Needed)
- System automatically recognizes it's 2026
- Historical range: 2015-2025 (expanded by 1 year)
- Routing: 2025 data still comes from BigQuery IF it exists, MLB API if not

### January 2, 2026 (Automatic if cron deployed)
- **Cron job runs at 2 AM**
- Calls `/api/sync/missing`
- Detects 2025 is missing from BigQuery
- Syncs all 2025 data (teams, stats, standings)
- BigQuery now has 2015-2025 data

### January 3, 2026 Onwards
- All 2025 requests → BigQuery (fast, cached)
- All 2026 requests → MLB API (live, current season)

## Deploy Automatic Sync Now

```bash
cd /Users/VTNX82W/Documents/personalDev/hanks_tank_backend
gcloud app deploy cron.yaml
```

## Current BigQuery Data

You already have **2015-2024** data loaded. The system is production-ready and will:
- ✅ Serve historical data from BigQuery (fast)
- ✅ Serve current season from MLB API (live)
- ⏰ Automatically sync next year IF you deploy cron.yaml

## Without Cron Job

If you don't deploy the cron job:
- Everything still works perfectly
- You just need to manually call `/api/sync/missing` once per year
- Takes 2 minutes to sync a full year's data
