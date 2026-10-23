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
