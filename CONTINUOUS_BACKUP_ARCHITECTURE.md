# Continuous Backup System - Architecture Guide

## 🎯 Overview

The Continuous Backup System implements a **write-through caching** strategy that ensures BigQuery always has the latest MLB data. This creates a resilient architecture where:

1. **Primary Source**: Always fetch from live MLB API first
2. **Automatic Backup**: Every API call automatically backs up to BigQuery
3. **Intelligent Fallback**: If MLB API fails, serve from BigQuery backup
4. **Incremental Discovery**: New players, teams, and games are automatically added
5. **Data Integrity**: Automated validation ensures data accuracy

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          API Request                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Data Source Service  │
                    └──────────┬───────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
      ┌─────────────────┐          ┌──────────────────┐
      │   MLB API (Live) │          │  BigQuery (Cache)│
      └────────┬─────────┘          └──────────────────┘
               │                             ▲
               │                             │
               ▼                             │
      ┌─────────────────┐                   │
      │  Success?       │───────NO──────────┤ (Fallback)
      └────────┬────────┘                   │
               │ YES                         │
               │                             │
               ▼                             │
      ┌─────────────────┐                   │
      │ Continuous      │───────────────────┘
      │ Backup Service  │  (Fire-and-forget)
      └─────────────────┘
```

### Data Flow

1. **Request comes in** → Data Source Service
2. **Try MLB API** → Fetch live data
3. **Auto-backup** → Fire-and-forget write to BigQuery
4. **On Failure** → Fallback to BigQuery
5. **Return data** → Client gets response

---

## 🔧 Components

### 1. Continuous Backup Service (`continuous-backup.service.ts`)

Handles automatic backup of all data types:

- **Team Stats** (batting, pitching)
- **Player Stats** (batting, pitching)
- **Games** (live, historical)
- **Standings** (divisions, leagues)
- **Rosters** (team rosters)
- **Teams** (team info)

**Key Features:**
- Upsert logic (insert if new, update if exists)
- Non-blocking (fire-and-forget)
- Error handling (won't crash API on backup failure)
- Automatic timestamp tracking

### 2. Data Source Service (`data-source.service.ts`)

Enhanced with:
- **`getLiveDataWithFallback()`**: Wraps MLB API calls with BigQuery fallback
- **Auto-backup hooks**: After every successful MLB API call
- **Player discovery**: New players automatically added to BigQuery
- **Team discovery**: New teams automatically added to BigQuery

### 3. Data Validation Controller (`data-validation.controller.ts`)

Automated validation jobs:
- **Daily Check**: Compare BigQuery vs MLB API sample
- **Weekly Sync**: Full historical sync
- **End-of-Season**: Backup completed season
- **Monthly Audit**: Table integrity checks

### 4. Cloud Scheduler (`cron.yaml`)

Automated jobs:
```yaml
Daily Validation:    Every day at 3 AM ET
Weekly Sync:         Every Sunday at 2 AM ET
End-of-Season:       January 2nd at 1 AM ET
Monthly Audit:       1st of month at 4 AM ET
```

---

## 📊 BigQuery Schema

All tables include automatic timestamping:

### Table: `team_stats_historical`
```sql
team_id: INTEGER
season: INTEGER
stats_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

### Table: `player_stats_historical`
```sql
player_id: INTEGER
season: INTEGER
stats_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

### Table: `games_historical`
```sql
game_pk: INTEGER (PRIMARY KEY)
season: INTEGER
game_date: DATE
game_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

### Table: `standings_historical`
```sql
season: INTEGER (PRIMARY KEY)
standings_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

### Table: `rosters_historical`
```sql
team_id: INTEGER
season: INTEGER
roster_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

### Table: `teams_historical`
```sql
team_id: INTEGER
season: INTEGER
team_data: STRING (JSON)
created_at: TIMESTAMP
last_updated: TIMESTAMP
```

---

## 🚀 Usage

### Automatic Backup (No Action Required)

Every time data is fetched from MLB API, it's automatically backed up:

```typescript
// Example: Team stats request
GET /api/v2/teams/144/stats/batting?season=2025

// What happens:
// 1. Fetch from MLB API
// 2. Auto-backup to BigQuery (background)
// 3. Return data to client
```

### Manual Validation Endpoints

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

### Fallback Behavior

If MLB API is down:

```typescript
// Request: GET /api/v2/teams/144/stats/batting?season=2024
// MLB API: ❌ FAILED
// System: ✅ Falls back to BigQuery
// Response: ✅ Returns cached data from BigQuery
```

---

## 🔄 Incremental Data Discovery

### New Players

When a new player appears in MLB API:

```typescript
// Player "John Doe" (ID: 123456) appears in 2025 season
GET /api/v2/teams/stats/batting?season=2025

// System automatically:
// 1. Fetches all players from MLB API
// 2. Detects new player (ID: 123456)
// 3. Backs up to BigQuery player_stats_historical
// 4. Future requests can use backup
```

