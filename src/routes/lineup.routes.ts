/**
 * Lineup Routes
 *
 * POST /api/lineup/schedule-task   — create a Cloud Task for a specific game
 * GET  /api/lineup/schedule-today  — schedule all of today's games
 */

import { Router } from 'express';
import { lineupController } from '../controllers/lineup.controller';

const router = Router();

// Create a Cloud Task for pre-game pipeline (called by ML Cloud Function)
router.post('/schedule-task', (req, res) => lineupController.scheduleTask(req, res));

// Schedule all of today's games (called by cron at ~10 AM ET)
router.get('/schedule-today', (req, res) => lineupController.scheduleToday(req, res));

export default router;
