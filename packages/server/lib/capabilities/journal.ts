import { randomUUID } from 'node:crypto';

import {
  ACTIVATION_PREVIEW_MAX_AGE_SECONDS,
  ActivationPreviewSchema,
  EventSchema,
  FacilitySchema,
  HUMAN_CONFIRMATION_MAX_AGE_SECONDS,
  HumanConfirmationRecordSchema,
  IntegrationStatusSchema,
  JournalEntryPageSchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  MessageTemplateSetSchema,
  PaginationCursorSchema,
  SecurityAuditEntrySchema,
  UuidSchema,
  type ActivationPreview,
  type CapabilityInput,
  type CapabilityOutput,
  type Event,
  type Facility,
  type HumanConfirmationRecord,
  type JournalEntry,
  type JournalEntryPage,
  type LifecycleConsequencePreview,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type PostgresDatabase,
} from '../../db/client';
import {
  activationPreviews,
  channelConfigurations,
  events,
  eventTypeTemplates,
  eventTypeVersions,
  facilities,
  humanConfirmationActions,
  humanConfirmationRecords,
  idempotencyRecords,
  integrationStatuses,
  journalEntries,
  lifecycleConsequencePreviews,
  securityAuditChainAnchors,
  securityAuditEntries,
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
  digestCapabilityValue,
  executeCapability,
  readCapabilityTime,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import type { AuthenticatedSession } from '../auth/sessions';
import { renderTemplateSet } from '../notify/render';
import { deriveCloseConsequenceDigest } from './events';

/** Event state and the next append position held under the event-row lock. */
export interface LockedJournalEvent {
  readonly event: Event;
  readonly nextSequence: number;
}

/** Journal-specific persistence added to the central capability transaction. */
export interface JournalCapabilityTransaction
  extends CapabilityEngineTransaction {
  resolveEventFacilityId(eventId: string): Promise<string | null>;
  lockEventForJournal(eventId: string): Promise<LockedJournalEvent | null>;
  getJournalEntry(
    eventId: string,
    entryId: string,
    sequence: number | null,
  ): Promise<JournalEntry | null>;
  appendJournalEntry(entry: JournalEntry): Promise<void>;
  listJournalEntries(
    input: CapabilityInput<'list-journal-entries'>,
  ): Promise<JournalEntryPage>;
  getFacility(facilityId: string): Promise<Facility | null>;
  createLifecycleConsequencePreview(
    input: CapabilityInput<'create-lifecycle-consequence-preview'>,
  ): Promise<LifecycleConsequencePreview>;
  resolveJournalReplayFacilityId(
    resultReference: string,
  ): Promise<string | null>;
  loadJournalReplay(resultReference: string): Promise<JournalEntry | null>;
}

/** Atomic store used by web, REST, MCP, and tests for journal capabilities. */
export type JournalCapabilityStore =
  CapabilityEngineStore<JournalCapabilityTransaction>;

/** Canonical capability IDs implemented by this module. */
export type JournalCapabilityId = Extract<
  RegisteredCapabilityId,
  | 'append-journal-entry'
  | 'correct-journal-entry'
  | 'redact-journal-entry'
  | 'list-journal-entries'
  | 'create-lifecycle-consequence-preview'
  | 'get-facility'
>;

const EVENT_FACILITY_CACHE_PREFIX = 'journal:event-facility:';
const LOCKED_EVENT_CACHE_PREFIX = 'journal:locked-event:';
const JOURNAL_CURSOR_VERSION = 1;

function notFound(message = 'The event was not found.'): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    message,
    404,
  );
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function invalid(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'PERSISTENCE_CONFLICT',
    message,
    400,
  );
}

function unavailable(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'LIVE_ACTION_UNAVAILABLE',
    'PERSISTENCE_CONFLICT',
    message,
    503,
    true,
  );
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

function facilityFromRow(row: typeof facilities.$inferSelect): Facility {
  return FacilitySchema.parse({
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    createdAt: dateIso(row.createdAt),
  });
}

