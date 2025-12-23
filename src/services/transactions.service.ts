/**
 * MLB Transactions Service
 * Handles fetching and managing MLB transactions (trades, signings, releases, etc.)
 * Data includes historical transactions (2015-2025) and current transactions
 */

import axios from 'axios';
import https from 'https';
import { logger } from '../utils/logger';
import { cacheService } from './cache.service';
import { CacheKeys } from '../utils/cache-keys';

export interface Transaction {
  id?: number;
  date: string;
  typeCode: string;
  typeDesc: string;
  description: string;
  fromTeam?: {
    id: number;
    name: string;
    abbreviation: string;
  };
  toTeam?: {
    id: number;
    name: string;
    abbreviation: string;
  };
  person: {
    id: number;
    fullName: string;
    link: string;
  };
  resolution?: string;
  notes?: string;
}

export interface TransactionFilters {
  teamId?: number;
  playerId?: number;
  startDate?: string;
  endDate?: string;
  transactionType?: string;
}

class TransactionsService {
  private baseUrl = 'https://statsapi.mlb.com/api/v1';
  
  /**
   * Get transactions with optional filters
   * @param filters - Optional filters for transactions
   */
  async getTransactions(filters: TransactionFilters = {}): Promise<Transaction[]> {
    try {
      const params: any = {};
      
      if (filters.teamId) params.teamId = filters.teamId;
      if (filters.playerId) params.playerId = filters.playerId;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      
      const cacheKey = CacheKeys.transactions(params);
      
      // Check cache first
      const cached = await cacheService.get<Transaction[]>(cacheKey);
      if (cached) {
        logger.info('Transactions cache hit', { filters });
        return cached;
      }
      
      // Fetch from MLB API
      logger.info('Fetching transactions from MLB API', { filters });
      const response = await axios.get(`${this.baseUrl}/transactions`, {
        params,
        timeout: 10000,
        httpsAgent: new https.Agent({
          rejectUnauthorized: false
        })
      } as any);
      
      const transactions = this.parseTransactions(response.data);
      
      // Cache for 1 hour (transactions don't change frequently)
      await cacheService.set(cacheKey, transactions, 3600);
      
      logger.info('Transactions fetched successfully', { 
        count: transactions.length,
        filters 
      });
      
      return transactions;
    } catch (error) {
      logger.error('Error fetching transactions', {
        error: error instanceof Error ? error.message : 'Unknown error',
        filters
      });
      throw error;
    }
  }
  
  /**
   * Get transactions for a specific team
   * @param teamId - MLB team ID
   * @param startDate - Optional start date (YYYY-MM-DD)
   * @param endDate - Optional end date (YYYY-MM-DD)
   */
  async getTeamTransactions(
    teamId: number, 
    startDate?: string, 
    endDate?: string
  ): Promise<Transaction[]> {
    return this.getTransactions({ teamId, startDate, endDate });
  }
  
  /**
   * Get transactions for a date range (for historical data collection)
   * @param startDate - Start date (YYYY-MM-DD)
   * @param endDate - End date (YYYY-MM-DD)
   */
  async getTransactionsByDateRange(
    startDate: string,
    endDate: string
  ): Promise<Transaction[]> {
    return this.getTransactions({ startDate, endDate });
  }
  
  /**
   * Get recent transactions (last 30 days)
   */
  async getRecentTransactions(): Promise<Transaction[]> {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    
    return this.getTransactions({ startDate, endDate });
  }
  
  /**
   * Get transactions for a specific year
   * @param year - Year to fetch transactions for
   */
  async getTransactionsByYear(year: number): Promise<Transaction[]> {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    
    return this.getTransactions({ startDate, endDate });
  }
  
  /**
   * Get transactions for multiple years (for batch historical collection)
   * @param years - Array of years to fetch
   */
  async getTransactionsForYears(years: number[]): Promise<Map<number, Transaction[]>> {
    const results = new Map<number, Transaction[]>();
    
    for (const year of years) {
      try {
        logger.info(`Fetching transactions for year ${year}`);
        const transactions = await this.getTransactionsByYear(year);
        results.set(year, transactions);
        
        // Add delay to avoid rate limiting
        await this.delay(1000);
      } catch (error) {
        logger.error(`Error fetching transactions for year ${year}`, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        results.set(year, []);
      }
    }
    
    return results;
  }
  
  /**
   * Parse MLB API transaction response
   */
  private parseTransactions(data: any): Transaction[] {
    if (!data || !data.transactions) {
      return [];
    }
    
    return data.transactions.map((t: any) => ({
      id: t.id,
      date: t.date,
      typeCode: t.typeCode,
      typeDesc: t.typeDesc,
      description: t.description,
      fromTeam: t.fromTeam ? {
        id: t.fromTeam.id,
        name: t.fromTeam.name,
        abbreviation: t.fromTeam.abbreviation || t.fromTeam.teamCode
      } : undefined,
      toTeam: t.toTeam ? {
        id: t.toTeam.id,
        name: t.toTeam.name,
        abbreviation: t.toTeam.abbreviation || t.toTeam.teamCode
      } : undefined,
      person: t.person ? {
        id: t.person.id,
        fullName: t.person.fullName,
        link: t.person.link
      } : { id: 0, fullName: 'Unknown', link: '' },
      resolution: t.resolution,
      notes: t.notes
    })).filter((t: Transaction) => t.person.id !== 0);
  }
  
  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get transaction type breakdown for a team
   * @param teamId - MLB team ID
   * @param startDate - Optional start date
   * @param endDate - Optional end date
   */
  async getTransactionTypeBreakdown(
    teamId: number,
    startDate?: string,
    endDate?: string
  ): Promise<Map<string, number>> {
    const transactions = await this.getTeamTransactions(teamId, startDate, endDate);
    const breakdown = new Map<string, number>();
    
    transactions.forEach(t => {
      const count = breakdown.get(t.typeDesc) || 0;
      breakdown.set(t.typeDesc, count + 1);
    });
    
    return breakdown;
  }
}

export const transactionsService = new TransactionsService();
