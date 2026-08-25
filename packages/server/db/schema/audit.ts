import { sql } from 'drizzle-orm';

import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  invocationSourceEnum,
  securityAuditCategoryEnum,
  securityAuditOutcomeEnum,
} from './enums';

import { auditCode, digest, occurredAt } from './shared';

import { securityAuditFacilityAnchors } from './configuration';

import { humanConfirmationRecords } from './identity';
/** Separate append-only, hash-chained security audit log. */
export const securityAuditEntries = pgTable(
  'security_audit_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sequence: integer('sequence').notNull(),
    previousHash: digest('previous_hash'),
    entryHash: digest('entry_hash').notNull(),
    category: securityAuditCategoryEnum('category').notNull(),
    action: varchar('action', { length: 120 }).notNull(),
    actionIds: jsonb('action_ids').notNull(),
    confirmationId: uuid('confirmation_id').references(
      () => humanConfirmationRecords.id,
      { onDelete: 'restrict' },
    ),
    outcome: securityAuditOutcomeEnum('outcome').notNull(),
    principalKind: varchar('principal_kind', { length: 32 }).notNull(),
    principal: jsonb('principal').notNull(),
    source: invocationSourceEnum('source').notNull(),
    facilityId: uuid('facility_id').references(
      () => securityAuditFacilityAnchors.facilityId,
      { onDelete: 'restrict' },
    ),
    targetKind: varchar('target_kind', { length: 32 }),
    targetId: varchar('target_id', { length: 255 }),
    requestId: uuid('request_id').notNull(),
    reasonCode: auditCode('reason_code'),
    occurredAt: occurredAt('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('security_audit_entries_sequence_uq').on(table.sequence),
    uniqueIndex('security_audit_entries_hash_uq').on(table.entryHash),
    uniqueIndex('security_audit_entries_request_uq').on(table.requestId),
    index('security_audit_entries_query_idx').on(
      table.occurredAt,
      table.category,
      table.outcome,
    ),
    check(
      'security_audit_entries_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'security_audit_entries_hash_chain',
      sql`(${table.sequence} = 1) = (${table.previousHash} is null)`,
    ),
    check(
      'security_audit_entries_hash_format',
      sql`${table.entryHash} ~ '^[a-f0-9]{64}$'
        and (${table.previousHash} is null or ${table.previousHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'security_audit_entries_action_format',
      sql`${table.action} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'security_audit_entries_principal_kind',
      sql`${table.principalKind} in ('human', 'agent', 'system', 'unauthenticated')`,
    ),
    check(
      'security_audit_entries_target_pair',
      sql`(${table.targetKind} is null) = (${table.targetId} is null)`,
    ),
    check(
      'security_audit_entries_outcome_reason',
      sql`(${table.outcome} = 'success') = (${table.reasonCode} is null)`,
    ),
  ],
);

/**
 * Append-only external anchors make deletion of the audit-chain tail
 * detectable. A database trigger, not application writers, owns inserts.
 */
export const securityAuditChainAnchors = pgTable(
  'security_audit_chain_anchors',
  {
    sequence: integer('sequence').primaryKey(),
    entryHash: digest('entry_hash').notNull(),
  },
  (table) => [
    unique('security_audit_chain_anchors_hash_uq').on(table.entryHash),
    check(
      'security_audit_chain_anchors_sequence_positive',
      sql`${table.sequence} > 0`,
    ),
    check(
      'security_audit_chain_anchors_hash_format',
      sql`${table.entryHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
