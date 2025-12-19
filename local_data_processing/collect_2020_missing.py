#!/usr/bin/env python3
"""
Collector for 2020 missing months (March-June)
Note: 2020 season was COVID-shortened and started in July, so these months may have no data
"""

import requests
import pandas as pd
from datetime import datetime
import time
from google.cloud import bigquery
import urllib3
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Thread-safe printing
print_lock = threading.Lock()

def thread_print(*args, **kwargs):
    """Thread-safe print function"""
    with print_lock:
        print(*args, **kwargs)

def fetch_statcast_day(date_str):
    """Fetch statcast data for a single day from Baseball Savant"""
    url = "https://baseballsavant.mlb.com/statcast_search/csv"
    params = {
        'all': 'true',
        'hfPT': '',
        'hfAB': '',
        'hfGT': 'R|',
        'hfPR': '',
        'hfZ': '',
        'stadium': '',
        'hfBBL': '',
        'hfNewZones': '',
        'hfPull': '',
        'hfC': '',
        'hfSea': '2020|',
        'hfSit': '',
        'player_type': 'pitcher',
        'hfOuts': '',
        'opponent': '',
        'pitcher_throws': '',
        'batter_stands': '',
        'hfSA': '',
        'game_date_gt': date_str,
        'game_date_lt': date_str,
        'hfMo': '',
        'team': '',
        'home_road': '',
        'hfRO': '',
        'position': '',
        'hfInfield': '',
        'hfOutfield': '',
        'hfInn': '',
        'hfBBT': '',
        'hfFlag': '',
        'metric_1': '',
        'group_by': 'name',
        'min_pitches': '0',
        'min_results': '0',
        'min_pas': '0',
        'sort_col': 'pitches',
        'player_event_sort': 'api_p_release_speed',
        'sort_order': 'desc',
        'chk_stats_pa': 'on',
        'chk_stats_abs': 'on',
        'chk_stats_bip': 'on',
        'chk_stats_hits': 'on',
        'chk_stats_singles': 'on',
        'chk_stats_dbls': 'on',
        'chk_stats_triples': 'on',
        'chk_stats_hrs': 'on',
        'chk_stats_so': 'on',
        'chk_stats_bb': 'on',
        'type': 'details'
    }
    
    try:
        response = requests.get(url, params=params, verify=False, timeout=30)
        response.raise_for_status()
        
        if len(response.content) > 100:
            df = pd.read_csv(pd.io.common.StringIO(response.text))
            return df
        return None
    except Exception as e:
        thread_print(f"  ❌ Error fetching {date_str}: {e}")
        return None

def collect_day(date_str, max_retries=2):
    """Collect data for a single day with retry logic"""
    for attempt in range(max_retries + 1):
        df = fetch_statcast_day(date_str)
        if df is not None and len(df) > 0:
            return df
        if attempt < max_retries:
            time.sleep(2)
    return None

def upload_month_data(df, year, month):
    """Upload combined month data to BigQuery"""
    if df is None or len(df) == 0:
        return 0
    
    # Convert game_date to proper format if needed
    if 'game_date' in df.columns:
        df['game_date'] = pd.to_datetime(df['game_date']).dt.date
    
    # Add metadata
    df['year'] = year
    df['month'] = month
    df['data_load_timestamp'] = datetime.now()
    
    # Upload to BigQuery
    client = bigquery.Client(project='hankstank')
    table_id = 'hankstank.mlb_historical_data.statcast_pitches'
    
    job_config = bigquery.LoadJobConfig(
        write_disposition="WRITE_APPEND",
        schema_update_options=[bigquery.SchemaUpdateOption.ALLOW_FIELD_ADDITION]
    )
    
    job = client.load_table_from_dataframe(df, table_id, job_config=job_config)
    job.result()
    
    # Verify upload
    query = f"""
    SELECT COUNT(*) as cnt 
    FROM `{table_id}` 
    WHERE year = {year} AND month = {month}
    """
    result = list(client.query(query).result())
    return result[0].cnt

def collect_month_parallel(year, month, max_workers=10):
    """Collect data for a month using parallel day-by-day collection"""
    # Determine date range
    if month == 3:
        start_day = 20
    else:
        start_day = 1
    
    # Get last day of month
    if month in [4, 6]:
        end_day = 30
    else:
        end_day = 31
    
    # Generate list of dates
    dates = []
    for day in range(start_day, end_day + 1):
        date_str = f"{year}-{month:02d}-{day:02d}"
        dates.append(date_str)
    
    thread_print("="*60)
    thread_print(f"📅 {year}-{month:02d} ({dates[0]} to {dates[-1]})")
    thread_print(f"  📦 {len(dates)} days, using {max_workers} threads")
    thread_print("="*60)
    
    # Collect data in parallel
    all_data = []
    total_games = 0
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_date = {executor.submit(collect_day, date): date for date in dates}
        
        completed = 0
        for future in as_completed(future_to_date):
            date = future_to_date[future]
            try:
                df = future.result()
                if df is not None and len(df) > 0:
                    all_data.append(df)
                    games = df['game_pk'].nunique() if 'game_pk' in df.columns else 0
                    total_games += games
                    thread_print(f"  ✓ {date}: {len(df):,} pitches, {games} games")
                
                completed += 1
                    
            except Exception as e:
                thread_print(f"  ❌ Error processing {date}: {e}")
    
    # Combine all data
    if all_data:
        combined = pd.concat(all_data, ignore_index=True)
        thread_print(f"  📊 Total: {len(combined):,} pitches, {total_games} games")
        
        # Upload to BigQuery
        thread_print(f"  📤 Uploading to BigQuery...")
        uploaded = upload_month_data(combined, year, month)
        thread_print(f"  ✅ SUCCESS: {uploaded:,} pitches verified for {year}-{month:02d}\n")
        return uploaded
    else:
        thread_print(f"  ℹ️  No data for {year}-{month:02d} (expected - COVID delayed season)\n")
        return 0

def main():
    thread_print("="*60)
    thread_print("2020 MISSING MONTHS COLLECTOR")
    thread_print("Note: Season started in July 2020 due to COVID")
    thread_print("="*60)
    
    # Try to collect the "failed" months
    year = 2020
    months_to_try = [3, 4, 5, 6]
    
    total_collected = 0
    
    for month in months_to_try:
        try:
            collected = collect_month_parallel(year, month, max_workers=10)
            total_collected += collected
        except Exception as e:
            thread_print(f"❌ Error collecting {year}-{month:02d}: {e}")
    
    thread_print("\n" + "="*60)
    thread_print("2020 COLLECTION SUMMARY")
    thread_print("="*60)
    thread_print(f"✅ Total pitches collected: {total_collected:,}")
    if total_collected == 0:
        thread_print("ℹ️  No data found (expected - 2020 season started in July)")
    thread_print("="*60)

if __name__ == "__main__":
    main()
