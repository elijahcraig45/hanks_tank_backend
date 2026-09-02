/**
 * Pick'em routes: /api/pickem/*
 *
 * Reading is public — the sheet and the leaderboard are meant to be shareable with
 * people who have not signed in. Writing requires a verified Google token.
 *
 * `attachUser` runs on the public reads rather than `requireUser` so a signed-in
 * visitor gets their own picks merged into the sheet in the same request, while an
 * anonymous one still sees the games.
 */

import { Router } from 'express';
import { attachUser, requireUser } from '../middleware/auth.middleware';
import {
  getWeekGames,
  submitPicks,
  getLeaderboard,
  getMyPicks,
  getConfig,
} from '../controllers/pickem.controller';

import { cacheGet } from '../middleware/responseCache.middleware';

/**
 * The sheet's TTL is deliberately short. Its `locked` flag comes from the server clock,
 * so a longer one would show a game as open for that long after kickoff. Submitting
 * re-checks the lock against the table, so the worst case is a briefly stale button and
 * never an accepted late pick.
 */
const TTL = { games: 30, leaderboard: 120, me: 60 } as const;

const router = Router();

// Deliberately uncached. It touches no BigQuery, so caching buys nothing, and its
// answer depends on a Secret Manager lookup whose negative result is already held for a
// minute — stacking a response cache on top is how sign-in stayed switched off for
// minutes after the client id was actually added.
router.get('/config', getConfig);
router.get('/games', attachUser, cacheGet({ ttl: TTL.games, prefix: 'pk:games' }), getWeekGames);
router.get('/leaderboard', attachUser, cacheGet({ ttl: TTL.leaderboard, prefix: 'pk:board' }), getLeaderboard);
router.get('/me', requireUser, cacheGet({ ttl: TTL.me, prefix: 'pk:me' }), getMyPicks);
router.put('/picks', requireUser, submitPicks);

export default router;
