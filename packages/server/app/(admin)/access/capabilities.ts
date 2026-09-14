import {
  AdmitAccountInputSchema,
  AdmittedAccountListSchema,
  AdmittedAccountSchema,
  RevokeAdmittedAccountInputSchema,
  RoleSchema,
  SetUserFacilityScopeInputSchema,
  UserPageSchema,
  UserSchema,
  UuidSchema,
  type AdmittedAccount,
  type AdmittedAccountList,
  type CapabilityInput,
  type Role,
  type User,
  type UserPage,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  admittedAccounts,
  facilities,
  groupMembers,
  groupSources,
  userFacilityScopes,
  userRoleChanges,
  userRoles,
  users,
} from '../../../db/schema';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadEffectiveAdministratorUserIds,
  projectEffectiveRoles,
  type RoleChangeFact,
} from '../../../lib/auth/role-state';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { MEMBERSHIP_FRESHNESS_MS } from '../../../lib/auth/trusted-group-access';
import { type ServerCapabilityRegistration } from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryDatabase,
  type AdminMutationMetadata,
  type AdminQueryMetadata,
} from '../../../lib/capabilities/admin';

interface MutationExecution<Input> {
  readonly authenticated: AuthenticatedSession;
  readonly store?: AdminCapabilityStore;
  readonly command: Input;
  readonly metadata: AdminMutationMetadata;
}

function executionStore(
  authenticated: AuthenticatedSession,
  store: AdminCapabilityStore | undefined,
): AdminCapabilityStore {
  return (
    store ??
    createDrizzleAdminCapabilityStore(getDefaultAdminDatabase(), authenticated)
  );
}

function invalid(message: string): AdminCapabilityError {
  return new AdminCapabilityError('VALIDATION_ERROR', message, 400);
}

function guard(
  context: Readonly<{
    invocation: {
      actor: Parameters<typeof requireAdminCapabilityAuthorization>[0];
    };
    transaction: AdminCapabilityTransaction;
  }>,
): null {
  requireAdminCapabilityAuthorization(
    context.invocation.actor,
    context.transaction,
  );
  return null;
}

export interface UserPageCursorFilters {
  readonly facilityId: string | null;
  readonly includeDisabled: boolean;
}

interface UserPageCursorPayload extends UserPageCursorFilters {
  readonly v: 1;
  readonly collection: 'users';
  readonly after: string;
}

function invalidUserCursor(): never {
  throw invalid('The user pagination cursor is invalid.');
}

function canonicalUserCursorPayload(
  after: string,
  filters: UserPageCursorFilters,
): UserPageCursorPayload {
  return Object.freeze({
    v: 1 as const,
    collection: 'users' as const,
    facilityId: filters.facilityId,
    includeDisabled: filters.includeDisabled,
    after,
  });
}

