import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
} from '../../db/schema';

type HandoffDatabase = Pick<Database, 'insert' | 'select' | 'update'>;

/** Ends every live push registration of one enrollment, idempotently. */
export async function appendDevicePushTokenUnregistrations(
  database: Pick<Database, 'insert' | 'select'>,
  deviceEnrollmentId: string,
  unregisteredAt: Date,
): Promise<void> {
  const activePushRegistrations = await database
    .select({
      registrationId: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    );
  if (activePushRegistrations.length === 0) return;
  await database
    .insert(devicePushTokenUnregistrations)
    .values(
      activePushRegistrations.map((registration) => ({
        registrationId: registration.registrationId,
        deviceEnrollmentId: registration.deviceEnrollmentId,
        unregisteredAt,
      })),
    )
    .onConflictDoNothing({
      target: devicePushTokenUnregistrations.registrationId,
    });
}

/**
 * Whoever signs in on an installation holds the device. Every other account's
 * active enrollment on it is closed and its push registrations are ended in
 * the same transaction as the new sign-in, so the previous holder's sessions
 * stop authorizing and their notifications stop reaching a phone they no
 * longer hold. Waiting for the previous account to sign out would leave a
 * window: a lapsed session never performs a sign-out, and the new account's
 * own push registration may take a while or never come.
 */
export async function supersedeOtherAccountsOnInstallation(
  database: HandoffDatabase,
  installationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const others = await database
    .select({ id: deviceEnrollments.id })
    .from(deviceEnrollments)
    .where(
      and(
        eq(deviceEnrollments.installationId, installationId),
        ne(deviceEnrollments.userId, userId),
        isNull(deviceEnrollments.revokedAt),
      ),
    );
  for (const other of others) {
    await appendDevicePushTokenUnregistrations(database, other.id, now);
    await database
      .update(deviceEnrollments)
      .set({
        revokedAt: sql`greatest(
          ${deviceEnrollments.enrolledAt},
          ${now.toISOString()}::timestamptz
        )`,
      })
      .where(
        and(eq(deviceEnrollments.id, other.id), isNull(deviceEnrollments.revokedAt)),
      );
  }
}
