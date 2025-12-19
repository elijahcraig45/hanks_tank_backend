/**
 * Statcast Data Collector Service
 * Collects pitch-by-pitch Statcast data from Baseball Savant for 2015-2025
 */

import axios from 'axios';
import { BigQuery } from '@google-cloud/bigquery';
import { gcpConfig } from '../config/gcp.config';
import { logger } from '../utils/logger';

interface StatcastPitch {
  // Core pitch data
  pitch_type?: string;
  game_date?: string;
  release_speed?: number;
  release_pos_x?: number;
  release_pos_z?: number;
  player_name?: string;
  batter?: number;
  pitcher?: number;
  events?: string;
  description?: string;
  
  // Spin and break
  spin_rate_deprecated?: number;
  break_angle_deprecated?: number;
  break_length_deprecated?: number;
  release_spin_rate?: number;
  spin_axis?: number;
  
  // Location
  zone?: number;
  plate_x?: number;
  plate_z?: number;
  
  // Game context
  game_type?: string;
  stand?: string;
  p_throws?: string;
  home_team?: string;
  away_team?: string;
  balls?: number;
  strikes?: number;
  game_year?: number;
  inning?: number;
  inning_topbot?: string;
  outs_when_up?: number;
  
  // Advanced metrics
  pfx_x?: number;
  pfx_z?: number;
  hit_distance_sc?: number;
  launch_speed?: number;
  launch_angle?: number;
  effective_speed?: number;
  release_extension?: number;
  game_pk?: number;
  
  // Expected stats
  estimated_ba_using_speedangle?: number;
  estimated_woba_using_speedangle?: number;
  estimated_slg_using_speedangle?: number;
  woba_value?: number;
  woba_denom?: number;
  babip_value?: number;
  iso_value?: number;
  
  // Velocity components
  vx0?: number;
  vy0?: number;
  vz0?: number;
  ax?: number;
  ay?: number;
  az?: number;
  
  // Strike zone
  sz_top?: number;
  sz_bot?: number;
  
  // Bat tracking
  bat_speed?: number;
  swing_length?: number;
  
  // Win probability
  delta_home_win_exp?: number;
  delta_run_exp?: number;
  
  // Additional context
  pitch_name?: string;
  home_score?: number;
  away_score?: number;
  attack_angle?: number;
}

export class StatcastCollectorService {
  private bigquery: BigQuery;
  private dataset: string;
  private projectId: string;
  private baseUrl: string = 'https://baseballsavant.mlb.com/statcast_search/csv';

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