/** Encodes one strict, filter-bound continuation after an immutable user ID. */
export function encodeUserPageCursor(
  afterValue: string,
  filters: UserPageCursorFilters,
): string {
  const after = UuidSchema.parse(afterValue);
  const facilityId =
    filters.facilityId === null ? null : UuidSchema.parse(filters.facilityId);
  return Buffer.from(
    JSON.stringify(
      canonicalUserCursorPayload(after, {
        facilityId,
        includeDisabled: filters.includeDisabled,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

/** Decodes only the canonical v1 users cursor for the exact active filters. */
export function decodeUserPageCursor(
  cursor: string | null,
  filters: UserPageCursorFilters,
): string | null {
  if (cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      return invalidUserCursor();
    }
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return invalidUserCursor();
    }
    const keys = Object.keys(parsed);
    const expectedKeys = [
      'v',
      'collection',
      'facilityId',
      'includeDisabled',
      'after',
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      Reflect.get(parsed, 'v') !== 1 ||
      Reflect.get(parsed, 'collection') !== 'users' ||
      typeof Reflect.get(parsed, 'includeDisabled') !== 'boolean'
    ) {
      return invalidUserCursor();
    }
    const facilityIdValue = Reflect.get(parsed, 'facilityId');
    const facilityId =
      facilityIdValue === null ? null : UuidSchema.parse(facilityIdValue);
    const includeDisabled = Reflect.get(parsed, 'includeDisabled') as boolean;
    const after = UuidSchema.parse(Reflect.get(parsed, 'after'));
    const canonical = canonicalUserCursorPayload(after, {
      facilityId,
      includeDisabled,
    });
    if (
      facilityId !== filters.facilityId ||
      includeDisabled !== filters.includeDisabled ||
      JSON.stringify(canonical) !== decoded
    ) {
      return invalidUserCursor();
    }
    return after;
  } catch {
    return invalidUserCursor();
  }
}

const ROLE_DISPLAY_ORDER: readonly Role[] = ['admin', 'staff'];

/**
 * A membership read recently enough to authorize a sign-in, by the same rule
 * `decideAccess` applies: the fresher of the row's own capture and the
 * group's bulk read. The page lists who can sign in now, not who was once
 * on a list the sync stopped refreshing.
 */
function freshAccessMembership(now: Date) {
  const cutoff = new Date(now.getTime() - MEMBERSHIP_FRESHNESS_MS);
  return and(
    eq(groupSources.purpose, 'access'),
    eq(groupSources.active, true),
    // An SQL expression has no column type for the driver to map a Date
    // through, so the bound is passed as text and Postgres reads it as the
    // timestamp the comparison needs.
    gt(
      sql`greatest(${groupMembers.capturedAt}, coalesce(${groupSources.membersCapturedAt}, ${groupMembers.capturedAt}))`,
      cutoff.toISOString(),
    ),
  );
}

async function projectUserPage(
  database: AdminQueryDatabase,
  rows: readonly (typeof users.$inferSelect)[],
  now: Date,
): Promise<readonly User[]> {
  if (rows.length === 0) return Object.freeze([]);
  const userIds = rows.map(({ id }) => id);

  // Keep these fixed-count batch reads sequential: the Aurora Data API rejects
  // overlapping statements that share one transaction ID.
  const baseRoleRows = await database
    .select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds))
    .orderBy(asc(userRoles.userId), asc(userRoles.role));
  const latestRoleChangeRows = await database
    .selectDistinctOn([userRoleChanges.userId, userRoleChanges.role], {
      userId: userRoleChanges.userId,
      sequence: userRoleChanges.sequence,
      role: userRoleChanges.role,
      granted: userRoleChanges.granted,
    })
    .from(userRoleChanges)
    .where(inArray(userRoleChanges.userId, userIds))
    .orderBy(
      asc(userRoleChanges.userId),
      asc(userRoleChanges.role),
      desc(userRoleChanges.sequence),
    );
  const facilityRows = await database
    .select({
      userId: userFacilityScopes.userId,
      facilityId: userFacilityScopes.facilityId,
    })
    .from(userFacilityScopes)
    .where(inArray(userFacilityScopes.userId, userIds))
    .orderBy(
      asc(userFacilityScopes.userId),
      asc(userFacilityScopes.facilityId),
    );

  const baseRolesByUserId = new Map<string, Role[]>();
  for (const { userId, role } of baseRoleRows) {
    const roles = baseRolesByUserId.get(userId) ?? [];
    roles.push(role);
    baseRolesByUserId.set(userId, roles);
  }
  const roleChangesByUserId = new Map<string, RoleChangeFact[]>();
  for (const { userId, ...change } of latestRoleChangeRows) {
    const changes = roleChangesByUserId.get(userId) ?? [];
    changes.push(change);
    roleChangesByUserId.set(userId, changes);
  }
  const facilityIdsByUserId = new Map<string, string[]>();
  for (const { userId, facilityId } of facilityRows) {
    const facilityIds = facilityIdsByUserId.get(userId) ?? [];
    facilityIds.push(facilityId);
    facilityIdsByUserId.set(userId, facilityIds);
  }

  // Roles are what a person's groups grant, plus staff for a direct
  // admission; the stored grants above are the legacy remainder. Listing
  // only stored grants left this page empty once roles stopped being stored.
  const emails = rows.map(({ email }) => email);
  const groupGrantRows = await database
    .select({ email: groupMembers.email, role: groupSources.grantedRole })
    .from(groupMembers)
    .innerJoin(groupSources, eq(groupSources.id, groupMembers.groupSourceId))
    .where(and(freshAccessMembership(now), inArray(groupMembers.email, emails)))
    .orderBy(asc(groupMembers.email), asc(groupSources.grantedRole));
  const admittedRows = await database
    .select({ email: admittedAccounts.email })
    .from(admittedAccounts)
    .where(
      and(
        isNull(admittedAccounts.revokedAt),
        inArray(admittedAccounts.email, emails),
      ),
    );
  const grantedRolesByEmail = new Map<string, Set<Role>>();
  for (const { email, role } of groupGrantRows) {
    if (role === null) continue;
    const roles = grantedRolesByEmail.get(email) ?? new Set<Role>();
    roles.add(RoleSchema.parse(role));
    grantedRolesByEmail.set(email, roles);
  }
  for (const { email } of admittedRows) {
    const roles = grantedRolesByEmail.get(email) ?? new Set<Role>();
    roles.add('staff');
    grantedRolesByEmail.set(email, roles);
  }
  const rolesFor = (row: typeof users.$inferSelect): readonly Role[] => {
    const roles = new Set<Role>(
      projectEffectiveRoles(
        baseRolesByUserId.get(row.id) ?? [],
        roleChangesByUserId.get(row.id) ?? [],
      ),
    );
    for (const role of grantedRolesByEmail.get(row.email) ?? []) {
      roles.add(role);
    }
    return [...roles].sort(
      (left, right) =>
        ROLE_DISPLAY_ORDER.indexOf(left) - ROLE_DISPLAY_ORDER.indexOf(right),
    );
  };

  return Object.freeze(
    rows.map((row) =>
      UserSchema.parse({
        id: row.id,
        googleSubject: row.googleSubject,
        email: row.email,
        displayName: row.displayName,
        roles: rolesFor(row),
        facilityScope:
          row.facilityScopeKind === 'district'
            ? { kind: 'district' }
            : {
                kind: 'facilities',
                facilityIds: facilityIdsByUserId.get(row.id) ?? [],
              },
        createdAt: row.createdAt.toISOString(),
        disabledAt: row.disabledAt?.toISOString() ?? null,
      }),
    ),
  );
}

async function listUsers(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-users'>,
  now: Date,
): Promise<UserPage> {
  const cursorFilters = {
    facilityId: input.facilityId,
    includeDisabled: input.includeDisabled,
  } as const;
  const afterUserId = decodeUserPageCursor(input.cursor, cursorFilters);
  const facilityUserIds =
    input.facilityId === null
      ? null
      : database
          .select({ userId: userFacilityScopes.userId })
          .from(userFacilityScopes)
          .where(eq(userFacilityScopes.facilityId, input.facilityId));
  // The shared users table also owns roster endpoint subjects that have never
  // signed in and have no role, so this administration surface lists access
  // accounts only: the people an active access group admits (read recently
  // enough to sign in), the people admitted directly, and the legacy stored
  // grants. Roles are not stored any more, so a list of stored grants alone
  // showed nobody.
  const groupAdmittedEmails = database
    .select({ email: groupMembers.email })
    .from(groupMembers)
    .innerJoin(groupSources, eq(groupSources.id, groupMembers.groupSourceId))
    .where(freshAccessMembership(now));
  const directlyAdmittedEmails = database
    .select({ email: admittedAccounts.email })
    .from(admittedAccounts)
    .where(isNull(admittedAccounts.revokedAt));
  const legacyGrantUserIds = database
    .select({ userId: userRoles.userId })
    .from(userRoles);
  const rows = await database
    .select()
    .from(users)
    .where(
      and(
        input.includeDisabled ? undefined : isNull(users.disabledAt),
        afterUserId === null ? undefined : gt(users.id, afterUserId),
        or(
          inArray(users.email, groupAdmittedEmails),
          inArray(users.email, directlyAdmittedEmails),
          inArray(users.id, legacyGrantUserIds),
        ),
        facilityUserIds === null
          ? undefined
          : or(
              eq(users.facilityScopeKind, 'district'),
              inArray(users.id, facilityUserIds),
            ),
      ),
    )
    .orderBy(asc(users.id))
    .limit(input.limit + 1);
  const selected = rows.slice(0, input.limit);
  const items = await projectUserPage(database, selected, now);
  const hasMore = rows.length > input.limit;
  return UserPageSchema.parse({
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore
        ? encodeUserPageCursor(selected[selected.length - 1]!.id, cursorFilters)
        : null,
    },
  });
}

