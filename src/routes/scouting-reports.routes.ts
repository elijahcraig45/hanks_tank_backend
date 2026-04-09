import { Router } from 'express';
import { scoutingReportsController } from '../controllers/scouting-reports.controller';

const router = Router();

// GET /api/scouting-reports?date=YYYY-MM-DD
router.get('/', (req, res) => scoutingReportsController.getReports(req, res));

// GET /api/scouting-reports/:gamePk
router.get('/:gamePk', (req, res) => scoutingReportsController.getReportByGame(req, res));

export default router;
