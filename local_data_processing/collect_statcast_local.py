#!/usr/bin/env python3
"""
Statcast Data Collection - Local to BigQuery
Collects MLB Statcast pitch data using pybaseball and uploads to BigQuery
with validation, deduplication, and progress tracking.
"""

import ssl
import certifi

# Fix SSL certificate verification issues
ssl._create_default_https_context = ssl._create_unverified_context

import pybaseball as pyb
from google.cloud import bigquery
from datetime import datetime, timedelta
import pandas as pd
import time
import sys
import warnings

warnings.filterwarnings('ignore')

# Enable cache for pybaseball
pyb.cache.enable()

# Initialize BigQuery client
client = bigquery.Client(project='hankstank')
dataset_id = 'mlb_historical_data'
table_id = 'statcast_pitches'
full_table_id = f'{client.project}.{dataset_id}.{table_id}'

def get_existing_data_summary():
    """Get summary of what data already exists in BigQuery"""
    query = f"""
    SELECT 
        year,
        COUNT(*) as pitch_count,
        COUNT(DISTINCT game_pk) as game_count,
        MIN(game_date) as first_date,
        MAX(game_date) as last_date
    FROM `{full_table_id}`
    GROUP BY year
    ORDER BY year
    """
    return client.query(query).to_dataframe()

def validate_month_data(df, year, month):
    """Validate collected data before upload"""
    if df is None or len(df) == 0:
        print(f"  ⚠️  No data found for {year}-{month:02d}")
        return False
    
    print(f"  ✓ Collected {len(df):,} pitches")
    print(f"  ✓ Date range: {df['game_date'].min()} to {df['game_date'].max()}")
    print(f"  ✓ Unique games: {df['game_pk'].nunique()}")
    print(f"  ✓ Unique pitchers: {df['pitcher'].nunique()}")
    
    # Check for required fields
    required_fields = ['game_pk', 'pitcher', 'batter', 'game_date', 'release_speed']
    missing = [f for f in required_fields if f not in df.columns or df[f].isna().all()]
    if missing:
        print(f"  ⚠️  Missing required fields: {missing}")
        return False
    
    return True

def upload_to_bigquery(df, year, month):
    """Upload data to BigQuery with deduplication"""
    if df is None or len(df) == 0:
        return 0
    
    # Add year column for partitioning
    df['year'] = year
    
    # Delete existing data for this month to avoid duplicates
    delete_query = f"""
    DELETE FROM `{full_table_id}`
    WHERE year = {year}
    AND EXTRACT(MONTH FROM game_date) = {month}
    """
    print(f"  🗑️  Deleting existing data for {year}-{month:02d}...")
    client.query(delete_query).result()
    
    # Upload new data
    print(f"  📤 Uploading {len(df):,} pitches...")
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION]
    )
    
    job = client.load_table_from_dataframe(df, full_table_id, job_config=job_config)
    job.result()  # Wait for completion
    
    # Verify upload
    verify_query = f"""
    SELECT COUNT(*) as count
    FROM `{full_table_id}`
    WHERE year = {year}
    AND EXTRACT(MONTH FROM game_date) = {month}
    """
    result = client.query(verify_query).to_dataframe()
    uploaded_count = result['count'].iloc[0]
    
    print(f"  ✓ Verified {uploaded_count:,} pitches in BigQuery")
    return uploaded_count

