import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from 'bun:test';
import { max, sql } from 'drizzle-orm';

import {
  SessionEstablishmentResultSchema,
  SessionRevocationSchema,
  type RefreshCredentialRecordRef,
  type SessionRevocation,
} from '@psd-eoc/contracts';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  authenticateSessionRequest,
  createCsrfToken,
  readPresentedSessionCredential,
  requireFacilityAccess,
  requireRole,
  writeBrowserCsrfCookie,
  writeBrowserSessionCookies,
  type CookieWriter,
} from '../../../lib/auth/middleware.js';
import {
  DrizzleSessionStore,
  SessionAccessError,
  SessionService,
  createOpaqueRefreshToken,
  executeListDeviceSessionsCapability,
  executeRefreshSessionCapability,
  executeRevokeSessionCapability,
  hashRefreshToken,
  readSessionPolicy,
  type CompletedRefreshRetryInput,
  type EstablishDeviceSessionInput,
  type RecordReplayInput,
  type RevokeStoredSessionInput,
  type RotateCredentialInput,
  type SessionStore,
  type StoredCredential,
  type StoredSessionContext,
} from '../../../lib/auth/sessions.js';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client.js';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochInvalidations,
  connectivityEpochs,
  facilities,
  groupSources,
  userFacilityScopes,
  userRoles,
  users,
} from '../../../db/schema.js';
import { migrateDatabase } from '../../../drizzle/migrate.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const IDS = {
  user: '10000000-0000-4000-8000-000000000001',
  device: '10000000-0000-4000-8000-000000000002',
  session: '10000000-0000-4000-8000-000000000003',
  snapshot: '10000000-0000-4000-8000-000000000004',
  facility: '10000000-0000-4000-8000-000000000005',
  epoch: '10000000-0000-4000-8000-000000000006',
  issuance: '10000000-0000-4000-8000-000000000007',
  request: '10000000-0000-4000-8000-000000000008',
} as const;

const CREATED_AT = new Date('2026-08-07T08:00:00.000Z');
const MEMBERSHIP_VALID_UNTIL = '2026-08-07T10:00:00.000Z';
const MEMBERSHIP_GRACE_UNTIL = '2026-08-07T13:00:00.000Z';
const SESSION_EXPIRES_AT = '2026-09-06T08:00:00.000Z';
const INSIDE_GRACE = new Date('2026-08-07T11:00:00.000Z');

function result(
  overrides: Readonly<{
    sessionId?: string;
    deviceId?: string;
    epochId?: string;
    epochAt?: Date;
    validUntil?: string;
    graceUntil?: string;
    expiresAt?: string;
    revokedAt?: string | null;
    lastSeenAt?: Date;
  }> = {},
) {
  return SessionEstablishmentResultSchema.parse({
    user: {
      id: IDS.user,
      googleSubject: 'synthetic-google-subject',
      email: 'synthetic.staff@psd401.net',
      displayName: 'Synthetic Staff Member',
      roles: ['staff', 'admin'],
      facilityScope: {
        kind: 'facilities',
        facilityIds: [IDS.facility],
      },
      createdAt: CREATED_AT.toISOString(),
      disabledAt: null,
    },
    session: {
      id: overrides.sessionId ?? IDS.session,
      userId: IDS.user,
      deviceEnrollmentId: overrides.deviceId ?? IDS.device,
      createdAt: CREATED_AT.toISOString(),
      expiresAt: overrides.expiresAt ?? SESSION_EXPIRES_AT,
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: IDS.snapshot,
        membershipValidUntil: overrides.validUntil ?? MEMBERSHIP_VALID_UNTIL,
        membershipGraceUntil: overrides.graceUntil ?? MEMBERSHIP_GRACE_UNTIL,
      },
      revokedAt: overrides.revokedAt ?? null,
    },
    deviceEnrollment: {
      id: overrides.deviceId ?? IDS.device,
      userId: IDS.user,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: 'synthetic-installation-0001',
      enrolledAt: CREATED_AT.toISOString(),
      lastSeenAt: (overrides.lastSeenAt ?? CREATED_AT).toISOString(),
      revokedAt: null,
    },
    connectivityEpoch: {
      id: overrides.epochId ?? IDS.epoch,
      sessionId: overrides.sessionId ?? IDS.session,
      establishedAt: (overrides.epochAt ?? CREATED_AT).toISOString(),
    },
  });
}

class MemorySessionStore implements SessionStore {
  public replayCount = 0;
  public rotationCount = 0;
  public snapshotCapturedAt = new Date('2026-08-07T09:00:00.000Z');

  private context: StoredSessionContext;
  private currentDigest: string;
  private generation = 1;
  private currentRecordRef: RefreshCredentialRecordRef = {
    kind: 'initial-issuance' as const,
    issuanceId: IDS.issuance,
  };
  private readonly retired = new Map<
    string,
    Readonly<{
      sessionId: string;
      deviceEnrollmentId: string;
      rotationId: string;
      tokenDigest: string;
    }>
  >();
  private readonly refreshes = new Map<
    string,
    Readonly<{
      requestDigest: string;
      rotationId: string;
      nextDigest: string;
      completedAt: Date;
      context: StoredSessionContext;
    }>
  >();
  private readonly revocations = new Map<string, SessionRevocation>();

