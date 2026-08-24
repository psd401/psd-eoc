import { createHash, randomUUID } from 'node:crypto';

import {
  EventTypePageSchema,
  EventTypePublicationAuthorizationSchema,
  EventTypeRenderingPreviewSchema,
  EventTypeSchema,
  EventTypeVersionDraftSchema,
  EventTypeVersionSchema,
  IdempotencyPrincipalSchema,
  MessageTemplateCatalogSchema,
  UuidSchema,
  defineCapability,
  getCapabilityInvocationPolicy,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type Actor,
  type AgentCapabilityGrant,
  type CapabilityScope,
  type CapabilityExecutionAuthorizer,
  type CreateEventTypeDraftInput,
  type EventKind,
  type EventType,
  type EventTypePage,
  type EventTypeRenderingPreview,
  type EventTypeVersion,
  type EventTypeVersionDraft,
  type GetEventTypeDraftInput,
  type GetEventTypeVersionInput,
  type ListEventTypesInput,
  type MessageTemplateCatalog,
  type MutationTransport,
  type NotificationChannel,
  type NotificationPurpose,
  type InvocationSource,
  type PreviewEventTypeRenderingInput,
  type PublishEventTypeVersionInput,
  type RegisteredCapabilityId,
  type UpdateEventTypeDraftInput,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
} from '../../db/client';
import {
  eventTypeDraftTemplates,
  eventTypeTemplates,
  eventTypeVersionDrafts,
  eventTypeVersions,
  eventTypes,
  idempotencyRecords,
} from '../../db/schema';
import type { AuthenticatedSession } from '../auth/sessions';
import {
  assertApprovedEventTypeName,
  renderTemplateSet,
} from '../notify/render';
import {
  createDrizzleCapabilityStore,
  type AdminCapabilityTransaction,
} from './admin';
import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  executeAuthorizedCapabilityQuery,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';

const EVENT_TYPE_MUTATION_IDS = [
  'create-event-type-draft',
  'update-event-type-draft',
  'publish-event-type-version',
] as const;

type EventTypeMutationId = (typeof EVENT_TYPE_MUTATION_IDS)[number];
type ConfigurationActor = Exclude<Actor, { readonly kind: 'system' }>;

const EVENT_TYPE_ADMIN_CAPABILITY_IDS = new Set<RegisteredCapabilityId>([
  ...EVENT_TYPE_MUTATION_IDS,
  'get-event-type-draft',
  'preview-event-type-rendering',
]);

const PURPOSES = [
  'activation',
  'all-clear',
  'reactivation',
] as const satisfies readonly NotificationPurpose[];
const CHANNELS = [
  'push',
  'email',
  'sms',
] as const satisfies readonly NotificationChannel[];

const DRAFT_RESULT_PREFIX = 'event-type-draft-v2';
const VERSION_RESULT_PREFIX = 'event-type-version-v1';
const ROOT_DRAFT_REVISION = 'root';
const NO_BASE_VERSION = 'none';
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

const DRAFT_MUTATION_IDS = [
  'create-event-type-draft',
  'update-event-type-draft',
] as const;

type DraftMutationId = (typeof DRAFT_MUTATION_IDS)[number];

type DraftLedgerEntry = Readonly<{
  capabilityId: DraftMutationId;
  draftId: string;
  baseVersionId: string | null;
  enabled: boolean;
  previousDraftRevision: string | null;
  draftRevision: string;
}>;

type DraftLedgerRow = Readonly<{
  capabilityId: string;
  resultReference: string | null;
}>;

export const EVENT_TYPE_PREVIEW_VARIABLES = Object.freeze({
  site: 'Harbor Ridge High School',
  eventType: 'Lockdown Drill',
  startTime: '2026-08-08T16:30:00.000Z',
  initiator: 'Taylor Morgan',
});

export type EventTypeCapabilityErrorCode =
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR';

const ERROR_STATUS = {
  CONFLICT: 409,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
} as const satisfies Record<EventTypeCapabilityErrorCode, number>;

/** Stable, non-sensitive failure suitable for an owned HTTP adapter. */
export class EventTypeCapabilityError extends CapabilityEngineError {
  public constructor(code: EventTypeCapabilityErrorCode, message: string) {
    super(
      code,
      code === 'FORBIDDEN'
        ? 'CAPABILITY_INVOCATION_DENIED'
        : code === 'IDEMPOTENCY_CONFLICT'
          ? 'IDEMPOTENCY_REQUEST_MISMATCH'
          : code === 'VALIDATION_ERROR'
            ? 'CAPABILITY_INPUT_INVALID'
            : 'PERSISTENCE_CONFLICT',
      message,
      ERROR_STATUS[code],
      false,
    );
    this.name = 'EventTypeCapabilityError';
  }
}

export interface EventTypeMutationMetadata {
  readonly actor: ConfigurationActor;
  readonly capabilityId: EventTypeMutationId;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
}