    logger.info('StatcastCollectorService initialized');
  }

  /**
   * Collect Statcast data for a specific date range
   */
  async collectStatcastData(
    startDate: string,
    endDate: string,
    playerType: 'batter' | 'pitcher' = 'batter'
  ): Promise<StatcastPitch[]> {
    try {
      const url = `${this.baseUrl}?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfC=&hfSit=&player_type=${playerType}&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA=&game_date_gt=${startDate}&game_date_lt=${endDate}&hfInfield=&team=&position=&hfOutfield=&hfRO=&home_road=&hfFlag=&hfPull=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=game_date&sort_order=desc&min_pas=0&type=details`;

      logger.info('Fetching Statcast data', { startDate, endDate, playerType });

      const response = await axios.get(url, {
        timeout: 60000,
        headers: {
          'User-Agent': 'Hanks-Tank-Backend/2.0',
        },
      });

      const csvData = response.data as string;
      const pitches = this.parseCSVToJSON(csvData);

      logger.info('Statcast data fetched successfully', {
        startDate,
        endDate,
        pitchCount: pitches.length
      });

      return pitches;
    } catch (error) {
      logger.error('Error fetching Statcast data', {
        error: error instanceof Error ? error.message : 'Unknown error',
        startDate,
        endDate
      });
      throw error;
    }
  }

  /**
   * Collect Statcast data for an entire season with pagination
   */
  async collectSeasonStatcast(year: number): Promise<number> {
    try {
      logger.info(`Starting Statcast collection for ${year}`);

      // Divide season into monthly chunks to avoid hitting limits
      const dateRanges = this.generateMonthlyRanges(year);
      let totalPitches = 0;

      for (const range of dateRanges) {
        logger.info(`Collecting ${range.start} to ${range.end}`);
        
        // Collect both batter and pitcher perspectives
        const [batterData, pitcherData] = await Promise.all([
          this.collectStatcastData(range.start, range.end, 'batter'),
          this.collectStatcastData(range.start, range.end, 'pitcher')
        ]);

        // Deduplicate by game_pk + pitch sequence
        const allPitches = this.deduplicatePitches([...batterData, ...pitcherData]);
        
        // Store in BigQuery
        await this.storeStatcastData(allPitches, year);
        
        totalPitches += allPitches.length;
        
        // Delay between requests to avoid rate limiting
        await this.delay(2000);
      }

      logger.info(`Completed Statcast collection for ${year}`, { totalPitches });
      return totalPitches;

    } catch (error) {
      logger.error(`Error collecting season Statcast for ${year}`, {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Store Statcast data in BigQuery in batches
   */
  async storeStatcastData(pitches: StatcastPitch[], year: number): Promise<void> {
    if (pitches.length === 0) {
      logger.warn('No Statcast pitches to store');
      return;
    }

    const tableName = 'statcast_pitches';
    const BATCH_SIZE = 1000; // BigQuery insert limit is ~10MB, 1000 rows is safe
    
    // Fields allowed in our BigQuery schema
    const allowedFields = [
      'pitch_type', 'game_date', 'release_speed', 'release_pos_x', 'release_pos_z',
      'player_name', 'batter', 'pitcher', 'events', 'description',
      'spin_rate_deprecated', 'release_spin_rate', 'spin_axis', 'zone',
      'plate_x', 'plate_z', 'game_type', 'stand', 'p_throws',
      'home_team', 'away_team', 'balls', 'strikes', 'game_year',
      'year', 'inning', 'inning_topbot', 'outs_when_up',
      'pfx_x', 'pfx_z', 'hit_distance_sc', 'launch_speed', 'launch_angle',
      'effective_speed', 'release_extension', 'game_pk',
      'estimated_ba_using_speedangle', 'estimated_woba_using_speedangle',
      'estimated_slg_using_speedangle', 'woba_value', 'woba_denom',
      'babip_value', 'iso_value', 'vx0', 'vy0', 'vz0',
      'ax', 'ay', 'az', 'sz_top', 'sz_bot',
      'bat_speed', 'swing_length', 'delta_home_win_exp', 'delta_run_exp',
      'pitch_name', 'home_score', 'away_score', 'attack_angle'
    ];
    
    try {
      // Transform and filter data for BigQuery
      const rows = pitches.map(pitch => {
        const filtered: any = { year };
        
        // Only include fields that exist in our schema
        for (const field of allowedFields) {
          if (field in pitch) {
            filtered[field] = pitch[field as keyof StatcastPitch];
          }
        }
        
        // Ensure numeric fields are properly typed
        if (filtered.release_speed) filtered.release_speed = parseFloat(String(filtered.release_speed));
        if (filtered.launch_speed) filtered.launch_speed = parseFloat(String(filtered.launch_speed));
        if (filtered.launch_angle) filtered.launch_angle = parseFloat(String(filtered.launch_angle));
        if (filtered.bat_speed) filtered.bat_speed = parseFloat(String(filtered.bat_speed));
        if (filtered.release_spin_rate) filtered.release_spin_rate = parseInt(String(filtered.release_spin_rate));
        
        return filtered;
      });

      // Insert in batches
      const table = this.bigquery.dataset(this.dataset).table(tableName);
      const batches = [];
      
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        batches.push(batch);
      }

      logger.info(`Storing ${rows.length} pitches in ${batches.length} batches`, {
        tableName,
        year,
        batchSize: BATCH_SIZE
      });

      for (let i = 0; i < batches.length; i++) {
        try {
          await table.insert(batches[i]);
          logger.info(`Batch ${i + 1}/${batches.length} inserted (${batches[i].length} rows)`);
        } catch (insertError: any) {
          logger.error(`Error inserting batch ${i + 1}/${batches.length}`, {
            error: insertError?.message || JSON.stringify(insertError),
            errors: insertError?.errors,
            response: insertError?.response?.data,
            batchSize: batches[i].length,
            sampleRow: batches[i][0]
          });
          throw insertError;
        }
        
        // Small delay between batches
        if (i < batches.length - 1) {
          await this.delay(500);
        }
      }

      logger.info(`Stored ${rows.length} Statcast pitches in BigQuery`, {
        tableName,
        year,
        sampleDate: rows[0]?.game_date
      });

    } catch (error: any) {
      logger.error('Error storing Statcast data', {
        error: error?.message || JSON.stringify(error),
        errors: error?.errors,
        stack: error?.stack,
        pitchCount: pitches.length
      });
      throw error;
    }
  }

  /**
   * Generate monthly date ranges for a season
   */
  private generateMonthlyRanges(year: number): Array<{ start: string; end: string }> {
    const ranges: Array<{ start: string; end: string }> = [];
    
    // MLB season runs March-October
    const months = [
      { start: `${year}-03-01`, end: `${year}-03-31` },
      { start: `${year}-04-01`, end: `${year}-04-30` },
      { start: `${year}-05-01`, end: `${year}-05-31` },
      { start: `${year}-06-01`, end: `${year}-06-30` },
      { start: `${year}-07-01`, end: `${year}-07-31` },
      { start: `${year}-08-01`, end: `${year}-08-31` },
      { start: `${year}-09-01`, end: `${year}-09-30` },
      { start: `${year}-10-01`, end: `${year}-11-15` }
    ];

    return months;
  }

  /**
   * Deduplicate pitches based on game_pk and pitch sequence
   */
  private deduplicatePitches(pitches: StatcastPitch[]): StatcastPitch[] {
    const seen = new Set<string>();
    const unique: StatcastPitch[] = [];

    for (const pitch of pitches) {
      // Create unique key from game_pk, batter, pitcher, inning, and pitch number would be ideal
      // For now, use game_pk + player + game_date + description as proxy
      const key = `${pitch.game_pk}_${pitch.batter}_${pitch.pitcher}_${pitch.game_date}_${pitch.description}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(pitch);
      }
    }

    logger.info('Deduplicated pitches', {
      original: pitches.length,
      unique: unique.length,
      duplicates: pitches.length - unique.length
    });

    return unique;
  }

  /**
   * Parse CSV data to JSON
   */
  private parseCSVToJSON(csvData: string): StatcastPitch[] {
    try {
      const lines = csvData.trim().split('\n');
      if (lines.length < 2) {
        return [];
      }

      const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
      const pitches: StatcastPitch[] = [];

      for (let i = 1; i < lines.length; i++) {
        const values = this.parseCSVLine(lines[i]);
        if (values.length === headers.length) {
          const pitch: any = {};
          headers.forEach((header, index) => {
            const value = values[index];
            // Convert numeric strings to numbers
            if (value && !isNaN(Number(value)) && value !== '') {
              pitch[header] = Number(value);
            } else {
              pitch[header] = value || null;
            }
          });
          pitches.push(pitch as StatcastPitch);
        }
      }

      return pitches;
    } catch (error) {
      logger.error('Error parsing CSV', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Parse a single CSV line handling quoted values
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current.trim());
    return result;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const statcastCollectorService = new StatcastCollectorService();
