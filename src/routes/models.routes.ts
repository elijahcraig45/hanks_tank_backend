/**
 * The Models section, all sports: /api/models/:sport/compare and the MLB totals & props.
 *
 * /api/football/:sport/models/compare keeps its own handler and shape, because the
 * existing football page reads it; this is the sport-neutral successor.
 */

import { Router } from 'express';
import { cacheGet } from '../middleware/responseCache.middleware';
import { getModelsCompare, getMlbTotalsProps } from '../controllers/models.controller';

const router = Router({ mergeParams: true });

// Declared before /:sport/compare so "mlb/totals-props" is never read as a sport.
router.get('/mlb/totals-props', cacheGet({ ttl: 900, prefix: 'models:props' }), getMlbTotalsProps);
router.get('/:sport/compare', cacheGet({ ttl: 900, prefix: 'models:cmp' }), getModelsCompare);

export default router;