/** Persistence boundary used by both the production database and unit tests. */
export interface EventTypeStore {
  list(input: ListEventTypesInput): Promise<EventTypePage>;
  getVersion(input: GetEventTypeVersionInput): Promise<EventTypeVersion>;
  getDraft(input: GetEventTypeDraftInput): Promise<EventTypeVersionDraft>;
  createDraft(
    input: CreateEventTypeDraftInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersionDraft>;
  updateDraft(
    input: UpdateEventTypeDraftInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersionDraft>;
  publishVersion(
    input: PublishEventTypeVersionInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersion>;
}

/** Transaction-scoped event-type repository used by the audited engine. */
export interface EventTypeCapabilityTransaction
  extends CapabilityEngineTransaction {
  readonly eventTypes: EventTypeStore;
}

/** Atomic domain/idempotency/audit store for event-type mutations. */
export type EventTypeCapabilityStore =
  CapabilityEngineStore<EventTypeCapabilityTransaction>;

type StoredTemplateRow = Readonly<{
  templateMode: 'real' | 'drill';
  purpose: NotificationPurpose;
  channel: NotificationChannel;
  classificationMarker: 'INCIDENT' | 'DRILL';
  title: string | null;
  subject: string | null;
  body: string | null;
  textBody: string | null;
}>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function templateCatalogFromRows(
  rows: readonly StoredTemplateRow[],
): MessageTemplateCatalog {
  if (rows.length !== PURPOSES.length * CHANNELS.length) {
    throw new EventTypeCapabilityError(
      'CONFLICT',
      'The event-type revision does not contain a complete template catalog.',
    );
  }
  const rowFor = (
    purpose: NotificationPurpose,
    channel: NotificationChannel,
  ): StoredTemplateRow => {
    const matching = rows.filter(
      (row) => row.purpose === purpose && row.channel === channel,
    );
    if (matching.length !== 1 || matching[0] === undefined) {
      throw new EventTypeCapabilityError(
        'CONFLICT',
        'The event-type revision has an ambiguous template catalog.',
      );
    }
    return matching[0];
  };

  return MessageTemplateCatalogSchema.parse(
    Object.fromEntries(
      PURPOSES.map((purpose) => {
        const push = rowFor(purpose, 'push');
        const email = rowFor(purpose, 'email');
        const sms = rowFor(purpose, 'sms');
        if (
          push.title === null ||
          push.body === null ||
          email.subject === null ||
          email.textBody === null ||
          sms.body === null
        ) {
          throw new EventTypeCapabilityError(
            'CONFLICT',
            'The event-type revision has incomplete channel wording.',
          );
        }
        return [
          purpose,
          {
            templateMode: push.templateMode,
            purpose,
            push: {
              channel: 'push',
              templateMode: push.templateMode,
              purpose,
              classificationMarker: push.classificationMarker,
              title: push.title,
              body: push.body,
            },
            email: {
              channel: 'email',
              templateMode: email.templateMode,
              purpose,
              classificationMarker: email.classificationMarker,
              subject: email.subject,
              textBody: email.textBody,
            },
            sms: {
              channel: 'sms',
              templateMode: sms.templateMode,
              purpose,
              classificationMarker: sms.classificationMarker,
              body: sms.body,
            },
          },
        ];
      }),
    ),
  );
}

function templateRowsFor<
  Reference extends Readonly<
    { eventTypeVersionId: string } | { eventTypeVersionDraftId: string }
  >,
>(
  reference: Reference,
  templates: MessageTemplateCatalog,
): Array<
  Reference &
    Readonly<{
      templateMode: 'real' | 'drill';
      purpose: NotificationPurpose;
      channel: NotificationChannel;
      classificationMarker: 'INCIDENT' | 'DRILL';
      title: string | null;
      subject: string | null;
      body: string | null;
      textBody: string | null;
    }>
> {
  return PURPOSES.flatMap((purpose) =>
    CHANNELS.map((channel) => {
      const template = templates[purpose][channel];
      return {
        ...reference,
        templateMode: template.templateMode,
        purpose: template.purpose,
        channel: template.channel,
        classificationMarker: template.classificationMarker,
        title: template.channel === 'push' ? template.title : null,
        subject: template.channel === 'email' ? template.subject : null,
        body: template.channel === 'email' ? null : template.body,
        textBody: template.channel === 'email' ? template.textBody : null,
      };
    }),
  );
}

function eventTypeFromRow(row: typeof eventTypes.$inferSelect): EventType {
  return EventTypeSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
}

function versionFromRows(
  row: typeof eventTypeVersions.$inferSelect,
  templates: readonly StoredTemplateRow[],
): EventTypeVersion {
  return EventTypeVersionSchema.parse({
    ...row,
    templates: templateCatalogFromRows(templates),
    createdAt: row.createdAt.toISOString(),
  });
}

function draftFromRows(
  row: typeof eventTypeVersionDrafts.$inferSelect,
  templates: readonly StoredTemplateRow[],
  ledger: DraftLedgerEntry,
): EventTypeVersionDraft {
  const parsed = EventTypeVersionDraftSchema.safeParse({
    ...row,
    status: 'draft',
    baseVersionId: ledger.baseVersionId,
    enabled: ledger.enabled,
    templates: templateCatalogFromRows(templates),
    draftRevision: ledger.draftRevision,
    createdAt: row.createdAt.toISOString(),
  });
  if (!parsed.success) {
    throwDraftStateConflict();
  }
  if (
    calculateDraftRevision(parsed.data, ledger.previousDraftRevision) !==
    ledger.draftRevision
  ) {
    throwDraftStateConflict();
  }
  return parsed.data;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    !/^\d+$/u.test(decoded) ||
    Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
  ) {
    throw new EventTypeCapabilityError(
      'VALIDATION_ERROR',
      'The event-type pagination cursor is invalid.',
    );
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EventTypeCapabilityError(
      'VALIDATION_ERROR',
      'The event-type pagination cursor is invalid.',
    );
  }
  return offset;
}

function resultReference(prefix: string, id: string): string {
  return `${prefix}:${UuidSchema.parse(id)}`;
}

function parseResultReference(
  reference: string | null,
  prefix: string,
): string | null {
  if (reference === null || !reference.startsWith(`${prefix}:`)) {
    return null;
  }
  const parsed = UuidSchema.safeParse(reference.slice(prefix.length + 1));
  return parsed.success ? parsed.data : null;
}

function throwDraftStateConflict(): never {
  throw new EventTypeCapabilityError(
    'CONFLICT',
    'The event-type draft revision history is incomplete or inconsistent.',
  );
}

function draftLedgerReference(
  entry: Omit<DraftLedgerEntry, 'capabilityId'>,
): string {
  return [
    DRAFT_RESULT_PREFIX,
    UuidSchema.parse(entry.draftId),
    entry.baseVersionId === null
      ? NO_BASE_VERSION
      : UuidSchema.parse(entry.baseVersionId),
    entry.enabled ? '1' : '0',
    entry.previousDraftRevision ?? ROOT_DRAFT_REVISION,
    entry.draftRevision,
  ].join(':');
}

function parseDraftLedgerEntry(row: DraftLedgerRow): DraftLedgerEntry | null {
  if (!DRAFT_MUTATION_IDS.includes(row.capabilityId as DraftMutationId)) {
    return null;
  }
  const parts = row.resultReference?.split(':');
  if (
    parts === undefined ||
    parts.length !== 6 ||
    parts[0] !== DRAFT_RESULT_PREFIX
  ) {
    return null;
  }
  const draftId = UuidSchema.safeParse(parts[1]);
  const baseVersionId =
    parts[2] === NO_BASE_VERSION
      ? { success: true as const, data: null }
      : UuidSchema.safeParse(parts[2]);
  const previousDraftRevision =
    parts[4] === ROOT_DRAFT_REVISION
      ? null
      : SHA_256_PATTERN.test(parts[4] ?? '')
        ? parts[4]
        : undefined;
  const draftRevision = parts[5];
  if (
    !draftId.success ||
    !baseVersionId.success ||
    (parts[3] !== '0' && parts[3] !== '1') ||
    previousDraftRevision === undefined ||
    draftRevision === undefined ||
    !SHA_256_PATTERN.test(draftRevision)
  ) {
    return null;
  }
  return {
    capabilityId: row.capabilityId as DraftMutationId,
    draftId: draftId.data,
    baseVersionId: baseVersionId.data,
    enabled: parts[3] === '1',
    previousDraftRevision,
    draftRevision,
  };
}

function currentDraftLedgerEntry(
  draftId: string,
  rows: readonly DraftLedgerRow[],
): DraftLedgerEntry {
  const entries = rows.map(parseDraftLedgerEntry);
  if (
    entries.length === 0 ||
    entries.some((entry) => entry === null || entry.draftId !== draftId)
  ) {
    throwDraftStateConflict();
  }
  const parsedEntries = entries as DraftLedgerEntry[];
  const byRevision = new Map<string, DraftLedgerEntry>();
  const childrenByRevision = new Map<string, DraftLedgerEntry[]>();
  const rootEntries: DraftLedgerEntry[] = [];
  const baseVersionId = parsedEntries[0]?.baseVersionId;

  for (const entry of parsedEntries) {
    if (
      byRevision.has(entry.draftRevision) ||
      entry.baseVersionId !== baseVersionId
    ) {
      throwDraftStateConflict();
    }
    byRevision.set(entry.draftRevision, entry);
    if (entry.previousDraftRevision === null) {
      rootEntries.push(entry);
    } else {
      const children =
        childrenByRevision.get(entry.previousDraftRevision) ?? [];
      children.push(entry);
      childrenByRevision.set(entry.previousDraftRevision, children);
    }
  }
  if (
    rootEntries.length !== 1 ||
    rootEntries[0]?.capabilityId !== 'create-event-type-draft' ||
    parsedEntries.some(
      (entry) =>
        (entry.previousDraftRevision === null) !==
          (entry.capabilityId === 'create-event-type-draft') ||
        (entry.previousDraftRevision !== null &&
          !byRevision.has(entry.previousDraftRevision)),
    ) ||
    [...childrenByRevision.values()].some((children) => children.length !== 1)
  ) {
    throwDraftStateConflict();
  }

  const heads = parsedEntries.filter(
    (entry) => !childrenByRevision.has(entry.draftRevision),
  );
  if (heads.length !== 1 || heads[0] === undefined) {
    throwDraftStateConflict();
  }
  const visited = new Set<string>();
  let cursor: DraftLedgerEntry | undefined = heads[0];
  while (cursor !== undefined) {
    if (visited.has(cursor.draftRevision)) {
      throwDraftStateConflict();
    }
    visited.add(cursor.draftRevision);
    cursor =
      cursor.previousDraftRevision === null
        ? undefined
        : byRevision.get(cursor.previousDraftRevision);
  }
  if (visited.size !== parsedEntries.length) {
    throwDraftStateConflict();
  }
  return heads[0];
}

function calculateDraftRevision(
  draft: Omit<EventTypeVersionDraft, 'draftRevision'>,
  previousDraftRevision: string | null,
): string {
  return digest({
    format: 'event-type-draft-revision-v1',
    previousDraftRevision,
    draft: {
      id: draft.id,
      eventTypeId: draft.eventTypeId,
      status: draft.status,
      templateMode: draft.templateMode,
      name: draft.name,
      description: draft.description,
      baseVersionId: draft.baseVersionId,
      enabled: draft.enabled,
      templates: draft.templates,
      draftedBy: draft.draftedBy,
      createdAt: draft.createdAt,
    },
  });
}

function approvalReference(draftId: string, draftRevision: string): string {
  if (!SHA_256_PATTERN.test(draftRevision)) {
    throwDraftStateConflict();
  }
  return `event-type-draft:${UuidSchema.parse(draftId)}:revision:${draftRevision}`;
}

function authorizationReference(
  authorization: EventTypeVersion['publicationAuthorization'],
): string {
  return authorization.kind === 'agent-configuration'
    ? authorization.authorizationReference
    : authorization.approvalReference;
}

function publicationReferencesDraft(
  authorization: EventTypeVersion['publicationAuthorization'],
  draftId: string,
): boolean {
  return authorizationReference(authorization).startsWith(
    `event-type-draft:${UuidSchema.parse(draftId)}:revision:`,
  );
}

function publicationReferencesDraftRevision(
  authorization: EventTypeVersion['publicationAuthorization'],
  draftId: string,
  draftRevision: string,
): boolean {
  return (
    authorizationReference(authorization) ===
    approvalReference(draftId, draftRevision)
  );
}

function publicationAuthorization(
  actor: ConfigurationActor,
  draftId: string,
  draftRevision: string,
) {
  if (actor.kind === 'human') {
    return {
      kind: 'human-admin' as const,
      approvedByUserId: actor.userId,
      approvalReference: approvalReference(draftId, draftRevision),
    };
  }
  return {
    kind: 'agent-configuration' as const,
    agentId: actor.agentId,
    apiKeyId: actor.apiKeyId,
    authorizationReference: approvalReference(draftId, draftRevision),
  };
}

function existingIdempotentResult(
  existing: typeof idempotencyRecords.$inferSelect | undefined,
  requestDigest: string,
  prefix: string,
): string | null {
  if (existing === undefined) {
    return null;
  }
  const resultId = parseResultReference(existing.resultReference, prefix);
  if (
    existing.requestDigest !== requestDigest ||
    existing.status !== 'completed' ||
    resultId === null
  ) {
    throw new EventTypeCapabilityError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to another request.',
    );
  }
  return resultId;
}

function existingIdempotentDraftResult(
  existing: typeof idempotencyRecords.$inferSelect | undefined,
  requestDigest: string,
): DraftLedgerEntry | null {
  if (existing === undefined) {
    return null;
  }
  const parsed = parseDraftLedgerEntry(existing);
  if (
    existing.requestDigest !== requestDigest ||
    existing.status !== 'completed' ||
    parsed === null
  ) {
    throw new EventTypeCapabilityError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to another request.',
    );
  }
  return parsed;
}