function activationPreviewFromRow(
  row: typeof activationPreviews.$inferSelect,
): ActivationPreview {
  return ActivationPreviewSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    activeEventIds: row.activeEventIds,
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

function integrationStatusFromRow(
  row: typeof integrationStatuses.$inferSelect,
) {
  return IntegrationStatusSchema.parse({
    integrationId: row.integrationId,
    label: row.label,
    verifiedAt: row.verifiedAt === null ? null : dateIso(row.verifiedAt),
    verifiedByUserId: row.verifiedByUserId,
    authorizationReference: row.authorizationReference,
    reasonCode: row.reasonCode,
    observedAt: dateIso(row.observedAt),
  });
}

function lifecyclePreviewFromRow(
  row: typeof lifecycleConsequencePreviews.$inferSelect,
): LifecycleConsequencePreview {
  return LifecycleConsequencePreviewSchema.parse({
    id: row.id,
    eventId: row.eventId,
    purpose: row.purpose,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

function journalFromRow(row: typeof journalEntries.$inferSelect): JournalEntry {
  return JournalEntrySchema.parse({
    id: row.id,
    eventId: row.eventId,
    sequence: row.sequence,
    kind: row.kind,
    author: row.author,
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

function journalInsertValues(
  entry: JournalEntry,
): typeof journalEntries.$inferInsert {
  const transitionId =
    entry.kind === 'system' && 'transition' in entry.payload
      ? entry.payload.transition.id
      : null;
  return {
    id: entry.id,
    eventId: entry.eventId,
    sequence: entry.sequence,
    kind: entry.kind,
    author: entry.author,
    source: entry.source,
    serverTime: new Date(entry.serverTime),
    clientTime: entry.clientTime === null ? null : new Date(entry.clientTime),
    payload: entry.payload,
    mediaId: entry.kind === 'photo' ? entry.payload.mediaId : null,
    transitionId,
    supersedesEntryId: entry.supersedes?.entryId ?? null,
    supersedesEntrySequence: entry.supersedes?.entrySequence ?? null,
    supersessionKind: entry.supersedes?.kind ?? null,
    supersessionReason: entry.supersedes?.reason ?? null,
  };
}

interface JournalCursorPayload {
  readonly v: 1;
  readonly e: string;
  readonly s: number;
}

/**
 * Creates an opaque event-bound resume token after an observed sequence.
 * Unlike pageInfo.nextCursor, this remains useful at the live edge for polling.
 */
export function createJournalCursor(
  eventIdValue: string,
  afterSequence: number,
): string {
  const eventId = UuidSchema.parse(eventIdValue);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw invalid('The journal cursor sequence is invalid.');
  }
  return PaginationCursorSchema.parse(
    Buffer.from(
      JSON.stringify({
        v: JOURNAL_CURSOR_VERSION,
        e: eventId,
        s: afterSequence,
      } satisfies JournalCursorPayload),
      'utf8',
    ).toString('base64url'),
  );
}

function decodeJournalCursor(cursor: string | null, eventId: string): number {
  if (cursor === null) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(PaginationCursorSchema.parse(cursor), 'base64url').toString(
        'utf8',
      ),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Reflect.get(parsed, 'v') !== JOURNAL_CURSOR_VERSION ||
      Reflect.get(parsed, 'e') !== eventId ||
      !Number.isSafeInteger(Reflect.get(parsed, 's')) ||
      Number(Reflect.get(parsed, 's')) < 0 ||
      Object.keys(parsed).sort().join(',') !== 'e,s,v'
    ) {
      throw new TypeError('invalid cursor');
    }
    return Number(Reflect.get(parsed, 's'));
  } catch {
    throw invalid('The journal cursor is invalid for this event.');
  }
}

interface JournalResultReference {
  readonly v: 1;
  readonly k: 'journal';
  readonly e: string;
  readonly f: string;
  readonly j: string;
}

// This bridge exists because the shared engine's final replay check is
// synchronous while facility resolution is database-backed. The bound is
// above the product's 1,200-user ceiling and entries are normally removed as
// soon as their matching replay check consumes them.
const JOURNAL_REPLAY_EVIDENCE_LIMIT = 2_048;
interface JournalReplayFacilityEvidence {
  readonly facilityId: string;
  readonly pendingConsumers: number;
}

const journalReplayFacilityEvidence = new Map<
  string,
  JournalReplayFacilityEvidence
>();

function rememberJournalReplayFacility(entryId: string, facilityId: string) {
  const existing = journalReplayFacilityEvidence.get(entryId);
  if (existing !== undefined && existing.facilityId !== facilityId) {
    throw conflict('The journal replay facility evidence is inconsistent.');
  }
  journalReplayFacilityEvidence.delete(entryId);
  journalReplayFacilityEvidence.set(entryId, {
    facilityId,
    pendingConsumers: (existing?.pendingConsumers ?? 0) + 1,
  });
  while (journalReplayFacilityEvidence.size > JOURNAL_REPLAY_EVIDENCE_LIMIT) {
    const oldest = journalReplayFacilityEvidence.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) {
      break;
    }
    journalReplayFacilityEvidence.delete(oldest);
  }
}

function journalResultReference(
  entry: JournalEntry,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): string {
  const facilityId = context.resolvedFacilityId;
  if (facilityId === null) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'The journal result facility was not resolved.',
      500,
    );
  }
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'journal',
      e: entry.eventId,
      f: UuidSchema.parse(facilityId),
      j: entry.id,
    } satisfies JournalResultReference),
    'utf8',
  ).toString('base64url');
}

function parseJournalResultReference(
  value: string,
): JournalResultReference | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Reflect.get(parsed, 'v') !== 1 ||
      Reflect.get(parsed, 'k') !== 'journal' ||
      !UuidSchema.safeParse(Reflect.get(parsed, 'e')).success ||
      !UuidSchema.safeParse(Reflect.get(parsed, 'f')).success ||
      !UuidSchema.safeParse(Reflect.get(parsed, 'j')).success ||
      Object.keys(parsed).sort().join(',') !== 'e,f,j,k,v'
    ) {
      return null;
    }
    return {
      v: 1,
      k: 'journal',
      e: String(Reflect.get(parsed, 'e')),
      f: String(Reflect.get(parsed, 'f')),
      j: String(Reflect.get(parsed, 'j')),
    };
  } catch {
    return null;
  }
}

async function eventFacilityId(
  eventId: string,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): Promise<string> {
  const cacheKey = `${EVENT_FACILITY_CACHE_PREFIX}${eventId}`;
  const cached = context.cache.get(cacheKey);
  if (typeof cached === 'string') {
    return cached;
  }
  const facilityId = await context.transaction.resolveEventFacilityId(eventId);
  if (facilityId === null) {
    throw notFound();
  }
  context.cache.set(cacheKey, facilityId);
  return facilityId;
}

async function lockedJournalEvent(
  eventId: string,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): Promise<LockedJournalEvent> {
  const cacheKey = `${LOCKED_EVENT_CACHE_PREFIX}${eventId}`;
  const cached = context.cache.get(cacheKey);
  if (cached !== undefined) {
    return cached as LockedJournalEvent;
  }
  const locked = await context.transaction.lockEventForJournal(eventId);
  if (locked === null) {
    throw notFound();
  }
  context.cache.set(cacheKey, locked);
  return locked;
}

