/**
 * GET /api/site-status
 *
 * The one public read of the control plane's site-wide banners:
 *   { success, data: { generated_at, control_available,
 *       sports: { mlb: { banner: {text, level} | null }, nfl: {...}, cfb: {...} } } }
 *
 * Read-only, plain text, and fail open: if the control data cannot be read the answer is
 * still 200 with control_available:false and no banners. It never throws.
 */

import { Request, Response } from 'express';
import { CONTROL_SPORTS, getAllControl } from '../services/model-control.service';

export async function getSiteStatus(_req: Request, res: Response): Promise<void> {
  let sports: Record<string, { banner: { text: string; level: string } | null }> = {};
  let available = false;
  try {
    const all = await getAllControl();
    for (const s of CONTROL_SPORTS) {
      const c = all[s];
      sports[s] = { banner: c?.banner ? { text: c.banner.text, level: c.banner.level } : null };
      if (c?.available) available = true;
    }
  } catch {
    sports = {};
    available = false;
  }
  for (const s of CONTROL_SPORTS) if (!sports[s]) sports[s] = { banner: null };
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    success: true,
    data: { generated_at: new Date().toISOString(), control_available: available, sports },
  });
}
