import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  agentApiKeys,
  agents,
  idempotencyRecords,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { createDrizzleAgentApiKeyRepository } from './drizzle-key-repository';
import { AgentApiKeyIssuanceReplayError, AgentApiKeyService } from './keys';

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
    throw new Error('The PostgreSQL integration-test connection is not open.');
  }
  return connection;
}

describeWithDatabase('agent API-key PostgreSQL concurrency', () => {
  const issuerId = randomUUID();
  const issuerSessionId = randomUUID();
  const idempotencyKey = `issue-agent-key:concurrent-${randomUUID()}`;
  const issuedAt = new Date('2026-08-10T18:00:00.000Z');

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 3,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error('Agent key integration tests require PostgreSQL.');
    }
    connection = createdConnection;
    await migrateDatabase(createdConnection);
    await createdConnection.db.insert(users).values({
      id: issuerId,
      googleSubject: `synthetic-agent-key-concurrency-${issuerId}`,
      email: `synthetic-agent-key-concurrency-${issuerId}@psd401.net`,
      displayName: 'Synthetic agent key concurrency issuer',
      facilityScopeKind: 'district',
      createdAt: issuedAt,
    });
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('serializes concurrent issuance and reveals exactly one credential', async () => {
    const database = databaseConnection().db;
    const service = new AgentApiKeyService({
      repository: createDrizzleAgentApiKeyRepository(database),
      now: () => issuedAt,
    });
    const input = {
      agentId: null,
      displayName: 'Synthetic concurrent reporting agent',
      facilityScope: { kind: 'district' as const },
      capabilityIds: ['list-active-events' as const],
      expiresInSeconds: null,
    };
    const invocation = {
      actor: {
        kind: 'human' as const,
        userId: issuerId,
        sessionId: issuerSessionId,
      },
      idempotencyKey,
    };

    const results = await Promise.allSettled([
      service.issue(input, issuerId, invocation),
      service.issue(input, issuerId, invocation),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<AgentApiKeyService['issue']>>
      > => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const issuance = fulfilled[0]!.value;
    const replayError = rejected[0]!.reason as unknown;
    expect(replayError).toBeInstanceOf(AgentApiKeyIssuanceReplayError);
    expect(replayError).toMatchObject({
      code: 'ISSUANCE_ALREADY_COMMITTED',
      status: 409,
      key: { id: issuance.key.id, keyPrefix: issuance.key.keyPrefix },
    });
    expect(JSON.stringify(replayError)).not.toContain(
      issuance.oneTimeCredential,
    );

    await expect(
      service.authenticate(issuance.oneTimeCredential),
    ).resolves.toMatchObject({
      actor: {
        kind: 'agent',
        agentId: issuance.key.agentId,
        apiKeyId: issuance.key.id,
      },
    });

    const keyRows = await database
      .select({ id: agentApiKeys.id, agentId: agentApiKeys.agentId })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.issuedByUserId, issuerId));
    expect(keyRows).toEqual([
      { id: issuance.key.id, agentId: issuance.key.agentId },
    ]);
    const agentRows = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, issuance.key.agentId));
    expect(agentRows).toEqual([{ id: issuance.key.agentId }]);
    const idempotencyRows = await database
      .select({
        status: idempotencyRecords.status,
        resultReference: idempotencyRecords.resultReference,
      })
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, idempotencyKey));
    expect(idempotencyRows).toEqual([
      {
        status: 'completed',
        resultReference: `agent-api-key:${issuance.key.id}`,
      },
    ]);

    await expect(
      service.issue(
        { ...input, displayName: 'Different concurrent request' },
        issuerId,
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });
});