/** Applies the role-transition invariants after one exact locked DB projection. */
export const listUsersRegistration: ServerCapabilityRegistration<
  'list-users',
  AdminCapabilityTransaction
> = {
  id: 'list-users',
  resolveFacilityId: (_input, context) => guard(context),
  handler: (input, context) =>
    listUsers(
      context.transaction.database,
      input,
      context.invocation.serverTime,
    ),
};

export function executeListUsersCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'list-users'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<UserPage> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminQueryCapability(
    listUsersRegistration,
    input.query,
    input.authenticated,
    store,
    input.metadata,
  );
}

/**
 * Records an administrator's decision about where one person may act: the
 * whole district, or a named set of active facilities. Sessions and every
 * capability already enforce the stored scope; nothing set it until now.
 * The first use is the App Review account, limited to the isolated review
 * site so a store reviewer's drill can reach nobody else.
 *
 * The scope rows are written under the administrator-availability lock the
 * database takes on every write to them, so the mutation is serialized with
 * everything else that can change who reaches the system.
 */
async function setUserFacilityScope(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'set-user-facility-scope'>,
  now: Date,
): Promise<User> {
  const input = SetUserFacilityScopeInputSchema.parse(inputValue);
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  const [userRow] = await database
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for('update');
  if (userRow === undefined) {
    throw new AdminCapabilityError(
      'NOT_FOUND',
      'The person was not found.',
      404,
    );
  }
  if (input.facilityScope.kind === 'facilities') {
    // Administration is district-wide: every admin capability refuses a
    // limited scope. Limiting an administrator would lock them out of the
    // pages that could undo it, so the group membership has to change first.
    const administrators = await loadEffectiveAdministratorUserIds(database);
    if (administrators.includes(input.userId)) {
      throw new AdminCapabilityError(
        'CONFLICT',
        'An administrator is district-wide. Move them out of the administrator group before limiting where they act.',
        409,
      );
    }
    const facilityRows = await database
      .select({ id: facilities.id, active: facilities.active })
      .from(facilities)
      .where(inArray(facilities.id, [...input.facilityScope.facilityIds]));
    const known = new Map(facilityRows.map((row) => [row.id, row.active]));
    for (const facilityId of input.facilityScope.facilityIds) {
      const active = known.get(facilityId);
      if (active === undefined) {
        throw invalid('A selected facility does not exist.');
      }
      if (!active) {
        throw invalid('A selected facility is inactive.');
      }
    }
  }
  await database
    .delete(userFacilityScopes)
    .where(eq(userFacilityScopes.userId, input.userId));
  if (input.facilityScope.kind === 'facilities') {
    await database.insert(userFacilityScopes).values(
      input.facilityScope.facilityIds.map((facilityId) => ({
        userId: input.userId,
        facilityId,
      })),
    );
  }
  await database
    .update(users)
    .set({ facilityScopeKind: input.facilityScope.kind })
    .where(eq(users.id, input.userId));
  // Read the person back: the row selected above carries the scope kind as
  // it was before the change, and the projection reads it from the row.
  const updated = await getUser(database, input.userId, now);
  if (updated === null) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The person could not be read back.',
      409,
    );
  }
  return updated;
}