### New Teams

When a new team is added (e.g., expansion team):

```typescript
// New team "Portland Pioneers" (ID: 999)
GET /api/v2/teams/batting?season=2026

// System automatically:
// 1. Fetches all teams from MLB API
// 2. Detects new team (ID: 999)
// 3. Backs up to BigQuery teams_historical
// 4. Backs up team stats to team_stats_historical
```

### Live Games

When games are played:

```typescript
// Live game data requested
GET /api/games/2025/663456

// System automatically:
// 1. Fetches game from MLB API
// 2. Backs up to BigQuery games_historical
// 3. Updates if game already exists (e.g., live updates)
```

---

## 🛡️ Resilience Features

### 1. Non-Blocking Backups

Backups never slow down API responses:

```typescript
// Fire-and-forget pattern
continuousBackupService.backupTeamStats(teamId, season, data)
  .catch(err => logger.error('Backup failed', { error: err }));

// API response returns immediately
// Backup happens in background
```

### 2. Fallback on MLB API Failure

```typescript
try {
  // Try MLB API
  return await mlbApi.getTeamBattingStats(teamId, season);
} catch (mlbApiError) {
  // Fallback to BigQuery
  logger.error('MLB API failed, using BigQuery fallback');
  return await bigQueryService.getTeamStats(teamId, season);
}
```

### 3. Error Isolation

Backup failures don't crash the API:

```typescript
try {
  await continuousBackupService.backupPlayerStats(...);
} catch (error) {
  logger.error('Backup failed', { error });
  // API continues normally
}
```

---

## 📅 Scheduled Jobs

### Daily Validation (3 AM ET)

- Compares sample of BigQuery data with MLB API
- Validates team stats and standings
- Logs discrepancies
- Alerts if data missing

### Weekly Full Sync (Sunday 2 AM ET)

- Syncs all historical seasons (2015-2024)
- Fills any gaps in data
- Updates existing records
- Comprehensive backup

### End-of-Season Sync (January 2, 1 AM ET)

- Backs up entire completed season
- Full team stats, player stats, standings
- Game logs, rosters
- Prepares for ML/analysis

### Monthly Audit (1st of month, 4 AM ET)

- Checks all BigQuery tables
- Row counts for each table
- Identifies empty or corrupted tables
- Comprehensive health check

---

## 🔍 Monitoring & Logging

All operations are logged with context:

```typescript
logger.info('Backed up new team stats to BigQuery', { 
  teamId, 
  season 
});

logger.error('MLB API failed, attempting BigQuery fallback', { 
  error: mlbApiError.message,
  request 
});

logger.info('Daily validation complete', { 
  results,
  overall: 'PASS' 
});
```

View logs:
```bash
# Cloud Scheduler jobs
gcloud logging read "resource.type=cloud_scheduler_job"

# Application logs
gcloud logging read "resource.type=gae_app" --limit=50
```

---

## 🎯 Benefits

### For Users
- **Zero downtime**: API always available even if MLB API fails
- **Fast responses**: Cached data when appropriate
- **Complete data**: All historical data backed up

### For Developers
- **Automatic**: No manual intervention required
- **Resilient**: Multiple fallback layers
- **Transparent**: Comprehensive logging

### For ML/Analysis
- **Complete dataset**: All data in BigQuery
- **Structured**: Consistent schema
- **Fresh**: Continuously updated
- **Queryable**: SQL access for analysis

---

## 🚦 Deployment

### 1. Deploy Application
```bash
cd /Users/VTNX82W/Documents/personalDev/hanks_tank_backend
gcloud app deploy
```

### 2. Deploy Cron Jobs
```bash
gcloud app deploy cron.yaml
```

### 3. Verify Scheduled Jobs
```bash
gcloud scheduler jobs list
```

### 4. Test Validation Endpoints
```bash
# Daily check
curl https://hankstank.uc.r.appspot.com/api/validation/daily-check

# Monthly audit
curl https://hankstank.uc.r.appspot.com/api/validation/monthly-audit
```

---

## 📈 Future Enhancements

1. **Real-time Streaming**: Use Pub/Sub for live game updates
2. **ML Integration**: Direct pipelines from BigQuery to AI Platform
3. **Delta Sync**: Only sync changed records
4. **Compression**: Optimize storage costs
5. **Multi-region**: Replicate to multiple regions

---

## ✅ Summary

The Continuous Backup System ensures:

✅ **Always available** - BigQuery fallback if MLB API down  
✅ **Always current** - Auto-backup on every request  
✅ **Always complete** - Scheduled jobs fill gaps  
✅ **Always validated** - Automated integrity checks  
✅ **Always logged** - Full audit trail  

**Result**: A rock-solid data infrastructure that supports both live operations and ML/analysis workloads.
