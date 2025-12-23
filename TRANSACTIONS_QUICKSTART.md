# MLB Transactions - Quick Reference

## 🚀 Quick Start

### Backend Setup
```bash
cd hanks_tank_backend

# Run complete setup (recommended)
npm run transactions:setup

# Or manual setup:
npm run build
# Create BigQuery table (see scripts/bigquery/transactions_schema.sql)
npm run transactions:collect
```

### Frontend Integration
```bash
cd hanks_tank

# Components are already created at:
# - src/components/Transactions.js
# - src/components/TeamTransactions.js

# Add to your App.js router:
import Transactions from './components/Transactions';
<Route path="/transactions" element={<Transactions />} />
```

## 📡 API Endpoints

### Get Recent Transactions (Last 30 Days)
```
GET /api/transactions/recent
```

### Get All Transactions (with filters)
```
GET /api/transactions?teamId=144&startDate=2025-01-01&endDate=2025-12-31
```

### Get Team Transactions
```
GET /api/transactions/team/144
GET /api/transactions/team/144?startDate=2025-01-01
```

### Get Transactions by Year
```
GET /api/transactions/year/2024
```

### Get Transaction Type Breakdown
```
GET /api/transactions/team/144/breakdown
```

## 💾 Data Collection

### Collect All Historical Data (2015-2025)
```bash
npm run transactions:collect
```

### Collect Specific Years
```bash
npm run transactions:collect:year 2024,2025
```

### Collect Year Range
```bash
node scripts/collect_historical_transactions.js --start-year 2020 --end-year 2025
```

## 🗄️ BigQuery

### Table Name
```
hanks_tank.transactions_historical
```

### Sample Queries

**Team Transactions:**
```sql
SELECT * FROM `hanks_tank.transactions_historical`
WHERE from_team_id = 144 OR to_team_id = 144
ORDER BY date DESC
LIMIT 100;
```

**Transaction Summary:**
```sql
SELECT type_desc, COUNT(*) as count
FROM `hanks_tank.transactions_historical`
WHERE year = 2025
GROUP BY type_desc
ORDER BY count DESC;
```

**Player History:**
```sql
SELECT date, type_desc, description, from_team_name, to_team_name
FROM `hanks_tank.transactions_historical`
WHERE person_id = 660271
ORDER BY date DESC;
```

## 🎨 Frontend Usage

### All Transactions Page
```javascript
import Transactions from './components/Transactions';

// Standalone page
<Route path="/transactions" element={<Transactions />} />
```

### Team-Specific Transactions
```javascript
import TeamTransactions from './components/TeamTransactions';

// As part of team page
<TeamTransactions teamId={144} teamName="Atlanta Braves" />

// Or standalone route
<Route path="/team/:teamId/transactions" element={<TeamTransactions />} />
```

## 📊 Team IDs Reference

| Team | ID |
|------|-----|
| Atlanta Braves | 144 |
| New York Yankees | 147 |
| Boston Red Sox | 111 |
| Los Angeles Dodgers | 119 |
| Chicago Cubs | 112 |

## 🔧 Troubleshooting

**Backend not responding:**
```bash
curl http://localhost:8080/health
```

**Test transactions endpoint:**
```bash
curl http://localhost:8080/api/transactions/recent
```

**Check BigQuery sync status:**
```bash
curl http://localhost:8080/api/sync/status
```

**View backend logs:**
```bash
npm run gcp:logs
```

## 📈 Features

✅ Historical data (2015-2025)  
✅ Real-time updates  
✅ BigQuery backup  
✅ Team filtering  
✅ Date range filtering  
✅ Transaction type breakdown  
✅ Beautiful UI with timeline  
✅ Responsive design  
✅ Caching for performance  

## 🛠️ NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run transactions:setup` | Complete setup script |
| `npm run transactions:collect` | Collect all historical data |
| `npm run transactions:collect:year 2024` | Collect specific year |

## 📖 Full Documentation

See [TRANSACTIONS_README.md](./TRANSACTIONS_README.md) for complete documentation.

## 🎯 Next Steps

1. ✅ Create BigQuery table
2. ✅ Collect historical data
3. ⬜ Add to frontend navigation
4. ⬜ Deploy to production
5. ⬜ Set up automatic sync schedule
