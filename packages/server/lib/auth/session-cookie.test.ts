import { describe, expect, test } from 'bun:test';

import {
  executeCapability,
  parseCapabilityEnvelopeFor,
  type CompleteOidcSignInInput,
  type RegisteredCapabilityEnvelope,
  type SessionEstablishmentResult,
} from '@psd-eoc/contracts';

import {
  WebSessionIssuanceError,
  createCompleteOidcSignInAuthorizer,
  createCompleteOidcSignInHandler,
  digestWebSessionCredential,
  type CompleteOidcSignInContext,
  type InitialWebSessionStore,
  type PersistInitialWebSessionRequest,
  type WebSessionPolicy,
} from './session-cookie';

const NOW = new Date('2026-08-10T18:00:00.000Z');
const CAPTURED_AT = '2026-08-10T17:55:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000101';
const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000102';
const GROUP_SOURCE_ID = '10000000-0000-4000-8000-000000000103';
const DEVICE_ID = '10000000-0000-4000-8000-000000000104';
const SESSION_ID = '10000000-0000-4000-8000-000000000105';
const EPOCH_ID = '10000000-0000-4000-8000-000000000106';
const RESPONSE_DIGEST = 'a'.repeat(64);

const POLICY: Readonly<WebSessionPolicy> = Object.freeze({
  sessionLifetimeSeconds: 90 * 24 * 60 * 60,
  membershipTtlSeconds: 24 * 60 * 60,
  membershipGraceSeconds: 72 * 60 * 60,
});

const INPUT: CompleteOidcSignInInput = Object.freeze({
  claims: Object.freeze({
    issuer: 'https://accounts.google.com',
    audience: 'synthetic-mobile-client.apps.googleusercontent.com',
    subject: 'synthetic-google-subject-mobile',
    subjectDigest: 'b'.repeat(64),
    claimsDigest: 'c'.repeat(64),
    hostedDomain: 'psd401.net',
    email: 'synthetic.mobile@psd401.net',
    emailVerified: true,
    displayName: 'Synthetic Mobile Staff',
  }),
  device: Object.freeze({
    platform: 'ios',
    unlockMethod: 'biometric',
    installationId: 'synthetic-native-installation-0001',
  }),
});

const AUTHORIZATION: CompleteOidcSignInContext['authorization'] = Object.freeze(
  {
    user: Object.freeze({
      id: USER_ID,
      googleSubject: INPUT.claims.subject,
      email: INPUT.claims.email,
      displayName: INPUT.claims.displayName,
      roles: Object.freeze(['staff'] as const),
      facilityScope: Object.freeze({ kind: 'district' as const }),
      createdAt: '2026-08-01T00:00:00.000Z',
      disabledAt: null,
    }),
    membershipSnapshot: Object.freeze({
      id: SNAPSHOT_ID,
      version: 1,
      complete: true as const,
      syncStartedAt: '2026-08-10T17:54:00.000Z',
      capturedAt: CAPTURED_AT,
    }),
    membershipMember: Object.freeze({
      userId: USER_ID,
      googleSubject: INPUT.claims.subject,
      accessGroupSourceRefs: Object.freeze([
        Object.freeze({
          id: GROUP_SOURCE_ID,
          kind: 'google-group' as const,
          purpose: 'access' as const,
          facilityId: null,
        }),
      ]),
      facilityScope: Object.freeze({ kind: 'district' as const }),
    }),
    grantBootstrapAdmin: false,
  },
);

function envelope(
  requestId: string,
): RegisteredCapabilityEnvelope<'complete-oidc-sign-in'> {
  return parseCapabilityEnvelopeFor('complete-oidc-sign-in', {
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: {
      kind: 'verified-oidc-claims',
      ...INPUT.claims,
      audienceVerified: true,
    },
    source: 'mobile',
    requestId,
    serverTime: NOW.toISOString(),
    input: INPUT,
    idempotencyKey: `oidc:${RESPONSE_DIGEST}`,
    transport: {
      kind: 'mobile-oidc-code-exchange',
      method: 'POST',
      stateVerified: true,
      nonceVerified: true,
      pkceVerified: true,
      signatureVerified: true,
    },
  });
}

