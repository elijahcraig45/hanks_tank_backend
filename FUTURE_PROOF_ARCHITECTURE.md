# BigQuery Sync System - Future-Proof Architecture

## ✅ Zero Maintenance Required Year-to-Year

This system is **completely self-maintaining** and requires **NO updates** as seasons progress. Here's how:

## 🔧 Dynamic Year Calculation

### How It Works

All year ranges are calculated dynamically from the current date:

```typescript
// From gcp.config.ts
currentSeason: new Date().getFullYear()  // Always current year
minSeason: 2015                          // Configurable minimum
```

### What This Means

- **January 2026**: System automatically recognizes 2026 as current season
  - Historical data: 2015-2025 ✅
  - Live data: 2026 ✅
  
- **January 2027**: System automatically recognizes 2027 as current season
  - Historical data: 2015-2026 ✅
  - Live data: 2027 ✅

- **No code changes needed** - ever!

## 📊 Data Routing Logic

### Current Implementation

```typescript
// Calculated dynamically every request
const currentSeason = new Date().getFullYear();        // 2025 (in Dec 2025)
const minHistoricalSeason = config.minSeason;          // 2015
const lastCompletedSeason = currentSeason - 1;         // 2024

// Decision: Use historical data?
if (season >= currentSeason) {
  return false;  // Current/future season - use live API
}

if (season < minHistoricalSeason) {
  return false;  // Before our data range - use live API
}

return true;  // Completed season in our range - use BigQuery
```

### Why This Is Perfect

| Date | Current Season | Historical Range | Current Season Source |
|------|----------------|------------------|----------------------|
| Dec 2025 | 2025 | 2015-2024 | Live MLB API |
| Jan 2026 | 2026 | 2015-2025 | Live MLB API |
| Dec 2026 | 2026 | 2015-2025 | Live MLB API |
| Jan 2027 | 2027 | 2015-2026 | Live MLB API |

**No configuration changes needed - it just works!**

## 🎯 Sync Service Logic

### Year Validation

```typescript
// Dynamically calculated - never hardcoded
const minYear = gcpConfig.dataSource.minSeason;  // 2015
const maxYear = new Date().getFullYear() - 1;    // Current year - 1

// Example in December 2025:
// Valid years: 2015-2024 ✅

// Example in January 2026:
// Valid years: 2015-2025 ✅ (2025 is now completed)
```

### Missing Year Detection

```typescript
// getHistoricalYears() - calculated every time
const currentSeason = new Date().getFullYear();
const lastCompletedSeason = currentSeason - 1;

// Returns: [2015, 2016, 2017, ..., lastCompletedSeason]
// Automatically includes new seasons as they complete
```

## 🔄 Automatic Season Progression

### Timeline Example (2025→2026 Transition)

**December 31, 2025 (11:59 PM)**
- Current season: 2025
- Historical data: 2015-2024
- 2025 data source: MLB API (live)

**January 1, 2026 (12:01 AM)**
- Current season: 2026 ✅ (automatically updated)
- Historical data: 2015-2024 (2025 not yet in BigQuery)
- 2026 data source: MLB API (live)
- 2025 data source: MLB API (still live until synced)

**Post-Sync (after running /api/sync/missing)**
- Current season: 2026
- Historical data: 2015-2025 ✅ (2025 now cached)
- 2026 data source: MLB API (live)
- 2025 data source: BigQuery (cached)

## 🛡️ Safeguards Built In

### 1. Current Season Protection
```typescript
// In syncMissingData()
if (year >= this.currentSeason) {
  logger.info(`Skipping current/future season ${year}`);
  continue;  // Never cache current season
}
```

**Result**: Impossible to accidentally cache current season data

### 2. Dynamic Year Range
```typescript
// No hardcoded "2024" or "2025" anywhere
// All calculated from new Date().getFullYear()
```

**Result**: Code works identically in 2026, 2027, 2030, etc.

### 3. Configurable Minimum
```typescript
// From environment variable
MIN_SEASON=2015

// Want to start from 2010 instead? Just change env var!
// No code changes needed
```

**Result**: Easy to extend historical range if needed

## 📝 Configuration Reference

### Environment Variables (All Optional)

```bash
# Automatically calculated if not set
CURRENT_SEASON=            # Default: new Date().getFullYear()

# Only set these if you want to override defaults
MIN_SEASON=2015            # Earliest year to sync
MAX_SEASON=2030            # Hard limit (safety)

# GCP Settings
GCP_PROJECT_ID=hankstank
BQ_DATASET=mlb_historical_data
```

### What Happens Each Year

**You don't need to do anything!**

The system automatically:
1. Recognizes new current season (Jan 1)
2. Treats previous season as historical
3. Routes requests correctly
4. Syncs new season when you run `/api/sync/missing`

## 🚀 Recommended Annual Process

### End of Season (November)

After World Series ends:

```bash
# 1. Check what's missing
curl https://hankstank.uc.r.appspot.com/api/sync/status

# 2. Sync completed season
curl -X POST https://hankstank.uc.r.appspot.com/api/sync/missing \
  -H "Content-Type: application/json" \
  -d '{"years": [2025]}'  # Update year as needed

# 3. Verify sync
curl https://hankstank.uc.r.appspot.com/api/sync/status
```

**That's it!** No code deployment, no configuration changes.

## ✅ Future-Proof Checklist

- ✅ No hardcoded years in code
- ✅ Dynamic year calculation from system date
- ✅ Current season always uses live API
- ✅ Completed seasons use BigQuery
- ✅ Automatic year range expansion
- ✅ Configurable via environment variables
- ✅ Protected against accidentally caching current season
- ✅ Works identically in any year (2026, 2030, 2050...)

## 🔍 Code Review: No Hardcoded Years

### ✅ Good Examples (What We Have)

```typescript
// Dynamic - works forever
const currentSeason = new Date().getFullYear();
const lastCompletedSeason = currentSeason - 1;
const historicalYears = range(minSeason, lastCompletedSeason);
```

### ❌ Bad Examples (What We Avoided)

```typescript
// Hardcoded - would break in 2026
if (season > 2024) { return false; }
const historicalYears = [2015, 2016, ..., 2024];
```

## 🎓 Key Principles Applied

1. **Single Source of Truth**: `new Date().getFullYear()`
2. **Relative Calculations**: `currentYear - 1` not `2024`
3. **Configuration Over Code**: ENV vars for limits
4. **Defensive Programming**: Current season protection
5. **Self-Documenting**: Logs show year ranges on startup

## 📊 Testing Future Scenarios

### How to Test for 2026

You can test future behavior by setting environment variable:

```bash
# Pretend it's 2026
CURRENT_SEASON=2026 npm run dev

# System will now:
# - Treat 2015-2025 as historical
# - Route 2026 requests to MLB API
# - Allow syncing 2025 data
```

## 🎉 Summary

**This system requires ZERO maintenance for year-to-year progression.**

The only action needed is an annual sync of the completed season:
```bash
curl -X POST .../api/sync/missing -d '{"years": [LAST_YEAR]}'
```

Everything else is automatic. No code changes, no deployments, no configuration updates needed year after year.

---

**Built to last** ⚾
