import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { IdempotencyPrincipalSchema, type StaffRole } from '@psd-eoc/contracts';
import { inArray } from 'drizzle-orm';

import type { PostgresDatabaseConnection } from '../db/client';
import {
  channelConfigurations,
  partnerAdmissions,
  type groupSources,
} from '../db/schema';
import { createCsrfToken } from '../lib/auth/middleware';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '../lib/auth/session-cookie';
import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../lib/auth/sessions';
import { authorizeSignIn } from '../lib/auth/sign-in-authorization';
import type { TrustedCapabilityInvocation } from '../lib/capabilities/engine';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../lib/capabilities/events';
import {
  createDrizzleStartFlowCapabilityStore,
  executeStartFlowCapability,
} from '../lib/capabilities/start';
import { issueSyntheticPartnerSession } from '../lib/testing/partner-session';

/**
 * The synthetic rows every end-to-end harness in this repository needs: the
 * groups that grant access, a signed-in identity, an admitted partner, and one
 * active synthetic drill. The browser harness (`run.ts`) and the native
 * partner harness both build their world out of these, so a change to what a
 * signed-in identity or a live drill means lands on both at once.
 *
 * Every identifier here is a seeded synthetic one. Nothing in this module can
 * name a real facility, a real group, or a real roster.
 */

export const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
export const SYNTHETIC_OTHER_FACILITY_ID =
  '00000000-0000-4000-8000-000000000002';
export const SYNTHETIC_REAL_VERSION_ID = '00000000-0000-4000-8000-000000000200';
export const SYNTHETIC_DRILL_VERSION_ID =
  '00000000-0000-4000-8000-000000000201';
/** The seed's first active threat, `Synthetic wildlife`. */
export const SYNTHETIC_THREAT_ID = '00000000-0000-4000-8000-000000000700';
export const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface IssuedIdentity {
  readonly userId: string;
  readonly actor: Extract<
    TrustedCapabilityInvocation['actor'],
    { kind: 'human' }
  >;
  readonly connectivityEpochId: string;
}

export function accessGroup(
  id: string,
  role: StaffRole,
  capturedAt: Date,
): typeof groupSources.$inferInsert {
  return {
    id,
    kind: 'google-group',
    purpose: 'access',
    facilityId: null,
    displayName: `Synthetic ${role} browser group`,
    active: true,
    grantedRole: role,
    membersCapturedAt: capturedAt,
    googleGroupId: `synthetic-browser-${role}-${id}`,
    email: `synthetic-browser-${role}-${id}@example.invalid`,
    fixtureKey: null,
    createdAt: capturedAt,
  };
}

export function buildingGroup(
  id: string,
  facilityId: string,
  label: string,
  capturedAt: Date,
): typeof groupSources.$inferInsert {
  return {
    id,
    kind: 'google-group',
    purpose: 'building',
    facilityId,
    displayName: `Synthetic ${label} facility staff group`,
    active: true,
    grantedRole: null,
    membersCapturedAt: capturedAt,
    googleGroupId: `synthetic-browser-building-${id}`,
    email: `synthetic-browser-building-${id}@example.invalid`,
    fixtureKey: null,
    createdAt: capturedAt,
  };
}