function assertJournalWriteState(
  event: Event,
  capabilityId:
    | 'append-journal-entry'
    | 'correct-journal-entry'
    | 'redact-journal-entry',
): void {
  if (event.status === 'draft') {
    throw conflict('Journal posts require an activated event.');
  }
  if (capabilityId === 'append-journal-entry' && event.status === 'closed') {
    throw conflict('A closed event cannot receive ordinary journal posts.');
  }
}

async function buildJournalEntry(
  capabilityId:
    | 'append-journal-entry'
    | 'correct-journal-entry'
    | 'redact-journal-entry',
  input:
    | CapabilityInput<'append-journal-entry'>
    | CapabilityInput<'correct-journal-entry'>
    | CapabilityInput<'redact-journal-entry'>,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): Promise<JournalEntry> {
  const locked = await lockedJournalEvent(input.eventId, context);
  assertJournalWriteState(locked.event, capabilityId);

  if (input.supersedes !== null) {
    const target = await context.transaction.getJournalEntry(
      input.eventId,
      input.supersedes.entryId,
      input.supersedes.entrySequence,
    );
    if (target === null) {
      throw conflict(
        'The superseded journal entry does not belong to this event and sequence.',
      );
    }
    if (target.kind === 'system') {
      throw conflict('System lifecycle journal facts cannot be superseded.');
    }
  }

  // Read after acquiring the event lock. Sequence is the total order; this
  // timestamp records authoritative server receipt rather than client clocks.
  const serverTime = await readCapabilityTime(context);
  const entry = JournalEntrySchema.parse({
    id: randomUUID(),
    eventId: input.eventId,
    sequence: locked.nextSequence,
    author: context.invocation.actor,
    source: context.invocation.source,
    serverTime: serverTime.toISOString(),
    clientTime: input.clientTime,
    supersedes: input.supersedes,
    kind: input.kind,
    payload: input.payload,
  });
  await context.transaction.appendJournalEntry(entry);
  return entry;
}

async function replayFacilityId(
  reference: string,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): Promise<string> {
  const referenceValue = parseJournalResultReference(reference);
  const facilityId =
    await context.transaction.resolveJournalReplayFacilityId(reference);
  if (
    referenceValue === null ||
    facilityId === null ||
    referenceValue.f !== facilityId
  ) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'The original journal result facility is unavailable.',
      500,
    );
  }
  rememberJournalReplayFacility(referenceValue.j, facilityId);
  return facilityId;
}

function consumeJournalReplayFacility(entry: JournalEntry): string | null {
  const evidence = journalReplayFacilityEvidence.get(entry.id);
  if (evidence === undefined) {
    return null;
  }
  if (evidence.pendingConsumers <= 1) {
    journalReplayFacilityEvidence.delete(entry.id);
  } else {
    journalReplayFacilityEvidence.set(entry.id, {
      facilityId: evidence.facilityId,
      pendingConsumers: evidence.pendingConsumers - 1,
    });
  }
  return evidence.facilityId;
}

async function loadJournalReplay(
  reference: string,
  context: CapabilityHandlerContext<JournalCapabilityTransaction>,
): Promise<JournalEntry> {
  const entry = await context.transaction.loadJournalReplay(reference);
  if (entry === null) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'The original journal result is unavailable.',
      500,
    );
  }
  return JournalEntrySchema.parse(entry);
}

export const appendJournalEntryRegistration: ServerCapabilityRegistration<
  'append-journal-entry',
  JournalCapabilityTransaction
> = {
  id: 'append-journal-entry',
  resolveFacilityId: (input, context) =>
    eventFacilityId(input.eventId, context),
  handler: (input, context) =>
    buildJournalEntry('append-journal-entry', input, context),
  resultReference: journalResultReference,
  loadReplay: loadJournalReplay,
  resolveReplayFacilityId: replayFacilityId,
  replayFacilityId: consumeJournalReplayFacility,
};

export const correctJournalEntryRegistration: ServerCapabilityRegistration<
  'correct-journal-entry',
  JournalCapabilityTransaction
> = {
  id: 'correct-journal-entry',
  resolveFacilityId: (input, context) =>
    eventFacilityId(input.eventId, context),
  handler: (input, context) =>
    buildJournalEntry('correct-journal-entry', input, context),
  resultReference: journalResultReference,
  loadReplay: loadJournalReplay,
  resolveReplayFacilityId: replayFacilityId,
  replayFacilityId: consumeJournalReplayFacility,
};

export const redactJournalEntryRegistration: ServerCapabilityRegistration<
  'redact-journal-entry',
  JournalCapabilityTransaction
> = {
  id: 'redact-journal-entry',
  resolveFacilityId: (input, context) =>
    eventFacilityId(input.eventId, context),
  handler: (input, context) =>
    buildJournalEntry('redact-journal-entry', input, context),
  resultReference: journalResultReference,
  loadReplay: loadJournalReplay,
  resolveReplayFacilityId: replayFacilityId,
  replayFacilityId: consumeJournalReplayFacility,
};

export const listJournalEntriesRegistration: ServerCapabilityRegistration<
  'list-journal-entries',
  JournalCapabilityTransaction
> = {
  id: 'list-journal-entries',
  resolveFacilityId: (input, context) =>
    eventFacilityId(input.eventId, context),
  async handler(input, context): Promise<JournalEntryPage> {
    return JournalEntryPageSchema.parse(
      await context.transaction.listJournalEntries(input),
    );
  },
};

export const createLifecycleConsequencePreviewRegistration: ServerCapabilityRegistration<
  'create-lifecycle-consequence-preview',
  JournalCapabilityTransaction
> = {
  id: 'create-lifecycle-consequence-preview',
  resolveFacilityId: (input, context) =>
    eventFacilityId(input.eventId, context),
  async handler(input, context): Promise<LifecycleConsequencePreview> {
    return LifecycleConsequencePreviewSchema.parse(
      await context.transaction.createLifecycleConsequencePreview(input),
    );
  },
};

