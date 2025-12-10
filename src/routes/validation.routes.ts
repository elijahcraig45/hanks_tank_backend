import { Router } from 'express';
import { dataValidationController } from '../controllers/data-validation.controller';

const router = Router();

/**
 * Data Validation Routes
 * 
 * These endpoints are called by Cloud Scheduler for automated data validation
 */

// Daily validation check
router.get('/daily-check', async (req, res) => {
  await dataValidationController.dailyCheck(req, res);
});

// Weekly full sync
router.get('/weekly-full', async (req, res) => {
  await dataValidationController.weeklyFullSync(req, res);
});

// End-of-season sync
router.get('/end-of-season', async (req, res) => {
  await dataValidationController.endOfSeasonSync(req, res);
});

// Monthly data integrity audit
router.get('/monthly-audit', async (req, res) => {
  await dataValidationController.monthlyAudit(req, res);
});

export default router;
