import { sql } from 'drizzle-orm';

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { roleEnum, groupSourceKindEnum, groupPurposeEnum } from './enums';

import { occurredAt } from './shared';
/** Opaque, retained identities used only to keep audit history resolvable. */
export const securityAuditFacilityAnchors = pgTable(
  'security_audit_facility_anchors',
  {
    facilityId: uuid('facility_id').primaryKey(),
  },
);

/** Stable administrator-managed district facilities. */
export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('facilities_code_uq').on(table.code),
    check('facilities_code_format', sql`${table.code} ~ '^[A-Z0-9-]+$'`),
    check('facilities_name_nonempty', sql`length(btrim(${table.name})) > 0`),
  ],
);

/** Immutable versions of administrator-defined neighborhoods. */
export const neighborhoodVersions = pgTable(
  'neighborhood_versions',
  {
    id: uuid('id').notNull(),
    version: integer('version').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    check('neighborhood_versions_version_positive', sql`${table.version} > 0`),
    check(
      'neighborhood_versions_name_nonempty',
      sql`length(btrim(${table.name})) > 0`,
    ),
  ],
);

/** Facility membership pinned to one immutable neighborhood version. */
export const neighborhoodFacilities = pgTable(
  'neighborhood_facilities',
  {
    neighborhoodId: uuid('neighborhood_id').notNull(),
    neighborhoodVersion: integer('neighborhood_version').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.neighborhoodId,
        table.neighborhoodVersion,
        table.facilityId,
      ],
    }),
    foreignKey({
      columns: [table.neighborhoodId, table.neighborhoodVersion],
      foreignColumns: [neighborhoodVersions.id, neighborhoodVersions.version],
      name: 'neighborhood_facilities_version_fk',
    }).onDelete('restrict'),
    index('neighborhood_facilities_facility_idx').on(table.facilityId),
  ],
);

/** Purpose-bound Google Group or fail-closed synthetic source configuration. */
/**
 * One person currently in one group source, whatever that source is for.
 *
 * Sign-in reads the rows whose source has `purpose = 'access'`: is the viewer
 * in a group the deployment trusts, and what role does that group grant.
 * Notification recipients read the rows whose source has `purpose = 'building'`
 * — the staff at a school, which is what an event at that school notifies.
 *
 * One table for both because the row is the same fact either way, and because
 * membership from a group the district has not activated for a purpose cannot
 * leak into that purpose: every reader constrains `group_source_id` to the
 * sources it has already selected by purpose.
 *
 * Membership is replaced wholesale per group when the provider is read, so a
 * row existing means the person was in that group as of the source's
 * `membersCapturedAt`.
 */
export const groupMembers = pgTable(
  'group_members',
  {
    groupSourceId: uuid('group_source_id')
      .notNull()
      .references(() => groupSources.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    capturedAt: occurredAt('captured_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'group_members_pk',
      columns: [table.groupSourceId, table.email],
    }),
    index('group_members_email_idx').on(table.email),
  ],
);

export const groupSources = pgTable(
  'group_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: groupSourceKindEnum('kind').notNull(),
    purpose: groupPurposeEnum('purpose').notNull(),
    facilityId: uuid('facility_id').references(() => facilities.id, {
      onDelete: 'restrict',
    }),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    active: boolean('active').default(true).notNull(),
    // Access sources only. The role every member of this group receives, so a
    // deployment configures who administers instead of compiling it in.
    grantedRole: roleEnum('granted_role'),
    // When this group's membership was last read from the provider. Sign-in
    // refuses membership that has gone stale, which is the only temporal
    // question it needs to ask — there is no global generation to agree on.
    membersCapturedAt: occurredAt('members_captured_at'),
    googleGroupId: varchar('google_group_id', { length: 255 }),
    email: varchar('email', { length: 320 }),
    fixtureKey: varchar('fixture_key', { length: 100 }),
    createdAt: occurredAt('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('group_sources_identity_kind_purpose_uq').on(
      table.id,
      table.kind,
      table.purpose,
    ),
    unique('group_sources_google_group_id_uq').on(table.googleGroupId),
    unique('group_sources_fixture_key_uq').on(table.fixtureKey),
    index('group_sources_facility_idx').on(table.facilityId),
    check(
      'group_sources_access_role_present',
      sql`(
        ${table.purpose} = 'access' and ${table.grantedRole} is not null
      ) or (
        ${table.purpose} <> 'access' and ${table.grantedRole} is null
      )`,
    ),
    check(
      'group_sources_valid_variant',
      sql`(
        ${table.kind} = 'google-group'
        and ${table.googleGroupId} is not null
        and ${table.email} is not null
        and ${table.fixtureKey} is null
        and (
          (${table.purpose} = 'building' and ${table.facilityId} is not null)
          or (${table.purpose} in ('access', 'others') and ${table.facilityId} is null)
        )
      ) or (
        ${table.kind} = 'synthetic'
        and ${table.googleGroupId} is null
        and ${table.email} is null
        and ${table.fixtureKey} is not null
        and ${table.purpose} in ('building', 'others')
        and (
          (${table.purpose} = 'building' and ${table.facilityId} is not null)
          or (${table.purpose} = 'others' and ${table.facilityId} is null)
        )
      ) or (
        -- Compared as text so this constraint can be created in the same
        -- migration transaction that adds 'manual' to the enum. PostgreSQL
        -- refuses a new enum value used as an enum literal before it commits.
        ${table.kind}::text = 'manual'
        and ${table.googleGroupId} is null
        and ${table.email} is null
        and ${table.fixtureKey} is null
        and ${table.purpose} = 'building'
        and ${table.facilityId} is not null
      )`,
    ),
    check(
      'group_sources_fixture_key_format',
      sql`${table.fixtureKey} is null or ${table.fixtureKey} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);
