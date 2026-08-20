import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  MessageTemplateCatalogSchema,
  type MessageTemplateCatalog,
  type NotificationPurpose,
} from '@psd-eoc/contracts';
import { and, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypeVersionDrafts,
  eventTypes,
  idempotencyRecords,
  securityAuditEntries,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { parseSecurityAuditFact } from '../audit/model';
import {
  createDrizzleSecurityAuditRepository,
  SecurityAuditRequestConflictError,
} from '../audit';
import type { EventTypeMutationMetadata } from '../capabilities/event-types';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import { createAtomicAgentEventTypeStore } from './event-types';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The atomic event-type test database is not open.');
  }
  return connection;
}

function templates(): MessageTemplateCatalog {
  const set = (purpose: NotificationPurpose) => ({
    templateMode: 'real' as const,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      title: '{{eventType}} at {{site}}',
      body: 'Open PSD EOC for current information.',
    },
    email: {
      channel: 'email' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      subject: '{{eventType}} at {{site}}',
      textBody:
        '{{eventType}} at {{site}} began {{startTime}}. Open PSD EOC for current information.',
    },
    sms: {
      channel: 'sms' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      body: '{{eventType}} at {{site}}. Open PSD EOC.',
    },
  });
  return MessageTemplateCatalogSchema.parse({
    activation: set('activation'),
    'all-clear': set('all-clear'),
    reactivation: set('reactivation'),
  });
}

function mutationMetadata(
  requestId: string,
  idempotencyKey: string,
  now: Date,
): EventTypeMutationMetadata {
  return {
    actor: {
      kind: 'agent',
      agentId: randomUUID(),
      apiKeyId: randomUUID(),
    },
    capabilityId: 'create-event-type-draft',
    idempotencyKey,
    requestId,
    now,
  };
}

function createInput(key: string) {
  return {
    target: {
      kind: 'new-event-type' as const,
      key,
      familyKey: key,
      templateMode: 'real' as const,
    },
    name: 'Lockdown',
    description: 'Synthetic configuration used only by an atomicity test.',
    enabled: true,
    templates: templates(),
  };
}

describeWithDatabase('atomic agent event-type database adapter', () => {
  beforeAll(async () => {
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl ?? '',
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The atomic event-type test requires PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
  });

  afterAll(async () => {
    await connection?.close();
    connection = undefined;
  });

  test('commits the canonical draft, idempotency record, and audit together', async () => {
    const db = databaseConnection().db;
    const store = createAtomicAgentEventTypeStore(db);
    const requestId = randomUUID();
    const idempotencyKey = `agent-atomic-success-${randomUUID()}`;
    const key = `agent-atomic-success-${randomUUID()}`;
    const draft = await store.createDraft(
      createInput(key),
      mutationMetadata(
        requestId,
        idempotencyKey,
        new Date('2026-08-10T21:30:00.000Z'),
      ),
    );

    const [identityRows, draftRows, ledgerRows, auditRows] = await Promise.all([
      db.select().from(eventTypes).where(eq(eventTypes.key, key)),
      db
        .select()
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.id, draft.id)),
      db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'create-event-type-draft'),
            eq(idempotencyRecords.key, idempotencyKey),
          ),
        ),
      db
        .select()
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId)),
    ]);
    expect(identityRows).toHaveLength(1);
    expect(draftRows).toHaveLength(1);
    expect(ledgerRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'create-event-type-draft',
      outcome: 'success',
      requestId,
    });
  });

  test('rolls back canonical writes when the audit request conflicts', async () => {
    const db = databaseConnection().db;
    const store = createAtomicAgentEventTypeStore(db);
    const requestId = randomUUID();
    const idempotencyKey = `agent-atomic-rollback-${randomUUID()}`;
    const key = `agent-atomic-rollback-${randomUUID()}`;
    const now = new Date('2026-08-10T21:31:00.000Z');
    const metadata = mutationMetadata(requestId, idempotencyKey, now);
    await createDrizzleSecurityAuditRepository(db).append(
      parseSecurityAuditFact({
        category: 'agent-access',
        action: 'list-event-types',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: metadata.actor,
        source: 'agent-rest',
        facilityId: null,
        target: { kind: 'capability', id: 'list-event-types' },
        requestId,
        reasonCode: null,
        occurredAt: now.toISOString(),
      }),
    );

    await expect(
      store.createDraft(createInput(key), metadata),
    ).rejects.toBeInstanceOf(SecurityAuditRequestConflictError);

    const [identityRows, ledgerRows, auditRows] = await Promise.all([
      db.select().from(eventTypes).where(eq(eventTypes.key, key)),
      db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'create-event-type-draft'),
            eq(idempotencyRecords.key, idempotencyKey),
          ),
        ),
      db
        .select()
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId)),
    ]);
    expect(identityRows).toEqual([]);
    expect(ledgerRows).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe('list-event-types');
  });
});
