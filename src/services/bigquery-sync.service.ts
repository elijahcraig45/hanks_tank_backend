/**
 * BigQuery Sync Service
 * Manages syncing historical MLB data to BigQuery for long-term caching
 * Only syncs data for completed seasons (minHistoricalYear through previous season)
 * Current season is always fetched live from MLB API
 */

import { BigQuery } from '@google-cloud/bigquery';
import { gcpConfig } from '../config/gcp.config';
import { logger } from '../utils/logger';
import { mlbApi } from './mlb-api.service';

export interface SyncStatus {
  tableName: string;
  yearsCovered: number[];
  totalRecords: number;
  lastSyncDate?: Date;
  missingYears: number[];
  isComplete: boolean;
}

export interface SyncOptions {
  years?: number[];
  tables?: ('teams' | 'team_stats' | 'player_stats' | 'standings' | 'games' | 'rosters')[];
  forceRefresh?: boolean;
}

export interface SyncResult {
  success: boolean;
  tableName: string;
  year: number;
  recordsAdded: number;
  recordsUpdated: number;
  error?: string;
}

class BigQuerySyncService {
  private bigquery: BigQuery;
  private dataset: string;
  private projectId: string;
  private currentSeason: number;
  private minHistoricalYear: number;

  constructor() {
    const gcpOptions: any = {
      projectId: gcpConfig.projectId,
    };

    if (gcpConfig.auth.keyFilename) {
      gcpOptions.keyFilename = gcpConfig.auth.keyFilename;
    }

    this.bigquery = new BigQuery(gcpOptions);
    this.dataset = gcpConfig.bigQuery.dataset;
    this.projectId = gcpConfig.projectId;
    this.currentSeason = gcpConfig.dataSource.currentSeason;
    this.minHistoricalYear = gcpConfig.dataSource.minSeason;

    logger.info('BigQuerySyncService initialized', {
      projectId: this.projectId,
      dataset: this.dataset,
      currentSeason: this.currentSeason,
      minHistoricalYear: this.minHistoricalYear,
      historicalYearRange: `${this.minHistoricalYear}-${this.currentSeason - 1}`
    });
  }