export function isDatabaseConstraintError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const code = Reflect.get(current, 'code');
    if (code === '23505' || code === '23503') {
      return true;
    }
    const name = Reflect.get(current, 'name');
    const message = Reflect.get(current, 'message');
    if (
      name === 'DatabaseErrorException' &&
      typeof message === 'string' &&
      /\bSQLState\s*:\s*(?:23503|23505)\b/iu.test(message)
    ) {
      return true;
    }
    current = Reflect.get(current, 'cause');
  }
  return false;
}

function draftResultFromInput(
  row: Pick<
    typeof eventTypeVersionDrafts.$inferSelect,
    'id' | 'eventTypeId' | 'templateMode' | 'createdAt'
  >,
  input: CreateEventTypeDraftInput | UpdateEventTypeDraftInput,
  draftedBy: ConfigurationActor,
  ledger: DraftLedgerEntry,
): EventTypeVersionDraft {
  const parsed = EventTypeVersionDraftSchema.safeParse({
    id: row.id,
    eventTypeId: row.eventTypeId,
    status: 'draft',
    templateMode: row.templateMode,
    name: input.name,
    description: input.description,
    baseVersionId: ledger.baseVersionId,
    enabled: input.enabled,
    templates: input.templates,
    draftedBy,
    draftRevision: ledger.draftRevision,
    createdAt: row.createdAt.toISOString(),
  });
  if (
    !parsed.success ||
    ledger.draftId !== row.id ||
    ledger.enabled !== input.enabled ||
    ('draftId' in input && input.draftId !== ledger.draftId) ||
    ('expectedDraftRevision' in input &&
      input.expectedDraftRevision !== ledger.previousDraftRevision) ||
    ('target' in input &&
      (ledger.baseVersionId !==
        (input.target.kind === 'existing-event-type'
          ? input.target.baseVersionId
          : null) ||
        (input.target.kind === 'existing-event-type' &&
          input.target.eventTypeId !== row.eventTypeId))) ||
    calculateDraftRevision(parsed.data, ledger.previousDraftRevision) !==
      ledger.draftRevision
  ) {
    throwDraftStateConflict();
  }
  return parsed.data;
}

function assertExpectedDraftRevision(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new EventTypeCapabilityError(
      'CONFLICT',
      'The event-type draft changed after this copy was loaded. Reload the draft before continuing.',
    );
  }
}

function throwBaseVersionConflict(): never {
  throw new EventTypeCapabilityError(
    'CONFLICT',
    'The event type changed after this draft was started. Reload the latest version and create a new draft.',
  );
}

function assertTemplateCatalogRenderable(
  templateMode: 'real' | 'drill',
  eventTypeName: string,
  templates: MessageTemplateCatalog,
): void {
  assertApprovedEventTypeName(eventTypeName, templateMode);
  const eventKind = templateMode === 'real' ? 'incident' : 'drill';
  for (const purpose of PURPOSES) {
    renderTemplateSet({
      eventKind,
      templates: templates[purpose],
      variables: {
        ...EVENT_TYPE_PREVIEW_VARIABLES,
        eventType: eventTypeName,
      },
    });
  }
}

/** Database implementation over the contract-aligned immutable schema. */
export class DrizzleEventTypeStore implements EventTypeStore {
  public constructor(private readonly database: Database) {}

