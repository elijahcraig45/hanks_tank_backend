import { BigQuery } from '@google-cloud/bigquery';
import { logger } from '../utils/logger';
import { gcpConfig } from '../config/gcp.config';

/**
 * Continuous Backup Service
 * 
 * This service implements a write-through caching strategy:
 * 1. Fetch data from live MLB API
 * 2. Automatically back up to BigQuery
 * 3. On API failure, fallback to BigQuery
 * 
 * This ensures BigQuery is always up-to-date and serves as:
 * - Disaster recovery backup
 * - Data lake for ML/analysis
 * - Historical archive
 */
export class ContinuousBackupService {
  private bigquery: BigQuery;
  private datasetId = 'mlb_data';
  private readonly BACKUP_TIMEOUT_MS = 30000; // 30 second timeout for backup operations

  constructor() {
    this.bigquery = new BigQuery({
      projectId: gcpConfig.projectId,
    });
  }

  /**
   * Wrapper to add timeout to BigQuery operations
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number = this.BACKUP_TIMEOUT_MS): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error('BigQuery operation timed out')), timeoutMs)
      )
    ]);
  }

  /**
   * Back up team stats to BigQuery
   * Called automatically after fetching from MLB API
   */
  async backupTeamStats(teamId: number, season: number, stats: any): Promise<void> {
    try {
      await this.withTimeout(this._backupTeamStatsInternal(teamId, season, stats));
    } catch (error) {
      logger.error('Failed to backup team stats to BigQuery', { 
        teamId, 
        season, 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupTeamStatsInternal(teamId: number, season: number, stats: any): Promise<void> {
    const tableId = 'team_stats_historical';
    const table = this.bigquery.dataset(this.datasetId).table(tableId);

    // Check if record already exists
    const query = `
      SELECT COUNT(*) as count
      FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
      WHERE team_id = @teamId AND season = @season
    `;

    const [rows] = await this.bigquery.query({
      query,
      params: { teamId, season },
    });

    const exists = rows[0]?.count > 0;

    if (exists) {
      // Update existing record
      const updateQuery = `
        UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        SET 
          stats_data = @statsData,
          last_updated = CURRENT_TIMESTAMP()
        WHERE team_id = @teamId AND season = @season
      `;

      await this.bigquery.query({
        query: updateQuery,
        params: { 
          teamId, 
          season,
          statsData: JSON.stringify(stats),
        },
      });

      logger.info('Updated team stats in BigQuery', { teamId, season });
    } else {
      // Insert new record
      const row = {
        team_id: teamId,
        season,
        stats_data: JSON.stringify(stats),
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      };

      await table.insert([row]);
      logger.info('Backed up new team stats to BigQuery', { teamId, season });
    }
  }

  /**
   * Back up player stats to BigQuery
   * Creates player record if doesn't exist
   */
  async backupPlayerStats(playerId: number, season: number, stats: any): Promise<void> {
    try {
      await this.withTimeout(this._backupPlayerStatsInternal(playerId, season, stats));
    } catch (error) {
      logger.error('Failed to backup player stats to BigQuery', { 
        playerId, 
        season, 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupPlayerStatsInternal(playerId: number, season: number, stats: any): Promise<void> {
    const tableId = 'player_stats_historical';
    const table = this.bigquery.dataset(this.datasetId).table(tableId);

    // Check if record already exists
    const query = `
      SELECT COUNT(*) as count
      FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
      WHERE player_id = @playerId AND season = @season
    `;

    const [rows] = await this.bigquery.query({
      query,
      params: { playerId, season },
    });

    const exists = rows[0]?.count > 0;

    if (exists) {
      // Update existing record
      const updateQuery = `
        UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        SET 
          stats_data = @statsData,
          last_updated = CURRENT_TIMESTAMP()
        WHERE player_id = @playerId AND season = @season
      `;

      await this.bigquery.query({
        query: updateQuery,
        params: { 
          playerId, 
          season,
          statsData: JSON.stringify(stats),
        },
      });

      logger.info('Updated player stats in BigQuery', { playerId, season });
    } else {
      // Insert new record
      const row = {
        player_id: playerId,
        season,
        stats_data: JSON.stringify(stats),
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      };

      await table.insert([row]);
      logger.info('Backed up new player stats to BigQuery', { playerId, season });
    }
  }

  /**
   * Back up game data to BigQuery
   * Stores play-by-play, box scores, etc.
   */
  async backupGameData(gameId: number, gamePk: number, gameData: any): Promise<void> {
    try {
      await this.withTimeout(this._backupGameDataInternal(gameId, gamePk, gameData));
    } catch (error) {
      logger.error('Failed to backup game data to BigQuery', { 
        gameId, 
        gamePk,
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupGameDataInternal(gameId: number, gamePk: number, gameData: any): Promise<void> {
      const tableId = 'games_historical';
      const table = this.bigquery.dataset(this.datasetId).table(tableId);

      // Extract season from game date
      const gameDate = gameData.gameDate || gameData.officialDate;
      const season = new Date(gameDate).getFullYear();

      // Check if record already exists
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        WHERE game_pk = @gamePk
      `;

      const [rows] = await this.bigquery.query({
        query,
        params: { gamePk },
      });

      const exists = rows[0]?.count > 0;

      if (exists) {
        // Update existing record
        const updateQuery = `
          UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
          SET 
            game_data = @gameData,
            last_updated = CURRENT_TIMESTAMP()
          WHERE game_pk = @gamePk
        `;

        await this.bigquery.query({
          query: updateQuery,
          params: { 
            gamePk,
            gameData: JSON.stringify(gameData),
          },
        });

        logger.info('Updated game data in BigQuery', { gamePk, season });
      } else {
        // Insert new record
        const row = {
          game_pk: gamePk,
          season,
          game_date: gameDate,
          game_data: JSON.stringify(gameData),
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };

        await table.insert([row]);
        logger.info('Backed up new game data to BigQuery', { gamePk, season });
      }
  }

  /**
   * Back up standings data to BigQuery
   */
  async backupStandings(season: number, standingsData: any): Promise<void> {
    try {
      await this.withTimeout(this._backupStandingsInternal(season, standingsData));
    } catch (error) {
      logger.error('Failed to backup standings to BigQuery', { 
        season,
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupStandingsInternal(season: number, standingsData: any): Promise<void> {
      const tableId = 'standings_historical';
      const table = this.bigquery.dataset(this.datasetId).table(tableId);

      // Check if record already exists
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        WHERE season = @season
      `;

      const [rows] = await this.bigquery.query({
        query,
        params: { season },
      });

      const exists = rows[0]?.count > 0;

      if (exists) {
        // Update existing record
        const updateQuery = `
          UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
          SET 
            standings_data = @standingsData,
            last_updated = CURRENT_TIMESTAMP()
          WHERE season = @season
        `;

        await this.bigquery.query({
          query: updateQuery,
          params: { 
            season,
            standingsData: JSON.stringify(standingsData),
          },
        });

        logger.info('Updated standings in BigQuery', { season });
      } else {
        // Insert new record
        const row = {
          season,
          standings_data: JSON.stringify(standingsData),
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };

        await table.insert([row]);
        logger.info('Backed up new standings to BigQuery', { season });
      }
  }

  /**
   * Back up roster data to BigQuery
   */
  async backupRoster(teamId: number, season: number, rosterData: any): Promise<void> {
    try {
      await this.withTimeout(this._backupRosterInternal(teamId, season, rosterData));
    } catch (error) {
      logger.error('Failed to backup roster to BigQuery', { 
        teamId,
        season, 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupRosterInternal(teamId: number, season: number, rosterData: any): Promise<void> {
      const tableId = 'rosters_historical';
      const table = this.bigquery.dataset(this.datasetId).table(tableId);

      // Check if record already exists
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        WHERE team_id = @teamId AND season = @season
      `;

      const [rows] = await this.bigquery.query({
        query,
        params: { teamId, season },
      });

      const exists = rows[0]?.count > 0;

      if (exists) {
        // Update existing record
        const updateQuery = `
          UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
          SET 
            roster_data = @rosterData,
            last_updated = CURRENT_TIMESTAMP()
          WHERE team_id = @teamId AND season = @season
        `;

        await this.bigquery.query({
          query: updateQuery,
          params: { 
            teamId,
            season,
            rosterData: JSON.stringify(rosterData),
          },
        });

        logger.info('Updated roster in BigQuery', { teamId, season });
      } else {
        // Insert new record
        const row = {
          team_id: teamId,
          season,
          roster_data: JSON.stringify(rosterData),
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };

        await table.insert([row]);
        logger.info('Backed up new roster to BigQuery', { teamId, season });
      }
  }

  /**
   * Back up teams data to BigQuery
   */
  async backupTeam(teamId: number, season: number, teamData: any): Promise<void> {
    try {
      await this.withTimeout(this._backupTeamInternal(teamId, season, teamData));
    } catch (error) {
      logger.error('Failed to backup team to BigQuery', { 
        teamId,
        season, 
        error: error instanceof Error ? error.message : String(error) 
      });
      // Don't throw - backup failure shouldn't break the API response
    }
  }

  private async _backupTeamInternal(teamId: number, season: number, teamData: any): Promise<void> {
      const tableId = 'teams_historical';
      const table = this.bigquery.dataset(this.datasetId).table(tableId);

      // Check if record already exists
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
        WHERE team_id = @teamId AND season = @season
      `;

      const [rows] = await this.bigquery.query({
        query,
        params: { teamId, season },
      });

      const exists = rows[0]?.count > 0;

      if (exists) {
        // Update existing record
        const updateQuery = `
          UPDATE \`${gcpConfig.projectId}.${this.datasetId}.${tableId}\`
          SET 
            team_data = @teamData,
            last_updated = CURRENT_TIMESTAMP()
          WHERE team_id = @teamId AND season = @season
        `;

        await this.bigquery.query({
          query: updateQuery,
          params: { 
            teamId,
            season,
            teamData: JSON.stringify(teamData),
          },
        });

        logger.info('Updated team in BigQuery', { teamId, season });
      } else {
        // Insert new record
        const row = {
          team_id: teamId,
          season,
          team_data: JSON.stringify(teamData),
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };

        await table.insert([row]);
        logger.info('Backed up new team to BigQuery', { teamId, season });
      }
  }
}

export const continuousBackupService = new ContinuousBackupService();
