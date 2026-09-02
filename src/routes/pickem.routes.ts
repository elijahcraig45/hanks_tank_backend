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

const router = Router();

router.get('/config', getConfig);
router.get('/games', attachUser, getWeekGames);
router.get('/leaderboard', attachUser, getLeaderboard);
router.get('/me', requireUser, getMyPicks);
router.put('/picks', requireUser, submitPicks);

export default router;
