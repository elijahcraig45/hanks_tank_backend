/**
 * Transactions Routes
 * API endpoints for MLB transactions data
 */

import { Router } from 'express';
import { TransactionsController } from '../controllers/transactions.controller';

const router = Router();

// Get all transactions with optional filters
router.get('/', TransactionsController.getTransactions);

// Get recent transactions (last 30 days)
router.get('/recent', TransactionsController.getRecentTransactions);

// Get transactions for a specific year
router.get('/year/:year', TransactionsController.getTransactionsByYear);

// Get transactions for a specific team
router.get('/team/:teamId', TransactionsController.getTeamTransactions);

// Get transaction type breakdown for a team
router.get('/team/:teamId/breakdown', TransactionsController.getTransactionBreakdown);

export default router;
