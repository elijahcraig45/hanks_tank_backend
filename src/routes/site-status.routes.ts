/** GET /api/site-status: site-wide banners from the model control plane (read-only). */

import { Router } from 'express';
import { getSiteStatus } from '../controllers/site-status.controller';

const router = Router();
router.get('/', getSiteStatus);

export default router;
