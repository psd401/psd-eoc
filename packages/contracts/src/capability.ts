import { z } from 'zod';

import { FacilityScopeSchema } from './facility';
import { HumanOnlyActionIdSchema, isHumanOnlyActionId } from './human-only';
import { isAtOrAfter, TimestampSchema, UuidSchema } from './shared';

/**
 * Owns a capability's stable, kebab-case identifier across web, mobile, REST,
 * MCP, worker, and scheduled surfaces. Human-only action IDs occupy a
 * protected subset of this namespace but a capability may require multiple
 * protected actions.
 */
export const CapabilityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Stable capability identifier inferred from its schema. */
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/**
 * Owns the persisted caller categories used for authorization and audit.
 * These values are canonical for database enums and capability execution.
 */
export const ActorKindSchema = z.enum(['human', 'agent', 'system']);

/** Persisted caller category inferred from its schema. */
export type ActorKind = z.infer<typeof ActorKindSchema>;

/**
 * Owns the caller identity resolved by trusted authentication code. Human,
 * agent, and system identities are deliberately disjoint for deny-by-default
 * authorization and audit.
 */
export const ActorSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('human'),
        userId: UuidSchema,
        sessionId: UuidSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('agent'),
        agentId: UuidSchema,
        apiKeyId: UuidSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('system'),
        serviceId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      })
      .strict(),
  ])
  .readonly();

/** Server-resolved human, agent, or system actor inferred from its schema. */
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Owns normalized pre-session OIDC principal evidence after cryptographic
 * claim validation. The transient staff claims are cross-bound to canonical
 * capability input; no callback token, authorization code, or PKCE secret is
 * represented. Digests support minimized audit correlation.
 */
export const PreSessionOidcPrincipalSchema = z
  .object({
    kind: z.literal('verified-oidc-claims'),
    issuer: z.literal('https://accounts.google.com'),
    audience: z.string().trim().min(1).max(255),
    subject: z.string().trim().min(1).max(255),
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    claimsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    audienceVerified: z.literal(true),
    // Informational only. Exact persisted Google Group evidence owns access.
    hostedDomain: z.string().trim().min(1).max(255).nullable(),
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .refine((email) => email === email.toLowerCase(), {
        message: 'OIDC email must be normalized to lowercase.',
      }),
    emailVerified: z.literal(true),
    displayName: z.string().trim().min(1).max(160),
  })
  .strict()
  .readonly();

/** Minimized verified pre-session OIDC principal inferred from its schema. */
export type PreSessionOidcPrincipal = z.infer<
  typeof PreSessionOidcPrincipalSchema
>;

/**
 * Owns safe audit evidence for a provider-denied OIDC callback. Denials never
 * enter the session-establishment capability and therefore cannot require a
 * fabricated authorization code, device, actor, session, or facility scope.
 */
export const OidcCallbackRejectionEvidenceSchema = z
  .object({
    checkId: UuidSchema,
    issuer: z.literal('https://accounts.google.com'),
    errorCode: z.enum(['access-denied', 'login-required']),
    responseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    stateVerified: z.literal(true),
    checkedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Safe non-executable OIDC denial evidence inferred from schema. */
export type OidcCallbackRejectionEvidence = z.infer<
  typeof OidcCallbackRejectionEvidenceSchema
>;

/**
 * Owns the trusted invocation-surface vocabulary recorded with every
 * capability execution and journal entry. GET/link preview is intentionally
 * absent as a mutation-capable source.
 */
export const InvocationSourceSchema = z.enum([
  'web',
  'mobile',
  'agent-rest',
  'mcp',
  'worker',
  'scheduled-job',
  'webhook',
]);

/** Trusted capability invocation source inferred from its schema. */
export type InvocationSource = z.infer<typeof InvocationSourceSchema>;

/**
 * Owns trusted mutation-transport evidence derived by the server adapter, not
 * accepted from an external request body. Browser mutations require an
 * explicit user submission over CSRF-verified POST, so cross-site requests,
 * GET requests, prefetches, link previews, and passive page loads cannot reach
 * a mutation capability.
 */
export const MutationTransportSchema = z
  .union([
    z
      .object({
        kind: z.literal('web-interactive'),
        method: z.literal('POST'),
        interaction: z.literal('explicit-user-submit'),
        csrfVerified: z.literal(true),
      })
      .strict(),
    z
      .object({
        kind: z.literal('mobile-interactive'),
        interaction: z.literal('explicit-user-submit'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('agent-rest-command'),
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      })
      .strict(),
    z.object({ kind: z.literal('mcp-tool-call') }).strict(),
    z.object({ kind: z.literal('worker-execution') }).strict(),
    z.object({ kind: z.literal('scheduled-execution') }).strict(),
    z.object({ kind: z.literal('webhook-delivery') }).strict(),
  ])
  .readonly();

/** Trusted server-derived mutation transport inferred from its schema. */
export type MutationTransport = z.infer<typeof MutationTransportSchema>;

/**
 * Owns trusted Google OIDC callback transport evidence. This narrow verified
 * GET path can complete sign-in only; it cannot parse as an ordinary mutation
 * transport or invoke any event/notification capability.
 */
export const OidcCallbackTransportSchema = z
  .object({
    kind: z.literal('oidc-code-callback'),
    method: z.literal('GET'),
    stateVerified: z.literal(true),
    nonceVerified: z.literal(true),
    pkceVerified: z.literal(true),
    signatureVerified: z.literal(true),
  })
  .strict()
  .readonly();

/** Trusted OIDC callback transport inferred from its schema. */
export type OidcCallbackTransport = z.infer<typeof OidcCallbackTransportSchema>;

/**
 * Trusted evidence for a native authorization-code exchange. Raw codes,
 * verifiers, flow tokens, and provider tokens are removed by the adapter before
 * this transport can reach the capability layer.
 */
export const MobileOidcCodeExchangeTransportSchema = z
  .object({
    kind: z.literal('mobile-oidc-code-exchange'),
    method: z.literal('POST'),
    stateVerified: z.literal(true),
    nonceVerified: z.literal(true),
    pkceVerified: z.literal(true),
    signatureVerified: z.literal(true),
  })
  .strict()
  .readonly();

/** Trusted native OIDC exchange transport inferred from its schema. */
export type MobileOidcCodeExchangeTransport = z.infer<
  typeof MobileOidcCodeExchangeTransportSchema
>;

/** Complete set of trusted transports that may establish an OIDC session. */
export const OidcCompletionTransportSchema = z
  .union([OidcCallbackTransportSchema, MobileOidcCodeExchangeTransportSchema])
  .readonly();

/** Trusted OIDC completion transport inferred from its schema. */
export type OidcCompletionTransport = z.infer<
  typeof OidcCompletionTransportSchema
>;

/**
 * Owns provenance for the persisted record that issued the currently valid
 * refresh credential. A current credential is either the initial issuance or
 * the successor of one append-only rotation record.
 */
export const RefreshCredentialRecordRefSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('initial-issuance'),
        issuanceId: UuidSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('rotation-successor'),
        rotationId: UuidSchema,
      })
      .strict(),
  ])
  .readonly();

