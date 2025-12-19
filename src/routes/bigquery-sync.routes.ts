/**
 * BigQuery Sync Routes
 * API endpoints for managing BigQuery data synchronization
 */

import { Router } from 'express';
import { bigQuerySyncController } from '../controllers/bigquery-sync.controller';

const router = Router();

// Get sync status for all tables
router.get('/status', bigQuerySyncController.getSyncStatus.bind(bigQuerySyncController));

// Sync all missing data
router.post('/missing', bigQuerySyncController.syncMissingData.bind(bigQuerySyncController));

// Sync specific tables by year
router.post('/teams/:year', bigQuerySyncController.syncTeams.bind(bigQuerySyncController));
router.post('/team-stats/:year', bigQuerySyncController.syncTeamStats.bind(bigQuerySyncController));
router.post('/player-stats/:year', bigQuerySyncController.syncPlayerStats.bind(bigQuerySyncController));
router.post('/standings/:year', bigQuerySyncController.syncStandings.bind(bigQuerySyncController));
router.post('/rosters/:year', bigQuerySyncController.syncRosters.bind(bigQuerySyncController));
router.post('/games/:year', bigQuerySyncController.syncGames.bind(bigQuerySyncController));

// Task handler endpoint for Cloud Tasks (called by GCP task queue)
// IMPORTANT: This must come BEFORE /statcast/:year to avoid route collision
router.post('/statcast/process-task', bigQuerySyncController.processStatcastTask.bind(bigQuerySyncController));
router.post('/statcast/:year', bigQuerySyncController.syncStatcast.bind(bigQuerySyncController));

export default router;