export const getFacilityRegistration: ServerCapabilityRegistration<
  'get-facility',
  JournalCapabilityTransaction
> = {
  id: 'get-facility',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context): Promise<Facility> {
    const facility = await context.transaction.getFacility(input.facilityId);
    if (facility === null) {
      throw notFound('The facility was not found.');
    }
    return FacilitySchema.parse(facility);
  },
};

const registrations = Object.freeze({
  'append-journal-entry': appendJournalEntryRegistration,
  'correct-journal-entry': correctJournalEntryRegistration,
  'redact-journal-entry': redactJournalEntryRegistration,
  'list-journal-entries': listJournalEntriesRegistration,
  'create-lifecycle-consequence-preview':
    createLifecycleConsequencePreviewRegistration,
  'get-facility': getFacilityRegistration,
});

/** Executes a journal capability through the canonical server engine. */
export async function executeJournalCapability<Id extends JournalCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: JournalCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, JournalCapabilityTransaction>;
  return executeCapability(registration, input, invocation, store);
}

type JournalQueryDatabase = PostgresDatabase;

function journalQueryDatabase(database: unknown): JournalQueryDatabase {
  // Both configured Drizzle transports expose this common query surface.
  return database as JournalQueryDatabase;
}

async function readDatabaseTime(database: JournalQueryDatabase): Promise<Date> {
  const [row] = await database.execute<{ value: Date | string }>(
    sql`select clock_timestamp() as value`,
  );
  if (row === undefined) {
    throw conflict('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function claimIdempotency(
  database: JournalQueryDatabase,
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
    throw conflict('The idempotency reservation could not be resolved.');
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
  database: JournalQueryDatabase,
  input: CompleteIdempotencyInput,
): Promise<void> {
  const [completed] = await database
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
  if (completed === undefined) {
    throw conflict('The idempotency result could not be completed.');
  }
}

async function getHumanConfirmation(
  database: JournalQueryDatabase,
  confirmationId: string,
): Promise<HumanConfirmationRecord | null> {
  const [row] = await database
    .select()
    .from(humanConfirmationRecords)
    .where(eq(humanConfirmationRecords.id, confirmationId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const actions = await database
    .select({ actionId: humanConfirmationActions.actionId })
    .from(humanConfirmationActions)
    .where(eq(humanConfirmationActions.confirmationId, confirmationId))
    .orderBy(asc(humanConfirmationActions.actionId));
  return HumanConfirmationRecordSchema.parse({
    confirmation: {
      id: row.id,
      capabilityId: row.capabilityId,
      actionIds: actions.map((action) => action.actionId),
      connectivityEpochId: row.connectivityEpochId,
      confirmedByUserId: row.confirmedByUserId,
      confirmedWithSessionId: row.confirmedWithSessionId,
      consequenceDigest: row.consequenceDigest,
      issuedAt: dateIso(row.issuedAt),
      expiresAt: dateIso(row.expiresAt),
    },
    status: row.status,
    consumedAt: row.consumedAt === null ? null : dateIso(row.consumedAt),
    consumedForRequestId: row.consumedForRequestId,
    expiredAt: row.expiredAt === null ? null : dateIso(row.expiredAt),
  });
}

async function consumeHumanConfirmation(
  database: JournalQueryDatabase,
  input: ConsumeHumanConfirmationInput,
): Promise<boolean> {
  const [consumed] = await database
    .update(humanConfirmationRecords)
    .set({
      status: 'consumed',
      consumedAt: sql`clock_timestamp()`,
      consumedForRequestId: input.requestId,
    })
    .where(
      and(
        eq(humanConfirmationRecords.id, input.confirmationId),
        eq(humanConfirmationRecords.status, 'issued'),
        sql`${humanConfirmationRecords.issuedAt} <= clock_timestamp()`,
        sql`${humanConfirmationRecords.expiresAt} >= clock_timestamp()`,
      ),
    )
    .returning({ id: humanConfirmationRecords.id });
  return consumed !== undefined;
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
  database: JournalQueryDatabase,
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
    throw conflict('The audit request is already bound to different evidence.');
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

async function resolveEventFacilityIdFromDatabase(
  database: JournalQueryDatabase,
  eventId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ facilityId: events.facilityId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.facilityId ?? null;
}

async function lockEventForJournalFromDatabase(
  database: JournalQueryDatabase,
  eventId: string,
): Promise<LockedJournalEvent | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for('update')
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const [sequence] = await database
    .select({
      value: sql<number>`coalesce(max(${journalEntries.sequence}), 0)`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.eventId, eventId));
  return {
    event: eventFromRow(row),
    nextSequence: Number(sequence?.value ?? 0) + 1,
  };
}

async function getJournalEntryFromDatabase(
  database: JournalQueryDatabase,
  eventId: string,
  entryId: string,
  sequence: number | null,
): Promise<JournalEntry | null> {
  const conditions = [
    eq(journalEntries.eventId, eventId),
    eq(journalEntries.id, entryId),
  ];
  if (sequence !== null) {
    conditions.push(eq(journalEntries.sequence, sequence));
  }
  const [row] = await database
    .select()
    .from(journalEntries)
    .where(and(...conditions))
    .limit(1);
  return row === undefined ? null : journalFromRow(row);
}

async function listJournalEntriesFromDatabase(
  database: JournalQueryDatabase,
  input: CapabilityInput<'list-journal-entries'>,
): Promise<JournalEntryPage> {
  const afterSequence = decodeJournalCursor(input.cursor, input.eventId);
  const rows = await database
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.eventId, input.eventId),
        gt(journalEntries.sequence, afterSequence),
      ),
    )
    .orderBy(asc(journalEntries.sequence))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const visible = rows.slice(0, input.limit).map(journalFromRow);
  const last = visible.at(-1);
  return JournalEntryPageSchema.parse({
    items: visible,
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? createJournalCursor(input.eventId, last.sequence)
          : null,
    },
  });
}

