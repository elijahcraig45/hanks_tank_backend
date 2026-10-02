/**
 * Legacy Routes - Backward compatibility for existing frontend
 * Maps legacy endpoints to new hybrid data architecture
 */

import { Router } from 'express';
import { legacyController } from '../controllers/legacy.controller';
import { getSchedulerHealth } from '../controllers/pipeline-health.controller';
import { cacheGet } from '../middleware/responseCache.middleware';
import { config } from '../config/app';

const router = Router();

// Player and leaderboard reads are the same for everyone and change at most daily, but had no
// Cache-Control, so every repeat visit, crawler render and link preview reached an App Engine
// instance and kept it billed. Live game surfaces (/games, /games/:gamePk) are left uncached on
// purpose. The in-process store is per instance; the header is what Google's frontend shares.
const playerCache = cacheGet({ ttl: config.cache.ttl.players, prefix: 'legacy:player' });
const statsCache = cacheGet({ ttl: config.cache.ttl.stats, prefix: 'legacy:stats' });

// Team Statistics Endpoints
router.get('/teamBatting', legacyController.getTeamBatting.bind(legacyController));
router.get('/TeamPitching', legacyController.getTeamPitching.bind(legacyController));

// New Team Leaderboard Endpoints (Phase 1)
router.get('/team-batting', legacyController.getTeamBatting.bind(legacyController));
router.get('/team-pitching', legacyController.getTeamPitching.bind(legacyController));

// Team Statistics Available Stats
router.get('/teamBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/TeamBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/TeamPitching/avaliableStats', legacyController.getAvailableStats.bind(legacyController));

// Player Statistics Endpoints
router.get('/PlayerBatting', statsCache, legacyController.getPlayerBatting.bind(legacyController));
router.get('/PlayerPitching', statsCache, legacyController.getPlayerPitching.bind(legacyController));

// New Player Leaderboard Endpoints (Phase 1)
router.get('/player-batting', statsCache, legacyController.getPlayerBatting.bind(legacyController));
router.get('/player-pitching', statsCache, legacyController.getPlayerPitching.bind(legacyController));

// Player Statistics Available Stats
router.get('/PlayerBatting/avaliableStats', legacyController.getAvailableStats.bind(legacyController));
router.get('/PlayerPitching/avaliableStats', legacyController.getAvailableStats.bind(legacyController));

// League Data
router.get('/Standings', legacyController.getStandings.bind(legacyController));

// Live game surfaces
router.get('/games', legacyController.getGames.bind(legacyController));
router.get('/games/:gamePk', legacyController.getGameDetails.bind(legacyController));

// FanGraphs Integration
router.get('/playerData', legacyController.getPlayerData.bind(legacyController));
router.get('/statcast', statsCache, legacyController.getStatcast.bind(legacyController));
router.get('/splits', statsCache, legacyController.getSplits.bind(legacyController));
router.get('/players/:playerId/profile', playerCache, legacyController.getPlayerProfile.bind(legacyController));
router.get('/players/:playerId/game-log', playerCache, legacyController.getPlayerGameLog.bind(legacyController));

// Team Data (aggregated)
router.get('/teamData', legacyController.getTeamData.bind(legacyController));

// News Endpoints
router.get('/mlb-news', legacyController.getMLBNews.bind(legacyController));
router.get('/braves-news', legacyController.getBravesNews.bind(legacyController));
router.post('/news/refresh', legacyController.refreshNews.bind(legacyController));

// Pipeline health. Reports how old each league's newest prediction is, not
// just which in-process cron tasks are registered - the MLB and six football
// jobs are Cloud Scheduler and were never visible here at all.
router.get('/health/scheduler', getSchedulerHealth);

export default router;
