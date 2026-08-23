import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  users,
} from '../../db/schema';
import {
  resolveEventRecipients,
  type EventPopulation,
  type EventReach,
} from './event-recipients';

/**
 * A stable identifier derived from a value rather than stored beside it.
 *
 * Recipient and endpoint identifiers end up in delivery records, so they have
 * to mean the same thing on the next send. The roster pipeline got that from a
 * snapshot row it had written earlier; resolving from the domain there is no
 * such row, so the identifier comes from the thing it identifies. Same address,
 * same id, on any deployment, without a table to keep in step.
 *
 * Formatted as a version 5 UUID because `RecipientIdSchema` is a UUID and a
 * value that merely looks like one would be a lie about how it was made.
 */
function derivedUuid(namespace: string, value: string): string {
  const digest = createHash('sha256')
    .update(`${namespace}:${value}`, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5, RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function recipientIdForEmail(email: string): string {
  return derivedUuid('psd-eoc.recipient', email.toLowerCase());
}

export interface EventAudienceEndpoint {
  readonly id: string;
  readonly channel: 'email' | 'push';
  readonly email?: string;
  readonly platform?: 'ios' | 'android';
  readonly token?: string;
}

export interface EventAudienceRecipient {
  readonly recipientId: string;
  readonly email: string;
  /** Null until this person has signed in; the address still receives email. */
  readonly displayName: string | null;
  readonly endpoints: readonly EventAudienceEndpoint[];
}

export interface EventAudience {
  readonly recipients: readonly EventAudienceRecipient[];
  readonly facilityIds: readonly string[];
  readonly oldestCapturedAt: Date | null;
  readonly unreadFacilityIds: readonly string[];
  readonly unconfiguredFacilityIds: readonly string[];
}

/**
 * Everyone an event notifies, and how to reach them.
 *
 * The membership comes from the school's staff group, not from `users`, and
 * that distinction is the whole reason this reads two tables instead of one.
 * `users` holds only people who have signed in at least once — on the live
 * deployment, one row against five authorised members. Addressing from `users`
 * would silently drop the four who never logged in, which in an emergency is
 * the difference between notifying a school and notifying whoever happened to
 * open the app.
 *
 * So email is addressed from the membership row itself: every member has an
 * address whether or not they have ever used this system. Push is addressed
 * from `device_enrollments`, which necessarily only covers people who have —
 * a device cannot enrol without a session. A member with no enrolment simply
 * has one endpoint instead of two.
 */
export async function resolveEventAudience(
  database: Database,
  input: Readonly<{
    facilityId: string;
    reach: EventReach;
    population: EventPopulation;
  }>,
): Promise<EventAudience> {
  const reached = await resolveEventRecipients(database, input);
  if (reached.emails.length === 0) {
    return Object.freeze({
      recipients: Object.freeze([]),
      facilityIds: Object.freeze(
        reached.facilities.map(({ facilityId }) => facilityId),
      ),
      oldestCapturedAt: reached.oldestCapturedAt,
      unreadFacilityIds: reached.unreadFacilityIds,
      unconfiguredFacilityIds: reached.unconfiguredFacilityIds,
    });
  }

  const emails = [...reached.emails];
  const accounts = await database
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      disabledAt: users.disabledAt,
    })
    .from(users)
    .where(inArray(users.email, emails));

  // A disabled account keeps its address — an administrator disabling somebody
  // is revoking their access to the system, not removing them from the school
  // they still work at. Their devices stop, because those are how they use it.
  const accountByEmail = new Map(
    accounts.map((account) => [account.email.toLowerCase(), account]),
  );
  const liveUserIds = accounts
    .filter(({ disabledAt }) => disabledAt === null)
    .map(({ id }) => id);

  const pushRows =
    liveUserIds.length === 0
      ? []
      : await database
          .select({
            userId: deviceEnrollments.userId,
            registrationId: devicePushTokenRegistrations.id,
            platform: devicePushTokenRegistrations.platform,
            token: devicePushTokenRegistrations.token,
          })
          .from(devicePushTokenRegistrations)
          .innerJoin(
            deviceEnrollments,
            eq(
              deviceEnrollments.id,
              devicePushTokenRegistrations.deviceEnrollmentId,
            ),
          )
          .leftJoin(
            devicePushTokenUnregistrations,
            eq(
              devicePushTokenUnregistrations.registrationId,
              devicePushTokenRegistrations.id,
            ),
          )
          .where(
            and(
              inArray(deviceEnrollments.userId, liveUserIds),
              // A revoked device must not receive: revocation is how a lost
              // phone stops being an emergency notification target.
              isNull(deviceEnrollments.revokedAt),
              isNull(devicePushTokenUnregistrations.registrationId),
            ),
          );

  const pushByUserId = new Map<string, typeof pushRows>();
  for (const row of pushRows) {
    pushByUserId.set(row.userId, [
      ...(pushByUserId.get(row.userId) ?? []),
      row,
    ]);
  }

  const recipients = emails.map((email) => {
    const account = accountByEmail.get(email);
    const push =
      account === undefined ? [] : (pushByUserId.get(account.id) ?? []);
    const endpoints: EventAudienceEndpoint[] = [
      {
        id: derivedUuid('psd-eoc.endpoint.email', email),
        channel: 'email' as const,
        email,
      },
      ...push
        // `device_push_token_registrations_native_only` already refuses any
        // other platform, so this drops nothing — but the column's type is
        // wider than its constraint, and narrowing by filter rather than by
        // assertion keeps a future third platform from silently becoming a
        // push endpoint nothing knows how to deliver to.
        .filter(
          (
            row,
          ): row is (typeof push)[number] & {
            platform: 'ios' | 'android';
          } => row.platform === 'ios' || row.platform === 'android',
        )
        .map((row) => ({
          // The registration's own id: a token is replaced by registering a
          // new one, and a delivery record should name the registration it
          // actually used rather than the device it belonged to.
          id: row.registrationId,
          channel: 'push' as const,
          platform: row.platform,
          token: row.token,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ];
    return {
      recipientId: recipientIdForEmail(email),
      email,
      displayName: account?.displayName ?? null,
      endpoints: Object.freeze(endpoints),
    };
  });

  return Object.freeze({
    recipients: Object.freeze(recipients),
    facilityIds: Object.freeze(
      reached.facilities.map(({ facilityId }) => facilityId),
    ),
    oldestCapturedAt: reached.oldestCapturedAt,
    unreadFacilityIds: reached.unreadFacilityIds,
    unconfiguredFacilityIds: reached.unconfiguredFacilityIds,
  });
}
