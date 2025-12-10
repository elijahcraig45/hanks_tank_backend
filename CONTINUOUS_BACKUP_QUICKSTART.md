# Continuous Backup System - Quick Start Guide

## 🎯 What This System Does

**Automatic continuous backup of all MLB data to BigQuery with intelligent fallback.**

Every API request:
1. ✅ Fetches live data from MLB API
2. ✅ Automatically backs up to BigQuery
3. ✅ If MLB API fails → serves from BigQuery backup
4. ✅ New players/teams automatically discovered and added

---

## 📦 What Was Added

### New Files Created:
1. **`src/services/continuous-backup.service.ts`** - Auto-backup service
2. **`src/controllers/data-validation.controller.ts`** - Validation endpoints
3. **`src/routes/validation.routes.ts`** - Validation routes
4. **`CONTINUOUS_BACKUP_ARCHITECTURE.md`** - Full architecture docs

### Files Modified:
1. **`src/services/data-source.service.ts`** - Added auto-backup hooks + fallback logic
2. **`src/app.ts`** - Added validation routes
3. **`cron.yaml`** - Added scheduled validation jobs

---

## 🚀 New Endpoints

### Auto-Backup (Transparent)
All existing endpoints now auto-backup to BigQuery:
- `GET /api/v2/teams/:teamId/stats/batting?season=2025`
- `GET /api/v2/teams/:teamId/stats/pitching?season=2025`
- `GET /api/v2/teams/stats/batting?season=2025` (all teams)
- And all other data endpoints

### Validation Endpoints (New)
```bash
# Daily validation check
GET /api/validation/daily-check

# Weekly full sync
GET /api/validation/weekly-full

# End-of-season sync
GET /api/validation/end-of-season

# Monthly audit
GET /api/validation/monthly-audit
```

---

## 🕐 Scheduled Jobs (Cloud Scheduler)

These run automatically after deployment:

| Job | Schedule | What It Does |
|-----|----------|--------------|
| **Annual Sync** | Jan 2, 2 AM ET | Backup completed season |
| **Daily Validation** | Every day, 3 AM ET | Compare BQ vs MLB API |
| **Weekly Sync** | Sunday, 2 AM ET | Full historical sync |
| **Monthly Audit** | 1st of month, 4 AM ET | Table integrity check |

---

## 🏗️ How It Works

### Example: Team Stats Request

```
User requests: GET /api/v2/teams/144/stats/batting?season=2025

┌─────────────────────────────────────────┐
│ 1. Fetch from MLB API                   │
│    ✅ Success                            │
└─────────────┬───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ 2. Auto-backup to BigQuery              │
│    (Fire-and-forget, non-blocking)      │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ 3. Return data to user                  │
│    (Backup happens in background)       │
└─────────────────────────────────────────┘
```

### Example: MLB API Failure (Fallback)

```
User requests: GET /api/v2/teams/144/stats/batting?season=2024

┌─────────────────────────────────────────┐
│ 1. Try MLB API                          │
│    ❌ FAILED (API down)                 │
└─────────────┬───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ 2. Fallback to BigQuery                 │
│    ✅ SUCCESS (using backup)            │
└─────────────┬───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ 3. Return data to user                  │
│    (From BigQuery backup)               │
└─────────────────────────────────────────┘
```

---

## 📊 Data Discovery

### New Players Automatically Added

```typescript
// 2025 season starts, new player "John Doe" (ID: 123456) debuts
GET /api/v2/teams/stats/batting?season=2025

// System:
// 1. Fetches ALL players from MLB API (5000 players)
// 2. Detects new player: John Doe (123456)
// 3. Automatically backs up to BigQuery
// 4. Future requests can use backup
```

### New Teams Automatically Added

```typescript
// 2026 expansion team "Portland Pioneers" (ID: 999)
GET /api/v2/teams/batting?season=2026

// System:
// 1. Fetches all teams from MLB API
// 2. Detects new team: Portland Pioneers (999)
// 3. Backs up team info + stats to BigQuery
// 4. Team now in backup database
```

