#!/usr/bin/env python3
"""
Direct Baseball Savant Statcast Collector
Bypasses pybaseball and uses requests directly with SSL verification disabled
"""

import requests
import pandas as pd
from google.cloud import bigquery
from datetime import datetime, timedelta
import time
import sys
import warnings
from io import StringIO

warnings.filterwarnings('ignore')
# Disable SSL warnings
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Initialize BigQuery client
client = bigquery.Client(project='hankstank')
dataset_id = 'mlb_historical_data'
table_id = 'statcast_pitches'
full_table_id = f'{client.project}.{dataset_id}.{table_id}'

def fetch_statcast_data(start_date, end_date):
    """Fetch Statcast data directly from Baseball Savant using requests"""
    url = "https://baseballsavant.mlb.com/statcast_search/csv"
    
    params = {
        'all': 'true',
        'hfPT': '',
        'hfAB': '',
        'hfBBT': '',
        'hfPR': '',
        'hfZ': '',
        'stadium': '',
        'hfBBL': '',
        'hfNewZones': '',
        'hfGT': 'R|PO|S|',
        'hfC': '',
        'hfSea': '',
        'hfSit': '',
        'player_type': 'pitcher',
        'hfOuts': '',
        'opponent': '',
        'pitcher_throws': '',
        'batter_stands': '',
        'hfSA': '',
        'game_date_gt': start_date,
        'game_date_lt': end_date,
        'team': '',
        'position': '',
        'hfRO': '',
        'home_road': '',
        'hfFlag': '',
        'metric_1': '',
        'hfInn': '',
        'min_pitches': '0',
        'min_results': '0',
        'group_by': 'name',
        'sort_col': 'pitches',
        'player_event_sort': 'h_launch_speed',
        'sort_order': 'desc',
        'min_abs': '0',
        'type': 'details',
    }
    
    # Make request with SSL verification disabled
    response = requests.get(url, params=params, verify=False, timeout=120)
    response.raise_for_status()
    
    # Parse CSV
    df = pd.read_csv(StringIO(response.text))
    return df

def upload_to_bigquery(df, year, month):
    """Upload data to BigQuery with deduplication"""
    if df is None or len(df) == 0:
        return 0
    
    # Convert game_date to datetime
    if 'game_date' in df.columns:
        df['game_date'] = pd.to_datetime(df['game_date'], errors='coerce')
    
    # Add year column
    df['year'] = year
    
    # Delete existing data for this month
    delete_query = f"""
    DELETE FROM `{full_table_id}`
    WHERE year = {year}
    AND EXTRACT(MONTH FROM game_date) = {month}
    """
    print(f"  🗑️  Clearing existing data for {year}-{month:02d}...")
    client.query(delete_query).result()
    
    # Upload new data
    print(f"  📤 Uploading {len(df):,} pitches...")
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION]
    )
    
    job = client.load_table_from_dataframe(df, full_table_id, job_config=job_config)
    job.result()
    
    # Verify
    verify_query = f"""
    SELECT COUNT(*) as count
    FROM `{full_table_id}`
    WHERE year = {year}
    AND EXTRACT(MONTH FROM game_date) = {month}
    """
    result = client.query(verify_query).to_dataframe()
    uploaded = result['count'].iloc[0]
    
    print(f"  ✓ Verified {uploaded:,} pitches in BigQuery")
    return uploaded