/** Current refresh-credential record reference inferred from schema. */
export type RefreshCredentialRecordRef = z.infer<
  typeof RefreshCredentialRecordRefSchema
>;

/**
 * Owns minimized refresh evidence created only after a same-transaction row
 * lock or compare-and-swap proves that the presented digest is the current
 * successor and that the session and device are active. Raw credentials are
 * never represented in contracts, persistence, or audit records.
 */
export const VerifiedCurrentRefreshCredentialSchema = z
  .object({
    kind: z.literal('verified-current-refresh-credential'),
    verificationId: UuidSchema,
    userId: UuidSchema,
    sessionId: UuidSchema,
    deviceEnrollmentId: UuidSchema,
    recordRef: RefreshCredentialRecordRefSchema,
    presentedTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    credentialGeneration: z.number().int().positive(),
    credentialState: z.literal('current'),
    sessionState: z.literal('active'),
    deviceState: z.literal('active'),
    sessionExpiresAt: TimestampSchema,
    verifiedAt: TimestampSchema,
  })
  .strict()
  .superRefine((credential, context) => {
    if (
      Date.parse(credential.sessionExpiresAt) <=
      Date.parse(credential.verifiedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A refresh credential can verify only a session that remains active.',
        path: ['sessionExpiresAt'],
      });
    }
  })
  .readonly();

/** Verified current refresh credential inferred from schema. */
export type VerifiedCurrentRefreshCredential = z.infer<
  typeof VerifiedCurrentRefreshCredentialSchema
>;

const RefreshRejectionCommonShape = {
  checkId: UuidSchema,
  presentedTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  checkedAt: TimestampSchema,
};

/**
 * Owns safe, append-only evidence for a rejected refresh credential. Rejected
 * credentials never enter an executable capability envelope; bounded IDs and
 * digests let security audit record the denial without raw token material.
 */
export const RefreshCredentialRejectionEvidenceSchema = z
  .discriminatedUnion('reason', [
    z
      .object({
        ...RefreshRejectionCommonShape,
        reason: z.literal('unknown-credential'),
      })
      .strict(),
    z
      .object({
        ...RefreshRejectionCommonShape,
        reason: z.literal('token-replay'),
        sessionId: UuidSchema,
        rotationId: UuidSchema,
      })
      .strict(),
    z
      .object({
        ...RefreshRejectionCommonShape,
        reason: z.literal('session-revoked'),
        sessionId: UuidSchema,
        revocationId: UuidSchema,
      })
      .strict(),
    z
      .object({
        ...RefreshRejectionCommonShape,
        reason: z.literal('session-expired'),
        sessionId: UuidSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        ...RefreshRejectionCommonShape,
        reason: z.literal('device-revoked'),
        sessionId: UuidSchema,
        deviceEnrollmentId: UuidSchema,
        revokedAt: TimestampSchema,
      })
      .strict(),
  ])
  .superRefine((evidence, context) => {
    if (
      evidence.reason === 'session-expired' &&
      !isAtOrAfter(evidence.checkedAt, evidence.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session expiry must exist before it can deny refresh.',
        path: ['expiresAt'],
      });
    }
    if (
      evidence.reason === 'device-revoked' &&
      !isAtOrAfter(evidence.checkedAt, evidence.revokedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Device revocation must exist before it can deny refresh.',
        path: ['revokedAt'],
      });
    }
  })
  .readonly();