---

## 🚦 Deployment

### 1. Deploy Application
```bash
cd /Users/VTNX82W/Documents/personalDev/hanks_tank_backend
gcloud app deploy
```

### 2. Deploy Scheduled Jobs
```bash
gcloud app deploy cron.yaml
```

### 3. Verify Deployment
```bash
# Check cron jobs are scheduled
gcloud scheduler jobs list

# Test validation endpoint
curl https://hankstank.uc.r.appspot.com/api/validation/daily-check
```

---

## ✅ Testing the System

### Test Auto-Backup
```bash
# Request team stats for 2025 (live season)
curl "https://hankstank.uc.r.appspot.com/api/v2/teams/144/stats/batting?season=2025"

# Check logs - you should see:
# "Backed up new team stats to BigQuery"
```

### Test Fallback (Simulated)
```bash
# Request historical data (2024)
curl "https://hankstank.uc.r.appspot.com/api/v2/teams/144/stats/batting?season=2024"

# If MLB API is slow/down, logs will show:
# "MLB API failed, using BigQuery fallback"
```

### Test Validation
```bash
# Run daily validation check
curl "https://hankstank.uc.r.appspot.com/api/validation/daily-check"

# Response:
# {
#   "success": true,
#   "results": {
#     "overall": "PASS",
#     "teamStats": { "valid": true },
#     "standings": { "valid": true }
#   }
# }
```

---

## 🎯 Key Benefits

| Feature | Benefit |
|---------|---------|
| **Auto-Backup** | Every API call backs up data - no manual work |
| **Fallback** | API stays online even if MLB API fails |
| **Discovery** | New players/teams automatically added |
| **Validation** | Scheduled jobs ensure data integrity |
| **ML-Ready** | Complete dataset in BigQuery for analysis |
| **Non-Blocking** | Backups don't slow down API responses |
| **Logged** | Full audit trail of all operations |

---

## 📝 Monitoring

### View Logs
```bash
# Application logs
gcloud logging read "resource.type=gae_app" --limit=50

# Scheduler job logs
gcloud logging read "resource.type=cloud_scheduler_job"

# Search for backup operations
gcloud logging read "jsonPayload.message:'Backed up'" --limit=20

# Search for fallback operations
gcloud logging read "jsonPayload.message:'fallback'" --limit=20
```

### Check BigQuery Data
```sql
-- Check team stats count
SELECT season, COUNT(*) as teams
FROM `mlb_data.team_stats_historical`
GROUP BY season
ORDER BY season DESC;

-- Check player stats count
SELECT season, COUNT(*) as players
FROM `mlb_data.player_stats_historical`
GROUP BY season
ORDER BY season DESC;

-- Check most recent backups
SELECT season, MAX(last_updated) as last_backup
FROM `mlb_data.team_stats_historical`
GROUP BY season
ORDER BY season DESC;
```

---

## 🔧 Configuration

All configuration in `src/config/gcp.config.ts`:

```typescript
export const gcpConfig = {
  projectId: 'hankstank',
  dataSource: {
    currentSeason: new Date().getFullYear(), // 2025
    minSeason: 2015,
    // ...
  },
  bigQuery: {
    dataset: 'mlb_data',
    // ...
  }
};
```

---

## ✨ Summary

**What you get:**
- ✅ Automatic continuous backup (every API call)
- ✅ Resilient fallback (BigQuery if MLB API down)
- ✅ Auto-discovery (new players/teams added automatically)
- ✅ Scheduled validation (daily/weekly/monthly checks)
- ✅ ML/analysis ready (complete dataset in BigQuery)
- ✅ Zero maintenance (fully automated)

**Next steps:**
1. Deploy app: `gcloud app deploy`
2. Deploy cron: `gcloud app deploy cron.yaml`
3. Monitor logs: `gcloud logging read ...`
4. Use BigQuery for ML/analysis

**That's it!** Your data is now continuously backed up and always available. 🎉
