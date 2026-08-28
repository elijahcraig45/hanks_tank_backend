/**
 * NFL routes — predictions, accuracy vs baselines, and searchable stats.
 */

import { Router } from 'express';
import {
  getNflPredictions,
  getNflAccuracy,
  searchNflTeamStats,
  searchNflGames,
} from '../controllers/nfl-predictions.controller';

const router = Router();

router.get('/predictions', getNflPredictions);
router.get('/predictions/accuracy', getNflAccuracy);
router.get('/stats/teams', searchNflTeamStats);
router.get('/stats/games', searchNflGames);

export default router;
