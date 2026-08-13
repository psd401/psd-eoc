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
  type TemplateMode,
} from '@psd-eoc/contracts';
import { and, eq, like, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  eventTypeDraftTemplates,
  eventTypeVersionDrafts,
  eventTypeVersions,
  eventTypes,
  facilities,
  idempotencyRecords,
  events,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  DrizzleEventTypeStore,
  executePreviewEventTypeRenderingCapability,
  type AuthenticatedEventTypeAgent,
  type EventTypeMutationMetadata,
} from '../../../lib/capabilities/event-types';
import {
  measureSmsLength,
  renderTemplateSet,
} from '../../../lib/notify/render';
import {
  prepareOwnedEventTypeDatabaseTestDatabase,
  resolveEventTypeDatabaseTestContext,
  type OwnedEventTypeDatabaseTestDatabase,
} from './database-test-database';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  configuredTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase:
  | OwnedEventTypeDatabaseTestDatabase<PostgresDatabaseConnection>
  | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The event-type integration database is not open.');
  }
  return connection;
}

function templates(mode: TemplateMode, label: string): MessageTemplateCatalog {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  const activationTitle =
    /(?:BRAVO|LATEST|NEWER|REVISED|REVISION B|UPDATED)/u.test(label)
      ? '{{eventType}} update'
      : '{{eventType}} at {{site}}';
  const set = (purpose: NotificationPurpose) => {
    const wording =
      purpose === 'activation'
        ? {
            title: activationTitle,
            body: 'Started {{startTime}} by {{initiator}}. Open PSD EOC for current instructions.',
            textBody:
              '{{eventType}} at {{site}} started {{startTime}} by {{initiator}}. Open PSD EOC for current instructions.',
            sms: '{{eventType}} at {{site}}. Open PSD EOC.',
          }
        : purpose === 'all-clear'
          ? {
              title: 'ALL CLEAR: {{eventType}} at {{site}}',
              body: '{{eventType}} at {{site}} is all clear. Open PSD EOC for current information.',
              textBody:
                'The {{eventType}} at {{site}} is complete. The notification began {{startTime}}. Open PSD EOC for current information.',
              sms: '{{eventType}} complete at {{site}}. Open PSD EOC for current information.',
            }
          : {
              title: 'REACTIVATION: {{eventType}} at {{site}}',
              body: '{{eventType}} at {{site}} is active again. Open PSD EOC for current instructions.',
              textBody:
                'The {{eventType}} at {{site}} is active again. The notification originally began {{startTime}} and was initiated by {{initiator}}. Open PSD EOC for current instructions.',
              sms: '{{eventType}} reactivated at {{site}}. Open PSD EOC for current instructions.',
            };
    return {
      templateMode: mode,
      purpose,
      push: {
        channel: 'push' as const,
        templateMode: mode,
        purpose,
        classificationMarker,
        title: wording.title,
        body: wording.body,
      },
      email: {
        channel: 'email' as const,
        templateMode: mode,
        purpose,
        classificationMarker,
        subject: wording.title,
        textBody: wording.textBody,
      },
      sms: {
        channel: 'sms' as const,
        templateMode: mode,
        purpose,
        classificationMarker,
        body: wording.sms,
      },
    };
  };
  return MessageTemplateCatalogSchema.parse({
    activation: set('activation'),
    'all-clear': set('all-clear'),
    reactivation: set('reactivation'),
  });
}

function metadata(
  capabilityId: EventTypeMutationMetadata['capabilityId'],
  actor: EventTypeMutationMetadata['actor'],
  keyPrefix: string,
  now: Date,
): EventTypeMutationMetadata {
  return {
    actor,
    capabilityId,
    idempotencyKey: `${keyPrefix}-${randomUUID()}`,
    requestId: randomUUID(),
    now,
  };
}

function authenticatedPreviewAgent(): AuthenticatedEventTypeAgent {
  return {
    actor: {
      kind: 'agent',
      agentId: randomUUID(),
      apiKeyId: randomUUID(),
    },
    source: 'mcp',
    scope: { facilityScope: { kind: 'district' } },
    grantedCapabilityIds: ['preview-event-type-rendering'],
  };
}

