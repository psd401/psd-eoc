import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './shared';

/** A sign-in address, normalized the way the users table stores one. */
export const AdmittedAccountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320);

const AdmissionNoteSchema = z.string().trim().max(240);

/**
 * One address admitted to sign in without being in a designated Google group.
 *
 * Admission grants `staff` and nothing more: administrators come only from
 * groups, so the final-administrator guards never have to reason about a row
 * written here. It exists for the account no group should hold, such as the
 * one an app store reviewer signs in with. Revocation keeps the row so the
 * record of who admitted whom, and when it ended, is never rewritten.
 */
export const AdmittedAccountSchema = z
  .object({
    id: UuidSchema,
    email: AdmittedAccountEmailSchema,
    note: AdmissionNoteSchema,
    admittedAt: TimestampSchema,
    admittedByUserId: UuidSchema,
    revokedAt: TimestampSchema.nullable(),
    revokedByUserId: UuidSchema.nullable(),
  })
  .strict()
  .readonly();

export type AdmittedAccount = z.infer<typeof AdmittedAccountSchema>;

export const AdmitAccountInputSchema = z
  .object({
    email: AdmittedAccountEmailSchema,
    /** Why this address is admitted; shown on the Access page. */
    note: AdmissionNoteSchema.optional(),
  })
  .strict()
  .readonly();

export type AdmitAccountInput = z.infer<typeof AdmitAccountInputSchema>;

export const RevokeAdmittedAccountInputSchema = z
  .object({ admittedAccountId: UuidSchema })
  .strict()
  .readonly();

export type RevokeAdmittedAccountInput = z.infer<
  typeof RevokeAdmittedAccountInputSchema
>;

export const ListAdmittedAccountsInputSchema = z
  .object({ includeRevoked: z.boolean() })
  .strict()
  .readonly();

export type ListAdmittedAccountsInput = z.infer<
  typeof ListAdmittedAccountsInputSchema
>;

/** Bounded: a district admits a handful of accounts, not a roster. */
export const AdmittedAccountListSchema = z
  .object({ items: z.array(AdmittedAccountSchema).max(500).readonly() })
  .strict()
  .readonly();

export type AdmittedAccountList = z.infer<typeof AdmittedAccountListSchema>;
