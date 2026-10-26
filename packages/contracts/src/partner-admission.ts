import { z } from 'zod';

import { isAtOrAfter, TimestampSchema, UuidSchema } from './shared';

/**
 * A partner admission lets one person from outside the district — a police or
 * fire responder — sign in through the partner identity provider for one year.
 *
 * It is a separate record from an admitted account on purpose. An admitted
 * account admits a Google identity as staff; a partner admission admits a
 * non-Google identity as `partner` and nothing more. Neither can stand in for
 * the other.
 *
 * Admissions are append-only. Nothing about one is ever edited: a typo in the
 * address, a renewal, and an administrator's disable all end the admission
 * with an ending record, and a renewal or correction is a new admission that
 * names the one it supersedes.
 */

/** A partner's sign-in address, normalized the way the users table stores one. */
export const PartnerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

/** The partner's name as an administrator entered it. */
export const PartnerDisplayNameSchema = z.string().trim().min(1).max(160);

/** The agency the partner responds for, as an administrator entered it. */
export const PartnerAgencySchema = z.string().trim().min(1).max(160);

/**
 * Why an admission ended. `disabled` is an administrator's decision and
 * `expired` is the system's, so the two stay distinguishable in every record
 * and on the Access page. `superseded` means a newer admission replaced it.
 */
export const PartnerAdmissionEndingReasonSchema = z.enum([
  'disabled',
  'expired',
  'superseded',
]);

export type PartnerAdmissionEndingReason = z.infer<
  typeof PartnerAdmissionEndingReasonSchema
>;

/**
 * Returns the instant an admission granted at `admittedAt` expires: the same
 * UTC wall-clock time one calendar year later, with February 29 falling back
 * to February 28. The database computes the stored value with the same rule;
 * this exists so contracts can check a record against it.
 */
export function partnerAdmissionExpiresAt(admittedAt: string): string {
  const admitted = new Date(admittedAt);
  const year = admitted.getUTCFullYear() + 1;
  const month = admitted.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(admitted.getUTCDate(), lastDayOfMonth),
      admitted.getUTCHours(),
      admitted.getUTCMinutes(),
      admitted.getUTCSeconds(),
      admitted.getUTCMilliseconds(),
    ),
  ).toISOString();
}

/** How and when one admission ended. */
export const PartnerAdmissionEndingSchema = z
  .object({
    reason: PartnerAdmissionEndingReasonSchema,
    /** The administrator who ended it; null only when the system expired it. */
    endedByUserId: UuidSchema.nullable(),
    endedAt: TimestampSchema,
  })
  .strict()
  .superRefine((ending, context) => {
    if ((ending.reason === 'expired') !== (ending.endedByUserId === null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Only the system expires an admission, and only an administrator disables or supersedes one.',
        path: ['endedByUserId'],
      });
    }
  })
  .readonly();

export type PartnerAdmissionEnding = z.infer<
  typeof PartnerAdmissionEndingSchema
>;

export const PartnerAdmissionSchema = z
  .object({
    id: UuidSchema,
    email: PartnerEmailSchema,
    displayName: PartnerDisplayNameSchema,
    agency: PartnerAgencySchema,
    invitedByUserId: UuidSchema,
    admittedAt: TimestampSchema,
    /** Always one year after admission; the database computes it. */
    expiresAt: TimestampSchema,
    /** The admission this one replaced, for a renewal or a corrected address. */
    supersedesAdmissionId: UuidSchema.nullable(),
    ending: PartnerAdmissionEndingSchema.nullable(),
  })
  .strict()
  .superRefine((admission, context) => {
    if (
      Date.parse(admission.expiresAt) !==
      Date.parse(partnerAdmissionExpiresAt(admission.admittedAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A partner admission expires one year after it was granted.',
        path: ['expiresAt'],
      });
    }
    if (
      admission.ending !== null &&
      !isAtOrAfter(admission.ending.endedAt, admission.admittedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An admission cannot end before it was granted.',
        path: ['ending', 'endedAt'],
      });
    }
    if (admission.supersedesAdmissionId === admission.id) {
      context.addIssue({
        code: 'custom',
        message: 'An admission cannot supersede itself.',
        path: ['supersedesAdmissionId'],
      });
    }
  })
  .readonly();

export type PartnerAdmission = z.infer<typeof PartnerAdmissionSchema>;

/**
 * Where an admission stands at one instant. An admission past its expiry is
 * `expired` the moment the date passes, before any sweep records the ending,
 * so a session read never has to wait for the sweep to refuse it.
 */
export const PartnerAdmissionStatusSchema = z.enum([
  'active',
  'expired',
  'disabled',
  'superseded',
]);

export type PartnerAdmissionStatus = z.infer<
  typeof PartnerAdmissionStatusSchema
>;

