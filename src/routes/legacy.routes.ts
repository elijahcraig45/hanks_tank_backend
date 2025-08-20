/**
 * Legacy Routes - Backward compatibility for existing frontend
 * Maps legacy endpoints to new hybrid data architecture
 */

import { Router } from 'express';
import { legacyController } from '../controllers/legacy.controller';

const router = Router();

// Team Statistics Endpoints
router.get('/teamBatting', legacyController.getTeamBatting.bind(legacyController));
router.get('/TeamPitching', legacyController.getTeamPitching.bind(legacyController));

// Team Statistics Available Stats
router.get('/teamBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/TeamBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/TeamPitching/avaliableStats', legacyController.getAvailableStats.bind(legacyController));

// Player Statistics Endpoints
router.get('/PlayerBatting', legacyController.getPlayerBatting.bind(legacyController));
router.get('/PlayerPitching', legacyController.getPlayerPitching.bind(legacyController));

// Player Statistics Available Stats
router.get('/PlayerBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/PlayerPitching/avaliableStats', legacyController.getAvailableStats.bind(legacyController));

// League Data
router.get('/Standings', legacyController.getStandings.bind(legacyController));

// FanGraphs Integration
router.get('/playerData', legacyController.getPlayerData.bind(legacyController));
router.get('/statcast', legacyController.getStatcast.bind(legacyController));

// Team Data (aggregated)
router.get('/teamData', legacyController.getTeamData.bind(legacyController));

// News Endpoints
router.get('/mlb-news', legacyController.getMLBNews.bind(legacyController));
router.get('/braves-news', legacyController.getBravesNews.bind(legacyController));
router.post('/news/refresh', legacyController.refreshNews.bind(legacyController));

// Health check with scheduler status
router.get('/health/scheduler', (req, res) => {
  const { schedulerService } = require('../services/scheduler.service');
  res.json({
    status: 'ok',
    scheduler: {
      jobs: schedulerService.getJobStatus(),
      timestamp: new Date().toISOString()
    }
  });
});

export default router;
