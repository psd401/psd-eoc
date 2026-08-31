import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { Actor } from '@psd-eoc/contracts';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypeVersions,
  events,
  facilities,
  idempotencyRecords,
  mediaUploadIntents,
  rosterSnapshots,
  securityAuditEntries,
} from '../../db/schema';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  executeMediaCapability,
  type MediaCapabilityDependencies,
} from './capabilities';
import { ImageValidationError } from './image';
import {
  MEDIA_EVENT_ACTIVE_BYTE_LIMIT,
  MEDIA_EVENT_ACTIVE_INTENT_LIMIT,
  MEDIA_EVENT_ROLLING_INTENT_LIMIT,
  MEDIA_FACILITY_ACTIVE_BYTE_LIMIT,
  MEDIA_FACILITY_ACTIVE_INTENT_LIMIT,
  MEDIA_FACILITY_ROLLING_INTENT_LIMIT,
  MEDIA_MAX_BYTES,
  MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
  MEDIA_UPLOAD_GRANT_SECONDS,
  quarantineStorageKey,
} from './model';
import type { MediaObjectStore } from './object-store';
import {
  createMediaProcessingGate,
  createMediaProviderGate,
} from './processing-gate';
import {
  buildBoundedMediaUploadUsageQueries,
  configureMediaUploadAllocationDeadline,
  createDrizzleMediaCapabilityStore,
  MEDIA_UPLOAD_ALLOCATION_LOCK_TIMEOUT_MILLISECONDS,
  MEDIA_UPLOAD_ALLOCATION_STATEMENT_TIMEOUT_MILLISECONDS,
} from './repository';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface FixtureIds {
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
}

interface UploadUsage {
  readonly bytes: number;
  readonly intents: number;
}

interface GrantRecorder {
  readonly storageKeys: string[];
}

const SYNTHETIC_EVENT_CREATOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const CONTENT_BYTES = Buffer.from(
  'synthetic media resource budget fixture',
  'utf8',
);
const CONTENT_SHA256 = createHash('sha256').update(CONTENT_BYTES).digest('hex');
const SEEDED_BUDGET_PRINCIPAL_DIGEST = createHash('sha256')
  .update('synthetic direct media budget fixture principal', 'utf8')
  .digest('hex');

let connection: PostgresDatabaseConnection | undefined;
let fixtureIds: FixtureIds | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The media budget integration database is not open.');
  }
  return connection;
}

function syntheticFixtureIds(): FixtureIds {
  if (fixtureIds === undefined) {
    throw new Error('The synthetic media budget fixture is unavailable.');
  }
  return fixtureIds;
}

type HumanActor = Extract<Actor, { kind: 'human' }>;
type AgentActor = Extract<Actor, { kind: 'agent' }>;

function createHumanActor(
  userId = randomUUID(),
  sessionId = randomUUID(),
): HumanActor {
  return Object.freeze({
    kind: 'human' as const,
    userId,
    sessionId,
  });
}

function createAgentActor(
  agentId = randomUUID(),
  apiKeyId = randomUUID(),
): AgentActor {
  return Object.freeze({ kind: 'agent' as const, agentId, apiKeyId });
}

function mutationInvocation(
  actor: Actor,
  facilityId: string,
  idempotencyKey: string,
): TrustedCapabilityInvocation {
  const invocation =
    actor.kind === 'human'
      ? {
          source: 'web' as const,
          connectivityEpochId: randomUUID(),
          transport: {
            kind: 'web-interactive' as const,
            method: 'POST' as const,
            interaction: 'explicit-user-submit' as const,
            csrfVerified: true as const,
          },
        }
      : actor.kind === 'agent'
        ? {
            source: 'agent-rest' as const,
            connectivityEpochId: null,
            transport: {
              kind: 'agent-rest-command' as const,
              method: 'POST' as const,
            },
          }
        : {
            source: 'worker' as const,
            connectivityEpochId: null,
            transport: { kind: 'worker-execution' as const },
          };
  return {
    actor,
    source: invocation.source,
    scope: {
      facilityScope: { kind: 'facilities', facilityIds: [facilityId] },
    },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: invocation.connectivityEpochId,
    mutation: {
      idempotencyKey,
      transport: invocation.transport,
      humanConfirmationId: null,
    },
  };
}

function createGrantRecorder(): Readonly<{
  dependencies: MediaCapabilityDependencies;
  recorder: GrantRecorder;
}> {
  const recorder: GrantRecorder = { storageKeys: [] };
  const unused = async (): Promise<never> => {
    throw new Error('The upload-intent test used an unrelated object method.');
  };
  const objectStore: MediaObjectStore = {
    async createRawUploadGrant(input) {
      recorder.storageKeys.push(input.storageKey);
      return {
        method: 'PUT',
        uploadUrl: `https://media.example.test/${input.storageKey}?signature=synthetic`,
        requiredHeaders: {
          'content-type': input.contentType,
          'if-none-match': '*',
        },
        byteLength: input.byteLength,
        contentSha256: input.contentSha256,
        expiresInSeconds: input.expiresInSeconds ?? 60,
      };
    },
    readVerifiedRawObject: unused,
    putSanitizedObject: unused,
    createPrivateReadGrant: unused,
    getMalwareScanStatus: unused,
  };
  return {
    dependencies: { objectStore, createId: randomUUID },
    recorder,
  };
}

