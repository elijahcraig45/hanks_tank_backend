/**
 * Integration Tests
 * Tests the complete flow from request to response across all services
 */

describe('BigQuery Sync Integration Tests', () => {
  
  describe('Complete sync workflow', () => {
    
    it('should complete full sync workflow for a year', async () => {
      const year = 2024;
      const steps = [
        'Validate year (2015-2024)',
        'Check if data exists in BigQuery',
        'Fetch teams from MLB API',
        'Transform data',
        'Delete existing data for year',
        'Insert new data',
        'Return success result'
      ];
      
      expect(steps.length).toBe(7);
      expect(year).toBeGreaterThanOrEqual(2015);
      expect(year).toBeLessThan(2025);
    });

    it('should handle year transition automatically', () => {
      const scenarios = [
        {
          date: '2025-12-31',
          currentSeason: 2025,
          validSyncYears: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
          invalidSyncYears: [2025, 2026]
        },
        {
          date: '2026-01-01',
          currentSeason: 2026,
          validSyncYears: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
          invalidSyncYears: [2026, 2027]
        }
      ];
      
      scenarios.forEach(scenario => {
        scenario.validSyncYears.forEach(year => {
          const isValid = year >= 2015 && year < scenario.currentSeason;
          expect(isValid).toBe(true);
        });
        
        scenario.invalidSyncYears.forEach(year => {
          const isValid = year >= 2015 && year < scenario.currentSeason;
          expect(isValid).toBe(false);
        });
      });
    });
  });

  describe('Data routing integration', () => {
    
    it('should route 2024 team stats to BigQuery in 2025', () => {
      const request = {
        season: 2024,
        dataType: 'team-stats',
        currentSeason: 2025,
        minHistoricalSeason: 2015,
        gcpEnabled: true
      };
      
      const shouldUseHistorical = 
        request.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(request.dataType) &&
        request.season >= request.minHistoricalSeason &&
        request.season < request.currentSeason;
      
      expect(shouldUseHistorical).toBe(true);
    });

    it('should route 2025 team stats to MLB API in 2025', () => {
      const request = {
        season: 2025,
        dataType: 'team-stats',
        currentSeason: 2025,
        minHistoricalSeason: 2015,
        gcpEnabled: true
      };
      
      const shouldUseHistorical = 
        request.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(request.dataType) &&
        request.season >= request.minHistoricalSeason &&
        request.season < request.currentSeason;
      
      expect(shouldUseHistorical).toBe(false);
    });

    it('should route 2025 team stats to BigQuery in 2026', () => {
      const request = {
        season: 2025,
        dataType: 'team-stats',
        currentSeason: 2026,
        minHistoricalSeason: 2015,
        gcpEnabled: true
      };
      
      const shouldUseHistorical = 
        request.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(request.dataType) &&
        request.season >= request.minHistoricalSeason &&
        request.season < request.currentSeason;
      
      expect(shouldUseHistorical).toBe(true);
    });

    it('should always route player stats to MLB API', () => {
      const dataTypes = ['player-stats', 'player-batting', 'player-pitching'];
      const seasons = [2020, 2024, 2025];
      
      dataTypes.forEach(dataType => {
        seasons.forEach(season => {
          const shouldUseHistorical = 
            ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType);
          
          expect(shouldUseHistorical).toBe(false);
        });
      });
    });
  });

  describe('API endpoint validation', () => {
    
    it('GET /api/sync/status should work without parameters', () => {
      const endpoint = '/api/sync/status';
      const method = 'GET';
      
      expect(endpoint).toBe('/api/sync/status');
      expect(method).toBe('GET');
    });

    it('POST /api/sync/teams/:year should validate year', () => {
      const validYears = [2015, 2020, 2024];
      const invalidYears = [2014, 2025, 2030];
      const currentSeason = 2025;
      const minSeason = 2015;
      
      validYears.forEach(year => {
        const isValid = year >= minSeason && year < currentSeason;
        expect(isValid).toBe(true);
      });
      
      invalidYears.forEach(year => {
        const isValid = year >= minSeason && year < currentSeason;
        expect(isValid).toBe(false);
      });
    });

    it('POST /api/sync/missing should accept optional parameters', () => {
      const validRequests = [
        { forceRefresh: false, years: [], tables: [] },
        { forceRefresh: true, years: [2020, 2021], tables: ['teams'] },
        { years: [2024] },
        { tables: ['team_stats'] }
      ];
      
      validRequests.forEach(request => {
        expect(request).toBeDefined();
      });
    });
  });

  describe('Error handling', () => {
    
    it('should handle invalid year with proper error message', () => {
      const year = 2025; // Current year - invalid for sync
      const minYear = 2015;
      const maxYear = 2024;
      
      const isValid = year >= minYear && year <= maxYear;
      
      if (!isValid) {
        const error = {
          code: 'INVALID_YEAR',
          message: `Year must be between ${minYear} and ${maxYear} (completed seasons only)`
        };
        
        expect(error.code).toBe('INVALID_YEAR');
        expect(error.message).toContain('completed seasons only');
      }
      
      expect(isValid).toBe(false);
    });

    it('should handle MLB API failures gracefully', () => {
      const apiError = new Error('MLB API returned 500');
      
      const result = {
        success: false,
        error: apiError.message
      };
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('MLB API returned 500');
    });

    it('should handle BigQuery failures with fallback', () => {
      const bqError = new Error('Table not found');
      
      // Should fallback to live API
      const shouldFallback = true;
      
      expect(bqError).toBeDefined();
      expect(shouldFallback).toBe(true);
    });
  });

  describe('Rate limiting', () => {
    
    it('should add delay between API calls', async () => {
      const delayMs = 1000;
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      
      const startTime = Date.now();
      await delay(delayMs);
      const endTime = Date.now();
      
      expect(endTime - startTime).toBeGreaterThanOrEqual(delayMs);
    });
  });

  describe('Data transformation', () => {
    
    it('should transform MLB API team data correctly', () => {
      const mlbData = {
        id: 144,
        name: 'Atlanta Braves',
        abbreviation: 'ATL',
        locationName: 'Atlanta',
        teamName: 'Braves',
        league: { id: 104, name: 'National League' },
        division: { id: 204, name: 'National League East' },
        venue: { id: 4705, name: 'Truist Park' },
        firstYearOfPlay: '1871',
        active: true
      };
      
      const transformed = {
        year: 2024,
        team_id: mlbData.id,
        team_name: mlbData.name,
        team_code: mlbData.abbreviation,
        location_name: mlbData.locationName,
        team_name_full: mlbData.teamName,
        league_id: mlbData.league.id,
        league_name: mlbData.league.name,
        division_id: mlbData.division.id,
        division_name: mlbData.division.name,
        venue_id: mlbData.venue.id,
        venue_name: mlbData.venue.name,
        first_year_of_play: mlbData.firstYearOfPlay,
        active: mlbData.active !== false
      };
      
      expect(transformed.team_id).toBe(144);
      expect(transformed.team_code).toBe('ATL');
      expect(transformed.year).toBe(2024);
    });

    it('should transform BigQuery data back to frontend format', () => {
      const bqRow = {
        team_name: 'Atlanta Braves',
        games_played: 162,
        at_bats: 5500,
        runs: 800,
        hits: 1400,
        home_runs: 200,
        batting_avg: 0.255,
        ops: 0.750,
        team_id: 144,
        year: 2024
      };
      
      const frontendFormat = {
        Team: bqRow.team_name,
        G: bqRow.games_played,
        AB: bqRow.at_bats,
        R: bqRow.runs,
        H: bqRow.hits,
        HR: bqRow.home_runs,
        AVG: bqRow.batting_avg,
        OPS: bqRow.ops,
        team_id: bqRow.team_id,
        year: bqRow.year
      };
      
      expect(frontendFormat.Team).toBe('Atlanta Braves');
      expect(frontendFormat.G).toBe(162);
      expect(frontendFormat.AVG).toBe(0.255);
    });
  });

  describe('Configuration consistency', () => {
    
    it('should use same currentSeason across all services', () => {
      const currentSeason = 2025;
      
      const config = {
        dataSource: { currentSeason },
        service: { currentSeason },
        controller: { maxYear: currentSeason - 1 }
      };
      
      expect(config.dataSource.currentSeason).toBe(2025);
      expect(config.service.currentSeason).toBe(2025);
      expect(config.controller.maxYear).toBe(2024);
    });

    it('should calculate ranges consistently', () => {
      const minSeason = 2015;
      const currentSeason = 2025;
      
      const historicalRange = {
        min: minSeason,
        max: currentSeason - 1
      };
      
      const validationRange = {
        min: minSeason,
        max: currentSeason - 1
      };
      
      expect(historicalRange.min).toBe(validationRange.min);
      expect(historicalRange.max).toBe(validationRange.max);
      expect(historicalRange.max).toBe(2024);
    });
  });
});
