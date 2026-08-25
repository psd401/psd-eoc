import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import type { AgentGrantableCapabilityId } from './capability-catalog';
import { InstalledAgentGrantableCapabilityIdSchema } from './capability-derived-registry';
import { FacilityScopeSchema } from './facility';
import { TimestampSchema, UuidSchema } from './shared';

/** Stable identity for a district agent principal. */
export const AgentIdSchema = UuidSchema;

/** District agent identifier inferred from its schema. */
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Stable identity for one revocable agent API key. */
export const AgentApiKeyIdSchema = UuidSchema;

/** Agent API-key identifier inferred from its schema. */
export type AgentApiKeyId = z.infer<typeof AgentApiKeyIdSchema>;

/** Owns the closed agent-key capability-grant vocabulary. */
export const AgentGrantableCapabilityIdSchema =
  InstalledAgentGrantableCapabilityIdSchema as z.ZodType<AgentGrantableCapabilityId>;

/**
 * Owns the closed capability grant vocabulary available to agent API keys.
 * Unknown aliases, protected action names, credentials, and internal worker
 * operations cannot be persisted as agent authority.
 */
export const AgentCapabilityGrantSchema = AgentGrantableCapabilityIdSchema;

type AgentCapabilityGrantValue = z.infer<typeof AgentCapabilityGrantSchema>;

/**
 * Owns an agent API-key issuance request. Actor, issuance time, key material,
 * and authorization are server-owned; the caller supplies only the intended
 * name, bounded facility/capability scope, and optional lifetime.
 */
export const IssueAgentApiKeyInputSchema = z
  .object({
    agentId: AgentIdSchema.nullable(),
    displayName: z.string().trim().min(1).max(160),
    facilityScope: FacilityScopeSchema,
    capabilityIds: z
      .array(AgentCapabilityGrantSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Agent capability grants must be unique.',
      })
      .readonly(),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(366 * 24 * 60 * 60)
      .nullable(),
  })
  .strict()
  .readonly();

/** Agent API-key issuance input inferred from its schema. */
export type IssueAgentApiKeyInput = z.infer<typeof IssueAgentApiKeyInputSchema>;

const agentApiKeySummaryShape = {
  id: AgentApiKeyIdSchema,
  agentId: AgentIdSchema,
  displayName: z.string().trim().min(1).max(160),
  facilityScope: FacilityScopeSchema,
  capabilityIds: z.array(AgentCapabilityGrantSchema).min(1).max(100).readonly(),
  keyPrefix: z
    .string()
    .trim()
    .min(8)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/u),
  issuedByUserId: UuidSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
};

function addAgentApiKeyLifecycleIssues(
  key: {
    readonly capabilityIds: readonly AgentCapabilityGrantValue[];
    readonly issuedAt: string;
    readonly expiresAt: string | null;
    readonly revokedAt: string | null;
  },
  context: z.RefinementCtx,
): void {
  if (new Set(key.capabilityIds).size !== key.capabilityIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'Retained agent capability grants must be unique.',
      path: ['capabilityIds'],
    });
  }
  if (key.expiresAt && Date.parse(key.expiresAt) < Date.parse(key.issuedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Agent key expiry cannot precede issuance.',
      path: ['expiresAt'],
    });
  }
  if (key.revokedAt && Date.parse(key.revokedAt) < Date.parse(key.issuedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Agent key revocation cannot precede issuance.',
      path: ['revokedAt'],
    });
  }
}

/**
 * Owns client-safe agent key metadata. Prefix, scope, grants, and lifecycle
 * are visible for administration, while the verifier digest is structurally
 * absent from every issuance/list response.
 */
export const AgentApiKeySummarySchema = z
  .object(agentApiKeySummaryShape)
  .strict()
  .superRefine(addAgentApiKeyLifecycleIssues)
  .readonly();

/** Client-safe agent API-key metadata inferred from its schema. */
export type AgentApiKeySummary = z.infer<typeof AgentApiKeySummarySchema>;

/**
 * Owns the persisted agent API-key verifier record. The credential digest is
 * required for authentication but must never be returned by a read/list
 * capability; revocation and expiry preserve append-only lifecycle truth.
 */
export const AgentApiKeySchema = z
  .object({
    ...agentApiKeySummaryShape,
    credentialDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine(addAgentApiKeyLifecycleIssues)
  .readonly();

/** Persisted agent API-key verifier record inferred from its schema. */
export type AgentApiKey = z.infer<typeof AgentApiKeySchema>;

/**
 * Owns the one-time agent API-key issuance result. The plaintext credential is
 * returned exactly once and must never be persisted, logged, or placed in a
 * repository fixture; metadata omits the persisted verifier digest.
 */
export const AgentApiKeyIssuanceSchema = z
  .object({
    key: AgentApiKeySummarySchema,
    oneTimeCredential: z.string().min(32).max(512),
  })
  .strict()
  .readonly();

/** One-time agent API-key issuance result inferred from its schema. */
export type AgentApiKeyIssuance = z.infer<typeof AgentApiKeyIssuanceSchema>;

/** Owns a request to revoke one agent key without deleting its history. */
export const RevokeAgentApiKeyInputSchema = z
  .object({
    apiKeyId: AgentApiKeyIdSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u),
  })
  .strict()
  .readonly();

/** Agent API-key revocation input inferred from its schema. */
export type RevokeAgentApiKeyInput = z.infer<
  typeof RevokeAgentApiKeyInputSchema
>;

/** Owns one append-only agent API-key revocation fact. */
export const AgentApiKeyRevocationSchema = z
  .object({
    id: UuidSchema,
    apiKeyId: AgentApiKeyIdSchema,
    revokedByUserId: UuidSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u),
    revokedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Append-only agent key-revocation fact inferred from its schema. */
export type AgentApiKeyRevocation = z.infer<typeof AgentApiKeyRevocationSchema>;

/** Owns bounded agent key-administration list filters. */
export const ListAgentApiKeysInputSchema = z
  .object({
    agentId: AgentIdSchema.nullable(),
    includeRevoked: z.boolean(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Agent key-list input inferred from its schema. */
export type ListAgentApiKeysInput = z.infer<typeof ListAgentApiKeysInputSchema>;

/** Owns a bounded page of non-secret agent API-key metadata. */
export const AgentApiKeyPageSchema = paginatedSchema(AgentApiKeySummarySchema);

/** Non-secret agent API-key page inferred from its schema. */
export type AgentApiKeyPage = z.infer<typeof AgentApiKeyPageSchema>;