/** Safe rejected-refresh evidence inferred from schema. */
export type RefreshCredentialRejectionEvidence = z.infer<
  typeof RefreshCredentialRejectionEvidenceSchema
>;

/**
 * Owns trusted transport evidence for presentation of a refresh credential.
 * Browser refreshes require a secure HTTP-only cookie and CSRF-verified POST;
 * mobile refreshes require an explicit POST from protected device storage.
 */
export const SessionRefreshTransportSchema = z
  .union([
    z
      .object({
        kind: z.literal('web-refresh-cookie'),
        method: z.literal('POST'),
        csrfVerified: z.literal(true),
        secure: z.literal(true),
        httpOnly: z.literal(true),
        sameSite: z.enum(['strict', 'lax']),
      })
      .strict(),
    z
      .object({
        kind: z.literal('mobile-refresh-bearer'),
        method: z.literal('POST'),
      })
      .strict(),
  ])
  .readonly();

/** Trusted pre-session refresh transport inferred from schema. */
export type SessionRefreshTransport = z.infer<
  typeof SessionRefreshTransportSchema
>;

const mutationTransportKindBySource = {
  web: 'web-interactive',
  mobile: 'mobile-interactive',
  'agent-rest': 'agent-rest-command',
  mcp: 'mcp-tool-call',
  worker: 'worker-execution',
  'scheduled-job': 'scheduled-execution',
  webhook: 'webhook-delivery',
} as const satisfies Record<InvocationSource, MutationTransport['kind']>;

const sourcesByActor = {
  human: ['web', 'mobile'],
  agent: ['agent-rest', 'mcp'],
  system: ['worker', 'scheduled-job', 'webhook'],
} as const satisfies Record<ActorKind, readonly InvocationSource[]>;

/** Returns true when a trusted actor category can originate from a surface. */
export function isActorSourceCompatible(
  actor: Actor,
  source: InvocationSource,
): boolean {
  return (sourcesByActor[actor.kind] as readonly string[]).includes(source);
}

/**
 * Owns a truthful actor-and-source provenance pair shared by capability and
 * append-only journal records. Impossible combinations fail at the contract
 * boundary rather than entering history.
 */
export const ActorInvocationSchema = z
  .object({
    actor: ActorSchema,
    source: InvocationSourceSchema,
  })
  .strict()
  .superRefine((invocation, context) => {
    if (!isActorSourceCompatible(invocation.actor, invocation.source)) {
      context.addIssue({
        code: 'custom',
        message: `${invocation.actor.kind} actors cannot invoke from ${invocation.source}.`,
        path: ['source'],
      });
    }
  })
  .readonly();

/** Truthful actor-and-source provenance inferred from its schema. */
export type ActorInvocation = z.infer<typeof ActorInvocationSchema>;

/**
 * Owns the opaque replay-protection key required on every mutation. Keys are
 * scoped and persisted by the capability engine; replays return the original
 * result rather than executing again.
 */
export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/u);

/** Opaque mutation replay-protection key inferred from its schema. */
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/**
 * Owns the persisted lifecycle of one idempotent capability execution. A
 * completed or failed record retains its request digest and result reference
 * so replay never performs a second mutation.
 */
export const IdempotencyStatusSchema = z.enum([
  'in-progress',
  'completed',
  'failed',
]);

/** Persisted idempotency lifecycle state inferred from its schema. */
export type IdempotencyStatus = z.infer<typeof IdempotencyStatusSchema>;

/**
 * Owns the minimized principal bound to an idempotency record. Authenticated
 * calls retain their actor; pre-session OIDC and refresh calls retain only
 * digests and bounded identifiers, never callback codes or raw credentials.
 */
export const IdempotencyPrincipalSchema = z
  .union([
    ActorSchema,
    z
      .object({
        kind: z.literal('oidc-callback'),
        subjectDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        responseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        kind: z.literal('refresh-credential'),
        sessionId: UuidSchema.nullable(),
        deviceEnrollmentId: UuidSchema.nullable(),
        presentedTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  ])
  .readonly();

/** Authenticated or pre-session idempotency principal inferred from schema. */
export type IdempotencyPrincipal = z.infer<typeof IdempotencyPrincipalSchema>;

/**
 * Owns one persisted idempotency record. Request payloads are represented by
 * a digest, not copied into the record, and result references remain bounded.
 * Refresh retries bind the credential, device, and transport through the
 * principal and request digest; successor secrets never appear here.
 */
export const IdempotencyRecordSchema = z
  .object({
    id: UuidSchema,
    key: IdempotencyKeySchema,
    capabilityId: CapabilityIdSchema,
    principal: IdempotencyPrincipalSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    status: IdempotencyStatusSchema,
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    resultReference: z.string().trim().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (!isRegisteredMutationCapabilityId(record.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message:
          'Idempotency records must name a registered mutation capability.',
        path: ['capabilityId'],
      });
    }
    const isComplete = record.status !== 'in-progress';
    if (isComplete !== (record.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only terminal idempotency records have a completion time.',
        path: ['completedAt'],
      });
    }
    if (
      record.completedAt &&
      !isAtOrAfter(record.completedAt, record.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Idempotency completion cannot precede creation.',
        path: ['completedAt'],
      });
    }
    if (isComplete !== (record.resultReference !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Terminal idempotency records retain a result reference; in-progress records do not.',
        path: ['resultReference'],
      });
    }
  })
  .readonly();

