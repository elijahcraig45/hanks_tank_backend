/**
 * Google sign-in verification.
 *
 * The browser signs in with Google Identity Services and gets an ID token — a JWT
 * Google signed. Every authenticated request carries it as a bearer token and this
 * verifies the signature, the issuer and the audience against Google's published keys.
 * There is no session store and no cookie: the token already carries an expiry and an
 * identity, so re-verifying it is cheaper and safer than minting a second credential to
 * keep in sync.
 *
 * Identity is keyed on the `sub` claim, never the email. A Google account's email can
 * change; its subject cannot, and keying on email would silently split or merge people's
 * pick history when it does.
 *
 * Verification results are cached briefly. Google's library fetches and caches the
 * signing certificates itself, but the RSA verify still costs a few milliseconds, and a
 * pick sheet fires several requests at once.
 */

import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../utils/logger';

export interface AuthUser {
  userId: string;       // Google `sub`
  email: string | null;
  displayName: string | null;
  pictureUrl: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * The web OAuth client ID. Both the audience this accepts and the ID the browser signs
 * in with, so they cannot drift apart.
 */
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

export function isAuthConfigured(): boolean {
  return Boolean(GOOGLE_CLIENT_ID);
}

const client = new OAuth2Client();

/** Short-lived verification cache, keyed on the token itself. */
const verified = new Map<string, { user: AuthUser; expires: number }>();
const CACHE_MS = 5 * 60 * 1000;

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of verified) {
    if (entry.expires <= now) verified.delete(token);
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Verify a Google ID token. Returns null rather than throwing, so callers decide
 * whether an anonymous request is an error or merely a reader.
 */
export async function verifyToken(token: string): Promise<AuthUser | null> {
  if (!GOOGLE_CLIENT_ID) return null;

  prune();
  const hit = verified.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) return null;

    // A token for an unverified email is a token for an address the holder may not own.
    if (payload.email && payload.email_verified === false) {
      logger.warn('rejected a token with an unverified email');
      return null;
    }

    const user: AuthUser = {
      userId: payload.sub,
      email: payload.email ?? null,
      displayName: payload.name ?? payload.given_name ?? null,
      pictureUrl: payload.picture ?? null,
    };

    // Never cached past the token's own expiry.
    const tokenExpiry = (payload.exp ?? 0) * 1000;
    verified.set(token, {
      user,
      expires: Math.min(Date.now() + CACHE_MS, tokenExpiry || Date.now() + CACHE_MS),
    });
    return user;
  } catch (error: any) {
    // Expected constantly: expired tokens, tokens for another audience. Logged at debug
    // so a real misconfiguration is not buried in routine noise.
    logger.debug('ID token verification failed', { error: error?.message });
    return null;
  }
}

/**
 * Attach `req.user` when a valid token is present, and continue either way.
 *
 * For the endpoints anyone may read — the pick sheet, the public leaderboard — where
 * being signed in changes what is shown but is not required to see anything.
 */
export async function attachUser(
  req: Request, _res: Response, next: NextFunction,
): Promise<void> {
  const token = bearer(req);
  if (token) {
    const user = await verifyToken(token);
    if (user) req.user = user;
  }
  next();
}

/** Require a signed-in user, or 401. */
export async function requireUser(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  if (!isAuthConfigured()) {
    // Distinguished from a bad token on purpose: this is the server's fault, not the
    // caller's, and the message says which so nobody debugs the wrong end.
    res.status(503).json({
      success: false,
      error: {
        code: 'AUTH_NOT_CONFIGURED',
        message: 'Sign-in is not configured on this server.',
      },
    });
    return;
  }

  const token = bearer(req);
  const user = token ? await verifyToken(token) : null;
  if (!user) {
    res.status(401).json({
      success: false,
      error: {
        code: 'SIGN_IN_REQUIRED',
        message: 'Sign in with Google to make picks.',
      },
    });
    return;
  }

  req.user = user;
  next();
}

/** Test seam. */
export function __clearVerificationCache(): void {
  verified.clear();
}
