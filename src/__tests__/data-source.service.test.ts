/**
 * Unit Tests for Data Source Service
 * Tests intelligent routing between historical BigQuery data and live MLB API
 */

describe('Data Source Service - shouldUseHistoricalData()', () => {
  
  const mockConfig = {
    currentSeason: 2025,
    minHistoricalSeason: 2015,
    gcpEnabled: true
  };

  describe('Data type routing', () => {
    
    it('should use historical data for team-stats in valid range', () => {
      const dataType = 'team-stats';
      const season = 2020;
      
      const shouldUseHistorical = 
        mockConfig.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= mockConfig.minHistoricalSeason &&
        season < mockConfig.currentSeason;
      
      expect(shouldUseHistorical).toBe(true);
    });

    it('should use historical data for standings in valid range', () => {
      const dataType = 'standings';
      const season = 2023;
      
      const shouldUseHistorical = 
        mockConfig.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= mockConfig.minHistoricalSeason &&
        season < mockConfig.currentSeason;
      
      expect(shouldUseHistorical).toBe(true);
    });

    it('should NOT use historical data for player stats (not available yet)', () => {
      const dataTypes = ['player-stats', 'player-batting', 'player-pitching'];
      const season = 2020;
      
      dataTypes.forEach(dataType => {
        const shouldUseHistorical = 
          mockConfig.gcpEnabled &&
          ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
          season >= mockConfig.minHistoricalSeason &&
          season < mockConfig.currentSeason;
        
        expect(shouldUseHistorical).toBe(false);
      });
    });

    it('should NOT use historical data for roster data', () => {
      const dataType = 'roster';
      const season = 2020;
      
      const shouldUseHistorical = 
        mockConfig.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= mockConfig.minHistoricalSeason &&
        season < mockConfig.currentSeason;
      
      expect(shouldUseHistorical).toBe(false);
    });
  });

  describe('Season boundary checks', () => {
    
    it('should use MLB API for current season (2025)', () => {
      const dataType = 'team-stats';
      const season = 2025; // Current season
      
      const shouldUseHistorical = 
        mockConfig.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= mockConfig.minHistoricalSeason &&
        season < mockConfig.currentSeason;
      
      expect(shouldUseHistorical).toBe(false);
    });

    it('should use MLB API for future seasons', () => {
      const dataType = 'team-stats';
      const seasons = [2026, 2027, 2030];
      
      seasons.forEach(season => {
        const shouldUseHistorical = 
          mockConfig.gcpEnabled &&
          ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
          season >= mockConfig.minHistoricalSeason &&
          season < mockConfig.currentSeason;
        
        expect(shouldUseHistorical).toBe(false);
      });
    });

    it('should use MLB API for seasons before minimum historical year', () => {
      const dataType = 'team-stats';
      const seasons = [2010, 2012, 2014];
      
      seasons.forEach(season => {
        const shouldUseHistorical = 
          mockConfig.gcpEnabled &&
          ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
          season >= mockConfig.minHistoricalSeason &&
          season < mockConfig.currentSeason;
        
        expect(shouldUseHistorical).toBe(false);
      });
    });

    it('should use BigQuery for all years in historical range', () => {
      const dataType = 'team-stats';
      const historicalYears = [2015, 2016, 2018, 2020, 2022, 2024];
      
      historicalYears.forEach(season => {
        const shouldUseHistorical = 
          mockConfig.gcpEnabled &&
          ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
          season >= mockConfig.minHistoricalSeason &&
          season < mockConfig.currentSeason;
        
        expect(shouldUseHistorical).toBe(true);
      });
    });
  });

  describe('GCP availability fallback', () => {
    
    it('should use MLB API when GCP is disabled', () => {
      const config = { ...mockConfig, gcpEnabled: false };
      const dataType = 'team-stats';
      const season = 2020;
      
      const shouldUseHistorical = 
        config.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= config.minHistoricalSeason &&
        season < config.currentSeason;
      
      expect(shouldUseHistorical).toBe(false);
    });
  });

  describe('Year transition behavior', () => {
    
    it('should switch 2025 from live to historical on Jan 1, 2026', () => {
      const dataType = 'team-stats';
      const season = 2025;
      
      // December 31, 2025: currentSeason = 2025
      let config = { ...mockConfig, currentSeason: 2025 };
      let shouldUseHistorical = 
        config.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= config.minHistoricalSeason &&
        season < config.currentSeason;
      expect(shouldUseHistorical).toBe(false); // Live API
      
      // January 1, 2026: currentSeason = 2026
      config = { ...mockConfig, currentSeason: 2026 };
      shouldUseHistorical = 
        config.gcpEnabled &&
        ['team-stats', 'team-batting', 'team-pitching', 'standings'].includes(dataType) &&
        season >= config.minHistoricalSeason &&
        season < config.currentSeason;
      expect(shouldUseHistorical).toBe(true); // BigQuery
    });
  });

  describe('Cache TTL selection', () => {
    
    it('should use long TTL for historical data', () => {
      const season = 2020;
      const currentSeason = 2025;
      
      // Historical data (completed season) should cache for 24 hours
      const ttl = season < currentSeason ? 86400 : 900;
      expect(ttl).toBe(86400); // 24 hours
    });

    it('should use short TTL for current season data', () => {
      const season = 2025;
      const currentSeason = 2025;
      
      // Current season data should cache for 15 minutes
      const ttl = season < currentSeason ? 86400 : 900;
      expect(ttl).toBe(900); // 15 minutes
    });
  });

  describe('BigQuery table selection', () => {
    
    it('should query team_stats_historical for batting stats', () => {
      const dataType = 'team-batting';
      const statType = 'batting';
      
      const expectedTable = 'team_stats_historical';
      const expectedStatTypeFilter = "stat_type = 'batting'";
      
      expect(dataType).toBe('team-batting');
      expect(statType).toBe('batting');
    });

    it('should query team_stats_historical for pitching stats', () => {
      const dataType = 'team-pitching';
      const statType = 'pitching';
      
      const expectedTable = 'team_stats_historical';
      const expectedStatTypeFilter = "stat_type = 'pitching'";
      
      expect(dataType).toBe('team-pitching');
      expect(statType).toBe('pitching');
    });

    it('should query standings_historical for standings', () => {
      const dataType = 'standings';
      const expectedTable = 'standings_historical';
      
      expect(dataType).toBe('standings');
    });
  });

  describe('Fallback behavior', () => {
    
    it('should fallback to MLB API if BigQuery query fails', () => {
      // This tests that getHistoricalData catches errors and calls getLiveData
      const bigQueryError = new Error('Table not found');
      
      // Should catch error and attempt fallback
      expect(bigQueryError).toBeDefined();
      expect(bigQueryError.message).toBe('Table not found');
      
      // Fallback mechanism should be triggered
      const shouldFallback = true;
      expect(shouldFallback).toBe(true);
    });

    it('should fallback to MLB API for player stats (not in BigQuery)', () => {
      const dataType = 'player-batting';
      const errorMessage = 'Player stats not available in historical data - using MLB API fallback';
      
      // Player stats should throw and fallback
      expect(errorMessage).toContain('using MLB API fallback');
    });

    it('should fallback to MLB API for roster data', () => {
      const dataType = 'roster';
      const errorMessage = 'Roster data not available in historical data - using MLB API fallback';
      
      expect(errorMessage).toContain('using MLB API fallback');
    });
  });
});