/** Persisted idempotency record inferred from its schema. */
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

/**
 * Owns the server-resolved facility authorization boundary carried into
 * capability execution. It is never accepted directly from an untrusted
 * request body.
 */
export const CapabilityScopeSchema = z
  .object({
    facilityScope: FacilityScopeSchema,
  })
  .strict()
  .readonly();

/** Server-resolved capability scope inferred from its schema. */
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

const HumanOnlyActionIdSetSchema = z
  .array(HumanOnlyActionIdSchema)
  .min(1)
  .max(4)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Human-only action IDs must be unique.',
  })
  .readonly();

/** Maximum lifetime, in seconds, of a server-issued human confirmation. */
export const HUMAN_CONFIRMATION_MAX_AGE_SECONDS = 5 * 60;

/** Stable identifier for one online session connectivity epoch. */
export const ConnectivityEpochIdSchema = UuidSchema;

/** Online session connectivity-epoch identifier inferred from its schema. */
export type ConnectivityEpochId = z.infer<typeof ConnectivityEpochIdSchema>;

/** Stable identifier for a single-use human consequence confirmation. */
export const HumanConfirmationIdSchema = UuidSchema;

/** Human consequence-confirmation identifier inferred from its schema. */
export type HumanConfirmationId = z.infer<typeof HumanConfirmationIdSchema>;

/**
 * Owns a server-issued, short-lived consequence confirmation for one
 * capability and the complete protected-action set it will perform. The
 * digest binds exactly what the human reviewed; schema validation supplements
 * server-side lookup and single-use enforcement.
 */
export const HumanConfirmationSchema = z
  .object({
    id: HumanConfirmationIdSchema,
    capabilityId: CapabilityIdSchema,
    actionIds: HumanOnlyActionIdSetSchema,
    connectivityEpochId: ConnectivityEpochIdSchema,
    confirmedByUserId: UuidSchema,
    confirmedWithSessionId: UuidSchema,
    consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((confirmation, context) => {
    if (isHumanOnlyActionId(confirmation.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message:
          'Human-only action IDs are derived requirements, not callable capability IDs.',
        path: ['capabilityId'],
      });
    }
    if (!isAtOrAfter(confirmation.expiresAt, confirmation.issuedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Human confirmation expiry cannot precede issuance.',
        path: ['expiresAt'],
      });
    }
    if (
      Date.parse(confirmation.expiresAt) - Date.parse(confirmation.issuedAt) >
      HUMAN_CONFIRMATION_MAX_AGE_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Human confirmation lifetime exceeds the safe maximum.',
        path: ['expiresAt'],
      });
    }
  })
  .readonly();

/** Server-issued consequence confirmation inferred from its schema. */
export type HumanConfirmation = z.infer<typeof HumanConfirmationSchema>;

/**
 * Owns the persisted single-use lifecycle for a human confirmation. Consumed
 * and expired confirmations remain retained as evidence and can never be
 * silently reset to issued.
 */
export const HumanConfirmationStatusSchema = z.enum([
  'issued',
  'consumed',
  'expired',
]);

/** Persisted human-confirmation state inferred from its schema. */
export type HumanConfirmationStatus = z.infer<
  typeof HumanConfirmationStatusSchema
>;

/**
 * Owns one persisted human-confirmation record. Consumption binds the exact
 * request ID once; expiry and consumption are terminal append-only facts.
 */
export const HumanConfirmationRecordSchema = z
  .object({
    confirmation: HumanConfirmationSchema,
    status: HumanConfirmationStatusSchema,
    consumedAt: TimestampSchema.nullable(),
    consumedForRequestId: UuidSchema.nullable(),
    expiredAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const isConsumed = record.status === 'consumed';
    if (
      isConsumed !==
      (record.consumedAt !== null && record.consumedForRequestId !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Consumed confirmations require complete request provenance.',
        path: ['consumedAt'],
      });
    }
    if (
      !isConsumed &&
      (record.consumedAt !== null || record.consumedForRequestId !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unconsumed confirmations cannot carry consumption data.',
        path: ['consumedAt'],
      });
    }
    if (isConsumed && record.expiredAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A consumed confirmation cannot also be expired.',
        path: ['expiredAt'],
      });
    }
    if (
      record.consumedAt &&
      (!isAtOrAfter(record.consumedAt, record.confirmation.issuedAt) ||
        !isAtOrAfter(record.confirmation.expiresAt, record.consumedAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmation consumption must occur inside its lifetime.',
        path: ['consumedAt'],
      });
    }
    const isExpired = record.status === 'expired';
    if (isExpired !== (record.expiredAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Expired confirmations require exactly one expiry fact.',
        path: ['expiredAt'],
      });
    }
    if (
      record.expiredAt &&
      !isAtOrAfter(record.expiredAt, record.confirmation.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expiry cannot be recorded before confirmation expiry.',
        path: ['expiredAt'],
      });
    }
  })
  .readonly();