async function waitForBlockedBackend(
  database: PostgresDatabaseConnection['db'],
  matches: (row: {
    readonly pid: number;
    readonly blockers: readonly number[];
  }) => boolean,
  description: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await database.execute<{
      pid: number;
      blockers: number[];
    }>(sql`
      select
        pid::integer as pid,
        pg_blocking_pids(pid) as blockers
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
    `);
    const blocked = waiting.find(matches);
    if (blocked !== undefined) {
      return blocked.pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function startInIdentityLockOrder<TFirst, TSecond>(
  database: PostgresDatabaseConnection['db'],
  eventTypeId: string,
  first: () => Promise<TFirst>,
  second: () => Promise<TSecond>,
  description: string,
): Promise<readonly [Promise<TFirst>, Promise<TSecond>]> {
  return database.transaction(async (transaction) => {
    await transaction
      .select({ id: eventTypes.id })
      .from(eventTypes)
      .where(eq(eventTypes.id, eventTypeId))
      .for('update');
    const [backend] = await transaction.execute<{ blockerPid: number }>(sql`
      select pg_backend_pid()::integer as "blockerPid"
    `);
    if (backend === undefined) {
      throw new Error('Could not resolve the identity lock holder.');
    }

    const firstPromise = first();
    const firstPid = await waitForBlockedBackend(
      database,
      (row) => row.blockers.includes(backend.blockerPid),
      `the first ${description} operation to wait on the identity lock`,
    );
    const secondPromise = second();
    await waitForBlockedBackend(
      database,
      (row) =>
        row.pid !== firstPid &&
        (row.blockers.includes(firstPid) ||
          row.blockers.includes(backend.blockerPid)),
      `the second ${description} operation to queue behind the first`,
    );
    return [firstPromise, secondPromise] as const;
  });
}

describeWithDatabase('event-type database versioning', () => {
  beforeAll(async () => {
    if (configuredTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const context = resolveEventTypeDatabaseTestContext(
      configuredTestDatabaseUrl,
    );
    ownedDatabase = await prepareOwnedEventTypeDatabaseTestDatabase(context, {
      open(databaseUrl) {
        const created = createDatabaseClient({
          driver: 'postgres',
          url: databaseUrl,
          maxConnections: 4,
        });
        if (created.driver !== 'postgres') {
          throw new Error('Event-type integration tests require PostgreSQL.');
        }
        return created;
      },
      async prepare(created) {
        await migrateDatabase(created);
        await seedDatabase(created.db);
      },
      close: (created) => created.close(),
    });
    connection = ownedDatabase.resource;
  });

  afterAll(async () => {
    const database = ownedDatabase;
    connection = undefined;
    ownedDatabase = undefined;
    await database?.cleanup();
  });

  test('publishes a linear version chain while an event remains pinned to exact historical wording', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-${randomUUID()}`;
    const createdAt = new Date('2026-08-08T18:00:00.000Z');
    const createInput = {
      target: {
        kind: 'new-event-type' as const,
        key,
        familyKey: key,
        templateMode: 'real' as const,
      },
      name: 'Secure',
      description: 'Synthetic event type used only by the database test.',
      enabled: true,
      templates: templates('real', 'INITIAL COPY'),
    };
    const createMetadata = metadata(
      'create-event-type-draft',
      actor,
      'issue10-create',
      createdAt,
    );
    const firstDraft = await store.createDraft(createInput, createMetadata);
    const createReplay = await store.createDraft(createInput, createMetadata);
    expect(createReplay.id).toBe(firstDraft.id);

    const firstVersion = await store.publishVersion(
      {
        draftId: firstDraft.id,
        expectedDraftRevision: firstDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-publish-v1',
        new Date('2026-08-08T18:01:00.000Z'),
      ),
    );
    expect(firstVersion.version).toBe(1);
    expect(firstVersion.supersedesVersionId).toBeNull();

    const [facility] = await db.select().from(facilities).limit(1);
    if (facility === undefined) {
      throw new Error('The synthetic seed did not create a facility.');
    }
    const eventId = randomUUID();
    await db.insert(events).values({
      id: eventId,
      facilityId: facility.id,
      kind: 'incident',
      templateMode: 'real',
      eventTypeVersionId: firstVersion.id,
      status: 'draft',
      createdBy: actor,
      createdAt: new Date('2026-08-08T18:02:00.000Z'),
    });

    const secondDraft = await store.createDraft(
      {
        target: {
          kind: 'existing-event-type',
          eventTypeId: firstDraft.eventTypeId,
          baseVersionId: firstVersion.id,
        },
        name: 'Hold',
        description: 'A later immutable configuration.',
        enabled: true,
        templates: templates('real', 'REVISED COPY'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-create-v2',
        new Date('2026-08-08T18:03:00.000Z'),
      ),
    );
    const secondVersion = await store.publishVersion(
      {
        draftId: secondDraft.id,
        expectedDraftRevision: secondDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-publish-v2',
        new Date('2026-08-08T18:04:00.000Z'),
      ),
    );
    expect(secondVersion.version).toBe(2);
    expect(secondVersion.supersedesVersionId).toBe(firstVersion.id);
    expect(secondVersion.templates.activation.push.title).toBe(
      '{{eventType}} update',
    );

    const historical = await store.getVersion({
      eventTypeVersionId: firstVersion.id,
    });
    expect(historical.name).toBe('Secure');
    expect(historical.templates.activation.push.title).toBe(
      '{{eventType}} at {{site}}',
    );
    const [pinnedEvent] = await db
      .select({ eventTypeVersionId: events.eventTypeVersionId })
      .from(events)
      .where(eq(events.id, eventId));
    expect(pinnedEvent?.eventTypeVersionId).toBe(firstVersion.id);

    const duplicatePublish = await store.publishVersion(
      {
        draftId: secondDraft.id,
        expectedDraftRevision: secondDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-publish-duplicate',
        new Date('2026-08-08T18:05:00.000Z'),
      ),
    );
    expect(duplicatePublish.id).toBe(secondVersion.id);
    await expect(
      store.updateDraft(
        {
          draftId: secondDraft.id,
          expectedDraftRevision: secondDraft.draftRevision,
          name: 'Medical',
          description: null,
          enabled: true,
          templates: templates('real', 'MUTATED COPY'),
        },
        metadata(
          'update-event-type-draft',
          actor,
          'issue10-update-published',
          new Date('2026-08-08T18:06:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const listed = await store.list({
      templateMode: 'real',
      enabled: true,
      cursor: null,
      limit: 200,
    });
    const current = listed.items.find(
      (item) => item.eventType.id === firstDraft.eventTypeId,
    );
    expect(current?.latestVersion.id).toBe(secondVersion.id);
    expect(current?.latestVersion.version).toBe(2);
  });

  test('idempotency replays immutable create and update results after later draft edits', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-replay-${randomUUID()}`;
    const createInput = {
      target: {
        kind: 'new-event-type' as const,
        key,
        familyKey: key,
        templateMode: 'real' as const,
      },
      name: 'Gas Leak',
      description: 'Original response wording.',
      enabled: true,
      templates: templates('real', 'ORIGINAL COPY'),
    };
    const createMetadata = metadata(
      'create-event-type-draft',
      actor,
      'issue10-replay-create',
      new Date('2026-08-08T18:10:00.000Z'),
    );
    const created = await store.createDraft(createInput, createMetadata);

    const updateAInput = {
      draftId: created.id,
      expectedDraftRevision: created.draftRevision,
      name: 'Police Activity',
      description: 'First saved revision.',
      enabled: false,
      templates: templates('real', 'REVISION A COPY'),
    };
    const updateAMetadata = metadata(
      'update-event-type-draft',
      actor,
      'issue10-replay-update-a',
      new Date('2026-08-08T18:11:00.000Z'),
    );
    const revisionA = await store.updateDraft(updateAInput, updateAMetadata);

    const updateBInput = {
      draftId: created.id,
      expectedDraftRevision: revisionA.draftRevision,
      name: 'Bomb Threat',
      description: 'Current saved revision.',
      enabled: true,
      templates: templates('real', 'REVISION B COPY'),
    };
    await store.updateDraft(
      updateBInput,
      metadata(
        'update-event-type-draft',
        actor,
        'issue10-replay-update-b',
        new Date('2026-08-08T18:12:00.000Z'),
      ),
    );

    expect(await store.createDraft(createInput, createMetadata)).toEqual(
      created,
    );
    expect(await store.updateDraft(updateAInput, updateAMetadata)).toEqual(
      revisionA,
    );
    const current = await store.getDraft({ draftId: created.id });
    expect(current.name).toBe(updateBInput.name);
    expect(current.description).toBe(updateBInput.description);
    expect(current.enabled).toBe(true);
    expect(current.templates).toEqual(updateBInput.templates);
  });

  test('allows only one independently based draft to supersede a published version', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-independent-${randomUUID()}`;
    const initialDraft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'real',
        },
        name: 'Shelter',
        description: 'Base version for independent draft concurrency.',
        enabled: true,
        templates: templates('real', 'INDEPENDENT BASE'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-independent-create-base',
        new Date('2026-08-08T18:13:00.000Z'),
      ),
    );
    const baseVersion = await store.publishVersion(
      {
        draftId: initialDraft.id,
        expectedDraftRevision: initialDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-independent-publish-base',
        new Date('2026-08-08T18:13:10.000Z'),
      ),
    );

    const draftInputs = [
      { label: 'ALPHA COPY', name: 'Secure' },
      { label: 'BRAVO COPY', name: 'Hold' },
    ].map(({ label, name }) => ({
      target: {
        kind: 'existing-event-type' as const,
        eventTypeId: initialDraft.eventTypeId,
        baseVersionId: baseVersion.id,
      },
      name,
      description: `Independent draft ${label}.`,
      enabled: true,
      templates: templates('real', label),
    }));
    const draftA = await store.createDraft(
      draftInputs[0]!,
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-independent-create-a',
        new Date('2026-08-08T18:13:20.000Z'),
      ),
    );
    const draftB = await store.createDraft(
      draftInputs[1]!,
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-independent-create-b',
        new Date('2026-08-08T18:13:30.000Z'),
      ),
    );
    expect(draftA.baseVersionId).toBe(baseVersion.id);
    expect(draftB.baseVersionId).toBe(baseVersion.id);

    const outcomes = await Promise.allSettled([
      store.publishVersion(
        {
          draftId: draftA.id,
          expectedDraftRevision: draftA.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-independent-publish-a',
          new Date('2026-08-08T18:13:40.000Z'),
        ),
      ),
      store.publishVersion(
        {
          draftId: draftB.id,
          expectedDraftRevision: draftB.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-independent-publish-b',
          new Date('2026-08-08T18:13:50.000Z'),
        ),
      ),
    ]);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: 'CONFLICT',
        message:
          'The event type changed after this draft was started. Reload the latest version and create a new draft.',
      },
    });

    const versions = await db
      .select()
      .from(eventTypeVersions)
      .where(eq(eventTypeVersions.eventTypeId, initialDraft.eventTypeId));
    expect(versions).toHaveLength(2);
    const successor = versions.find((version) => version.version === 2);
    expect(successor?.supersedesVersionId).toBe(baseVersion.id);

    await expect(
      store.createDraft(
        {
          ...draftInputs[0]!,
          name: 'Secure',
        },
        metadata(
          'create-event-type-draft',
          actor,
          'issue10-independent-create-stale',
          new Date('2026-08-08T18:13:55.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('rejects stale same-draft update, preview, and publish revisions', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-revision-${randomUUID()}`;
    const originalInput = {
      target: {
        kind: 'new-event-type' as const,
        key,
        familyKey: key,
        templateMode: 'drill' as const,
      },
      name: 'Secure Drill',
      description: 'Original exact content.',
      enabled: true,
      templates: templates('drill', 'ORIGINAL REVISION'),
    };
    const original = await store.createDraft(
      originalInput,
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-revision-create',
        new Date('2026-08-08T18:14:00.000Z'),
      ),
    );
    const previewAgent = authenticatedPreviewAgent();
    const originalPreview = await executePreviewEventTypeRenderingCapability({
      store,
      authenticated: previewAgent,
      query: {
        draftId: original.id,
        expectedDraftRevision: original.draftRevision,
        eventKind: 'drill',
        purpose: 'activation',
      },
    });
    expect(originalPreview.draftRevision).toBe(original.draftRevision);

    const revised = await store.updateDraft(
      {
        draftId: original.id,
        expectedDraftRevision: original.draftRevision,
        name: 'Hold Drill',
        description: 'A newer exact revision.',
        enabled: false,
        templates: templates('drill', 'NEWER REVISION'),
      },
      metadata(
        'update-event-type-draft',
        actor,
        'issue10-revision-update',
        new Date('2026-08-08T18:14:10.000Z'),
      ),
    );
    expect(revised.draftRevision).not.toBe(original.draftRevision);

    await expect(
      store.updateDraft(
        {
          draftId: original.id,
          expectedDraftRevision: original.draftRevision,
          name: 'Shelter Drill',
          description: null,
          enabled: true,
          templates: templates('drill', 'STALE REVISION'),
        },
        metadata(
          'update-event-type-draft',
          actor,
          'issue10-revision-stale-update',
          new Date('2026-08-08T18:14:20.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      executePreviewEventTypeRenderingCapability({
        store,
        authenticated: previewAgent,
        query: {
          draftId: original.id,
          expectedDraftRevision: original.draftRevision,
          eventKind: 'drill',
          purpose: 'activation',
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      store.publishVersion(
        {
          draftId: original.id,
          expectedDraftRevision: original.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-revision-stale-publish',
          new Date('2026-08-08T18:14:30.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const restored = await store.updateDraft(
      {
        draftId: original.id,
        expectedDraftRevision: revised.draftRevision,
        name: originalInput.name,
        description: originalInput.description,
        enabled: originalInput.enabled,
        templates: originalInput.templates,
      },
      metadata(
        'update-event-type-draft',
        actor,
        'issue10-revision-restore-content',
        new Date('2026-08-08T18:14:40.000Z'),
      ),
    );
    expect(restored.name).toBe(original.name);
    expect(restored.templates).toEqual(original.templates);
    expect(restored.draftRevision).not.toBe(original.draftRevision);
    const currentPreview = await executePreviewEventTypeRenderingCapability({
      store,
      authenticated: previewAgent,
      query: {
        draftId: restored.id,
        expectedDraftRevision: restored.draftRevision,
        eventKind: 'drill',
        purpose: 'activation',
      },
    });
    expect(currentPreview.draftRevision).toBe(restored.draftRevision);
  });

  test('publishes disable and re-enable changes as immutable versions', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-enabled-${randomUUID()}`;
    const initialDraft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'real',
        },
        name: 'Medical',
        description: null,
        enabled: true,
        templates: templates('real', 'AVAILABLE'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-enabled-create',
        new Date('2026-08-08T18:14:50.000Z'),
      ),
    );
    const enabledV1 = await store.publishVersion(
      {
        draftId: initialDraft.id,
        expectedDraftRevision: initialDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-enabled-publish',
        new Date('2026-08-08T18:15:00.000Z'),
      ),
    );
    const disableDraft = await store.createDraft(
      {
        target: {
          kind: 'existing-event-type',
          eventTypeId: initialDraft.eventTypeId,
          baseVersionId: enabledV1.id,
        },
        name: enabledV1.name,
        description: enabledV1.description,
        enabled: false,
        templates: enabledV1.templates,
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-disable-create',
        new Date('2026-08-08T18:15:10.000Z'),
      ),
    );
    const disabledV2 = await store.publishVersion(
      {
        draftId: disableDraft.id,
        expectedDraftRevision: disableDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-disable-publish',
        new Date('2026-08-08T18:15:20.000Z'),
      ),
    );
    expect(disabledV2.enabled).toBe(false);
    expect(disabledV2.supersedesVersionId).toBe(enabledV1.id);
    expect(
      (
        await store.list({
          templateMode: 'real',
          enabled: true,
          cursor: null,
          limit: 200,
        })
      ).items.some((item) => item.eventType.id === initialDraft.eventTypeId),
    ).toBe(false);
    expect(
      (
        await store.list({
          templateMode: 'real',
          enabled: false,
          cursor: null,
          limit: 200,
        })
      ).items.some((item) => item.eventType.id === initialDraft.eventTypeId),
    ).toBe(true);
    expect(
      (await store.getVersion({ eventTypeVersionId: enabledV1.id })).enabled,
    ).toBe(true);

    const enableDraft = await store.createDraft(
      {
        target: {
          kind: 'existing-event-type',
          eventTypeId: initialDraft.eventTypeId,
          baseVersionId: disabledV2.id,
        },
        name: disabledV2.name,
        description: disabledV2.description,
        enabled: true,
        templates: disabledV2.templates,
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-reenable-create',
        new Date('2026-08-08T18:15:30.000Z'),
      ),
    );
    const enabledV3 = await store.publishVersion(
      {
        draftId: enableDraft.id,
        expectedDraftRevision: enableDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-reenable-publish',
        new Date('2026-08-08T18:15:40.000Z'),
      ),
    );
    expect(enabledV3.version).toBe(3);
    expect(enabledV3.enabled).toBe(true);
    expect(enabledV3.supersedesVersionId).toBe(disabledV2.id);
    expect(
      (await store.getVersion({ eventTypeVersionId: disabledV2.id })).enabled,
    ).toBe(false);
  });

  test('allows only the actor who last saved a draft to publish its wording', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const originalActor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const latestActor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-author-${randomUUID()}`;
    const draft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'real',
        },
        name: 'Wildlife',
        description: 'A draft whose final author must remain attributable.',
        enabled: true,
        templates: templates('real', 'ORIGINAL AUTHOR COPY'),
      },
      metadata(
        'create-event-type-draft',
        originalActor,
        'issue10-author-create',
        new Date('2026-08-08T18:15:00.000Z'),
      ),
    );
    const revisedDraft = await store.updateDraft(
      {
        draftId: draft.id,
        expectedDraftRevision: draft.draftRevision,
        name: 'Fire',
        description: 'The latest actor supplied this complete revision.',
        enabled: true,
        templates: templates('real', 'LATEST AUTHOR COPY'),
      },
      metadata(
        'update-event-type-draft',
        latestActor,
        'issue10-author-update',
        new Date('2026-08-08T18:16:00.000Z'),
      ),
    );

    await expect(
      store.publishVersion(
        {
          draftId: draft.id,
          expectedDraftRevision: revisedDraft.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          originalActor,
          'issue10-author-stale-publish',
          new Date('2026-08-08T18:17:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Only the actor who last saved this draft can publish it.',
    });

    const published = await store.publishVersion(
      {
        draftId: draft.id,
        expectedDraftRevision: revisedDraft.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        latestActor,
        'issue10-author-current-publish',
        new Date('2026-08-08T18:18:00.000Z'),
      ),
    );
    expect(published.name).toBe('Fire');
    expect(published.createdBy).toEqual(latestActor);
    expect(published.publicationAuthorization).toMatchObject({
      kind: 'human-admin',
      approvalReference: `event-type-draft:${draft.id}:revision:${revisedDraft.draftRevision}`,
    });
    expect(published.templates.activation.push.title).toBe(
      '{{eventType}} update',
    );
  });

  test('serializes concurrent update and publish without a torn version', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-race-${randomUUID()}`;
    const draft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type' as const,
          key,
          familyKey: key,
          templateMode: 'real' as const,
        },
        name: 'Modified Lockdown',
        description: 'Original draft awaiting a concurrent edit.',
        enabled: true,
        templates: templates('real', 'ORIGINAL CONCURRENT COPY'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-race-create',
        new Date('2026-08-08T18:20:00.000Z'),
      ),
    );
    const updateInput = {
      draftId: draft.id,
      expectedDraftRevision: draft.draftRevision,
      name: 'Secure',
      description: 'The complete revision that publication must observe.',
      enabled: true,
      templates: templates('real', 'UPDATED CONCURRENT COPY'),
    };
    const operations = await db.transaction(async (transaction) => {
      await transaction
        .select({ id: eventTypes.id })
        .from(eventTypes)
        .where(eq(eventTypes.id, draft.eventTypeId))
        .for('update');
      const [backend] = await transaction.execute<{ blocker_pid: number }>(sql`
        select pg_backend_pid()::integer as blocker_pid
      `);
      if (backend === undefined) {
        throw new Error('Could not resolve the lock-holder backend.');
      }

      const updatePromise = store.updateDraft(
        updateInput,
        metadata(
          'update-event-type-draft',
          actor,
          'issue10-race-update',
          new Date('2026-08-08T18:21:00.000Z'),
        ),
      );
      const updatePid = await waitForBlockedBackend(
        db,
        (row) => row.blockers.includes(backend.blocker_pid),
        'the draft update to hold the draft lock and wait on its identity',
      );
      const publishPromise = store.publishVersion(
        {
          draftId: draft.id,
          expectedDraftRevision: draft.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-race-publish',
          new Date('2026-08-08T18:22:00.000Z'),
        ),
      );
      await waitForBlockedBackend(
        db,
        (row) =>
          row.pid !== updatePid &&
          (row.blockers.includes(updatePid) ||
            row.blockers.includes(backend.blocker_pid)),
        'publication to wait behind the in-flight draft update',
      );
      return { updatePromise, publishPromise };
    });

    const [updateOutcome, publishOutcome] = await Promise.allSettled([
      operations.updatePromise,
      operations.publishPromise,
    ]);
    if (updateOutcome.status !== 'fulfilled') {
      throw updateOutcome.reason;
    }
    expect(publishOutcome).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'CONFLICT',
        message:
          'The event-type draft changed after this copy was loaded. Reload the draft before continuing.',
      },
    });
    expect(updateOutcome.value.name).toBe(updateInput.name);
    const published = await store.publishVersion(
      {
        draftId: draft.id,
        expectedDraftRevision: updateOutcome.value.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-race-publish-current',
        new Date('2026-08-08T18:22:30.000Z'),
      ),
    );
    expect(published.name).toBe(updateInput.name);
    expect(published.description).toBe(updateInput.description);
    expect(published.templates).toEqual(updateInput.templates);

    await expect(
      store.updateDraft(
        {
          ...updateInput,
          expectedDraftRevision: updateOutcome.value.draftRevision,
          name: 'Medical',
        },
        metadata(
          'update-event-type-draft',
          actor,
          'issue10-race-update-after-publish',
          new Date('2026-08-08T18:23:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('rejects authoritative draft wording tampering before immutable publication', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-publication-validation-${randomUUID()}`;
    const draft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'drill',
        },
        name: 'Shelter Drill',
        description: null,
        enabled: true,
        templates: templates('drill', 'PUBLICATION VALIDATION'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-publication-validation-create',
        new Date('2026-08-08T18:30:00.000Z'),
      ),
    );
    await db
      .update(eventTypeDraftTemplates)
      .set({
        body: 'REAL INCIDENT — NOT A DRILL. Follow emergency directions.',
      })
      .where(
        and(
          eq(eventTypeDraftTemplates.eventTypeVersionDraftId, draft.id),
          eq(eventTypeDraftTemplates.purpose, 'activation'),
          eq(eventTypeDraftTemplates.channel, 'sms'),
        ),
      );

    await expect(
      store.publishVersion(
        {
          draftId: draft.id,
          expectedDraftRevision: draft.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-publication-validation-publish',
          new Date('2026-08-08T18:31:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The event-type draft revision history is incomplete or inconsistent.',
    });
    expect(
      await db
        .select({ id: eventTypeVersions.id })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.eventTypeId, draft.eventTypeId)),
    ).toHaveLength(0);
  });

  test('fails closed when the append-only draft revision ledger is forked', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-ledger-corruption-${randomUUID()}`;
    const draft = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'real',
        },
        name: 'Fire',
        description: null,
        enabled: true,
        templates: templates('real', 'LEDGER INTEGRITY'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-ledger-create',
        new Date('2026-08-08T18:32:00.000Z'),
      ),
    );
    await store.updateDraft(
      {
        draftId: draft.id,
        expectedDraftRevision: draft.draftRevision,
        name: 'Earthquake',
        description: null,
        enabled: true,
        templates: templates('real', 'LEDGER INTEGRITY REVISED'),
      },
      metadata(
        'update-event-type-draft',
        actor,
        'issue10-ledger-update',
        new Date('2026-08-08T18:32:05.000Z'),
      ),
    );
    const [updateRecord] = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.capabilityId, 'update-event-type-draft'),
          like(
            idempotencyRecords.resultReference,
            `event-type-draft-v2:${draft.id}:%`,
          ),
        ),
      )
      .limit(1);
    if (updateRecord === undefined || updateRecord.resultReference === null) {
      throw new Error('The synthetic draft revision ledger was not written.');
    }
    const forkParts = updateRecord.resultReference.split(':');
    forkParts[5] = 'f'.repeat(64);
    if (forkParts.join(':') === updateRecord.resultReference) {
      forkParts[5] = 'e'.repeat(64);
    }
    await db.insert(idempotencyRecords).values({
      ...updateRecord,
      id: randomUUID(),
      key: `issue10-ledger-corrupt-${randomUUID()}`,
      createdAt: new Date('2026-08-08T18:32:10.000Z'),
      completedAt: new Date('2026-08-08T18:32:10.000Z'),
      resultReference: forkParts.join(':'),
    });

    await expect(store.getDraft({ draftId: draft.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The event-type draft revision history is incomplete or inconsistent.',
    });
  });

  test('renders reviewed lock-screen seed copy for all four real/drill families', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const page = await store.list({
      templateMode: null,
      enabled: true,
      cursor: null,
      limit: 200,
    });
    const expected = new Set([
      'Lockdown',
      'Lockdown Drill',
      'Modified Lockdown',
      'Modified Lockdown Drill',
      'Medical',
      'Medical Drill',
      'Wildlife',
      'Wildlife Drill',
    ]);
    const seeded = page.items.filter((item) =>
      expected.has(item.latestVersion.name),
    );
    expect(new Set(seeded.map((item) => item.latestVersion.name))).toEqual(
      expected,
    );

    for (const item of seeded) {
      const drill = item.eventType.templateMode === 'drill';
      const marker = drill ? '[DRILL]' : '[INCIDENT]';
      const messages = renderTemplateSet({
        eventKind: drill ? 'drill' : 'incident',
        templates: item.latestVersion.templates.activation,
        variables: {
          site: 'Harbor Ridge High School',
          eventType: item.latestVersion.name,
          startTime: '2026-08-08T16:30:00.000Z',
          initiator: 'Taylor Morgan',
        },
      });
      const push = messages.find((message) => message.channel === 'push');
      const sms = messages.find((message) => message.channel === 'sms');
      if (push?.channel !== 'push' || sms?.channel !== 'sms') {
        throw new Error('Seed rendering omitted a lock-screen channel.');
      }
      expect(push.title.startsWith(marker)).toBe(true);
      expect(push.body.startsWith(marker)).toBe(true);
      expect(sms.body.startsWith(marker)).toBe(true);
      expect(push.title).toContain(item.latestVersion.name);
      expect(sms.body).toContain(item.latestVersion.name);
      expect(push.title.length).toBeLessThanOrEqual(120);
      expect(push.body.length).toBeLessThanOrEqual(500);
      expect(measureSmsLength(sms.body).exceedsProviderLimit).toBe(false);
      if (drill) {
        expect(`${push.title} ${push.body} ${sms.body}`).toContain(
          'TRAINING ONLY',
        );
      } else {
        expect(`${push.title} ${push.body} ${sms.body}`).not.toContain(
          '[DRILL]',
        );
      }
    }
  });

  test('accepts arbitrary safe event names but rejects renderer markers and control text before persistence', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    for (const [index, templateMode, name] of [
      [0, 'real', 'SRP D-010 — Lockdown Drill — echter Notfall'],
      [1, 'drill', 'SRP D-010 — Simulacro de emergencia 安全訓練'],
    ] as const) {
      const key = `issue-10-arbitrary-name-${index}-${randomUUID()}`;
      const draft = await store.createDraft(
        {
          target: {
            kind: 'new-event-type',
            key,
            familyKey: key,
            templateMode,
          },
          name,
          description: null,
          enabled: true,
          templates: templates(templateMode, 'ARBITRARY SAFE NAME'),
        },
        metadata(
          'create-event-type-draft',
          actor,
          `issue10-arbitrary-name-${index}`,
          new Date(`2026-08-08T18:58:0${index}.000Z`),
        ),
      );
      expect(draft.name).toBe(name);
      expect(
        await db
          .select({ id: eventTypes.id })
          .from(eventTypes)
          .where(eq(eventTypes.key, key)),
      ).toHaveLength(1);
    }

    for (const [index, name, errorCode] of [
      [0, '[DRILL] Secure', 'RESERVED_MARKER'],
      [1, 'Secure\u0007', 'INVALID_VARIABLE'],
      [2, 'Secure\u200B', 'INVALID_VARIABLE'],
      [3, 'Secure ［INCIDENT］', 'RESERVED_MARKER'],
      [4, 'Secure [INСIDENT]', 'RESERVED_MARKER'],
    ] as const) {
      const key = `issue-10-unsafe-name-${index}-${randomUUID()}`;
      await expect(
        store.createDraft(
          {
            target: {
              kind: 'new-event-type',
              key,
              familyKey: key,
              templateMode: 'real',
            },
            name,
            description: null,
            enabled: true,
            templates: templates('real', 'UNSAFE NAME'),
          },
          metadata(
            'create-event-type-draft',
            actor,
            `issue10-unsafe-name-${index}`,
            new Date(`2026-08-08T18:59:0${index}.000Z`),
          ),
        ),
      ).rejects.toMatchObject({ code: errorCode });
      expect(
        await db
          .select({ id: eventTypes.id })
          .from(eventTypes)
          .where(eq(eventTypes.key, key)),
      ).toHaveLength(0);
    }
  });

  test('recovers a lost zero-version draft as new append-only state and preserves exact idempotency', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const originalActor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const recoveringActor = {
      ...originalActor,
      sessionId: randomUUID(),
    };
    const key = `issue-10-recovery-${randomUUID()}`;
    const originalInput = {
      target: {
        kind: 'new-event-type' as const,
        key,
        familyKey: key,
        templateMode: 'real' as const,
      },
      name: 'Secure',
      description: 'The browser-local draft identifier will be lost.',
      enabled: true,
      templates: templates('real', 'ORIGINAL RECOVERY COPY'),
    };
    const originalMetadata = metadata(
      'create-event-type-draft',
      originalActor,
      'issue10-recovery-original',
      new Date('2026-08-08T19:00:00.000Z'),
    );
    const original = await store.createDraft(originalInput, originalMetadata);

    const recoveryInput = {
      ...originalInput,
      name: 'Hold',
      description: 'A fresh draft recovered after browser state was lost.',
      enabled: false,
      templates: templates('real', 'RECOVERED COPY'),
    };
    const recoveryMetadata = metadata(
      'create-event-type-draft',
      recoveringActor,
      'issue10-recovery-fresh',
      new Date('2026-08-08T19:01:00.000Z'),
    );
    const recovered = await store.createDraft(recoveryInput, recoveryMetadata);

    expect(recovered.eventTypeId).toBe(original.eventTypeId);
    expect(recovered.id).not.toBe(original.id);
    expect(recovered.baseVersionId).toBeNull();
    expect(recovered.draftedBy).toEqual(recoveringActor);
    expect(await store.createDraft(recoveryInput, recoveryMetadata)).toEqual(
      recovered,
    );

    const retainedOriginal = await store.getDraft({ draftId: original.id });
    expect(retainedOriginal).toEqual(original);
    expect(await store.getDraft({ draftId: recovered.id })).toEqual(recovered);
    const retainedRows = await db
      .select({
        id: eventTypeVersionDrafts.id,
        eventTypeId: eventTypeVersionDrafts.eventTypeId,
      })
      .from(eventTypeVersionDrafts)
      .where(eq(eventTypeVersionDrafts.eventTypeId, original.eventTypeId));
    expect(retainedRows).toHaveLength(2);
    expect(new Set(retainedRows.map((row) => row.id))).toEqual(
      new Set([original.id, recovered.id]),
    );
    for (const draft of [original, recovered]) {
      const ledgerRoots = await db
        .select({ resultReference: idempotencyRecords.resultReference })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'create-event-type-draft'),
            eq(idempotencyRecords.status, 'completed'),
            like(
              idempotencyRecords.resultReference,
              `event-type-draft-v2:${draft.id}:%`,
            ),
          ),
        );
      expect(ledgerRoots).toHaveLength(1);
    }

    const published = await store.publishVersion(
      {
        draftId: recovered.id,
        expectedDraftRevision: recovered.draftRevision,
      },
      metadata(
        'publish-event-type-version',
        recoveringActor,
        'issue10-recovery-publish',
        new Date('2026-08-08T19:02:00.000Z'),
      ),
    );
    expect(published.version).toBe(1);
    expect(published.name).toBe(recoveryInput.name);
    await expect(
      store.createDraft(
        { ...recoveryInput, name: 'Shelter' },
        metadata(
          'create-event-type-draft',
          recoveringActor,
          'issue10-recovery-after-publish',
          new Date('2026-08-08T19:03:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The stable event-type key already belongs to a published event type.',
      status: 409,
    });
    expect(
      await db
        .select({ id: eventTypeVersionDrafts.id })
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.eventTypeId, original.eventTypeId)),
    ).toHaveLength(2);
  });

  test('serializes same-key draft recovery and retains an independent ledger root for each request', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-recovery-race-${randomUUID()}`;
    const requests = [
      { name: 'Medical', label: 'RECOVERY RACE ALPHA' },
      { name: 'Shelter', label: 'RECOVERY RACE BRAVO' },
    ].map(({ name, label }, index) => ({
      input: {
        target: {
          kind: 'new-event-type' as const,
          key,
          familyKey: key,
          templateMode: 'real' as const,
        },
        name,
        description: `Concurrent recovery request ${index + 1}.`,
        enabled: true,
        templates: templates('real', label),
      },
      metadata: metadata(
        'create-event-type-draft',
        actor,
        `issue10-recovery-race-${index}`,
        new Date(`2026-08-08T19:1${index}:00.000Z`),
      ),
    }));

    const creationPromises = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`event-type-key:${key}`}, 4010))`,
      );
      const [backend] = await transaction.execute<{ blockerPid: number }>(sql`
        select pg_backend_pid()::integer as "blockerPid"
      `);
      if (backend === undefined) {
        throw new Error('Could not resolve the stable-key lock holder.');
      }
      const pending = requests.map((request) =>
        store.createDraft(request.input, request.metadata),
      );
      await waitForBlockedBackend(
        db,
        (row) => row.blockers.includes(backend.blockerPid),
        'same-key event-type creation to wait on the stable-key lock',
      );
      return pending;
    });
    const created = await Promise.all(creationPromises);

    expect(new Set(created.map((draft) => draft.eventTypeId)).size).toBe(1);
    expect(new Set(created.map((draft) => draft.id)).size).toBe(2);
    expect(
      await db
        .select({ id: eventTypes.id })
        .from(eventTypes)
        .where(eq(eventTypes.key, key)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: eventTypeVersionDrafts.id })
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.eventTypeId, created[0]!.eventTypeId)),
    ).toHaveLength(2);
    for (const [index, draft] of created.entries()) {
      expect(await store.getDraft({ draftId: draft.id })).toEqual(draft);
      expect(
        await store.createDraft(
          requests[index]!.input,
          requests[index]!.metadata,
        ),
      ).toEqual(draft);
      const ledgerRoots = await db
        .select({ resultReference: idempotencyRecords.resultReference })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'create-event-type-draft'),
            eq(idempotencyRecords.status, 'completed'),
            like(
              idempotencyRecords.resultReference,
              `event-type-draft-v2:${draft.id}:%`,
            ),
          ),
        );
      expect(ledgerRoots).toHaveLength(1);
    }
  });

  test('linearizes recovery and publication in either identity-lock order without stranding the event type', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const originalActor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const recoveringActor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };

    const recoveryFirstKey = `issue-10-recovery-first-${randomUUID()}`;
    const recoveryFirstOriginal = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key: recoveryFirstKey,
          familyKey: recoveryFirstKey,
          templateMode: 'real',
        },
        name: 'Secure',
        description: 'Original draft before a forced recovery-first race.',
        enabled: true,
        templates: templates('real', 'RECOVERY FIRST ORIGINAL'),
      },
      metadata(
        'create-event-type-draft',
        originalActor,
        'issue10-recovery-first-original',
        new Date('2026-08-08T19:30:00.000Z'),
      ),
    );
    const recoveryFirstInput = {
      target: {
        kind: 'new-event-type' as const,
        key: recoveryFirstKey,
        familyKey: recoveryFirstKey,
        templateMode: 'real' as const,
      },
      name: 'Hold',
      description: 'Recovered while publication was waiting.',
      enabled: true,
      templates: templates('real', 'RECOVERY FIRST FRESH'),
    };
    const recoveryFirstOperations = await startInIdentityLockOrder(
      db,
      recoveryFirstOriginal.eventTypeId,
      () =>
        store.createDraft(
          recoveryFirstInput,
          metadata(
            'create-event-type-draft',
            recoveringActor,
            'issue10-recovery-first-fresh',
            new Date('2026-08-08T19:31:00.000Z'),
          ),
        ),
      () =>
        store.publishVersion(
          {
            draftId: recoveryFirstOriginal.id,
            expectedDraftRevision: recoveryFirstOriginal.draftRevision,
          },
          metadata(
            'publish-event-type-version',
            originalActor,
            'issue10-recovery-first-publish-original',
            new Date('2026-08-08T19:32:00.000Z'),
          ),
        ),
      'recovery-before-publication',
    );
    const [recoveredFirst, publishedAfterRecovery] = await Promise.all(
      recoveryFirstOperations,
    );
    expect(recoveredFirst.eventTypeId).toBe(recoveryFirstOriginal.eventTypeId);
    expect(publishedAfterRecovery.version).toBe(1);
    await expect(
      store.publishVersion(
        {
          draftId: recoveredFirst.id,
          expectedDraftRevision: recoveredFirst.draftRevision,
        },
        metadata(
          'publish-event-type-version',
          recoveringActor,
          'issue10-recovery-first-publish-stale',
          new Date('2026-08-08T19:33:00.000Z'),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The event type changed after this draft was started. Reload the latest version and create a new draft.',
    });
    const recoveredFromV1 = await store.createDraft(
      {
        target: {
          kind: 'existing-event-type',
          eventTypeId: recoveryFirstOriginal.eventTypeId,
          baseVersionId: publishedAfterRecovery.id,
        },
        name: 'Medical',
        description: 'A discoverable draft based on the published version.',
        enabled: true,
        templates: templates('real', 'RECOVERED FROM V1'),
      },
      metadata(
        'create-event-type-draft',
        recoveringActor,
        'issue10-recovery-first-from-v1',
        new Date('2026-08-08T19:34:00.000Z'),
      ),
    );
    expect(recoveredFromV1.baseVersionId).toBe(publishedAfterRecovery.id);
    expect(
      (
        await store.list({
          templateMode: 'real',
          enabled: true,
          cursor: null,
          limit: 200,
        })
      ).items.some(
        (item) =>
          item.eventType.id === recoveryFirstOriginal.eventTypeId &&
          item.latestVersion.id === publishedAfterRecovery.id,
      ),
    ).toBe(true);

    const publishFirstKey = `issue-10-publish-first-${randomUUID()}`;
    const publishFirstOriginal = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key: publishFirstKey,
          familyKey: publishFirstKey,
          templateMode: 'real',
        },
        name: 'Shelter',
        description: 'Original draft before a forced publish-first race.',
        enabled: true,
        templates: templates('real', 'PUBLISH FIRST ORIGINAL'),
      },
      metadata(
        'create-event-type-draft',
        originalActor,
        'issue10-publish-first-original',
        new Date('2026-08-08T19:35:00.000Z'),
      ),
    );
    const publishFirstOperations = await startInIdentityLockOrder(
      db,
      publishFirstOriginal.eventTypeId,
      () =>
        store.publishVersion(
          {
            draftId: publishFirstOriginal.id,
            expectedDraftRevision: publishFirstOriginal.draftRevision,
          },
          metadata(
            'publish-event-type-version',
            originalActor,
            'issue10-publish-first-publish',
            new Date('2026-08-08T19:36:00.000Z'),
          ),
        ),
      () =>
        store.createDraft(
          {
            target: {
              kind: 'new-event-type',
              key: publishFirstKey,
              familyKey: publishFirstKey,
              templateMode: 'real',
            },
            name: 'Evacuate',
            description: 'A recovery request queued behind publication.',
            enabled: true,
            templates: templates('real', 'PUBLISH FIRST RECOVERY'),
          },
          metadata(
            'create-event-type-draft',
            recoveringActor,
            'issue10-publish-first-recovery',
            new Date('2026-08-08T19:37:00.000Z'),
          ),
        ),
      'publication-before-recovery',
    );
    const [publishFirstOutcome, recoveryAfterPublishOutcome] =
      await Promise.allSettled(publishFirstOperations);
    if (publishFirstOutcome.status !== 'fulfilled') {
      throw publishFirstOutcome.reason;
    }
    expect(publishFirstOutcome.value.version).toBe(1);
    expect(recoveryAfterPublishOutcome).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'CONFLICT',
        message:
          'The stable event-type key already belongs to a published event type.',
      },
    });
    expect(
      (
        await store.list({
          templateMode: 'real',
          enabled: true,
          cursor: null,
          limit: 200,
        })
      ).items.some(
        (item) =>
          item.eventType.id === publishFirstOriginal.eventTypeId &&
          item.latestVersion.id === publishFirstOutcome.value.id,
      ),
    ).toBe(true);
  });

  test('rejects immutable family or mode reuse without leaking or retaining database conflicts', async () => {
    const db = databaseConnection().db;
    const store = new DrizzleEventTypeStore(db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-recovery-identity-${randomUUID()}`;
    const original = await store.createDraft(
      {
        target: {
          kind: 'new-event-type',
          key,
          familyKey: key,
          templateMode: 'real',
        },
        name: 'Secure',
        description: null,
        enabled: true,
        templates: templates('real', 'IMMUTABLE ORIGINAL'),
      },
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-recovery-identity-original',
        new Date('2026-08-08T19:20:00.000Z'),
      ),
    );
    const familyMetadata = metadata(
      'create-event-type-draft',
      actor,
      'issue10-recovery-family-mismatch',
      new Date('2026-08-08T19:21:00.000Z'),
    );
    const modeMetadata = metadata(
      'create-event-type-draft',
      actor,
      'issue10-recovery-mode-mismatch',
      new Date('2026-08-08T19:22:00.000Z'),
    );
    await expect(
      store.createDraft(
        {
          target: {
            kind: 'new-event-type',
            key,
            familyKey: `other-${randomUUID()}`,
            templateMode: 'real',
          },
          name: 'Hold',
          description: null,
          enabled: true,
          templates: templates('real', 'IMMUTABLE FAMILY MISMATCH'),
        },
        familyMetadata,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The stable event-type key belongs to a different immutable family or mode.',
      status: 409,
    });
    await expect(
      store.createDraft(
        {
          target: {
            kind: 'new-event-type',
            key,
            familyKey: key,
            templateMode: 'drill',
          },
          name: 'Secure Drill',
          description: null,
          enabled: true,
          templates: templates('drill', 'IMMUTABLE MODE MISMATCH'),
        },
        modeMetadata,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The stable event-type key belongs to a different immutable family or mode.',
      status: 409,
    });

    expect(
      await db
        .select({ id: eventTypes.id })
        .from(eventTypes)
        .where(eq(eventTypes.key, key)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: eventTypeVersionDrafts.id })
        .from(eventTypeVersionDrafts)
        .where(eq(eventTypeVersionDrafts.eventTypeId, original.eventTypeId)),
    ).toHaveLength(1);
    for (const rejectedMetadata of [familyMetadata, modeMetadata]) {
      expect(
        await db
          .select({ id: idempotencyRecords.id })
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.key, rejectedMetadata.idempotencyKey)),
      ).toHaveLength(0);
    }
  });
});
