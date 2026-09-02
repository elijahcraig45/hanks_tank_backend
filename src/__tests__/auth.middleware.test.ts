/**
 * Tests for Google client-id resolution.
 *
 * The retry behaviour is the point. A found id never changes and is cached for the life
 * of the instance; a missing one must not be, because caching absence forever means
 * storing the id later has no effect until instances are replaced — which is exactly
 * what happened the first time sign-in was switched on.
 */

const accessSecretVersion = jest.fn();

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion,
  })),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { googleClientId, isAuthConfigured, __resetClientId } from '../middleware/auth.middleware';

const ID = '127033547664-abc.apps.googleusercontent.com';
const secret = (value: string) => [{ payload: { data: Buffer.from(value) } }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  __resetClientId();
  delete process.env.GOOGLE_CLIENT_ID;
});

describe('googleClientId', () => {
  it('reads the id from Secret Manager', async () => {
    accessSecretVersion.mockResolvedValue(secret(ID));
    await expect(googleClientId()).resolves.toBe(ID);
    await expect(isAuthConfigured()).resolves.toBe(true);
  });

  it('prefers an explicit env var, so local dev needs no secret access', async () => {
    process.env.GOOGLE_CLIENT_ID = 'from-env';
    await expect(googleClientId()).resolves.toBe('from-env');
    expect(accessSecretVersion).not.toHaveBeenCalled();
  });

  it('caches a found id for the life of the instance', async () => {
    accessSecretVersion.mockResolvedValue(secret(ID));
    await googleClientId();
    await googleClientId();
    await googleClientId();
    expect(accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it('makes one upstream call for a burst of concurrent first requests', async () => {
    accessSecretVersion.mockResolvedValue(secret(ID));
    const all = await Promise.all([
      googleClientId(), googleClientId(), googleClientId(),
    ]);
    expect(all).toEqual([ID, ID, ID]);
    expect(accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it('does not treat a missing id as permanent', async () => {
    // The regression: caching absence forever meant storing the id later had no
    // effect until the instance was replaced.
    accessSecretVersion.mockRejectedValueOnce(new Error('NOT_FOUND'));
    await expect(googleClientId()).resolves.toBeNull();

    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 61_000);
    accessSecretVersion.mockResolvedValue(secret(ID));
    await expect(googleClientId()).resolves.toBe(ID);
  });

  it('does not hammer Secret Manager while the id is still missing', async () => {
    accessSecretVersion.mockRejectedValue(new Error('NOT_FOUND'));
    await googleClientId();
    await googleClientId();
    await googleClientId();
    // One attempt, then a quiet window rather than a call per request.
    expect(accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it('reports not-configured rather than throwing when the secret is unreadable', async () => {
    accessSecretVersion.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(isAuthConfigured()).resolves.toBe(false);
  });
});