  public async list(input: ListEventTypesInput): Promise<EventTypePage> {
    const identityRows = await this.database
      .select()
      .from(eventTypes)
      .where(
        input.templateMode === null
          ? undefined
          : eq(eventTypes.templateMode, input.templateMode),
      )
      .orderBy(asc(eventTypes.key), asc(eventTypes.id));

    if (identityRows.length === 0) {
      return EventTypePageSchema.parse({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    }
    const versionRows = await this.database
      .select()
      .from(eventTypeVersions)
      .where(
        inArray(
          eventTypeVersions.eventTypeId,
          identityRows.map((row) => row.id),
        ),
      )
      .orderBy(
        asc(eventTypeVersions.eventTypeId),
        desc(eventTypeVersions.version),
      );
    const latestByEventType = new Map<
      string,
      typeof eventTypeVersions.$inferSelect
    >();
    for (const version of versionRows) {
      if (!latestByEventType.has(version.eventTypeId)) {
        latestByEventType.set(version.eventTypeId, version);
      }
    }
    const includedVersions = [...latestByEventType.values()].filter(
      (version) => input.enabled === null || version.enabled === input.enabled,
    );
    const templatesByVersion = new Map<string, StoredTemplateRow[]>();
    if (includedVersions.length > 0) {
      const templateRows = await this.database
        .select()
        .from(eventTypeTemplates)
        .where(
          inArray(
            eventTypeTemplates.eventTypeVersionId,
            includedVersions.map((version) => version.id),
          ),
        );
      for (const template of templateRows) {
        const rows = templatesByVersion.get(template.eventTypeVersionId) ?? [];
        rows.push(template);
        templatesByVersion.set(template.eventTypeVersionId, rows);
      }
    }
    const includedVersionIds = new Set(
      includedVersions.map((version) => version.id),
    );
    const rows = identityRows.flatMap((eventTypeRow) => {
      const latest = latestByEventType.get(eventTypeRow.id);
      if (latest === undefined || !includedVersionIds.has(latest.id)) {
        return [];
      }
      return [
        {
          eventType: eventTypeFromRow(eventTypeRow),
          latestVersion: versionFromRows(
            latest,
            templatesByVersion.get(latest.id) ?? [],
          ),
        },
      ];
    });
    const offset = decodeCursor(input.cursor);
    const items = rows.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return EventTypePageSchema.parse({
      items,
      pageInfo: {
        hasMore: nextOffset < rows.length,
        nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null,
      },
    });
  }

  public async getVersion(
    input: GetEventTypeVersionInput,
  ): Promise<EventTypeVersion> {
    const [row] = await this.database
      .select()
      .from(eventTypeVersions)
      .where(eq(eventTypeVersions.id, input.eventTypeVersionId))
      .limit(1);
    if (row === undefined) {
      throw new EventTypeCapabilityError(
        'NOT_FOUND',
        'The event-type version was not found.',
      );
    }
    const templates = await this.database
      .select()
      .from(eventTypeTemplates)
      .where(eq(eventTypeTemplates.eventTypeVersionId, row.id));
    return versionFromRows(row, templates);
  }

  public async getDraft(
    input: GetEventTypeDraftInput,
  ): Promise<EventTypeVersionDraft> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.id, input.draftId))
        .for('share')
        .limit(1);
      if (row === undefined) {
        throw new EventTypeCapabilityError(
          'NOT_FOUND',
          'The event-type draft was not found.',
        );
      }
      const templates = await transaction
        .select()
        .from(eventTypeDraftTemplates)
        .where(eq(eventTypeDraftTemplates.eventTypeVersionDraftId, row.id));
      const ledgerRows = await transaction
        .select({
          capabilityId: idempotencyRecords.capabilityId,
          resultReference: idempotencyRecords.resultReference,
        })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.status, 'completed'),
            inArray(idempotencyRecords.capabilityId, DRAFT_MUTATION_IDS),
            like(
              idempotencyRecords.resultReference,
              `${DRAFT_RESULT_PREFIX}:${row.id}:%`,
            ),
          ),
        );
      return draftFromRows(
        row,
        templates,
        currentDraftLedgerEntry(row.id, ledgerRows),
      );
    });
  }

  public async createDraft(
    input: CreateEventTypeDraftInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersionDraft> {
    let eventTypeId =
      input.target.kind === 'new-event-type'
        ? randomUUID()
        : input.target.eventTypeId;
    const draftId = randomUUID();
    const principal = IdempotencyPrincipalSchema.parse(metadata.actor);
    const principalDigest = digest(principal);
    const requestDigest = digest(input);
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${metadata.capabilityId}:${principalDigest}:${metadata.idempotencyKey}`}, 4010))`,
        );
        const [existing] = await transaction
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.capabilityId, metadata.capabilityId),
              eq(idempotencyRecords.principalDigest, principalDigest),
              eq(idempotencyRecords.key, metadata.idempotencyKey),
            ),
          )
          .limit(1);
        const replay = existingIdempotentDraftResult(existing, requestDigest);
        if (replay !== null) {
          const [replayedDraft] = await transaction
            .select({
              id: eventTypeVersionDrafts.id,
              eventTypeId: eventTypeVersionDrafts.eventTypeId,
              templateMode: eventTypeVersionDrafts.templateMode,
              createdAt: eventTypeVersionDrafts.createdAt,
            })
            .from(eventTypeVersionDrafts)
            .where(eq(eventTypeVersionDrafts.id, replay.draftId))
            .for('share')
            .limit(1);
          if (replayedDraft === undefined) {
            throw new EventTypeCapabilityError(
              'CONFLICT',
              'The idempotent draft result is no longer available.',
            );
          }
          return draftResultFromInput(
            replayedDraft,
            input,
            metadata.actor,
            replay,
          );
        }
        if (input.target.kind === 'new-event-type') {
          // The key row may not exist yet, so its unique index cannot provide
          // the serialization needed by concurrent create-or-recover calls.
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`event-type-key:${input.target.key}`}, 4010))`,
          );
        }
        const idempotencyId = randomUUID();
        await transaction.insert(idempotencyRecords).values({
          id: idempotencyId,
          key: metadata.idempotencyKey,
          capabilityId: metadata.capabilityId,
          principal,
          principalDigest,
          requestDigest,
          status: 'in-progress',
          createdAt: metadata.now,
          completedAt: null,
          resultReference: null,
        });

        let templateMode: 'real' | 'drill';
        let baseVersionId: string | null;
        if (input.target.kind === 'new-event-type') {
          templateMode = input.target.templateMode;
          baseVersionId = null;
          const [existingIdentity] = await transaction
            .select()
            .from(eventTypes)
            .where(eq(eventTypes.key, input.target.key))
            .for('update')
            .limit(1);
          if (existingIdentity === undefined) {
            await transaction.insert(eventTypes).values({
              id: eventTypeId,
              key: input.target.key,
              familyKey: input.target.familyKey,
              templateMode,
              createdAt: metadata.now,
            });
          } else {
            if (
              existingIdentity.familyKey !== input.target.familyKey ||
              existingIdentity.templateMode !== input.target.templateMode
            ) {
              throw new EventTypeCapabilityError(
                'CONFLICT',
                'The stable event-type key belongs to a different immutable family or mode.',
              );
            }
            const [publishedVersion] = await transaction
              .select({ id: eventTypeVersions.id })
              .from(eventTypeVersions)
              .where(eq(eventTypeVersions.eventTypeId, existingIdentity.id))
              .limit(1);
            if (publishedVersion !== undefined) {
              throw new EventTypeCapabilityError(
                'CONFLICT',
                'The stable event-type key already belongs to a published event type.',
              );
            }
            // Preserve the unreachable draft and its ledger root. The caller
            // receives a fresh draft that remains publishable until the usual
            // base-version concurrency rule detects a later publication.
            eventTypeId = existingIdentity.id;
          }
        } else {
          const [identity] = await transaction
            .select()
            .from(eventTypes)
            .where(eq(eventTypes.id, eventTypeId))
            .for('update')
            .limit(1);
          if (identity === undefined) {
            throw new EventTypeCapabilityError(
              'NOT_FOUND',
              'The event type was not found.',
            );
          }
          templateMode = identity.templateMode;
          const [latest] = await transaction
            .select({ id: eventTypeVersions.id })
            .from(eventTypeVersions)
            .where(eq(eventTypeVersions.eventTypeId, identity.id))
            .orderBy(desc(eventTypeVersions.version))
            .limit(1);
          if (latest?.id !== input.target.baseVersionId) {
            throwBaseVersionConflict();
          }
          baseVersionId = latest.id;
        }
        if (
          Object.values(input.templates).some(
            (set) => set.templateMode !== templateMode,
          )
        ) {
          throw new EventTypeCapabilityError(
            'CONFLICT',
            "Draft templates cannot change an event type's real-or-drill mode.",
          );
        }
        assertTemplateCatalogRenderable(
          templateMode,
          input.name,
          input.templates,
        );
        const draftRow = {
          id: draftId,
          eventTypeId,
          templateMode,
          createdAt: metadata.now,
        } as const;
        const draftWithoutRevision = {
          ...draftRow,
          status: 'draft' as const,
          name: input.name,
          description: input.description,
          baseVersionId,
          enabled: input.enabled,
          templates: input.templates,
          draftedBy: metadata.actor,
          createdAt: metadata.now.toISOString(),
        } satisfies Omit<EventTypeVersionDraft, 'draftRevision'>;
        const ledger: DraftLedgerEntry = {
          capabilityId: 'create-event-type-draft',
          draftId,
          baseVersionId,
          enabled: input.enabled,
          previousDraftRevision: null,
          draftRevision: calculateDraftRevision(draftWithoutRevision, null),
        };
        await transaction.insert(eventTypeVersionDrafts).values({
          ...draftRow,
          name: input.name,
          description: input.description,
          draftedBy: metadata.actor,
        });
        await transaction
          .insert(eventTypeDraftTemplates)
          .values(
            templateRowsFor(
              { eventTypeVersionDraftId: draftId },
              input.templates,
            ),
          );
        await transaction
          .update(idempotencyRecords)
          .set({
            status: 'completed',
            completedAt: metadata.now,
            resultReference: draftLedgerReference(ledger),
          })
          .where(eq(idempotencyRecords.id, idempotencyId));
        return draftResultFromInput(draftRow, input, metadata.actor, ledger);
      });
    } catch (error) {
      if (error instanceof EventTypeCapabilityError) {
        throw error;
      }
      if (isDatabaseConstraintError(error)) {
        throw new EventTypeCapabilityError(
          'CONFLICT',
          'The event type conflicts with an existing configuration.',
        );
      }
      throw error;
    }
  }

  public async updateDraft(
    input: UpdateEventTypeDraftInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersionDraft> {
    const principal = IdempotencyPrincipalSchema.parse(metadata.actor);
    const principalDigest = digest(principal);
    const requestDigest = digest(input);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${metadata.capabilityId}:${principalDigest}:${metadata.idempotencyKey}`}, 4010))`,
      );
      const [existing] = await transaction
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, metadata.capabilityId),
            eq(idempotencyRecords.principalDigest, principalDigest),
            eq(idempotencyRecords.key, metadata.idempotencyKey),
          ),
        )
        .limit(1);
      const replay = existingIdempotentDraftResult(existing, requestDigest);
      if (replay !== null) {
        const [replayedDraft] = await transaction
          .select({
            id: eventTypeVersionDrafts.id,
            eventTypeId: eventTypeVersionDrafts.eventTypeId,
            templateMode: eventTypeVersionDrafts.templateMode,
            createdAt: eventTypeVersionDrafts.createdAt,
          })
          .from(eventTypeVersionDrafts)
          .where(eq(eventTypeVersionDrafts.id, replay.draftId))
          .for('share')
          .limit(1);
        if (replayedDraft === undefined) {
          throw new EventTypeCapabilityError(
            'CONFLICT',
            'The idempotent draft result is no longer available.',
          );
        }
        return draftResultFromInput(
          replayedDraft,
          input,
          metadata.actor,
          replay,
        );
      }
      const [draft] = await transaction
        .select()
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.id, input.draftId))
        .for('update')
        .limit(1);
      if (draft === undefined) {
        throw new EventTypeCapabilityError(
          'NOT_FOUND',
          'The event-type draft was not found.',
        );
      }
      const storedTemplates = await transaction
        .select()
        .from(eventTypeDraftTemplates)
        .where(eq(eventTypeDraftTemplates.eventTypeVersionDraftId, draft.id));
      const ledgerRows = await transaction
        .select({
          capabilityId: idempotencyRecords.capabilityId,
          resultReference: idempotencyRecords.resultReference,
        })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.status, 'completed'),
            inArray(idempotencyRecords.capabilityId, DRAFT_MUTATION_IDS),
            like(
              idempotencyRecords.resultReference,
              `${DRAFT_RESULT_PREFIX}:${draft.id}:%`,
            ),
          ),
        );
      const currentLedger = currentDraftLedgerEntry(draft.id, ledgerRows);
      const currentDraft = draftFromRows(draft, storedTemplates, currentLedger);
      assertExpectedDraftRevision(
        currentDraft.draftRevision,
        input.expectedDraftRevision,
      );
      const [identity] = await transaction
        .select({ id: eventTypes.id, templateMode: eventTypes.templateMode })
        .from(eventTypes)
        .where(eq(eventTypes.id, draft.eventTypeId))
        .for('update')
        .limit(1);
      if (
        identity === undefined ||
        identity.templateMode !== draft.templateMode
      ) {
        throw new EventTypeCapabilityError(
          'CONFLICT',
          'The draft no longer matches its immutable event-type identity.',
        );
      }
      const publishedAuthorizations = await transaction
        .select({
          publicationAuthorization: eventTypeVersions.publicationAuthorization,
        })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.eventTypeId, draft.eventTypeId));
      if (
        publishedAuthorizations.some((row) =>
          publicationReferencesDraft(
            EventTypePublicationAuthorizationSchema.parse(
              row.publicationAuthorization,
            ),
            draft.id,
          ),
        )
      ) {
        throw new EventTypeCapabilityError(
          'CONFLICT',
          'A published draft cannot be edited in place.',
        );
      }
      if (
        Object.values(input.templates).some(
          (set) => set.templateMode !== draft.templateMode,
        )
      ) {
        throw new EventTypeCapabilityError(
          'CONFLICT',
          "Draft templates cannot change an event type's real-or-drill mode.",
        );
      }
      assertTemplateCatalogRenderable(
        draft.templateMode,
        input.name,
        input.templates,
      );

      const updatedWithoutRevision = {
        id: draft.id,
        eventTypeId: draft.eventTypeId,
        status: 'draft' as const,
        templateMode: draft.templateMode,
        name: input.name,
        description: input.description,
        baseVersionId: currentDraft.baseVersionId,
        enabled: input.enabled,
        templates: input.templates,
        draftedBy: metadata.actor,
        createdAt: draft.createdAt.toISOString(),
      } satisfies Omit<EventTypeVersionDraft, 'draftRevision'>;
      const nextLedger: DraftLedgerEntry = {
        capabilityId: 'update-event-type-draft',
        draftId: draft.id,
        baseVersionId: currentDraft.baseVersionId,
        enabled: input.enabled,
        previousDraftRevision: currentDraft.draftRevision,
        draftRevision: calculateDraftRevision(
          updatedWithoutRevision,
          currentDraft.draftRevision,
        ),
      };

      const idempotencyId = randomUUID();
      await transaction.insert(idempotencyRecords).values({
        id: idempotencyId,
        key: metadata.idempotencyKey,
        capabilityId: metadata.capabilityId,
        principal,
        principalDigest,
        requestDigest,
        status: 'in-progress',
        createdAt: metadata.now,
        completedAt: null,
        resultReference: null,
      });
      await transaction
        .update(eventTypeVersionDrafts)
        .set({
          name: input.name,
          description: input.description,
          draftedBy: metadata.actor,
        })
        .where(eq(eventTypeVersionDrafts.id, draft.id));
      for (const row of templateRowsFor(
        { eventTypeVersionDraftId: draft.id },
        input.templates,
      )) {
        await transaction
          .update(eventTypeDraftTemplates)
          .set({
            title: row.title,
            subject: row.subject,
            body: row.body,
            textBody: row.textBody,
          })
          .where(
            and(
              eq(eventTypeDraftTemplates.eventTypeVersionDraftId, draft.id),
              eq(eventTypeDraftTemplates.purpose, row.purpose),
              eq(eventTypeDraftTemplates.channel, row.channel),
            ),
          );
      }
      await transaction
        .update(idempotencyRecords)
        .set({
          status: 'completed',
          completedAt: metadata.now,
          resultReference: draftLedgerReference(nextLedger),
        })
        .where(eq(idempotencyRecords.id, idempotencyId));
      return draftResultFromInput(draft, input, metadata.actor, nextLedger);
    });
  }

  public async publishVersion(
    input: PublishEventTypeVersionInput,
    metadata: EventTypeMutationMetadata,
  ): Promise<EventTypeVersion> {
    const principal = IdempotencyPrincipalSchema.parse(metadata.actor);
    const principalDigest = digest(principal);
    const requestDigest = digest(input);
    const selectedVersionId = await this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${metadata.capabilityId}:${principalDigest}:${metadata.idempotencyKey}`}, 4010))`,
        );
        const [existing] = await transaction
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.capabilityId, metadata.capabilityId),
              eq(idempotencyRecords.principalDigest, principalDigest),
              eq(idempotencyRecords.key, metadata.idempotencyKey),
            ),
          )
          .limit(1);
        const replay = existingIdempotentResult(
          existing,
          requestDigest,
          VERSION_RESULT_PREFIX,
        );
        if (replay !== null) {
          return replay;
        }
        const [draft] = await transaction
          .select()
          .from(eventTypeVersionDrafts)
          .where(eq(eventTypeVersionDrafts.id, input.draftId))
          .for('update')
          .limit(1);
        if (draft === undefined) {
          throw new EventTypeCapabilityError(
            'NOT_FOUND',
            'The event-type draft was not found.',
          );
        }
        const draftTemplateRows = await transaction
          .select()
          .from(eventTypeDraftTemplates)
          .where(eq(eventTypeDraftTemplates.eventTypeVersionDraftId, draft.id));
        const ledgerRows = await transaction
          .select({
            capabilityId: idempotencyRecords.capabilityId,
            resultReference: idempotencyRecords.resultReference,
          })
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.status, 'completed'),
              inArray(idempotencyRecords.capabilityId, DRAFT_MUTATION_IDS),
              like(
                idempotencyRecords.resultReference,
                `${DRAFT_RESULT_PREFIX}:${draft.id}:%`,
              ),
            ),
          );
        const currentDraft = draftFromRows(
          draft,
          draftTemplateRows,
          currentDraftLedgerEntry(draft.id, ledgerRows),
        );
        assertExpectedDraftRevision(
          currentDraft.draftRevision,
          input.expectedDraftRevision,
        );
        if (digest(currentDraft.draftedBy) !== digest(metadata.actor)) {
          throw new EventTypeCapabilityError(
            'CONFLICT',
            'Only the actor who last saved this draft can publish it.',
          );
        }
        const [identity] = await transaction
          .select()
          .from(eventTypes)
          .where(eq(eventTypes.id, draft.eventTypeId))
          .for('update')
          .limit(1);
        if (
          identity === undefined ||
          identity.templateMode !== draft.templateMode
        ) {
          throw new EventTypeCapabilityError(
            'CONFLICT',
            'The draft no longer matches its immutable event-type identity.',
          );
        }
        const allVersions = await transaction
          .select()
          .from(eventTypeVersions)
          .where(eq(eventTypeVersions.eventTypeId, identity.id))
          .orderBy(desc(eventTypeVersions.version));
        const alreadyPublished = allVersions.find((version) => {
          return publicationReferencesDraftRevision(
            EventTypePublicationAuthorizationSchema.parse(
              version.publicationAuthorization,
            ),
            draft.id,
            currentDraft.draftRevision,
          );
        });
        const idempotencyId = randomUUID();
        await transaction.insert(idempotencyRecords).values({
          id: idempotencyId,
          key: metadata.idempotencyKey,
          capabilityId: metadata.capabilityId,
          principal,
          principalDigest,
          requestDigest,
          status: 'in-progress',
          createdAt: metadata.now,
          completedAt: null,
          resultReference: null,
        });
        if (alreadyPublished !== undefined) {
          await transaction
            .update(idempotencyRecords)
            .set({
              status: 'completed',
              completedAt: metadata.now,
              resultReference: resultReference(
                VERSION_RESULT_PREFIX,
                alreadyPublished.id,
              ),
            })
            .where(eq(idempotencyRecords.id, idempotencyId));
          return alreadyPublished.id;
        }

        const latest = allVersions[0];
        if ((latest?.id ?? null) !== currentDraft.baseVersionId) {
          throwBaseVersionConflict();
        }
        const templates = currentDraft.templates;
        assertTemplateCatalogRenderable(
          draft.templateMode,
          draft.name,
          templates,
        );
        const versionId = randomUUID();
        const version = EventTypeVersionSchema.parse({
          id: versionId,
          eventTypeId: identity.id,
          version: (latest?.version ?? 0) + 1,
          templateMode: identity.templateMode,
          name: draft.name,
          description: draft.description,
          enabled: currentDraft.enabled,
          templates,
          supersedesVersionId: currentDraft.baseVersionId,
          createdBy: metadata.actor,
          publicationAuthorization: publicationAuthorization(
            metadata.actor,
            draft.id,
            currentDraft.draftRevision,
          ),
          createdAt: metadata.now.toISOString(),
        });
        await transaction.insert(eventTypeVersions).values({
          id: version.id,
          eventTypeId: version.eventTypeId,
          version: version.version,
          templateMode: version.templateMode,
          name: version.name,
          description: version.description,
          enabled: version.enabled,
          supersedesVersionId: version.supersedesVersionId,
          createdBy: version.createdBy,
          publicationAuthorization: version.publicationAuthorization,
          createdAt: metadata.now,
        });
        await transaction
          .insert(eventTypeTemplates)
          .values(
            templateRowsFor({ eventTypeVersionId: version.id }, templates),
          );
        await transaction
          .update(idempotencyRecords)
          .set({
            status: 'completed',
            completedAt: metadata.now,
            resultReference: resultReference(VERSION_RESULT_PREFIX, version.id),
          })
          .where(eq(idempotencyRecords.id, idempotencyId));
        return version.id;
      },
    );
    return this.getVersion({ eventTypeVersionId: selectedVersionId });
  }
}

export interface AuthenticatedEventTypeAgent {
  readonly actor: Extract<Actor, { readonly kind: 'agent' }>;
  readonly source: Extract<InvocationSource, 'agent-rest' | 'mcp'>;
  readonly scope: CapabilityScope;
  readonly grantedCapabilityIds: readonly AgentCapabilityGrant[];
}

type AuthenticatedEventTypePrincipal =
  | AuthenticatedSession
  | AuthenticatedEventTypeAgent;

function isAuthenticatedEventTypeAgent(
  authenticated: AuthenticatedEventTypePrincipal,
): authenticated is AuthenticatedEventTypeAgent {
  return authenticated.actor.kind === 'agent';
}

interface EventTypeCapabilityContext {
  readonly store: EventTypeStore;
  readonly authenticated: AuthenticatedEventTypePrincipal;
  readonly requestId: string;
  readonly now: Date;
  readonly mutation: Readonly<{
    idempotencyKey: string;
    transport: Extract<
      MutationTransport,
      {
        readonly kind:
          | 'agent-rest-command'
          | 'mcp-tool-call'
          | 'mobile-interactive'
          | 'web-interactive';
      }
    >;
  }> | null;
}

const listEventTypesHandler = registerCapabilityHandler(
  'list-event-types',
  (input, context: EventTypeCapabilityContext) => context.store.list(input),
);

const getEventTypeVersionHandler = registerCapabilityHandler(
  'get-event-type-version',
  (input, context: EventTypeCapabilityContext) =>
    context.store.getVersion(input),
);

const getEventTypeDraftHandler = registerCapabilityHandler(
  'get-event-type-draft',
  (input, context: EventTypeCapabilityContext) => context.store.getDraft(input),
);

const previewEventTypeRenderingHandler = registerCapabilityHandler(
  'preview-event-type-rendering',
  async (
    input,
    context: EventTypeCapabilityContext,
  ): Promise<EventTypeRenderingPreview> => {
    const draft = await context.store.getDraft({ draftId: input.draftId });
    assertExpectedDraftRevision(
      draft.draftRevision,
      input.expectedDraftRevision,
    );
    const expectedMode = input.eventKind === 'incident' ? 'real' : 'drill';
    if (draft.templateMode !== expectedMode) {
      throw new EventTypeCapabilityError(
        'CONFLICT',
        "Preview event kind must match the draft's immutable mode.",
      );
    }
    return EventTypeRenderingPreviewSchema.parse({
      draftId: draft.id,
      draftRevision: draft.draftRevision,
      eventKind: input.eventKind,
      templateMode: draft.templateMode,
      purpose: input.purpose,
      messages: renderTemplateSet({
        eventKind: input.eventKind,
        templates: draft.templates[input.purpose],
        variables: {
          ...EVENT_TYPE_PREVIEW_VARIABLES,
          eventType: draft.name,
        },
      }),
    });
  },
);

function assertEventTypeCapabilityAuthorized(
  capabilityId: RegisteredCapabilityId,
  input: unknown,
  context: EventTypeCapabilityContext,
): void {
  const definition = defineCapability(capabilityId);
  const invocationPolicy = getCapabilityInvocationPolicy(capabilityId);
  const principalKinds: ReadonlySet<string> = new Set(
    invocationPolicy.principalKinds,
  );
  const sources: ReadonlySet<string> = new Set(invocationPolicy.sources);
  const authenticated = context.authenticated;
  if (
    !principalKinds.has(authenticated.actor.kind) ||
    !sources.has(authenticated.source)
  ) {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'Event-type capability authorization failed.',
    );
  }

  const staffPublishedList =
    definition.id === 'list-event-types' &&
    typeof input === 'object' &&
    input !== null &&
    'enabled' in input &&
    input.enabled === true;
  const globalConfigurationAccess =
    EVENT_TYPE_ADMIN_CAPABILITY_IDS.has(definition.id) ||
    (definition.id === 'list-event-types' && !staffPublishedList);
  if (
    globalConfigurationAccess &&
    authenticated.scope.facilityScope.kind !== 'district'
  ) {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'District scope is required for event-type configuration.',
    );
  }

  if (isAuthenticatedEventTypeAgent(authenticated)) {
    if (
      !authenticated.grantedCapabilityIds.some(
        (grantedCapabilityId) => grantedCapabilityId === definition.id,
      )
    ) {
      throw new EventTypeCapabilityError(
        'FORBIDDEN',
        'The agent is not granted this event-type capability.',
      );
    }
  } else {
    const isAdmin = authenticated.roles.includes('admin');
    const publishedVersionRead = definition.id === 'get-event-type-version';
    if (
      !isAdmin &&
      (EVENT_TYPE_ADMIN_CAPABILITY_IDS.has(definition.id) ||
        (!staffPublishedList && !publishedVersionRead))
    ) {
      throw new EventTypeCapabilityError(
        'FORBIDDEN',
        'Administrator access is required.',
      );
    }
  }

  if (definition.operation === 'mutation') {
    if (context.mutation === null) {
      throw new EventTypeCapabilityError(
        'FORBIDDEN',
        'The event-type mutation transport was not verified.',
      );
    }
  } else if (context.mutation !== null) {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'Query capabilities cannot use mutation transport metadata.',
    );
  }
}

const eventTypeAuthorizer: CapabilityExecutionAuthorizer<EventTypeCapabilityContext> =
  {
    authorize: ({ definition, input, context }) =>
      assertEventTypeCapabilityAuthorized(definition.id, input, context),
  };

interface ExecuteEventTypeQueryInput<Input> {
  readonly store: EventTypeStore;
  readonly authenticated: AuthenticatedEventTypePrincipal;
  readonly query: Input;
  readonly requestId?: string;
  readonly now?: Date;
}

interface ExecuteEventTypeMutationInput<Input> {
  readonly store: EventTypeStore;
  readonly capabilityStore: EventTypeCapabilityStore;
  readonly authenticated: AuthenticatedEventTypePrincipal;
  readonly command: Input;
  readonly idempotencyKey: string;
  readonly transport: Extract<
    MutationTransport,
    {
      readonly kind:
        | 'agent-rest-command'
        | 'mcp-tool-call'
        | 'mobile-interactive'
        | 'web-interactive';
    }
  >;
  readonly requestId?: string;
  readonly now?: Date;
}

function queryContext<Input>(input: ExecuteEventTypeQueryInput<Input>): {
  readonly requestId: string;
  readonly now: Date;
  readonly context: EventTypeCapabilityContext;
} {
  const requestId = input.requestId ?? randomUUID();
  const now = input.now ?? new Date();
  return {
    requestId,
    now,
    context: {
      store: input.store,
      authenticated: input.authenticated,
      requestId,
      now,
      mutation: null,
    },
  };
}

function mutationContext<Input>(input: ExecuteEventTypeMutationInput<Input>): {
  readonly requestId: string;
  readonly now: Date;
  readonly context: EventTypeCapabilityContext;
} {
  const requestId = input.requestId ?? randomUUID();
  const now = input.now ?? new Date();
  return {
    requestId,
    now,
    context: {
      store: input.store,
      authenticated: input.authenticated,
      requestId,
      now,
      mutation: {
        idempotencyKey: input.idempotencyKey,
        transport: input.transport,
      },
    },
  };
}

function queryEnvelope(
  capabilityId:
    | 'get-event-type-draft'
    | 'get-event-type-version'
    | 'list-event-types'
    | 'preview-event-type-rendering',
  input: unknown,
  execution: ReturnType<typeof queryContext>,
) {
  return parseCapabilityEnvelopeFor(capabilityId, {
    capabilityId,
    operation: 'query',
    actor: execution.context.authenticated.actor,
    source: execution.context.authenticated.source,
    scope: execution.context.authenticated.scope,
    requestId: execution.requestId,
    serverTime: execution.now.toISOString(),
    input,
  });
}

const executionDependencies = (context: EventTypeCapabilityContext) => ({
  context,
  humanActionResolutionContext: null,
  safetyResolver: null,
  authorizer: eventTypeAuthorizer,
});

export async function executeListEventTypesCapability(
  input: ExecuteEventTypeQueryInput<ListEventTypesInput>,
): Promise<EventTypePage> {
  const execution = queryContext(input);
  const envelope = queryEnvelope('list-event-types', input.query, execution);
  return executeAuthorizedCapabilityQuery(
    listEventTypesHandler,
    envelope.input,
    executionDependencies(execution.context),
  );
}

export async function executeGetEventTypeVersionCapability(
  input: ExecuteEventTypeQueryInput<GetEventTypeVersionInput>,
): Promise<EventTypeVersion> {
  const execution = queryContext(input);
  const envelope = queryEnvelope(
    'get-event-type-version',
    input.query,
    execution,
  );
  return executeAuthorizedCapabilityQuery(
    getEventTypeVersionHandler,
    envelope.input,
    executionDependencies(execution.context),
  );
}

export async function executeGetEventTypeDraftCapability(
  input: ExecuteEventTypeQueryInput<GetEventTypeDraftInput>,
): Promise<EventTypeVersionDraft> {
  const execution = queryContext(input);
  const envelope = queryEnvelope(
    'get-event-type-draft',
    input.query,
    execution,
  );
  return executeAuthorizedCapabilityQuery(
    getEventTypeDraftHandler,
    envelope.input,
    executionDependencies(execution.context),
  );
}

export async function executePreviewEventTypeRenderingCapability(
  input: ExecuteEventTypeQueryInput<PreviewEventTypeRenderingInput>,
): Promise<EventTypeRenderingPreview> {
  const execution = queryContext(input);
  const envelope = queryEnvelope(
    'preview-event-type-rendering',
    input.query,
    execution,
  );
  return executeAuthorizedCapabilityQuery(
    previewEventTypeRenderingHandler,
    envelope.input,
    executionDependencies(execution.context),
  );
}

function eventTypeMutationInvocation(
  execution: ReturnType<typeof mutationContext>,
): TrustedCapabilityInvocation {
  const authenticated = execution.context.authenticated;
  const mutation = execution.context.mutation;
  if (mutation === null) {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'Mutation transport metadata is required.',
    );
  }
  return Object.freeze({
    actor: authenticated.actor,
    source: authenticated.source,
    scope: authenticated.scope,
    requestId: execution.requestId,
    serverTime: execution.now,
    connectivityEpochId: isAuthenticatedEventTypeAgent(authenticated)
      ? null
      : authenticated.result.connectivityEpoch.id,
    mutation: Object.freeze({
      idempotencyKey: mutation.idempotencyKey,
      transport: mutation.transport,
      humanConfirmationId: null,
    }),
  });
}

function engineMutationMetadata(
  context: Readonly<{
    invocation: TrustedCapabilityInvocation;
  }>,
  capabilityId: EventTypeMutationId,
): EventTypeMutationMetadata {
  if (context.invocation.actor.kind === 'system') {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'Event-type configuration requires a human or agent actor.',
    );
  }
  const idempotencyKey = context.invocation.mutation?.idempotencyKey;
  if (idempotencyKey === undefined) {
    throw new EventTypeCapabilityError(
      'FORBIDDEN',
      'Mutation transport metadata is required.',
    );
  }
  return {
    actor: context.invocation.actor,
    capabilityId,
    idempotencyKey,
    requestId: context.invocation.requestId,
    now: context.invocation.serverTime,
  };
}

function authorizeEngineEventTypeMutation(
  capabilityId: EventTypeMutationId,
  input: unknown,
  authenticated: AuthenticatedEventTypePrincipal,
  invocation: TrustedCapabilityInvocation,
): void {
  assertEventTypeCapabilityAuthorized(capabilityId, input, {
    store: Object.freeze({}) as EventTypeStore,
    authenticated,
    requestId: invocation.requestId,
    now: invocation.serverTime,
    mutation:
      invocation.mutation === null
        ? null
        : {
            idempotencyKey: invocation.mutation.idempotencyKey,
            transport: invocation.mutation.transport as NonNullable<
              EventTypeCapabilityContext['mutation']
            >['transport'],
          },
  });
}

export async function executeCreateEventTypeDraftCapability(
  input: ExecuteEventTypeMutationInput<CreateEventTypeDraftInput>,
): Promise<EventTypeVersionDraft> {
  const execution = mutationContext(input);
  const registration: ServerCapabilityRegistration<
    'create-event-type-draft',
    EventTypeCapabilityTransaction
  > = {
    id: 'create-event-type-draft',
    mutationPersistence: 'repository-owned',
    resolveFacilityId(command, context) {
      authorizeEngineEventTypeMutation(
        'create-event-type-draft',
        command,
        input.authenticated,
        context.invocation,
      );
      return null;
    },
    handler: (command, context) =>
      context.transaction.eventTypes.createDraft(
        command,
        engineMutationMetadata(context, 'create-event-type-draft'),
      ),
  };
  return executeAuditedCapabilityTransaction(
    registration,
    input.command,
    eventTypeMutationInvocation(execution),
    input.capabilityStore,
  );
}

export async function executeUpdateEventTypeDraftCapability(
  input: ExecuteEventTypeMutationInput<UpdateEventTypeDraftInput>,
): Promise<EventTypeVersionDraft> {
  const execution = mutationContext(input);
  const registration: ServerCapabilityRegistration<
    'update-event-type-draft',
    EventTypeCapabilityTransaction
  > = {
    id: 'update-event-type-draft',
    mutationPersistence: 'repository-owned',
    resolveFacilityId(command, context) {
      authorizeEngineEventTypeMutation(
        'update-event-type-draft',
        command,
        input.authenticated,
        context.invocation,
      );
      return null;
    },
    handler: (command, context) =>
      context.transaction.eventTypes.updateDraft(
        command,
        engineMutationMetadata(context, 'update-event-type-draft'),
      ),
  };
  return executeAuditedCapabilityTransaction(
    registration,
    input.command,
    eventTypeMutationInvocation(execution),
    input.capabilityStore,
  );
}

export async function executePublishEventTypeVersionCapability(
  input: ExecuteEventTypeMutationInput<PublishEventTypeVersionInput>,
): Promise<EventTypeVersion> {
  const execution = mutationContext(input);
  const registration: ServerCapabilityRegistration<
    'publish-event-type-version',
    EventTypeCapabilityTransaction
  > = {
    id: 'publish-event-type-version',
    mutationPersistence: 'repository-owned',
    resolveFacilityId(command, context) {
      authorizeEngineEventTypeMutation(
        'publish-event-type-version',
        command,
        input.authenticated,
        context.invocation,
      );
      return null;
    },
    handler: (command, context) =>
      context.transaction.eventTypes.publishVersion(
        command,
        engineMutationMetadata(context, 'publish-event-type-version'),
      ),
  };
  return executeAuditedCapabilityTransaction(
    registration,
    input.command,
    eventTypeMutationInvocation(execution),
    input.capabilityStore,
  );
}

/** Creates the production atomic engine store around transaction-scoped repositories. */
export function createDrizzleEventTypeCapabilityStore(
  database: Database,
): EventTypeCapabilityStore {
  const engineStore = createDrizzleCapabilityStore(database);
  return Object.freeze({
    transaction<Result>(
      operation: (
        transaction: EventTypeCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return engineStore.transaction((transaction) =>
        operation({
          readCurrentTime: (receivedAt) =>
            transaction.readCurrentTime(receivedAt),
          claimIdempotency: (claim) => transaction.claimIdempotency(claim),
          completeIdempotency: (completion) =>
            transaction.completeIdempotency(completion),
          getHumanConfirmation: (id) => transaction.getHumanConfirmation(id),
          consumeHumanConfirmation: (confirmation) =>
            transaction.consumeHumanConfirmation(confirmation),
          appendCapabilityAudit: (event) =>
            transaction.appendCapabilityAudit(event),
          eventTypes: new DrizzleEventTypeStore(
            (transaction as AdminCapabilityTransaction).database as Database,
          ),
        }),
      );
    },
    appendCapabilityAudit: (event: CapabilityAuditEvent) =>
      engineStore.appendCapabilityAudit(event),
  });
}

let defaultConnection: DatabaseConnection | undefined;
let defaultStore: DrizzleEventTypeStore | undefined;
let defaultCapabilityStore: EventTypeCapabilityStore | undefined;

/** Lazily creates the production event-type repository for Next.js routes. */
export function getDefaultEventTypeStore(): DrizzleEventTypeStore {
  if (defaultStore === undefined) {
    defaultConnection = createDatabaseClient(readDatabaseConfig());
    defaultStore = new DrizzleEventTypeStore(defaultConnection.db);
    defaultCapabilityStore = createDrizzleEventTypeCapabilityStore(
      defaultConnection.db,
    );
  }
  return defaultStore;
}

/** Returns the engine store paired with the process-default event-type repository. */
export function getDefaultEventTypeCapabilityStore(): EventTypeCapabilityStore {
  getDefaultEventTypeStore();
  if (defaultCapabilityStore === undefined) {
    throw new EventTypeCapabilityError(
      'CONFLICT',
      'The event-type capability store is unavailable.',
    );
  }
  return defaultCapabilityStore;
}

/** Test/script lifecycle hook; the normal Next.js process retains its pool. */
export async function closeDefaultEventTypeStore(): Promise<void> {
  const connection = defaultConnection;
  defaultConnection = undefined;
  defaultStore = undefined;
  defaultCapabilityStore = undefined;
  await connection?.close();
}

/** Maps a preview kind to the immutable template mode without caller choice. */
export function eventKindForTemplateMode(mode: 'real' | 'drill'): EventKind {
  return mode === 'real' ? 'incident' : 'drill';
}
