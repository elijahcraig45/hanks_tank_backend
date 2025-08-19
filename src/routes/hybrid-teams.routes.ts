import { Router } from 'express';
import { HybridTeamsController } from '../controllers/hybrid-teams.controller';

const router = Router();

// Hybrid data source routes (intelligent routing between historical/live data)
router.get('/', HybridTeamsController.getAllTeams);
router.get('/standings', HybridTeamsController.getStandings);
router.get('/news', HybridTeamsController.getNews);
router.get('/:id', HybridTeamsController.getTeamById);
router.get('/:id/roster', HybridTeamsController.getTeamRoster);
router.get('/:id/schedule', HybridTeamsController.getTeamSchedule);
router.get('/:id/stats', HybridTeamsController.getTeamStats);

// Administrative routes for data management
router.post('/admin/sync-historical', HybridTeamsController.syncHistoricalData);

// Direct MLB API access (for comparison and fallback)
router.get('/direct/:endpoint', HybridTeamsController.getDirectMLBData);

export default router;
