import { describe, expect, test } from 'bun:test';

import {
  SessionEstablishmentResultSchema,
  SessionRevocationSchema,
  type RefreshCredentialRecordRef,
  type SessionRevocation,
} from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../../../../lib/auth/middleware';
import {
  SessionService,
  hashRefreshToken,
  type CompletedSelfRevocationRetryInput,
  type RevokeStoredSessionInput,
  type SessionStore,
  type StoredCredential,
  type StoredSessionContext,
} from '../../../../lib/auth/sessions';
import { createRevokeSessionRouteHandler } from './route';

const IDS = {
  user: '10000000-0000-4000-8000-000000000001',
  device: '10000000-0000-4000-8000-000000000002',
  session: '10000000-0000-4000-8000-000000000003',
  snapshot: '10000000-0000-4000-8000-000000000004',
  facility: '10000000-0000-4000-8000-000000000005',
  epoch: '10000000-0000-4000-8000-000000000006',
  issuance: '10000000-0000-4000-8000-000000000007',
  revocation: '10000000-0000-4000-8000-000000000008',
  otherSession: '10000000-0000-4000-8000-000000000009',
  rotation: '10000000-0000-4000-8000-000000000010',
} as const;

const TOKEN = 'A'.repeat(43);
const UNKNOWN_TOKEN = 'B'.repeat(43);
const IDEMPOTENCY_KEY = 'issue-23-self-revoke-route-0001';
const REASON_CODE = 'USER_REQUESTED_REVOCATION';
const CREATED_AT = new Date('2026-08-12T08:00:00.000Z');

function activeContext(): StoredSessionContext {
  const result = SessionEstablishmentResultSchema.parse({
    user: {
      id: IDS.user,
      googleSubject: 'synthetic-route-google-subject',
      email: 'synthetic.route.staff@psd401.net',
      displayName: 'Synthetic Route Staff',
      roles: ['staff'],
      facilityScope: {
        kind: 'facilities',
        facilityIds: [IDS.facility],
      },
      createdAt: CREATED_AT.toISOString(),
      disabledAt: null,
    },
    session: {
      id: IDS.session,
      userId: IDS.user,
      deviceEnrollmentId: IDS.device,
      createdAt: CREATED_AT.toISOString(),
      expiresAt: '2099-08-12T08:00:00.000Z',
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: IDS.snapshot,
        membershipValidUntil: '2099-08-12T08:00:00.000Z',
        membershipGraceUntil: '2099-08-15T08:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: IDS.device,
      userId: IDS.user,
      platform: 'ios',
      unlockMethod: 'biometric',
      installationId: 'synthetic-route-installation',
      enrolledAt: CREATED_AT.toISOString(),
      lastSeenAt: CREATED_AT.toISOString(),
      revokedAt: null,
    },
    connectivityEpoch: {
      id: IDS.epoch,
      sessionId: IDS.session,
      establishedAt: CREATED_AT.toISOString(),
    },
  });
  return Object.freeze({
    result,
    membershipSnapshotId: IDS.snapshot,
    membershipCapturedAt: CREATED_AT,
    membershipScope: result.user.facilityScope,
    membershipAccessActive: true,
    revocation: null,
    connectivityEpochActive: true,
  });
}

class RouteSessionStore implements SessionStore {
  public mutationCount = 0;
  public recoveryCount = 0;

  private context = activeContext();
  private retired = false;
  private completed:
    | Readonly<{
        tokenDigest: string;
        sessionId: string;
        idempotencyKey: string;
        requestDigest: string;
        revocation: SessionRevocation;
      }>
    | undefined;

  public retireCredential(): void {
    this.retired = true;
  }

  public forceIncompleteRevocation(): void {
    this.setRevoked(
      SessionRevocationSchema.parse({
        id: IDS.revocation,
        sessionId: IDS.session,
        revokedBy: {
          kind: 'human',
          userId: IDS.user,
          sessionId: IDS.session,
        },
        reasonCode: REASON_CODE,
        revokedAt: '2026-08-12T08:01:00.000Z',
      }),
    );
  }

  public async getMembershipSnapshotCapturedAt(): Promise<Date> {
    return CREATED_AT;
  }

  public async establish(): Promise<StoredSessionContext> {
    throw new Error('Route test does not establish sessions.');
  }

  public async inspectCredential(
    tokenDigest: string,
  ): Promise<StoredCredential> {
    if (tokenDigest !== hashRefreshToken(TOKEN)) {
      return Object.freeze({ kind: 'unknown', tokenDigest });
    }
    if (this.retired) {
      return Object.freeze({
        kind: 'retired',
        sessionId: IDS.session,
        deviceEnrollmentId: IDS.device,
        rotationId: IDS.rotation,
        tokenDigest,
      });
    }
    const recordRef: RefreshCredentialRecordRef = {
      kind: 'initial-issuance',
      issuanceId: IDS.issuance,
    };
    return Object.freeze({
      kind: 'current',
      context: this.context,
      recordRef,
      generation: 1,
      tokenDigest,
    });
  }

  public async rotateCredential(): Promise<StoredSessionContext> {
    throw new Error('Route test does not rotate credentials.');
  }

  public async completedRefreshRetry(): Promise<StoredSessionContext | null> {
    return null;
  }

