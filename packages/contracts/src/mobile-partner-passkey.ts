import { z } from 'zod';

import {
  MobilePartnerSignInFlowTokenSchema,
  NativeDevicePlatformSchema,
} from './identity';
import {
  PartnerPasskeyAssertionCredentialSchema,
  PartnerPasskeyCreationOptionsSchema,
  PartnerPasskeyRegistrationCredentialSchema,
  PartnerPasskeyRequestOptionsSchema,
} from './partner-passkey';
import { TimestampSchema } from './shared';

/**
 * The native app's half of partner passkey sign-in and enrollment.
 *
 * The ceremony itself is the one the browser already runs (`partner-passkey`):
 * the pool composes the options, the platform authenticator answers them, and
 * the deployment forwards the answer. What differs on a phone is only how the
 * two round trips of each ceremony are tied together. A browser carries that
 * state in sealed `__Host-` cookies; the app has no cookie jar it is willing
 * to depend on, so it is handed the same sealed values as opaque tokens and
 * returns them untouched.
 *
 * Every schema here is a new name on a new path. No shape an installed build
 * sends or parses is touched, which is what keeps this deployable before the
 * stores have the build that uses it (issue #470).
 *
 * Issue #647.
 */

/**
 * The sealed enrollment hand-off, the native counterpart of the browser's
 * `__Host-psd-eoc-partner-passkey` cookie.
 *
 * It carries the pool's own access token for the sign-in that just completed,
 * which is the only credential Cognito's registration calls accept. The app
 * never reads it and cannot produce one: the `e1` label is the native seal,
 * so a value sealed for the browser cannot be presented here and a value
 * sealed here cannot be presented as that cookie.
 */
export const MobilePartnerPasskeyEnrollmentTokenSchema = z
  .string()
  .min(32)
  .max(8 * 1_024)
  .regex(
    /^e1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    'Partner passkey enrollment must be a sealed native hand-off.',
  );

/** The opaque native enrollment hand-off inferred from its schema. */
export type MobilePartnerPasskeyEnrollmentToken = z.infer<
  typeof MobilePartnerPasskeyEnrollmentTokenSchema
>;

/**
 * The response header the native code sign-in offers enrollment on.
 *
 * The hand-off is a transient credential envelope, not application data, and
 * the browser carries exactly the same value in a header of its own
 * (`Set-Cookie`). Putting it in the sign-in body instead would mean either
 * adding a field to the session envelope every installed build parses
 * strictly, which is what broke every enrolled phone in #470, or serving the
 * same sign-in twice on two paths. A header is ignored by an installed build
 * by construction.
 */
export const MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER =
  'X-PSD-EOC-Partner-Passkey-Enrollment';

/**
 * Asks whether this address signs in with a passkey on this device, and for
 * the options to do it with.
 *
 * The answer is `passkey` or `code` and nothing else, exactly as on the web:
 * an address with no passkey, an address with no account at all, and a pool
 * that offered some other challenge are one answer, because any difference
 * would let this step be used to ask who holds partner access. The device
 * this sign-in would enroll is named here for the same reason the code path
 * names it — the second step reads it from the seal rather than the request.
 */
export const MobilePartnerPasskeySignInStartRequestSchema = z
  .object({
    step: z.literal('sign-in-start'),
    email: z.string().trim().toLowerCase().email().max(320),
    platform: NativeDevicePlatformSchema,
    installationId: z.string().trim().min(16).max(255),
  })
  .strict()
  .readonly();

/** The native passkey sign-in first step inferred from its schema. */
export type MobilePartnerPasskeySignInStartRequest = z.infer<
  typeof MobilePartnerPasskeySignInStartRequestSchema
>;

/**
 * What that first step answers: the ceremony options and the sealed flow to
 * return them with, or the instruction to use an emailed code instead.
 */
export const MobilePartnerPasskeySignInStartResponseSchema = z
  .discriminatedUnion('method', [
    z
      .object({
        method: z.literal('passkey'),
        flowToken: MobilePartnerSignInFlowTokenSchema,
        options: PartnerPasskeyRequestOptionsSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
    z.object({ method: z.literal('code') }).strict(),
  ])
  .readonly();

/** The native passkey sign-in first answer inferred from its schema. */
export type MobilePartnerPasskeySignInStartResponse = z.infer<
  typeof MobilePartnerPasskeySignInStartResponseSchema
>;

/**
 * Answers the pool's passkey challenge. The address comes from the sealed
 * flow, never from this request, so an assertion cannot be presented on
 * behalf of a different address.
 */
export const MobilePartnerPasskeySignInFinishRequestSchema = z
  .object({
    step: z.literal('sign-in-finish'),
    flowToken: MobilePartnerSignInFlowTokenSchema,
    credential: PartnerPasskeyAssertionCredentialSchema,
  })
  .strict()
  .readonly();

/** The native passkey sign-in second step inferred from its schema. */
export type MobilePartnerPasskeySignInFinishRequest = z.infer<
  typeof MobilePartnerPasskeySignInFinishRequestSchema
>;

/** Asks the pool to begin enrolling a passkey against one hand-off. */
export const MobilePartnerPasskeyRegisterStartRequestSchema = z
  .object({
    step: z.literal('register-start'),
    enrollmentToken: MobilePartnerPasskeyEnrollmentTokenSchema,
  })
  .strict()
  .readonly();

/** The native enrollment first step inferred from its schema. */
export type MobilePartnerPasskeyRegisterStartRequest = z.infer<
  typeof MobilePartnerPasskeyRegisterStartRequestSchema
>;

/** The options the app creates the passkey with. */
export const MobilePartnerPasskeyRegisterStartResponseSchema = z
  .object({ options: PartnerPasskeyCreationOptionsSchema })
  .strict()
  .readonly();

/** The native enrollment first answer inferred from its schema. */
export type MobilePartnerPasskeyRegisterStartResponse = z.infer<
  typeof MobilePartnerPasskeyRegisterStartResponseSchema
>;

/** Hands the pool a newly created passkey, which spends the hand-off. */
export const MobilePartnerPasskeyRegisterFinishRequestSchema = z
  .object({
    step: z.literal('register-finish'),
    enrollmentToken: MobilePartnerPasskeyEnrollmentTokenSchema,
    credential: PartnerPasskeyRegistrationCredentialSchema,
  })
  .strict()
  .readonly();

/** The native enrollment second step inferred from its schema. */
export type MobilePartnerPasskeyRegisterFinishRequest = z.infer<
  typeof MobilePartnerPasskeyRegisterFinishRequestSchema
>;

/** What a completed enrollment answers. */
export const MobilePartnerPasskeyRegisterFinishResponseSchema = z
  .object({ status: z.literal('registered') })
  .strict()
  .readonly();

/** The completed enrollment's answer inferred from its schema. */
export type MobilePartnerPasskeyRegisterFinishResponse = z.infer<
  typeof MobilePartnerPasskeyRegisterFinishResponseSchema
>;

/** Every request the native partner passkey endpoint accepts. */
export const MobilePartnerPasskeyRequestSchema = z
  .discriminatedUnion('step', [
    MobilePartnerPasskeySignInStartRequestSchema,
    MobilePartnerPasskeySignInFinishRequestSchema,
    MobilePartnerPasskeyRegisterStartRequestSchema,
    MobilePartnerPasskeyRegisterFinishRequestSchema,
  ])
  .readonly();

/** A native partner passkey request inferred from its schema. */
export type MobilePartnerPasskeyRequest = z.infer<
  typeof MobilePartnerPasskeyRequestSchema
>;
