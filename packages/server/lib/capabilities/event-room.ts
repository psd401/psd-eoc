import {
  EventIdSchema,
  EventRoomHeaderSchema,
  EventRoomSyncResultSchema,
  EventSchema,
  JournalEntrySchema,
  PaginationCursorSchema,
  projectJournalEntryForRead,
  type CapabilityInput,
  type CapabilityOutput,
  type Event,
  type EventRoomHeader,
  type EventRoomSyncResult,
  type HumanConfirmationRecord,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';

import {
  authorDisplayNameForRow,
  resolveAuthorDisplayNames,
} from './journal-author-names';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
  type PostgresDatabase,
} from '../../db/client';
import {
  events,
  eventTypeVersions,
  facilities,
  journalEntries,
} from '../../db/schema';
import { createDrizzleSecurityAuditRepository } from '../audit/drizzle-repository';
import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import { activationThreatFromColumns } from './start-preview';

const EVENT_ROOM_CURSOR_VERSION = 1;
const EVENT_CACHE_KEY = 'event-room:event';

/** Shared transaction posture for both configured Drizzle PostgreSQL drivers. */
export const EVENT_ROOM_TRANSACTION_CONFIG = Object.freeze({
  isolationLevel: 'repeatable read' as const,
  accessMode: 'read only' as const,
});

interface EventRoomCursorPayload {
  readonly v: typeof EVENT_ROOM_CURSOR_VERSION;
  readonly e: string;
  readonly s: number;
}

function invalidCursor(): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'PERSISTENCE_CONFLICT',
    'The event-room cursor is invalid for this event.',
    400,
  );
}

function notFound(): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    'The event was not found.',
    404,
  );
}

function persistenceConflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

/** Creates the opaque, versioned cursor for one exact event journal head. */
export function createEventRoomCursor(
  eventIdValue: string,
  afterSequence: number,
): string {
  const eventId = EventIdSchema.parse(eventIdValue);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw invalidCursor();
  }
  return PaginationCursorSchema.parse(
    Buffer.from(
      JSON.stringify({
        v: EVENT_ROOM_CURSOR_VERSION,
        e: eventId,
        s: afterSequence,
      } satisfies EventRoomCursorPayload),
      'utf8',
    ).toString('base64url'),
  );
}

/** Decodes only the current canonical cursor version bound to one event. */
export function readEventRoomCursorSequence(
  cursor: string | null,
  expectedEventIdValue: string,
): number {
  const expectedEventId = EventIdSchema.parse(expectedEventIdValue);
  if (cursor === null) return 0;
  try {
    const parsedCursor = PaginationCursorSchema.parse(cursor);
    const decodedText = Buffer.from(parsedCursor, 'base64url').toString('utf8');
    if (
      Buffer.from(decodedText, 'utf8').toString('base64url') !== parsedCursor
    ) {
      throw invalidCursor();
    }
    const value: unknown = JSON.parse(decodedText);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.get(value, 'v') !== EVENT_ROOM_CURSOR_VERSION ||
      Reflect.get(value, 'e') !== expectedEventId ||
      !Number.isSafeInteger(Reflect.get(value, 's')) ||
      Number(Reflect.get(value, 's')) < 0 ||
      Object.keys(value).sort().join(',') !== 'e,s,v'
    ) {
      throw invalidCursor();
    }
    return Number(Reflect.get(value, 's'));
  } catch (error) {
    if (error instanceof CapabilityEngineError) throw error;
    throw invalidCursor();
  }
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function eventFromRow(row: typeof events.$inferSelect): Event {
  return EventSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    status: row.status,
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    threat: activationThreatFromColumns(row),
    responseDetail: row.responseDetail ?? null,
    createdBy: row.createdBy,
    createdAt: dateIso(row.createdAt),
    activatedAt: row.activatedAt === null ? null : dateIso(row.activatedAt),
    allClearAt: row.allClearAt === null ? null : dateIso(row.allClearAt),
    reactivatedAt:
      row.reactivatedAt === null ? null : dateIso(row.reactivatedAt),
    closedAt: row.closedAt === null ? null : dateIso(row.closedAt),
    correctionOfEventId: row.correctionOfEventId,
    correctionReason: row.correctionReason,
    activationAuthorization: row.activationAuthorization,
  });
}

