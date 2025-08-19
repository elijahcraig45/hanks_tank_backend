#!/usr/bin/env python3
"""
Historical MLB Data Collector - Incremental Update (2015-2020)
Extends existing data collection to include 2015-2020 and adds player data
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from historical_data_collector import MLBHistoricalDataCollector
import pandas as pd

class MLBIncrementalCollector(MLBHistoricalDataCollector):
    def __init__(self, project_id: str = "hankstank", dataset_id: str = "mlb_historical_data"):
        super().__init__(project_id, dataset_id)
        # Only collect the missing years
        self.new_years = [2015, 2016, 2017, 2018, 2019, 2020]
        
    def collect_incremental_data(self):
        """Collect data for new years and merge with existing data"""
        print("=== Collecting incremental data (2015-2020) ===")
        
        # Collect new data
        all_teams = []
        all_team_stats = []
        all_standings = []
        all_games = []
        all_player_stats = []
        all_rosters = []
        
        for year in self.new_years:
            print(f"\n=== Collecting data for {year} ===")
            
            # Collect teams
            teams = self.get_teams(year)
            all_teams.extend(teams)
            
            # Collect team stats
            team_stats = self.get_team_stats(year)
            all_team_stats.extend(team_stats)
            
            # Collect standings
            standings = self.get_standings(year)
            all_standings.extend(standings)
            
            # Collect games (reduced scope for older years)
            games = self.get_schedule_games(year, f"{year}-04-01", f"{year}-10-31")
            all_games.extend(games)
            
            # Collect player stats
            player_stats = self.get_player_stats(year)
            all_player_stats.extend(player_stats)
            
            # Collect rosters
            rosters = self.get_team_rosters(year)
            all_rosters.extend(rosters)
            
            print(f"Year {year} complete: {len(teams)} teams, {len(team_stats)} team stats, {len(standings)} standings, {len(games)} games, {len(player_stats)} player stats, {len(rosters)} roster entries")
        
        # Load existing data and merge
        print("\n=== Merging with existing data ===")
        
        try:
            # Load existing data
            existing_teams = pd.read_csv("data/teams/teams_2021_2024.csv")
            existing_team_stats = pd.read_csv("data/teams/team_stats_2021_2024.csv")
            existing_standings = pd.read_csv("data/standings/standings_2021_2024.csv")
            existing_games = pd.read_csv("data/games/games_2021_2024.csv")
            
            # Merge new data with existing
            new_teams_df = pd.DataFrame(all_teams)
            new_team_stats_df = pd.DataFrame(all_team_stats)
            new_standings_df = pd.DataFrame(all_standings)
            new_games_df = pd.DataFrame(all_games)
            new_player_stats_df = pd.DataFrame(all_player_stats)
            new_rosters_df = pd.DataFrame(all_rosters)
            
            # Combine datasets
            combined_teams = pd.concat([new_teams_df, existing_teams], ignore_index=True)
            combined_team_stats = pd.concat([new_team_stats_df, existing_team_stats], ignore_index=True)
            combined_standings = pd.concat([new_standings_df, existing_standings], ignore_index=True)
            combined_games = pd.concat([new_games_df, existing_games], ignore_index=True)
            
            # Sort by year
            combined_teams = combined_teams.sort_values('year')
            combined_team_stats = combined_team_stats.sort_values('year')
            combined_standings = combined_standings.sort_values('year')
            combined_games = combined_games.sort_values('year')
            new_player_stats_df = new_player_stats_df.sort_values('year')
            new_rosters_df = new_rosters_df.sort_values('year')
            
            # Save combined data
            combined_teams.to_csv("data/teams/teams_2015_2024.csv", index=False)
            combined_team_stats.to_csv("data/teams/team_stats_2015_2024.csv", index=False)
            combined_standings.to_csv("data/standings/standings_2015_2024.csv", index=False)
            combined_games.to_csv("data/games/games_2015_2024.csv", index=False)
            new_player_stats_df.to_csv("data/players/player_stats_2015_2024.csv", index=False)
            new_rosters_df.to_csv("data/rosters/rosters_2015_2024.csv", index=False)
            
            print(f"Combined datasets saved:")
            print(f"  Teams: {len(combined_teams)} records")
            print(f"  Team Stats: {len(combined_team_stats)} records")
            print(f"  Standings: {len(combined_standings)} records")
            print(f"  Games: {len(combined_games)} records")
            print(f"  Player Stats: {len(new_player_stats_df)} records")
            print(f"  Rosters: {len(new_rosters_df)} records")
            
        except FileNotFoundError:
            print("Existing data files not found, saving new data only...")
            self.save_to_csv(all_teams, "data/teams/teams_2015_2024.csv")
            self.save_to_csv(all_team_stats, "data/teams/team_stats_2015_2024.csv")
            self.save_to_csv(all_standings, "data/standings/standings_2015_2024.csv")
            self.save_to_csv(all_games, "data/games/games_2015_2024.csv")
            self.save_to_csv(all_player_stats, "data/players/player_stats_2015_2024.csv")
            self.save_to_csv(all_rosters, "data/rosters/rosters_2015_2024.csv")
        
        # Upload to BigQuery (replace existing tables)
        print("\n=== Uploading to BigQuery ===")
        try:
            self.upload_to_bigquery("data/teams/teams_2015_2024.csv", "teams_historical")
            self.upload_to_bigquery("data/teams/team_stats_2015_2024.csv", "team_stats_historical")
            self.upload_to_bigquery("data/standings/standings_2015_2024.csv", "standings_historical")
            self.upload_to_bigquery("data/games/games_2015_2024.csv", "games_historical")
            self.upload_to_bigquery("data/players/player_stats_2015_2024.csv", "player_stats_historical")
            self.upload_to_bigquery("data/rosters/rosters_2015_2024.csv", "rosters_historical")
            
            print("\n=== Incremental data collection and upload complete! ===")
            
        except Exception as e:
            print(f"Error uploading to BigQuery: {e}")
            print("CSV files have been saved locally for manual upload if needed.")

def main():
    collector = MLBIncrementalCollector()
    collector.collect_incremental_data()
    collector.verify_data_completeness()

if __name__ == "__main__":
    main()