  public constructor(initialToken: string, initial = result()) {
    this.currentDigest = hashRefreshToken(initialToken);
    this.context = Object.freeze({
      result: initial,
      membershipSnapshotId: IDS.snapshot,
      membershipCapturedAt: this.snapshotCapturedAt,
      membershipScope: initial.user.facilityScope,
      membershipAccessActive: true,
      revocation: null,
      connectivityEpochActive: true,
    });
  }

  public async getMembershipSnapshotCapturedAt(
    snapshotId: string,
  ): Promise<Date | null> {
    return snapshotId === IDS.snapshot ? this.snapshotCapturedAt : null;
  }

  public async establish(
    input: EstablishDeviceSessionInput &
      Readonly<{
        tokenDigest: string;
        issuedAt: Date;
        membershipValidUntil: Date;
        membershipGraceUntil: Date;
        sessionExpiresAt: Date;
        sessionId: string;
        deviceEnrollmentId: string;
        tokenIssuanceId: string;
        connectivityEpochId: string;
      }>,
  ): Promise<StoredSessionContext> {
    this.currentDigest = input.tokenDigest;
    this.currentRecordRef = {
      kind: 'initial-issuance',
      issuanceId: input.tokenIssuanceId,
    };
    this.generation = 1;
    const established = result({
      sessionId: input.sessionId,
      deviceId: input.deviceEnrollmentId,
      epochId: input.connectivityEpochId,
      epochAt: input.issuedAt,
      validUntil: input.membershipValidUntil.toISOString(),
      graceUntil: input.membershipGraceUntil.toISOString(),
      expiresAt: input.sessionExpiresAt.toISOString(),
      lastSeenAt: input.issuedAt,
    });
    this.context = Object.freeze({
      result: established,
      membershipSnapshotId: input.membershipSnapshotId,
      membershipCapturedAt: this.snapshotCapturedAt,
      membershipScope: established.user.facilityScope,
      membershipAccessActive: true,
      revocation: null,
      connectivityEpochActive: true,
    });
    return this.context;
  }

  public async inspectCredential(
    tokenDigest: string,
  ): Promise<StoredCredential> {
    if (tokenDigest === this.currentDigest) {
      return Object.freeze({
        kind: 'current' as const,
        context: this.context,
        recordRef: this.currentRecordRef,
        generation: this.generation,
        tokenDigest,
      });
    }
    const retired = this.retired.get(tokenDigest);
    if (retired !== undefined) {
      return Object.freeze({ kind: 'retired' as const, ...retired });
    }
    return Object.freeze({ kind: 'unknown' as const, tokenDigest });
  }

  public async rotateCredential(
    input: RotateCredentialInput,
  ): Promise<StoredSessionContext> {
    if (
      input.principal.presentedTokenDigest !== this.currentDigest ||
      this.context.revocation !== null
    ) {
      throw new SessionAccessError(
        'TOKEN_REPLAY',
        'The session credential is no longer current.',
      );
    }
    this.retired.set(this.currentDigest, {
      sessionId: input.principal.sessionId,
      deviceEnrollmentId: input.principal.deviceEnrollmentId,
      rotationId: input.rotationId,
      tokenDigest: this.currentDigest,
    });
    this.currentDigest = input.nextTokenDigest;
    this.currentRecordRef = {
      kind: 'rotation-successor',
      rotationId: input.rotationId,
    };
    this.generation += 1;
    this.rotationCount += 1;
    const refreshed = SessionEstablishmentResultSchema.parse({
      ...this.context.result,
      deviceEnrollment: {
        ...this.context.result.deviceEnrollment,
        lastSeenAt: input.rotatedAt.toISOString(),
      },
      connectivityEpoch: {
        id: input.connectivityEpochId,
        sessionId: input.principal.sessionId,
        establishedAt: input.rotatedAt.toISOString(),
      },
    });
    this.context = Object.freeze({
      ...this.context,
      result: refreshed,
      connectivityEpochActive: true,
    });
    this.refreshes.set(
      `${input.principal.presentedTokenDigest}:${input.idempotencyKey}`,
      {
        requestDigest: input.requestDigest,
        rotationId: input.rotationId,
        nextDigest: input.nextTokenDigest,
        completedAt: input.rotatedAt,
        context: this.context,
      },
    );
    return this.context;
  }

