import { z } from 'zod';

/**
 * The WebAuthn ceremony payloads that cross the partner passkey boundary.
 *
 * A passkey is the only part of partner sign-in where browser code takes
 * part: `navigator.credentials` runs in the page, and nothing else can sign
 * the pool's challenge. Everything the page sends and receives therefore
 * passes through this module first, so the server never hands an unchecked
 * provider document to a browser and never forwards an unchecked browser
 * document to the pool.
 *
 * These schemas are deliberately shallow. The authenticator's response is
 * opaque bytes that only the pool can verify, so validating it here would be
 * theatre; what is worth checking is the shape, the size, and the fields the
 * server itself reads — the credential id, the relying party, and the
 * challenge the ceremony is bound to. The pool remains the only thing that
 * verifies a signature.
 *
 * Issue #599.
 */

/** A base64url field, as every WebAuthn transport encoding uses. */
const Base64UrlSchema = z
  .string()
  .min(1)
  .max(8 * 1_024)
  .regex(/^[A-Za-z0-9_-]+$/u, 'Must be unpadded base64url.');

/**
 * A relying-party id: the application's own registrable hostname.
 *
 * A passkey is bound to this value, so it is derived from the deployment's
 * application origin rather than configured beside it (see
 * `partnerRelyingPartyId` on the server). An IP address or a value with a
 * port, scheme, or path is refused: those cannot be a relying-party id, and
 * accepting one would produce passkeys no browser would ever offer back.
 */
export const PasskeyRelyingPartyIdSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u,
    'Must be a lower-case hostname with no scheme, port, or path.',
  );

/**
 * The creation options the page hands `navigator.credentials.create`.
 *
 * The pool composes these, and the server re-states them through this schema
 * so a page can never be asked to enroll a passkey for another relying party
 * than this deployment. User verification is `required` because the pool
 * requires it: a passkey on a device whose biometric or PIN was not satisfied
 * must not be a credential.
 */
