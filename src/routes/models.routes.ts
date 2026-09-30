/**
 * The Models section, all sports: /api/models/:sport/compare and the MLB totals & props.
 *
 * /api/football/:sport/models/compare keeps its own handler and shape, because the
 * existing football page reads it; this is the sport-neutral successor.
 */

import { Router } from 'express';
import { cacheGet } from '../middleware/responseCache.middleware';
import { loadControl, controlPrefix } from '../middleware/modelControl.middleware';
import { getModelsCompare, getMlbTotalsProps } from '../controllers/models.controller';

const router = Router({ mergeParams: true });

// Declared before /:sport/compare so "mlb/totals-props" is never read as a sport.
// The control version is part of the key and browsers/edges hold the body for at most
// 60 s, so a hide from the control plane shows within about a minute (server TTL stays 900).
const CONTROL_MAX_AGE = 60;
router.get('/mlb/totals-props', loadControl(() => 'mlb'),
  cacheGet({ ttl: 900, prefix: controlPrefix('models:props'), maxAge: CONTROL_MAX_AGE }), getMlbTotalsProps);
router.get('/:sport/compare', loadControl(),
  cacheGet({ ttl: 900, prefix: controlPrefix('models:cmp'), maxAge: CONTROL_MAX_AGE }), getModelsCompare);

export default router;
