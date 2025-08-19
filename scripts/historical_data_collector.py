#!/usr/bin/env python3
"""
Historical MLB Data Collector for BigQuery
Fetches comprehensive MLB data for years 2021-2024 using MLB StatsAPI
"""

import requests
import pandas as pd
import json
from datetime import datetime, timedelta
import time
import os
from typing import Dict, List, Any
import argparse
from google.cloud import bigquery
from google.cloud.exceptions import NotFound

class MLBHistoricalDataCollector:
    def __init__(self, project_id: str = "hankstank", dataset_id: str = "mlb_historical_data"):
        self.base_url = "https://statsapi.mlb.com/api/v1"
        self.project_id = project_id
        self.dataset_id = dataset_id
        self.client = bigquery.Client(project=project_id)
        self.years = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]
        
        # Create output directories
        os.makedirs("data/teams", exist_ok=True)
        os.makedirs("data/players", exist_ok=True)
        os.makedirs("data/games", exist_ok=True)
        os.makedirs("data/standings", exist_ok=True)
        os.makedirs("data/rosters", exist_ok=True)
        
    def fetch_with_retry(self, url: str, max_retries: int = 3) -> Dict[Any, Any]:
        """Fetch data with retry logic"""
        for attempt in range(max_retries):
            try:
                response = requests.get(url, timeout=30)
                response.raise_for_status()
                return response.json()
            except Exception as e:
                print(f"Attempt {attempt + 1} failed for {url}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff
                else:
                    raise
    
    def get_teams(self, year: int) -> List[Dict]:
        """Fetch all MLB teams for a given year"""
        print(f"Fetching teams for {year}...")
        url = f"{self.base_url}/teams?season={year}&sportId=1"
        data = self.fetch_with_retry(url)
        
        teams = []
        for team in data.get('teams', []):
            teams.append({
                'year': year,
                'team_id': team['id'],
                'team_name': team['name'],
                'team_code': team['abbreviation'],
                'location_name': team['locationName'],
                'team_name_full': team['teamName'],
                'league_id': team['league']['id'],
                'league_name': team['league']['name'],
                'division_id': team['division']['id'],
                'division_name': team['division']['name'],
                'venue_id': team.get('venue', {}).get('id'),
                'venue_name': team.get('venue', {}).get('name'),
                'first_year_of_play': team.get('firstYearOfPlay'),
                'active': team.get('active', True)
            })
        
        return teams
    
    def get_team_stats(self, year: int) -> List[Dict]:
        """Fetch team statistics for a given year"""
        print(f"Fetching team stats for {year}...")
        
        # Get batting stats
        batting_url = f"{self.base_url}/teams/stats?season={year}&sportId=1&stats=season&group=hitting"
        batting_data = self.fetch_with_retry(batting_url)
        
        # Get pitching stats  
        pitching_url = f"{self.base_url}/teams/stats?season={year}&sportId=1&stats=season&group=pitching"
        pitching_data = self.fetch_with_retry(pitching_url)
        
        team_stats = []
        
        # Process batting stats
        for team_stat in batting_data.get('stats', [{}])[0].get('splits', []):
            team = team_stat['team']
            stats = team_stat['stat']
            
            batting_record = {
                'year': year,
                'team_id': team['id'],
                'team_name': team['name'],
                'stat_type': 'batting',
                'games_played': stats.get('gamesPlayed', 0),
                'at_bats': stats.get('atBats', 0),
                'runs': stats.get('runs', 0),
                'hits': stats.get('hits', 0),
                'doubles': stats.get('doubles', 0),
                'triples': stats.get('triples', 0),
                'home_runs': stats.get('homeRuns', 0),
                'rbi': stats.get('rbi', 0),
                'stolen_bases': stats.get('stolenBases', 0),
                'caught_stealing': stats.get('caughtStealing', 0),
                'walks': stats.get('baseOnBalls', 0),
                'strikeouts': stats.get('strikeOuts', 0),
                'batting_avg': float(stats.get('avg', 0)),
                'obp': float(stats.get('obp', 0)),
                'slg': float(stats.get('slg', 0)),
                'ops': float(stats.get('ops', 0)),
                'total_bases': stats.get('totalBases', 0),
                'hit_by_pitch': stats.get('hitByPitch', 0),
                'sac_flies': stats.get('sacFlies', 0),
                'sac_bunts': stats.get('sacBunts', 0),
                'left_on_base': stats.get('leftOnBase', 0)
            }
            team_stats.append(batting_record)
        
        # Process pitching stats
        for team_stat in pitching_data.get('stats', [{}])[0].get('splits', []):
            team = team_stat['team']
            stats = team_stat['stat']
            
            pitching_record = {
                'year': year,
                'team_id': team['id'],
                'team_name': team['name'],
                'stat_type': 'pitching',
                'games_played': stats.get('gamesPlayed', 0),
                'wins': stats.get('wins', 0),
                'losses': stats.get('losses', 0),
                'win_percentage': float(stats.get('winPercentage', 0)),
                'era': float(stats.get('era', 0)),
                'games_started': stats.get('gamesStarted', 0),
                'games_finished': stats.get('gamesFinished', 0),
                'complete_games': stats.get('completeGames', 0),
                'shutouts': stats.get('shutouts', 0),
                'saves': stats.get('saves', 0),
                'save_opportunities': stats.get('saveOpportunities', 0),
                'holds': stats.get('holds', 0),
                'blown_saves': stats.get('blownSaves', 0),
                'innings_pitched': float(stats.get('inningsPitched', 0)),
                'hits_allowed': stats.get('hits', 0),
                'runs_allowed': stats.get('runs', 0),
                'earned_runs': stats.get('earnedRuns', 0),
                'home_runs_allowed': stats.get('homeRuns', 0),
                'walks_allowed': stats.get('baseOnBalls', 0),
                'strikeouts': stats.get('strikeOuts', 0),
                'whip': float(stats.get('whip', 0)),
                'batters_faced': stats.get('battersFaced', 0),
                'wild_pitches': stats.get('wildPitches', 0),
                'hit_batsmen': stats.get('hitBatsmen', 0),
                'balks': stats.get('balks', 0)
            }
            team_stats.append(pitching_record)
        
        return team_stats
    
    def get_standings(self, year: int) -> List[Dict]:
        """Fetch standings for a given year"""
        print(f"Fetching standings for {year}...")
        url = f"{self.base_url}/standings?leagueId=103,104&season={year}"
        data = self.fetch_with_retry(url)
        
        standings = []
        for record in data.get('records', []):
            division_id = record.get('division', {}).get('id')
            division_name = record.get('division', {}).get('name', 'Unknown Division')
            league_id = record.get('league', {}).get('id')
            league_name = record.get('league', {}).get('name', 'Unknown League')
            
            for team_record in record['teamRecords']:
                team = team_record['team']
                standings.append({
                    'year': year,
                    'team_id': team['id'],
                    'team_name': team['name'],
                    'division_id': division_id,
                    'division_name': division_name,
                    'league_id': league_id,
                    'league_name': league_name,
                    'wins': team_record.get('wins', 0),
                    'losses': team_record.get('losses', 0),
                    'pct': float(team_record.get('winningPercentage', 0)),
                    'games_back': str(team_record.get('gamesBack', '0')),
                    'wild_card_games_back': str(team_record.get('wildCardGamesBack', '0')),
                    'division_rank': team_record.get('divisionRank', 0),
                    'league_rank': team_record.get('leagueRank', 0),
                    'sport_rank': team_record.get('sportRank', 0),
                    'runs_scored': team_record.get('runsScored', 0),
                    'runs_allowed': team_record.get('runsAllowed', 0),
                    'run_differential': team_record.get('runDifferential', 0),
                    'streak_type': team_record.get('streak', {}).get('streakType', ''),
                    'streak_number': team_record.get('streak', {}).get('streakNumber', 0),
                    'streak_code': team_record.get('streak', {}).get('streakCode', ''),
                    'last_updated': team_record.get('lastUpdated', '')
                })
        
        return standings
    
    def get_schedule_games(self, year: int, start_date: str = None, end_date: str = None) -> List[Dict]:
        """Fetch games for a given year or date range"""
        if not start_date:
            start_date = f"{year}-03-01"
        if not end_date:
            end_date = f"{year}-11-30"
            
        print(f"Fetching games for {year} ({start_date} to {end_date})...")
        
        url = f"{self.base_url}/schedule?sportId=1&startDate={start_date}&endDate={end_date}&hydrate=team,linescore,boxscore"
        data = self.fetch_with_retry(url)
        
        games = []
        for date_info in data.get('dates', []):
            game_date = date_info['date']
            
            for game in date_info.get('games', []):
                game_info = {
                    'year': year,
                    'game_pk': game['gamePk'],
                    'game_date': game_date,
                    'game_datetime': game.get('gameDate', ''),
                    'status_code': game['status']['statusCode'],
                    'status_description': game['status']['detailedState'],
                    'home_team_id': game['teams']['home']['team']['id'],
                    'home_team_name': game['teams']['home']['team']['name'],
                    'away_team_id': game['teams']['away']['team']['id'],
                    'away_team_name': game['teams']['away']['team']['name'],
                    'venue_id': game.get('venue', {}).get('id'),
                    'venue_name': game.get('venue', {}).get('name'),
                    'game_type': game['gameType'],
                    'season': game['season'],
                    'season_display': game['seasonDisplay']
                }
                
                # Add scores if game is final
                if game['status']['statusCode'] == 'F':
                    game_info.update({
                        'home_score': game['teams']['home'].get('score', 0),
                        'away_score': game['teams']['away'].get('score', 0),
                        'winning_team_id': game['teams']['home']['team']['id'] if game['teams']['home'].get('score', 0) > game['teams']['away'].get('score', 0) else game['teams']['away']['team']['id'],
                        'losing_team_id': game['teams']['away']['team']['id'] if game['teams']['home'].get('score', 0) > game['teams']['away'].get('score', 0) else game['teams']['home']['team']['id']
                    })
                else:
                    game_info.update({
                        'home_score': None,
                        'away_score': None,
                        'winning_team_id': None,
                        'losing_team_id': None
                    })
                
                games.append(game_info)
        
        return games
    
    def get_player_stats(self, year: int) -> List[Dict]:
        """Fetch player statistics for a given year"""
        print(f"Fetching player stats for {year}...")
        
        all_player_stats = []
        
        # Get batting stats
        batting_url = f"{self.base_url}/stats?stats=season&season={year}&sportId=1&group=hitting&gameType=R"
        batting_data = self.fetch_with_retry(batting_url)
        
        for stat in batting_data.get('stats', []):
            for split in stat.get('splits', []):
                player = split.get('player', {})
                team = split.get('team', {})
                stats = split.get('stat', {})
                
                player_record = {
                    'year': year,
                    'player_id': player.get('id'),
                    'player_name': player.get('fullName', ''),
                    'first_name': player.get('firstName', ''),
                    'last_name': player.get('lastName', ''),
                    'team_id': team.get('id'),
                    'team_name': team.get('name', ''),
                    'stat_type': 'batting',
                    'position': player.get('primaryPosition', {}).get('name', ''),
                    'position_code': player.get('primaryPosition', {}).get('code', ''),
                    'games_played': stats.get('gamesPlayed', 0),
                    'plate_appearances': stats.get('plateAppearances', 0),
                    'at_bats': stats.get('atBats', 0),
                    'runs': stats.get('runs', 0),
                    'hits': stats.get('hits', 0),
                    'doubles': stats.get('doubles', 0),
                    'triples': stats.get('triples', 0),
                    'home_runs': stats.get('homeRuns', 0),
                    'rbi': stats.get('rbi', 0),
                    'stolen_bases': stats.get('stolenBases', 0),
                    'caught_stealing': stats.get('caughtStealing', 0),
                    'walks': stats.get('baseOnBalls', 0),
                    'strikeouts': stats.get('strikeOuts', 0),
                    'batting_avg': float(stats.get('avg', 0)),
                    'obp': float(stats.get('obp', 0)),
                    'slg': float(stats.get('slg', 0)),
                    'ops': float(stats.get('ops', 0)),
                    'total_bases': stats.get('totalBases', 0),
                    'hit_by_pitch': stats.get('hitByPitch', 0),
                    'sac_flies': stats.get('sacFlies', 0),
                    'sac_bunts': stats.get('sacBunts', 0),
                    'intentional_walks': stats.get('intentionalWalks', 0),
                    'left_on_base': stats.get('leftOnBase', 0),
                    'ground_outs': stats.get('groundOuts', 0),
                    'air_outs': stats.get('airOuts', 0),
                    'ground_into_double_play': stats.get('groundIntoDoublePlay', 0)
                }
                all_player_stats.append(player_record)
        
        time.sleep(2)  # Rate limiting between batting and pitching
        
        # Get pitching stats
        pitching_url = f"{self.base_url}/stats?stats=season&season={year}&sportId=1&group=pitching&gameType=R"
        pitching_data = self.fetch_with_retry(pitching_url)
        
        for stat in pitching_data.get('stats', []):
            for split in stat.get('splits', []):
                player = split.get('player', {})
                team = split.get('team', {})
                stats = split.get('stat', {})
                
                player_record = {
                    'year': year,
                    'player_id': player.get('id'),
                    'player_name': player.get('fullName', ''),
                    'first_name': player.get('firstName', ''),
                    'last_name': player.get('lastName', ''),
                    'team_id': team.get('id'),
                    'team_name': team.get('name', ''),
                    'stat_type': 'pitching',
                    'position': player.get('primaryPosition', {}).get('name', ''),
                    'position_code': player.get('primaryPosition', {}).get('code', ''),
                    'games_played': stats.get('gamesPlayed', 0),
                    'games_started': stats.get('gamesStarted', 0),
                    'wins': stats.get('wins', 0),
                    'losses': stats.get('losses', 0),
                    'win_percentage': float(stats.get('winPercentage', 0)),
                    'era': float(stats.get('era', 0)),
                    'complete_games': stats.get('completeGames', 0),
                    'shutouts': stats.get('shutouts', 0),
                    'saves': stats.get('saves', 0),
                    'save_opportunities': stats.get('saveOpportunities', 0),
                    'holds': stats.get('holds', 0),
                    'blown_saves': stats.get('blownSaves', 0),
                    'innings_pitched': float(stats.get('inningsPitched', 0)),
                    'hits_allowed': stats.get('hits', 0),
                    'runs_allowed': stats.get('runs', 0),
                    'earned_runs': stats.get('earnedRuns', 0),
                    'home_runs_allowed': stats.get('homeRuns', 0),
                    'walks_allowed': stats.get('baseOnBalls', 0),
                    'strikeouts': stats.get('strikeOuts', 0),
                    'whip': float(stats.get('whip', 0)),
                    'batters_faced': stats.get('battersFaced', 0),
                    'wild_pitches': stats.get('wildPitches', 0),
                    'hit_batsmen': stats.get('hitBatsmen', 0),
                    'balks': stats.get('balks', 0),
                    'games_finished': stats.get('gamesFinished', 0),
                    'quality_starts': stats.get('qualityStarts', 0),
                    'strike_percentage': float(stats.get('strikePercentage', 0)),
                    'strikeouts_per_nine': float(stats.get('strikeoutsPer9Inn', 0)),
                    'walks_per_nine': float(stats.get('baseOnBallsPer9Inn', 0)),
                    'hits_per_nine': float(stats.get('hitsPer9Inn', 0))
                }
                all_player_stats.append(player_record)
        
        return all_player_stats
    
    def get_team_rosters(self, year: int) -> List[Dict]:
        """Fetch team rosters for a given year"""
        print(f"Fetching team rosters for {year}...")
        
        all_roster_data = []
        
        # Get all teams first
        teams = self.get_teams(year)
        
        for team in teams:
            team_id = team['team_id']
            print(f"  Fetching roster for {team['team_name']}...")
            
            try:
                # Get roster for the team
                roster_url = f"{self.base_url}/teams/{team_id}/roster?season={year}"
                roster_data = self.fetch_with_retry(roster_url)
                
                for player in roster_data.get('roster', []):
                    person = player.get('person', {})
                    position = player.get('position', {})
                    status = player.get('status', {})
                    
                    roster_record = {
                        'year': year,
                        'team_id': team_id,
                        'team_name': team['team_name'],
                        'player_id': person.get('id'),
                        'player_name': person.get('fullName', ''),
                        'first_name': person.get('firstName', ''),
                        'last_name': person.get('lastName', ''),
                        'jersey_number': player.get('jerseyNumber', ''),
                        'position_name': position.get('name', ''),
                        'position_code': position.get('code', ''),
                        'position_type': position.get('type', ''),
                        'status_code': status.get('code', ''),
                        'status_description': status.get('description', ''),
                        'birth_date': person.get('birthDate', ''),
                        'birth_city': person.get('birthCity', ''),
                        'birth_state_province': person.get('birthStateProvince', ''),
                        'birth_country': person.get('birthCountry', ''),
                        'height': person.get('height', ''),
                        'weight': person.get('weight', 0),
                        'bats': person.get('batSide', {}).get('code', ''),
                        'throws': person.get('pitchHand', {}).get('code', ''),
                        'debut_date': person.get('mlbDebutDate', ''),
                        'active': person.get('active', True)
                    }
                    all_roster_data.append(roster_record)
                
                time.sleep(0.5)  # Small delay between team roster requests
                
            except Exception as e:
                print(f"    Error fetching roster for team {team_id}: {e}")
                continue
        
        return all_roster_data
    
    def save_to_csv(self, data: List[Dict], filename: str):
        """Save data to CSV file"""
        if data:
            df = pd.DataFrame(data)
            df.to_csv(filename, index=False)
            print(f"Saved {len(data)} records to {filename}")
        else:
            print(f"No data to save for {filename}")
    
    def upload_to_bigquery(self, csv_file: str, table_name: str, schema: List = None):
        """Upload CSV data to BigQuery"""
        table_id = f"{self.project_id}.{self.dataset_id}.{table_name}"
        
        job_config = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.CSV,
            skip_leading_rows=1,
            autodetect=True if not schema else False,
            write_disposition="WRITE_TRUNCATE",
        )
        
        if schema:
            job_config.schema = schema
        
        with open(csv_file, "rb") as source_file:
            job = self.client.load_table_from_file(source_file, table_id, job_config=job_config)
        
        job.result()  # Wait for the job to complete
        
        table = self.client.get_table(table_id)
        print(f"Loaded {table.num_rows} rows into {table_id}")
    
    def collect_all_data(self):
        """Collect all historical data for all years"""
        all_teams = []
        all_team_stats = []
        all_standings = []
        all_games = []
        all_player_stats = []
        all_rosters = []
        
        for year in self.years:
            print(f"\n=== Collecting data for {year} ===")
            
            # Collect teams
            teams = self.get_teams(year)
            all_teams.extend(teams)
            time.sleep(1)  # Rate limiting
            
            # Collect team stats
            team_stats = self.get_team_stats(year)
            all_team_stats.extend(team_stats)
            time.sleep(1)
            
            # Collect standings
            standings = self.get_standings(year)
            all_standings.extend(standings)
            time.sleep(1)
            
            # Collect games (sample for large years to avoid timeout)
            if year >= 2020:  # Full games for recent years
                games = self.get_schedule_games(year)
            else:  # Sample games for older years to reduce load
                # Get games for just April-October to reduce API calls
                games = self.get_schedule_games(year, f"{year}-04-01", f"{year}-10-31")
            all_games.extend(games)
            time.sleep(2)
            
            # Collect player stats
            player_stats = self.get_player_stats(year)
            all_player_stats.extend(player_stats)
            time.sleep(3)  # Longer pause for player stats as it's heavy
            
            # Collect team rosters
            rosters = self.get_team_rosters(year)
            all_rosters.extend(rosters)
            time.sleep(2)
            
            print(f"Year {year} complete: {len(teams)} teams, {len(team_stats)} team stats, {len(standings)} standings, {len(games)} games, {len(player_stats)} player stats, {len(rosters)} roster entries")
        
        # Save all data to CSV files
        print("\n=== Saving data to CSV files ===")
        self.save_to_csv(all_teams, "data/teams/teams_2015_2024.csv")
        self.save_to_csv(all_team_stats, "data/teams/team_stats_2015_2024.csv")
        self.save_to_csv(all_standings, "data/standings/standings_2015_2024.csv")
        self.save_to_csv(all_games, "data/games/games_2015_2024.csv")
        self.save_to_csv(all_player_stats, "data/players/player_stats_2015_2024.csv")
        self.save_to_csv(all_rosters, "data/rosters/rosters_2015_2024.csv")
        
        # Upload to BigQuery
        print("\n=== Uploading to BigQuery ===")
        try:
            self.upload_to_bigquery("data/teams/teams_2015_2024.csv", "teams_historical")
            self.upload_to_bigquery("data/teams/team_stats_2015_2024.csv", "team_stats_historical")
            self.upload_to_bigquery("data/standings/standings_2015_2024.csv", "standings_historical")
            self.upload_to_bigquery("data/games/games_2015_2024.csv", "games_historical")
            self.upload_to_bigquery("data/players/player_stats_2015_2024.csv", "player_stats_historical")
            self.upload_to_bigquery("data/rosters/rosters_2015_2024.csv", "rosters_historical")
            
            print("\n=== Data collection and upload complete! ===")
            
        except Exception as e:
            print(f"Error uploading to BigQuery: {e}")
            print("CSV files have been saved locally for manual upload if needed.")
    
    def verify_data_completeness(self):
        """Verify data completeness in BigQuery"""
        print("\n=== Verifying Data Completeness ===")
        
        tables = ['teams_historical', 'team_stats_historical', 'standings_historical', 'games_historical', 'player_stats_historical', 'rosters_historical']
        
        for table in tables:
            try:
                query = f"""
                SELECT 
                    year,
                    COUNT(*) as record_count
                FROM `{self.project_id}.{self.dataset_id}.{table}`
                GROUP BY year
                ORDER BY year
                """
                
                results = self.client.query(query).result()
                print(f"\n{table.upper()}:")
                total_records = 0
                for row in results:
                    print(f"  {row.year}: {row.record_count:,} records")
                    total_records += row.record_count
                print(f"  TOTAL: {total_records:,} records")
                
            except Exception as e:
                print(f"Error verifying {table}: {e}")
        
        # Additional verification for player data
        try:
            print(f"\n=== PLAYER STATS BREAKDOWN ===")
            query = f"""
            SELECT 
                year,
                stat_type,
                COUNT(*) as player_count,
                COUNT(DISTINCT player_id) as unique_players
            FROM `{self.project_id}.{self.dataset_id}.player_stats_historical`
            GROUP BY year, stat_type
            ORDER BY year, stat_type
            """
            
            results = self.client.query(query).result()
            for row in results:
                print(f"  {row.year} {row.stat_type}: {row.player_count:,} records ({row.unique_players:,} unique players)")
                
        except Exception as e:
            print(f"Error verifying player stats breakdown: {e}")

def main():
    parser = argparse.ArgumentParser(description='Collect historical MLB data for BigQuery')
    parser.add_argument('--project-id', default='hankstank', help='GCP Project ID')
    parser.add_argument('--dataset-id', default='mlb_historical_data', help='BigQuery Dataset ID')
    parser.add_argument('--verify-only', action='store_true', help='Only verify existing data')
    
    args = parser.parse_args()
    
    collector = MLBHistoricalDataCollector(args.project_id, args.dataset_id)
    
    if args.verify_only:
        collector.verify_data_completeness()
    else:
        collector.collect_all_data()
        collector.verify_data_completeness()

if __name__ == "__main__":
    main()
