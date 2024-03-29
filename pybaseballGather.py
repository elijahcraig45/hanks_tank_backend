import sys
import os
import pandas as pd
from pybaseball import batting_stats, pitching_stats, standings, team_batting, team_pitching, statcast

def save_to_csv(df, year, filename):
    """Save DataFrame to CSV if not empty."""
    folder_path = f"./data/{year}/"
    if not df.empty:
        # Ensure the directory exists
        os.makedirs(folder_path, exist_ok=True)
        file_path = os.path.join(folder_path, filename)
        df.to_csv(file_path, index=False)
        print(f"{filename} added")
    else:
        print(f"No data to add for {filename}")

def fetch_and_store_mlb_data(year):
    """Fetch MLB data for a given year and store it locally."""
    print(f"Fetching MLB data for the year {year}")

    # Player Batting
    playerBattingdf = batting_stats(year)
    save_to_csv(playerBattingdf, year, f"playerBatting_{year}.csv")

    # Player Pitching
    playerPitchingdf = pitching_stats(year)
    save_to_csv(playerPitchingdf, year, f"playerPitching_{year}.csv")

    # Team Batting
    teamBattingdf = team_batting(year)
    save_to_csv(teamBattingdf, year, f"teamBatting_{year}.csv")

    # Team Pitching
    teamPitchingdf = team_pitching(year)
    save_to_csv(teamPitchingdf, year, f"teamPitching_{year}.csv")

    # Standings
    standingsdf = pd.concat(standings(year), ignore_index=True)
    save_to_csv(standingsdf, year, f"standings_{year}.csv")

    # Statcast
    statcastdf = statcast(start_dt=f"{year}-03-01", end_dt=f"{year}-12-01")
    save_to_csv(statcastdf, year, f"statcast_{year}.csv")

    print("All MLB data fetched and stored locally.")

if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        fetch_and_store_mlb_data(2024)
    else:
        year = int(sys.argv[1])
        fetch_and_store_mlb_data(year)