def collect_month(year, month, max_retries=3):
    """Collect data for a specific month in weekly chunks to avoid 25K limit"""
    if month == 3:
        start = datetime(year, 3, 20)
    else:
        start = datetime(year, month, 1)
    
    if month == 10:
        end = datetime(year, 10, 31)
    else:
        next_month = datetime(year, month, 1) + timedelta(days=32)
        end = next_month.replace(day=1) - timedelta(days=1)
    
    print(f"\n{'='*60}", flush=True)
    print(f"📅 {year}-{month:02d} ({start.date()} to {end.date()})", flush=True)
    print(f"{'='*60}", flush=True)
    
    # Break into 7-day chunks to stay under 25K limit
    chunks = []
    current = start
    while current <= end:
        chunk_end = min(current + timedelta(days=6), end)
        chunks.append((current.strftime("%Y-%m-%d"), chunk_end.strftime("%Y-%m-%d")))
        current = chunk_end + timedelta(days=1)
    
    print(f"  📦 Collecting in {len(chunks)} weekly chunks...", flush=True)
    
    all_data = []
    total_pitches = 0
    
    for chunk_start, chunk_end in chunks:
        for attempt in range(max_retries):
            try:
                df = fetch_statcast_data(chunk_start, chunk_end)
                
                if df is not None and len(df) > 0:
                    all_data.append(df)
                    total_pitches += len(df)
                    print(f"  ✓ {chunk_start} to {chunk_end}: {len(df):,} pitches", flush=True)
                    break
                else:
                    break  # No data for this period
                    
            except Exception as e:
                error_msg = str(e)[:100]
                if attempt < max_retries - 1:
                    print(f"  ⚠️  Retry {chunk_start}-{chunk_end}...", flush=True)
                    time.sleep(3)
                else:
                    print(f"  ❌ Failed {chunk_start}-{chunk_end}: {error_msg}", flush=True)
        
        time.sleep(1)  # Rate limit between chunks
    
    if all_data:
        # Combine all chunks
        combined_df = pd.concat(all_data, ignore_index=True)
        print(f"  📊 Total: {len(combined_df):,} pitches, {combined_df['game_pk'].nunique()} games", flush=True)
        uploaded = upload_to_bigquery(combined_df, year, month)
        print(f"  ✅ SUCCESS: {uploaded:,} pitches for {year}-{month:02d}\n", flush=True)
        return uploaded
    else:
        print(f"  ⚠️  No data for {year}-{month:02d}\n", flush=True)
        return 0

def get_months_to_collect():
    """Get list of months that need data"""
    months_to_collect = [3, 4, 5, 6, 7, 8, 9, 10]
    years_to_collect = range(2015, 2025)
    
    print("🔍 Checking existing data...")
    existing = set()
    
    for year in years_to_collect:
        for month in months_to_collect:
            query = f"""
            SELECT COUNT(*) as count
            FROM `{full_table_id}`
            WHERE year = {year}
            AND EXTRACT(MONTH FROM game_date) = {month}
            """
            result = client.query(query).to_dataframe()
            count = result['count'].iloc[0]
            if count > 1000:
                existing.add((year, month))
                print(f"  ✓ Skip {year}-{month:02d} ({count:,} pitches)")
    
    # Generate list of months to collect
    todo = []
    for year in years_to_collect:
        for month in months_to_collect:
            if (year, month) not in existing:
                todo.append((year, month))
    
    return todo

def main():
    print("="*60, flush=True)
    print("STATCAST DIRECT COLLECTOR", flush=True)
    print("="*60, flush=True)
    
    todo = get_months_to_collect()
    
    print(f"\n📊 Found {len(todo)} months to collect", flush=True)
    print(f"⏱️  Estimated time: {len(todo) * 2} minutes\n", flush=True)
    print("🚀 Starting collection...\n", flush=True)
    
    total_collected = 0
    successful = 0
    failed = []
    
    start_time = time.time()
    
    for year, month in todo:
        try:
            count = collect_month(year, month)
            total_collected += count
            
            if count > 0:
                successful += 1
            else:
                failed.append(f"{year}-{month:02d}")
            
            # Rate limit
            time.sleep(3)
            
        except KeyboardInterrupt:
            print("\n⚠️  Interrupted")
            break
        except Exception as e:
            print(f"  ❌ Error: {str(e)[:100]}")
            failed.append(f"{year}-{month:02d}")
    
    # Summary
    elapsed = time.time() - start_time
    print(f"\n{'='*60}")
    print("COLLECTION COMPLETE")
    print(f"{'='*60}")
    print(f"✅ Collected: {total_collected:,} pitches")
    print(f"✅ Successful: {successful}/{len(todo)} months")
    print(f"⏱️  Time: {elapsed/60:.1f} minutes")
    
    if failed:
        print(f"\n❌ Failed ({len(failed)}):")
        for m in failed:
            print(f"   - {m}")
    
    # Final summary
    print("\n📊 Final Data Summary:")
    summary = client.query(f"""
    SELECT year, COUNT(*) as pitches, COUNT(DISTINCT game_pk) as games
    FROM `{full_table_id}`
    GROUP BY year
    ORDER BY year
    """).to_dataframe()
    print(summary.to_string(index=False))

if __name__ == "__main__":
    main()
