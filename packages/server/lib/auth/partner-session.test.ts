import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  CompleteOidcSignInInputSchema,
  parseCapabilityEnvelopeFor,
  partnerAdmissionExpiresAt,
  PartnerAdmissionSchema,
  SessionEstablishmentResultSchema,
  UserSchema,
  type PartnerAdmission,
  type SessionEstablishmentResult,
  type User,
} from '@psd-eoc/contracts';

import {
  createPartnerSignInAuthorizer,
  createPartnerSignInHandler,
  DEFAULT_PARTNER_SESSION_POLICY,
  PARTNER_SESSION_LIFETIME_SECONDS,
  validatePartnerSessionPolicy,
  type PartnerSessionStore,
  type PartnerSignInContext,
  type PersistPartnerSessionRequest,
} from './partner-session';
import {
  createCompletePartnerSignInEnvelope,
  createPartnerSignInCompletion,
} from './partner-sign-in';
import { DEFAULT_SESSION_POLICY } from './sessions';
import {
  WebSessionIssuanceError,
  type WebSessionCookie,
} from './session-cookie';

/**
 * Issue #593. A partner session lasts at most one day, and saying so must not
 * have changed what a staff session lasts.
 */

const PARTNER_ISSUER =
  'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1';
const EMAIL = 'responder@agency.example.invalid';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const DAY_SECONDS = 24 * 60 * 60;

function admission(
  overrides: Readonly<Partial<PartnerAdmission>> = {},
): PartnerAdmission {
  const admittedAt = new Date(NOW.getTime() - 60_000).toISOString();
  return PartnerAdmissionSchema.parse({
    id: randomUUID(),
    email: EMAIL,
    displayName: 'Synthetic Responder',
    agency: 'Synthetic Fire District',
    invitedByUserId: randomUUID(),
    admittedAt,
    expiresAt: partnerAdmissionExpiresAt(admittedAt),
    supersedesAdmissionId: null,
    ending: null,
    ...overrides,
  });
}

function partnerUser(overrides: Readonly<Partial<User>> = {}): User {
  return UserSchema.parse({
    id: randomUUID(),
    googleSubject: null,
    email: EMAIL,
    displayName: 'Synthetic Responder',
    roles: ['partner'],
    facilityScope: { kind: 'district' },
    createdAt: NOW.toISOString(),
    disabledAt: null,
    ...overrides,
  });
}

function completion(subject = 'cognito-sub-1') {
  return createPartnerSignInCompletion({
    claims: {
      issuer: PARTNER_ISSUER,
      audience: 'partner-app-client',
      subject,
      email: EMAIL,
      claimsDigest: createHash('sha256').update(subject).digest('hex'),
    },
    displayName: 'Synthetic Responder',
    installationId: 'web.installation-identifier',
    requestId: randomUUID(),
  });
}

function context(
  options: Readonly<{
    user?: User;
    admission?: PartnerAdmission;
    cookies?: WebSessionCookie[];
    subject?: string;
  }> = {},
) {
  const built = completion(options.subject);
  const envelope = parseCapabilityEnvelopeFor(
    'complete-oidc-sign-in',
    createCompletePartnerSignInEnvelope(built, {
      requestId: randomUUID(),
      serverTime: NOW.toISOString(),
    }),
  );
  const cookies = options.cookies ?? [];
  const signInContext: PartnerSignInContext = {
    authorization: {
      user: options.user ?? partnerUser(),
      admission: options.admission ?? admission(),
      capturedAt: NOW,
    },
    cookieSink: {
      set(cookie: WebSessionCookie): void {
        cookies.push(cookie);
      },
    },
    envelope,
    responseDigest: built.responseDigest,
  };
  return { built, envelope, signInContext, cookies };
}

