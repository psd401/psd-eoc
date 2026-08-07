import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import {
  ActorSchema,
  CapabilityIdSchema,
  HumanConfirmationIdSchema,
  InvocationSourceSchema,
  isActorSourceCompatible,
} from './capability';
import { FacilityIdSchema } from './facility';
import { HumanOnlyActionIdSchema } from './human-only';
import { TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the bounded release-one security audit taxonomy. Operational event
 * narrative stays in the separate journal; these categories cover identity,
 * authorization, administrative, agent, and audit access facts only.
 */
export const SecurityAuditCategorySchema = z.enum([
  'sign-in',
  'access-denial',
  'admin-change',
  'agent-access',
  'session-revocation',
  'human-only-rejection',
  'capability-execution',
  'audit-query',
]);

/** Security audit category inferred from its schema. */
export type SecurityAuditCategory = z.infer<typeof SecurityAuditCategorySchema>;

/**
 * Owns the truth state of a security-audited operation. Denial is distinct
 * from execution failure and never implies that a protected action ran.
 */
export const SecurityAuditOutcomeSchema = z.enum([
  'success',
  'denied',
  'failure',
]);

/** Security audit outcome inferred from its schema. */
export type SecurityAuditOutcome = z.infer<typeof SecurityAuditOutcomeSchema>;

/**
 * Owns the SHA-256 hexadecimal representation used by the append-only audit
 * hash chain. The first entry has a null previous hash; later entries pin it.
 */
export const SecurityAuditHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Security audit hash inferred from its schema. */
export type SecurityAuditHash = z.infer<typeof SecurityAuditHashSchema>;

/**
 * Owns the principal representation for pre-session denials. A normalized
 * subject may be hashed for correlation, but raw email, message content, and
 * provider payloads are prohibited.
 */
export const UnauthenticatedAuditPrincipalSchema = z
  .object({
    kind: z.literal('unauthenticated'),
    subjectDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict()
  .readonly();

/** Pre-session security audit principal inferred from its schema. */
export type UnauthenticatedAuditPrincipal = z.infer<
  typeof UnauthenticatedAuditPrincipalSchema
>;

/**
 * Owns the trusted-or-pre-session principal union for security audit entries.
 * Capability actors remain server-resolved; unknown OIDC users use only the
 * minimized unauthenticated form.
 */
export const SecurityAuditPrincipalSchema = z
  .union([ActorSchema, UnauthenticatedAuditPrincipalSchema])
  .readonly();

/** Security audit principal inferred from its schema. */
export type SecurityAuditPrincipal = z.infer<
  typeof SecurityAuditPrincipalSchema
>;

/**
 * Owns the complete principal-kind filter vocabulary, including requests that
 * were denied before an authenticated actor could be resolved.
 */
export const SecurityAuditPrincipalKindSchema = z.enum([
  'human',
  'agent',
  'system',
  'unauthenticated',
]);

/** Security audit principal kind inferred from its schema. */
export type SecurityAuditPrincipalKind = z.infer<
  typeof SecurityAuditPrincipalKindSchema
>;

/**
 * Owns a minimized exact-principal filter for authorized audit queries. It
 * carries only stable IDs or a precomputed unknown-subject digest, never PII.
 */
export const SecurityAuditPrincipalFilterSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('human'), userId: UuidSchema }).strict(),
    z.object({ kind: z.literal('agent'), agentId: UuidSchema }).strict(),
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
    z
      .object({
        kind: z.literal('unauthenticated'),
        subjectDigest: SecurityAuditHashSchema,
      })
      .strict(),
  ])
  .readonly();

/** Minimized exact audit-principal filter inferred from its schema. */
export type SecurityAuditPrincipalFilter = z.infer<
  typeof SecurityAuditPrincipalFilterSchema
>;

/** Owns the normalized security-audit target discriminator. */
export const SecurityAuditTargetKindSchema = z.enum([
  'user',
  'session',
  'device',
  'agent',
  'configuration',
  'capability',
  'audit-query',
]);

/** Normalized security-audit target kind inferred from its schema. */
export type SecurityAuditTargetKind = z.infer<
  typeof SecurityAuditTargetKindSchema
>;

/**
 * Owns a minimized target reference for an audited operation. It identifies a
 * record category and opaque ID without copying staff PII or event content.
 */
export const SecurityAuditTargetSchema = z
  .object({
    kind: SecurityAuditTargetKindSchema,
    id: z.string().trim().min(1).max(255),
  })
  .strict()
  .readonly();

/** Minimized security audit target inferred from its schema. */
export type SecurityAuditTarget = z.infer<typeof SecurityAuditTargetSchema>;

/**
 * Owns one append-only, hash-chained security audit entry. It intentionally
 * has no arbitrary metadata or message-content field; reason codes are bounded
 * taxonomy values and audit history remains distinct from event journals.
 */
