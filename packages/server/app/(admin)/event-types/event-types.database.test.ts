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
import { and, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  eventTypeDraftTemplates,
  eventTypeVersions,
  eventTypes,
  facilities,
  events,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  DrizzleEventTypeStore,
  EventTypeCapabilityError,
  type EventTypeMutationMetadata,
} from '../../../lib/capabilities/event-types';
import {
  measureSmsLength,
  renderTemplateSet,
} from '../../../lib/notify/render';
import { requireSyntheticTestDatabaseUrl } from './test-database';

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
    throw new Error('The event-type integration database is not open.');
  }
  return connection;
}

function templates(mode: TemplateMode, label: string): MessageTemplateCatalog {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  const set = (purpose: NotificationPurpose) => ({
    templateMode: mode,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: mode,
      purpose,
      classificationMarker,
      title: `${label} {{eventType}} at {{site}}`,
      body: `${label} at {{site}}. Started {{startTime}} by {{initiator}}.`,
    },
    email: {
      channel: 'email' as const,
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: `${label} {{eventType}} at {{site}}`,
      textBody: `${label} {{eventType}} at {{site}}. Started {{startTime}} by {{initiator}}.`,
    },
    sms: {
      channel: 'sms' as const,
      templateMode: mode,
      purpose,
      classificationMarker,
      body: `${label} {{eventType}} at {{site}}. Open PSD EOC.`,
    },
  });
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

describeWithDatabase('event-type database versioning', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 4,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Event-type integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
    await seedDatabase(created.db);
  });

  afterAll(async () => {
    await connection?.close();
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
      name: 'Synthetic Secure',
      description: 'Synthetic event type used only by the database test.',
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
      { draftId: firstDraft.id },
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
        },
        name: 'Synthetic Secure Revised',
        description: 'A later immutable configuration.',
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
      { draftId: secondDraft.id },
      metadata(
        'publish-event-type-version',
        actor,
        'issue10-publish-v2',
        new Date('2026-08-08T18:04:00.000Z'),
      ),
    );
    expect(secondVersion.version).toBe(2);
    expect(secondVersion.supersedesVersionId).toBe(firstVersion.id);
    expect(secondVersion.templates.activation.push.title).toContain(
      'REVISED COPY',
    );

    const historical = await store.getVersion({
      eventTypeVersionId: firstVersion.id,
    });
    expect(historical.name).toBe('Synthetic Secure');
    expect(historical.templates.activation.push.title).toContain(
      'INITIAL COPY',
    );
    const [pinnedEvent] = await db
      .select({ eventTypeVersionId: events.eventTypeVersionId })
      .from(events)
      .where(eq(events.id, eventId));
    expect(pinnedEvent?.eventTypeVersionId).toBe(firstVersion.id);

    const duplicatePublish = await store.publishVersion(
      { draftId: secondDraft.id },
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
          name: 'Forbidden published-draft rewrite',
          description: null,
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
      name: 'Synthetic Replay Original',
      description: 'Original response wording.',
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
      name: 'Synthetic Replay Revision A',
      description: 'First saved revision.',
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
      name: 'Synthetic Replay Revision B',
      description: 'Current saved revision.',
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
    expect(current.templates).toEqual(updateBInput.templates);
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
        name: 'Synthetic Authorship Original',
        description: 'A draft whose final author must remain attributable.',
        templates: templates('real', 'ORIGINAL AUTHOR COPY'),
      },
      metadata(
        'create-event-type-draft',
        originalActor,
        'issue10-author-create',
        new Date('2026-08-08T18:15:00.000Z'),
      ),
    );
    await store.updateDraft(
      {
        draftId: draft.id,
        name: 'Synthetic Authorship Revised',
        description: 'The latest actor supplied this complete revision.',
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
        { draftId: draft.id },
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
      { draftId: draft.id },
      metadata(
        'publish-event-type-version',
        latestActor,
        'issue10-author-current-publish',
        new Date('2026-08-08T18:18:00.000Z'),
      ),
    );
    expect(published.name).toBe('Synthetic Authorship Revised');
    expect(published.createdBy).toEqual(latestActor);
    expect(published.templates.activation.push.title).toContain(
      'LATEST AUTHOR COPY',
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
        name: 'Synthetic Concurrent Original',
        description: 'Original draft awaiting a concurrent edit.',
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
      name: 'Synthetic Concurrent Updated',
      description: 'The complete revision that publication must observe.',
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
        { draftId: draft.id },
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
    if (publishOutcome.status !== 'fulfilled') {
      throw publishOutcome.reason;
    }
    expect(updateOutcome.value.name).toBe(updateInput.name);
    expect(publishOutcome.value.name).toBe(updateInput.name);
    expect(publishOutcome.value.description).toBe(updateInput.description);
    expect(publishOutcome.value.templates).toEqual(updateInput.templates);

    await expect(
      store.updateDraft(
        {
          ...updateInput,
          name: 'Forbidden post-publication edit',
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

  test('revalidates authoritative stored wording before immutable publication', async () => {
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
        name: 'Synthetic Publication Validation Drill',
        description: null,
        templates: templates('drill', 'TRAINING ONLY'),
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
        { draftId: draft.id },
        metadata(
          'publish-event-type-version',
          actor,
          'issue10-publication-validation-publish',
          new Date('2026-08-08T18:31:00.000Z'),
        ),
      ),
    ).rejects.toThrow('Drill wording cannot claim to be a real incident');
    expect(
      await db
        .select({ id: eventTypeVersions.id })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.eventTypeId, draft.eventTypeId)),
    ).toHaveLength(0);
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
          site: 'Synthetic Harbor High School',
          eventType: item.latestVersion.name,
          startTime: '2026-08-08T16:30:00.000Z',
          initiator: 'Synthetic Staff Member',
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

  test('uses a bounded conflict instead of leaking a database constraint', async () => {
    const store = new DrizzleEventTypeStore(databaseConnection().db);
    const actor = {
      kind: 'human' as const,
      userId: randomUUID(),
      sessionId: randomUUID(),
    };
    const key = `issue-10-conflict-${randomUUID()}`;
    const input = {
      target: {
        kind: 'new-event-type' as const,
        key,
        familyKey: key,
        templateMode: 'drill' as const,
      },
      name: 'Synthetic Conflict Drill',
      description: null,
      templates: templates('drill', 'TRAINING ONLY'),
    };
    await store.createDraft(
      input,
      metadata(
        'create-event-type-draft',
        actor,
        'issue10-first-key',
        new Date('2026-08-08T19:00:00.000Z'),
      ),
    );
    try {
      await store.createDraft(
        input,
        metadata(
          'create-event-type-draft',
          actor,
          'issue10-duplicate-key',
          new Date('2026-08-08T19:01:00.000Z'),
        ),
      );
      throw new Error('Expected the duplicate stable key to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(EventTypeCapabilityError);
      expect(error).toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(String(error)).not.toContain('event_types_key_uq');
    }
  });
});