/** Answers with exactly the evidence the request asked to be persisted. */
function acceptingStore(
  captured: PersistPartnerSessionRequest[] = [],
): PartnerSessionStore {
  return {
    persist(
      request: PersistPartnerSessionRequest,
    ): Promise<SessionEstablishmentResult> {
      captured.push(request);
      const deviceId = randomUUID();
      const sessionId = randomUUID();
      return Promise.resolve(
        SessionEstablishmentResultSchema.parse({
          user: request.user,
          session: {
            id: sessionId,
            userId: request.user.id,
            deviceEnrollmentId: deviceId,
            createdAt: request.createdAt.toISOString(),
            expiresAt: request.expiresAt.toISOString(),
            authorization: {
              kind: 'partner-admission',
              partnerAdmissionId: request.admission.id,
              admissionExpiresAt: request.admission.expiresAt,
            },
            revokedAt: null,
          },
          deviceEnrollment: {
            id: deviceId,
            userId: request.user.id,
            platform: request.device.platform,
            unlockMethod: request.device.unlockMethod,
            installationId: request.device.installationId,
            enrolledAt: request.createdAt.toISOString(),
            lastSeenAt: request.createdAt.toISOString(),
            revokedAt: null,
          },
          connectivityEpoch: {
            id: randomUUID(),
            sessionId,
            establishedAt: request.createdAt.toISOString(),
          },
        }),
      );
    },
  };
}

describe('the partner session policy', () => {
  test('one day is the ceiling and nothing can raise it', () => {
    expect(PARTNER_SESSION_LIFETIME_SECONDS).toBe(DAY_SECONDS);
    expect(
      validatePartnerSessionPolicy({ sessionLifetimeSeconds: 3_600 }),
    ).toEqual({ sessionLifetimeSeconds: 3_600 });
    for (const seconds of [DAY_SECONDS + 1, 90 * DAY_SECONDS, 0, -1, 1.5]) {
      expect(() =>
        validatePartnerSessionPolicy({ sessionLifetimeSeconds: seconds }),
      ).toThrow(WebSessionIssuanceError);
    }
  });

  test('the staff session policy is unchanged', () => {
    // The 90-day staff session is the policy this change deliberately left
    // alone: a partner's one day is its own policy, not a global shortening.
    expect(DEFAULT_SESSION_POLICY.sessionLifetimeSeconds).toBe(
      90 * DAY_SECONDS,
    );
    expect(
      DEFAULT_PARTNER_SESSION_POLICY.sessionLifetimeSeconds,
    ).toBeLessThanOrEqual(DAY_SECONDS);
  });
});

