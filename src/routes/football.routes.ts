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
  getLeaders,
  searchPlayers,
  getDiagnostics,
} from '../controllers/football.controller';
// Rankings share one schema across every sport, so they share one controller; this
// path stays only so the football tab's existing URL keeps working.
import { getRankings } from '../controllers/rankings.controller';

const router = Router({ mergeParams: true });

// accuracy must be declared before the bare /predictions route so it is not shadowed
router.get('/:sport/predictions/accuracy', getAccuracy);
router.get('/:sport/predictions/diagnostics', getDiagnostics);
router.get('/:sport/predictions', getPredictions);
router.get('/:sport/rankings', getRankings);
router.get('/:sport/stats/teams', searchTeamStats);
router.get('/:sport/stats/leaders', getLeaders);
router.get('/:sport/stats/players', searchPlayers);
router.get('/:sport/stats/games', searchGames);

export default router;
