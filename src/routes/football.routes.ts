/**
 * Football routes: /api/football/:sport/*  (sport = nfl | cfb)
 *
 * The older /api/nfl/* paths are aliased onto the same handlers in app.ts so anything
 * already pointing at them keeps working.
 */

import { Router } from 'express';
import {
  getPredictions,
  getAccuracy,
  searchTeamStats,
  searchGames,
  getRankings,
} from '../controllers/football.controller';

const router = Router({ mergeParams: true });

// accuracy must be declared before the bare /predictions route so it is not shadowed
router.get('/:sport/predictions/accuracy', getAccuracy);
router.get('/:sport/predictions', getPredictions);
router.get('/:sport/rankings', getRankings);
router.get('/:sport/stats/teams', searchTeamStats);
router.get('/:sport/stats/games', searchGames);

export default router;