def collect_month(year, month, max_retries=3):
    """Collect Statcast data for a specific month with retry logic"""
    # Determine date range for the month
    if month == 3:  # March - start from opening day (typically late March)
        start_date = f"{year}-03-20"
    else:
        start_date = f"{year}-{month:02d}-01"
    
    if month == 10:  # October - end at end of regular season + playoffs
        end_date = f"{year}-10-31"
    elif month == 11:  # November - World Series
        end_date = f"{year}-11-10"
    else:
        # Last day of month
        if month == 12:
            end_date = f"{year}-12-31"
        else:
            next_month = datetime(year, month, 1) + timedelta(days=32)
            end_date = (next_month.replace(day=1) - timedelta(days=1)).strftime("%Y-%m-%d")
    
    print(f"\n{'='*60}")
    print(f"Collecting: {year}-{month:02d} ({start_date} to {end_date})")
    print(f"{'='*60}")
    
    for attempt in range(max_retries):
        try:
            # Collect data using pybaseball
            df = pyb.statcast(start_dt=start_date, end_dt=end_date, verbose=False)
            
            if df is not None and len(df) > 0:
                # Validate
                if validate_month_data(df, year, month):
                    # Upload
                    uploaded = upload_to_bigquery(df, year, month)
                    print(f"  ✅ SUCCESS: {uploaded:,} pitches uploaded for {year}-{month:02d}\n")
                    return uploaded
                else:
                    print(f"  ❌ VALIDATION FAILED for {year}-{month:02d}\n")
                    return 0
            else:
                print(f"  ⚠️  No data available for {year}-{month:02d}\n")
                return 0
                
        except Exception as e:
            print(f"  ⚠️  Attempt {attempt + 1}/{max_retries} failed: {str(e)[:100]}")
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 5
                print(f"  ⏳ Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            else:
                print(f"  ❌ ERROR: All {max_retries} attempts failed for {year}-{month:02d}\n")
                return 0
    
    return 0

def main():
    print("="*60)
    print("STATCAST DATA COLLECTION - LOCAL TO BIGQUERY")
    print("="*60)
    
    # Show existing data
    print("\n📊 Current BigQuery Data Summary:")
    existing = get_existing_data_summary()
    print(existing.to_string(index=False))
    
    # Define collection plan
    months_to_collect = [3, 4, 5, 6, 7, 8, 9, 10]  # March through October (includes playoffs)
    years_to_collect = range(2015, 2025)  # 2015-2024
    
    # Check which months already have data to skip
    print("\n🔍 Checking for existing data to resume collection...")
    existing_months = set()
    for year in years_to_collect:
        for month in months_to_collect:
            check_query = f"""
            SELECT COUNT(*) as count
            FROM `{full_table_id}`
            WHERE year = {year}
            AND EXTRACT(MONTH FROM game_date) = {month}
            """
            result = client.query(check_query).to_dataframe()
            if result['count'].iloc[0] > 1000:  # Already has substantial data
                existing_months.add(f"{year}-{month:02d}")
                print(f"  ✓ Skipping {year}-{month:02d} ({result['count'].iloc[0]:,} pitches already collected)")
    
    if existing_months:
        print(f"\n📊 Found {len(existing_months)} months with existing data - will skip these")
    
    # Ask for confirmation
    total_months = len(years_to_collect) * len(months_to_collect) - len(existing_months)
    print(f"\n📅 Collection Plan:")
    print(f"   Years: {min(years_to_collect)}-{max(years_to_collect)}")
    print(f"   Months per year: {months_to_collect}")
    print(f"   Total months to collect: {total_months}")
    print(f"   Estimated time: {total_months * 2} minutes (2 min/month avg)")
    print("\n🚀 Starting collection automatically...")
    
    # Collect data
    total_collected = 0
    successful_months = 0
    failed_months = []
    
    start_time = time.time()
    
    for year in years_to_collect:
        print(f"\n{'#'*60}")
        print(f"# YEAR {year}")
        print(f"{'#'*60}")
        
        year_total = 0
        
        for month in months_to_collect:
            month_key = f"{year}-{month:02d}"
            
            # Skip if already collected
            if month_key in existing_months:
                continue
            
            try:
                count = collect_month(year, month)
                year_total += count
                total_collected += count
                
                if count > 0:
                    successful_months += 1
                else:
                    failed_months.append(month_key)
                
                # Rate limiting - be nice to the API
                time.sleep(3)
                
            except KeyboardInterrupt:
                print("\n\n⚠️  Collection interrupted by user")
                print(f"Collected {total_collected:,} pitches before interruption")
                sys.exit(0)
            except Exception as e:
                print(f"  ❌ Unexpected error: {str(e)}")
                failed_months.append(month_key)
                continue
        
        print(f"\n{'='*60}")
        print(f"Year {year} Complete: {year_total:,} pitches collected")
        print(f"{'='*60}")
    
    # Final summary
    elapsed = time.time() - start_time
    print(f"\n\n{'#'*60}")
    print("# COLLECTION COMPLETE")
    print(f"{'#'*60}")
    print(f"✅ Total pitches collected: {total_collected:,}")
    print(f"✅ Successful months: {successful_months}/{total_months}")
    print(f"⏱️  Time elapsed: {elapsed/60:.1f} minutes")
    
    if failed_months:
        print(f"\n⚠️  Failed months ({len(failed_months)}):")
        for month in failed_months:
            print(f"   - {month}")
    
    # Final data summary
    print("\n📊 Final BigQuery Data Summary:")
    final = get_existing_data_summary()
    print(final.to_string(index=False))
    
    print("\n🎉 Collection script completed!")

if __name__ == "__main__":
    main()