function journalFromRow(
  row: typeof journalEntries.$inferSelect,
  authorDisplayName: string | null = null,
) {
  return JournalEntrySchema.parse({
    id: row.id,
    eventId: row.eventId,
    sequence: row.sequence,
    kind: row.kind,
    author: row.author,
    authorDisplayName,
    source: row.source,
    serverTime: dateIso(row.serverTime),
    clientTime: row.clientTime === null ? null : dateIso(row.clientTime),
    payload: row.payload,
    supersedes:
      row.supersedesEntryId === null
        ? null
        : {
            entryId: row.supersedesEntryId,
            entrySequence: row.supersedesEntrySequence,
            kind: row.supersessionKind,
            reason: row.supersessionReason,
          },
  });
}

// Drizzle's schema-aware select builders normalize results for both the
// postgres-js and AWS Data API transports. No driver-specific execute result
// shape is used through this shared read surface.
type EventRoomQueryDatabase = PostgresDatabase;

function eventRoomQueryDatabase(database: unknown): EventRoomQueryDatabase {
  return database as EventRoomQueryDatabase;
}

async function readEvent(
  database: EventRoomQueryDatabase,
  eventId: string,
): Promise<Event | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row === undefined ? null : eventFromRow(row);
}

async function readEventRoomHeader(
  database: EventRoomQueryDatabase,
  event: Event,
): Promise<EventRoomHeader> {
  // Keep these reads sequential: the AWS Data API rejects concurrent
  // statements carrying one transaction ID. Both reads remain inside the
  // repeatable-read transaction that owns the event and journal snapshot.
  const [facility] = await database
    .select({
      id: facilities.id,
      code: facilities.code,
      name: facilities.name,
    })
    .from(facilities)
    .where(eq(facilities.id, event.facilityId))
    .limit(1);
  const [eventType] = await database
    .select({
      id: eventTypeVersions.id,
      name: eventTypeVersions.name,
      templateMode: eventTypeVersions.templateMode,
    })
    .from(eventTypeVersions)
    .where(eq(eventTypeVersions.id, event.eventTypeVersion.id))
    .limit(1);
  if (
    facility === undefined ||
    eventType === undefined ||
    eventType.templateMode !== event.templateMode
  ) {
    throw persistenceConflict(
      'The event-room heading does not match its pinned event configuration.',
    );
  }
  // The threat and any typed descriptions were pinned on the event at
  // activation; they need no second lookup and never change afterwards.
  return EventRoomHeaderSchema.parse({
    facility,
    eventType,
    threat: event.threat,
    responseDetail: event.responseDetail,
  });
}

interface EventRoomDescriptor {
  readonly event: Event;
  readonly header: EventRoomHeader;
}

async function readEventRoomDescriptor(
  database: EventRoomQueryDatabase,
  eventId: string,
): Promise<EventRoomDescriptor | null> {
  const event = await readEvent(database, eventId);
  if (event === null) return null;
  return {
    event,
    header: await readEventRoomHeader(database, event),
  };
}