async function getUser(
  database: AdminQueryDatabase,
  userId: string,
  now: Date,
): Promise<User | null> {
  const [row] = await database
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) return null;
  const [projected] = await projectUserPage(database, [row], now);
  return projected ?? null;
}

export const setUserFacilityScopeRegistration: ServerCapabilityRegistration<
  'set-user-facility-scope',
  AdminCapabilityTransaction
> = {
  id: 'set-user-facility-scope',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const output = await setUserFacilityScope(
      context.transaction.database,
      input,
      context.invocation.serverTime,
    );
    context.transaction.setAuditTarget({ kind: 'user', id: output.id });
    return output;
  },
  resultReference: (output) => output.id,
  async loadReplay(reference, context) {
    const output = await getUser(
      context.transaction.database,
      reference,
      context.invocation.serverTime,
    );
    if (output === null) {
      throw new AdminCapabilityError(
        'CONFLICT',
        'The scoped person is unavailable.',
        409,
      );
    }
    return output;
  },
  resolveReplayFacilityId: () => Promise.resolve(null),
  replayFacilityId: () => null,
};

export const executeSetUserFacilityScopeCapability = (
  input: MutationExecution<CapabilityInput<'set-user-facility-scope'>>,
) =>
  executeAdminMutationCapability(
    setUserFacilityScopeRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

function admittedAccountFromRow(
  row: typeof admittedAccounts.$inferSelect,
): AdmittedAccount {
  return AdmittedAccountSchema.parse({
    id: row.id,
    email: row.email,
    note: row.note,
    admittedAt: row.admittedAt.toISOString(),
    admittedByUserId: row.admittedByUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
  });
}

function humanActorUserId(
  context: Readonly<{
    invocation: { actor: { kind: string; userId?: string } };
  }>,
): string {
  const actor = context.invocation.actor;
  if (actor.kind !== 'human' || actor.userId === undefined) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'District administrator access is required.',
      403,
    );
  }
  return actor.userId;
}

async function listAdmittedAccounts(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-admitted-accounts'>,
): Promise<AdmittedAccountList> {
  const rows = await database
    .select()
    .from(admittedAccounts)
    .where(
      input.includeRevoked ? undefined : isNull(admittedAccounts.revokedAt),
    )
    .orderBy(desc(admittedAccounts.admittedAt), asc(admittedAccounts.id))
    .limit(500);
  return AdmittedAccountListSchema.parse({
    items: rows.map(admittedAccountFromRow),
  });
}