  /**
   * Get comprehensive sync status for all tables
   */
  async getSyncStatus(): Promise<SyncStatus[]> {
    const tables = [
      'teams_historical',
      'team_stats_historical', 
      'player_stats_historical',
      'standings_historical',
      'games_historical',
      'rosters_historical'
    ];

    const statusResults: SyncStatus[] = [];

    for (const tableName of tables) {
      try {
        const status = await this.getTableSyncStatus(tableName);
        statusResults.push(status);
      } catch (error) {
        logger.error(`Error getting sync status for ${tableName}`, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        statusResults.push({
          tableName,
          yearsCovered: [],
          totalRecords: 0,
          missingYears: this.getHistoricalYears(),
          isComplete: false
        });
      }
    }

    return statusResults;
  }

  /**
   * Get sync status for a specific table
   */
  private async getTableSyncStatus(tableName: string): Promise<SyncStatus> {
    const query = `
      SELECT 
        MIN(year) as min_year,
        MAX(year) as max_year,
        COUNT(DISTINCT year) as year_count,
        COUNT(*) as total_rows,
        ARRAY_AGG(DISTINCT year ORDER BY year) as years_covered
      FROM \`${this.projectId}.${this.dataset}.${tableName}\`
    `;

    const [rows] = await this.bigquery.query({ query });
    
    if (rows.length === 0 || rows[0].total_rows === 0) {
      return {
        tableName,
        yearsCovered: [],
        totalRecords: 0,
        missingYears: this.getHistoricalYears(),
        isComplete: false
      };
    }

    const data = rows[0];
    const yearsCovered: number[] = data.years_covered || [];
    const expectedYears = this.getHistoricalYears();
    const missingYears = expectedYears.filter(year => !yearsCovered.includes(year));

    return {
      tableName,
      yearsCovered,
      totalRecords: data.total_rows,
      missingYears,
      isComplete: missingYears.length === 0
    };
  }

  /**
   * Get list of historical years to sync (all years before current season)
   */
  private getHistoricalYears(): number[] {
    const years: number[] = [];
    // Only include completed seasons (not current year)
    const lastCompletedSeason = this.currentSeason - 1;
    
    for (let year = this.minHistoricalYear; year <= lastCompletedSeason; year++) {
      years.push(year);
    }
    return years;
  }

  /**
   * Sync teams data to BigQuery
   */
  async syncTeams(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'teams_historical';
    
    try {
      // Check if data already exists
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Teams data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      // Fetch data from MLB API
      logger.info(`Fetching teams data for ${year}`, { year });
      const teams = await mlbApi.getTeamsForYear(year);

      if (!teams || teams.length === 0) {
        throw new Error(`No teams data returned for ${year}`);
      }

      // Transform data for BigQuery
      const rows = teams.map((team: any) => ({
        year,
        team_id: team.id,
        team_name: team.name,
        team_code: team.abbreviation,
        location_name: team.locationName,
        team_name_full: team.teamName,
        league_id: team.league?.id,
        league_name: team.league?.name,
        division_id: team.division?.id,
        division_name: team.division?.name,
        venue_id: team.venue?.id,
        venue_name: team.venue?.name,
        first_year_of_play: team.firstYearOfPlay,
        active: team.active !== false
      }));

      // Insert or replace data
      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced teams data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing teams data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync team stats data to BigQuery
   */
  async syncTeamStats(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'team_stats_historical';
    
    try {
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Team stats data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      logger.info(`Fetching team stats data for ${year}`, { year });
      
      // Fetch both batting and pitching stats
      const [battingStats, pitchingStats] = await Promise.all([
        mlbApi.getTeamStatsForSync(year, 'hitting'),
        mlbApi.getTeamStatsForSync(year, 'pitching')
      ]);

      const rows: any[] = [];

      // Process batting stats
      if (battingStats?.stats?.[0]?.splits) {
        for (const split of battingStats.stats[0].splits) {
          const team = split.team;
          const stats = split.stat;
          
          rows.push({
            year,
            team_id: team.id,
            team_name: team.name,
            stat_type: 'batting',
            games_played: stats.gamesPlayed || 0,
            at_bats: stats.atBats || 0,
            runs: stats.runs || 0,
            hits: stats.hits || 0,
            doubles: stats.doubles || 0,
            triples: stats.triples || 0,
            home_runs: stats.homeRuns || 0,
            rbi: stats.rbi || 0,
            stolen_bases: stats.stolenBases || 0,
            caught_stealing: stats.caughtStealing || 0,
            walks: stats.baseOnBalls || 0,
            strikeouts: stats.strikeOuts || 0,
            batting_avg: parseFloat(stats.avg || '0'),
            obp: parseFloat(stats.obp || '0'),
            slg: parseFloat(stats.slg || '0'),
            ops: parseFloat(stats.ops || '0'),
            total_bases: stats.totalBases || 0,
            hit_by_pitch: stats.hitByPitch || 0,
            sac_flies: stats.sacFlies || 0,
            sac_bunts: stats.sacBunts || 0,
            left_on_base: stats.leftOnBase || 0
          });
        }
      }

      // Process pitching stats
      if (pitchingStats?.stats?.[0]?.splits) {
        for (const split of pitchingStats.stats[0].splits) {
          const team = split.team;
          const stats = split.stat;
          
          rows.push({
            year,
            team_id: team.id,
            team_name: team.name,
            stat_type: 'pitching',
            games_played: stats.gamesPlayed || 0,
            wins: stats.wins || 0,
            losses: stats.losses || 0,
            win_percentage: parseFloat(stats.winPercentage || '0'),
            era: parseFloat(stats.era || '0'),
            games_started: stats.gamesStarted || 0,
            games_finished: stats.gamesFinished || 0,
            complete_games: stats.completeGames || 0,
            shutouts: stats.shutouts || 0,
            saves: stats.saves || 0,
            save_opportunities: stats.saveOpportunities || 0,
            holds: stats.holds || 0,
            blown_saves: stats.blownSaves || 0,
            innings_pitched: parseFloat(stats.inningsPitched || '0'),
            hits_allowed: stats.hits || 0,
            runs_allowed: stats.runs || 0,
            earned_runs: stats.earnedRuns || 0,
            home_runs_allowed: stats.homeRuns || 0,
            walks_allowed: stats.baseOnBalls || 0,
            strikeouts: stats.strikeOuts || 0,
            whip: parseFloat(stats.whip || '0'),
            batters_faced: stats.battersFaced || 0,
            wild_pitches: stats.wildPitches || 0,
            hit_batsmen: stats.hitBatsmen || 0,
            balks: stats.balks || 0
          });
        }
      }

      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced team stats data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing team stats data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync player stats data to BigQuery - Gets ALL players from all teams
   */
  async syncPlayerStats(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'player_stats_historical';
    
    try {
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Player stats data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      logger.info(`Fetching comprehensive player stats data for ${year}`, { year });
      
      // Get all teams first to iterate through their stats
      const teams = await mlbApi.getTeamsForYear(year);
      const rows: any[] = [];
      
      // Fetch player stats for each team to get ALL players (not just top 50)
      for (const team of teams) {
        try {
          logger.info(`Fetching player stats for ${team.name} (${year})`);
          
          // Get batting stats for this team
          const battingStats = await mlbApi.getTeamStatsForSync(year, 'hitting');
          if (battingStats?.stats?.[0]?.splits) {
            for (const split of battingStats.stats[0].splits) {
              if (split.team?.id === team.id && split.player?.id) {
                const player = split.player;
                const stats = split.stat;
                
                rows.push({
                  year,
                  player_id: player.id,
                  player_name: player.fullName,
                  team_id: team.id,
                  team_name: team.name,
                  stat_type: 'batting',
                  games_played: stats.gamesPlayed || 0,
                  plate_appearances: stats.plateAppearances || 0,
                  at_bats: stats.atBats || 0,
                  runs: stats.runs || 0,
                  hits: stats.hits || 0,
                  doubles: stats.doubles || 0,
                  triples: stats.triples || 0,
                  home_runs: stats.homeRuns || 0,
                  rbi: stats.rbi || 0,
                  stolen_bases: stats.stolenBases || 0,
                  caught_stealing: stats.caughtStealing || 0,
                  walks: stats.baseOnBalls || 0,
                  strikeouts: stats.strikeOuts || 0,
                  batting_avg: parseFloat(stats.avg || '0'),
                  obp: parseFloat(stats.obp || '0'),
                  slg: parseFloat(stats.slg || '0'),
                  ops: parseFloat(stats.ops || '0')
                });
              }
            }
          }
          
          // Get pitching stats for this team
          const pitchingStats = await mlbApi.getTeamStatsForSync(year, 'pitching');
          if (pitchingStats?.stats?.[0]?.splits) {
            for (const split of pitchingStats.stats[0].splits) {
              if (split.team?.id === team.id && split.player?.id) {
                const player = split.player;
                const stats = split.stat;
                
                rows.push({
                  year,
                  player_id: player.id,
                  player_name: player.fullName,
                  team_id: team.id,
                  team_name: team.name,
                  stat_type: 'pitching',
                  games_played: stats.gamesPlayed || 0,
                  wins: stats.wins || 0,
                  losses: stats.losses || 0,
                  era: parseFloat(stats.era || '0'),
                  games_started: stats.gamesStarted || 0,
                  complete_games: stats.completeGames || 0,
                  shutouts: stats.shutouts || 0,
                  saves: stats.saves || 0,
                  innings_pitched: parseFloat(stats.inningsPitched || '0'),
                  hits_allowed: stats.hits || 0,
                  runs_allowed: stats.runs || 0,
                  earned_runs: stats.earnedRuns || 0,
                  home_runs_allowed: stats.homeRuns || 0,
                  walks_allowed: stats.baseOnBalls || 0,
                  strikeouts: stats.strikeOuts || 0,
                  whip: parseFloat(stats.whip || '0')
                });
              }
            }
          }
          
          // Small delay between teams to avoid rate limiting
          await this.delay(500);
        } catch (error) {
          logger.warn(`Error fetching player stats for team ${team.name}`, {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
      
      // Also get top performers across the league to ensure we don't miss anyone
      const [battingLeaders, pitchingLeaders] = await Promise.all([
        mlbApi.getPlayerStatsForSync(year, 'hitting', 100),
        mlbApi.getPlayerStatsForSync(year, 'pitching', 100)
      ]);

      // Add league leaders to ensure no one is missed (check for duplicates by player_id)
      const playerIds = new Set(rows.map(r => r.player_id));

      // Process batting leaders (only add if not already in rows)
      if (battingLeaders?.stats?.[0]?.splits) {
        for (const split of battingLeaders.stats[0].splits) {
          const player = split.player;
          if (!playerIds.has(player.id)) {
            const team = split.team;
            const stats = split.stat;
            
            rows.push({
              year,
              player_id: player.id,
              player_name: player.fullName,
              team_id: team?.id,
              team_name: team?.name,
              stat_type: 'batting',
              games_played: stats.gamesPlayed || 0,
              plate_appearances: stats.plateAppearances || 0,
              at_bats: stats.atBats || 0,
              runs: stats.runs || 0,
              hits: stats.hits || 0,
              doubles: stats.doubles || 0,
              triples: stats.triples || 0,
              home_runs: stats.homeRuns || 0,
              rbi: stats.rbi || 0,
              stolen_bases: stats.stolenBases || 0,
              caught_stealing: stats.caughtStealing || 0,
              walks: stats.baseOnBalls || 0,
              strikeouts: stats.strikeOuts || 0,
              batting_avg: parseFloat(stats.avg || '0'),
              obp: parseFloat(stats.obp || '0'),
              slg: parseFloat(stats.slg || '0'),
              ops: parseFloat(stats.ops || '0')
            });
            playerIds.add(player.id);
          }
        }
      }

      // Process pitching leaders (only add if not already in rows)
      if (pitchingLeaders?.stats?.[0]?.splits) {
        for (const split of pitchingLeaders.stats[0].splits) {
          const player = split.player;
          if (!playerIds.has(player.id)) {
            const team = split.team;
            const stats = split.stat;
            
            rows.push({
              year,
              player_id: player.id,
              player_name: player.fullName,
              team_id: team?.id,
              team_name: team?.name,
              stat_type: 'pitching',
              games_played: stats.gamesPlayed || 0,
              wins: stats.wins || 0,
              losses: stats.losses || 0,
              era: parseFloat(stats.era || '0'),
              games_started: stats.gamesStarted || 0,
              complete_games: stats.completeGames || 0,
              shutouts: stats.shutouts || 0,
              saves: stats.saves || 0,
              innings_pitched: parseFloat(stats.inningsPitched || '0'),
              hits_allowed: stats.hits || 0,
              runs_allowed: stats.runs || 0,
              earned_runs: stats.earnedRuns || 0,
              home_runs_allowed: stats.homeRuns || 0,
              walks_allowed: stats.baseOnBalls || 0,
              strikeouts: stats.strikeOuts || 0,
              whip: parseFloat(stats.whip || '0')
            });
            playerIds.add(player.id);
          }
        }
      }

      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced player stats data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing player stats data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync standings data to BigQuery
   */
  async syncStandings(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'standings_historical';
    
    try {
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Standings data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      logger.info(`Fetching standings data for ${year}`, { year });
      const standings = await mlbApi.getStandings(undefined, year);

      const rows: any[] = [];

      if (standings?.records) {
        for (const division of standings.records) {
          for (const teamRecord of division.teamRecords) {
            rows.push({
              year,
              team_id: teamRecord.team.id,
              team_name: teamRecord.team.name,
              league_id: teamRecord.league?.id,
              league_name: teamRecord.league?.name,
              division_id: teamRecord.division?.id,
              division_name: teamRecord.division?.name,
              wins: teamRecord.wins || 0,
              losses: teamRecord.losses || 0,
              win_percentage: parseFloat(teamRecord.winningPercentage || '0'),
              games_back: parseFloat(teamRecord.gamesBack || '0'),
              wildcard_games_back: parseFloat(teamRecord.wildCardGamesBack || '0'),
              division_rank: teamRecord.divisionRank,
              league_rank: teamRecord.leagueRank,
              runs_scored: teamRecord.runsScored || 0,
              runs_allowed: teamRecord.runsAllowed || 0,
              run_differential: teamRecord.runDifferential || 0,
              home_wins: teamRecord.records?.splitRecords?.find((r: any) => r.type === 'home')?.wins || 0,
              home_losses: teamRecord.records?.splitRecords?.find((r: any) => r.type === 'home')?.losses || 0,
              away_wins: teamRecord.records?.splitRecords?.find((r: any) => r.type === 'away')?.wins || 0,
              away_losses: teamRecord.records?.splitRecords?.find((r: any) => r.type === 'away')?.losses || 0
            });
          }
        }
      }

      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced standings data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing standings data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync rosters data to BigQuery
   */
  async syncRosters(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'rosters_historical';
    
    try {
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Rosters data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      logger.info(`Fetching rosters data for ${year}`, { year });
      const teams = await mlbApi.getTeamsForYear(year);
      const rows: any[] = [];

      for (const team of teams) {
        try {
          const rosterData = await mlbApi.getTeamRoster(team.id, year);
          
          if (rosterData?.roster) {
            for (const player of rosterData.roster) {
              rows.push({
                year,
                team_id: team.id,
                team_name: team.name,
                player_id: player.person?.id,
                player_name: player.person?.fullName,
                jersey_number: player.jerseyNumber,
                position_code: player.position?.code,
                position_name: player.position?.name,
                position_type: player.position?.type,
                status: player.status?.code
              });
            }
          }
          
          // Small delay between teams
          await this.delay(500);
        } catch (error) {
          logger.warn(`Error fetching roster for team ${team.name}`, {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced rosters data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing rosters data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync games data to BigQuery
   */
  async syncGames(year: number, forceRefresh: boolean = false): Promise<SyncResult> {
    const tableName = 'games_historical';
    
    try {
      if (!forceRefresh) {
        const exists = await this.checkDataExists(tableName, year);
        if (exists) {
          logger.info(`Games data for ${year} already exists, skipping`, { year, tableName });
          return {
            success: true,
            tableName,
            year,
            recordsAdded: 0,
            recordsUpdated: 0
          };
        }
      }

      logger.info(`Fetching games data for ${year}`, { year });
      
      // Get full season schedule
      const startDate = `${year}-03-01`;
      const endDate = `${year}-11-30`;
      const scheduleData = await mlbApi.getSchedule(startDate, endDate, undefined, 1);
      
      const rows: any[] = [];

      if (scheduleData?.dates) {
        for (const date of scheduleData.dates) {
          for (const game of date.games || []) {
            // Only include regular season and playoff games
            if (game.gameType === 'R' || game.gameType === 'F' || game.gameType === 'D' || game.gameType === 'L' || game.gameType === 'W') {
              rows.push({
                year,
                game_pk: game.gamePk,
                game_type: game.gameType,
                season: game.season,
                game_date: game.gameDate,
                official_date: date.date,
                status: game.status?.detailedState,
                abstract_game_state: game.status?.abstractGameState,
                home_team_id: game.teams?.home?.team?.id,
                home_team_name: game.teams?.home?.team?.name,
                home_score: game.teams?.home?.score || 0,
                home_is_winner: game.teams?.home?.isWinner || false,
                away_team_id: game.teams?.away?.team?.id,
                away_team_name: game.teams?.away?.team?.name,
                away_score: game.teams?.away?.score || 0,
                away_is_winner: game.teams?.away?.isWinner || false,
                venue_id: game.venue?.id,
                venue_name: game.venue?.name,
                day_night: game.dayNight,
                scheduled_innings: game.scheduledInnings || 9,
                series_game_number: game.seriesGameNumber,
                games_in_series: game.gamesInSeries,
                series_description: game.seriesDescription,
                double_header: game.doubleHeader || 'N'
              });
            }
          }
        }
      }

      const recordsModified = await this.insertOrReplaceData(tableName, year, rows);

      logger.info(`Successfully synced games data for ${year}`, {
        year,
        tableName,
        recordsModified
      });

      return {
        success: true,
        tableName,
        year,
        recordsAdded: recordsModified,
        recordsUpdated: 0
      };
    } catch (error) {
      logger.error(`Error syncing games data for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        year
      });
      return {
        success: false,
        tableName,
        year,
        recordsAdded: 0,
        recordsUpdated: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Sync all missing data for historical years
   */
  async syncMissingData(options: SyncOptions = {}): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const status = await this.getSyncStatus();

    for (const tableStatus of status) {
      if (tableStatus.missingYears.length === 0 && !options.forceRefresh) {
        logger.info(`No missing years for ${tableStatus.tableName}`, { tableName: tableStatus.tableName });
        continue;
      }

      const yearsToSync = options.forceRefresh && options.years
        ? options.years
        : tableStatus.missingYears;

      for (const year of yearsToSync) {
        // Skip current season - we only cache historical data
        if (year >= this.currentSeason) {
          logger.info(`Skipping current/future season ${year}`, { year });
          continue;
        }

        let result: SyncResult;

        switch (tableStatus.tableName) {
          case 'teams_historical':
            result = await this.syncTeams(year, options.forceRefresh);
            break;
          case 'team_stats_historical':
            result = await this.syncTeamStats(year, options.forceRefresh);
            break;
          case 'player_stats_historical':
            result = await this.syncPlayerStats(year, options.forceRefresh);
            break;
          case 'standings_historical':
            result = await this.syncStandings(year, options.forceRefresh);
            break;
          case 'rosters_historical':
            result = await this.syncRosters(year, options.forceRefresh);
            break;
          case 'games_historical':
            result = await this.syncGames(year, options.forceRefresh);
            break;
          default:
            logger.warn(`Sync not implemented for ${tableStatus.tableName}`);
            continue;
        }

        results.push(result);

        // Add delay between API calls to avoid rate limiting
        await this.delay(1000);
      }
    }

    return results;
  }

  /**
   * Check if data exists for a specific table and year
   */
  private async checkDataExists(tableName: string, year: number): Promise<boolean> {
    const query = `
      SELECT COUNT(*) as count
      FROM \`${this.projectId}.${this.dataset}.${tableName}\`
      WHERE year = ${year}
    `;

    const [rows] = await this.bigquery.query({ query });
    return rows[0]?.count > 0;
  }

  /**
   * Insert or replace data in BigQuery table
   * Deletes existing data for the year first, then inserts new data
   */
  private async insertOrReplaceData(tableName: string, year: number, rows: any[]): Promise<number> {
    if (rows.length === 0) {
      logger.warn(`No data to insert for ${tableName} year ${year}`);
      return 0;
    }

    // Delete existing data for this year
    const deleteQuery = `
      DELETE FROM \`${this.projectId}.${this.dataset}.${tableName}\`
      WHERE year = ${year}
    `;

    await this.bigquery.query({ query: deleteQuery });
    logger.info(`Deleted existing data for ${tableName} year ${year}`);

    // Insert new data
    const table = this.bigquery.dataset(this.dataset).table(tableName);
    await table.insert(rows);

    logger.info(`Inserted ${rows.length} rows into ${tableName}`, {
      tableName,
      year,
      rowCount: rows.length
    });

    return rows.length;
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const bigQuerySyncService = new BigQuerySyncService();