  public async recordReplayAndRevoke(): Promise<void> {}

  public async revoke(
    input: RevokeStoredSessionInput,
  ): Promise<SessionRevocation> {
    this.mutationCount += 1;
    const revocation = SessionRevocationSchema.parse({
      id: IDS.revocation,
      sessionId: input.sessionId,
      revokedBy: input.actor,
      reasonCode: input.reasonCode,
      revokedAt: input.revokedAt.toISOString(),
    });
    this.completed = Object.freeze({
      tokenDigest: hashRefreshToken(TOKEN),
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      revocation,
    });
    this.setRevoked(revocation);
    return revocation;
  }

  public async completedSelfRevocationRetry(
    input: CompletedSelfRevocationRetryInput,
  ): Promise<SessionRevocation | null> {
    this.recoveryCount += 1;
    const completed = this.completed;
    return completed !== undefined &&
      !this.retired &&
      input.presentedTokenDigest === completed.tokenDigest &&
      input.sessionId === completed.sessionId &&
      input.idempotencyKey === completed.idempotencyKey &&
      input.requestDigest === completed.requestDigest
      ? completed.revocation
      : null;
  }

  public async getSession(
    sessionId: string,
  ): Promise<StoredSessionContext | null> {
    return sessionId === IDS.session ? this.context : null;
  }

  public async listDeviceSessions(): Promise<readonly StoredSessionContext[]> {
    return [this.context];
  }

  private setRevoked(revocation: SessionRevocation): void {
    this.context = Object.freeze({
      ...this.context,
      result: SessionEstablishmentResultSchema.parse({
        ...this.context.result,
        session: {
          ...this.context.result.session,
          revokedAt: revocation.revokedAt,
        },
      }),
      revocation,
      connectivityEpochActive: false,
    });
  }
}

function mobileRequest(
  token: string = TOKEN,
  body: Readonly<{ sessionId: string; reasonCode: string }> = {
    sessionId: IDS.session,
    reasonCode: REASON_CODE,
  },
  idempotencyKey: string = IDEMPOTENCY_KEY,
): NextRequest {
  return new NextRequest('https://eoc.example.invalid/api/auth/revoke', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function webRequest(): NextRequest {
  const csrf = 'synthetic-revoke-csrf';
  return new NextRequest('https://eoc.example.invalid/api/auth/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${WEB_SESSION_COOKIE_NAME}=${TOKEN}; ${WEB_CSRF_COOKIE_NAME}=${csrf}`,
      'Idempotency-Key': IDEMPOTENCY_KEY,
      Origin: 'https://eoc.example.invalid',
      'X-PSD-EOC-CSRF': csrf,
    },
    body: JSON.stringify({
      sessionId: IDS.session,
      reasonCode: REASON_CODE,
    }),
  });
}

describe('POST /api/auth/revoke', () => {
  test('recovers the canonical self-revocation receipt after response loss and a route restart', async () => {
    const store = new RouteSessionStore();
    const firstRoute = createRevokeSessionRouteHandler(
      () => new SessionService(store),
    );
    const committed = await firstRoute(mobileRequest());
    expect(committed.status).toBe(200);
    const canonical = SessionRevocationSchema.parse(await committed.json());
    expect(store.mutationCount).toBe(1);
    expect(store.recoveryCount).toBe(0);

    const restartedRoute = createRevokeSessionRouteHandler(
      () => new SessionService(store),
    );
    const retried = await restartedRoute(mobileRequest());
    expect(retried.status).toBe(200);
    expect(SessionRevocationSchema.parse(await retried.json())).toEqual(
      canonical,
    );
    expect(retried.headers.get('cache-control')).toContain('no-store');
    expect(store.mutationCount).toBe(1);
    expect(store.recoveryCount).toBe(1);
  });

  test('rejects wrong target, key, body, source, and unknown or retired credentials without another mutation', async () => {
    const store = new RouteSessionStore();
    const route = createRevokeSessionRouteHandler(
      () => new SessionService(store),
    );
    expect((await route(mobileRequest())).status).toBe(200);

    const rejected = [
      mobileRequest(TOKEN, {
        sessionId: IDS.otherSession,
        reasonCode: REASON_CODE,
      }),
      mobileRequest(TOKEN, undefined, 'issue-23-wrong-revoke-key-0001'),
      mobileRequest(TOKEN, {
        sessionId: IDS.session,
        reasonCode: 'DIFFERENT_REASON',
      }),
      webRequest(),
      mobileRequest(UNKNOWN_TOKEN),
    ];
    for (const request of rejected) {
      expect((await route(request)).status).toBe(401);
    }

    store.retireCredential();
    expect((await route(mobileRequest())).status).toBe(401);
    expect(store.mutationCount).toBe(1);
  });

  test('rejects a revoked credential when no completed idempotency record exists', async () => {
    const store = new RouteSessionStore();
    store.forceIncompleteRevocation();
    const route = createRevokeSessionRouteHandler(
      () => new SessionService(store),
    );

    const response = await route(mobileRequest());
    expect(response.status).toBe(401);
    expect(store.mutationCount).toBe(0);
    expect(store.recoveryCount).toBe(1);
  });
});
