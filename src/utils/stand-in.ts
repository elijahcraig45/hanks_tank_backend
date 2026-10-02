/**
 * Stand-in model: what the site headlines while the PRODUCTION model of a sport has been
 * hidden (site_visible=false) or paused (run_state=paused) by the control plane.
 *
 * Applies ONLY then, and only for MLB in this release. A production model that merely has
 * no rows never triggers it. See mllab docs/MODEL_CONTROL.md, "Stand-in model".
 *
 * Candidates: visible models, minus the production key and the derived models (elo,
 * market), that have predictions for the games being served. Choice: the lowest
 * season-to-date log loss (point estimate) on the games every candidate was scored on,
 * when there are at least STAND_IN_MIN_GAMES of them; otherwise the first eligible key of
 * STAND_IN_FIXED_ORDER. No candidate, no stand-in.
 *
 * Pure: no I/O. Its inputs (season games, registry, control) are all already cached, so
 * the choice only changes when the control version or the scoreboard data does.
 */

import type { ControlState } from '../services/model-control.service';
import { PRODUCTION_KEY, isHidden } from './model-overlay';
import { ScoredGame, commonGames, scoreModel } from './model-scoring';

export const STAND_IN_SPORTS = new Set(['mlb']);
export const STAND_IN_MIN_GAMES = 50;
export const STAND_IN_FIXED_ORDER = ['sim_blend', 'logit3'];
export const DERIVED_KEYS = new Set(['elo', 'market']);

export type StandInReason = 'production_hidden' | 'production_paused';

export interface StandIn {
  model: string;
  label: string;
  reason: StandInReason;
  basis: 'season_log_loss' | 'fixed_order';
  n_games: number | null;
}

/** Why the stand-in applies, or null when it must not. */
export function standInReason(control: ControlState | null | undefined, sport: string): StandInReason | null {
  if (!control?.available || !STAND_IN_SPORTS.has(sport)) return null;
  const prod = PRODUCTION_KEY[sport];
  if (!prod) return null;
  if (isHidden(control, prod)) return 'production_hidden';
  if (control.models[prod]?.paused) return 'production_paused';
  return null;
}

/** Keys a stand-in could come from, given the visible registry (already control-overlaid). */
export function standInCandidates(
  sport: string, registry: Array<{ key: string }>, served: Set<string>,
): string[] {
  const prod = PRODUCTION_KEY[sport];
  return registry.map((m) => m.key)
    .filter((k) => k !== prod && !DERIVED_KEYS.has(k) && served.has(k));
}

export function chooseStandIn(args: {
  sport: string;
  control: ControlState | null | undefined;
  /** Visible registry after applyControl (labels already overridden). */
  registry: Array<{ key: string; label: string }>;
  /** Model keys with a prediction on at least one served game. */
  served: Set<string>;
  /** The season's games with every candidate's picks (for log loss). */
  seasonGames: ScoredGame[];
}): StandIn | null {
  const reason = standInReason(args.control, args.sport);
  if (!reason) return null;
  const candidates = standInCandidates(args.sport, args.registry, args.served);
  if (!candidates.length) return null;
  const label = (k: string) => args.registry.find((m) => m.key === k)?.label ?? k;

  const common = commonGames(args.seasonGames, candidates)
    .filter((g) => candidates.every((k) => g.predictions[k]?.pregame));
  if (common.length >= STAND_IN_MIN_GAMES) {
    let best: { key: string; ll: number } | null = null;
    for (const k of candidates) {
      const ll = scoreModel(common, k, 0).log_loss?.value;
      if (ll != null && (!best || ll < best.ll)) best = { key: k, ll };
    }
    if (best) {
      return { model: best.key, label: label(best.key), reason, basis: 'season_log_loss', n_games: common.length };
    }
  }
  const key = STAND_IN_FIXED_ORDER.find((k) => candidates.includes(k));
  return key ? { model: key, label: label(key), reason, basis: 'fixed_order', n_games: null } : null;
}