async function syncEventRoom(
  database: EventRoomQueryDatabase,
  input: CapabilityInput<'sync-event-room'>,
  descriptor: EventRoomDescriptor,
): Promise<EventRoomSyncResult> {
  const { event, header } = descriptor;
  const afterSequence = readEventRoomCursorSequence(
    input.cursor,
    input.eventId,
  );
  const [head] = await database
    .select({ sequence: journalEntries.sequence })
    .from(journalEntries)
    .where(eq(journalEntries.eventId, input.eventId))
    .orderBy(desc(journalEntries.sequence))
    .limit(1);
  const snapshotSequence = head?.sequence ?? 0;
  if (afterSequence > snapshotSequence) throw invalidCursor();

  const rows = await database
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.eventId, input.eventId),
        gt(journalEntries.sequence, afterSequence),
        lte(journalEntries.sequence, snapshotSequence),
      ),
    )
    .orderBy(asc(journalEntries.sequence))
    .limit(input.limit + 1);
  let expectedSequence = afterSequence + 1;
  for (const row of rows) {
    if (row.sequence !== expectedSequence) {
      throw persistenceConflict(
        'The event journal is not contiguous from the supplied cursor.',
      );
    }
    expectedSequence += 1;
  }
  const hasMore = rows.length > input.limit;
  const visibleRows = rows.slice(0, input.limit);
  const visibleIds = visibleRows.map((row) => row.id);
  const redactionTargets =
    visibleIds.length === 0
      ? []
      : await database
          .select({ entryId: journalEntries.supersedesEntryId })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.eventId, input.eventId),
              eq(journalEntries.supersessionKind, 'redaction'),
              inArray(journalEntries.supersedesEntryId, visibleIds),
            ),
          );
  const redactedIds = new Set(
    redactionTargets.flatMap(({ entryId }) =>
      entryId === null ? [] : [entryId],
    ),
  );
  const authorNames = await resolveAuthorDisplayNames(database, visibleRows);
  const entries = visibleRows.map((row) =>
    projectJournalEntryForRead(
      journalFromRow(row, authorDisplayNameForRow(row, authorNames)),
      redactedIds.has(row.id),
    ),
  );
  if (afterSequence < snapshotSequence && entries.length === 0) {
    throw persistenceConflict(
      'The event journal cannot make progress from the supplied cursor.',
    );
  }
  const returnedSequence = entries.at(-1)?.entry.sequence ?? afterSequence;
  const includeEvent =
    input.cursor === null || (!hasMore && entries.length > 0);
  return EventRoomSyncResultSchema.parse({
    eventId: input.eventId,
    header,
    event: includeEvent ? event : null,
    entries,
    cursor: createEventRoomCursor(input.eventId, returnedSequence),
    hasMore,
    snapshotSequence,
  });
}

/** Read-only transaction surface needed by the canonical room sync. */
export interface EventRoomCapabilityTransaction extends CapabilityEngineTransaction {
  beforeSync(): Promise<void>;
  getEventRoomDescriptor(eventId: string): Promise<EventRoomDescriptor | null>;
  syncEventRoom(
    input: CapabilityInput<'sync-event-room'>,
    descriptor: EventRoomDescriptor,
  ): Promise<EventRoomSyncResult>;
}

function readOnlyMutation(): never {
  throw new CapabilityEngineError(
    'INTERNAL_ERROR',
    'PERSISTENCE_CONFLICT',
    'The event-room read transaction cannot mutate persistence.',
    500,
  );
}

function createEventRoomTransaction(
  database: EventRoomQueryDatabase,
  beforeSync: () => Promise<void>,
): EventRoomCapabilityTransaction {
  return {
    readCurrentTime: async (requestReceivedAt) => requestReceivedAt,
    claimIdempotency: async (): Promise<IdempotencyClaim> => readOnlyMutation(),
    completeIdempotency: async (): Promise<void> => readOnlyMutation(),
    getHumanConfirmation: async (): Promise<HumanConfirmationRecord | null> =>
      null,
    consumeHumanConfirmation: async (): Promise<boolean> => readOnlyMutation(),
    appendCapabilityAudit: async (): Promise<void> => readOnlyMutation(),
    beforeSync,
    getEventRoomDescriptor: (eventId) =>
      readEventRoomDescriptor(database, eventId),
    syncEventRoom: (input, descriptor) =>
      syncEventRoom(database, input, descriptor),
  };
}

async function cachedDescriptor(
  input: CapabilityInput<'sync-event-room'>,
  context: Parameters<
    ServerCapabilityRegistration<
      'sync-event-room',
      EventRoomCapabilityTransaction
    >['handler']
  >[1],
): Promise<EventRoomDescriptor> {
  const cached = context.cache.get(EVENT_CACHE_KEY);
  if (cached !== undefined) {
    const descriptor = cached as EventRoomDescriptor;
    return {
      event: EventSchema.parse(descriptor.event),
      header: EventRoomHeaderSchema.parse(descriptor.header),
    };
  }
  const descriptor = await context.transaction.getEventRoomDescriptor(
    input.eventId,
  );
  if (descriptor === null) throw notFound();
  context.cache.set(EVENT_CACHE_KEY, descriptor);
  return descriptor;
}

