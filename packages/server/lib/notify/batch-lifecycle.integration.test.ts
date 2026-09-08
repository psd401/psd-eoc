import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { sql } from 'drizzle-orm';
import { DispatchBatchSchema, type DispatchBatch } from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  events,
  eventTransitions,
  rosterSnapshots,
  rosterSourceConfigurations,
} from '../../db/schema';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../testing/database';
import { batchHasCurrentLifecycle } from './batch-lifecycle';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const ACTIVATED_AT = new Date('2026-09-08T20:32:42.000Z');
const ALL_CLEAR_AT = new Date('2026-09-08T21:09:22.000Z');
const CLOSED_AT = new Date('2026-09-08T21:09:23.000Z');
const actor = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
const staffRoster = Object.freeze({
  configurationId: randomUUID(),
  snapshotId: randomUUID(),
});

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) {
    throw new Error('The batch lifecycle test connection is not open.');
  }
  return connection.db;
}

function activationAuthorization(requestId: string) {
  return Object.freeze({
    kind: 'human-confirmed' as const,
    activationPreviewId: randomUUID(),
    preparedActivationId: null,
    confirmationId: randomUUID(),
    consequenceDigest: 'a'.repeat(64),
    requestId,
  });
}

function allClearAuthorization(requestId: string, transitionId: string) {
  return Object.freeze({
    kind: 'human-confirmed-lifecycle' as const,
    purpose: 'all-clear' as const,
    targeting: Object.freeze({
      kind: 'drill' as const,
      templateMode: 'drill' as const,
      rosterPopulation: 'staff' as const,
    }),
    lifecyclePreviewId: randomUUID(),
    transitionId,
    actionIds: ['all-clear' as const, 'send-real-notification' as const],
    confirmationId: randomUUID(),
    consequenceDigest: 'c'.repeat(64),
    requestId,
  });
}

/**
 * One drill that was activated, then cleared, and then optionally closed a
 * second later: the sequence the event room's "End event" produces.
 */
async function installDrill(
  status: 'active' | 'all-clear' | 'closed',
  options: Readonly<{ reactivatedAt?: Date }> = {},
): Promise<
  Readonly<{
    eventId: string;
    activation: ReturnType<typeof activationAuthorization>;
    allClear: ReturnType<typeof allClearAuthorization> | null;
  }>
> {
  const eventId = randomUUID();
  const activationRequestId = randomUUID();
  const activation = activationAuthorization(activationRequestId);
  const cleared = status !== 'active' || options.reactivatedAt !== undefined;
  const transitionId = randomUUID();
  const allClearRequestId = randomUUID();
  const allClear = cleared
    ? allClearAuthorization(allClearRequestId, transitionId)
    : null;
  await database().transaction(async (transaction) => {
    await transaction.insert(events).values({
      id: eventId,
      facilityId: FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersionId: EVENT_TYPE_VERSION_ID,
      status,
      rosterSnapshotId: staffRoster.snapshotId,
      rosterPopulation: 'staff',
      createdBy: actor,
      createdAt: ACTIVATED_AT,
      activatedAt: ACTIVATED_AT,
      allClearAt: cleared ? ALL_CLEAR_AT : null,
      reactivatedAt: options.reactivatedAt ?? null,
      closedAt: status === 'closed' ? CLOSED_AT : null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: activation,
    });
  });
  if (allClear !== null) {
    await database().transaction(async (transaction) => {
      await transaction.execute(
        sql`set local session_replication_role = replica`,
      );
      await transaction.insert(eventTransitions).values({
        id: transitionId,
        sequence: 2,
        transition: 'all-clear',
        eventId,
        sourceEventId: null,
        correctionEventId: null,
        journalEventId: eventId,
        fromStatus: 'active',
        toStatus: 'all-clear',
        kind: 'drill',
        templateMode: 'drill',
        rosterPopulation: 'staff',
        actor,
        source: 'web',
        occurredAt: ALL_CLEAR_AT,
        requestId: allClearRequestId,
        // A staff all-clear must name a consumed human confirmation. The
        // confirmation record itself sits behind sessions and connectivity
        // epochs that nothing here reads, so only its foreign key is skipped
        // (replica mode disables the key trigger); every CHECK rule on the
        // transition row still applies.
        confirmationId: randomUUID(),
        confirmationStatus: 'consumed',
        consequenceDigest: allClear.consequenceDigest,
        idempotencyKey: randomUUID(),
        activationAuthorization: null,
        notificationAuthorization: allClear,
        correctionReason: null,
      });
    });
  }
  return Object.freeze({ eventId, activation, allClear });
}