export const PartnerPasskeyCreationOptionsSchema = z
  .object({
    rp: z
      .object({
        id: PasskeyRelyingPartyIdSchema,
        name: z.string().min(1).max(160),
      })
      .strict(),
    user: z
      .object({
        id: Base64UrlSchema,
        name: z.string().min(1).max(320),
        displayName: z.string().min(1).max(320),
      })
      .strict(),
    challenge: Base64UrlSchema,
    pubKeyCredParams: z
      .array(
        z
          .object({
            type: z.literal('public-key'),
            alg: z.number().int(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    timeout: z.number().int().positive().max(600_000).optional(),
    excludeCredentials: z
      .array(
        z
          .object({
            type: z.literal('public-key'),
            id: Base64UrlSchema,
            transports: z.array(z.string().min(1).max(32)).max(8).optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.string().min(1).max(32).optional(),
        requireResidentKey: z.boolean().optional(),
        residentKey: z.string().min(1).max(32).optional(),
        userVerification: z.literal('required'),
      })
      .strict()
      .optional(),
    attestation: z.string().min(1).max(32).optional(),
  })
  .strict()
  .readonly();

/** Passkey creation options inferred from their schema. */
export type PartnerPasskeyCreationOptions = z.infer<
  typeof PartnerPasskeyCreationOptionsSchema
>;

/**
 * The request options the page hands `navigator.credentials.get`.
 *
 * `allowCredentials` is absent on a discoverable-credential sign-in and
 * present when the pool names the credentials it holds; either is accepted,
 * and the relying party is checked exactly as it is for creation.
 */
export const PartnerPasskeyRequestOptionsSchema = z
  .object({
    rpId: PasskeyRelyingPartyIdSchema,
    challenge: Base64UrlSchema,
    timeout: z.number().int().positive().max(600_000).optional(),
    userVerification: z.literal('required'),
    allowCredentials: z
      .array(
        z
          .object({
            type: z.literal('public-key'),
            id: Base64UrlSchema,
            transports: z.array(z.string().min(1).max(32)).max(8).optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict()
  .readonly();

/** Passkey request options inferred from their schema. */
export type PartnerPasskeyRequestOptions = z.infer<
  typeof PartnerPasskeyRequestOptionsSchema
>;

/**
 * What the authenticator returns from a registration ceremony, as the page
 * serializes it. `clientDataJSON` carries the origin and the challenge the
 * authenticator actually signed over, which is the one part of this document
 * the server reads for itself before passing it on.
 */
export const PartnerPasskeyRegistrationCredentialSchema = z
  .object({
    id: Base64UrlSchema,
    rawId: Base64UrlSchema,
    type: z.literal('public-key'),
    authenticatorAttachment: z.string().min(1).max(32).nullable().optional(),
    response: z
      .object({
        clientDataJSON: Base64UrlSchema,
        attestationObject: Base64UrlSchema,
        transports: z.array(z.string().min(1).max(32)).max(8).optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .readonly();

/** A registration credential inferred from its schema. */
export type PartnerPasskeyRegistrationCredential = z.infer<
  typeof PartnerPasskeyRegistrationCredentialSchema
>;

/** What the authenticator returns from a sign-in ceremony. */
export const PartnerPasskeyAssertionCredentialSchema = z
  .object({
    id: Base64UrlSchema,
    rawId: Base64UrlSchema,
    type: z.literal('public-key'),
    authenticatorAttachment: z.string().min(1).max(32).nullable().optional(),
    response: z
      .object({
        clientDataJSON: Base64UrlSchema,
        authenticatorData: Base64UrlSchema,
        signature: Base64UrlSchema,
        userHandle: Base64UrlSchema.nullable().optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .readonly();

/** An assertion credential inferred from its schema. */
export type PartnerPasskeyAssertionCredential = z.infer<
  typeof PartnerPasskeyAssertionCredentialSchema
>;

/**
 * The `clientDataJSON` the authenticator signed over, once decoded.
 *
 * The server reads this to check that the ceremony was bound to this
 * deployment's own origin and to the challenge it issued. The pool checks it
 * too; checking it here as well means a misdirected ceremony is refused
 * before the pool is asked, and the browser flows can prove that binding
 * without a real authenticator's signature.
 */
export const PartnerPasskeyClientDataSchema = z
  .object({
    type: z.enum(['webauthn.create', 'webauthn.get']),
    challenge: Base64UrlSchema,
    origin: z.string().min(1).max(2_048),
    crossOrigin: z.boolean().optional(),
    topOrigin: z.string().min(1).max(2_048).optional(),
  })
  // Browsers are permitted to add fields to client data, and an unknown one
  // must not refuse a valid sign-in, so this is the one shape here that is
  // not strict.
  .readonly();

/** Decoded WebAuthn client data inferred from its schema. */
export type PartnerPasskeyClientData = z.infer<
  typeof PartnerPasskeyClientDataSchema
>;

/** The step a partner passkey request is asking the server to take. */
export const PARTNER_PASSKEY_STEPS = Object.freeze([
  'register-start',
  'register-finish',
  'sign-in-start',
  'sign-in-finish',
] as const);

export type PartnerPasskeyStep = (typeof PARTNER_PASSKEY_STEPS)[number];

/** Asks the pool to begin enrolling a passkey for the signed-in partner. */
export const PartnerPasskeyRegisterStartRequestSchema = z
  .object({ step: z.literal('register-start') })
  .strict()
  .readonly();

/** Hands the pool a newly created passkey. */
export const PartnerPasskeyRegisterFinishRequestSchema = z
  .object({
    step: z.literal('register-finish'),
    credential: PartnerPasskeyRegistrationCredentialSchema,
  })
  .strict()
  .readonly();

/**
 * Asks whether this address may sign in with a passkey, and for the options
 * to do it with. The address is the only input: the answer never says whether
 * the address is enrolled, only which ceremony the page should run, and an
 * address with no account is answered exactly as one with no passkey.
 */
export const PartnerPasskeySignInStartRequestSchema = z
  .object({
    step: z.literal('sign-in-start'),
    email: z.string().min(3).max(320),
  })
  .strict()
  .readonly();

/** Answers the pool's passkey challenge. */
export const PartnerPasskeySignInFinishRequestSchema = z
  .object({
    step: z.literal('sign-in-finish'),
    credential: PartnerPasskeyAssertionCredentialSchema,
  })
  .strict()
  .readonly();

/** Every request the partner passkey endpoint accepts. */
export const PartnerPasskeyRequestSchema = z
  .discriminatedUnion('step', [
    PartnerPasskeyRegisterStartRequestSchema,
    PartnerPasskeyRegisterFinishRequestSchema,
    PartnerPasskeySignInStartRequestSchema,
    PartnerPasskeySignInFinishRequestSchema,
  ])
  .readonly();

/** A partner passkey request inferred from its schema. */
export type PartnerPasskeyRequest = z.infer<typeof PartnerPasskeyRequestSchema>;

/**
 * What the sign-in first step answers.
 *
 * `passkey` carries the options to run the ceremony with. `code` means the
 * page should ask for an emailed code instead, and it is the answer for an
 * address with no passkey, an address with no account at all, and a pool that
 * offered no passkey challenge. The three are deliberately one answer: any
 * difference between them would let the form be used to ask who is enrolled.
 */
export const PartnerPasskeySignInStartResponseSchema = z
  .discriminatedUnion('method', [
    z
      .object({
        method: z.literal('passkey'),
        options: PartnerPasskeyRequestOptionsSchema,
      })
      .strict(),
    z.object({ method: z.literal('code') }).strict(),
  ])
  .readonly();

/** The sign-in first step's answer inferred from its schema. */
export type PartnerPasskeySignInStartResponse = z.infer<
  typeof PartnerPasskeySignInStartResponseSchema
>;

/** What the registration first step answers. */
export const PartnerPasskeyRegisterStartResponseSchema = z
  .object({ options: PartnerPasskeyCreationOptionsSchema })
  .strict()
  .readonly();

/** The registration first step's answer inferred from its schema. */
export type PartnerPasskeyRegisterStartResponse = z.infer<
  typeof PartnerPasskeyRegisterStartResponseSchema
>;