  public async completedRefreshRetry(
    input: CompletedRefreshRetryInput,
  ): Promise<StoredSessionContext | null> {
    const completed = this.refreshes.get(
      `${input.retired.tokenDigest}:${input.idempotencyKey}`,
    );
    if (completed === undefined) {
      return null;
    }
    if (
      completed.requestDigest !== input.requestDigest ||
      completed.rotationId !== input.retired.rotationId ||
      completed.nextDigest !== this.currentDigest
    ) {
      throw new SessionAccessError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key is already bound to another request.',
      );
    }
    if (
      input.checkedAt.getTime() >=
      completed.completedAt.getTime() + 5 * 60 * 1_000
    ) {
      return null;
    }
    return completed.context;
  }

  public async recordReplayAndRevoke(input: RecordReplayInput): Promise<void> {
    this.replayCount += 1;
    this.setRevoked(
      SessionRevocationSchema.parse({
        id: crypto.randomUUID(),
        sessionId: input.retired.sessionId,
        revokedBy: { kind: 'system', serviceId: 'session-auth-test' },
        reasonCode: 'REFRESH_TOKEN_REPLAY',
        revokedAt: input.detectedAt.toISOString(),
      }),
    );
  }

  public async revoke(
    input: RevokeStoredSessionInput,
  ): Promise<SessionRevocation> {
    const key = `${input.actor.sessionId}:${input.idempotencyKey}`;
    const existing = this.revocations.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const revocation = SessionRevocationSchema.parse({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      revokedBy: input.actor,
      reasonCode: input.reasonCode,
      revokedAt: input.revokedAt.toISOString(),
    });
    this.revocations.set(key, revocation);
    this.setRevoked(revocation);
    return revocation;
  }

  private setRevoked(revocation: SessionRevocation): void {
    const revokedResult = SessionEstablishmentResultSchema.parse({
      ...this.context.result,
      session: {
        ...this.context.result.session,
        revokedAt: revocation.revokedAt,
      },
    });
    this.context = Object.freeze({
      ...this.context,
      result: revokedResult,
      revocation,
      connectivityEpochActive: false,
    });
  }

  public async getSession(
    sessionId: string,
  ): Promise<StoredSessionContext | null> {
    return sessionId === this.context.result.session.id ? this.context : null;
  }

  public async listDeviceSessions(): Promise<readonly StoredSessionContext[]> {
    return [this.context];
  }

  public useNewerMembershipSnapshot(
    snapshotId: string,
    capturedAt: Date,
  ): void {
    this.context = Object.freeze({
      ...this.context,
      membershipSnapshotId: snapshotId,
      membershipCapturedAt: capturedAt,
    });
  }
}

