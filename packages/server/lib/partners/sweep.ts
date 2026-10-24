import type { PartnerAccessRecord } from '@psd-eoc/contracts';
import { and, eq, isNull, lte } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  groupSources,
  partnerAccessReviews,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerNotices,
} from '../../db/schema';
import {
  endPartnerAppAccess,
  listPartnerAccess,
  loadPartnerAdmission,
  lockPartnerAddress,
  reconcilePartnerAccess,
} from './access';
import {
  partnerAccessReviewMessage,
  partnerExpiryNoticeMessage,
  type PartnerMessageContext,
} from './messages';
import type { PartnerProviders } from './providers';

const DAY_MS = 24 * 60 * 60 * 1_000;
/** One notice, this many days before expiry (standard 14, decided 2026-10-23). */
export const PARTNER_EXPIRY_NOTICE_DAYS = 14;
/** A partner with no sign-in for this long is listed for review. */
export const PARTNER_INACTIVITY_DAYS = 90;

const SWEEP_ACTOR = Object.freeze({
  kind: 'system' as const,
  serviceId: 'partner-access-sweep',
});

/**
 * Who is listed for administrator review: current partners invited but never
 * signed in, and current partners with no sign-in in 90 days — two separate
 * groups. Review only: nothing here, or anywhere, disables a partner for
 * inactivity.
 */
export function partnerInactivityReview(
  records: readonly PartnerAccessRecord[],
  now: Date,
): Readonly<{
  neverSignedIn: readonly PartnerAccessRecord[];
  inactive: readonly PartnerAccessRecord[];
}> {
  const threshold = now.getTime() - PARTNER_INACTIVITY_DAYS * DAY_MS;
  return Object.freeze({
    neverSignedIn: records.filter((record) => record.status === 'invited'),
    inactive: records.filter(
      (record) =>
        record.status === 'active' &&
        record.lastSignInAt !== null &&
        Date.parse(record.lastSignInAt) < threshold,
    ),
  });
}

/** `YYYY-Qn` of an instant, in UTC. */
export function reviewQuarter(now: Date): string {
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

/**
 * Where a partner's reply and the quarterly review go: the addresses of the
 * active access groups that grant administrator. An administrator is whoever
 * is in those groups, so mailing the group reaches exactly them.
 */
export async function administratorGroupAddresses(
  database: Pick<Database, 'select'>,
): Promise<readonly string[]> {
  const rows = await database
    .select({ email: groupSources.email })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.purpose, 'access'),
        eq(groupSources.grantedRole, 'admin'),
        eq(groupSources.active, true),
      ),
    );
  return [
    ...new Set(
      rows.flatMap(({ email }) =>
        email === null ? [] : [email.toLowerCase()],
      ),
    ),
  ].sort();
}

export interface PartnerAccessSweepResult {
  readonly expired: number;
  readonly providerChangesCompleted: number;
  readonly providerChangesPending: number;
  readonly noticesSent: number;
  readonly noticesFailed: number;
  readonly reviewSent: boolean;
}

/**
 * The daily partner-access run. Each step is idempotent and commits per
 * admission, so a retried or overlapping run repeats nothing and one failure
 * never blocks the rest:
 *
 * 1. Every admission past its expiry is ended `expired` by the system, and
 *    the partner is cut out of the app — sessions revoked, push and SMS
 *    registrations ended. (Session reads already refused it at the expiry
 *    instant; this makes the ending a record.)
 * 2. Every ended admission whose provider account is not yet confirmed
 *    disabled is reconciled, which also completes an administrator's disable
 *    that the provider did not confirm at the time.
 * 3. Exactly one notice is sent to each partner whose admission expires within
 *    14 days. The notice row and the send share a transaction under a unique
 *    index, so a retry never sends it twice, and a failed send leaves no row,
 *    so the next run tries again rather than skipping it.
 * 4. Once a quarter, administrators receive the inactivity review.
 */
