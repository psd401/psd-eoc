import { createHash } from 'node:crypto';

import {
  DeviceEnrollmentPageSchema,
  DeviceEnrollmentSchema,
  EndpointStatusRecordSchema,
  PushTokenRegistrationReceiptSchema,
  PushTokenUnregistrationReceiptSchema,
  SecurityAuditEntrySchema,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type DeviceEnrollmentPage,
  type EndpointStatusRecord,
  type PushTokenRegistrationReceipt,
  type PushTokenUnregistrationReceipt,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  idempotencyRecords,
  rosterEndpoints,
  securityAuditChainAnchors,
  securityAuditEntries,
  sessionRevocations,
  sessions,
} from '../../db/schema';
import {
  buildSecurityAuditEntry,
  canonicalSecurityAuditJson,
  parseSecurityAuditFact,
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  securityAuditFactFromEntry,
  toSecurityAuditInsertValues,
} from '../audit';

import {
  CapabilityEngineError,
  executeCapability,
  readCapabilityTime,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';

/** The one worker identity accepted by the push endpoint-invalidation route. */
export const PUSH_ENDPOINT_INVALIDATION_SERVICE_ID =
  'push-endpoint-invalidation-worker' as const;

/** Provider-terminal reason retained without copying the rejected token. */
export const EXPO_DEVICE_NOT_REGISTERED_REASON =
  'EXPO_DEVICE_NOT_REGISTERED' as const;

/** Device-specific persistence added to the canonical capability transaction. */
export interface DeviceCapabilityTransaction
  extends CapabilityEngineTransaction {
  registerPushToken(
    input: CapabilityInput<'register-push-token'>,
    actor: Extract<Actor, { kind: 'human' }>,
    registeredAt: Date,
  ): Promise<PushTokenRegistrationReceipt>;
  unregisterPushToken(
    input: CapabilityInput<'unregister-push-token'>,
    actor: Extract<Actor, { kind: 'human' }>,
    unregisteredAt: Date,
  ): Promise<PushTokenUnregistrationReceipt>;
  listMyDevices(
    input: CapabilityInput<'list-my-devices'>,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<DeviceEnrollmentPage>;
  recordEndpointStatus(
    input: CapabilityInput<'record-endpoint-status'>,
    recordedAt: Date,
  ): Promise<EndpointStatusRecord>;
  loadPushTokenRegistrationReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<PushTokenRegistrationReceipt | null>;
  loadPushTokenUnregistrationReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<PushTokenUnregistrationReceipt | null>;
  loadEndpointStatusReplay(
    resultReference: string,
  ): Promise<EndpointStatusRecord | null>;
}

export type DeviceCapabilityStore =
  CapabilityEngineStore<DeviceCapabilityTransaction>;

type DeviceCapabilityId = Extract<
  RegisteredCapabilityId,
  | 'list-my-devices'
  | 'record-endpoint-status'
  | 'register-push-token'
  | 'unregister-push-token'
>;

function requireHuman(
  context: CapabilityHandlerContext<DeviceCapabilityTransaction>,
): Extract<Actor, { kind: 'human' }> {
  if (context.invocation.actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'This device capability requires an authenticated human.',
      403,
    );
  }
  return context.invocation.actor;
}

function replayUnavailable(): CapabilityEngineError {
  return new CapabilityEngineError(
    'INTERNAL_ERROR',
    'IDEMPOTENCY_RESULT_UNAVAILABLE',
    'The original device result is unavailable.',
    500,
  );
}

function requirePushInvalidationWorker(
  input: CapabilityInput<'record-endpoint-status'>,
  context: CapabilityHandlerContext<DeviceCapabilityTransaction>,
): void {
  const invocation = context.invocation;
  if (
    invocation.actor.kind !== 'system' ||
    invocation.actor.serviceId !== PUSH_ENDPOINT_INVALIDATION_SERVICE_ID ||
    invocation.source !== 'worker' ||
    invocation.mutation?.transport.kind !== 'worker-execution' ||
    input.status !== 'invalid' ||
    input.reasonCode !== EXPO_DEVICE_NOT_REGISTERED_REASON
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The endpoint-status invocation was not authorized.',
      403,
    );
  }
}

