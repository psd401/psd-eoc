import {
  SetUserFacilityScopeInputSchema,
  UserPageSchema,
  UserSchema,
  UuidSchema,
  type CapabilityInput,
  type Role,
  type User,
  type UserPage,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import {
  facilities,
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

async function projectUserPage(
  database: AdminQueryDatabase,
  rows: readonly (typeof users.$inferSelect)[],
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

  return Object.freeze(
    rows.map((row) =>
      UserSchema.parse({
        id: row.id,
        googleSubject: row.googleSubject,
        email: row.email,
        displayName: row.displayName,
        roles: projectEffectiveRoles(
          baseRolesByUserId.get(row.id) ?? [],
          roleChangesByUserId.get(row.id) ?? [],
        ),
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
  // signed in and therefore have no role. UserSchema intentionally requires at
  // least one role, so this administration surface lists access accounts only.
  const accessAccountUserIds = database
    .select({ userId: userRoles.userId })
    .from(userRoles);
  const rows = await database
    .select()
    .from(users)
    .where(
      and(
        input.includeDisabled ? undefined : isNull(users.disabledAt),
        afterUserId === null ? undefined : gt(users.id, afterUserId),
        inArray(users.id, accessAccountUserIds),
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
  const items = await projectUserPage(database, selected);
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
  handler: (input, context) => listUsers(context.transaction.database, input),
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
  const updated = await getUser(database, input.userId);
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
): Promise<User | null> {
  const [row] = await database
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) return null;
  const [projected] = await projectUserPage(database, [row]);
  return projected ?? null;
}

export const setUserFacilityScopeRegistration: ServerCapabilityRegistration<
  'set-user-facility-scope',
  AdminCapabilityTransaction
> = {
  id: 'set-user-facility-scope',
  resolveFacilityId: (_input, context) => guard(context),
  handler: (input, context) =>
    setUserFacilityScope(context.transaction.database, input),
  resultReference: (output) => output.id,
  async loadReplay(reference, context) {
    const output = await getUser(context.transaction.database, reference);
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
