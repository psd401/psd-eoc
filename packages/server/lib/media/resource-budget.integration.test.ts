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
import { asc, eq, sql } from 'drizzle-orm';

import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypeVersions,
  events,
  facilities,
  mediaUploadIntents,
  rosterSnapshots,
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
import {
  MEDIA_EVENT_ACTIVE_BYTE_LIMIT,
  MEDIA_EVENT_ACTIVE_INTENT_LIMIT,
  MEDIA_FACILITY_ACTIVE_BYTE_LIMIT,
  MEDIA_FACILITY_ACTIVE_INTENT_LIMIT,
  MEDIA_MAX_BYTES,
  MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
  MEDIA_UPLOAD_GRANT_SECONDS,
  quarantineStorageKey,
} from './model';
import type { MediaObjectStore } from './object-store';
import { createDrizzleMediaCapabilityStore } from './repository';

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
const CONTENT_SHA256 = createHash('sha256')
  .update('synthetic media resource budget fixture', 'utf8')
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
  await databaseConnection()
    .db.insert(mediaUploadIntents)
    .values(
      byteLengths.map((byteLength, index) => {
        const id = randomUUID();
        const eventId = eventIds[index % eventIds.length];
        if (eventId === undefined) {
          throw new Error('At least one synthetic event is required.');
        }
        return {
          id,
          eventId,
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

describeWithDatabase('media upload production resource budgets', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 16,
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
});