export const SecurityAuditEntrySchema = z
  .object({
    id: UuidSchema,
    sequence: z.number().int().positive(),
    previousHash: SecurityAuditHashSchema.nullable(),
    entryHash: SecurityAuditHashSchema,
    category: SecurityAuditCategorySchema,
    action: CapabilityIdSchema,
    actionIds: z
      .array(HumanOnlyActionIdSchema)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Audited protected action IDs must be unique.',
      })
      .readonly(),
    confirmationId: HumanConfirmationIdSchema.nullable(),
    outcome: SecurityAuditOutcomeSchema,
    principal: SecurityAuditPrincipalSchema,
    source: InvocationSourceSchema,
    facilityId: FacilityIdSchema.nullable(),
    target: SecurityAuditTargetSchema.nullable(),
    requestId: UuidSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    occurredAt: TimestampSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.sequence === 1) !== (entry.previousHash === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first audit entry may have no previous hash.',
        path: ['previousHash'],
      });
    }
    if (
      entry.principal.kind !== 'unauthenticated' &&
      !isActorSourceCompatible(entry.principal, entry.source)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Audit principal and invocation source are incompatible.',
        path: ['source'],
      });
    }
    if (
      entry.principal.kind === 'unauthenticated' &&
      entry.outcome === 'success'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An unauthenticated principal cannot record successful access.',
        path: ['outcome'],
      });
    }
    const denialCategory = ['access-denial', 'human-only-rejection'].includes(
      entry.category,
    );
    if (denialCategory && entry.outcome !== 'denied') {
      context.addIssue({
        code: 'custom',
        message: 'Denial categories require denied outcome.',
        path: ['outcome'],
      });
    }
    if ((entry.outcome === 'success') !== (entry.reasonCode === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Denied or failed audit facts require a safe reason code.',
        path: ['reasonCode'],
      });
    }
    if (
      entry.category === 'human-only-rejection' &&
      entry.actionIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Human-only rejection must name the protected actions.',
        path: ['actionIds'],
      });
    }
    if (
      entry.actionIds.length > 0 &&
      entry.outcome === 'success' &&
      entry.confirmationId === null
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Successful protected actions require confirmation provenance.',
        path: ['confirmationId'],
      });
    }
    if (
      entry.actionIds.length > 0 &&
      entry.outcome === 'success' &&
      entry.principal.kind !== 'human'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a human principal may succeed at protected actions.',
        path: ['principal'],
      });
    }
    if (entry.confirmationId !== null && entry.actionIds.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmation provenance must name protected actions.',
        path: ['actionIds'],
      });
    }
  })
  .readonly();

/** Append-only hash-chained security audit entry inferred from its schema. */
export type SecurityAuditEntry = z.infer<typeof SecurityAuditEntrySchema>;

/**
 * Owns bounded, auditor-scoped query filters for the security log. The
 * capability layer still authorizes and audits every query itself.
 */
export const SecurityAuditQuerySchema = z
  .object({
    actorKind: SecurityAuditPrincipalKindSchema.nullable(),
    principal: SecurityAuditPrincipalFilterSchema.nullable(),
    category: SecurityAuditCategorySchema.nullable(),
    outcome: SecurityAuditOutcomeSchema.nullable(),
    action: CapabilityIdSchema.nullable(),
    facilityId: FacilityIdSchema.nullable(),
    occurredFrom: TimestampSchema.nullable(),
    occurredThrough: TimestampSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.occurredFrom &&
      query.occurredThrough &&
      Date.parse(query.occurredThrough) < Date.parse(query.occurredFrom)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Audit query end time cannot precede start time.',
        path: ['occurredThrough'],
      });
    }
    if (
      query.actorKind &&
      query.principal &&
      query.actorKind !== query.principal.kind
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Principal filter kind must match the requested actor kind.',
        path: ['principal'],
      });
    }
  })
  .readonly();

/** Bounded security audit query inferred from its schema. */
export type SecurityAuditQuery = z.infer<typeof SecurityAuditQuerySchema>;

/**
 * Owns a hash-chain verification result returned by the audit verification
 * job. Failure identifies the first bad sequence without exposing entry data.
 */
export const SecurityAuditVerificationSchema = z
  .union([
    z
      .object({
        valid: z.literal(true),
        verifiedThroughSequence: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        valid: z.literal(false),
        firstInvalidSequence: z.number().int().positive(),
      })
      .strict(),
  ])
  .readonly();

/** Security audit hash-chain result inferred from its schema. */
export type SecurityAuditVerification = z.infer<
  typeof SecurityAuditVerificationSchema
>;

/** Owns a bounded authorized page of append-only security audit entries. */
export const SecurityAuditPageSchema = paginatedSchema(
  SecurityAuditEntrySchema,
);

/** Authorized security-audit page inferred from its schema. */
export type SecurityAuditPage = z.infer<typeof SecurityAuditPageSchema>;

/**
 * Owns a bounded hash-chain verification request. Null boundaries verify the
 * complete retained chain; callers cannot supply expected hashes or results.
 */
export const VerifySecurityAuditChainInputSchema = z
  .object({
    fromSequence: z.number().int().positive().nullable(),
    throughSequence: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.fromSequence !== null &&
      input.throughSequence !== null &&
      input.throughSequence < input.fromSequence
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Audit verification end cannot precede its start.',
        path: ['throughSequence'],
      });
    }
  })
  .readonly();

/** Security-audit chain verification input inferred from its schema. */
export type VerifySecurityAuditChainInput = z.infer<
  typeof VerifySecurityAuditChainInputSchema
>;
