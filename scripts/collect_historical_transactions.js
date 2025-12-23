#!/usr/bin/env node

/**
 * Historical Transactions Collection Script
 * Collects MLB transactions from 2015-2025 and syncs to BigQuery
 * 
 * Usage:
 *   node collect_historical_transactions.js
 *   node collect_historical_transactions.js --years 2024,2025
 *   node collect_historical_transactions.js --start-year 2020 --end-year 2025
 */

const { bigQuerySyncService } = require('../dist/services/bigquery-sync.service');
const { transactionsService } = require('../dist/services/transactions.service');
const { logger } = require('../dist/utils/logger');

// Parse command line arguments
const args = process.argv.slice(2);
let years = [];

if (args.includes('--years')) {
  const yearsIndex = args.indexOf('--years');
  const yearsStr = args[yearsIndex + 1];
  years = yearsStr.split(',').map(y => parseInt(y.trim()));
} else {
  const startYearIndex = args.indexOf('--start-year');
  const endYearIndex = args.indexOf('--end-year');
  
  const startYear = startYearIndex >= 0 ? parseInt(args[startYearIndex + 1]) : 2015;
  const endYear = endYearIndex >= 0 ? parseInt(args[endYearIndex + 1]) : 2025;
  
  for (let year = startYear; year <= endYear; year++) {
    years.push(year);
  }
}

console.log('🏀 MLB Historical Transactions Collection');
console.log('==========================================');
console.log(`Years: ${years.join(', ')}`);
console.log(`Total: ${years.length} years\n`);

logger.info('Starting historical transactions collection', {
  years,
  totalYears: years.length
});

async function collectHistoricalTransactions() {
  const startTime = Date.now();
  const results = {
    successful: [],
    failed: [],
    totalRecords: 0
  };

  for (const year of years) {
    try {
      console.log(`\n📅 Collecting transactions for ${year}...`);
      logger.info(`Collecting transactions for ${year}...`);
      
      // Sync to BigQuery
      const syncResult = await bigQuerySyncService.syncTransactions(year, false);
      
      if (syncResult.success) {
        results.successful.push(year);
        results.totalRecords += syncResult.recordsAdded;
        console.log(`✅ Successfully synced ${year}: ${syncResult.recordsAdded} records`);
        logger.info(`✅ Successfully synced ${year}: ${syncResult.recordsAdded} records`);
      } else {
        results.failed.push(year);
        console.log(`❌ Failed to sync ${year}: ${syncResult.error}`);
        logger.error(`❌ Failed to sync ${year}: ${syncResult.error}`);
      }
      
      // Add delay to avoid rate limiting
      if (year !== years[years.length - 1]) {
        console.log(`⏳ Waiting 2 seconds before next year...`);
        logger.info(`Waiting 2 seconds before next year...`);
        await delay(2000);
      }
    } catch (error) {
      results.failed.push(year);
  console.log('\n==========================================');
  console.log('🎉 Historical transactions collection complete!');
  console.log(`Duration: ${duration}s`);
  console.log(`Successful: ${results.successful.length}/${years.length} years`);
  console.log(`Total Records: ${results.totalRecords}`);
  if (results.failed.length > 0) {
    console.log(`Failed: ${results.failed.join(', ')}`);
  }
  console.log('==========================================\n');
  
      console.log(`❌ Error collecting transactions for ${year}: ${error.message}`);
      logger.error(`Error collecting transactions for ${year}`, {
        error: error.message,
        year
      });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  logger.info('Historical transactions collection complete!', {
    duration: `${duration}s`,
    successful: results.successful.length,
    failed: results.failed.length,
    totalRecords: results.totalRecords,
    successfulYears: results.successful,
    failedYears: results.failed
  });

  return results;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the collection
collectHistoricalTransactions()
  .then(results => {
    if (results.failed.length > 0) {
      console.log('\n⚠️  Some years failed to sync:');
      results.failed.forEach(year => console.log(`  - ${year}`));
      process.exit(1);
    } else {
      console.log('\n✅ All years successfully synced!');
      console.log(`   Total records: ${results.totalRecords}`);
      process.exit(0);
    }
  })
  .catch(error => {
    logger.error('Fatal error in historical collection', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