const INTEGRATION_BY_CHANNEL = Object.freeze({
  push: 'expo-push',
  email: 'ses-email',
  sms: 'aws-eum-sms',
});

async function getFacilityFromDatabase(
  database: JournalQueryDatabase,
  facilityId: string,
): Promise<Facility | null> {
  const [row] = await database
    .select()
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  return row === undefined ? null : facilityFromRow(row);
}

async function createLifecycleConsequencePreviewFromDatabase(
  database: JournalQueryDatabase,
  input: CapabilityInput<'create-lifecycle-consequence-preview'>,
): Promise<LifecycleConsequencePreview> {
  const [eventRow] = await database
    .select()
    .from(events)
    .where(eq(events.id, input.eventId))
    .for('share')
    .limit(1);
  if (eventRow === undefined) {
    throw notFound();
  }
  const event = eventFromRow(eventRow);
  const requiredStatus = input.purpose === 'all-clear' ? 'active' : 'all-clear';
  if (event.status !== requiredStatus) {
    throw conflict(
      `An ${input.purpose} preview cannot be created from the current event state.`,
    );
  }
  if (
    event.rosterSnapshotId === null ||
    event.rosterPopulation === null ||
    event.activatedAt === null ||
    event.activationAuthorization === null
  ) {
    throw conflict('The activated event is missing pinned notification truth.');
  }

  const [sourceRow] = await database
    .select()
    .from(activationPreviews)
    .where(
      eq(
        activationPreviews.id,
        event.activationAuthorization.activationPreviewId,
      ),
    )
    .for('share')
    .limit(1);
  if (sourceRow === undefined) {
    throw conflict('The event activation consequence preview is unavailable.');
  }
  const source = activationPreviewFromRow(sourceRow);
  if (
    source.facilityId !== event.facilityId ||
    source.kind !== event.kind ||
    source.templateMode !== event.templateMode ||
    source.eventTypeVersion.id !== event.eventTypeVersion.id ||
    source.rosterSnapshotId !== event.rosterSnapshotId ||
    source.rosterPopulation !== event.rosterPopulation
  ) {
    throw conflict(
      'The event no longer matches its activation consequence truth.',
    );
  }

  const [facilityRow, versionRow, templateRows] = await Promise.all([
    database
      .select()
      .from(facilities)
      .where(eq(facilities.id, event.facilityId))
      .limit(1)
      .then((rows) => rows[0]),
    database
      .select()
      .from(eventTypeVersions)
      .where(eq(eventTypeVersions.id, event.eventTypeVersion.id))
      .limit(1)
      .then((rows) => rows[0]),
    database
      .select()
      .from(eventTypeTemplates)
      .where(
        and(
          eq(eventTypeTemplates.eventTypeVersionId, event.eventTypeVersion.id),
          eq(eventTypeTemplates.purpose, input.purpose),
        ),
      ),
  ]);
  if (
    facilityRow === undefined ||
    versionRow === undefined ||
    versionRow.templateMode !== event.templateMode
  ) {
    throw conflict(
      'The event configuration needed for preview is unavailable.',
    );
  }

  const rowFor = (channel: 'push' | 'email' | 'sms') => {
    const matching = templateRows.filter((row) => row.channel === channel);
    if (matching.length !== 1 || matching[0] === undefined) {
      throw conflict('The lifecycle message templates are incomplete.');
    }
    return matching[0];
  };
  const push = rowFor('push');
  const email = rowFor('email');
  const sms = rowFor('sms');
  if (
    push.title === null ||
    push.body === null ||
    email.subject === null ||
    email.textBody === null ||
    sms.body === null
  ) {
    throw conflict('The lifecycle message templates are incomplete.');
  }
  const templates = MessageTemplateSetSchema.parse({
    templateMode: event.templateMode,
    purpose: input.purpose,
    push: {
      channel: 'push',
      templateMode: push.templateMode,
      purpose: push.purpose,
      classificationMarker: push.classificationMarker,
      title: push.title,
      body: push.body,
    },
    email: {
      channel: 'email',
      templateMode: email.templateMode,
      purpose: email.purpose,
      classificationMarker: email.classificationMarker,
      subject: email.subject,
      textBody: email.textBody,
    },
    sms: {
      channel: 'sms',
      templateMode: sms.templateMode,
      purpose: sms.purpose,
      classificationMarker: sms.classificationMarker,
      body: sms.body,
    },
  });
  const rendered = renderTemplateSet({
    eventKind: event.kind,
    templates,
    variables: {
      site: facilityRow.name,
      eventType: versionRow.name,
      startTime: event.activatedAt,
      initiator: 'Recorded initiator',
    },
  });

  const integrationIds = source.channels.map(
    (channel) => INTEGRATION_BY_CHANNEL[channel.channel],
  );
  const configurationRows = await database
    .select({
      enabled: channelConfigurations.enabled,
      status: integrationStatuses,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(inArray(channelConfigurations.integrationId, integrationIds));

  const blockingReasonCodes = new Set<string>();
  if (source.recipientCount === 0) {
    blockingReasonCodes.add('NO_RECIPIENTS');
  }
  const expectedIntegrationLabel =
    event.rosterPopulation === 'staff' ? 'live-verified' : 'mocked';
  const channels = source.channels.map((sourceChannel) => {
    const integrationId = INTEGRATION_BY_CHANNEL[sourceChannel.channel];
    const configuration = configurationRows.find(
      (row) => row.status.integrationId === integrationId,
    );
    if (configuration === undefined) {
      throw unavailable(
        `The ${sourceChannel.channel} integration is not configured.`,
      );
    }
    const channelCode = sourceChannel.channel.toUpperCase();
    if (!configuration.enabled) {
      blockingReasonCodes.add(`${channelCode}_CHANNEL_DISABLED`);
    }
    if (configuration.status.label !== expectedIntegrationLabel) {
      blockingReasonCodes.add(`${channelCode}_INTEGRATION_NOT_READY`);
    }
    if (
      (sourceChannel.channel === 'push' || sourceChannel.channel === 'email') &&
      sourceChannel.endpointCount === 0
    ) {
      blockingReasonCodes.add(`NO_${channelCode}_ENDPOINTS`);
    }
    const renderedMessage = rendered.find(
      (message) => message.channel === sourceChannel.channel,
    );
    if (renderedMessage === undefined) {
      throw conflict('The lifecycle message renderer omitted a channel.');
    }
    return {
      channel: sourceChannel.channel,
      endpointCount: sourceChannel.endpointCount,
      renderedMessage,
      integrationStatus: integrationStatusFromRow(configuration.status),
    };
  });

  const createdAt = await readDatabaseTime(database);
  const expiresAt = new Date(
    createdAt.getTime() + ACTIVATION_PREVIEW_MAX_AGE_SECONDS * 1_000,
  );
  const id = randomUUID();
  const sortedBlockingReasonCodes = [...blockingReasonCodes].sort();
  const sendReadiness =
    sortedBlockingReasonCodes.length === 0 ? 'ready' : 'blocked';
  const consequenceDigest = digestCapabilityValue({
    version: 1,
    capabilityId:
      input.purpose === 'all-clear' ? 'all-clear-event' : 'reactivate-event',
    id,
    eventId: event.id,
    eventStatus: event.status,
    activatedAt: event.activatedAt,
    allClearAt: event.allClearAt,
    reactivatedAt: event.reactivatedAt,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersion: event.eventTypeVersion,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    audienceConfig: source.audienceConfig,
    recipientCount: source.recipientCount,
    channels,
    sendReadiness,
    blockingReasonCodes: sortedBlockingReasonCodes,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const preview = LifecycleConsequencePreviewSchema.parse({
    id,
    eventId: event.id,
    purpose: input.purpose,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersion: event.eventTypeVersion,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    audienceConfig: source.audienceConfig,
    recipientCount: source.recipientCount,
    channels,
    sendReadiness,
    blockingReasonCodes: sortedBlockingReasonCodes,
    consequenceDigest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  await database.insert(lifecycleConsequencePreviews).values({
    id: preview.id,
    eventId: preview.eventId,
    purpose: preview.purpose,
    kind: preview.kind,
    templateMode: preview.templateMode,
    eventTypeVersionId: preview.eventTypeVersion.id,
    rosterSnapshotId: preview.rosterSnapshotId,
    rosterPopulation: preview.rosterPopulation,
    audienceConfigId: preview.audienceConfig.id,
    audienceConfigVersion: preview.audienceConfig.version,
    recipientCount: preview.recipientCount,
    channels: preview.channels,
    sendReadiness: preview.sendReadiness,
    blockingReasonCodes: preview.blockingReasonCodes,
    consequenceDigest: preview.consequenceDigest,
    createdAt,
    expiresAt,
  });
  return preview;
}

async function resolveJournalReplayFacilityIdFromDatabase(
  database: JournalQueryDatabase,
  resultReference: string,
): Promise<string | null> {
  const reference = parseJournalResultReference(resultReference);
  if (reference === null) {
    return null;
  }
  return resolveEventFacilityIdFromDatabase(database, reference.e);
}

async function loadJournalReplayFromDatabase(
  database: JournalQueryDatabase,
  resultReference: string,
): Promise<JournalEntry | null> {
  const reference = parseJournalResultReference(resultReference);
  if (reference === null) {
    return null;
  }
  return getJournalEntryFromDatabase(database, reference.e, reference.j, null);
}

function createDrizzleJournalTransaction(
  database: JournalQueryDatabase,
): JournalCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: (id) => getHumanConfirmation(database, id),
    consumeHumanConfirmation: (input) =>
      consumeHumanConfirmation(database, input),
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    resolveEventFacilityId: (eventId) =>
      resolveEventFacilityIdFromDatabase(database, eventId),
    lockEventForJournal: (eventId) =>
      lockEventForJournalFromDatabase(database, eventId),
    getJournalEntry: (eventId, entryId, sequence) =>
      getJournalEntryFromDatabase(database, eventId, entryId, sequence),
    async appendJournalEntry(entry) {
      await database.insert(journalEntries).values(journalInsertValues(entry));
    },
    listJournalEntries: (input) =>
      listJournalEntriesFromDatabase(database, input),
    getFacility: (facilityId) => getFacilityFromDatabase(database, facilityId),
    createLifecycleConsequencePreview: (input) =>
      createLifecycleConsequencePreviewFromDatabase(database, input),
    resolveJournalReplayFacilityId: (reference) =>
      resolveJournalReplayFacilityIdFromDatabase(database, reference),
    loadJournalReplay: (reference) =>
      loadJournalReplayFromDatabase(database, reference),
  };
}

/** Creates production one-transaction journal capability persistence. */
export function createDrizzleJournalCapabilityStore(
  database: Database,
): JournalCapabilityStore {
  return {
    transaction<Result>(
      operation: (transaction: JournalCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleJournalTransaction(journalQueryDatabase(transaction)),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendCapabilityAuditEntry(journalQueryDatabase(transaction), event),
      );
    },
  };
}

export const EVENT_CONFIRMATION_PHRASES = Object.freeze({
  'all-clear': 'ALL CLEAR',
  close: 'CLOSE EVENT',
} as const);

export interface IssueEventHumanConfirmationInput {
  readonly authenticated: AuthenticatedSession;
  readonly eventId: string;
  readonly action: keyof typeof EVENT_CONFIRMATION_PHRASES;
  readonly lifecyclePreviewId: string | null;
  readonly confirmationPhrase: string;
  readonly requestId: string;
  readonly now: Date;
}

export interface IssueEventHumanConfirmationResult {
  readonly confirmationId: string | null;
}

function assertWebConfirmationIdentity(
  authenticated: AuthenticatedSession,
): void {
  const { actor, result } = authenticated;
  if (
    authenticated.source !== 'web' ||
    actor.kind !== 'human' ||
    actor.userId !== result.user.id ||
    actor.sessionId !== result.session.id ||
    result.connectivityEpoch.sessionId !== result.session.id ||
    result.deviceEnrollment.platform !== 'web'
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'HUMAN_ONLY_REQUIRED',
      'This confirmation can only be issued to the current web session.',
      403,
    );
  }
}

function assertAuthenticatedFacilityScope(
  authenticated: AuthenticatedSession,
  facilityId: string,
): void {
  const scope = authenticated.scope.facilityScope;
  if (scope.kind !== 'district' && !scope.facilityIds.includes(facilityId)) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_SCOPE_DENIED',
      'The requested facility is outside the authenticated scope.',
      403,
    );
  }
}

async function assertLifecycleIntegrationsCurrent(
  database: JournalQueryDatabase,
  preview: LifecycleConsequencePreview,
): Promise<void> {
  const integrationIds = preview.channels.map(
    (channel) => channel.integrationStatus.integrationId,
  );
  const rows = await database
    .select({
      enabled: channelConfigurations.enabled,
      status: integrationStatuses,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(inArray(channelConfigurations.integrationId, integrationIds))
    .for('share');
  for (const channel of preview.channels) {
    const expected = channel.integrationStatus;
    const matching = rows.find((row) => {
      const actual = integrationStatusFromRow(row.status);
      return (
        row.enabled &&
        actual.integrationId === expected.integrationId &&
        digestCapabilityValue(actual) === digestCapabilityValue(expected)
      );
    });
    if (matching === undefined) {
      throw conflict(
        'The consequence preview no longer matches current integration readiness.',
      );
    }
  }
}

async function issueEventHumanConfirmationWithDatabase(
  database: JournalQueryDatabase,
  input: IssueEventHumanConfirmationInput,
): Promise<IssueEventHumanConfirmationResult> {
  assertWebConfirmationIdentity(input.authenticated);
  const eventId = UuidSchema.parse(input.eventId);
  UuidSchema.parse(input.requestId);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw invalid('The confirmation request time is invalid.');
  }
  if (input.action !== 'all-clear' && input.action !== 'close') {
    throw invalid('The confirmation action is invalid.');
  }
  if (input.confirmationPhrase !== EVENT_CONFIRMATION_PHRASES[input.action]) {
    throw invalid('The typed confirmation phrase does not match.');
  }
  if ((input.action === 'all-clear') !== (input.lifecyclePreviewId !== null)) {
    throw invalid(
      'The confirmation preview does not match the requested action.',
    );
  }

  const [eventRow] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for('share')
    .limit(1);
  if (eventRow === undefined) {
    throw notFound();
  }
  const event = eventFromRow(eventRow);
  assertAuthenticatedFacilityScope(input.authenticated, event.facilityId);
  if (event.rosterPopulation === null) {
    throw conflict('The event has not been activated.');
  }

  let capabilityId: 'all-clear-event' | 'close-event';
  let consequenceDigest: string;
  let actionIds:
    | readonly ['all-clear', 'send-real-notification']
    | readonly ['close-real-event'];
  let previewExpiry: Date | null = null;
  if (input.action === 'all-clear') {
    if (event.status !== 'active') {
      // The capability engine resolves an exact completed idempotency replay
      // before safety authorization. Do not mint another confirmation after
      // the state has advanced; a matching completed command may replay with
      // null confirmation, while a new key still fails its state transition.
      if (event.status === 'all-clear' || event.status === 'closed') {
        return { confirmationId: null };
      }
      throw conflict('The event is not active and cannot be issued all-clear.');
    }
    const previewId = UuidSchema.parse(input.lifecyclePreviewId);
    const [previewRow] = await database
      .select()
      .from(lifecycleConsequencePreviews)
      .where(eq(lifecycleConsequencePreviews.id, previewId))
      .for('share')
      .limit(1);
    if (previewRow === undefined) {
      throw notFound('The lifecycle consequence preview was not found.');
    }
    const preview = lifecyclePreviewFromRow(previewRow);
    const stateChangedAt = event.reactivatedAt ?? event.activatedAt;
    if (
      stateChangedAt === null ||
      preview.eventId !== event.id ||
      preview.purpose !== 'all-clear' ||
      preview.kind !== event.kind ||
      preview.templateMode !== event.templateMode ||
      preview.eventTypeVersion.id !== event.eventTypeVersion.id ||
      preview.rosterSnapshotId !== event.rosterSnapshotId ||
      preview.rosterPopulation !== event.rosterPopulation ||
      Date.parse(preview.createdAt) < Date.parse(stateChangedAt)
    ) {
      throw conflict('The lifecycle preview does not match the current event.');
    }
    if (event.activationAuthorization === null) {
      throw conflict('The event activation consequence truth is unavailable.');
    }
    const [sourceRow] = await database
      .select()
      .from(activationPreviews)
      .where(
        eq(
          activationPreviews.id,
          event.activationAuthorization.activationPreviewId,
        ),
      )
      .for('share')
      .limit(1);
    if (sourceRow === undefined) {
      throw conflict(
        'The event activation consequence preview is unavailable.',
      );
    }
    const source = activationPreviewFromRow(sourceRow);
    const channelPlan = (
      value: ActivationPreview | LifecycleConsequencePreview,
    ) =>
      [...value.channels]
        .map((channel) => ({
          channel: channel.channel,
          endpointCount: channel.endpointCount,
        }))
        .sort((left, right) => left.channel.localeCompare(right.channel));
    if (
      source.facilityId !== event.facilityId ||
      source.kind !== event.kind ||
      source.templateMode !== event.templateMode ||
      source.eventTypeVersion.id !== event.eventTypeVersion.id ||
      source.rosterSnapshotId !== event.rosterSnapshotId ||
      source.rosterPopulation !== event.rosterPopulation ||
      digestCapabilityValue(source.audienceConfig) !==
        digestCapabilityValue(preview.audienceConfig) ||
      source.recipientCount !== preview.recipientCount ||
      digestCapabilityValue(channelPlan(source)) !==
        digestCapabilityValue(channelPlan(preview))
    ) {
      throw conflict(
        'The lifecycle preview does not match the activated audience plan.',
      );
    }
    const currentTime = await readDatabaseTime(database);
    if (
      preview.sendReadiness !== 'ready' ||
      currentTime.getTime() < Date.parse(preview.createdAt) ||
      currentTime.getTime() >= Date.parse(preview.expiresAt)
    ) {
      throw unavailable('The lifecycle consequence preview is not usable.');
    }
    await assertLifecycleIntegrationsCurrent(database, preview);
    if (event.rosterPopulation !== 'staff') {
      return { confirmationId: null };
    }
    capabilityId = 'all-clear-event';
    consequenceDigest = preview.consequenceDigest;
    actionIds = ['all-clear', 'send-real-notification'];
    previewExpiry = new Date(preview.expiresAt);
  } else {
    if (event.status !== 'all-clear') {
      // As above, this permits only the engine's exact completed replay. It
      // does not issue authorization for a second close transition.
      if (event.status === 'closed') {
        return { confirmationId: null };
      }
      throw conflict('Only an all-clear event can be closed.');
    }
    if (event.kind !== 'incident' || event.rosterPopulation !== 'staff') {
      return { confirmationId: null };
    }
    capabilityId = 'close-event';
    consequenceDigest = deriveCloseConsequenceDigest(event);
    actionIds = ['close-real-event'];
  }

  const issuedAt = await readDatabaseTime(database);
  const maximumExpiry = new Date(
    issuedAt.getTime() + HUMAN_CONFIRMATION_MAX_AGE_SECONDS * 1_000,
  );
  const expiresAt =
    previewExpiry !== null && previewExpiry.getTime() < maximumExpiry.getTime()
      ? previewExpiry
      : maximumExpiry;
  if (expiresAt.getTime() <= issuedAt.getTime()) {
    throw unavailable('The consequence preview expired before confirmation.');
  }
  const confirmationId = randomUUID();
  const record = HumanConfirmationRecordSchema.parse({
    confirmation: {
      id: confirmationId,
      capabilityId,
      actionIds,
      connectivityEpochId: input.authenticated.result.connectivityEpoch.id,
      confirmedByUserId: input.authenticated.actor.userId,
      confirmedWithSessionId: input.authenticated.actor.sessionId,
      consequenceDigest,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    status: 'issued',
    consumedAt: null,
    consumedForRequestId: null,
    expiredAt: null,
  });
  await database.insert(humanConfirmationRecords).values({
    id: record.confirmation.id,
    capabilityId,
    connectivityEpochId: record.confirmation.connectivityEpochId,
    confirmedByUserId: record.confirmation.confirmedByUserId,
    confirmedWithSessionId: record.confirmation.confirmedWithSessionId,
    consequenceDigest: record.confirmation.consequenceDigest,
    issuedAt,
    expiresAt,
    status: 'issued',
    consumedAt: null,
    consumedForRequestId: null,
    expiredAt: null,
  });
  await database.insert(humanConfirmationActions).values(
    record.confirmation.actionIds.map((actionId) => ({
      confirmationId: record.confirmation.id,
      actionId,
    })),
  );
  return { confirmationId: record.confirmation.id };
}

/** Runtime shared by web handlers and future REST/MCP journal adapters. */
export interface JournalCapabilityRuntime {
  readonly store: JournalCapabilityStore;
  execute<Id extends JournalCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  issueHumanConfirmation(
    input: IssueEventHumanConfirmationInput,
  ): Promise<IssueEventHumanConfirmationResult>;
  close(): Promise<void>;
}

/** Builds a journal runtime around an explicitly managed DB connection. */
export function createJournalCapabilityRuntime(
  connection: DatabaseConnection,
): JournalCapabilityRuntime {
  const store = createDrizzleJournalCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeJournalCapability(capabilityId, input, invocation, store),
    issueHumanConfirmation: (input) =>
      connection.db.transaction(async (transaction) =>
        issueEventHumanConfirmationWithDatabase(
          journalQueryDatabase(transaction),
          input,
        ),
      ),
    close: () => connection.close(),
  };
}

let defaultJournalCapabilityRuntime: JournalCapabilityRuntime | undefined;

/** Lazily creates the database-backed journal runtime. */
export function getDefaultJournalCapabilityRuntime(): JournalCapabilityRuntime {
  defaultJournalCapabilityRuntime ??= createJournalCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultJournalCapabilityRuntime;
}

/** Closes and clears the lazily created default journal runtime. */
export async function closeDefaultJournalCapabilityRuntime(): Promise<void> {
  const runtime = defaultJournalCapabilityRuntime;
  defaultJournalCapabilityRuntime = undefined;
  await runtime?.close();
}