function registrationReference(output: PushTokenRegistrationReceipt): string {
  return `push-registration:${output.deviceEnrollmentId}:${output.platform}`;
}

function unregistrationReference(
  output: PushTokenUnregistrationReceipt,
): string {
  return `push-unregistration:${output.deviceEnrollmentId}`;
}

function endpointStatusReference(output: EndpointStatusRecord): string {
  return `endpoint-status:${output.id}`;
}

const registerPushTokenRegistration: ServerCapabilityRegistration<
  'register-push-token',
  DeviceCapabilityTransaction
> = {
  id: 'register-push-token',
  resolveFacilityId: () => null,
  async handler(input, context) {
    return context.transaction.registerPushToken(
      input,
      requireHuman(context),
      await readCapabilityTime(context),
    );
  },
  resultReference: registrationReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadPushTokenRegistrationReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const unregisterPushTokenRegistration: ServerCapabilityRegistration<
  'unregister-push-token',
  DeviceCapabilityTransaction
> = {
  id: 'unregister-push-token',
  resolveFacilityId: () => null,
  async handler(input, context) {
    return context.transaction.unregisterPushToken(
      input,
      requireHuman(context),
      await readCapabilityTime(context),
    );
  },
  resultReference: unregistrationReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadPushTokenUnregistrationReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const listMyDevicesRegistration: ServerCapabilityRegistration<
  'list-my-devices',
  DeviceCapabilityTransaction
> = {
  id: 'list-my-devices',
  resolveFacilityId: () => null,
  handler: (input, context) =>
    context.transaction.listMyDevices(input, requireHuman(context)),
};

const recordEndpointStatusRegistration: ServerCapabilityRegistration<
  'record-endpoint-status',
  DeviceCapabilityTransaction
> = {
  id: 'record-endpoint-status',
  resolveFacilityId: () => null,
  async handler(input, context) {
    requirePushInvalidationWorker(input, context);
    return context.transaction.recordEndpointStatus(
      input,
      await readCapabilityTime(context),
    );
  },
  resultReference: endpointStatusReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay =
      await context.transaction.loadEndpointStatusReplay(reference);
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const registrations = Object.freeze({
  'list-my-devices': listMyDevicesRegistration,
  'record-endpoint-status': recordEndpointStatusRegistration,
  'register-push-token': registerPushTokenRegistration,
  'unregister-push-token': unregisterPushTokenRegistration,
});

/** Executes a device capability through the canonical server engine. */
export function executeDeviceCapability<Id extends DeviceCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: DeviceCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, DeviceCapabilityTransaction>;
  return executeCapability(registration, input, invocation, store);
}

type DeviceQueryDatabase = DatabaseQuery;
type NativePlatform = 'ios' | 'android';

interface LockedNativeDevice {
  readonly id: string;
  readonly platform: NativePlatform;
}

function deviceQueryDatabase(database: unknown): DeviceQueryDatabase {
  // Both configured transports expose the shared schema-aware query surface.
  return database as DeviceQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw deviceConflict('Persisted device time was invalid.');
  }
  return date.toISOString();
}

function deviceConflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function deviceForbidden(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_INVOCATION_DENIED',
    'The current session cannot manage this device enrollment.',
    403,
  );
}

function deviceNotFound(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    message,
    404,
  );
}

function invalidCursor(): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'CAPABILITY_INPUT_INVALID',
    'The device pagination cursor is invalid.',
    400,
  );
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor();
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(decoded)) throw invalidCursor();
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset)) throw invalidCursor();
  return offset;
}

