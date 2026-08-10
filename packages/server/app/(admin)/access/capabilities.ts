import {
  SetUserRolesInputSchema,
  UserPageSchema,
  UserSchema,
  UuidSchema,
  type Actor,
  type CapabilityInput,
  type User,
  type UserPage,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  userFacilityScopes,
  userRoleChanges,
  userRoles,
  users,
} from '../../../db/schema';
import {
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
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

function decodeOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^\d+$/u.test(value)) throw new TypeError();
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError();
    return offset;
  } catch {
    throw invalid('The user pagination cursor is invalid.');
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
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

async function listUsers(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-users'>,
): Promise<UserPage> {
  const offset = decodeOffset(input.cursor);
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
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        input.includeDisabled ? undefined : isNull(users.disabledAt),
        inArray(users.id, accessAccountUserIds),
        facilityUserIds === null
          ? undefined
          : or(
              eq(users.facilityScopeKind, 'district'),
              inArray(users.id, facilityUserIds),
            ),
      ),
    )
    .orderBy(asc(users.displayName), asc(users.id))
    .offset(offset)
    .limit(input.limit + 1);
  const selected = rows.slice(0, input.limit);
  const items: User[] = [];
  for (const { id } of selected) {
    const user = await loadUser(database, id);
    if (user === null) {
      throw conflict('A listed user could not be reloaded.');
    }
    items.push(user);
  }
  const hasMore = rows.length > input.limit;
  return UserPageSchema.parse({
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeOffset(offset + input.limit) : null,
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
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-effective-admin-role', 0))`,
  );
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
  const effectiveAdministratorIds =
    await loadEffectiveAdministratorUserIds(database);
  if (!effectiveAdministratorIds.includes(actor.userId)) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'The administrator role changed before this request could commit.',
      403,
    );
  }
  if (
    current.roles.includes('admin') &&
    !input.roles.includes('admin') &&
    effectiveAdministratorIds.includes(input.userId) &&
    effectiveAdministratorIds.length <= 1
  ) {
    throw conflict('The final effective administrator cannot be removed.');
  }
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
