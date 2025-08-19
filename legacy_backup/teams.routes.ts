// Teams Routes - Simplified version
import { Router } from 'express';
import { TeamsController } from '../controllers/teams.controller';

const router = Router();

// GET /api/teams - Get all MLB teams
router.get('/', TeamsController.getAllTeams);

// GET /api/teams/:id - Get specific team details
router.get('/:id', TeamsController.getTeamById);

// GET /api/teams/:id/roster - Get team roster
router.get('/:id/roster', TeamsController.getTeamRoster);

// GET /api/teams/:id/stats - Get team statistics
router.get('/:id/stats', TeamsController.getTeamStats);

// GET /api/teams/:id/schedule - Get team schedule
router.get('/:id/schedule', TeamsController.getTeamSchedule);

export default router;
