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

import { getModelComparison } from '../controllers/football-compare.controller';

import { cacheGet } from '../middleware/responseCache.middleware';
import { loadControl, controlPrefix } from '../middleware/modelControl.middleware';

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
  compare: 900,
} as const;

// Routes that can serve a model the control plane may hide: the control version joins the
// key and browser/edge max-age is capped at 60 s (server TTL unchanged).
const CONTROL_MAX_AGE = 60;
const controlled = (ttl: number, prefix: string) => [
  loadControl(),
  cacheGet({ ttl, prefix: controlPrefix(prefix), maxAge: CONTROL_MAX_AGE }),
];

const router = Router({ mergeParams: true });

// accuracy must be declared before the bare /predictions route so it is not shadowed
router.get('/:sport/predictions/accuracy', ...controlled(TTL.accuracy, 'ftbl:acc'), getAccuracy);
router.get('/:sport/predictions/diagnostics', ...controlled(TTL.diagnostics, 'ftbl:diag'), getDiagnostics);
router.get('/:sport/predictions', ...controlled(TTL.predictions, 'ftbl:preds'), getPredictions);
// Side-by-side model comparison (experiment): every model's pregame prediction per
// game plus a season scoreboard. Same TTL as predictions, which move in-week.
router.get('/:sport/models/compare', ...controlled(TTL.compare, 'ftbl:cmp'), getModelComparison);
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