async function createSyntheticFacility(): Promise<string> {
  const id = randomUUID();
  await databaseConnection()
    .db.insert(facilities)
    .values({
      id,
      code: `MEDIA-${id.slice(0, 8).toUpperCase()}`,
      name: `Synthetic media budget facility ${id.slice(0, 8)}`,
      active: true,
      createdAt: new Date(),
    });
  return id;
}

async function createActiveSyntheticEvent(facilityId: string): Promise<string> {
  const ids = syntheticFixtureIds();
  const id = randomUUID();
  const activatedAt = new Date();
  await databaseConnection()
    .db.insert(events)
    .values({
      id,
      facilityId,
      kind: 'test',
      templateMode: 'drill',
      eventTypeVersionId: ids.eventTypeVersionId,
      status: 'active',
      rosterSnapshotId: ids.rosterSnapshotId,
      rosterPopulation: 'synthetic',
      createdBy: SYNTHETIC_EVENT_CREATOR,
      createdAt: new Date(activatedAt.getTime() - 1_000),
      activatedAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: {
        kind: 'synthetic-training',
        activationPreviewId: randomUUID(),
        consequenceDigest: 'a'.repeat(64),
        requestId: randomUUID(),
      },
    });
  return id;
}

async function seedUploadIntents(
  eventIds: readonly string[],
  byteLengths: readonly number[],
  status: 'completed' | 'pending-upload' = 'pending-upload',
): Promise<void> {
  const createdAt = new Date();
  const eventAnchors = await databaseConnection()
    .db.select({ id: events.id, facilityId: events.facilityId })
    .from(events)
    .where(inArray(events.id, eventIds));
  const facilityByEvent = new Map(
    eventAnchors.map(({ id, facilityId }) => [id, facilityId] as const),
  );
  await databaseConnection()
    .db.insert(mediaUploadIntents)
    .values(
      byteLengths.map((byteLength, index) => {
        const id = randomUUID();
        const eventId = eventIds[index % eventIds.length];
        if (eventId === undefined) {
          throw new Error('At least one synthetic event is required.');
        }
        const facilityId = facilityByEvent.get(eventId);
        if (facilityId === undefined) {
          throw new Error('Every synthetic event requires a facility anchor.');
        }
        return {
          id,
          eventId,
          facilityId,
          budgetPrincipalDigest: SEEDED_BUDGET_PRINCIPAL_DIGEST,
          budgetPrincipalAttributed: true,
          byteLength,
          contentSha256: CONTENT_SHA256,
          declaredContentType: 'image/jpeg' as const,
          storageKey: quarantineStorageKey(eventId, id),
          status,
          createdAt,
          expiresAt: new Date(
            createdAt.getTime() + MEDIA_UPLOAD_GRANT_SECONDS * 1_000,
          ),
        };
      }),
    );
}

function exactByteChunks(totalBytes: number): readonly number[] {
  const chunks: number[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MEDIA_MAX_BYTES);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

async function eventUsage(eventId: string): Promise<UploadUsage> {
  const [usage] = await databaseConnection()
    .db.select({
      intents: sql<number>`count(*)::integer`,
      bytes: sql<number>`coalesce(sum(${mediaUploadIntents.byteLength}), 0)::bigint`,
    })
    .from(mediaUploadIntents)
    .where(eq(mediaUploadIntents.eventId, eventId));
  if (usage === undefined) {
    throw new Error('The media upload usage query returned no row.');
  }
  return { intents: Number(usage.intents), bytes: Number(usage.bytes) };
}

async function reserveUpload(
  eventId: string,
  facilityId: string,
  actor: Actor,
  idempotencyKey: string,
  byteLength: number,
  dependencies: MediaCapabilityDependencies,
) {
  return executeMediaCapability(
    'create-media-upload-intent',
    {
      eventId,
      byteLength,
      contentSha256: CONTENT_SHA256,
      declaredContentType: 'image/jpeg',
    },
    mutationInvocation(actor, facilityId, idempotencyKey),
    createDrizzleMediaCapabilityStore(databaseConnection().db),
    dependencies,
  );
}

async function expectRateLimitedWithoutAllocation(input: {
  readonly eventId: string;
  readonly facilityId: string;
  readonly byteLength: number;
  readonly actor?: Actor;
}): Promise<void> {
  const actor = input.actor ?? createHumanActor();
  const object = createGrantRecorder();
  const before = await eventUsage(input.eventId);
  await expect(
    reserveUpload(
      input.eventId,
      input.facilityId,
      actor,
      `media-budget-rejected-${randomUUID()}`,
      input.byteLength,
      object.dependencies,
    ),
  ).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    status: 429,
    retryable: true,
  });
  expect(await eventUsage(input.eventId)).toEqual(before);
  expect(object.recorder.storageKeys).toHaveLength(0);
}

