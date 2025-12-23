# 🚀 MLB Transactions - Deployment Checklist

Use this checklist to deploy the transactions feature to production.

## ✅ Pre-Deployment

### Backend Verification
- [x] TypeScript compiles without errors (`npm run build`)
- [ ] All service files created
  - [ ] `src/services/transactions.service.ts`
  - [ ] `src/controllers/transactions.controller.ts`
  - [ ] `src/routes/transactions.routes.ts`
- [ ] BigQuery sync service updated
- [ ] Routes registered in `app.ts`
- [ ] Cache keys configured

### Database Setup
- [ ] BigQuery project accessible
- [ ] Dataset `hanks_tank` exists
- [ ] Run schema creation SQL:
  ```bash
  # In BigQuery Console, run:
  scripts/bigquery/transactions_schema.sql
  ```
- [ ] Verify table created: `transactions_historical`

### Historical Data Collection
- [ ] Backend running locally
- [ ] Run collection script:
  ```bash
  cd hanks_tank_backend
  npm run transactions:collect
  
  # Or for specific years:
  npm run transactions:collect:year 2024,2025
  ```
- [ ] Verify data in BigQuery:
  ```sql
  SELECT year, COUNT(*) as count
  FROM `hanks_tank.transactions_historical`
  GROUP BY year
  ORDER BY year DESC;
  ```

### Frontend Files
- [ ] Components created:
  - [ ] `src/components/Transactions.js`
  - [ ] `src/components/TeamTransactions.js`
- [ ] Environment variable set:
  ```bash
  # In .env or .env.local
  REACT_APP_API_URL=http://localhost:8080
  # Or production URL
  REACT_APP_API_URL=https://your-backend.com
  ```

## 🧪 Testing

### Backend Tests
- [ ] Health check:
  ```bash
  curl http://localhost:8080/health
  ```
- [ ] Recent transactions:
  ```bash
  curl http://localhost:8080/api/transactions/recent
  ```
- [ ] Team transactions:
  ```bash
  curl http://localhost:8080/api/transactions/team/144
  ```
- [ ] Year query:
  ```bash
  curl http://localhost:8080/api/transactions/year/2024
  ```
- [ ] Breakdown endpoint:
  ```bash
  curl http://localhost:8080/api/transactions/team/144/breakdown
  ```

### Frontend Tests
- [ ] Start frontend: `npm start`
- [ ] Navigate to transactions page
- [ ] Test filters:
  - [ ] Team filter
  - [ ] Date range filter
  - [ ] Type filter
- [ ] Verify data loads
- [ ] Check mobile responsiveness
- [ ] Test error states (disconnect backend)

### Integration Tests
- [ ] BigQuery sync status:
  ```bash
  curl http://localhost:8080/api/sync/status
  ```
- [ ] Data consistency check
- [ ] Cache working (check response times)
- [ ] Error handling works

## 📦 Production Deployment

### 1. Backend Deployment

#### Google Cloud App Engine
```bash
cd hanks_tank_backend

# Build
npm run build

# Deploy
npm run deploy:prod

# Verify
gcloud app browse
```

#### Or Docker/Container
```bash
# Build image
docker build -t hanks-tank-backend .

# Run container
docker run -p 8080:8080 hanks-tank-backend

# Deploy to your container service
```

### 2. BigQuery Setup (Production)
- [ ] Production BigQuery project ready
- [ ] Run schema SQL in production
- [ ] Configure service account permissions
- [ ] Update `gcp.config.ts` with production project

### 3. Historical Data Collection (Production)
```bash
# SSH into production or run Cloud Shell
cd hanks_tank_backend
npm run transactions:collect
```

### 4. Frontend Deployment

#### Update Environment
```bash
# .env.production
REACT_APP_API_URL=https://your-backend.appspot.com
```

#### Build and Deploy
```bash
cd hanks_tank

# Build
npm run build

# Deploy to hosting service
# Firebase:
firebase deploy --only hosting

# Or other service
```

### 5. Add to Navigation

**Update App.js:**
```javascript
import Transactions from './components/Transactions';
import TeamTransactions from './components/TeamTransactions';

// Add routes
<Route path="/transactions" element={<Transactions />} />
<Route path="/team/:teamId/transactions" element={<TeamTransactions />} />
```

**Update Navbar.js:**
```javascript
<Link to="/transactions">Transactions</Link>
```

## 🔄 Post-Deployment

### Verification
- [ ] Visit production URL
- [ ] Test all endpoints
- [ ] Check transactions page loads
- [ ] Verify data displays correctly
- [ ] Test filters work
- [ ] Check mobile view
- [ ] Monitor error logs