/** Persisted single-use confirmation record inferred from its schema. */
export type HumanConfirmationRecord = z.infer<
  typeof HumanConfirmationRecordSchema
>;

const envelopeCommonShape = {
  capabilityId: CapabilityIdSchema,
  actor: ActorSchema,
  source: InvocationSourceSchema,
  scope: CapabilityScopeSchema,
  requestId: UuidSchema,
  serverTime: TimestampSchema,
  input: z.unknown(),
};

function addActorSourceIssues(
  envelope: { readonly actor: Actor; readonly source: InvocationSource },
  context: z.RefinementCtx,
): void {
  if (!isActorSourceCompatible(envelope.actor, envelope.source)) {
    context.addIssue({
      code: 'custom',
      message: `${envelope.actor.kind} actors cannot invoke from ${envelope.source}.`,
      path: ['source'],
    });
  }
}

/**
 * Owns the execution envelope for read-only capabilities. Queries omit
 * idempotency and protected-action sets and can never register a human-only
 * action ID.
 */
export const QueryCapabilityEnvelopeSchema = z
  .object({
    ...envelopeCommonShape,
    operation: z.literal('query'),
  })
  .strict()
  .superRefine((envelope, context) => {
    addActorSourceIssues(envelope, context);
    if (isRegisteredMutationCapabilityId(envelope.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message:
          'Registered mutation capability IDs cannot execute as queries.',
        path: ['capabilityId'],
      });
    }
    if (!isRegisteredQueryCapabilityId(envelope.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message: 'Query capability ID is not in the closed query manifest.',
        path: ['capabilityId'],
      });
    }
    if (isHumanOnlyActionId(envelope.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message:
          'Human-only action IDs are derived requirements, not callable capability IDs.',
        path: ['capabilityId'],
      });
    }
  })
  .readonly();

/** Read-only capability execution envelope inferred from its schema. */
export type QueryCapabilityEnvelope = z.infer<
  typeof QueryCapabilityEnvelopeSchema
>;

/**
 * Owns the execution envelope for every mutation. The capability engine—not
 * the request body—derives `requiredHumanActionIds` after parsing input and
 * resolving current state. Any non-empty set requires a matching confirmation
 * from the invoking human, closing capability-alias and multi-action bypasses.
 */