async function getAdmittedAccount(
  database: AdminQueryDatabase,
  admittedAccountId: string,
): Promise<AdmittedAccount | null> {
  const [row] = await database
    .select()
    .from(admittedAccounts)
    .where(eq(admittedAccounts.id, admittedAccountId))
    .limit(1);
  return row === undefined ? null : admittedAccountFromRow(row);
}

/**
 * Admits one address to sign in as staff without a group. The same advisory
 * lock every access change takes serializes two administrators admitting the
 * same address at once; the partial unique index is the backstop.
 */
async function admitAccount(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'admit-account'>,
  admittedByUserId: string,
  now: Date,
): Promise<AdmittedAccount> {
  const input = AdmitAccountInputSchema.parse(inputValue);
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  const [existing] = await database
    .select({ id: admittedAccounts.id })
    .from(admittedAccounts)
    .where(
      and(
        eq(admittedAccounts.email, input.email),
        isNull(admittedAccounts.revokedAt),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'That address is already admitted.',
      409,
    );
  }
  const [row] = await database
    .insert(admittedAccounts)
    .values({
      email: input.email,
      note: input.note ?? '',
      admittedAt: now,
      admittedByUserId,
    })
    .returning();
  if (row === undefined) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The admission could not be recorded.',
      409,
    );
  }
  return admittedAccountFromRow(row);
}

/** Ends an admission; the next sign-in is refused and the row stays as record. */
async function revokeAdmittedAccount(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'revoke-admitted-account'>,
  revokedByUserId: string,
  now: Date,
): Promise<AdmittedAccount> {
  const input = RevokeAdmittedAccountInputSchema.parse(inputValue);
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  const [row] = await database
    .select()
    .from(admittedAccounts)
    .where(eq(admittedAccounts.id, input.admittedAccountId))
    .limit(1)
    .for('update');
  if (row === undefined) {
    throw new AdminCapabilityError(
      'NOT_FOUND',
      'The admission was not found.',
      404,
    );
  }
  if (row.revokedAt !== null) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'That admission was already revoked.',
      409,
    );
  }
  const [updated] = await database
    .update(admittedAccounts)
    .set({ revokedAt: now, revokedByUserId })
    .where(eq(admittedAccounts.id, row.id))
    .returning();
  if (updated === undefined) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The admission could not be revoked.',
      409,
    );
  }
  return admittedAccountFromRow(updated);
}

export const listAdmittedAccountsRegistration: ServerCapabilityRegistration<
  'list-admitted-accounts',
  AdminCapabilityTransaction
> = {
  id: 'list-admitted-accounts',
  resolveFacilityId: (_input, context) => guard(context),
  handler: (input, context) =>
    listAdmittedAccounts(context.transaction.database, input),
};

export function executeListAdmittedAccountsCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'list-admitted-accounts'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<AdmittedAccountList> {
  return executeAdminQueryCapability(
    listAdmittedAccountsRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
}

function admissionReplayLoader(
  reference: string,
  context: Readonly<{ transaction: AdminCapabilityTransaction }>,
): Promise<AdmittedAccount> {
  return getAdmittedAccount(context.transaction.database, reference).then(
    (output) => {
      if (output === null) {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The admission is unavailable.',
          409,
        );
      }
      return output;
    },
  );
}

export const admitAccountRegistration: ServerCapabilityRegistration<
  'admit-account',
  AdminCapabilityTransaction
> = {
  id: 'admit-account',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const output = await admitAccount(
      context.transaction.database,
      input,
      humanActorUserId(context),
      context.invocation.serverTime,
    );
    // The hash-chained audit names the admission row, never the address.
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => output.id,
  loadReplay: admissionReplayLoader,
  resolveReplayFacilityId: () => Promise.resolve(null),
  replayFacilityId: () => null,
};

export const revokeAdmittedAccountRegistration: ServerCapabilityRegistration<
  'revoke-admitted-account',
  AdminCapabilityTransaction
> = {
  id: 'revoke-admitted-account',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const output = await revokeAdmittedAccount(
      context.transaction.database,
      input,
      humanActorUserId(context),
      context.invocation.serverTime,
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => output.id,
  loadReplay: admissionReplayLoader,
  resolveReplayFacilityId: () => Promise.resolve(null),
  replayFacilityId: () => null,
};

export const executeAdmitAccountCapability = (
  input: MutationExecution<CapabilityInput<'admit-account'>>,
) =>
  executeAdminMutationCapability(
    admitAccountRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeRevokeAdmittedAccountCapability = (
  input: MutationExecution<CapabilityInput<'revoke-admitted-account'>>,
) =>
  executeAdminMutationCapability(
    revokeAdmittedAccountRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