export async function issueIdentity(
  connection: PostgresDatabaseConnection,
  input: Readonly<{
    email: string;
    displayName: string;
    groupSourceIds: readonly string[];
    now: Date;
    /** Where to write the browser's cookies; omitted for a native harness. */
    statePath?: string;
  }>,
): Promise<IssuedIdentity> {
  const googleSubject = `synthetic-browser-${input.email}`;
  const authorization = await authorizeSignIn(connection.db, {
    googleSubject,
    email: input.email,
    displayName: input.displayName,
    checkedAt: input.now,
  });
  if (!authorization.authorized) {
    throw new Error(`Synthetic sign-in was refused: ${authorization.refusal}`);
  }

  // Where the identity acts is what its groups grant, as in production: a
  // school staff group limits it to that school, several place it at each of
  // them, and a sign-in group does not limit it at all.
  const user = authorization.user;
  const credential = randomBytes(48).toString('base64url');
  const responseDigest = digestWebSessionCredential(randomUUID());
  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: digestWebSessionCredential(googleSubject),
    responseDigest,
  });
  const result = await createDrizzleInitialWebSessionStore(
    connection.db,
  ).persist({
    user,
    membership: {
      groupSourceIds: [...input.groupSourceIds],
      admittedAccountId: null,
      capturedAt: input.now,
    },
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-browser-${randomUUID()}`,
    },
    credentialDigest: digestWebSessionCredential(credential),
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + 90 * DAY_MILLISECONDS),
    membershipValidUntil: new Date(input.now.getTime() + DAY_MILLISECONDS),
    membershipGraceUntil: new Date(input.now.getTime() + 3 * DAY_MILLISECONDS),
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digestWebSessionCredential(JSON.stringify(principal)),
      requestDigest: digestWebSessionCredential(
        `synthetic-browser:${randomUUID()}`,
      ),
    },
  });
  if (input.statePath !== undefined) {
    await writeBrowserSessionState(
      input.statePath,
      credential,
      result.session.expiresAt,
    );
  }
  return {
    userId: result.user.id,
    actor: {
      kind: 'human',
      userId: result.user.id,
      sessionId: result.session.id,
    },
    connectivityEpochId: result.connectivityEpoch.id,
  };
}

/** Writes the cookies a signed-in browser carries for one session. */
export async function writeBrowserSessionState(
  statePath: string,
  credential: string,
  expiresAt: string,
): Promise<void> {
  const expires = Math.floor(Date.parse(expiresAt) / 1_000);
  await writeFile(
    statePath,
    JSON.stringify({
      cookies: [
        {
          name: WEB_SESSION_COOKIE_NAME,
          value: credential,
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: WEB_CSRF_COOKIE_NAME,
          value: createCsrfToken(),
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: false,
          secure: true,
          sameSite: 'Strict',
        },
      ],
      origins: [],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

/**
 * An admitted partner and nothing else: no account and no session, which is
 * the state partner sign-in starts from and the only state the native partner
 * harness wants, because the sign-in under test creates the rest.
 */
export async function admitPartner(
  connection: PostgresDatabaseConnection,
  input: Readonly<{
    email: string;
    displayName: string;
    invitedByUserId: string;
    /** When the admission was granted. */
    admittedAt: Date;
  }>,
): Promise<string> {
  const [admission] = await connection.db
    .insert(partnerAdmissions)
    .values({
      email: input.email,
      displayName: input.displayName,
      agency: 'Synthetic Fire District',
      invitedByUserId: input.invitedByUserId,
      admittedAt: input.admittedAt,
    })
    .returning({ id: partnerAdmissions.id });
  if (admission === undefined) throw new Error('No partner admission.');
  return admission.id;
}

/**
 * A partner admitted by the district administrator, with a signed-in browser
 * session, for the browser flows. The session rows are the ones a partner
 * sign-in writes.
 */
export async function issuePartner(
  connection: PostgresDatabaseConnection,
  input: Readonly<{
    email: string;
    displayName: string;
    invitedByUserId: string;
    now: Date;
    /** When the admission was granted; defaults to `now`. */
    admittedAt?: Date;
    statePath: string;
  }>,
): Promise<Readonly<{ admissionId: string; userId: string }>> {
  const admissionId = await admitPartner(connection, {
    email: input.email,
    displayName: input.displayName,
    invitedByUserId: input.invitedByUserId,
    admittedAt: input.admittedAt ?? input.now,
  });
  const issued = await issueSyntheticPartnerSession(connection.db, {
    email: input.email,
    displayName: input.displayName,
    now: input.now,
  });
  await writeBrowserSessionState(
    input.statePath,
    issued.credential,
    new Date(input.now.getTime() + DAY_MILLISECONDS).toISOString(),
  );
  return Object.freeze({ admissionId, userId: issued.userId });
}

export function invocation(
  identity: IssuedIdentity,
  mutation: TrustedCapabilityInvocation['mutation'],
): TrustedCapabilityInvocation {
  return {
    actor: identity.actor,
    source: 'web',
    scope: { facilityScope: { kind: 'district' } },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: identity.connectivityEpochId,
    mutation,
  };
}

export async function createSyntheticDrill(
  connection: PostgresDatabaseConnection,
  identity: IssuedIdentity,
): Promise<string> {
  await connection.db
    .update(channelConfigurations)
    .set({ enabled: true, changedAt: new Date() })
    .where(
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
      ]),
    );
  const preview = await executeStartFlowCapability(
    'create-activation-preview',
    {
      facilityId: SYNTHETIC_FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: {
        id: SYNTHETIC_DRILL_VERSION_ID,
        templateMode: 'drill',
      },
      rosterPopulation: 'synthetic',
      threatId: SYNTHETIC_THREAT_ID,
      threatDetail: null,
      responseDetail: null,
    },
    invocation(identity, null),
    createDrizzleStartFlowCapabilityStore(connection.db),
  );
  if (preview.sendReadiness !== 'ready') {
    throw new Error(
      `Synthetic drill preview was not safely ready: ${preview.blockingReasonCodes.join(', ')}`,
    );
  }
  const result = await executeEventCapability(
    'start-event',
    {
      source: 'activation-preview',
      activationPreviewId: preview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: preview.activeEventIds,
      },
    },
    invocation(identity, {
      idempotencyKey: `synthetic-browser-start-${randomUUID()}`,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: null,
    }),
    createDrizzleEventCapabilityStore(connection.db),
  );
  if (
    result.event.kind !== 'drill' ||
    result.event.rosterPopulation !== 'synthetic' ||
    result.event.status !== 'active'
  ) {
    throw new Error('Synthetic setup created an unsafe or inactive event.');
  }
  return result.event.id;
}
