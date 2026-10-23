import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  connectivityEpochs,
  deviceEnrollments,
  sessions,
  sessionTokenIssuances,
  users,
} from '../../db/schema';
import { createOpaqueRefreshToken, hashRefreshToken } from '../auth/sessions';

/** A synthetic partner identity provider; never a real pool. */
export const SYNTHETIC_PARTNER_ISSUER =
  'https://cognito-idp.example.invalid/synthetic-partner-pool';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface SyntheticPartnerSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly connectivityEpochId: string;
  /** The opaque credential a browser cookie or mobile bearer would carry. */
  readonly credential: string;
}

/**
 * Writes the rows a partner sign-in will write, for tests that need a partner
 * session before the partner sign-in flow exists: the partner identity (reused
 * when the address already has one), a web device, a one-day session, its
 * credential digest, and a connectivity epoch. Authorization is not written —
 * it is derived from the partner's admission on every read.
 */
export async function issueSyntheticPartnerSession(
  database: Database,
  input: Readonly<{
    email: string;
    displayName: string;
    now: Date;
    lifetimeMilliseconds?: number;
  }>,
): Promise<SyntheticPartnerSession> {
  const email = input.email.toLowerCase();
  const [existing] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const userId =
    existing?.id ??
    (
      await database
        .insert(users)
        .values({
          googleSubject: null,
          identityIssuer: SYNTHETIC_PARTNER_ISSUER,
          identitySubject: `synthetic-partner-${randomUUID()}`,
          email,
          displayName: input.displayName,
          facilityScopeKind: 'district',
          createdAt: input.now,
        })
        .returning()
    )[0]?.id;
  if (userId === undefined) throw new Error('No synthetic partner user.');
  const [device] = await database
    .insert(deviceEnrollments)
    .values({
      userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-partner-${randomUUID()}`,
      enrolledAt: input.now,
      lastSeenAt: input.now,
    })
    .returning();
  if (device === undefined) throw new Error('No synthetic partner device.');
  const expiresAt = new Date(
    input.now.getTime() + (input.lifetimeMilliseconds ?? DAY_MILLISECONDS),
  );
  const [session] = await database
    .insert(sessions)
    .values({
      userId,
      deviceEnrollmentId: device.id,
      membershipSnapshotId: null,
      // A partner session has no Google membership windows; these columns
      // only satisfy the table's ordering check.
      membershipValidUntil: input.now,
      membershipGraceUntil: input.now,
      createdAt: input.now,
      expiresAt,
    })
    .returning();
  if (session === undefined) throw new Error('No synthetic partner session.');
  const credential = createOpaqueRefreshToken();
  await database.insert(sessionTokenIssuances).values({
    sessionId: session.id,
    tokenDigest: hashRefreshToken(credential),
    issuedAt: input.now,
  });
  const [epoch] = await database
    .insert(connectivityEpochs)
    .values({ sessionId: session.id, establishedAt: input.now })
    .returning();
  if (epoch === undefined) throw new Error('No synthetic connectivity epoch.');
  return Object.freeze({
    userId,
    sessionId: session.id,
    connectivityEpochId: epoch.id,
    credential,
  });
}
