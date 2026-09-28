/**
 * Sport-neutral power rankings: /api/rankings/:sport (nfl | cfb | mlb), plus
 * /api/rankings/:sport/compare?a=&b= for why one team rates above another.
 *
 * /api/football/:sport/rankings delegates to the same handler so the football tab's
 * existing URL keeps working.
 */

import { Router } from 'express';
import { cacheGet } from '../middleware/responseCache.middleware';
import { compareRankings, getRankings } from '../controllers/rankings.controller';

const router = Router({ mergeParams: true });

// Registered before '/:sport' for readability; the two paths cannot collide.
router.get('/:sport/compare', cacheGet({ ttl: 3600, prefix: 'rankcmp' }), compareRankings);
router.get('/:sport', cacheGet({ ttl: 3600, prefix: 'rank' }), getRankings);

export default router;