async function capabilityError(
  operation: Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected the media capability to fail.');
}

async function settleWithinDatabaseIsolationDeadline<Result>(
  operation: Promise<Result>,
  description: string,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(
          `${description} did not settle while the first media transaction was blocked.`,
        ),
      );
    }, 2_000);
    void operation.then(
      (result) => {
        clearTimeout(deadline);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        reject(error);
      },
    );
  });
}

describeWithDatabase('media upload production resource budgets', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      // Two connections model the smallest pool that can keep one unrelated
      // database operation available while a single media completion is in
      // provider/image work. The fail-fast gate must never consume the second
      // connection by waiting on the upload-intent row lock.
      maxConnections: 2,
    });
    if (created.driver !== 'postgres') {
      throw new Error('Media budget integration tests require PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
    await seedDatabase(created.db);

    const [[version], [snapshot]] = await Promise.all([
      created.db
        .select({ id: eventTypeVersions.id })
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.templateMode, 'drill'))
        .orderBy(asc(eventTypeVersions.id))
        .limit(1),
      created.db
        .select({ id: rosterSnapshots.id })
        .from(rosterSnapshots)
        .where(eq(rosterSnapshots.population, 'synthetic'))
        .limit(1),
    ]);
    if (version === undefined || snapshot === undefined) {
      throw new Error('The synthetic seed is missing media budget fixtures.');
    }
    fixtureIds = {
      eventTypeVersionId: version.id,
      rosterSnapshotId: snapshot.id,
    };
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('clamps allocation statements and lock waits without weakening stricter database deadlines', async () => {
    const db = databaseConnection().db;
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select
          set_config('statement_timeout', '30s', true),
          set_config('lock_timeout', '30s', true)
      `);
      await configureMediaUploadAllocationDeadline(transaction);
      const [settings] = await transaction.execute<{
        lockTimeoutMs: number;
        statementTimeoutMs: number;
      }>(sql`
        select
          (extract(epoch from current_setting('statement_timeout')::interval) * 1000)::integer as "statementTimeoutMs",
          (extract(epoch from current_setting('lock_timeout')::interval) * 1000)::integer as "lockTimeoutMs"
      `);
      expect(settings).toEqual({
        statementTimeoutMs:
          MEDIA_UPLOAD_ALLOCATION_STATEMENT_TIMEOUT_MILLISECONDS,
        lockTimeoutMs: MEDIA_UPLOAD_ALLOCATION_LOCK_TIMEOUT_MILLISECONDS,
      });
    });

    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        select
          set_config('statement_timeout', '200ms', true),
          set_config('lock_timeout', '100ms', true)
      `);
      await configureMediaUploadAllocationDeadline(transaction);
      const [settings] = await transaction.execute<{
        lockTimeoutMs: number;
        statementTimeoutMs: number;
      }>(sql`
        select
          (extract(epoch from current_setting('statement_timeout')::interval) * 1000)::integer as "statementTimeoutMs",
          (extract(epoch from current_setting('lock_timeout')::interval) * 1000)::integer as "lockTimeoutMs"
      `);
      expect(settings).toEqual({
        statementTimeoutMs: 200,
        lockTimeoutMs: 100,
      });
    });
  });

  test('plans every quota and journal read-auth lookup through its dedicated index', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const currentTime = new Date();
    const queries = buildBoundedMediaUploadUsageQueries(
      databaseConnection().db,
      {
        eventId,
        facilityId,
        budgetPrincipal: {
          kind: 'human',
          userId: randomUUID(),
          digest: createHash('sha256')
            .update('synthetic explain-plan principal', 'utf8')
            .digest('hex'),
        },
      },
      currentTime,
    );

    await databaseConnection().db.transaction(async (transaction) => {
      await transaction.execute(sql`set local enable_seqscan = off`);
      await transaction.execute(sql`set local enable_bitmapscan = off`);
      const quotaPlans = [
        [
          queries.principalRolling,
          'media_upload_intents_budget_principal_created_idx',
        ],
        [
          queries.unattributedRecent,
          'media_upload_intents_unattributed_created_idx',
        ],
        [queries.eventActive, 'media_upload_intents_event_active_idx'],
        [queries.eventRolling, 'media_upload_intents_event_created_idx'],
        [queries.facilityActive, 'media_upload_intents_facility_active_idx'],
        [queries.facilityRolling, 'media_upload_intents_facility_created_idx'],
      ] as const;
      for (const [query, expectedIndex] of quotaPlans) {
        const rows = await transaction.execute<Record<string, unknown>>(
          sql`explain (costs off) ${query}`,
        );
        const plan = rows
          .map((row) => String(Object.values(row)[0] ?? ''))
          .join('\n');
        expect(plan).toContain(expectedIndex);
      }

      const mediaId = randomUUID();
      const entryId = randomUUID();
      const entrySequence = 1;
      const journalPlans = [
        [
          sql`
            select id
            from journal_entries
            where event_id = ${eventId}
              and media_id = ${mediaId}
              and kind = 'photo'
            limit 1
          `,
          'journal_entries_event_media_idx',
        ],
        [
          sql`
            select id
            from journal_entries
            where event_id = ${eventId}
              and supersedes_entry_id = ${entryId}
              and supersedes_entry_sequence = ${entrySequence}
              and supersession_kind = 'redaction'
            limit 1
          `,
          'journal_entries_event_redaction_target_idx',
        ],
      ] as const;
      for (const [query, expectedIndex] of journalPlans) {
        const rows = await transaction.execute<Record<string, unknown>>(
          sql`explain (costs off) ${query}`,
        );
        const plan = rows
          .map((row) => String(Object.values(row)[0] ?? ''))
          .join('\n');
        expect(plan).toContain(expectedIndex);
      }
    });
  });

  test('fails closed while an unattributed migrated row remains in the principal window', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const legacyIntentId = randomUUID();
    const createdAt = new Date();
    const db = databaseConnection().db;

    // Simulate 0005's pre-trigger backfill. The trigger is re-enabled in the
    // same committed DDL transaction before application admission is invoked.
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        alter table media_upload_intents
        disable trigger media_upload_intents_integrity_guard
      `);
      await transaction.insert(mediaUploadIntents).values({
        id: legacyIntentId,
        eventId,
        facilityId,
        budgetPrincipalDigest: '0'.repeat(64),
        budgetPrincipalAttributed: false,
        byteLength: 1,
        contentSha256: CONTENT_SHA256,
        declaredContentType: 'image/jpeg',
        storageKey: quarantineStorageKey(eventId, legacyIntentId),
        status: 'pending-upload',
        createdAt,
        expiresAt: new Date(
          createdAt.getTime() + MEDIA_UPLOAD_GRANT_SECONDS * 1_000,
        ),
      });
      await transaction.execute(sql`
        alter table media_upload_intents
        enable trigger media_upload_intents_integrity_guard
      `);
    });

    const object = createGrantRecorder();
    try {
      await expect(
        reserveUpload(
          eventId,
          facilityId,
          createHumanActor(),
          `media-budget-unattributed-${randomUUID()}`,
          1,
          object.dependencies,
        ),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        reasonCode: 'PERSISTENCE_CONFLICT',
        status: 503,
        retryable: true,
      });
      expect(object.recorder.storageKeys).toHaveLength(0);
      expect(await eventUsage(eventId)).toEqual({ intents: 1, bytes: 1 });
    } finally {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`
          alter table media_upload_intents
          disable trigger media_upload_intents_integrity_guard
        `);
        await transaction
          .update(mediaUploadIntents)
          .set({
            status: 'expired',
            createdAt: new Date(createdAt.getTime() - 60 * 60_000),
            expiresAt: new Date(createdAt.getTime() - 50 * 60_000),
          })
          .where(eq(mediaUploadIntents.id, legacyIntentId));
        await transaction.execute(sql`
          alter table media_upload_intents
          enable trigger media_upload_intents_integrity_guard
        `);
      });
    }
  });

  test('shares the request boundary across human sessions and replays one key without a second allocation', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const userId = randomUUID();
    const actors = [
      createHumanActor(userId),
      createHumanActor(userId),
    ] as const;
    const object = createGrantRecorder();
    const firstKey = `media-budget-principal-first-${randomUUID()}`;

    for (
      let index = 0;
      index < MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT - 1;
      index += 1
    ) {
      await reserveUpload(
        eventId,
        facilityId,
        actors[index % actors.length] ?? actors[0],
        index === 0
          ? firstKey
          : `media-budget-principal-fill-${index}-${randomUUID()}`,
        1,
        object.dependencies,
      );
    }

    const replay = await reserveUpload(
      eventId,
      facilityId,
      actors[0],
      firstKey,
      1,
      object.dependencies,
    );
    expect(replay.eventId).toBe(eventId);
    expect(await eventUsage(eventId)).toEqual({
      intents: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT - 1,
      bytes: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT - 1,
    });
    expect(object.recorder.storageKeys).toHaveLength(
      MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
    );

    const raced = await Promise.allSettled([
      reserveUpload(
        eventId,
        facilityId,
        actors[0],
        `media-budget-principal-race-a-${randomUUID()}`,
        1,
        object.dependencies,
      ),
      reserveUpload(
        eventId,
        facilityId,
        actors[1],
        `media-budget-principal-race-b-${randomUUID()}`,
        1,
        object.dependencies,
      ),
    ]);
    const fulfilled = raced.filter((result) => result.status === 'fulfilled');
    const rejected = raced.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0];
    if (rejection?.status !== 'rejected') {
      throw new Error('Expected one rate-limited concurrent reservation.');
    }
    expect(rejection.reason).toBeInstanceOf(CapabilityEngineError);
    expect(rejection.reason).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
    });
    expect(await eventUsage(eventId)).toEqual({
      intents: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
      bytes: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
    });
    expect(object.recorder.storageKeys).toHaveLength(
      MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT + 1,
    );

    await expectRateLimitedWithoutAllocation({
      eventId,
      facilityId,
      byteLength: 1,
      actor: actors[1],
    });
  });

  test('shares the request boundary across API keys for one agent', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const agentId = randomUUID();
    const actors = [
      createAgentActor(agentId),
      createAgentActor(agentId),
    ] as const;
    const object = createGrantRecorder();

    for (
      let index = 0;
      index < MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT - 1;
      index += 1
    ) {
      await reserveUpload(
        eventId,
        facilityId,
        actors[index % actors.length] ?? actors[0],
        `media-budget-agent-fill-${index}-${randomUUID()}`,
        1,
        object.dependencies,
      );
    }

    const raced = await Promise.allSettled([
      reserveUpload(
        eventId,
        facilityId,
        actors[0],
        `media-budget-agent-race-a-${randomUUID()}`,
        1,
        object.dependencies,
      ),
      reserveUpload(
        eventId,
        facilityId,
        actors[1],
        `media-budget-agent-race-b-${randomUUID()}`,
        1,
        object.dependencies,
      ),
    ]);
    expect(
      raced.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = raced.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0];
    if (rejection?.status !== 'rejected') {
      throw new Error('Expected one rate-limited agent reservation.');
    }
    expect(rejection.reason).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
    });
    expect(await eventUsage(eventId)).toEqual({
      intents: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
      bytes: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
    });
    expect(object.recorder.storageKeys).toHaveLength(
      MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
    );
  });

  test('shares the rolling-byte boundary across sessions for one human', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const userId = randomUUID();
    const actors = [
      createHumanActor(userId),
      createHumanActor(userId),
    ] as const;
    const object = createGrantRecorder();
    const chunks = exactByteChunks(MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT);
    for (const [index, byteLength] of chunks.entries()) {
      await reserveUpload(
        eventId,
        facilityId,
        actors[index % actors.length] ?? actors[0],
        `media-budget-principal-bytes-${index}-${randomUUID()}`,
        byteLength,
        object.dependencies,
      );
    }
    expect(await eventUsage(eventId)).toEqual({
      intents: chunks.length,
      bytes: MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
    });
    await expect(
      reserveUpload(
        eventId,
        facilityId,
        createHumanActor(userId),
        `media-budget-principal-bytes-rejected-${randomUUID()}`,
        1,
        object.dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
    });
    expect(await eventUsage(eventId)).toEqual({
      intents: chunks.length,
      bytes: MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
    });
    expect(object.recorder.storageKeys).toHaveLength(chunks.length);
  });

  test('rejects event active request and byte limits before allocation', async () => {
    const requestFacilityId = await createSyntheticFacility();
    const requestEventId = await createActiveSyntheticEvent(requestFacilityId);
    await seedUploadIntents(
      [requestEventId],
      Array.from({ length: MEDIA_EVENT_ACTIVE_INTENT_LIMIT }, () => 1),
    );
    await expectRateLimitedWithoutAllocation({
      eventId: requestEventId,
      facilityId: requestFacilityId,
      byteLength: 1,
    });

    const byteFacilityId = await createSyntheticFacility();
    const byteEventId = await createActiveSyntheticEvent(byteFacilityId);
    const byteChunks = exactByteChunks(MEDIA_EVENT_ACTIVE_BYTE_LIMIT);
    await seedUploadIntents([byteEventId], byteChunks);
    expect(await eventUsage(byteEventId)).toEqual({
      intents: byteChunks.length,
      bytes: MEDIA_EVENT_ACTIVE_BYTE_LIMIT,
    });
    await expectRateLimitedWithoutAllocation({
      eventId: byteEventId,
      facilityId: byteFacilityId,
      byteLength: 1,
    });
  });

  test('rejects facility active request and byte limits before allocation', async () => {
    const requestFacilityId = await createSyntheticFacility();
    const requestReservoirs = await Promise.all(
      Array.from({ length: 3 }, () =>
        createActiveSyntheticEvent(requestFacilityId),
      ),
    );
    const requestTarget = await createActiveSyntheticEvent(requestFacilityId);
    await seedUploadIntents(
      requestReservoirs,
      Array.from({ length: MEDIA_FACILITY_ACTIVE_INTENT_LIMIT }, () => 1),
    );
    await expectRateLimitedWithoutAllocation({
      eventId: requestTarget,
      facilityId: requestFacilityId,
      byteLength: 1,
    });

    const byteFacilityId = await createSyntheticFacility();
    const byteReservoirs = await Promise.all(
      Array.from({ length: 3 }, () =>
        createActiveSyntheticEvent(byteFacilityId),
      ),
    );
    const byteTarget = await createActiveSyntheticEvent(byteFacilityId);
    await seedUploadIntents(
      byteReservoirs,
      exactByteChunks(MEDIA_FACILITY_ACTIVE_BYTE_LIMIT),
    );
    await expectRateLimitedWithoutAllocation({
      eventId: byteTarget,
      facilityId: byteFacilityId,
      byteLength: 1,
    });
  });

  test('preserves event and facility rolling request limits after uploads stop being active', async () => {
    const eventFacilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(eventFacilityId);
    await seedUploadIntents(
      [eventId],
      Array.from({ length: MEDIA_EVENT_ROLLING_INTENT_LIMIT }, () => 1),
      'completed',
    );
    await expectRateLimitedWithoutAllocation({
      eventId,
      facilityId: eventFacilityId,
      byteLength: 1,
    });

    const facilityId = await createSyntheticFacility();
    const reservoirs = await Promise.all(
      Array.from({ length: 3 }, () => createActiveSyntheticEvent(facilityId)),
    );
    const target = await createActiveSyntheticEvent(facilityId);
    await seedUploadIntents(
      reservoirs,
      Array.from({ length: MEDIA_FACILITY_ROLLING_INTENT_LIMIT }, () => 1),
      'completed',
    );
    await expectRateLimitedWithoutAllocation({
      eventId: target,
      facilityId,
      byteLength: 1,
    });
  });

  test('releases a constrained database connection when provider admission is saturated', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const constrained = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      // Two held provider calls may retain two capability transactions. The
      // third connection must be returned immediately after admission fails.
      maxConnections: 3,
    });
    if (constrained.driver !== 'postgres') {
      throw new Error('Provider admission requires direct PostgreSQL.');
    }

    let releaseProviders: (() => void) | undefined;
    const providersReleased = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    let announceAtCapacity: (() => void) | undefined;
    const atCapacity = new Promise<void>((resolve) => {
      announceAtCapacity = resolve;
    });
    let holders: Promise<readonly unknown[]> | undefined;
    try {
      const [firstFacilityId, secondFacilityId, saturatedFacilityId] =
        await Promise.all([
          createSyntheticFacility(),
          createSyntheticFacility(),
          createSyntheticFacility(),
        ]);
      const [firstEventId, secondEventId, saturatedEventId] = await Promise.all(
        [
          createActiveSyntheticEvent(firstFacilityId),
          createActiveSyntheticEvent(secondFacilityId),
          createActiveSyntheticEvent(saturatedFacilityId),
        ],
      );
      const keys = [
        `provider-holder-first-${randomUUID()}`,
        `provider-holder-second-${randomUUID()}`,
        `provider-saturated-${randomUUID()}`,
      ] as const;
      const invocations = [
        mutationInvocation(createHumanActor(), firstFacilityId, keys[0]),
        mutationInvocation(createHumanActor(), secondFacilityId, keys[1]),
        mutationInvocation(createHumanActor(), saturatedFacilityId, keys[2]),
      ] as const;
      let providerEntries = 0;
      const unrelated = async (): Promise<never> => {
        throw new Error('Provider admission used an unrelated object method.');
      };
      const objectStore: MediaObjectStore = {
        async createRawUploadGrant(input) {
          providerEntries += 1;
          if (providerEntries === 2) {
            announceAtCapacity?.();
          }
          await providersReleased;
          return {
            method: 'PUT',
            uploadUrl: `https://media.example.test/${input.storageKey}?signature=synthetic`,
            requiredHeaders: {
              'content-type': input.contentType,
              'if-none-match': '*',
            },
            byteLength: input.byteLength,
            contentSha256: input.contentSha256,
            expiresInSeconds: input.expiresInSeconds ?? 60,
          };
        },
        getMalwareScanStatus: unrelated,
        readVerifiedRawObject: unrelated,
        putSanitizedObject: unrelated,
        createPrivateReadGrant: unrelated,
      };
      const dependencies: MediaCapabilityDependencies = {
        objectStore,
        createId: randomUUID,
        providerGate: createMediaProviderGate(2),
      };
      const createInput = (eventId: string) => ({
        eventId,
        byteLength: CONTENT_BYTES.byteLength,
        contentSha256: CONTENT_SHA256,
        declaredContentType: 'image/jpeg',
      });
      const inputs = [
        createInput(firstEventId),
        createInput(secondEventId),
        createInput(saturatedEventId),
      ] as const;
      const store = createDrizzleMediaCapabilityStore(constrained.db);
      holders = Promise.all([
        executeMediaCapability(
          'create-media-upload-intent',
          inputs[0],
          invocations[0],
          store,
          dependencies,
        ),
        executeMediaCapability(
          'create-media-upload-intent',
          inputs[1],
          invocations[1],
          store,
          dependencies,
        ),
      ]);
      await settleWithinDatabaseIsolationDeadline(
        atCapacity,
        'Two upload-grant provider calls',
      );

      const saturatedError = await settleWithinDatabaseIsolationDeadline(
        capabilityError(
          executeMediaCapability(
            'create-media-upload-intent',
            inputs[2],
            invocations[2],
            store,
            dependencies,
          ),
        ),
        'The saturated upload-grant request',
      );
      const [availability] = await settleWithinDatabaseIsolationDeadline(
        constrained.db.execute<{ available: number }>(
          sql`select 1::integer as "available"`,
        ),
        'An unrelated constrained-pool query',
      );
      const providerEntriesWhileBlocked = providerEntries;

      releaseProviders?.();
      const completedHolders = await holders;
      expect(completedHolders).toHaveLength(2);
      expect(saturatedError).toMatchObject({
        code: 'INTERNAL_ERROR',
        reasonCode: 'PERSISTENCE_CONFLICT',
        status: 503,
        retryable: true,
      });
      expect(Number(availability?.available)).toBe(1);
      expect(providerEntriesWhileBlocked).toBe(2);
      expect(providerEntries).toBe(2);

      const idempotency = await databaseConnection()
        .db.select({
          key: idempotencyRecords.key,
          status: idempotencyRecords.status,
        })
        .from(idempotencyRecords)
        .where(inArray(idempotencyRecords.key, keys));
      expect(
        idempotency
          .map(({ key, status }) => ({ key, status }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      ).toEqual(
        keys
          .slice(0, 2)
          .map((key) => ({ key, status: 'completed' as const }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      );

      const requestIds = invocations.map(({ requestId }) => requestId);
      const audits = await databaseConnection()
        .db.select({
          outcome: securityAuditEntries.outcome,
          requestId: securityAuditEntries.requestId,
        })
        .from(securityAuditEntries)
        .where(inArray(securityAuditEntries.requestId, requestIds));
      expect(audits).toHaveLength(3);
      expect(
        audits.find(({ requestId }) => requestId === invocations[2].requestId)
          ?.outcome,
      ).toBe('failure');
      expect(
        audits
          .filter(({ requestId }) => requestId !== invocations[2].requestId)
          .every(({ outcome }) => outcome === 'success'),
      ).toBe(true);
    } finally {
      releaseProviders?.();
      await holders?.catch(() => undefined);
      await constrained.close();
    }
  });

  test('fails saturated completion before the intent lock while preserving terminal rejection evidence', async () => {
    const facilityId = await createSyntheticFacility();
    const eventId = await createActiveSyntheticEvent(facilityId);
    const uploadIntentId = randomUUID();
    const now = new Date();
    await databaseConnection()
      .db.insert(mediaUploadIntents)
      .values({
        id: uploadIntentId,
        eventId,
        facilityId,
        budgetPrincipalDigest: SEEDED_BUDGET_PRINCIPAL_DIGEST,
        budgetPrincipalAttributed: true,
        byteLength: CONTENT_BYTES.byteLength,
        contentSha256: CONTENT_SHA256,
        declaredContentType: 'image/jpeg',
        storageKey: quarantineStorageKey(eventId, uploadIntentId),
        status: 'pending-upload',
        createdAt: now,
        expiresAt: new Date(now.getTime() + MEDIA_UPLOAD_GRANT_SECONDS * 1_000),
      });

    const actor = createHumanActor();
    const firstKey = `terminal-image-first-${randomUUID()}`;
    const concurrentKey = `terminal-image-concurrent-${randomUUID()}`;
    const laterKey = `terminal-image-later-${randomUUID()}`;
    const firstInvocation = mutationInvocation(actor, facilityId, firstKey);
    const concurrentInvocation = mutationInvocation(
      actor,
      facilityId,
      concurrentKey,
    );
    const providerCalls = {
      scan: 0,
      raw: 0,
      sanitize: 0,
      sanitizedWrite: 0,
    };
    let releaseSanitizer: (() => void) | undefined;
    const sanitizerRelease = new Promise<void>((resolve) => {
      releaseSanitizer = resolve;
    });
    let announceSanitizer: (() => void) | undefined;
    const sanitizerEntered = new Promise<void>((resolve) => {
      announceSanitizer = resolve;
    });
    const unrelated = async (): Promise<never> => {
      throw new Error('Terminal rejection used an unrelated object method.');
    };
    const objectStore: MediaObjectStore = {
      createRawUploadGrant: unrelated,
      async getMalwareScanStatus() {
        providerCalls.scan += 1;
        return 'clean';
      },
      async readVerifiedRawObject() {
        providerCalls.raw += 1;
        return {
          bytes: CONTENT_BYTES,
          byteLength: CONTENT_BYTES.byteLength,
          contentSha256: CONTENT_SHA256,
          storedContentType: 'application/octet-stream',
        };
      },
      async putSanitizedObject() {
        providerCalls.sanitizedWrite += 1;
        throw new Error('Malformed bytes must never be persisted as ready.');
      },
      createPrivateReadGrant: unrelated,
    };
    const dependencies: MediaCapabilityDependencies = {
      objectStore,
      processingGate: createMediaProcessingGate(1),
      async sanitizeImage() {
        providerCalls.sanitize += 1;
        announceSanitizer?.();
        await sanitizerRelease;
        throw new ImageValidationError(
          'MALFORMED_IMAGE',
          'The image could not be safely processed. Choose a different image and try again.',
        );
      },
    };
    const store = createDrizzleMediaCapabilityStore(databaseConnection().db);
    const input = { uploadIntentId };

    const first = capabilityError(
      executeMediaCapability(
        'complete-media-upload',
        input,
        firstInvocation,
        store,
        dependencies,
      ),
    );
    await sanitizerEntered;
    const concurrent = capabilityError(
      executeMediaCapability(
        'complete-media-upload',
        input,
        concurrentInvocation,
        store,
        dependencies,
      ),
    );
    let concurrentError: CapabilityEngineError;
    let databaseAvailable: number;
    let providerCallsWhileBlocked: typeof providerCalls;
    try {
      concurrentError = await settleWithinDatabaseIsolationDeadline(
        concurrent,
        'The saturated completion',
      );
      const [availability] = await settleWithinDatabaseIsolationDeadline(
        databaseConnection().db.execute<{ available: number }>(
          sql`select 1::integer as "available"`,
        ),
        'An unrelated database query',
      );
      databaseAvailable = Number(availability?.available);
      providerCallsWhileBlocked = { ...providerCalls };
    } finally {
      releaseSanitizer?.();
    }
    const firstError = await first;

    expect(firstError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(concurrentError).toMatchObject({
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 503,
      retryable: true,
    });
    expect(databaseAvailable).toBe(1);
    // Completion no longer reads a malware-scan tag, so the first provider
    // call is the raw object read.
    expect(providerCallsWhileBlocked).toEqual({
      scan: 0,
      raw: 1,
      sanitize: 1,
      sanitizedWrite: 0,
    });

    const sameKeyInvocation = {
      ...firstInvocation,
      requestId: randomUUID(),
    };
    const sameKeyError = await capabilityError(
      executeMediaCapability(
        'complete-media-upload',
        input,
        sameKeyInvocation,
        store,
        dependencies,
      ),
    );
    expect(sameKeyError).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'IDEMPOTENCY_PREVIOUSLY_FAILED',
      status: 409,
      retryable: false,
    });

    const laterInvocation = mutationInvocation(actor, facilityId, laterKey);
    const laterError = await capabilityError(
      executeMediaCapability(
        'complete-media-upload',
        input,
        laterInvocation,
        store,
        dependencies,
      ),
    );
    expect(laterError).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      retryable: false,
    });
    expect(providerCalls).toEqual({
      scan: 0,
      raw: 1,
      sanitize: 1,
      sanitizedWrite: 0,
    });

    const [intent] = await databaseConnection()
      .db.select({ status: mediaUploadIntents.status })
      .from(mediaUploadIntents)
      .where(eq(mediaUploadIntents.id, uploadIntentId));
    expect(intent?.status).toBe('rejected');

    const idempotency = await databaseConnection()
      .db.select({
        key: idempotencyRecords.key,
        status: idempotencyRecords.status,
        completedAt: idempotencyRecords.completedAt,
        resultReference: idempotencyRecords.resultReference,
      })
      .from(idempotencyRecords)
      .where(
        inArray(idempotencyRecords.key, [firstKey, concurrentKey, laterKey]),
      );
    expect(idempotency).toEqual([
      {
        key: firstKey,
        status: 'failed',
        completedAt: expect.any(Date),
        resultReference: `terminal-image-rejection:${eventId}:${uploadIntentId}`,
      },
    ]);

    const requestIds = [
      firstInvocation.requestId,
      concurrentInvocation.requestId,
      sameKeyInvocation.requestId,
      laterInvocation.requestId,
    ];
    const audits = await databaseConnection()
      .db.select({
        requestId: securityAuditEntries.requestId,
        outcome: securityAuditEntries.outcome,
      })
      .from(securityAuditEntries)
      .where(inArray(securityAuditEntries.requestId, requestIds));
    expect(audits).toHaveLength(requestIds.length);
    expect(audits.map(({ requestId }) => requestId).sort()).toEqual(
      [...requestIds].sort(),
    );
    expect(audits.every(({ outcome }) => outcome === 'failure')).toBe(true);
  });
});