### BigQuery Verification
```sql
-- Check recent data
SELECT * FROM `hanks_tank.transactions_historical`
ORDER BY date DESC
LIMIT 10;

-- Check data coverage
SELECT 
  year,
  MIN(date) as earliest,
  MAX(date) as latest,
  COUNT(*) as count
FROM `hanks_tank.transactions_historical`
GROUP BY year
ORDER BY year DESC;
```

### Performance Check
- [ ] API response times < 500ms
- [ ] Page load time < 2s
- [ ] Cache hit rate > 80%
- [ ] BigQuery queries optimized

## 📊 Monitoring

### Set Up Monitoring
- [ ] Backend health checks
- [ ] API endpoint monitoring
- [ ] Error rate alerts
- [ ] BigQuery cost monitoring
- [ ] Cache performance metrics

### Logging
```bash
# View production logs
npm run gcp:logs

# Or
gcloud app logs tail -s default
```

## 🔧 Scheduled Jobs (Optional)

### Daily Sync (Recommended)
Set up Cloud Scheduler or cron job:

```yaml
# app.yaml or cron.yaml
cron:
  - description: "Daily transaction sync"
    url: /api/sync/transactions/current
    schedule: every day 02:00
    timezone: America/New_York
```

### Weekly Full Sync
```yaml
  - description: "Weekly full transaction sync"
    url: /api/sync/transactions/full
    schedule: every sunday 03:00
    timezone: America/New_York
```

## 🎯 Success Criteria

After deployment, verify:
- [x] ✅ TypeScript compiles
- [ ] ✅ Backend running in production
- [ ] ✅ BigQuery table created
- [ ] ✅ Historical data loaded (2015-2025)
- [ ] ✅ API endpoints responding
- [ ] ✅ Frontend displays transactions
- [ ] ✅ Filters working
- [ ] ✅ Mobile responsive
- [ ] ✅ Error handling works
- [ ] ✅ Performance acceptable

## 📱 User Acceptance Testing

### Test Scenarios
1. **View Recent Transactions**
   - [ ] Navigate to /transactions
   - [ ] See last 30 days of transactions
   - [ ] Verify dates and data accuracy

2. **Filter by Team**
   - [ ] Select Atlanta Braves
   - [ ] See only Braves transactions
   - [ ] Verify accuracy

3. **Filter by Date Range**
   - [ ] Set custom date range
   - [ ] Apply filter
   - [ ] Verify results match range

4. **View Team Page**
   - [ ] Navigate to team page
   - [ ] See transactions section
   - [ ] Verify timeline displays
   - [ ] Check breakdown stats

5. **Mobile Testing**
   - [ ] Test on phone
   - [ ] Verify layout
   - [ ] Test filters
   - [ ] Check scrolling

## 🐛 Common Issues & Solutions

### API Returns Empty
```bash
# Check backend logs
npm run gcp:logs

# Verify MLB API is accessible
curl https://statsapi.mlb.com/api/v1/transactions

# Check cache
# Clear and retry
```

### BigQuery Sync Fails
```bash
# Check service account permissions
# Verify dataset exists
# Check quota limits
gcloud projects describe YOUR_PROJECT_ID
```

### Frontend Not Loading
```bash
# Check API URL
echo $REACT_APP_API_URL

# Verify CORS configured
# Check network tab in browser DevTools
```

## 📞 Rollback Plan

If issues occur:

1. **Backend Issues**
   ```bash
   # Rollback to previous version
   gcloud app versions list
   gcloud app versions migrate PREVIOUS_VERSION
   ```

2. **Frontend Issues**
   - Remove routes from App.js
   - Redeploy frontend
   - Keep backend running (no impact)

3. **Data Issues**
   - BigQuery data is immutable
   - Can re-run collection script
   - Previous data remains intact

## ✅ Final Checklist

Before marking as DONE:
- [ ] All backend tests pass
- [ ] All frontend tests pass
- [ ] Production deployment successful
- [ ] Data verified in BigQuery
- [ ] Monitoring set up
- [ ] Documentation updated
- [ ] Team trained on new feature
- [ ] Stakeholders notified

## 🎉 Completion

Once all items checked:
1. Update project status
2. Notify stakeholders
3. Monitor for 24-48 hours
4. Collect user feedback
5. Plan Phase 2 enhancements

---

**Deployment Date**: _____________  
**Deployed By**: _____________  
**Production URL**: _____________  
**Status**: [ ] Not Started [ ] In Progress [ ] Complete
