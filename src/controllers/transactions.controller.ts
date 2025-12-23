/**
 * Transactions Controller
 * Handles HTTP requests for MLB transactions data
 */

import { Request, Response } from 'express';
import { transactionsService } from '../services/transactions.service';
import { logger } from '../utils/logger';

export class TransactionsController {
  /**
   * Get all transactions with optional filters
   * GET /api/transactions?teamId=144&startDate=2025-01-01&endDate=2025-12-31
   */
  static async getTransactions(req: Request, res: Response): Promise<void> {
    try {
      const { teamId, playerId, startDate, endDate } = req.query;
      
      const filters: any = {};
      if (teamId) filters.teamId = parseInt(teamId as string);
      if (playerId) filters.playerId = parseInt(playerId as string);
      if (startDate) filters.startDate = startDate as string;
      if (endDate) filters.endDate = endDate as string;
      
      const transactions = await transactionsService.getTransactions(filters);
      
      res.json({
        success: true,
        data: transactions,
        meta: {
          count: transactions.length,
          filters,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getTransactions controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch transactions'
        }
      });
    }
  }
  
  /**
   * Get transactions for a specific team
   * GET /api/transactions/team/:teamId?startDate=2025-01-01&endDate=2025-12-31
   */
  static async getTeamTransactions(req: Request, res: Response): Promise<void> {
    try {
      const teamId = parseInt(req.params.teamId);
      const { startDate, endDate } = req.query;
      
      if (isNaN(teamId)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TEAM_ID',
            message: 'Team ID must be a number'
          }
        });
        return;
      }
      
      const transactions = await transactionsService.getTeamTransactions(
        teamId,
        startDate as string | undefined,
        endDate as string | undefined
      );
      
      res.json({
        success: true,
        data: transactions,
        meta: {
          teamId,
          count: transactions.length,
          startDate,
          endDate,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getTeamTransactions controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch team transactions'
        }
      });
    }
  }
  
  /**
   * Get recent transactions (last 30 days)
   * GET /api/transactions/recent
   */
  static async getRecentTransactions(req: Request, res: Response): Promise<void> {
    try {
      const transactions = await transactionsService.getRecentTransactions();
      
      res.json({
        success: true,
        data: transactions,
        meta: {
          count: transactions.length,
          period: 'last 30 days',
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getRecentTransactions controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch recent transactions'
        }
      });
    }
  }
  
  /**
   * Get transactions for a specific year
   * GET /api/transactions/year/:year
   */
  static async getTransactionsByYear(req: Request, res: Response): Promise<void> {
    try {
      const year = parseInt(req.params.year);
      
      if (isNaN(year) || year < 2000 || year > 2030) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_YEAR',
            message: 'Year must be between 2000 and 2030'
          }
        });
        return;
      }
      
      const transactions = await transactionsService.getTransactionsByYear(year);
      
      res.json({
        success: true,
        data: transactions,
        meta: {
          year,
          count: transactions.length,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getTransactionsByYear controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch transactions by year'
        }
      });
    }
  }
  
  /**
   * Get transaction type breakdown for a team
   * GET /api/transactions/team/:teamId/breakdown?startDate=2025-01-01&endDate=2025-12-31
   */
  static async getTransactionBreakdown(req: Request, res: Response): Promise<void> {
    try {
      const teamId = parseInt(req.params.teamId);
      const { startDate, endDate } = req.query;
      
      if (isNaN(teamId)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TEAM_ID',
            message: 'Team ID must be a number'
          }
        });
        return;
      }
      
      const breakdown = await transactionsService.getTransactionTypeBreakdown(
        teamId,
        startDate as string | undefined,
        endDate as string | undefined
      );
      
      // Convert Map to object for JSON response
      const breakdownObj = Object.fromEntries(breakdown);
      
      res.json({
        success: true,
        data: breakdownObj,
        meta: {
          teamId,
          startDate,
          endDate,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getTransactionBreakdown controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch transaction breakdown'
        }
      });
    }
  }

  /**
   * Get transactions for a specific player
   * GET /api/transactions/player/:playerId?startDate=2025-01-01&endDate=2025-12-31
   */
  static async getPlayerTransactions(req: Request, res: Response): Promise<void> {
    try {
      const playerId = parseInt(req.params.playerId);
      const { startDate, endDate } = req.query;
      
      if (isNaN(playerId)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PLAYER_ID',
            message: 'Player ID must be a number'
          }
        });
        return;
      }
      
      const filters: any = { playerId };
      if (startDate) filters.startDate = startDate as string;
      if (endDate) filters.endDate = endDate as string;
      
      const transactions = await transactionsService.getTransactions(filters);
      
      res.json({
        success: true,
        data: transactions,
        meta: {
          playerId,
          count: transactions.length,
          startDate,
          endDate,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error in getPlayerTransactions controller', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to fetch player transactions'
        }
      });
    }
  }
}
