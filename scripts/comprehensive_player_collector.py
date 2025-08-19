#!/usr/bin/env python3
"""
Comprehensive Player Data Collector for 2021-2024
Fills in missing player data for recent years
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from historical_data_collector import MLBHistoricalDataCollector
import pandas as pd

class PlayerDataCollector(MLBHistoricalDataCollector):
    def __init__(self, project_id: str = "hankstank", dataset_id: str = "mlb_historical_data"):
        super().__init__(project_id, dataset_id)
        self.recent_years = [2021, 2022, 2023, 2024]
        
    def get_comprehensive_player_stats(self, year: int) -> List[Dict]:
        """Get ALL player statistics for a given year (not just top players)"""
        print(f"Fetching comprehensive player stats for {year}...")
        
        all_player_stats = []
        
        # Get all teams first to iterate through team rosters
        teams = self.get_teams(year)
        
        for team in teams:
            team_id = team['team_id']
            print(f"  Fetching player stats for {team['team_name']}...")
            
            try:
                # Get batting stats for this team
                batting_url = f"{self.base_url}/teams/{team_id}/stats?stats=season&season={year}&group=hitting&gameType=R"
                batting_data = self.fetch_with_retry(batting_url)
                
                for stat in batting_data.get('stats', []):
                    for split in stat.get('splits', []):
                        player = split.get('player', {})
                        stats = split.get('stat', {})
                        
                        if player.get('id'):  # Only if we have a valid player ID
                            player_record = {
                                'year': year,
                                'player_id': player.get('id'),
                                'player_name': player.get('fullName', ''),
                                'first_name': player.get('firstName', ''),
                                'last_name': player.get('lastName', ''),
                                'team_id': team_id,
                                'team_name': team['team_name'],
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
                
                # Small delay between batting and pitching requests
                time.sleep(1)
                
                # Get pitching stats for this team
                pitching_url = f"{self.base_url}/teams/{team_id}/stats?stats=season&season={year}&group=pitching&gameType=R"
                pitching_data = self.fetch_with_retry(pitching_url)
                
                for stat in pitching_data.get('stats', []):
                    for split in stat.get('splits', []):
                        player = split.get('player', {})
                        stats = split.get('stat', {})
                        
                        if player.get('id'):  # Only if we have a valid player ID
                            player_record = {
                                'year': year,
                                'player_id': player.get('id'),
                                'player_name': player.get('fullName', ''),
                                'first_name': player.get('firstName', ''),
                                'last_name': player.get('lastName', ''),
                                'team_id': team_id,
                                'team_name': team['team_name'],
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
                
                time.sleep(1)  # Rate limiting between teams
                
            except Exception as e:
                print(f"    Error fetching stats for team {team_id}: {e}")
                continue
        
        return all_player_stats
        
    def collect_recent_player_data(self):
        """Collect comprehensive player data for 2021-2024"""
        print("=== Collecting comprehensive player data (2021-2024) ===")
        
        all_player_stats = []
        all_rosters = []
        
        for year in self.recent_years:
            print(f"\n=== Collecting player data for {year} ===")
            
            # Get comprehensive player stats
            player_stats = self.get_comprehensive_player_stats(year)
            all_player_stats.extend(player_stats)
            
            # Get team rosters
            rosters = self.get_team_rosters(year)
            all_rosters.extend(rosters)
            
            print(f"Year {year} complete: {len(player_stats)} player stats, {len(rosters)} roster entries")
        
        # Load existing incomplete player data and merge
        try:
            existing_player_stats = pd.read_csv("data/players/player_stats_2015_2024.csv")
            existing_rosters = pd.read_csv("data/rosters/rosters_2015_2024.csv")
            
            # Filter out 2021-2024 from existing data and add new comprehensive data
            existing_filtered = existing_player_stats[existing_player_stats['year'] < 2021]
            existing_rosters_filtered = existing_rosters[existing_rosters['year'] < 2021]
            
            new_player_stats_df = pd.DataFrame(all_player_stats)
            new_rosters_df = pd.DataFrame(all_rosters)
            
            # Combine datasets
            combined_player_stats = pd.concat([existing_filtered, new_player_stats_df], ignore_index=True)
            combined_rosters = pd.concat([existing_rosters_filtered, new_rosters_df], ignore_index=True)
            
            # Sort by year
            combined_player_stats = combined_player_stats.sort_values(['year', 'player_id'])
            combined_rosters = combined_rosters.sort_values(['year', 'team_id', 'player_id'])
            
            # Save updated data
            combined_player_stats.to_csv("data/players/player_stats_2015_2024.csv", index=False)
            combined_rosters.to_csv("data/rosters/rosters_2015_2024.csv", index=False)
            
            print(f"Updated datasets saved:")
            print(f"  Player Stats: {len(combined_player_stats)} records")
            print(f"  Rosters: {len(combined_rosters)} records")
            
        except FileNotFoundError:
            print("Existing files not found, saving new data...")
            self.save_to_csv(all_player_stats, "data/players/player_stats_2015_2024.csv")
            self.save_to_csv(all_rosters, "data/rosters/rosters_2015_2024.csv")
        
        # Upload to BigQuery
        print("\n=== Uploading updated player data to BigQuery ===")
        try:
            self.upload_to_bigquery("data/players/player_stats_2015_2024.csv", "player_stats_historical")
            self.upload_to_bigquery("data/rosters/rosters_2015_2024.csv", "rosters_historical")
            
            print("\n=== Comprehensive player data collection complete! ===")
            
        except Exception as e:
            print(f"Error uploading to BigQuery: {e}")
            print("CSV files have been saved locally for manual upload if needed.")

def main():
    from typing import Dict, List
    collector = PlayerDataCollector()
    collector.collect_recent_player_data()
    collector.verify_data_completeness()

if __name__ == "__main__":
    main()
