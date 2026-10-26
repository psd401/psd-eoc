import {
  GOOGLE_IDENTITY_ISSUER,
  InvitePartnerInputSchema,
  PartnerAccessRecordSchema,
  partnerAdmissionStatus,
  type Actor,
  type InvitePartnerInput,
  type PartnerAccessRecord,
  type PartnerAccessStatus,
  type PartnerAdmission,
  type PartnerTextAlerts,
} from '@psd-eoc/contracts';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  deviceEnrollments,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerNotices,
  partnerProviderSyncs,
  sessionRevocations,
  sessions,
  staffSmsConsents,
  users,
} from '../../db/schema';
import { appendDevicePushTokenUnregistrations } from '../auth/installation-handoff';
import { partnerAdmissionFromRow } from '../auth/partner-admission';
import { loadSmsPhoneOptOuts } from '../notify/sms-policy';
import type { PartnerMessageContext } from './messages';
import { partnerInvitationMessage } from './messages';
import type { PartnerProviders } from './providers';

/** The read and write surface partner administration needs. */
export type PartnerDatabase = Pick<
  Database,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'execute'
>;

/** What projecting admissions for the Access page reads. */
export type PartnerAccessReadDatabase = Pick<
  Database,
  'select' | 'selectDistinctOn'
>;

/** A refusal an administrator can act on; never carries an address. */
export class PartnerAccessError extends Error {
  public constructor(
    public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'PartnerAccessError';
  }
}

/**
 * Serializes every change to one address's partner access. Taken before any
 * read, so two administrators — or an administrator and the expiry sweep —
 * never decide from the same stale state.
 */