export const MutationCapabilityEnvelopeSchema = z
  .object({
    ...envelopeCommonShape,
    operation: z.literal('mutation'),
    idempotencyKey: IdempotencyKeySchema,
    transport: MutationTransportSchema,
    connectivityEpochId: ConnectivityEpochIdSchema.nullable(),
    requiredHumanActionIds: z
      .array(HumanOnlyActionIdSchema)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Required human-only action IDs must be unique.',
      })
      .readonly(),
    requiredConsequenceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    humanConfirmation: HumanConfirmationSchema.nullable(),
  })
  .strict()
  .superRefine((envelope, context) => {
    addActorSourceIssues(envelope, context);
    if (!isRegisteredMutationCapabilityId(envelope.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message: 'Mutation capability ID is not in the closed safety manifest.',
        path: ['capabilityId'],
      });
    }
    if (envelope.capabilityId === 'complete-oidc-sign-in') {
      context.addIssue({
        code: 'custom',
        message:
          'OIDC completion requires the narrow pre-session callback envelope.',
        path: ['capabilityId'],
      });
    }
    if (envelope.capabilityId === 'refresh-session') {
      context.addIssue({
        code: 'custom',
        message:
          'Session refresh requires the narrow verified-credential envelope.',
        path: ['capabilityId'],
      });
    }
    if (isHumanOnlyActionId(envelope.capabilityId)) {
      context.addIssue({
        code: 'custom',
        message:
          'Human-only action IDs are derived requirements, not callable capability IDs.',
        path: ['capabilityId'],
      });
    }
    if (
      mutationTransportKindBySource[envelope.source] !== envelope.transport.kind
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Mutation transport must match the trusted invocation source.',
        path: ['transport'],
      });
    }
    if (
      (envelope.actor.kind === 'human') !==
      (envelope.connectivityEpochId !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Only human session mutations carry an online connectivity epoch.',
        path: ['connectivityEpochId'],
      });
    }
    if (
      envelope.requiredHumanActionIds.length > 0 !==
      (envelope.requiredConsequenceDigest !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Protected actions require exactly one server-derived consequence digest.',
        path: ['requiredConsequenceDigest'],
      });
    }

    if (envelope.requiredHumanActionIds.length > 0) {
      if (envelope.actor.kind !== 'human') {
        context.addIssue({
          code: 'custom',
          message: 'Protected actions reject every non-human actor.',
          path: ['actor'],
        });
      }
      if (envelope.humanConfirmation === null) {
        context.addIssue({
          code: 'custom',
          message: 'Protected actions require consequence confirmation.',
          path: ['humanConfirmation'],
        });
      } else {
        const expected = [...envelope.requiredHumanActionIds].sort();
        const confirmed = [...envelope.humanConfirmation.actionIds].sort();
        if (
          expected.length !== confirmed.length ||
          expected.some((id, index) => id !== confirmed[index])
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Confirmation must bind every required protected action.',
            path: ['humanConfirmation', 'actionIds'],
          });
        }
        if (envelope.humanConfirmation.capabilityId !== envelope.capabilityId) {
          context.addIssue({
            code: 'custom',
            message: 'Confirmation must bind the executing capability ID.',
            path: ['humanConfirmation', 'capabilityId'],
          });
        }
        if (
          envelope.humanConfirmation.consequenceDigest !==
          envelope.requiredConsequenceDigest
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Confirmation digest must match the resolved consequence.',
            path: ['humanConfirmation', 'consequenceDigest'],
          });
        }
        if (
          envelope.humanConfirmation.connectivityEpochId !==
          envelope.connectivityEpochId
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Confirmation must belong to the current online connectivity epoch.',
            path: ['humanConfirmation', 'connectivityEpochId'],
          });
        }
        if (
          !isAtOrAfter(
            envelope.serverTime,
            envelope.humanConfirmation.issuedAt,
          ) ||
          !isAtOrAfter(
            envelope.humanConfirmation.expiresAt,
            envelope.serverTime,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Confirmation must be current at capability execution.',
            path: ['humanConfirmation', 'expiresAt'],
          });
        }
        if (
          envelope.actor.kind === 'human' &&
          (envelope.humanConfirmation.confirmedByUserId !==
            envelope.actor.userId ||
            envelope.humanConfirmation.confirmedWithSessionId !==
              envelope.actor.sessionId)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Confirmation must belong to the invoking human session.',
            path: ['humanConfirmation'],
          });
        }
      }
    } else if (envelope.humanConfirmation !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Unprotected mutations cannot consume human confirmation.',
        path: ['humanConfirmation'],
      });
    }

    if (
      typeof envelope.input === 'object' &&
      envelope.input !== null &&
      'idempotencyKey' in envelope.input &&
      envelope.input.idempotencyKey !== envelope.idempotencyKey
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Nested idempotency metadata must match the envelope key.',
        path: ['input', 'idempotencyKey'],
      });
    }
  })
  .readonly();

/** Mutating capability execution envelope inferred from its schema. */
export type MutationCapabilityEnvelope = z.infer<
  typeof MutationCapabilityEnvelopeSchema
>;

/**
 * Owns the only pre-session capability invocation. A state/nonce/PKCE and
 * signature-verified Google callback may complete OIDC sign-in without
 * inventing an authenticated actor, session, scope, or CSRF-protected POST.
 */
export const AuthenticationCapabilityEnvelopeSchema = z
  .object({
    capabilityId: z.literal('complete-oidc-sign-in'),
    operation: z.literal('mutation'),
    principal: PreSessionOidcPrincipalSchema,
    source: z.enum(['web', 'mobile']),
    requestId: UuidSchema,
    serverTime: TimestampSchema,
    input: z.unknown(),
    idempotencyKey: IdempotencyKeySchema,
    transport: OidcCompletionTransportSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const expectedTransport =
      envelope.source === 'web'
        ? 'oidc-code-callback'
        : 'mobile-oidc-code-exchange';
    if (envelope.transport.kind !== expectedTransport) {
      context.addIssue({
        code: 'custom',
        message: 'OIDC completion transport must match its invocation source.',
        path: ['transport'],
      });
    }
  })
  .readonly();

/** Narrow pre-session OIDC capability envelope inferred from its schema. */
export type AuthenticationCapabilityEnvelope = z.infer<
  typeof AuthenticationCapabilityEnvelopeSchema
>;

/**
 * Owns the only pre-session refresh invocation. Verification happens before
 * capability execution and supplies no fabricated human actor, facility
 * scope, current session, or connectivity epoch. The literal capability ID
 * prevents refresh credentials from reaching any other mutation.
 */