async function lockCurrentNativeDevice(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  actor: Extract<Actor, { kind: 'human' }>,
  expectedPlatform: NativePlatform | null,
): Promise<LockedNativeDevice> {
  const [row] = await database
    .select({
      id: deviceEnrollments.id,
      platform: deviceEnrollments.platform,
    })
    .from(deviceEnrollments)
    .innerJoin(
      sessions,
      and(
        eq(sessions.deviceEnrollmentId, deviceEnrollments.id),
        eq(sessions.userId, deviceEnrollments.userId),
      ),
    )
    .where(
      and(
        eq(deviceEnrollments.id, deviceEnrollmentId),
        eq(deviceEnrollments.userId, actor.userId),
        eq(sessions.id, actor.sessionId),
        isNull(deviceEnrollments.revokedAt),
        isNull(sessions.revokedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (
    row === undefined ||
    (row.platform !== 'ios' && row.platform !== 'android') ||
    (expectedPlatform !== null && row.platform !== expectedPlatform)
  ) {
    throw deviceForbidden();
  }
  const [revocation] = await database
    .select({ id: sessionRevocations.id })
    .from(sessionRevocations)
    .where(eq(sessionRevocations.sessionId, actor.sessionId))
    .limit(1);
  if (revocation !== undefined) {
    throw deviceForbidden();
  }
  return { id: row.id, platform: row.platform };
}

interface ActivePushRegistration {
  readonly id: string;
  readonly token: string;
  readonly registeredAt: Date | string;
}

const MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE = 100;
const PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE = 12_012;

function pushTokenLockDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Serializes one opaque token without exposing token material to lock telemetry. */
async function lockPushToken(
  database: DeviceQueryDatabase,
  token: string,
): Promise<void> {
  const digest = pushTokenLockDigest(token);
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${digest}, ${PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE}))`,
  );
}

async function assertPushTokenAvailableForDevice(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  token: string,
): Promise<void> {
  const [conflicting] = await database
    .select({ id: devicePushTokenRegistrations.id })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.token, token),
        ne(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .limit(1);
  if (conflicting !== undefined) {
    throw deviceConflict(
      'The push token is already bound to another device enrollment.',
    );
  }
}

async function assertPushTokenHasNoTerminalInvalidation(
  database: DeviceQueryDatabase,
  token: string,
): Promise<void> {
  const [terminal] = await database
    .select({ id: endpointStatusRecords.id })
    .from(endpointStatusRecords)
    .innerJoin(
      rosterEndpoints,
      and(
        eq(
          rosterEndpoints.rosterSnapshotId,
          endpointStatusRecords.rosterSnapshotId,
        ),
        eq(rosterEndpoints.recipientId, endpointStatusRecords.recipientId),
        eq(rosterEndpoints.id, endpointStatusRecords.endpointId),
        eq(rosterEndpoints.population, endpointStatusRecords.population),
        eq(rosterEndpoints.channel, endpointStatusRecords.channel),
      ),
    )
    .where(
      and(
        eq(rosterEndpoints.channel, 'push'),
        eq(rosterEndpoints.token, token),
        eq(endpointStatusRecords.status, 'invalid'),
        eq(endpointStatusRecords.reasonCode, EXPO_DEVICE_NOT_REGISTERED_REASON),
      ),
    )
    .limit(1);
  if (terminal !== undefined) {
    throw deviceConflict('The push token cannot be registered.');
  }
}

async function appendActivePushTokenUnregistrations(
  database: DeviceQueryDatabase,
  token: string,
  unregisteredAt: Date,
): Promise<void> {
  const registrations = await database
    .select({
      id: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.token, token),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .limit(MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE + 1);
  if (registrations.length > MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE) {
    throw deviceConflict(
      'The push token has too many active registrations to reconcile safely.',
    );
  }
  if (registrations.length === 0) return;
  await database
    .insert(devicePushTokenUnregistrations)
    .values(
      registrations.map((registration) => ({
        registrationId: registration.id,
        deviceEnrollmentId: registration.deviceEnrollmentId,
        unregisteredAt,
      })),
    )
    .onConflictDoNothing({
      target: devicePushTokenUnregistrations.registrationId,
    });
}

/**
 * Resolves semantic idempotency without returning or persisting token material.
 * Callers serialize this plan with the device-enrollment row lock.
 */
export function planPushTokenRegistration(
  activeRegistrations: readonly Readonly<{ id: string; token: string }>[],
  requestedToken: string,
): Readonly<{
  keepRegistrationId: string | null;
  registrationRequired: boolean;
  unregisterRegistrationIds: readonly string[];
}> {
  const matching = activeRegistrations.find(
    (registration) => registration.token === requestedToken,
  );
  return Object.freeze({
    keepRegistrationId: matching?.id ?? null,
    registrationRequired: matching === undefined,
    unregisterRegistrationIds: activeRegistrations
      .filter((registration) => registration.id !== matching?.id)
      .map((registration) => registration.id),
  });
}

async function activePushRegistrations(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
): Promise<readonly ActivePushRegistration[]> {
  const registrations = await database
    .select({
      id: devicePushTokenRegistrations.id,
      token: devicePushTokenRegistrations.token,
      registeredAt: devicePushTokenRegistrations.registeredAt,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .orderBy(
      desc(devicePushTokenRegistrations.registeredAt),
      desc(devicePushTokenRegistrations.id),
    )
    .limit(MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE + 1);
  if (registrations.length > MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE) {
    throw deviceConflict(
      'The device has too many active push registrations to reconcile safely.',
    );
  }
  return registrations;
}

async function appendPushUnregistrations(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  registrationIds: readonly string[],
  unregisteredAt: Date,
): Promise<void> {
  if (registrationIds.length === 0) return;
  await database
    .insert(devicePushTokenUnregistrations)
    .values(
      registrationIds.map((registrationId) => ({
        registrationId,
        deviceEnrollmentId,
        unregisteredAt,
      })),
    )
    .onConflictDoNothing({
      target: devicePushTokenUnregistrations.registrationId,
    });
}

async function registerPushTokenWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'register-push-token'>,
  actor: Extract<Actor, { kind: 'human' }>,
  registeredAt: Date,
): Promise<PushTokenRegistrationReceipt> {
  const device = await lockCurrentNativeDevice(
    database,
    input.deviceEnrollmentId,
    actor,
    input.platform,
  );
  await lockPushToken(database, input.token);
  await assertPushTokenHasNoTerminalInvalidation(database, input.token);
  await assertPushTokenAvailableForDevice(database, device.id, input.token);
  const active = await activePushRegistrations(database, device.id);
  const plan = planPushTokenRegistration(active, input.token);
  await appendPushUnregistrations(
    database,
    device.id,
    plan.unregisterRegistrationIds,
    registeredAt,
  );
  if (plan.registrationRequired) {
    await database.insert(devicePushTokenRegistrations).values({
      deviceEnrollmentId: device.id,
      platform: device.platform,
      token: input.token,
      registeredAt,
    });
  }
  return PushTokenRegistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    platform: device.platform,
    status: 'registered',
  });
}

async function unregisterPushTokenWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'unregister-push-token'>,
  actor: Extract<Actor, { kind: 'human' }>,
  unregisteredAt: Date,
): Promise<PushTokenUnregistrationReceipt> {
  const device = await lockCurrentNativeDevice(
    database,
    input.deviceEnrollmentId,
    actor,
    null,
  );
  const active = await activePushRegistrations(database, device.id);
  await appendPushUnregistrations(
    database,
    device.id,
    active.map((registration) => registration.id),
    unregisteredAt,
  );
  return PushTokenUnregistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    status: 'unregistered',
  });
}

async function listMyDevicesWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'list-my-devices'>,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<DeviceEnrollmentPage> {
  const offset = decodeCursor(input.cursor);
  const rows = await database
    .select()
    .from(deviceEnrollments)
    .where(
      input.includeRevoked
        ? eq(deviceEnrollments.userId, actor.userId)
        : and(
            eq(deviceEnrollments.userId, actor.userId),
            isNull(deviceEnrollments.revokedAt),
          ),
    )
    .orderBy(asc(deviceEnrollments.id))
    .offset(offset)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit).map((row) =>
    DeviceEnrollmentSchema.parse({
      id: row.id,
      userId: row.userId,
      platform: row.platform,
      unlockMethod: row.unlockMethod,
      installationId: row.installationId,
      enrolledAt: dateIso(row.enrolledAt),
      lastSeenAt: dateIso(row.lastSeenAt),
      revokedAt: row.revokedAt === null ? null : dateIso(row.revokedAt),
    }),
  );
  const nextOffset = offset + items.length;
  return DeviceEnrollmentPageSchema.parse({
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeCursor(nextOffset) : null,
    },
  });
}

function endpointStatusFromRow(
  row: typeof endpointStatusRecords.$inferSelect,
): EndpointStatusRecord {
  return EndpointStatusRecordSchema.parse({
    id: row.id,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    status: row.status,
    reasonCode: row.reasonCode,
    recordedAt: dateIso(row.recordedAt),
  });
}

async function recordEndpointStatusWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'record-endpoint-status'>,
  recordedAt: Date,
): Promise<EndpointStatusRecord> {
  const [endpoint] = await database
    .select()
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
        eq(rosterEndpoints.recipientId, input.recipientId),
        eq(rosterEndpoints.id, input.endpointId),
      ),
    )
    .for('update')
    .limit(1);
  if (endpoint === undefined) {
    throw deviceNotFound('The snapshotted endpoint was not found.');
  }
  if (
    endpoint.channel !== 'push' ||
    endpoint.platform === null ||
    endpoint.token === null
  ) {
    throw deviceConflict('The endpoint is not a push registration.');
  }

  const [registration] = await database
    .select()
    .from(devicePushTokenRegistrations)
    .where(eq(devicePushTokenRegistrations.id, endpoint.id))
    .limit(1);
  if (registration !== undefined && endpoint.population === 'staff') {
    if (
      registration.platform !== endpoint.platform ||
      registration.token !== endpoint.token
    ) {
      throw deviceConflict(
        'The snapshotted endpoint no longer matches its registration.',
      );
    }
    const [lockedDevice] = await database
      .select({ id: deviceEnrollments.id })
      .from(deviceEnrollments)
      .where(eq(deviceEnrollments.id, registration.deviceEnrollmentId))
      .for('update')
      .limit(1);
    if (lockedDevice === undefined) {
      throw deviceConflict('The push registration device could not be locked.');
    }
  }

  await lockPushToken(database, endpoint.token);
  await appendActivePushTokenUnregistrations(
    database,
    endpoint.token,
    recordedAt,
  );

  const [existing] = await database
    .select()
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, input.rosterSnapshotId),
        eq(endpointStatusRecords.recipientId, input.recipientId),
        eq(endpointStatusRecords.endpointId, input.endpointId),
        eq(endpointStatusRecords.status, input.status),
        eq(endpointStatusRecords.reasonCode, input.reasonCode),
      ),
    )
    .orderBy(
      asc(endpointStatusRecords.recordedAt),
      asc(endpointStatusRecords.id),
    )
    .limit(1);
  if (existing !== undefined) return endpointStatusFromRow(existing);

  const [inserted] = await database
    .insert(endpointStatusRecords)
    .values({
      rosterSnapshotId: endpoint.rosterSnapshotId,
      recipientId: endpoint.recipientId,
      endpointId: endpoint.id,
      population: endpoint.population,
      channel: endpoint.channel,
      status: input.status,
      reasonCode: input.reasonCode,
      recordedAt,
    })
    .returning();
  if (inserted === undefined) {
    throw deviceConflict('Endpoint status evidence could not be appended.');
  }
  return endpointStatusFromRow(inserted);
}

function parseRegistrationReference(reference: string): {
  readonly deviceEnrollmentId: string;
  readonly platform: NativePlatform;
} | null {
  const match =
    /^push-registration:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(ios|android)$/u.exec(
      reference,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    deviceEnrollmentId: match[1],
    platform: match[2] as NativePlatform,
  };
}

function parseUnregistrationReference(
  reference: string,
): { readonly deviceEnrollmentId: string } | null {
  const match =
    /^push-unregistration:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      reference,
    );
  return match?.[1] === undefined ? null : { deviceEnrollmentId: match[1] };
}

function parseEndpointStatusReference(reference: string): string | null {
  const match =
    /^endpoint-status:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      reference,
    );
  return match?.[1] ?? null;
}

async function loadPushTokenRegistrationReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<PushTokenRegistrationReceipt | null> {
  const parsed = parseRegistrationReference(reference);
  if (parsed === null) return null;
  const device = await lockCurrentNativeDevice(
    database,
    parsed.deviceEnrollmentId,
    actor,
    parsed.platform,
  );
  return PushTokenRegistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    platform: device.platform,
    status: 'registered',
  });
}

async function loadPushTokenUnregistrationReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<PushTokenUnregistrationReceipt | null> {
  const parsed = parseUnregistrationReference(reference);
  if (parsed === null) return null;
  const device = await lockCurrentNativeDevice(
    database,
    parsed.deviceEnrollmentId,
    actor,
    null,
  );
  return PushTokenUnregistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    status: 'unregistered',
  });
}

async function loadEndpointStatusReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
): Promise<EndpointStatusRecord | null> {
  const id = parseEndpointStatusReference(reference);
  if (id === null) return null;
  const [row] = await database
    .select()
    .from(endpointStatusRecords)
    .where(eq(endpointStatusRecords.id, id))
    .limit(1);
  return row === undefined ? null : endpointStatusFromRow(row);
}

async function readDatabaseTime(database: DeviceQueryDatabase): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw deviceConflict('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function claimIdempotency(
  database: DeviceQueryDatabase,
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  const [inserted] = await database
    .insert(idempotencyRecords)
    .values({
      capabilityId: input.capabilityId,
      principal: input.actor,
      principalDigest: input.principalDigest,
      key: input.key,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.capabilityId,
        idempotencyRecords.principalDigest,
        idempotencyRecords.key,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  if (inserted !== undefined) {
    return { kind: 'new', recordId: inserted.id };
  }
  const [existing] = await database
    .select({
      requestDigest: idempotencyRecords.requestDigest,
      status: idempotencyRecords.status,
      resultReference: idempotencyRecords.resultReference,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.capabilityId, input.capabilityId),
        eq(idempotencyRecords.principalDigest, input.principalDigest),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .for('update')
    .limit(1);
  if (existing === undefined) {
    throw deviceConflict('The device request replay could not be resolved.');
  }
  if (existing.status === 'completed' && existing.resultReference !== null) {
    return {
      kind: 'completed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  if (existing.status === 'failed' && existing.resultReference !== null) {
    return {
      kind: 'failed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  return { kind: 'in-progress', requestDigest: existing.requestDigest };
}

async function completeIdempotency(
  database: DeviceQueryDatabase,
  input: CompleteIdempotencyInput,
): Promise<void> {
  const [updated] = await database
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: input.completedAt,
      resultReference: input.resultReference,
    })
    .where(
      and(
        eq(idempotencyRecords.id, input.recordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (updated === undefined) {
    throw deviceConflict('The device request replay could not be completed.');
  }
}

function securityAuditEntryFromRow(
  row: typeof securityAuditEntries.$inferSelect,
) {
  return SecurityAuditEntrySchema.parse({
    id: row.id,
    sequence: row.sequence,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    category: row.category,
    action: row.action,
    actionIds: row.actionIds,
    confirmationId: row.confirmationId,
    outcome: row.outcome,
    principal: row.principal,
    source: row.source,
    facilityId: row.facilityId,
    target:
      row.targetKind === null || row.targetId === null
        ? null
        : { kind: row.targetKind, id: row.targetId },
    requestId: row.requestId,
    reasonCode: row.reasonCode,
    occurredAt: dateIso(row.occurredAt),
  });
}

async function appendCapabilityAuditEntry(
  database: DeviceQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  const fact = parseSecurityAuditFact({
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability', id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  });
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [existingRow] = await database
    .select()
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, fact.requestId))
    .limit(1)
    .for('share');
  if (existingRow !== undefined) {
    const existing = securityAuditEntryFromRow(existingRow);
    if (
      canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
      canonicalSecurityAuditJson(fact)
    ) {
      return;
    }
    throw deviceConflict(
      'The audit request is already bound to different evidence.',
    );
  }
  const [anchor] = await database
    .select({
      sequence: securityAuditChainAnchors.sequence,
      entryHash: securityAuditChainAnchors.entryHash,
    })
    .from(securityAuditChainAnchors)
    .orderBy(desc(securityAuditChainAnchors.sequence))
    .limit(1)
    .for('share');
  const entry = buildSecurityAuditEntry(
    fact,
    anchor === undefined ? null : anchor,
  );
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}

function createDrizzleDeviceTransaction(
  database: DeviceQueryDatabase,
): DeviceCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    // Device capabilities have no human-confirmation policy by contract.
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    registerPushToken: (input, actor, registeredAt) =>
      registerPushTokenWithDatabase(database, input, actor, registeredAt),
    unregisterPushToken: (input, actor, unregisteredAt) =>
      unregisterPushTokenWithDatabase(database, input, actor, unregisteredAt),
    listMyDevices: (input, actor) =>
      listMyDevicesWithDatabase(database, input, actor),
    recordEndpointStatus: (input, recordedAt) =>
      recordEndpointStatusWithDatabase(database, input, recordedAt),
    loadPushTokenRegistrationReplay: (reference, actor) =>
      loadPushTokenRegistrationReplayFromDatabase(database, reference, actor),
    loadPushTokenUnregistrationReplay: (reference, actor) =>
      loadPushTokenUnregistrationReplayFromDatabase(database, reference, actor),
    loadEndpointStatusReplay: (reference) =>
      loadEndpointStatusReplayFromDatabase(database, reference),
  };
}

/** Creates the production one-transaction device capability persistence. */
export function createDrizzleDeviceCapabilityStore(
  database: Database,
): DeviceCapabilityStore {
  return {
    transaction<Result>(
      operation: (transaction: DeviceCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleDeviceTransaction(deviceQueryDatabase(transaction)),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendCapabilityAuditEntry(deviceQueryDatabase(transaction), event),
      );
    },
  };
}

/** Runtime shared by authenticated device routes and the push worker route. */
export interface DeviceCapabilityRuntime {
  readonly store: DeviceCapabilityStore;
  execute<Id extends DeviceCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

/** Builds a device capability runtime around one managed DB connection. */
export function createDeviceCapabilityRuntime(
  connection: DatabaseConnection,
): DeviceCapabilityRuntime {
  const store = createDrizzleDeviceCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeDeviceCapability(capabilityId, input, invocation, store),
    close: () => connection.close(),
  };
}

let defaultDeviceCapabilityRuntime: DeviceCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by device REST routes. */
export function getDefaultDeviceCapabilityRuntime(): DeviceCapabilityRuntime {
  defaultDeviceCapabilityRuntime ??= createDeviceCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultDeviceCapabilityRuntime;
}

/** Closes and clears the lazily created default device runtime. */
export async function closeDefaultDeviceCapabilityRuntime(): Promise<void> {
  const runtime = defaultDeviceCapabilityRuntime;
  defaultDeviceCapabilityRuntime = undefined;
  await runtime?.close();
}