function persistedResult(
  request: PersistInitialWebSessionRequest,
): SessionEstablishmentResult {
  return Object.freeze({
    user: request.user,
    deviceEnrollment: Object.freeze({
      id: DEVICE_ID,
      userId: request.user.id,
      platform: request.device.platform,
      unlockMethod: request.device.unlockMethod,
      installationId: request.device.installationId,
      enrolledAt: request.createdAt.toISOString(),
      lastSeenAt: request.createdAt.toISOString(),
      revokedAt: null,
    }),
    session: Object.freeze({
      id: SESSION_ID,
      userId: request.user.id,
      deviceEnrollmentId: DEVICE_ID,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
      authorization: Object.freeze({
        kind: 'group-membership' as const,
        source: 'google-group-snapshot' as const,
        membershipSnapshotId: request.membershipSnapshot.id,
        membershipValidUntil: request.membershipValidUntil.toISOString(),
        membershipGraceUntil: request.membershipGraceUntil.toISOString(),
      }),
      revokedAt: null,
    }),
    connectivityEpoch: Object.freeze({
      id: EPOCH_ID,
      sessionId: SESSION_ID,
      establishedAt: request.createdAt.toISOString(),
    }),
  });
}

function context(
  signInEnvelope: RegisteredCapabilityEnvelope<'complete-oidc-sign-in'>,
  bearers: string[],
  authorization: CompleteOidcSignInContext['authorization'] = AUTHORIZATION,
): CompleteOidcSignInContext {
  return Object.freeze({
    authorization,
    bearerSink: Object.freeze({
      set(bearer: string): void {
        bearers.push(bearer);
      },
    }),
    envelope: signInEnvelope,
    responseDigest: RESPONSE_DIGEST,
  });
}

function execute(
  store: InitialWebSessionStore,
  signInContext: CompleteOidcSignInContext,
): Promise<SessionEstablishmentResult> {
  return executeCapability(
    createCompleteOidcSignInHandler({ store, policy: POLICY, now: () => NOW }),
    INPUT,
    {
      context: signInContext,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createCompleteOidcSignInAuthorizer({
        policy: POLICY,
        now: () => NOW,
      }),
    },
  );
}

describe('native initial session issuance', () => {
  test('delivers one opaque bearer while persisting only its digest', async () => {
    let persisted: PersistInitialWebSessionRequest | undefined;
    const store: InitialWebSessionStore = Object.freeze({
      async persist(request: PersistInitialWebSessionRequest) {
        persisted = request;
        return persistedResult(request);
      },
    });
    const bearers: string[] = [];

    const result = await execute(
      store,
      context(envelope('10000000-0000-4000-8000-000000000107'), bearers),
    );

    expect(result.session.id).toBe(SESSION_ID);
    expect(bearers).toHaveLength(1);
    const bearer = bearers[0];
    if (persisted === undefined || bearer === undefined) {
      throw new Error('Native credential evidence was not captured.');
    }
    expect(bearer).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(persisted.credentialDigest).toBe(digestWebSessionCredential(bearer));
    expect(JSON.stringify(result)).not.toContain(bearer);
    expect(JSON.stringify(persisted)).not.toContain(bearer);
  });

  test('rejects a second valid-code envelope for the same flow before another session or bearer exists', async () => {
    const consumedFlowKeys = new Set<string>();
    let sessionsCreated = 0;
    const store: InitialWebSessionStore = Object.freeze({
      async persist(request: PersistInitialWebSessionRequest) {
        if (consumedFlowKeys.has(request.idempotency.key)) {
          throw new WebSessionIssuanceError(
            'SESSION_REPLAY_REJECTED',
            'The verified OIDC flow was already consumed.',
          );
        }
        consumedFlowKeys.add(request.idempotency.key);
        sessionsCreated += 1;
        return persistedResult(request);
      },
    });
    const bearers: string[] = [];

    await execute(
      store,
      context(envelope('10000000-0000-4000-8000-000000000108'), bearers),
    );
    await expect(
      execute(
        store,
        context(envelope('10000000-0000-4000-8000-000000000109'), bearers),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_REPLAY_REJECTED' });

    expect(sessionsCreated).toBe(1);
    expect(consumedFlowKeys.size).toBe(1);
    expect(bearers).toHaveLength(1);
  });

  test('requires the designated-group admin projection before bearer delivery', async () => {
    const designatedGroupEligible = Object.freeze({
      ...AUTHORIZATION,
      grantBootstrapAdmin: true,
    });
    let persisted: PersistInitialWebSessionRequest | undefined;
    const store: InitialWebSessionStore = Object.freeze({
      async persist(request: PersistInitialWebSessionRequest) {
        persisted = request;
        return Object.freeze({
          ...persistedResult(request),
          user: Object.freeze({
            ...request.user,
            roles: Object.freeze(['staff', 'admin'] as const),
          }),
        });
      },
    });
    const bearers: string[] = [];

    const result = await execute(
      store,
      context(
        envelope('10000000-0000-4000-8000-000000000110'),
        bearers,
        designatedGroupEligible,
      ),
    );

    expect(persisted?.grantBootstrapAdmin).toBe(true);
    expect(result.user.roles).toEqual(['staff', 'admin']);
    expect(bearers).toHaveLength(1);
  });
});