export const SessionRefreshCapabilityEnvelopeSchema = z
  .object({
    capabilityId: z.literal('refresh-session'),
    operation: z.literal('mutation'),
    principal: VerifiedCurrentRefreshCredentialSchema,
    source: z.enum(['web', 'mobile']),
    requestId: UuidSchema,
    serverTime: TimestampSchema,
    input: z.object({}).strict().readonly(),
    idempotencyKey: IdempotencyKeySchema,
    transport: SessionRefreshTransportSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const expectedTransport =
      envelope.source === 'web'
        ? 'web-refresh-cookie'
        : 'mobile-refresh-bearer';
    if (envelope.transport.kind !== expectedTransport) {
      context.addIssue({
        code: 'custom',
        message: 'Refresh transport must match the trusted invocation source.',
        path: ['transport'],
      });
    }
    if (envelope.serverTime !== envelope.principal.verifiedAt) {
      context.addIssue({
        code: 'custom',
        message:
          'Refresh verification and capability execution must share one transaction time.',
        path: ['principal', 'verifiedAt'],
      });
    }
  })
  .readonly();

/** Narrow pre-session refresh capability envelope inferred from schema. */
export type SessionRefreshCapabilityEnvelope = z.infer<
  typeof SessionRefreshCapabilityEnvelopeSchema
>;

/**
 * Owns the shared query-or-mutation envelope consumed by
 * `executeCapability`. Actor, scope, and required protected actions must be
 * constructed after authentication and state resolution, never trusted from
 * REST or MCP request bodies.
 */
export const CapabilityEnvelopeSchema = z
  .union([
    QueryCapabilityEnvelopeSchema,
    MutationCapabilityEnvelopeSchema,
    AuthenticationCapabilityEnvelopeSchema,
    SessionRefreshCapabilityEnvelopeSchema,
  ])
  .readonly();

/** Shared capability execution envelope inferred from its schema. */
export type CapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;

/**
 * Owns the complete server-derived human-only requirement for one execution.
 * Empty requirements have no digest; protected requirements bind a digest of
 * the exact preview and current state the human reviewed.
 */
export const HumanActionRequirementSchema = z
  .object({
    actionIds: z
      .array(HumanOnlyActionIdSchema)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Required human-only action IDs must be unique.',
      })
      .readonly(),
    consequenceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((requirement, context) => {
    if (
      requirement.actionIds.length > 0 !==
      (requirement.consequenceDigest !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Protected action sets require a consequence digest.',
        path: ['consequenceDigest'],
      });
    }
  })
  .readonly();

/** Server-derived human-only execution requirement inferred from its schema. */
export type HumanActionRequirement = z.infer<
  typeof HumanActionRequirementSchema
>;

/**
 * Owns safety-relevant capability effects independently from route or tool
 * names. Generic aliases that can reach a protected domain transition must
 * declare that effect and use a non-none human-action policy.
 */
export const CapabilitySafetyEffectSchema = z.enum([
  'none',
  'start-event',
  'send-notification',
  'all-clear-event',
  'close-event',
]);

/** Safety-relevant capability effect inferred from its schema. */
export type CapabilitySafetyEffect = z.infer<
  typeof CapabilitySafetyEffectSchema
>;

/**
 * Owns the trusted current-state classification returned by a safety resolver.
 * It mirrors the only valid event/recipient combinations without accepting a
 * caller-supplied protected-action list.
 */
