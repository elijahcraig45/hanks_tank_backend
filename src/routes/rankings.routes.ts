/**
 * Sport-neutral power rankings: /api/rankings/:sport (nfl | cfb | mlb).
 *
 * /api/football/:sport/rankings delegates to the same handler so the football tab's
 * existing URL keeps working.
 */

import { Router } from 'express';
import { getRankings } from '../controllers/rankings.controller';

const router = Router({ mergeParams: true });

router.get('/:sport', getRankings);

export default router;
