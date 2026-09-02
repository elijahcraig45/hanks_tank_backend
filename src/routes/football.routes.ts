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
import {
  searchTeamSeasonStats,
  getTeams,
} from '../controllers/football-stats.controller';
import {
  getScoreboard,
  getSchedule,
  getGameDetail,
} from '../controllers/football-games.controller';

import { cacheGet } from '../middleware/responseCache.middleware';

/**
 * TTLs chosen from how often the pipeline rewrites each table, not from traffic.
 * Predictions move in-week as lines and rosters do; a season's stat tables are
 * rewritten weekly; team metadata changes about once a year.
 */
const TTL = {
  predictions: 900,
  accuracy: 3600,
  diagnostics: 900,
  teamStats: 3600,
  leaders: 3600,
  players: 1800,
  games: 3600,
  teams: 86400,
} as const;

const router = Router({ mergeParams: true });

// accuracy must be declared before the bare /predictions route so it is not shadowed
router.get('/:sport/predictions/accuracy', cacheGet({ ttl: TTL.accuracy, prefix: 'ftbl:acc' }), getAccuracy);
router.get('/:sport/predictions/diagnostics', cacheGet({ ttl: TTL.diagnostics, prefix: 'ftbl:diag' }), getDiagnostics);
router.get('/:sport/predictions', cacheGet({ ttl: TTL.predictions, prefix: 'ftbl:preds' }), getPredictions);
router.get('/:sport/rankings', cacheGet({ ttl: TTL.teamStats, prefix: 'ftbl:rank' }), getRankings);
// season totals before the bare /stats/teams so the more specific path wins
router.get('/:sport/stats/teams/season', searchTeamSeasonStats);
router.get('/:sport/stats/teams', cacheGet({ ttl: TTL.teamStats, prefix: 'ftbl:twk' }), searchTeamStats);
router.get('/:sport/stats/leaders', cacheGet({ ttl: TTL.leaders, prefix: 'ftbl:lead' }), getLeaders);
router.get('/:sport/stats/players', cacheGet({ ttl: TTL.players, prefix: 'ftbl:plyr' }), searchPlayers);
router.get('/:sport/stats/games', cacheGet({ ttl: TTL.games, prefix: 'ftbl:games' }), searchGames);
router.get('/:sport/teams', getTeams);
// Live scoreboard and schedule. Declared before /games/:gameId so neither is captured
// as a game id, and kept distinct from /stats/games, which serves completed results
// out of BigQuery rather than the live feed.
router.get('/:sport/scoreboard', getScoreboard);
router.get('/:sport/schedule', getSchedule);
router.get('/:sport/games/:gameId', getGameDetail);

export default router;