function webRequest(token: string, path = '/api/protected'): Request {
  return new Request(`https://eoc.test${path}`, {
    headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${token}` },
  });
}

async function expectSessionError(
  promise: Promise<unknown>,
  code: SessionAccessError['code'],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SessionAccessError);
    expect((error as SessionAccessError).code).toBe(code);
    return;
  }
  throw new Error(`Expected session error ${code}.`);
}

describe('Google-outage session continuity', () => {
  test('refreshes and authorizes full facility scope inside grace with the IdP offline', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const service = new SessionService(store);
    const offlineIdp = spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Google IdP is offline'),
    );
    try {
      const issued = await executeRefreshSessionCapability({
        service,
        token,
        source: 'web',
        idempotencyKey: 'offline-grace-refresh-0001',
        csrfVerified: true,
        requestId: IDS.request,
        now: INSIDE_GRACE,
      });
      const authenticated = await authenticateSessionRequest(
        webRequest(issued.refreshToken),
        service,
        { mutation: false },
        INSIDE_GRACE,
      );

      expect(authenticated.membershipState).toBe('grace');
      expect(authenticated.actor).toEqual({
        kind: 'human',
        userId: IDS.user,
        sessionId: IDS.session,
      });
      expect(authenticated.scope.facilityScope).toEqual({
        kind: 'facilities',
        facilityIds: [IDS.facility],
      });
      expect(authenticated.result.connectivityEpoch.id).not.toBe(IDS.epoch);
      expect(() =>
        requireFacilityAccess(authenticated, IDS.facility),
      ).not.toThrow();
      const devices = await executeListDeviceSessionsCapability({
        service,
        authenticated,
        query: {
          userId: null,
          includeRevoked: true,
          cursor: null,
          limit: 10,
        },
        now: INSIDE_GRACE,
      });
      expect(devices.items).toHaveLength(1);
      expect(() =>
        requireFacilityAccess(
          authenticated,
          '10000000-0000-4000-8000-000000000099',
        ),
      ).toThrow(SessionAccessError);
      expect(() =>
        requireRole(
          Object.freeze({ ...authenticated, roles: ['staff'] as const }),
          'admin',
        ),
      ).toThrow(SessionAccessError);
      expect(offlineIdp).not.toHaveBeenCalled();
    } finally {
      offlineIdp.mockRestore();
    }
  });

  test('fails closed at the exact grace deadline without consulting Google', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const service = new SessionService(store);
    const exactGraceDeadline = new Date(MEMBERSHIP_GRACE_UNTIL);

    await expectSessionError(
      authenticateSessionRequest(
        webRequest(token),
        service,
        { mutation: false },
        exactGraceDeadline,
      ),
      'MEMBERSHIP_GRACE_EXPIRED',
    );
  });

  test('adopts newer complete cached membership without changing the issuance record', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const service = new SessionService(store);
    const newerSnapshotId = '10000000-0000-4000-8000-000000000009';
    store.useNewerMembershipSnapshot(
      newerSnapshotId,
      new Date('2026-08-07T13:30:00.000Z'),
    );
    const offlineIdp = spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Google IdP is offline'),
    );
    try {
      const authenticated = await service.authenticate(
        token,
        'web',
        new Date('2026-08-07T13:45:00.000Z'),
      );
      expect(authenticated.membershipState).toBe('fresh');
      expect(authenticated.result.session.authorization).toEqual({
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: IDS.snapshot,
        membershipValidUntil: MEMBERSHIP_VALID_UNTIL,
        membershipGraceUntil: MEMBERSHIP_GRACE_UNTIL,
      });
      expect(offlineIdp).not.toHaveBeenCalled();
    } finally {
      offlineIdp.mockRestore();
    }
  });
});

describe('device session administration', () => {
  test('paginates every retained session without exceeding the contract bound', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const retainedSessions = Array.from({ length: 101 }, (_, index) => {
      const sequence = String(index + 1).padStart(12, '0');
      const sessionResult = result({
        sessionId: `20000000-0000-4000-8000-${sequence}`,
        epochId: `30000000-0000-4000-8000-${sequence}`,
      });
      return Object.freeze({
        result: sessionResult,
        membershipSnapshotId: IDS.snapshot,
        membershipCapturedAt: new Date('2026-08-07T09:00:00.000Z'),
        membershipScope: sessionResult.user.facilityScope,
        membershipAccessActive: true,
        revocation: null,
        connectivityEpochActive: true,
      }) satisfies StoredSessionContext;
    });
    spyOn(store, 'listDeviceSessions').mockResolvedValue(retainedSessions);
    const service = new SessionService(store);
    const authenticated = await service.authenticate(
      token,
      'web',
      INSIDE_GRACE,
    );

    const firstPage = await executeListDeviceSessionsCapability({
      service,
      authenticated,
      query: {
        userId: null,
        includeRevoked: true,
        cursor: null,
        limit: 1,
      },
      now: INSIDE_GRACE,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.sessions).toHaveLength(100);
    expect(firstPage.pageInfo.hasMore).toBe(true);
    const nextCursor = firstPage.pageInfo.nextCursor;
    if (nextCursor === null) {
      throw new Error('Expected a continuation for the retained session list.');
    }

    const secondPage = await executeListDeviceSessionsCapability({
      service,
      authenticated,
      query: {
        userId: null,
        includeRevoked: true,
        cursor: nextCursor,
        limit: 1,
      },
      now: INSIDE_GRACE,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.sessions).toHaveLength(1);
    expect(secondPage.pageInfo).toEqual({
      hasMore: false,
      nextCursor: null,
    });
    const listedSessionIds = [...firstPage.items, ...secondPage.items].flatMap(
      (item) => item.sessions.map((session) => session.id),
    );
    expect(listedSessionIds).toHaveLength(101);
    expect(new Set(listedSessionIds).size).toBe(101);
  });
});

describe('rotation and revocation', () => {
  test('returns the same successor for an idempotent retry and rejects replay under a new key', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const service = new SessionService(store);
    const first = await executeRefreshSessionCapability({
      service,
      token,
      source: 'web',
      idempotencyKey: 'refresh-idempotency-key-0001',
      csrfVerified: true,
      now: INSIDE_GRACE,
    });
    const retry = await executeRefreshSessionCapability({
      service,
      token,
      source: 'web',
      idempotencyKey: 'refresh-idempotency-key-0001',
      csrfVerified: true,
      now: INSIDE_GRACE,
    });
    expect(retry.refreshToken).toBe(first.refreshToken);
    expect(retry.result.connectivityEpoch.id).toBe(
      first.result.connectivityEpoch.id,
    );
    expect(store.rotationCount).toBe(1);

    await expectSessionError(
      executeRefreshSessionCapability({
        service,
        token,
        source: 'web',
        idempotencyKey: 'refresh-idempotency-key-0001',
        csrfVerified: false,
        now: INSIDE_GRACE,
      }),
      'FORBIDDEN',
    );
    expect(store.replayCount).toBe(0);

    await expectSessionError(
      service.authenticate(token, 'web', INSIDE_GRACE),
      'TOKEN_REPLAY',
    );
    expect(store.replayCount).toBe(0);
    await expect(
      service.authenticate(first.refreshToken, 'web', INSIDE_GRACE),
    ).resolves.toMatchObject({ actor: { sessionId: IDS.session } });

    await expectSessionError(
      executeRefreshSessionCapability({
        service,
        token,
        source: 'web',
        idempotencyKey: 'refresh-replay-new-key-0002',
        csrfVerified: true,
        now: INSIDE_GRACE,
      }),
      'TOKEN_REPLAY',
    );
    expect(store.replayCount).toBe(1);
    await expectSessionError(
      service.authenticate(first.refreshToken, 'web', INSIDE_GRACE),
      'SESSION_REVOKED',
    );
  });

  test('another server instance observes revocation immediately and within 60 seconds', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const firstInstance = new SessionService(store);
    const secondInstance = new SessionService(store);
    const authenticated = await firstInstance.authenticate(
      token,
      'web',
      INSIDE_GRACE,
    );
    const revokedAt = new Date(INSIDE_GRACE.getTime() + 1_000);
    await executeRevokeSessionCapability({
      service: firstInstance,
      authenticated,
      sessionId: IDS.session,
      reasonCode: 'USER_REQUESTED',
      idempotencyKey: 'revoke-current-session-0001',
      csrfVerified: true,
      now: revokedAt,
    });

    await expectSessionError(
      authenticateSessionRequest(
        webRequest(token),
        secondInstance,
        { mutation: false },
        new Date(INSIDE_GRACE.getTime() + 59_000),
      ),
      'SESSION_REVOKED',
    );
    await expectSessionError(
      executeRefreshSessionCapability({
        service: secondInstance,
        token,
        source: 'web',
        idempotencyKey: 'revoked-refresh-denied-0001',
        csrfVerified: true,
        now: new Date(INSIDE_GRACE.getTime() + 59_000),
      }),
      'SESSION_REVOKED',
    );
  });

  test('limits lost-response recovery for a retired credential', async () => {
    const token = createOpaqueRefreshToken();
    const store = new MemorySessionStore(token);
    const service = new SessionService(store);
    await executeRefreshSessionCapability({
      service,
      token,
      source: 'web',
      idempotencyKey: 'bounded-refresh-recovery-0001',
      csrfVerified: true,
      now: INSIDE_GRACE,
    });
    await expectSessionError(
      executeRefreshSessionCapability({
        service,
        token,
        source: 'web',
        idempotencyKey: 'bounded-refresh-recovery-0001',
        csrfVerified: true,
        now: new Date(INSIDE_GRACE.getTime() + 5 * 60 * 1_000),
      }),
      'TOKEN_REPLAY',
    );
    expect(store.replayCount).toBe(1);
  });
});

describe('transport and policy boundaries', () => {
  test('uses callback CSRF protection to rotate an OIDC credential without Google', async () => {
    const oidcCredential = 'A'.repeat(64);
    const store = new MemorySessionStore(oidcCredential);
    const service = new SessionService(store);
    const csrfToken = createCsrfToken();
    const written: Array<{
      name: string;
      value: string;
      options: Parameters<CookieWriter['set']>[2];
    }> = [];
    writeBrowserCsrfCookie(
      {
        set(name, value, options) {
          written.push({ name, value, options });
        },
      },
      csrfToken,
      3_600,
    );
    expect(written).toEqual([
      {
        name: WEB_CSRF_COOKIE_NAME,
        value: csrfToken,
        options: {
          httpOnly: false,
          secure: true,
          sameSite: 'strict',
          path: '/',
          maxAge: 3_600,
        },
      },
    ]);

    const presented = readPresentedSessionCredential(
      new Request('https://eoc.test/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=${oidcCredential}; ${WEB_CSRF_COOKIE_NAME}=${csrfToken}`,
          origin: 'https://eoc.test',
          'x-psd-eoc-csrf': csrfToken,
        },
      }),
      { mutation: true },
    );
    expect(presented).toEqual({
      token: oidcCredential,
      source: 'web',
      csrfVerified: true,
    });

    await expect(
      authenticateSessionRequest(
        webRequest(oidcCredential),
        service,
        { mutation: false },
        INSIDE_GRACE,
      ),
    ).resolves.toMatchObject({ actor: { sessionId: IDS.session } });

    const refreshed = await executeRefreshSessionCapability({
      service,
      token: presented.token,
      source: presented.source,
      idempotencyKey: 'oidc-cookie-refresh-compatibility-0001',
      csrfVerified: presented.csrfVerified,
      now: INSIDE_GRACE,
    });
    expect(refreshed.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      service.authenticate(refreshed.refreshToken, 'web', INSIDE_GRACE),
    ).resolves.toMatchObject({ actor: { sessionId: IDS.session } });
  });

  test('writes secure browser cookies and accepts only an opaque mobile bearer', () => {
    const token = createOpaqueRefreshToken();
    const written: Array<{
      name: string;
      value: string;
      options: Parameters<CookieWriter['set']>[2];
    }> = [];
    const writer: CookieWriter = {
      set(name, value, options) {
        written.push({ name, value, options });
      },
    };
    writeBrowserSessionCookies(writer, token, 'synthetic-csrf-token', 3_600);
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual({
      name: WEB_SESSION_COOKIE_NAME,
      value: token,
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 3_600,
      },
    });
    expect(written[0]?.options).not.toHaveProperty('domain');

    const mobile = readPresentedSessionCredential(
      new Request('https://eoc.test/api/auth/refresh', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      { mutation: true },
    );
    expect(mobile).toEqual({
      token,
      source: 'mobile',
      csrfVerified: false,
    });
    expect(token).not.toContain('.');
    expect(token).not.toContain(IDS.session);
  });

  test('does not let a web credential switch to bearer transport to bypass CSRF', async () => {
    const token = createOpaqueRefreshToken();
    const service = new SessionService(new MemorySessionStore(token));
    await expectSessionError(
      service.authenticate(token, 'mobile', INSIDE_GRACE),
      'INVALID_CREDENTIAL',
    );
  });

  test('rejects ambiguous credentials and requires same-origin double-submit CSRF', () => {
    const token = createOpaqueRefreshToken();
    const csrf = 'synthetic-csrf-token';
    expect(() =>
      readPresentedSessionCredential(
        new Request('https://eoc.test/api/auth/refresh', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            cookie: `${WEB_SESSION_COOKIE_NAME}=${token}`,
          },
        }),
        { mutation: true },
      ),
    ).toThrow(SessionAccessError);

    const web = readPresentedSessionCredential(
      new Request('https://eoc.test/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=${token}; ${WEB_CSRF_COOKIE_NAME}=${csrf}`,
          origin: 'https://eoc.test',
          'x-psd-eoc-csrf': csrf,
        },
      }),
      { mutation: true },
    );
    expect(web.csrfVerified).toBe(true);
    expect(() =>
      readPresentedSessionCredential(
        new Request('https://eoc.test/api/auth/refresh', {
          method: 'POST',
          headers: {
            cookie: `${WEB_SESSION_COOKIE_NAME}=${token}; ${WEB_CSRF_COOKIE_NAME}=${csrf}`,
            origin: 'https://evil.example',
            'x-psd-eoc-csrf': csrf,
          },
        }),
        { mutation: true },
      ),
    ).toThrow(SessionAccessError);
  });

  test('verifies proxied production CSRF against the fixed public origin', () => {
    const token = createOpaqueRefreshToken();
    const csrf = 'synthetic-proxied-csrf-token';
    const request = (origin: string) =>
      new Request('https://localhost:3000/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=${token}; ${WEB_CSRF_COOKIE_NAME}=${csrf}`,
          origin,
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
          'x-psd-eoc-csrf': csrf,
        },
      });

    expect(
      readPresentedSessionCredential(
        request('https://eoc.psd401.net'),
        { mutation: true },
        { NODE_ENV: 'production' },
      ),
    ).toMatchObject({ source: 'web', csrfVerified: true });
    expect(() =>
      readPresentedSessionCredential(
        request('https://localhost:3000'),
        { mutation: true },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(SessionAccessError);
    expect(() =>
      readPresentedSessionCredential(
        request('https://evil.example'),
        { mutation: true },
        { NODE_ENV: 'production' },
      ),
    ).toThrow(SessionAccessError);
    expect(
      readPresentedSessionCredential(
        request('https://localhost:3000'),
        { mutation: true },
        { NODE_ENV: 'development' },
      ),
    ).toMatchObject({ source: 'web', csrfVerified: true });
  });

  test('derives TTL and grace from snapshot capture and never from refresh time', async () => {
    const initial = createOpaqueRefreshToken();
    const store = new MemorySessionStore(initial);
    store.snapshotCapturedAt = new Date('2026-08-07T09:00:00.000Z');
    const policy = readSessionPolicy({
      PSD_EOC_SESSION_LIFETIME_SECONDS: '86400',
      PSD_EOC_MEMBERSHIP_TTL_SECONDS: '600',
      PSD_EOC_MEMBERSHIP_GRACE_SECONDS: '1200',
    });
    const service = new SessionService(store, policy);
    const issuedAt = new Date('2026-08-07T09:05:00.000Z');
    const issued = await service.establish(
      {
        userId: IDS.user,
        membershipSnapshotId: IDS.snapshot,
        device: {
          platform: 'web',
          unlockMethod: 'secure-session-cookie',
          installationId: 'synthetic-installation-0002',
        },
      },
      issuedAt,
    );
    expect(issued.result.session.authorization.membershipValidUntil).toBe(
      '2026-08-07T09:10:00.000Z',
    );
    expect(issued.result.session.authorization.membershipGraceUntil).toBe(
      '2026-08-07T09:30:00.000Z',
    );

    const refreshed = await executeRefreshSessionCapability({
      service,
      token: issued.refreshToken,
      source: 'web',
      idempotencyKey: 'deadline-preserving-refresh-0001',
      csrfVerified: true,
      now: new Date('2026-08-07T09:20:00.000Z'),
    });
    expect(refreshed.result.session.authorization).toEqual(
      issued.result.session.authorization,
    );
    const atFreshDeadline = await service.authenticate(
      refreshed.refreshToken,
      'web',
      new Date('2026-08-07T09:10:00.000Z'),
    );
    expect(atFreshDeadline.membershipState).toBe('grace');
    await expectSessionError(
      service.authenticate(
        refreshed.refreshToken,
        'web',
        new Date('2026-08-07T09:30:00.000Z'),
      ),
      'MEMBERSHIP_GRACE_EXPIRED',
    );
  });

  test('rejects invalid TTL/grace configuration', () => {
    expect(readSessionPolicy({})).toEqual({
      sessionLifetimeSeconds: 90 * 24 * 60 * 60,
      membershipTtlSeconds: 24 * 60 * 60,
      membershipGraceSeconds: 72 * 60 * 60,
    });
    expect(() =>
      readSessionPolicy({ PSD_EOC_MEMBERSHIP_GRACE_SECONDS: '-1' }),
    ).toThrow('PSD_EOC_MEMBERSHIP_GRACE_SECONDS');
    expect(() =>
      readSessionPolicy({ PSD_EOC_MEMBERSHIP_TTL_SECONDS: '999999999' }),
    ).toThrow('PSD_EOC_MEMBERSHIP_TTL_SECONDS');
  });
});

