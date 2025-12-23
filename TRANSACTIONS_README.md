# MLB Transactions System

Complete implementation for tracking MLB transactions with historical data (2015-2025) and real-time updates, backed by BigQuery.

## Features

- **Historical Data**: Transactions from 2015-2025
- **Real-time Updates**: Current transactions fetched on page load
- **BigQuery Backup**: All data automatically synced to BigQuery
- **Team Filtering**: View transactions by specific teams
- **Date Range Filtering**: Filter by custom date ranges
- **Transaction Type Breakdown**: See summary of transaction types
- **Beautiful UI**: Modern, responsive interface with timeline view

## Backend Implementation

### 1. Service Layer
**File**: `src/services/transactions.service.ts`

- Fetches transactions from MLB StatsAPI
- Supports filtering by team, player, date range
- Provides transaction type breakdown analytics
- Implements caching for improved performance

### 2. Controller Layer
**File**: `src/controllers/transactions.controller.ts`

Endpoints:
- `GET /api/transactions` - Get all transactions with filters
- `GET /api/transactions/recent` - Last 30 days
- `GET /api/transactions/year/:year` - Specific year
- `GET /api/transactions/team/:teamId` - Team-specific
- `GET /api/transactions/team/:teamId/breakdown` - Type breakdown

### 3. BigQuery Integration
**File**: `src/services/bigquery-sync.service.ts`

- Automatic syncing of historical transactions
- Table: `transactions_historical`
- Partitioned by year for efficient queries
- Clustered by date and person_id for fast lookups

### 4. Routes
**File**: `src/routes/transactions.routes.ts`

All endpoints properly registered and accessible via `/api/transactions`

## Frontend Implementation

### 1. Transactions Component
**File**: `src/components/Transactions.js`

Features:
- View all recent transactions (last 30 days by default)
- Filter by team, date range, and transaction type
- Beautiful card-based layout
- Color-coded transaction types
- Responsive design

### 2. Team Transactions Component
**File**: `src/components/TeamTransactions.js`

Features:
- Team-specific transaction view
- Timeline visualization
- Transaction type breakdown with icons
- Flexible date range selection (7/30/90/365 days, current season)
- Summary statistics

## Setup Instructions

### 1. Create BigQuery Table

```bash
# Navigate to scripts directory
cd hanks_tank_backend/scripts/bigquery

# Run the schema creation
bq query --use_legacy_sql=false < transactions_schema.sql
```

Or manually create in BigQuery Console using the schema in `scripts/bigquery/transactions_schema.sql`

### 2. Collect Historical Data

```bash
cd hanks_tank_backend

# Collect all years (2015-2025)
node scripts/collect_historical_transactions.js

# Or specific years
node scripts/collect_historical_transactions.js --years 2024,2025

# Or year range
node scripts/collect_historical_transactions.js --start-year 2020 --end-year 2025
```

### 3. Backend Setup

The backend is already configured with:
- Transactions routes registered in `app.ts`
- Cache keys configured in `utils/cache-keys.ts`
- Service and controller ready to use

Just ensure your backend is running:

```bash
cd hanks_tank_backend
npm run dev
```

### 4. Frontend Integration

Add the routes to your main App.js:

```javascript
import Transactions from './components/Transactions';
import TeamTransactions from './components/TeamTransactions';

// In your Routes
<Route path="/transactions" element={<Transactions />} />
<Route path="/team/:teamId/transactions" element={<TeamTransactions />} />
```

Add navigation links in your Navbar:

```javascript
<Link to="/transactions">Transactions</Link>
```

## API Usage Examples

### Get Recent Transactions
```bash
curl http://localhost:8080/api/transactions/recent
```

### Get Braves Transactions (2025)
```bash
curl "http://localhost:8080/api/transactions/team/144?startDate=2025-01-01&endDate=2025-12-31"
```

### Get Transaction Breakdown
```bash
curl http://localhost:8080/api/transactions/team/144/breakdown
```

### Get All Transactions for 2024
```bash
curl http://localhost:8080/api/transactions/year/2024
```

## BigQuery Queries

### Get All Transactions for a Team
```sql
SELECT 
  date, 
  type_desc, 
  person_full_name, 
  description,
  from_team_name,
  to_team_name
FROM `hanks_tank.transactions_historical`
WHERE from_team_id = 144 OR to_team_id = 144
ORDER BY date DESC
LIMIT 100;
```

