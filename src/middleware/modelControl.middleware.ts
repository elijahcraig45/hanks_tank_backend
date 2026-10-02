/**
 * Loads the model control state for the request's sport BEFORE cacheGet runs, so the
 * control `version` can be part of the response-cache key: a hide or a relabel makes
 * every instance miss its cache within the control TTL instead of serving the old
 * body until the response TTL runs out.
 *
 * Never fails a request. getControl already fails open; a throw here would still be
 * swallowed.
 */

import { Request, Response, NextFunction } from 'express';
import { ControlState, getControl, unavailable } from '../services/model-control.service';

export function loadControl(sportOf: (req: Request) => string = (req) => String(req.params.sport || '')) {
  return async function loadControlMiddleware(req: Request, _res: Response, next: NextFunction) {
    try {
      (req as any).modelControl = await getControl(sportOf(req));
    } catch {
      (req as any).modelControl = unavailable();
    }
    next();
  };
}

/** A cacheGet `prefix` that carries the control version. 'none' when control is off. */
export const controlOf = (req: Request): ControlState => (req as any).modelControl || unavailable();

export const controlPrefix = (base: string) => (req?: Request): string =>
  `${base}:cv=${(req as any)?.modelControl?.version ?? 'none'}`;

/** The control state a handler should use: the one loaded for cache keying, else a fresh read. */
export async function controlForRequest(req: Request, sport: string): Promise<ControlState> {
  const loaded = (req as any).modelControl as ControlState | undefined;
  return loaded || getControl(sport);
}