describeWithDatabase(
  'PostgreSQL-backed Google-outage and revocation proof',
  () => {
    let connection: PostgresDatabaseConnection | undefined;

    function databaseConnection(): PostgresDatabaseConnection {
      if (connection === undefined) {
        throw new Error('The session integration database is not open.');
      }
      return connection;
    }

    beforeAll(async () => {
      if (testDatabaseUrl === undefined) {
        throw new Error(
          'TEST_DATABASE_URL is required for database integration tests.',
        );
      }
      const created = createDatabaseClient({
        driver: 'postgres',
        url: testDatabaseUrl,
        maxConnections: 4,
      });
      if (created.driver !== 'postgres') {
        throw new Error('Session integration tests require PostgreSQL.');
      }
      connection = created;
      await migrateDatabase(created);
    });

    afterAll(async () => {
      await connection?.close();
    });

    test('refreshes after issuance grace from newer cached evidence with Google offline, then revokes across instances', async () => {
      const database = databaseConnection().db;
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const fixture = {
        facilityId: crypto.randomUUID(),
        groupSourceId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        googleSubject: `synthetic-google-${suffix}`,
        email: `synthetic.auth.${suffix}@psd401.net`,
        targetUserId: crypto.randomUUID(),
        targetGoogleSubject: `synthetic-target-google-${suffix}`,
        targetEmail: `synthetic.target.${suffix}@psd401.net`,
      } as const;
      const createdAt = new Date('2026-08-07T08:00:00.000Z');
      const issuanceCapturedAt = new Date('2026-08-07T09:00:00.000Z');
      const renewedCapturedAt = new Date('2026-08-07T12:30:00.000Z');

      await database.transaction(async (transaction) => {
        await transaction.insert(facilities).values({
          id: fixture.facilityId,
          code: `AUTH-${suffix.slice(0, 12).toUpperCase()}`,
          name: 'Synthetic session-auth facility',
          active: true,
          createdAt,
        });
        await transaction.insert(groupSources).values({
          id: fixture.groupSourceId,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          displayName: 'Synthetic session-auth access group',
          grantedRole: 'admin',
          active: true,
          googleGroupId: `synthetic-access-${suffix}`,
          email: `synthetic-access-${suffix}@example.invalid`,
          fixtureKey: null,
          createdAt,
        });
        await transaction.insert(users).values([
          {
            id: fixture.userId,
            googleSubject: fixture.googleSubject,
            email: fixture.email,
            displayName: 'Synthetic Session Administrator',
            facilityScopeKind: 'facilities',
            createdAt,
            disabledAt: null,
          },
          {
            id: fixture.targetUserId,
            googleSubject: fixture.targetGoogleSubject,
            email: fixture.targetEmail,
            displayName: 'Synthetic Removed Staff Member',
            facilityScopeKind: 'facilities',
            createdAt,
            disabledAt: null,
          },
        ]);
        await transaction.insert(userRoles).values([
          { userId: fixture.userId, role: 'staff' },
          { userId: fixture.userId, role: 'admin' },
          { userId: fixture.targetUserId, role: 'staff' },
        ]);
        await transaction.insert(userFacilityScopes).values([
          { userId: fixture.userId, facilityId: fixture.facilityId },
          { userId: fixture.targetUserId, facilityId: fixture.facilityId },
        ]);
      });

      async function insertCompleteMembershipSnapshot(
        capturedAt: Date,
        includeTargetMember: boolean,
      ): Promise<string> {
        return database.transaction(async (transaction) => {
          await transaction.execute(sql`select pg_advisory_xact_lock(401, 7)`);
          const [current] = await transaction
            .select({ version: max(accessMembershipSnapshots.version) })
            .from(accessMembershipSnapshots);
          const snapshotId = crypto.randomUUID();
          const version = Number(current?.version ?? 0) + 1;
          await transaction.insert(accessMembershipSnapshots).values({
            id: snapshotId,
            version,
            complete: true,
            syncStartedAt: new Date(capturedAt.getTime() - 60_000),
            capturedAt,
          });
          await transaction.insert(accessMembershipSnapshotGroups).values([
            {
              snapshotId,
              groupSourceId: fixture.groupSourceId,
              groupSourceKind: 'google-group',
              groupPurpose: 'access',
              completionKind: 'expected',
            },
            {
              snapshotId,
              groupSourceId: fixture.groupSourceId,
              groupSourceKind: 'google-group',
              groupPurpose: 'access',
              completionKind: 'completed',
            },
          ]);
          const members = [
            {
              userId: fixture.userId,
              googleSubject: fixture.googleSubject,
            },
            ...(includeTargetMember
              ? [
                  {
                    userId: fixture.targetUserId,
                    googleSubject: fixture.targetGoogleSubject,
                  },
                ]
              : []),
          ];
          await transaction.insert(accessMembershipMembers).values(
            members.map((member) => ({
              snapshotId,
              ...member,
              facilityScopeKind: 'facilities' as const,
            })),
          );
          await transaction.insert(accessMembershipMemberGroups).values(
            members.map((member) => ({
              snapshotId,
              userId: member.userId,
              groupSourceId: fixture.groupSourceId,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
            })),
          );
          await transaction.insert(accessMembershipMemberFacilities).values(
            members.map((member) => ({
              snapshotId,
              userId: member.userId,
              facilityId: fixture.facilityId,
            })),
          );
          return snapshotId;
        });
      }

      const issuanceSnapshotId = await insertCompleteMembershipSnapshot(
        issuanceCapturedAt,
        true,
      );
      const policy = {
        sessionLifetimeSeconds: 30 * 24 * 60 * 60,
        membershipTtlSeconds: 60 * 60,
        membershipGraceSeconds: 3 * 60 * 60,
      } as const;
      const firstInstance = new SessionService(
        new DrizzleSessionStore(database),
        policy,
      );
      const secondInstance = new SessionService(
        new DrizzleSessionStore(database),
        policy,
      );
      const issued = await firstInstance.establish(
        {
          userId: fixture.userId,
          membershipSnapshotId: issuanceSnapshotId,
          device: {
            platform: 'web',
            unlockMethod: 'secure-session-cookie',
            installationId: `synthetic-installation-${suffix}`,
          },
        },
        new Date('2026-08-07T09:30:00.000Z'),
      );
      const targetIssued = await firstInstance.establish(
        {
          userId: fixture.targetUserId,
          membershipSnapshotId: issuanceSnapshotId,
          device: {
            platform: 'web',
            unlockMethod: 'secure-session-cookie',
            installationId: `synthetic-target-installation-${suffix}`,
          },
        },
        new Date('2026-08-07T09:31:00.000Z'),
      );
      const renewedSnapshotId = await insertCompleteMembershipSnapshot(
        renewedCapturedAt,
        true,
      );
      const offlineIdp = spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Google IdP is offline'),
      );
      try {
        const refreshAt = new Date('2026-08-07T13:15:00.000Z');
        const refreshed = await executeRefreshSessionCapability({
          service: firstInstance,
          token: issued.refreshToken,
          source: 'web',
          idempotencyKey: `db-offline-refresh-${suffix}`,
          csrfVerified: true,
          now: refreshAt,
        });
        const retried = await executeRefreshSessionCapability({
          service: secondInstance,
          token: issued.refreshToken,
          source: 'web',
          idempotencyKey: `db-offline-refresh-${suffix}`,
          csrfVerified: true,
          now: refreshAt,
        });
        expect(retried.refreshToken).toBe(refreshed.refreshToken);

        const authenticated = await authenticateSessionRequest(
          webRequest(refreshed.refreshToken),
          secondInstance,
          { mutation: false },
          refreshAt,
        );
        expect(authenticated.membershipState).toBe('fresh');
        expect(
          authenticated.result.session.authorization.membershipSnapshotId,
        ).toBe(issuanceSnapshotId);
        expect(renewedSnapshotId).not.toBe(issuanceSnapshotId);
        expect(authenticated.scope.facilityScope).toEqual({
          kind: 'facilities',
          facilityIds: [fixture.facilityId],
        });
        const extraEpochId = crypto.randomUUID();
        await database.insert(connectivityEpochs).values({
          id: extraEpochId,
          sessionId: issued.result.session.id,
          establishedAt: refreshAt,
        });
        await expectSessionError(
          secondInstance.authenticate(refreshed.refreshToken, 'web', refreshAt),
          'INVALID_CREDENTIAL',
        );
        await database.insert(connectivityEpochInvalidations).values({
          id: crypto.randomUUID(),
          connectivityEpochId: extraEpochId,
          reason: 'disconnected',
          invalidatedAt: refreshAt,
        });
        const devices = await executeListDeviceSessionsCapability({
          service: secondInstance,
          authenticated,
          query: {
            userId: fixture.userId,
            includeRevoked: true,
            cursor: null,
            limit: 10,
          },
          now: refreshAt,
        });
        expect(devices.items).toHaveLength(1);

        await insertCompleteMembershipSnapshot(
          new Date('2026-08-07T13:20:00.000Z'),
          false,
        );
        const afterRemoval = new Date('2026-08-07T13:21:00.000Z');
        const adminAfterRemoval = await firstInstance.authenticate(
          refreshed.refreshToken,
          'web',
          afterRemoval,
        );
        await expectSessionError(
          secondInstance.authenticate(
            targetIssued.refreshToken,
            'web',
            afterRemoval,
          ),
          'INVALID_MEMBERSHIP_EVIDENCE',
        );
        const removedUserDevices = await executeListDeviceSessionsCapability({
          service: secondInstance,
          authenticated: adminAfterRemoval,
          query: {
            userId: fixture.targetUserId,
            includeRevoked: true,
            cursor: null,
            limit: 10,
          },
          now: afterRemoval,
        });
        expect(removedUserDevices.items).toHaveLength(1);
        expect(removedUserDevices.items[0]?.sessions).toHaveLength(1);

        const revokedAt = new Date('2026-08-07T13:22:00.000Z');
        await executeRevokeSessionCapability({
          service: firstInstance,
          authenticated: adminAfterRemoval,
          sessionId: targetIssued.result.session.id,
          reasonCode: 'INTEGRATION_TEST_REMOVED_USER_REVOKE',
          idempotencyKey: `db-session-revoke-${suffix}`,
          csrfVerified: true,
          now: revokedAt,
        });
        await expectSessionError(
          authenticateSessionRequest(
            webRequest(targetIssued.refreshToken),
            secondInstance,
            { mutation: false },
            new Date(revokedAt.getTime() + 59_000),
          ),
          'SESSION_REVOKED',
        );
        expect(offlineIdp).not.toHaveBeenCalled();
      } finally {
        offlineIdp.mockRestore();
      }
    });
  },
);