export function partnerAdmissionStatus(
  admission: Pick<PartnerAdmission, 'expiresAt' | 'ending'>,
  now: Date,
): PartnerAdmissionStatus {
  if (admission.ending !== null) return admission.ending.reason;
  return now.getTime() >= Date.parse(admission.expiresAt)
    ? 'expired'
    : 'active';
}

/**
 * A confirmed change at the partner identity provider for one admission:
 * the account was created or re-enabled (`enabled`), or disabled and signed
 * out everywhere (`disabled`). The admission is what the app expects; these
 * are what it has confirmed, so a gap between the two is visible drift.
 */
export const PartnerProviderActionSchema = z.enum(['enabled', 'disabled']);

export type PartnerProviderAction = z.infer<typeof PartnerProviderActionSchema>;

/** Email the app sends a partner about their admission. */
export const PartnerNoticeKindSchema = z.enum(['invitation', 'expiry-notice']);

export type PartnerNoticeKind = z.infer<typeof PartnerNoticeKindSchema>;

/**
 * Invites a partner, or re-invites one. `replacesAdmissionId` names the
 * admission this one takes over from: an unended one is ended `superseded`
 * (an address typo, or a renewal), an ended one is only linked as history
 * (re-inviting someone who was disabled or expired). An address is never
 * edited in place.
 */
export const InvitePartnerInputSchema = z
  .object({
    email: PartnerEmailSchema,
    displayName: PartnerDisplayNameSchema,
    agency: PartnerAgencySchema,
    replacesAdmissionId: UuidSchema.nullable(),
  })
  .strict()
  .readonly();

export type InvitePartnerInput = z.infer<typeof InvitePartnerInputSchema>;

/** Ends one partner's admission at an administrator's decision. */
export const DisablePartnerInputSchema = z
  .object({ partnerAdmissionId: UuidSchema })
  .strict()
  .readonly();

export type DisablePartnerInput = z.infer<typeof DisablePartnerInputSchema>;

/**
 * Brings the partner identity provider and the invitation email in line with
 * one admission: an active admission needs an enabled provider account and a
 * sent invitation, an ended one a disabled, signed-out account. Run after
 * every partner change and again from the Access page whenever a step is
 * still pending. `resendInvitation` sends the invitation again even when one
 * was already sent.
 */
export const ReconcilePartnerAccessInputSchema = z
  .object({
    partnerAdmissionId: UuidSchema,
    resendInvitation: z.boolean(),
  })
  .strict()
  .readonly();

export type ReconcilePartnerAccessInput = z.infer<
  typeof ReconcilePartnerAccessInputSchema
>;

export const ListPartnersInputSchema = z
  .object({ includeEnded: z.boolean() })
  .strict()
  .readonly();

export type ListPartnersInput = z.infer<typeof ListPartnersInputSchema>;

/**
 * How a partner appears on the Access page. `invited` is an active admission
 * whose partner has not signed in since it was granted; the other values are
 * the admission's own status.
 */
export const PartnerAccessStatusSchema = z.enum([
  'invited',
  'active',
  'disabled',
  'expired',
  'superseded',
]);

export type PartnerAccessStatus = z.infer<typeof PartnerAccessStatusSchema>;

/**
 * The provider step one admission still needs, if any. `enable` means the
 * partner's provider account has not been confirmed created and enabled for
 * this admission; `disable` means an ended admission's account has not been
 * confirmed disabled and signed out. Null means the provider matches.
 */
export const PartnerProviderPendingStepSchema = z
  .enum(['enable', 'disable'])
  .nullable();

/**
 * Whether a partner gets alert texts, as the Access page shows it.
 * `not-signed-up` is no live consent: never given, or withdrawn in the app.
 * `opted-out` is a live consent whose number replied STOP and has not
 * replied START since. The provider keeps one opt-out list per number, so a
 * STOP recorded for a staff endpoint with the same number counts too.
 */
export const PartnerTextAlertsSchema = z.enum([
  'not-signed-up',
  'signed-up',
  'opted-out',
]);

export type PartnerTextAlerts = z.infer<typeof PartnerTextAlertsSchema>;

export const PartnerAccessRecordSchema = z
  .object({
    admission: PartnerAdmissionSchema,
    status: PartnerAccessStatusSchema,
    providerPendingStep: PartnerProviderPendingStepSchema,
    /** When the invitation was last sent; null until it has been. */
    invitationSentAt: TimestampSchema.nullable(),
    /** The partner's latest sign-in the app recorded; null if never. */
    lastSignInAt: TimestampSchema.nullable(),
    textAlerts: PartnerTextAlertsSchema,
  })
  .strict()
  .readonly();

export type PartnerAccessRecord = z.infer<typeof PartnerAccessRecordSchema>;

/** Bounded: a district admits responders by the hundred, not the thousand. */
export const PartnerAccessListSchema = z
  .object({ items: z.array(PartnerAccessRecordSchema).max(2_000).readonly() })
  .strict()
  .readonly();

export type PartnerAccessList = z.infer<typeof PartnerAccessListSchema>;
