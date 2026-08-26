import { describe, expect, test } from 'bun:test';

import {
  FCM_MESSAGING_SCOPE,
  FCM_OAUTH_REFRESH_SKEW_MILLISECONDS,
  FcmOAuthCredential,
  type FcmOAuthTokenRequest,
} from './fcm-credentials';

describe('FCM OAuth credential cache', () => {
  test('requests only firebase.messaging scope and refreshes before expiry', async () => {
    let now = Date.parse('2026-08-26T12:00:00.000Z');
    const requests: FcmOAuthTokenRequest[] = [];
    const credential = new FcmOAuthCredential({
      projectId: 'synthetic-project-1',
      clock: () => now,
      tokenSource: (request) => {
        requests.push(request);
        return {
          projectId: request.projectId,
          accessToken: `synthetic-access-token-${requests.length}`,
          expiresAt: now + 60 * 60_000,
        };
      },
    });

    const first = await credential.getAccessToken();
    now = first.expiresAtMilliseconds - FCM_OAUTH_REFRESH_SKEW_MILLISECONDS - 1;
    expect((await credential.getAccessToken()).accessToken).toBe(
      first.accessToken,
    );
    now += 1;
    expect((await credential.getAccessToken()).accessToken).not.toBe(
      first.accessToken,
    );
    expect(requests).toEqual([
      {
        projectId: 'synthetic-project-1',
        scope: FCM_MESSAGING_SCOPE,
      },
      {
        projectId: 'synthetic-project-1',
        scope: FCM_MESSAGING_SCOPE,
      },
    ]);
  });

  test('rejects project mismatch and non-short-lived credentials', async () => {
    const mismatch = new FcmOAuthCredential({
      projectId: 'synthetic-project-1',
      tokenSource: () => ({
        projectId: 'different-project-1',
        accessToken: 'synthetic-access-token-0001',
        expiresAt: Date.now() + 60 * 60_000,
      }),
    });
    await expect(mismatch.getAccessToken()).rejects.toThrow(
      'FCM OAuth credential response is invalid.',
    );

    const longLived = new FcmOAuthCredential({
      projectId: 'synthetic-project-1',
      tokenSource: () => ({
        projectId: 'synthetic-project-1',
        accessToken: 'synthetic-access-token-0001',
        expiresAt: Date.now() + 2 * 60 * 60_000,
      }),
    });
    await expect(longLived.getAccessToken()).rejects.toThrow(
      'FCM OAuth credential response is invalid.',
    );
  });
});