### Transaction Type Distribution by Year
```sql
SELECT 
  year,
  type_desc,
  COUNT(*) as count
FROM `hanks_tank.transactions_historical`
GROUP BY year, type_desc
ORDER BY year DESC, count DESC;
```

### Player Transaction History
```sql
SELECT 
  date,
  type_desc,
  description,
  from_team_name,
  to_team_name
FROM `hanks_tank.transactions_historical`
WHERE person_id = 660271  -- Ronald Acuña Jr.
ORDER BY date DESC;
```

## Data Schema

### BigQuery Table: `transactions_historical`

| Column | Type | Description |
|--------|------|-------------|
| year | INT64 | Transaction year |
| transaction_id | INT64 | Unique transaction ID |
| date | STRING | Transaction date (YYYY-MM-DD) |
| type_code | STRING | Transaction type code |
| type_desc | STRING | Human-readable type (Trade, Signed, etc.) |
| description | STRING | Full transaction description |
| from_team_id | INT64 | Source team ID |
| from_team_name | STRING | Source team name |
| to_team_id | INT64 | Destination team ID |
| to_team_name | STRING | Destination team name |
| person_id | INT64 | Player ID |
| person_full_name | STRING | Player name |
| resolution | STRING | Transaction resolution/outcome |
| notes | STRING | Additional notes |
| synced_at | TIMESTAMP | Sync timestamp |

## Transaction Types

Common transaction types you'll see:
- **Trade**: Player traded between teams
- **Signed**: Player signed with team
- **Released**: Player released by team
- **Selected off waivers**: Claimed from waivers
- **Recalled**: Called up from minors
- **Optioned**: Sent down to minors
- **Designated for assignment**: DFA'd
- **Placed on IL**: Injured list
- **Activated**: Returned from IL
- **Returned**: Returned from loan/assignment

## Automatic Updates

### Current Season Transactions
The system automatically fetches current transactions on page load. For real-time updates:

1. Frontend fetches from `/api/transactions/recent` on mount
2. Backend caches for 1 hour (configurable in `cache-keys.ts`)
3. BigQuery sync runs periodically via scheduled jobs

### Historical Data Refresh
To refresh historical data:

```bash
# Force refresh specific year
node scripts/collect_historical_transactions.js --years 2025

# The --force flag can be added to override existing data
```

## Monitoring & Maintenance

### Check Sync Status
```bash
curl http://localhost:8080/api/sync/status
```

### Manual Sync
```bash
# Sync transactions for 2025
curl -X POST http://localhost:8080/api/sync/transactions \
  -H "Content-Type: application/json" \
  -d '{"year": 2025}'
```

## Performance Optimization

1. **Caching**: Transactions cached for 1 hour
2. **Partitioning**: BigQuery table partitioned by year
3. **Clustering**: Clustered by date and person_id
4. **Indexing**: Indexes on common query patterns
5. **Rate Limiting**: 2-second delay between historical year fetches

## Troubleshooting

### No Transactions Showing
1. Check backend is running: `curl http://localhost:8080/health`
2. Verify API endpoint: `curl http://localhost:8080/api/transactions/recent`
3. Check browser console for errors
4. Verify REACT_APP_API_URL environment variable

### BigQuery Sync Failing
1. Check GCP credentials are configured
2. Verify BigQuery dataset exists
3. Check table schema matches
4. Review logs for specific errors

### Historical Collection Errors
1. MLB API rate limiting - add longer delays
2. Network timeouts - adjust timeout settings
3. Missing years - check data availability on MLB side

## Future Enhancements

- [ ] Real-time WebSocket updates for live transactions
- [ ] Push notifications for favorite team transactions
- [ ] Transaction impact analytics (WAR, salary cap, etc.)
- [ ] Trade deadline tracker and countdown
- [ ] Transaction history comparison between teams
- [ ] Export transactions to CSV/Excel
- [ ] Transaction search by player name
- [ ] Advanced filtering (position, contract type, etc.)

## Contributing

When adding new features:
1. Update service layer first
2. Add BigQuery schema changes
3. Update controller and routes
4. Update frontend components
5. Add tests
6. Update this README

## License

Same as parent project (see LICENSE file)
