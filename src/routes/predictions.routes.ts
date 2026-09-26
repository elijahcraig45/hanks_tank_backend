/**
 * Predictions Routes
 */

import { Router } from 'express';
import { predictionsController } from '../controllers/predictions.controller';
import { getSlate, getPlayers } from '../controllers/unified-predictions.controller';

const router = Router();

// GET /api/predictions?date=YYYY-MM-DD
router.get('/', predictionsController.getPredictions.bind(predictionsController));

// GET /api/predictions/diagnostics?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/diagnostics', predictionsController.getPredictionDiagnostics.bind(predictionsController));

// Unified predictions (every model per game, one shape for mlb | nfl | cfb). Two path
// segments, so neither can be captured by /:gamePk; declared first all the same. They
// cache in the controller: the TTL depends on whether the slate is past or upcoming.
// GET /api/predictions/:sport/slate?date= | ?season=&week=&division=  [&format=csv|json]
router.get('/:sport/slate', getSlate);
// GET /api/predictions/:sport/players?date= | ?game_id=  [&format=csv|json]
router.get('/:sport/players', getPlayers);

// GET /api/predictions/:gamePk
router.get('/:gamePk', predictionsController.getPredictionByGame.bind(predictionsController));

export default router;
