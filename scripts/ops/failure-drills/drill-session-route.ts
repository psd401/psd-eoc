import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { IdempotencyPrincipalSchema, UserSchema } from '@psd-eoc/contracts';
import { inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '@psd-eoc/server/db/client';
import {
  channelConfigurations,
  groupMembers,
  groupSources,
} from '@psd-eoc/server/db/schema';
import { createCsrfToken } from '@psd-eoc/server/lib/auth/middleware';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '@psd-eoc/server/lib/auth/session-cookie';
import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '@psd-eoc/server/lib/auth/sessions';
import { authorizeSignIn } from '@psd-eoc/server/lib/auth/sign-in-authorization';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '@psd-eoc/server/lib/capabilities/events';
import type { TrustedCapabilityInvocation } from '@psd-eoc/server/lib/capabilities/engine';
import {
  createDrizzleStartFlowCapabilityStore,
  executeStartFlowCapability,
} from '@psd-eoc/server/lib/capabilities/start';
import { authorizeSyntheticSessionRequest } from './drill-session-boundary';

export const dynamic = 'force-dynamic';

const ACCESS_GROUP_ID = '31000000-0000-4000-8000-000000000031';
const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function invocation(
  userId: string,
  sessionId: string,
  connectivityEpochId: string,
  mutation: TrustedCapabilityInvocation['mutation'],
): TrustedCapabilityInvocation {
  return {
    actor: { kind: 'human', userId, sessionId },
    connectivityEpochId,
    mutation,
    requestId: randomUUID(),
    scope: { facilityScope: { kind: 'district' } },
    serverTime: new Date(),
    source: 'web',
  };
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; Secure; SameSite=Strict`;
}

async function issueSyntheticSessionAndEvent() {
  const connection = createDatabaseClient(readDatabaseConfig());
  if (connection.driver !== 'postgres') {
    throw new Error('The synthetic drill requires native PostgreSQL.');
  }
  try {
    const now = new Date();
    const email = 'operator@example.invalid';
    await connection.db
      .insert(groupSources)
      .values({
        active: true,
        createdAt: now,
        displayName: 'Synthetic failure-drill administrators',
        email,
        facilityId: null,
        fixtureKey: null,
        googleGroupId: 'synthetic-failure-drill-administrators',
        grantedRole: 'admin',
        id: ACCESS_GROUP_ID,
        kind: 'google-group',
        membersCapturedAt: now,
        purpose: 'access',
      })
      .onConflictDoNothing();
    await connection.db
      .insert(groupMembers)
      .values({ capturedAt: now, email, groupSourceId: ACCESS_GROUP_ID })
      .onConflictDoNothing();
    const authorization = await authorizeSignIn(connection.db, {
      checkedAt: now,
      displayName: 'Synthetic Failure Drill Operator',
      email,
      googleSubject: 'synthetic-failure-drill-operator',
    });
    if (!authorization.authorized) {
      throw new Error('The synthetic operator could not be authorized.');
    }
    const user = UserSchema.parse({
      ...authorization.user,
      facilityScope: { kind: 'district' },
    });
    const credential = randomBytes(48).toString('base64url');
    const responseDigest = digestWebSessionCredential(randomUUID());
    const principal = IdempotencyPrincipalSchema.parse({
      kind: 'oidc-callback',
      responseDigest,
      subjectDigest: digestWebSessionCredential(user.googleSubject),
    });
    const session = await createDrizzleInitialWebSessionStore(
      connection.db,
    ).persist({
      createdAt: now,
      credentialDigest: digestWebSessionCredential(credential),
      device: {
        installationId: `synthetic-browser-${randomUUID()}`,
        platform: 'web',
        unlockMethod: 'secure-session-cookie',
      },
      expiresAt: new Date(now.getTime() + DAY_MILLISECONDS),
      idempotency: {
        key: `oidc:${responseDigest}`,
        principal,
        principalDigest: createHash('sha256')
          .update(JSON.stringify(principal), 'utf8')
          .digest('hex'),
        requestDigest: digestWebSessionCredential(
          `synthetic-browser:${randomUUID()}`,
        ),
      },
      membership: {
        capturedAt: now,
        groupSourceIds: [ACCESS_GROUP_ID],
      },
      membershipGraceUntil: new Date(now.getTime() + 3 * DAY_MILLISECONDS),
      membershipValidUntil: new Date(now.getTime() + DAY_MILLISECONDS),
      requestId: randomUUID(),
      user,
    });
    await connection.db
      .update(channelConfigurations)
      .set({ changedAt: now, enabled: true })
      .where(
        inArray(channelConfigurations.integrationId, [
          'expo-push',
          'ses-email',
        ]),
      );
    const trusted = invocation(
      session.user.id,
      session.session.id,
      session.connectivityEpoch.id,
      null,
    );
    const preview = await executeStartFlowCapability(
      'create-activation-preview',
      {
        eventTypeVersion: {
          id: SYNTHETIC_DRILL_VERSION_ID,
          templateMode: 'drill',
        },
        facilityId: SYNTHETIC_FACILITY_ID,
        kind: 'drill',
        rosterPopulation: 'synthetic',
        templateMode: 'drill',
      },
      trusted,
      createDrizzleStartFlowCapabilityStore(connection.db),
    );
    const started = await executeEventCapability(
      'start-event',
      {
        activationPreviewId: preview.id,
        activeEventDecision: {
          activeEventIdsSeen: preview.activeEventIds,
          decision: 'start-new',
        },
        source: 'activation-preview',
      },
      invocation(
        session.user.id,
        session.session.id,
        session.connectivityEpoch.id,
        {
          humanConfirmationId: null,
          idempotencyKey: `failure-drill-${randomUUID()}`,
          transport: {
            csrfVerified: true,
            interaction: 'explicit-user-submit',
            kind: 'web-interactive',
            method: 'POST',
          },
        },
      ),
      createDrizzleEventCapabilityStore(connection.db),
    );
    return {
      credential,
      csrf: createCsrfToken(),
      eventId: started.event.id,
    };
  } finally {
    await connection.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const applicationOrigin = authorizeSyntheticSessionRequest(request);
    const issued = await issueSyntheticSessionAndEvent();
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    });
    headers.append(
      'Set-Cookie',
      cookie(WEB_SESSION_COOKIE_NAME, issued.credential, 24 * 60 * 60),
    );
    headers.append(
      'Set-Cookie',
      cookie(WEB_CSRF_COOKIE_NAME, issued.csrf, 24 * 60 * 60).replace(
        '; HttpOnly',
        '',
      ),
    );
    return new Response(
      JSON.stringify({
        applicationOrigin,
        eventPath: `/events/${issued.eventId}`,
      }),
      { headers, status: 201 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'failure-drill-session-refused',
        reason: error instanceof Error ? error.message : 'unknown-error',
      }),
    );
    return Response.json(
      { code: 'FAILURE_DRILL_SESSION_REFUSED' },
      { status: 403 },
    );
  }
}
