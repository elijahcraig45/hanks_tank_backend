/**
 * Football rest-of-season Monte Carlo (shadow): /api/season-sim/:sport (nfl | cfb),
 * /api/season-sim/:sport/team/:team (one team's remaining games) and
 * /api/season-sim/:sport/export.
 *
 * Caching lives in the controller rather than cacheGet: the CFB slice is past the
 * middleware's 256KB store cap, and the JSON view and both exports share one slice.
 */

import { Router } from 'express';
import { getSeasonSim, getSeasonSimTeam, exportSeasonSim } from '../controllers/season-sim.controller';

const router = Router({ mergeParams: true });

router.get('/:sport/export', exportSeasonSim);
router.get('/:sport/team/:team', getSeasonSimTeam);
router.get('/:sport', getSeasonSim);

export default router;
