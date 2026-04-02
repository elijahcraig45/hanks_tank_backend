/**
 * Predictions Routes
 */

import { Router } from 'express';
import { predictionsController } from '../controllers/predictions.controller';

const router = Router();

// GET /api/predictions?date=YYYY-MM-DD
router.get('/', predictionsController.getPredictions.bind(predictionsController));

// GET /api/predictions/:gamePk
router.get('/:gamePk', predictionsController.getPredictionByGame.bind(predictionsController));

export default router;