export async function lockPartnerAddress(
  database: Pick<Database, 'execute'>,
  email: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`partner-access:${email.toLowerCase()}`}, 0))`,
  );
}

const admissionColumns = {
  id: partnerAdmissions.id,
  email: partnerAdmissions.email,
  displayName: partnerAdmissions.displayName,
  agency: partnerAdmissions.agency,
  invitedByUserId: partnerAdmissions.invitedByUserId,
  admittedAt: partnerAdmissions.admittedAt,
  expiresAt: partnerAdmissions.expiresAt,
  supersedesAdmissionId: partnerAdmissions.supersedesAdmissionId,
  endingReason: partnerAdmissionEndings.reason,
  endedByUserId: partnerAdmissionEndings.endedByUserId,
  endedAt: partnerAdmissionEndings.endedAt,
} as const;

async function loadAdmissions(
  database: Pick<Database, 'select'>,
  filter: Readonly<{ ids?: readonly string[]; emails?: readonly string[] }>,
): Promise<readonly PartnerAdmission[]> {
  const rows = await database
    .select(admissionColumns)
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(
      filter.ids !== undefined
        ? inArray(partnerAdmissions.id, [...filter.ids])
        : filter.emails !== undefined
          ? inArray(partnerAdmissions.email, [...filter.emails])
          : undefined,
    )
    .orderBy(desc(partnerAdmissions.admittedAt), desc(partnerAdmissions.id));
  return rows.map(partnerAdmissionFromRow);
}

export async function loadPartnerAdmission(
  database: Pick<Database, 'select'>,
  admissionId: string,
): Promise<PartnerAdmission | null> {
  if (!/^[0-9a-f-]{36}$/u.test(admissionId)) return null;
  const [admission] = await loadAdmissions(database, { ids: [admissionId] });
  return admission ?? null;
}

/** Whether the provider should hold an enabled account for this admission. */
function expectsEnabledAccount(
  admission: PartnerAdmission,
  now: Date,
): boolean {
  return partnerAdmissionStatus(admission, now) === 'active';
}

/**
 * Projects admissions into what the Access page shows: each admission's
 * status, the provider step it still needs, its last invitation, and the
 * latest sign-in the app recorded for its address. A sign-in is a session the
 * server issued to that partner identity; Essentials keeps no history, so
 * these are the only sign-in times there are.
 *
 * Text alerts read the partner account's live consent the way partner
 * delivery does (#597), and its number's newest STOP/START fact.
 */
export async function projectPartnerAccess(
  database: PartnerAccessReadDatabase,
  admissions: readonly PartnerAdmission[],
  now: Date,
): Promise<readonly PartnerAccessRecord[]> {
  if (admissions.length === 0) return [];
  const ids = admissions.map((admission) => admission.id);
  const emails = [...new Set(admissions.map((admission) => admission.email))];
  const [syncRows, noticeRows, signInRows, sameAddressRows, consentRows] =
    await Promise.all([
      database
        .select({
          partnerAdmissionId: partnerProviderSyncs.partnerAdmissionId,
          action: partnerProviderSyncs.action,
          completedAt: partnerProviderSyncs.completedAt,
        })
        .from(partnerProviderSyncs)
        .where(inArray(partnerProviderSyncs.partnerAdmissionId, ids)),
      database
        .select({
          partnerAdmissionId: partnerNotices.partnerAdmissionId,
          sentAt: partnerNotices.sentAt,
        })
        .from(partnerNotices)
        .where(
          and(
            inArray(partnerNotices.partnerAdmissionId, ids),
            eq(partnerNotices.kind, 'invitation'),
          ),
        ),
      database
        .select({
          email: users.email,
          signedInAt: sql<Date>`max(${sessions.createdAt})`.mapWith(
            (value: string | Date) => new Date(value),
          ),
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            inArray(users.email, emails),
            ne(users.identityIssuer, GOOGLE_IDENTITY_ISSUER),
          ),
        )
        .groupBy(users.email),
      loadAdmissions(database, { emails }),
      database
        .select({
          email: users.email,
          phoneNumber: staffSmsConsents.phoneNumber,
        })
        .from(staffSmsConsents)
        .innerJoin(users, eq(users.id, staffSmsConsents.userId))
        .where(
          and(
            inArray(users.email, emails),
            isNull(users.googleSubject),
            isNull(users.disabledAt),
            isNull(staffSmsConsents.withdrawnAt),
          ),
        )
        .orderBy(desc(staffSmsConsents.consentedAt), desc(staffSmsConsents.id)),
    ]);
  const livePhone = new Map<string, string>();
  for (const row of consentRows) {
    if (!livePhone.has(row.email)) livePhone.set(row.email, row.phoneNumber);
  }
  const optedOut = await loadSmsPhoneOptOuts(
    database,
    [...new Set(livePhone.values())],
    { includePartnerEndpoints: true },
  );
  const textAlerts = (email: string): PartnerTextAlerts => {
    const phoneNumber = livePhone.get(email);
    if (phoneNumber === undefined) return 'not-signed-up';
    return optedOut.get(phoneNumber) === true ? 'opted-out' : 'signed-up';
  };
  const lastSync = new Map<string, { action: string; completedAt: Date }>();
  for (const row of syncRows) {
    const prior = lastSync.get(row.partnerAdmissionId);
    if (prior === undefined || row.completedAt >= prior.completedAt) {
      lastSync.set(row.partnerAdmissionId, row);
    }
  }
  const lastInvitation = new Map<string, Date>();
  for (const row of noticeRows) {
    const prior = lastInvitation.get(row.partnerAdmissionId);
    if (prior === undefined || row.sentAt > prior) {
      lastInvitation.set(row.partnerAdmissionId, row.sentAt);
    }
  }
  const lastSignIn = new Map(
    signInRows.map((row) => [row.email, row.signedInAt] as const),
  );
  const activeEmails = new Set(
    sameAddressRows
      .filter((admission) => expectsEnabledAccount(admission, now))
      .map((admission) => admission.email),
  );
  return admissions.map((admission) => {
    const baseStatus = partnerAdmissionStatus(admission, now);
    const signedInAt = lastSignIn.get(admission.email) ?? null;
    const status: PartnerAccessStatus =
      baseStatus !== 'active'
        ? baseStatus
        : signedInAt === null ||
            signedInAt.getTime() < Date.parse(admission.admittedAt)
          ? 'invited'
          : 'active';
    const sync = lastSync.get(admission.id);
    const providerPendingStep =
      baseStatus === 'active'
        ? sync?.action === 'enabled'
          ? null
          : ('enable' as const)
        : activeEmails.has(admission.email) || sync?.action === 'disabled'
          ? null
          : ('disable' as const);
    const invitationSentAt = lastInvitation.get(admission.id) ?? null;
    return PartnerAccessRecordSchema.parse({
      admission,
      status,
      providerPendingStep,
      invitationSentAt: invitationSentAt?.toISOString() ?? null,
      lastSignInAt: signedInAt?.toISOString() ?? null,
      textAlerts: textAlerts(admission.email),
    });
  });
}

export async function listPartnerAccess(
  database: PartnerAccessReadDatabase,
  input: Readonly<{ includeEnded: boolean }>,
  now: Date,
): Promise<readonly PartnerAccessRecord[]> {
  const admissions = await loadAdmissions(database, {});
  return projectPartnerAccess(
    database,
    input.includeEnded
      ? admissions
      : admissions.filter((admission) => admission.ending === null),
    now,
  );
}

/**
 * Admits one partner. The address is never one a district Google identity
 * uses: staff sign in as staff, and an address can be one kind of person only.
 * An unended admission named by `replacesAdmissionId` is ended `superseded`
 * in the same transaction — a corrected address or a renewal. Provider and
 * email steps follow in `reconcilePartnerAccess`, so a failure there leaves
 * this admission visibly pending rather than undone.
 */
export async function invitePartner(
  database: PartnerDatabase,
  inputValue: InvitePartnerInput,
  invitedByUserId: string,
  now: Date,
  staffDomain: string | null,
): Promise<PartnerAdmission> {
  const input = InvitePartnerInputSchema.parse(inputValue);
  const replaced =
    input.replacesAdmissionId === null
      ? null
      : await loadPartnerAdmission(database, input.replacesAdmissionId);
  if (input.replacesAdmissionId !== null && replaced === null) {
    throw new PartnerAccessError(
      'NOT_FOUND',
      'The admission to replace was not found.',
    );
  }
  for (const email of [
    ...new Set([input.email, ...(replaced === null ? [] : [replaced.email])]),
  ].sort()) {
    await lockPartnerAddress(database, email);
  }
  if (
    staffDomain !== null &&
    input.email.endsWith(`@${staffDomain.toLowerCase()}`)
  ) {
    throw new PartnerAccessError(
      'VALIDATION_ERROR',
      'A district address signs in as staff, not as a partner.',
    );
  }
  const [staffIdentity] = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.email, input.email),
        eq(users.identityIssuer, GOOGLE_IDENTITY_ISSUER),
      ),
    )
    .limit(1);
  if (staffIdentity !== undefined) {
    throw new PartnerAccessError(
      'CONFLICT',
      'That address belongs to a district staff account.',
    );
  }
  // Re-read under the lock: the state that decides is the current one.
  const current =
    replaced === null
      ? null
      : await loadPartnerAdmission(database, replaced.id);
  if (current !== null && current.ending !== null) {
    throw new PartnerAccessError(
      'CONFLICT',
      'That admission has already ended; invite the partner again instead.',
    );
  }
  const [unended] = await database
    .select({ id: partnerAdmissions.id })
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(
      and(
        eq(partnerAdmissions.email, input.email),
        isNull(partnerAdmissionEndings.id),
        current === null ? undefined : ne(partnerAdmissions.id, current.id),
      ),
    )
    .limit(1);
  if (unended !== undefined) {
    throw new PartnerAccessError(
      'CONFLICT',
      'That address already has partner access.',
    );
  }
  const [row] = await database
    .insert(partnerAdmissions)
    .values({
      email: input.email,
      displayName: input.displayName,
      agency: input.agency,
      invitedByUserId,
      admittedAt: now,
      supersedesAdmissionId: current?.id ?? null,
    })
    .returning();
  if (row === undefined) {
    throw new PartnerAccessError(
      'CONFLICT',
      'The admission could not be recorded.',
    );
  }
  if (current !== null) {
    await database.insert(partnerAdmissionEndings).values({
      partnerAdmissionId: current.id,
      reason: 'superseded',
      endedByUserId: invitedByUserId,
      endedAt: now,
    });
  }
  const admission = await loadPartnerAdmission(database, row.id);
  if (admission === null) {
    throw new PartnerAccessError('CONFLICT', 'The admission is unavailable.');
  }
  return admission;
}

/**
 * Cuts one partner out of the app at once: every session revoked, every push
 * registration ended, and any SMS consent withdrawn, so no alert reaches a
 * person whose access has ended. Idempotent. The provider account is handled
 * separately by reconciliation; the app's own refusal does not wait for it.
 */
export async function endPartnerAppAccess(
  database: PartnerDatabase,
  email: string,
  actor: Actor,
  reasonCode: string,
  now: Date,
): Promise<void> {
  const partnerUsers = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.email, email.toLowerCase()),
        ne(users.identityIssuer, GOOGLE_IDENTITY_ISSUER),
      ),
    );
  for (const { id: userId } of partnerUsers) {
    const liveSessions = await database
      .select({ id: sessions.id })
      .from(sessions)
      .leftJoin(
        sessionRevocations,
        eq(sessionRevocations.sessionId, sessions.id),
      )
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          isNull(sessionRevocations.id),
        ),
      );
    if (liveSessions.length > 0) {
      await database.insert(sessionRevocations).values(
        liveSessions.map((session) => ({
          sessionId: session.id,
          revokedBy: actor,
          reasonCode,
          revokedAt: now,
        })),
      );
    }
    const devices = await database
      .select({ id: deviceEnrollments.id })
      .from(deviceEnrollments)
      .where(eq(deviceEnrollments.userId, userId));
    for (const device of devices) {
      await appendDevicePushTokenUnregistrations(database, device.id, now);
    }
    await database
      .update(staffSmsConsents)
      .set({ withdrawnAt: now })
      .where(
        and(
          eq(staffSmsConsents.userId, userId),
          isNull(staffSmsConsents.withdrawnAt),
        ),
      );
  }
}

/**
 * Ends one admission at an administrator's decision and cuts the partner out
 * of the app. The provider account is disabled by the reconciliation that
 * follows; until it confirms, the Access page shows the step as pending.
 */
export async function disablePartner(
  database: PartnerDatabase,
  admissionId: string,
  actor: Extract<Actor, { kind: 'human' }>,
  now: Date,
): Promise<PartnerAdmission> {
  const found = await loadPartnerAdmission(database, admissionId);
  if (found === null) {
    throw new PartnerAccessError('NOT_FOUND', 'The admission was not found.');
  }
  await lockPartnerAddress(database, found.email);
  const admission = await loadPartnerAdmission(database, admissionId);
  if (admission === null || admission.ending !== null) {
    throw new PartnerAccessError(
      'CONFLICT',
      'That admission has already ended.',
    );
  }
  await database.insert(partnerAdmissionEndings).values({
    partnerAdmissionId: admission.id,
    reason: 'disabled',
    endedByUserId: actor.userId,
    endedAt: now,
  });
  await endPartnerAppAccess(
    database,
    admission.email,
    actor,
    'PARTNER_ADMISSION_DISABLED',
    now,
  );
  const ended = await loadPartnerAdmission(database, admission.id);
  if (ended === null) {
    throw new PartnerAccessError('CONFLICT', 'The admission is unavailable.');
  }
  return ended;
}

/**
 * Makes the provider and the invitation match one admission, recording each
 * step it confirms. Provider calls are idempotent, so running this again after
 * any failure — a lost response, an outage, a crash between the call and the
 * commit — converges instead of duplicating. `performedByUserId` is null for
 * the system (the expiry sweep).
 */
export async function reconcilePartnerAccess(
  database: PartnerDatabase,
  input: Readonly<{ partnerAdmissionId: string; resendInvitation: boolean }>,
  performedByUserId: string | null,
  providers: PartnerProviders,
  messageContext: PartnerMessageContext,
  now: Date,
): Promise<PartnerAccessRecord> {
  const found = await loadPartnerAdmission(database, input.partnerAdmissionId);
  if (found === null) {
    throw new PartnerAccessError('NOT_FOUND', 'The admission was not found.');
  }
  await lockPartnerAddress(database, found.email);
  const admission = await loadPartnerAdmission(database, found.id);
  if (admission === null) {
    throw new PartnerAccessError('NOT_FOUND', 'The admission was not found.');
  }
  const [before] = await projectPartnerAccess(database, [admission], now);
  if (before === undefined) {
    throw new PartnerAccessError('CONFLICT', 'The admission is unavailable.');
  }
  const enabled = expectsEnabledAccount(admission, now);
  if (input.resendInvitation && !enabled) {
    throw new PartnerAccessError(
      'CONFLICT',
      'Only a current admission’s invitation can be sent again.',
    );
  }
  if (before.providerPendingStep === 'enable') {
    const { subject } = await providers.directory.ensureEnabled(
      admission.email,
    );
    await database.insert(partnerProviderSyncs).values({
      partnerAdmissionId: admission.id,
      action: 'enabled',
      providerSubject: subject,
      performedByUserId,
      completedAt: now,
    });
  } else if (before.providerPendingStep === 'disable') {
    await providers.directory.ensureDisabled(admission.email);
    await database.insert(partnerProviderSyncs).values({
      partnerAdmissionId: admission.id,
      action: 'disabled',
      providerSubject: null,
      performedByUserId,
      completedAt: now,
    });
  }
  if (enabled && (before.invitationSentAt === null || input.resendInvitation)) {
    await providers.mailer.send({
      to: admission.email,
      ...partnerInvitationMessage(admission, messageContext),
    });
    await database.insert(partnerNotices).values({
      partnerAdmissionId: admission.id,
      kind: 'invitation',
      sentByUserId: performedByUserId,
      sentAt: now,
    });
  }
  const [after] = await projectPartnerAccess(database, [admission], now);
  if (after === undefined) {
    throw new PartnerAccessError('CONFLICT', 'The admission is unavailable.');
  }
  return after;
}