export const CapabilitySafetyResolutionSchema = z
  .union([
    z
      .object({
        eventKind: z.literal('incident'),
        rosterPopulation: z.literal('staff'),
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        eventKind: z.literal('drill'),
        rosterPopulation: z.literal('staff'),
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        eventKind: z.literal('drill'),
        rosterPopulation: z.literal('synthetic'),
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        eventKind: z.literal('test'),
        rosterPopulation: z.literal('synthetic'),
        consequenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  ])
  .readonly();

/** Trusted state classification for safety resolution inferred from schema. */
export type CapabilitySafetyResolution = z.infer<
  typeof CapabilitySafetyResolutionSchema
>;

/**
 * Owns the closed mutation registry used by every executeCapability adapter.
 * IDs absent from this map cannot register or parse as mutations; the central
 * map, not a route or handler, determines each safety effect. Human-only
 * action IDs are deliberately absent because they are derived requirements,
 * never callable operations.
 */
export const CAPABILITY_MUTATION_SAFETY_MANIFEST = Object.freeze({
  'complete-oidc-sign-in': 'none',
  'refresh-session': 'none',
  'revoke-session': 'none',
  'sync-roster': 'none',
  'sync-access-membership': 'none',
  'record-delivery-test-canary-eligibility': 'none',
  'create-delivery-test-target-set-version': 'none',
  'prepare-activation': 'none',
  'start-event': 'start-event',
  'join-event': 'none',
  'append-journal-entry': 'none',
  'correct-journal-entry': 'none',
  'redact-journal-entry': 'none',
  'all-clear-event': 'all-clear-event',
  'reactivate-event': 'start-event',
  'close-event': 'close-event',
  'reopen-as-correction': 'none',
  'create-media-upload-intent': 'none',
  'complete-media-upload': 'none',
  'create-event-type-draft': 'none',
  'update-event-type-draft': 'none',
  'publish-event-type-version': 'none',
  'dispatch-outbox': 'none',
  'record-delivery-evidence': 'none',
  'reconcile-delivery-attempts': 'none',
  'record-endpoint-status': 'none',
  'record-sms-opt-out': 'none',
  'finalize-delivery-test-report': 'none',
  'register-push-token': 'none',
  'unregister-push-token': 'none',
  'create-facility': 'none',
  'update-facility': 'none',
  'create-neighborhood-version': 'none',
  'create-group-source': 'none',
  'update-group-source': 'none',
  'set-channel-enabled': 'none',
  'issue-agent-api-key': 'none',
  'revoke-agent-api-key': 'none',
  'create-lifecycle-consequence-preview': 'none',
} as const satisfies Readonly<Record<string, CapabilitySafetyEffect>>);

/**
 * Owns the closed read-only capability registry. Query adapters receive no
 * mutation handler or provider interface, and IDs absent from this list fail
 * registration and envelope parsing rather than becoming GET aliases.
 */
export const CAPABILITY_QUERY_MANIFEST = Object.freeze({
  'create-activation-preview': 'none',
  'create-delivery-test-preview': 'none',
  'get-prepared-activation': 'none',
  'get-current-session': 'none',
  'list-device-sessions': 'none',
  'list-facilities': 'none',
  'get-facility': 'none',
  'list-neighborhoods': 'none',
  'list-group-sources': 'none',
  'get-roster-snapshot': 'none',
  'get-roster-health': 'none',
  'get-stale-roster-report': 'none',
  'list-active-events': 'none',
  'get-event': 'none',
  'sync-event-room': 'none',
  'list-journal-entries': 'none',
  'search-journal-entries': 'none',
  'get-media-read-grant': 'none',
  'list-event-types': 'none',
  'get-event-type-version': 'none',
  'get-event-type-draft': 'none',
  'preview-event-type-rendering': 'none',
  'get-notification-status': 'none',
  'get-integration-health': 'none',
  'get-admin-readiness': 'none',
  'query-security-audit': 'none',
  'verify-security-audit-chain': 'none',
  'run-delivery-report': 'none',
  'list-delivery-test-reports': 'none',
  'list-my-devices': 'none',
  'list-neighborhood-versions': 'none',
  'get-neighborhood-version': 'none',
  'list-users': 'none',
  'list-agent-api-keys': 'none',
  'list-drill-records': 'none',
  'export-drill-records': 'none',
  'export-event-summary': 'none',
} as const satisfies Readonly<Record<string, 'none'>>);

/** Closed query capability identifier inferred from the query manifest. */
export type QueryCapabilityId = keyof typeof CAPABILITY_QUERY_MANIFEST;

/** Closed mutation capability identifier inferred from the safety manifest. */
export type MutationCapabilityId =
  keyof typeof CAPABILITY_MUTATION_SAFETY_MANIFEST;

function isRegisteredMutationCapabilityId(
  value: string,
): value is MutationCapabilityId {
  return Object.hasOwn(CAPABILITY_MUTATION_SAFETY_MANIFEST, value);
}

function isRegisteredQueryCapabilityId(
  value: string,
): value is QueryCapabilityId {
  return Object.hasOwn(CAPABILITY_QUERY_MANIFEST, value);
}

/**
 * Owns trusted execution metadata supplied to protected-action resolution.
 * A derived resolver may await repository reads using its server-injected
 * dependencies; none of this context is accepted from an external request.
 */
export interface HumanActionResolutionContext {
  readonly actor: Actor;
  readonly source: InvocationSource;
  readonly scope: CapabilityScope;
  readonly requestId: string;
  readonly serverTime: string;
  readonly connectivityEpochId: string | null;
}

/**
 * Declares whether a capability is unprotected or delegates classification to
 * the one central safety resolver. Per-capability callbacks cannot classify
 * their own target as synthetic or choose protected action IDs.
 */
export type HumanActionPolicy =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'central' }>;

/** Typed immutable registration consumed by the shared capability engine. */
export interface CapabilityRegistration<
  Id extends string,
  Operation extends 'query' | 'mutation',
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> {
  readonly id: Id;
  readonly operation: Operation;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly humanActionPolicy: HumanActionPolicy;
}

/** Immutable registered capability with its centrally derived safety effect. */
export interface CapabilityDefinition<
  Id extends string,
  Operation extends 'query' | 'mutation',
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> extends CapabilityRegistration<Id, Operation, InputSchema, OutputSchema> {
  readonly safetyEffect: CapabilitySafetyEffect;
}

/** Trusted request passed only to the server's central safety resolver. */
export interface CapabilitySafetyResolutionRequest {
  readonly capabilityId: CapabilityId;
  readonly safetyEffect: Exclude<CapabilitySafetyEffect, 'none'>;
  readonly input: unknown;
  readonly context: HumanActionResolutionContext;
}

/**
 * Owns the server-injected boundary that loads authoritative preview/event
 * state for every safety-relevant capability. The capability definition itself
 * cannot supply this implementation.
 */
export interface CapabilitySafetyResolver {
  readonly resolve: (
    request: CapabilitySafetyResolutionRequest,
  ) => CapabilitySafetyResolution | Promise<CapabilitySafetyResolution>;
}