export async function runPartnerAccessSweep(
  input: Readonly<{
    database: Database;
    providers: PartnerProviders;
    messageContext: PartnerMessageContext;
    now: Date;
  }>,
): Promise<PartnerAccessSweepResult> {
  const { database, providers, messageContext, now } = input;

  // 1. Expire.
  const due = await database
    .select({ id: partnerAdmissions.id, email: partnerAdmissions.email })
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(
      and(
        isNull(partnerAdmissionEndings.id),
        lte(partnerAdmissions.expiresAt, now),
      ),
    );
  let expired = 0;
  for (const admission of due) {
    const ended = await database.transaction(async (transaction) => {
      await lockPartnerAddress(transaction, admission.email);
      const current = await loadPartnerAdmission(transaction, admission.id);
      if (
        current === null ||
        current.ending !== null ||
        Date.parse(current.expiresAt) > now.getTime()
      ) {
        return false;
      }
      await transaction.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: current.id,
        reason: 'expired',
        endedByUserId: null,
        endedAt: now,
      });
      await endPartnerAppAccess(
        transaction,
        current.email,
        SWEEP_ACTOR,
        'PARTNER_ADMISSION_EXPIRED',
        now,
      );
      return true;
    });
    if (ended) expired += 1;
  }

  // 2. Bring the provider in line with every ended admission.
  let providerChangesCompleted = 0;
  let providerChangesPending = 0;
  const pending = (
    await listPartnerAccess(database, { includeEnded: true }, now)
  ).filter((record) => record.providerPendingStep === 'disable');
  for (const record of pending) {
    try {
      await database.transaction((transaction) =>
        reconcilePartnerAccess(
          transaction,
          { partnerAdmissionId: record.admission.id, resendInvitation: false },
          null,
          providers,
          messageContext,
          now,
        ),
      );
      providerChangesCompleted += 1;
    } catch {
      providerChangesPending += 1;
    }
  }

  // 3. One notice before expiry.
  const replyTo = await administratorGroupAddresses(database);
  const noticeFrom = new Date(
    now.getTime() + PARTNER_EXPIRY_NOTICE_DAYS * DAY_MS,
  );
  const expiring = (
    await listPartnerAccess(database, { includeEnded: false }, now)
  ).filter(
    (record) =>
      (record.status === 'active' || record.status === 'invited') &&
      Date.parse(record.admission.expiresAt) <= noticeFrom.getTime(),
  );
  let noticesSent = 0;
  let noticesFailed = 0;
  for (const record of expiring) {
    try {
      const sent = await database.transaction(async (transaction) => {
        await lockPartnerAddress(transaction, record.admission.email);
        const [already] = await transaction
          .select({ id: partnerNotices.id })
          .from(partnerNotices)
          .where(
            and(
              eq(partnerNotices.partnerAdmissionId, record.admission.id),
              eq(partnerNotices.kind, 'expiry-notice'),
            ),
          )
          .limit(1);
        if (already !== undefined) return false;
        await transaction.insert(partnerNotices).values({
          partnerAdmissionId: record.admission.id,
          kind: 'expiry-notice',
          sentByUserId: null,
          sentAt: now,
        });
        await providers.mailer.send({
          to: record.admission.email,
          replyTo,
          ...partnerExpiryNoticeMessage(record.admission, messageContext),
        });
        return true;
      });
      if (sent) noticesSent += 1;
    } catch {
      noticesFailed += 1;
    }
  }

  // 4. The quarterly review, once per quarter, to administrators.
  let reviewSent = false;
  if (replyTo.length > 0) {
    const quarter = reviewQuarter(now);
    const review = partnerInactivityReview(
      await listPartnerAccess(database, { includeEnded: false }, now),
      now,
    );
    try {
      reviewSent = await database.transaction(async (transaction) => {
        const inserted = await transaction
          .insert(partnerAccessReviews)
          .values({
            quarter,
            neverSignedInCount: review.neverSignedIn.length,
            inactiveCount: review.inactive.length,
            sentAt: now,
          })
          .onConflictDoNothing({ target: partnerAccessReviews.quarter })
          .returning();
        if (inserted.length === 0) return false;
        const line = (record: PartnerAccessRecord) => ({
          displayName: record.admission.displayName,
          agency: record.admission.agency,
          email: record.admission.email,
          admittedAt: record.admission.admittedAt,
          lastSignInAt: record.lastSignInAt,
        });
        await providers.mailer.send({
          to: replyTo,
          ...partnerAccessReviewMessage(
            {
              neverSignedIn: review.neverSignedIn.map(line),
              inactive: review.inactive.map(line),
            },
            messageContext,
          ),
        });
        return true;
      });
    } catch {
      reviewSent = false;
    }
  }

  return Object.freeze({
    expired,
    providerChangesCompleted,
    providerChangesPending,
    noticesSent,
    noticesFailed,
    reviewSent,
  });
}
