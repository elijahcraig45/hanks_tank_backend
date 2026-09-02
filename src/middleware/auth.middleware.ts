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
 * The web OAuth client ID: both the audience this verifies against and the ID the
 * browser signs in with, so the two cannot drift apart.
 *
 * Resolved from the environment first, then from Secret Manager. The second path exists
 * so adding sign-in needs no code change and no redeploy — create the OAuth client in
 * the console, store the id, and the next instance picks it up. It is not a secret (it
 * identifies the app, not a user, and the browser must have it), but Secret Manager is
 * the one config store this project already reads at runtime.
 */
const CLIENT_ID_SECRET = process.env.GOOGLE_CLIENT_ID_SECRET || 'google-oauth-client-id';
const SECRET_PROJECT = process.env.GCP_PROJECT_ID || 'hankstank';

let clientId: string | null | undefined;
let clientIdLoad: Promise<string | null> | null = null;
let clientIdRetryAfter = 0;

/**
 * How long to wait before re-reading a MISSING client id.
 *
 * A found id is cached for the life of the instance — it does not change. A missing one
 * must not be, and that distinction matters twice over: turning sign-in on would
 * otherwise require new instances rather than just storing the id, and a transient
 * Secret Manager failure at cold start would disable sign-in on that instance forever.
 */
const MISSING_RETRY_MS = 60_000;

async function loadClientId(): Promise<string | null> {
  const fromEnv = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const { SecretManagerServiceClient } =
      await import('@google-cloud/secret-manager');
    const sm = new SecretManagerServiceClient();
    const [version] = await sm.accessSecretVersion({
      name: `projects/${SECRET_PROJECT}/secrets/${CLIENT_ID_SECRET}/versions/latest`,
    });
    const value = version.payload?.data?.toString().trim() || null;
    if (value) logger.info('Google client ID loaded from Secret Manager');
    return value;
  } catch (error: any) {
    // Expected until sign-in is set up. Every read endpoint still works; the writes
    // answer AUTH_NOT_CONFIGURED, which says whose problem it is.
    logger.info('no Google client ID configured', { error: error?.message?.slice(0, 120) });
    return null;
  }
}

/**
 * The client id, resolved once when found and retried periodically when not.
 */
export async function googleClientId(): Promise<string | null> {
  if (clientId) return clientId;

  if (clientId === null && Date.now() < clientIdRetryAfter) return null;

  if (!clientIdLoad) {
    clientIdLoad = loadClientId().then((value) => {
      clientId = value;
      // Only a miss gets an expiry; a hit is final for this instance.
      clientIdRetryAfter = value ? 0 : Date.now() + MISSING_RETRY_MS;
      clientIdLoad = null;
      return value;
    }).catch((error) => {
      clientId = null;
      clientIdRetryAfter = Date.now() + MISSING_RETRY_MS;
      clientIdLoad = null;
      throw error;
    });
  }

  try {
    return await clientIdLoad;
  } catch {
    return null;
  }
}

export async function isAuthConfigured(): Promise<boolean> {
  return Boolean(await googleClientId());
}

/** Test seam. */
export function __resetClientId(): void {
  clientId = undefined;
  clientIdLoad = null;
  clientIdRetryAfter = 0;
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
  const audience = await googleClientId();
  if (!audience) return null;

  prune();
  const hit = verified.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience,
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
  if (!(await isAuthConfigured())) {
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
