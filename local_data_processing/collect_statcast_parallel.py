#!/usr/bin/env python3
"""
Multithreaded Statcast Collector - Daily chunks with parallel processing
"""

import requests
import pandas as pd
from google.cloud import bigquery
from datetime import datetime, timedelta
import time
import warnings
from io import StringIO
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

warnings.filterwarnings('ignore')
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Thread-safe print
print_lock = threading.Lock()

def thread_print(*args, **kwargs):
    with print_lock:
        print(*args, **kwargs, flush=True)

# Initialize BigQuery client
client = bigquery.Client(project='hankstank')
dataset_id = 'mlb_historical_data'
table_id = 'statcast_pitches'
full_table_id = f'{client.project}.{dataset_id}.{table_id}'

def fetch_statcast_day(date_str):
    """Fetch Statcast data for a single day"""
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
        'game_date_gt': date_str,
        'game_date_lt': date_str,
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
    
    response = requests.get(url, params=params, verify=False, timeout=60)
    response.raise_for_status()
    
    if response.text.strip():
        df = pd.read_csv(StringIO(response.text))
        return df if len(df) > 0 else None
    return None

def collect_day(date_str, max_retries=2):
    """Collect data for a single day with retries"""
    for attempt in range(max_retries):
        try:
            df = fetch_statcast_day(date_str)
            if df is not None and len(df) > 0:
                return (date_str, df, None)
            return (date_str, None, None)
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2)
            else:
                return (date_str, None, str(e)[:100])
    return (date_str, None, "Max retries exceeded")

def upload_month_data(df, year, month):
    """Upload combined month data to BigQuery"""
    if df is None or len(df) == 0:
        return 0
    
    # Convert date and add year
    if 'game_date' in df.columns:
        df['game_date'] = pd.to_datetime(df['game_date'], errors='coerce')
    df['year'] = year
    
    # Delete existing month data
    delete_query = f"""
    DELETE FROM `{full_table_id}`
    WHERE year = {year}
    AND EXTRACT(MONTH FROM game_date) = {month}
    """
    client.query(delete_query).result()
    
    # Upload
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
    return result['count'].iloc[0]

def collect_month_parallel(year, month, max_workers=10):
    """Collect entire month using parallel daily requests"""
    # Generate date range
    if month == 3:
        start = datetime(year, 3, 20)
    else:
        start = datetime(year, month, 1)
    
    if month == 10:
        end = datetime(year, 10, 31)
    else:
        next_month = datetime(year, month, 1) + timedelta(days=32)
        end = next_month.replace(day=1) - timedelta(days=1)
    
    dates = []
    current = start
    while current <= end:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    
    thread_print(f"\n{'='*60}")
    thread_print(f"📅 {year}-{month:02d} ({start.date()} to {end.date()})")
    thread_print(f"  📦 {len(dates)} days, using {max_workers} threads")
    thread_print(f"{'='*60}")
    
    all_data = []
    total_pitches = 0
    errors = []
    
    # Parallel collection
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(collect_day, date): date for date in dates}
        
        completed = 0
        for future in as_completed(futures):
            date_str, df, error = future.result()
            completed += 1
            
            if error:
                errors.append(f"{date_str}: {error}")
                thread_print(f"  ❌ {date_str}: {error}")
            elif df is not None:
                pitches = len(df)
                total_pitches += pitches
                all_data.append(df)
                if pitches > 20000:
                    thread_print(f"  ⚠️  {date_str}: {pitches:,} pitches (high volume day)")
                elif pitches > 5000:
                    thread_print(f"  ✓ {date_str}: {pitches:,} pitches")
            
            if completed % 10 == 0:
                thread_print(f"  📊 Progress: {completed}/{len(dates)} days ({total_pitches:,} pitches so far)")
    
    # Combine and upload
    if all_data:
        combined = pd.concat(all_data, ignore_index=True)
        games = combined['game_pk'].nunique()
        thread_print(f"  📊 Total: {len(combined):,} pitches, {games} games")
        thread_print(f"  📤 Uploading to BigQuery...")
        
        uploaded = upload_month_data(combined, year, month)
        thread_print(f"  ✅ SUCCESS: {uploaded:,} pitches verified for {year}-{month:02d}\n")
        return uploaded
    else:
        thread_print(f"  ⚠️  No data for {year}-{month:02d}\n")
        return 0

def main():
    thread_print("="*60)
    thread_print("PARALLEL STATCAST COLLECTOR - Daily Resolution")
    thread_print("="*60)
    
    # Define what to collect
    months_to_collect = [3, 4, 5, 6, 7, 8, 9, 10]
    years_to_collect = range(2015, 2025)
    
    total_collected = 0
    successful = 0
    failed = []
    
    start_time = time.time()
    
    for year in years_to_collect:
        thread_print(f"\n{'#'*60}")
        thread_print(f"# YEAR {year}")
        thread_print(f"{'#'*60}")
        
        for month in months_to_collect:
            try:
                count = collect_month_parallel(year, month, max_workers=10)
                total_collected += count
                
                if count > 0:
                    successful += 1
                else:
                    failed.append(f"{year}-{month:02d}")
                
                time.sleep(2)  # Brief pause between months
                
            except KeyboardInterrupt:
                thread_print("\n⚠️  Interrupted")
                break
            except Exception as e:
                thread_print(f"  ❌ Error: {str(e)[:100]}")
                failed.append(f"{year}-{month:02d}")
    
    # Summary
    elapsed = time.time() - start_time
    thread_print(f"\n{'='*60}")
    thread_print("COLLECTION COMPLETE")
    thread_print(f"{'='*60}")
    thread_print(f"✅ Collected: {total_collected:,} pitches")
    thread_print(f"✅ Successful: {successful} months")
    thread_print(f"⏱️  Time: {elapsed/60:.1f} minutes")
    
    if failed:
        thread_print(f"\n❌ Failed: {', '.join(failed)}")
    
    # Final summary
    thread_print("\n📊 Final Data Summary:")
    summary = client.query(f"""
    SELECT year, COUNT(*) as pitches, COUNT(DISTINCT game_pk) as games
    FROM `{full_table_id}`
    GROUP BY year
    ORDER BY year
    """).to_dataframe()
    thread_print(summary.to_string(index=False))

if __name__ == "__main__":
    main()