export const syncEventRoomRegistration: ServerCapabilityRegistration<
  'sync-event-room',
  EventRoomCapabilityTransaction
> = {
  id: 'sync-event-room',
  async resolveFacilityId(input, context) {
    return (await cachedDescriptor(input, context)).event.facilityId;
  },
  async handler(input, context) {
    const descriptor = await cachedDescriptor(input, context);
    await context.transaction.beforeSync();
    return context.transaction.syncEventRoom(input, descriptor);
  },
};

/** Store used by the canonical event-room capability engine execution. */
export type EventRoomCapabilityStore =
  CapabilityEngineStore<EventRoomCapabilityTransaction>;

function capabilityAuditFact(event: CapabilityAuditEvent) {
  return {
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability' as const, id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function createEventRoomCapabilityStore(
  connection: DatabaseConnection,
  options: EventRoomCapabilityRuntimeOptions,
): EventRoomCapabilityStore {
  const auditRepository = createDrizzleSecurityAuditRepository(connection.db);
  const beforeSync =
    options.afterAuthorizedEventRead ?? (() => Promise.resolve());
  return {
    transaction<Result>(
      operation: (
        transaction: EventRoomCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      switch (connection.driver) {
        case 'postgres':
          return connection.db.transaction(
            (transaction) =>
              operation(
                createEventRoomTransaction(
                  eventRoomQueryDatabase(transaction),
                  beforeSync,
                ),
              ),
            EVENT_ROOM_TRANSACTION_CONFIG,
          );
        case 'aws-data-api':
          return connection.db.transaction(
            (transaction) =>
              operation(
                createEventRoomTransaction(
                  eventRoomQueryDatabase(transaction),
                  beforeSync,
                ),
              ),
            EVENT_ROOM_TRANSACTION_CONFIG,
          );
      }
    },
    async appendCapabilityAudit(event) {
      await auditRepository.append(capabilityAuditFact(event));
    },
  };
}

/** Executes the sole event-room sync through the shared capability engine. */
export function executeEventRoomCapability(
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: EventRoomCapabilityStore,
): Promise<CapabilityOutput<'sync-event-room'>> {
  return executeAuditedCapabilityTransaction(
    syncEventRoomRegistration,
    input,
    invocation,
    store,
  );
}

/** Managed runtime shared by the server-rendered page and polling route. */
export interface EventRoomCapabilityRuntime {
  readonly store: EventRoomCapabilityStore;
  execute(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<'sync-event-room'>>;
  close(): Promise<void>;
}

/** Optional deterministic observation point used only by concurrency tests. */
export interface EventRoomCapabilityRuntimeOptions {
  readonly afterAuthorizedEventRead?: () => Promise<void>;
}

/** Builds an event-room runtime around an explicit database connection. */
export function createEventRoomCapabilityRuntime(
  connection: DatabaseConnection,
  options: EventRoomCapabilityRuntimeOptions = {},
): EventRoomCapabilityRuntime {
  const store = createEventRoomCapabilityStore(connection, options);
  return Object.freeze({
    store,
    execute: (input: unknown, invocation: TrustedCapabilityInvocation) =>
      executeEventRoomCapability(input, invocation, store),
    close: () => connection.close(),
  });
}

let defaultRuntime: EventRoomCapabilityRuntime | undefined;

/** Lazily creates the production event-room runtime. */
export function getDefaultEventRoomCapabilityRuntime(): EventRoomCapabilityRuntime {
  defaultRuntime ??= createEventRoomCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultRuntime;
}

/** Closes and clears the default runtime for tests and process lifecycle hooks. */
export async function resetDefaultEventRoomCapabilityRuntime(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = undefined;
  await runtime?.close();
}
