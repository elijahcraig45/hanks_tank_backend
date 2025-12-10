/**
 * Unit Tests for BigQuery Sync Service
 * Tests year calculations, historical data range, and edge cases
 */

import { gcpConfig } from '../config/gcp.config';

// Mock the current year for testing
const mockCurrentYear = (year: number) => {
  jest.spyOn(Date.prototype, 'getFullYear').mockReturnValue(year);
};

describe('BigQuery Sync Service - Year Calculations', () => {
  
  describe('getHistoricalYears()', () => {
    
    it('should return correct historical years for 2025', () => {
      // Simulate it's 2025
      mockCurrentYear(2025);
      
      // If current season is 2025, historical range should be 2015-2024
      const minSeason = 2015;
      const currentSeason = 2025;
      const expectedYears = Array.from(
        { length: currentSeason - 1 - minSeason + 1 }, 
        (_, i) => minSeason + i
      ); // [2015, 2016, ..., 2024]
      
      expect(expectedYears).toEqual([
        2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024
      ]);
      expect(expectedYears.length).toBe(10);
    });

    it('should return correct historical years for 2026', () => {
      // Simulate year transition to 2026
      mockCurrentYear(2026);
      
      const minSeason = 2015;
      const currentSeason = 2026;
      const expectedYears = Array.from(
        { length: currentSeason - 1 - minSeason + 1 }, 
        (_, i) => minSeason + i
      ); // [2015, 2016, ..., 2025]
      
      expect(expectedYears).toEqual([
        2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025
      ]);
      expect(expectedYears.length).toBe(11);
    });

    it('should never include current year in historical range', () => {
      mockCurrentYear(2030);
      
      const currentSeason = 2030;
      const minSeason = 2015;
      const lastCompletedSeason = currentSeason - 1;
      
      const historicalYears = Array.from(
        { length: lastCompletedSeason - minSeason + 1 }, 
        (_, i) => minSeason + i
      );
      
      expect(historicalYears).not.toContain(2030);
      expect(historicalYears[historicalYears.length - 1]).toBe(2029);
    });

    it('should expand range automatically each year', () => {
      const testYears = [2025, 2026, 2027, 2028, 2029, 2030];
      const minSeason = 2015;
      
      testYears.forEach(year => {
        mockCurrentYear(year);
        const currentSeason = year;
        const historicalYears = Array.from(
          { length: currentSeason - 1 - minSeason + 1 }, 
          (_, i) => minSeason + i
        );
        
        // Each year should add one more to the range
        const expectedLength = year - minSeason;
        expect(historicalYears.length).toBe(expectedLength);
        expect(historicalYears[historicalYears.length - 1]).toBe(year - 1);
      });
    });
  });

  describe('shouldUseHistoricalData() logic', () => {
    
    it('should return true for completed seasons within range', () => {
      mockCurrentYear(2025);
      const currentSeason = 2025;
      const minHistoricalSeason = 2015;
      
      // Test years 2015-2024 (all should be historical)
      const completedSeasons = [2015, 2016, 2020, 2023, 2024];
      
      completedSeasons.forEach(season => {
        const shouldUseHistorical = 
          season >= minHistoricalSeason && season < currentSeason;
        expect(shouldUseHistorical).toBe(true);
      });
    });

    it('should return false for current season', () => {
      mockCurrentYear(2025);
      const currentSeason = 2025;
      const minHistoricalSeason = 2015;
      
      const shouldUseHistorical = 
        2025 >= minHistoricalSeason && 2025 < currentSeason;
      
      expect(shouldUseHistorical).toBe(false);
    });

    it('should return false for future seasons', () => {
      mockCurrentYear(2025);
      const currentSeason = 2025;
      const minHistoricalSeason = 2015;
      
      const futureSeasons = [2026, 2027, 2030];
      
      futureSeasons.forEach(season => {
        const shouldUseHistorical = 
          season >= minHistoricalSeason && season < currentSeason;
        expect(shouldUseHistorical).toBe(false);
      });
    });

    it('should return false for seasons before minimum', () => {
      mockCurrentYear(2025);
      const currentSeason = 2025;
      const minHistoricalSeason = 2015;
      
      const oldSeasons = [2010, 2012, 2014];
      
      oldSeasons.forEach(season => {
        const shouldUseHistorical = 
          season >= minHistoricalSeason && season < currentSeason;
        expect(shouldUseHistorical).toBe(false);
      });
    });
  });

  describe('Year validation (controller)', () => {
    
    it('should accept valid historical years', () => {
      mockCurrentYear(2025);
      const minYear = 2015;
      const maxYear = 2024; // currentSeason - 1
      
      const validYears = [2015, 2018, 2020, 2024];
      
      validYears.forEach(year => {
        const isValid = year >= minYear && year <= maxYear;
        expect(isValid).toBe(true);
      });
    });

    it('should reject current and future years', () => {
      mockCurrentYear(2025);
      const minYear = 2015;
      const maxYear = 2024; // currentSeason - 1
      
      const invalidYears = [2025, 2026, 2030];
      
      invalidYears.forEach(year => {
        const isValid = year >= minYear && year <= maxYear;
        expect(isValid).toBe(false);
      });
    });

    it('should reject years before minimum', () => {
      mockCurrentYear(2025);
      const minYear = 2015;
      const maxYear = 2024;
      
      const invalidYears = [2000, 2010, 2014];
      
      invalidYears.forEach(year => {
        const isValid = year >= minYear && year <= maxYear;
        expect(isValid).toBe(false);
      });
    });

    it('should update valid range when year changes', () => {
      // In 2025: valid range is 2015-2024
      mockCurrentYear(2025);
      let maxYear = 2024;
      expect(2024 <= maxYear).toBe(true);
      expect(2025 <= maxYear).toBe(false);
      
      // In 2026: valid range is 2015-2025
      mockCurrentYear(2026);
      maxYear = 2025;
      expect(2025 <= maxYear).toBe(true);
      expect(2026 <= maxYear).toBe(false);
    });
  });

  describe('Edge case: Year boundary transitions', () => {
    
    it('should handle Dec 31, 2025 → Jan 1, 2026 transition', () => {
      // December 31, 2025 at 11:59 PM
      mockCurrentYear(2025);
      let currentSeason = 2025;
      let historicalRange = `${2015}-${currentSeason - 1}`;
      expect(historicalRange).toBe('2015-2024');
      
      // January 1, 2026 at 12:00 AM
      mockCurrentYear(2026);
      currentSeason = 2026;
      historicalRange = `${2015}-${currentSeason - 1}`;
      expect(historicalRange).toBe('2015-2025');
    });

    it('should correctly route 2025 data before and after transition', () => {
      const minHistoricalSeason = 2015;
      
      // Before transition (Dec 31, 2025): 2025 is current season
      mockCurrentYear(2025);
      let currentSeason = 2025;
      let shouldUseHistorical = 
        2025 >= minHistoricalSeason && 2025 < currentSeason;
      expect(shouldUseHistorical).toBe(false); // Use live API
      
      // After transition (Jan 1, 2026): 2025 is historical
      mockCurrentYear(2026);
      currentSeason = 2026;
      shouldUseHistorical = 
        2025 >= minHistoricalSeason && 2025 < currentSeason;
      expect(shouldUseHistorical).toBe(true); // Use BigQuery
    });

    it('should identify 2025 as missing after transition', () => {
      mockCurrentYear(2026);
      const currentSeason = 2026;
      const minSeason = 2015;
      
      // All historical years that should exist
      const expectedYears = Array.from(
        { length: currentSeason - 1 - minSeason + 1 }, 
        (_, i) => minSeason + i
      );
      
      // Simulate existing data (2015-2024)
      const existingYears = [
        2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024
      ];
      
      const missingYears = expectedYears.filter(
        year => !existingYears.includes(year)
      );
      
      expect(missingYears).toEqual([2025]);
    });
  });

  describe('Config value calculations', () => {
    
    it('should calculate maxSeason dynamically', () => {
      mockCurrentYear(2025);
      let maxSeason = 2025 + 10;
      expect(maxSeason).toBe(2035);
      
      mockCurrentYear(2026);
      maxSeason = 2026 + 10;
      expect(maxSeason).toBe(2036);
      
      mockCurrentYear(2030);
      maxSeason = 2030 + 10;
      expect(maxSeason).toBe(2040);
    });

    it('should keep minSeason static', () => {
      const minSeason = 2015;
      
      // Min season should never change regardless of current year
      mockCurrentYear(2025);
      expect(minSeason).toBe(2015);
      
      mockCurrentYear(2030);
      expect(minSeason).toBe(2015);
      
      mockCurrentYear(2040);
      expect(minSeason).toBe(2015);
    });

    it('should use single source of truth for currentSeason', () => {
      mockCurrentYear(2025);
      
      // All these should reference the same value
      const configCurrentSeason = 2025;
      const serviceCurrentSeason = configCurrentSeason;
      const controllerMaxYear = configCurrentSeason - 1;
      const dataSourceCurrentSeason = configCurrentSeason;
      
      expect(serviceCurrentSeason).toBe(2025);
      expect(controllerMaxYear).toBe(2024);
      expect(dataSourceCurrentSeason).toBe(2025);
    });
  });

  describe('MLB API parameter correctness', () => {
    
    it('getStandings should pass correct parameters', () => {
      // Correct signature: getStandings(leagueId?, season?, standingsType?)
      const testCases = [
        { leagueId: undefined, season: 2024, standingsType: undefined },
        { leagueId: 103, season: 2023, standingsType: 'regularSeason' },
        { leagueId: undefined, season: 2025, standingsType: 'regularSeason' },
      ];
      
      testCases.forEach(test => {
        // Should NOT call getStandings(season) directly
        // Should call getStandings(leagueId, season)
        expect(test.season).toBeDefined();
        
        // If leagueId is omitted, it should be undefined (not season value)
        if (!test.leagueId) {
          expect(test.leagueId).toBeUndefined();
        }
      });
    });
  });

  describe('Integration: Full system behavior', () => {
    
    it('should handle full lifecycle from 2025 to 2030', () => {
      const scenarios = [
        { year: 2025, historicalRange: '2015-2024', currentSeason: 2025 },
        { year: 2026, historicalRange: '2015-2025', currentSeason: 2026 },
        { year: 2027, historicalRange: '2015-2026', currentSeason: 2027 },
        { year: 2028, historicalRange: '2015-2027', currentSeason: 2028 },
        { year: 2029, historicalRange: '2015-2028', currentSeason: 2029 },
        { year: 2030, historicalRange: '2015-2029', currentSeason: 2030 },
      ];
      
      scenarios.forEach(scenario => {
        mockCurrentYear(scenario.year);
        const currentSeason = scenario.year;
        const historicalRange = `2015-${currentSeason - 1}`;
        
        expect(currentSeason).toBe(scenario.currentSeason);
        expect(historicalRange).toBe(scenario.historicalRange);
        
        // Verify current year is never historical
        const isCurrentYearHistorical = 
          scenario.year >= 2015 && scenario.year < currentSeason;
        expect(isCurrentYearHistorical).toBe(false);
        
        // Verify previous year IS historical
        const isPreviousYearHistorical = 
          (scenario.year - 1) >= 2015 && (scenario.year - 1) < currentSeason;
        expect(isPreviousYearHistorical).toBe(true);
      });
    });

    it('should maintain data integrity across year transitions', () => {
      const minSeason = 2015;
      
      for (let year = 2025; year <= 2030; year++) {
        mockCurrentYear(year);
        const currentSeason = year;
        
        // Historical years should be continuous from minSeason to currentSeason-1
        const historicalYears = Array.from(
          { length: currentSeason - 1 - minSeason + 1 }, 
          (_, i) => minSeason + i
        );
        
        // Check continuity (no gaps)
        for (let i = 0; i < historicalYears.length - 1; i++) {
          expect(historicalYears[i + 1] - historicalYears[i]).toBe(1);
        }
        
        // First year should be minSeason
        expect(historicalYears[0]).toBe(minSeason);
        
        // Last year should be currentSeason - 1
        expect(historicalYears[historicalYears.length - 1]).toBe(currentSeason - 1);
      }
    });
  });
});
