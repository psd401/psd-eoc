import {
  SetUserRolesInputSchema,
  UserPageSchema,
  UserSchema,
  UuidSchema,
  type Actor,
  type CapabilityInput,
  type Role,
  type User,
  type UserPage,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import {
  userFacilityScopes,
  userRoleChanges,
  userRoles,
  users,
} from '../../../db/schema';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadAccessConfigurationSnapshotState,
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
  projectEffectiveRoles,
  type RoleChangeFact,
} from '../../../lib/auth/role-state';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  digestCapabilityValue,
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminMutationMetadata,
  type AdminQueryDatabase,
  type AdminQueryMetadata,
} from '../facilities/admin-core';

function invalid(message: string): AdminCapabilityError {
  return new AdminCapabilityError('VALIDATION_ERROR', message, 400);
}

function notFound(message: string): AdminCapabilityError {
  return new AdminCapabilityError('NOT_FOUND', message, 404);
}

function conflict(message: string): AdminCapabilityError {
  return new AdminCapabilityError('CONFLICT', message, 409);
}

function userResultReference(user: User): string {
  return Buffer.from(
    JSON.stringify({
      id: user.id,
      outputDigest: digestCapabilityValue(user),
    }),
    'utf8',
  ).toString('base64url');
}

function parseUserResultReference(value: string): Readonly<{
  id: string;
  outputDigest: string;
}> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) throw new TypeError();
    const outputDigest = Reflect.get(parsed, 'outputDigest');
    if (
      typeof outputDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(outputDigest)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      id: UuidSchema.parse(Reflect.get(parsed, 'id')),
      outputDigest,
    });
  } catch {
    throw conflict('The role-assignment replay reference is invalid.');
  }
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

async function loadUser(
  database: AdminQueryDatabase,
  userId: string,
): Promise<User | null> {
  const [row] = await database
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row === undefined) return null;
  // Aurora Data API rejects concurrent statements that share a transaction
  // ID, so every read on this capability transaction is deliberately serial.
  const roles = await loadEffectiveRoles(database, userId);
  const facilityRows = await database
    .select({ facilityId: userFacilityScopes.facilityId })
    .from(userFacilityScopes)
    .where(eq(userFacilityScopes.userId, userId))
    .orderBy(asc(userFacilityScopes.facilityId));
  return UserSchema.parse({
    id: row.id,
    googleSubject: row.googleSubject,
    email: row.email,
    displayName: row.displayName,
    roles,
    facilityScope:
      row.facilityScopeKind === 'district'
        ? { kind: 'district' }
        : {
            kind: 'facilities',
            facilityIds: facilityRows.map(({ facilityId }) => facilityId),
          },
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  });
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

async function setUserRoles(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'set-user-roles'>,
  actor: Actor,
  requestId: string,
  readOccurredAt: () => Promise<Date>,
): Promise<User> {
  const input = SetUserRolesInputSchema.parse(inputValue);
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  const accessState = await loadAccessConfigurationSnapshotState(database);
  if (accessState === null) {
    throw conflict(
      'Roles cannot be changed until the latest access snapshot exactly matches the active access groups.',
    );
  }
  const [lockedUser] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for('update');
  if (lockedUser === undefined)
    throw notFound('The staff account was not found.');
  const current = await loadUser(database, input.userId);
  if (current === null) throw notFound('The staff account was not found.');
  if (current.disabledAt !== null) {
    throw conflict('Roles cannot be changed for a disabled account.');
  }
  if (actor.kind !== 'human') {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'A human administrator is required to change roles.',
      403,
    );
  }
  const effectiveAdministratorIds = await loadEffectiveAdministratorUserIds(
    database,
    { accessState },
  );
  assertReachableAdministratorTransition({
    actorUserId: actor.userId,
    targetUserId: input.userId,
    currentRoles: current.roles,
    requestedRoles: input.roles,
    reachableAdministratorUserIds: effectiveAdministratorIds,
  });
  const removedRoles = current.roles.filter(
    (role) => !input.roles.includes(role),
  );
  const addedRoles = input.roles.filter(
    (role) => !current.roles.includes(role),
  );
  const changes = [
    ...removedRoles.map((role) => ({ role, granted: false })),
    ...addedRoles.map((role) => ({ role, granted: true })),
  ];
  if (changes.length > 0) {
    const occurredAt = await readOccurredAt();
    await database.insert(userRoleChanges).values(
      changes.map(({ role, granted }) => ({
        userId: input.userId,
        role,
        granted,
        changedByUserId: actor.userId,
        changedWithSessionId: actor.sessionId,
        requestId,
        occurredAt,
      })),
    );
  }
  const updated = await loadUser(database, input.userId);
  if (updated === null)
    throw conflict('The updated user could not be reloaded.');
  return updated;
}

/** Applies the role-transition invariants after one exact locked DB projection. */
export function assertReachableAdministratorTransition(
  input: Readonly<{
    actorUserId: string;
    targetUserId: string;
    currentRoles: readonly Role[];
    requestedRoles: readonly Role[];
    reachableAdministratorUserIds: readonly string[];
  }>,
): void {
  if (!input.reachableAdministratorUserIds.includes(input.actorUserId)) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'The administrator role or access membership changed before this request could commit.',
      403,
    );
  }
  if (
    input.currentRoles.includes('admin') &&
    !input.requestedRoles.includes('admin') &&
    input.reachableAdministratorUserIds.includes(input.targetUserId) &&
    input.reachableAdministratorUserIds.length <= 1
  ) {
    throw conflict('The final reachable administrator cannot be removed.');
  }
}

export const listUsersRegistration: ServerCapabilityRegistration<
  'list-users',
  AdminCapabilityTransaction
> = {
  id: 'list-users',
  resolveFacilityId: (_input, context) => guard(context),
  handler: (input, context) => listUsers(context.transaction.database, input),
};

export const setUserRolesRegistration: ServerCapabilityRegistration<
  'set-user-roles',
  AdminCapabilityTransaction
> = {
  id: 'set-user-roles',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    return setUserRoles(
      context.transaction.database,
      input,
      context.invocation.actor,
      context.invocation.requestId,
      () => readCapabilityTime(context),
    );
  },
  resultReference: userResultReference,
  async loadReplay(reference, context) {
    const parsed = parseUserResultReference(reference);
    const user = await loadUser(context.transaction.database, parsed.id);
    if (user === null)
      throw notFound('The previous role result is unavailable.');
    if (digestCapabilityValue(user) !== parsed.outputDigest) {
      throw conflict(
        'The original role-assignment result is no longer reconstructable; replay was refused rather than returning changed data.',
      );
    }
    return user;
  },
  resolveReplayFacilityId: (_reference, context) => guard(context),
  replayFacilityId: () => null,
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

export function executeSetUserRolesCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'set-user-roles'>;
  readonly metadata: AdminMutationMetadata;
  readonly store?: AdminCapabilityStore;
}): Promise<User> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminMutationCapability(
    setUserRolesRegistration,
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}
