/**
 * Applies the model control state (services/model-control.service) to a model registry.
 *
 * Works on both registries (config/models.config MODELS and the legacy
 * config/football-models.config COMPARE_MODELS), and on any list keyed by `key`.
 *
 *   hidden (site_visible=false)  removed
 *   display_label / public_note  replace label / note (note goes in `noteOverride`, which
 *                                the status builders prefer over their own derived note)
 *   sort_order                   lower first; a model with none keeps its registry
 *                                position as its order (0, 1, 2 ...); ties keep registry
 *                                order (stable)
 *
 * With no control (available:false) or nothing to change, the SAME array is returned, so
 * the fail-open path is identical to what existed before, not merely equal.
 */

import type { ControlState } from '../services/model-control.service';

/** The production key: the spine of the slate / compare pages. */
export const PRODUCTION_KEY: Record<string, string> = { mlb: 'v10', nfl: 'xgb', cfb: 'xgb' };

export interface Keyed { key: string; label?: string; labelOverride?: string; note?: string; noteOverride?: string }

export function hiddenKeys(control: ControlState | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!control?.available) return out;
  for (const [k, v] of Object.entries(control.models)) if (v.visible === false) out.add(k);
  return out;
}

export function isHidden(control: ControlState | null | undefined, key: string): boolean {
  return Boolean(control?.available && control.models[key]?.visible === false);
}

export function isProductionHidden(control: ControlState | null | undefined, sport: string): boolean {
  const k = PRODUCTION_KEY[sport];
  return Boolean(k) && isHidden(control, k);
}

/** Stable sort by sort_order (registry position where unset). Same array if nothing sets one. */
export function orderByControl<T extends { key: string }>(items: T[], control: ControlState | null | undefined): T[] {
  if (!control?.available) return items;
  if (!items.some((m) => control.models[m.key]?.sortOrder !== undefined)) return items;
  return items
    .map((m, i) => ({ m, i, o: control.models[m.key]?.sortOrder ?? i }))
    .sort((a, b) => (a.o - b.o) || (a.i - b.i))
    .map((x) => x.m);
}

export function applyControl<T extends Keyed>(models: T[], control: ControlState | null | undefined): T[] {
  if (!control?.available || !models.length) return models;
  const visible = models.filter((m) => !isHidden(control, m.key));
  const touched = visible.length !== models.length
    || visible.some((m) => control.models[m.key]?.label || control.models[m.key]?.note);
  const labelled = touched
    ? visible.map((m) => {
      const c = control.models[m.key];
      if (!c || (!c.label && !c.note)) return m;
      return {
        ...m,
        ...(c.label ? { label: c.label, labelOverride: c.label } : {}),
        ...(c.note ? { note: c.note, noteOverride: c.note } : {}),
      } as T;
    })
    : models;
  return orderByControl(labelled, control);
}

/** Label / note for a model that is not in a registry list (e.g. a derived market row). */
export function overrideFor(control: ControlState | null | undefined, key: string) {
  return control?.available ? control.models[key] : undefined;
}

/**
 * Prediction fields a hidden production model would otherwise leak through the legacy
 * per-game endpoints. Only fields already on the row are nulled (none are added).
 */
const PREDICTION_FIELDS = [
  'home_win_probability', 'away_win_probability', 'predicted_winner', 'confidence_tier',
  'model_version', 'predicted_at', 'prediction_correct', 'predicted_home_margin',
  'predicted_home_score', 'predicted_away_score', 'predicted_total',
];

export function maskPredictionRow<T extends Record<string, any>>(row: T): T & { hidden: true } {
  const out: Record<string, any> = { ...row };
  for (const f of PREDICTION_FIELDS) if (f in out) out[f] = null;
  out.hidden = true;
  return out as T & { hidden: true };
}

/** First model that can serve as the featured default: production, else first listed. */
export function featuredDefault(models: Array<{ key: string; role?: string }>): string | null {
  return models.find((m) => m.role === 'production')?.key ?? models[0]?.key ?? null;
}