describe('partner session issuance', () => {
  test('issues a one-day cookie for an admitted partner', async () => {
    const captured: PersistPartnerSessionRequest[] = [];
    const { envelope, signInContext, cookies } = context();
    const handler = createPartnerSignInHandler({
      store: acceptingStore(captured),
      policy: DEFAULT_PARTNER_SESSION_POLICY,
      now: () => NOW,
    });
    const result = await handler.handler(envelope.input, signInContext);
    expect(result.session.authorization.kind).toBe('partner-admission');
    expect(Date.parse(result.session.expiresAt) - NOW.getTime()).toBe(
      DAY_SECONDS * 1_000,
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.maxAge).toBe(DAY_SECONDS);
    expect(cookies[0]?.httpOnly).toBe(true);
    expect(cookies[0]?.secure).toBe(true);
    // The store receives a digest, never the credential in the cookie.
    expect(captured[0]?.credentialDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(captured[0]?.credentialDigest).not.toBe(cookies[0]?.value);
  });

  test('a session never outlives the admission behind it', async () => {
    const endsSoon = new Date(NOW.getTime() + 2 * 60 * 60 * 1_000);
    const admittedAt = new Date(
      endsSoon.getTime() - 365 * DAY_SECONDS * 1_000,
    ).toISOString();
    const shortAdmission = admission({
      admittedAt,
      expiresAt: partnerAdmissionExpiresAt(admittedAt),
    });
    const { envelope, signInContext } = context({
      admission: shortAdmission,
    });
    const result = await createPartnerSignInHandler({
      store: acceptingStore(),
      policy: DEFAULT_PARTNER_SESSION_POLICY,
      now: () => NOW,
    }).handler(envelope.input, signInContext);
    expect(Date.parse(result.session.expiresAt)).toBe(
      Date.parse(shortAdmission.expiresAt),
    );
  });

  test('an expired admission issues nothing', async () => {
    const admittedAt = new Date(
      NOW.getTime() - 400 * DAY_SECONDS * 1_000,
    ).toISOString();
    const { envelope, signInContext } = context({
      admission: admission({
        admittedAt,
        expiresAt: partnerAdmissionExpiresAt(admittedAt),
      }),
    });
    const dependencies = {
      store: acceptingStore(),
      policy: DEFAULT_PARTNER_SESSION_POLICY,
      now: () => NOW,
    };
    await expect(
      createPartnerSignInHandler(dependencies).handler(
        envelope.input,
        signInContext,
      ),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_CURRENT' });
  });

  test('a partner identity is never a staff identity in any role', () => {
    // There is no partner session to refuse for these two, because there is
    // no such account: the identity contract refuses both shapes outright.
    expect(() => partnerUser({ googleSubject: 'google-subject-1' })).toThrow();
    expect(() => partnerUser({ roles: ['partner', 'admin'] })).toThrow();
  });

  test('a user the handler is handed without the partner role is refused', async () => {
    const { envelope, signInContext } = context();
    const staffShaped = {
      ...signInContext,
      authorization: {
        ...signInContext.authorization,
        user: { ...signInContext.authorization.user, roles: ['staff'] },
      },
    } as unknown as PartnerSignInContext;
    await expect(
      createPartnerSignInHandler({
        store: acceptingStore(),
        policy: DEFAULT_PARTNER_SESSION_POLICY,
        now: () => NOW,
      }).handler(envelope.input, staffShaped),
    ).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION_CONTEXT' });
  });

  test('an admission for another address is refused', async () => {
    const { envelope, signInContext } = context({
      admission: admission({ email: 'someone-else@agency.example.invalid' }),
    });
    await expect(
      createPartnerSignInHandler({
        store: acceptingStore(),
        policy: DEFAULT_PARTNER_SESSION_POLICY,
        now: () => NOW,
      }).handler(envelope.input, signInContext),
    ).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION_CONTEXT' });
  });

  test('a store that answers with other evidence is refused', async () => {
    const { envelope, signInContext } = context();
    const wrongStore: PartnerSessionStore = {
      persist: (request) =>
        acceptingStore()
          .persist(request)
          .then((result) =>
            SessionEstablishmentResultSchema.parse({
              ...result,
              session: {
                ...result.session,
                // One minute longer than the authorized lifetime.
                expiresAt: new Date(
                  Date.parse(result.session.expiresAt) + 60_000,
                ).toISOString(),
              },
            }),
          ),
    };
    await expect(
      createPartnerSignInHandler({
        store: wrongStore,
        policy: DEFAULT_PARTNER_SESSION_POLICY,
        now: () => NOW,
      }).handler(envelope.input, signInContext),
    ).rejects.toMatchObject({ code: 'PERSISTED_RESULT_MISMATCH' });
  });
});

describe('the partner sign-in authorizer', () => {
  const definition = { id: 'complete-oidc-sign-in' } as const;

  function authorize(
    signInContext: PartnerSignInContext,
    input: unknown,
  ): void {
    createPartnerSignInAuthorizer({
      policy: DEFAULT_PARTNER_SESSION_POLICY,
      now: () => NOW,
    }).authorize({
      definition,
      invocationPolicy: { principalKinds: [], sources: [] },
      input,
      humanActionRequirement: { actionIds: [], consequenceDigest: null },
      context: signInContext,
    } as never);
  }

  test('admits a verified partner with a current admission', () => {
    const { envelope, signInContext } = context();
    expect(() => {
      authorize(signInContext, envelope.input);
    }).not.toThrow();
  });

  test('refuses another capability', () => {
    const { envelope, signInContext } = context();
    expect(() => {
      createPartnerSignInAuthorizer({
        policy: DEFAULT_PARTNER_SESSION_POLICY,
        now: () => NOW,
      }).authorize({
        definition: { id: 'start-event' },
        invocationPolicy: { principalKinds: [], sources: [] },
        input: envelope.input,
        humanActionRequirement: { actionIds: [], consequenceDigest: null },
        context: signInContext,
      } as never);
    }).toThrow(WebSessionIssuanceError);
  });

  test('refuses input the envelope does not carry', () => {
    const { signInContext } = context();
    const other = completion('cognito-sub-2');
    expect(() => {
      authorize(
        signInContext,
        CompleteOidcSignInInputSchema.parse(other.capabilityInput),
      );
    }).toThrow(WebSessionIssuanceError);
  });
});