function batch(
  eventId: string,
  purpose: 'activation' | 'all-clear',
  authorization:
    | ReturnType<typeof activationAuthorization>
    | ReturnType<typeof allClearAuthorization>,
  channel: 'sms' | 'email' = 'sms',
): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: randomUUID(),
    intentId: randomUUID(),
    eventId,
    facilityId: FACILITY_ID,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose,
    eventTypeVersion: { id: EVENT_TYPE_VERSION_ID, templateMode: 'drill' },
    rosterSnapshotId: randomUUID(),
    rosterPopulation: 'staff',
    requestId: authorization.requestId,
    authorization,
    channel,
    renderedMessage:
      channel === 'sms'
        ? {
            eventKind: 'drill',
            templateMode: 'drill',
            purpose,
            classificationMarker: 'DRILL',
            channel: 'sms',
            body: '[DRILL] Synthetic lifecycle test only.',
          }
        : {
            eventKind: 'drill',
            templateMode: 'drill',
            purpose,
            classificationMarker: 'DRILL',
            channel: 'email',
            subject: '[DRILL] Synthetic lifecycle test',
            textBody: '[DRILL] Synthetic lifecycle test only.',
          },
    integrationId: channel === 'sms' ? 'aws-eum-sms' : 'ses-email',
    sequence: channel === 'sms' ? 3 : 2,
    endpointCount: 1,
    createdAt: (purpose === 'activation'
      ? ACTIVATED_AT
      : ALL_CLEAR_AT
    ).toISOString(),
  });
}

describeWithDatabase('dispatch batch lifecycle currency', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for lifecycle tests.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_batch_lifecycle',
      baseTestDatabaseUrl,
    );
    ownedDatabase = owned;
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The lifecycle integration test requires PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    // The seed's only snapshot is synthetic; a staff drill needs a staff one.
    await opened.db.transaction(async (transaction) => {
      await transaction.insert(rosterSourceConfigurations).values({
        id: staffRoster.configurationId,
        version: 1,
        population: 'staff',
        createdAt: ACTIVATED_AT,
      });
      await transaction.insert(rosterSnapshots).values({
        id: staffRoster.snapshotId,
        version: 1,
        population: 'staff',
        complete: true,
        sourceConfigurationId: staffRoster.configurationId,
        sourceConfigurationVersion: 1,
        syncStartedAt: ACTIVATED_AT,
        capturedAt: ACTIVATED_AT,
      });
    });
  });

  afterAll(async () => {
    if (ownedDatabase !== undefined) {
      const opened = connection;
      await closeAndDropDisposableDatabase(
        () => opened?.close() ?? Promise.resolve(),
        ownedDatabase,
      );
    }
  });

  test('an activation is current only while the event is active under the same authorization', async () => {
    const active = await installDrill('active');
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(active.eventId, 'activation', active.activation),
      ),
    ).resolves.toBe(true);
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(
          active.eventId,
          'activation',
          activationAuthorization(randomUUID()),
        ),
      ),
    ).resolves.toBe(false);
    const closed = await installDrill('closed');
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(closed.eventId, 'activation', closed.activation),
      ),
    ).resolves.toBe(false);
  });

  test('an all-clear is current while the event stands at all-clear', async () => {
    const cleared = await installDrill('all-clear');
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(cleared.eventId, 'all-clear', cleared.allClear!),
      ),
    ).resolves.toBe(true);
  });

  test('an all-clear stays current after the event is ended into closed, for every channel', async () => {
    // "End event" issues the all-clear and closes the event one second later.
    // The all-clear is the message staff are told the event ended by, so the
    // close must not take it back. Before this rule, SMS refused every such
    // all-clear and email refused every all-clear at all.
    const closed = await installDrill('closed');
    for (const channel of ['sms', 'email'] as const) {
      await expect(
        batchHasCurrentLifecycle(
          database(),
          batch(closed.eventId, 'all-clear', closed.allClear!, channel),
          channel === 'email' ? 'no key update' : null,
        ),
      ).resolves.toBe(true);
    }
  });

  test('a closed event does not revive an all-clear confirmed under another request or superseded by reactivation', async () => {
    const closed = await installDrill('closed');
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(
          closed.eventId,
          'all-clear',
          allClearAuthorization(randomUUID(), closed.allClear!.transitionId),
        ),
      ),
    ).resolves.toBe(false);
    const reactivated = await installDrill('active', {
      reactivatedAt: CLOSED_AT,
    });
    await expect(
      batchHasCurrentLifecycle(
        database(),
        batch(
          reactivated.eventId,
          'all-clear',
          allClearAuthorization(randomUUID(), randomUUID()),
        ),
      ),
    ).resolves.toBe(false);
  });
});
