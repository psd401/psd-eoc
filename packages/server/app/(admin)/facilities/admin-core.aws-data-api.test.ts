import { IntegrationChannelChangeAuthorizationSchema } from '@psd-eoc/contracts';
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type RDSDataClient,
} from '@aws-sdk/client-rds-data';
import { describe, expect, test } from 'bun:test';
import { drizzle as drizzleAwsDataApi } from 'drizzle-orm/aws-data-api/pg';

import type { Database } from '../../../db/client';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { executeListUsersCapability } from '../access/capabilities';
import {
  executeIntegrationHealthProjection,
  executeSetChannelEnabledCapability,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
} from '../integrations/capabilities';
import { executeRosterHealthProjection } from '../integrations/roster-health';
import { createDrizzleAdminCapabilityStore } from './admin-core';

const CLOCK_VALUE = '2026-08-10T12:00:00.000Z';
const USER_ID = '00000000-0000-4000-8000-000000002670';
const SECOND_USER_ID = '00000000-0000-4000-8000-000000002675';
const SESSION_ID = '00000000-0000-4000-8000-000000002671';
const MOCKED_INTEGRATION_ID = 'synthetic-mocked-push';
const MOCKED_STATUS_ID = '00000000-0000-4000-8000-000000002676';
const LIVE_INTEGRATION_ID = 'synthetic-live-push';
const LIVE_STATUS_ID = '00000000-0000-4000-8000-000000002677';
const LIVE_AUTHORIZATION_ID = '00000000-0000-4000-8000-000000002678';

const liveAuthorizationBase = {
  reference: 'synthetic-data-api-live-authorization',
  integrationStatusId: LIVE_STATUS_ID,
  integrationId: LIVE_INTEGRATION_ID,
  desiredEnabled: true,
  requestDigest: '0'.repeat(64),
  consequenceDigest: '0'.repeat(64),
  authorizedByUserId: USER_ID,
  authorizedWithSessionId: SESSION_ID,
  issuedAt: CLOCK_VALUE,
  expiresAt: '2026-08-10T12:15:00.000Z',
} as const;
const LIVE_AUTHORIZATION = IntegrationChannelChangeAuthorizationSchema.parse({
  ...liveAuthorizationBase,
  requestDigest: liveChannelChangeRequestDigest(liveAuthorizationBase),
  consequenceDigest: liveChannelChangeConsequenceDigest({
    integrationId: LIVE_INTEGRATION_ID,
    previousConfiguration: null,
    desiredEnabled: true,
    integrationStatusId: LIVE_STATUS_ID,
  }),
});
const LIVE_AUTHORIZATION_COMMITMENT =
  liveChannelChangeAuthorizationCommitment(LIVE_AUTHORIZATION);

interface RecordedStatement {
  readonly sql: string;
  readonly transactionId: string;
}

interface FakeIdempotencyRecord {
  readonly id: string;
  readonly key: string;
  readonly requestDigest: string;
  status: 'in-progress' | 'completed';
  resultReference: string | null;
}

/**
 * Minimal deterministic client for the pinned Drizzle 0.44.5 Data API driver.
 * It owns no credentials or network transport and returns only synthetic rows.
 */
class FakeRdsDataClient {
  readonly statements: RecordedStatement[] = [];
  readonly maximumInFlight = new Map<string, number>();

  private readonly configuredIntegrations = new Set<string>();
  private readonly idempotencyById = new Map<string, FakeIdempotencyRecord>();
  private readonly inFlight = new Map<string, number>();
  private nextIdempotencyRecord = 0;
  private nextTransaction = 0;

  async send(command: unknown): Promise<unknown> {
    if (command instanceof BeginTransactionCommand) {
      this.nextTransaction += 1;
      return {
        transactionId: `synthetic-transaction-${this.nextTransaction}`,
        $metadata: {},
      };
    }
    if (
      command instanceof CommitTransactionCommand ||
      command instanceof RollbackTransactionCommand
    ) {
      return { $metadata: {} };
    }
    if (!(command instanceof ExecuteStatementCommand)) {
      throw new Error('The fake Data API client received an unknown command.');
    }

    const transactionId = command.input.transactionId;
    if (transactionId === undefined) {
      throw new Error('Every admin statement must use a transaction ID.');
    }
    const statementSql = command.input.sql;
    if (statementSql === undefined) {
      throw new Error('Every admin statement must contain SQL.');
    }
    const normalizedSql = statementSql.replace(/\s+/gu, ' ').trim();
    this.statements.push({ sql: normalizedSql, transactionId });

    const current = (this.inFlight.get(transactionId) ?? 0) + 1;
    this.inFlight.set(transactionId, current);
    this.maximumInFlight.set(
      transactionId,
      Math.max(this.maximumInFlight.get(transactionId) ?? 0, current),
    );

    // Yield so concurrent sends on one transaction deterministically overlap.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    try {
      const parameterStrings =
        command.input.parameters?.flatMap(({ value }) =>
          value?.stringValue === undefined ? [] : [value.stringValue],
        ) ?? [];
      return this.syntheticResponse(normalizedSql, parameterStrings);
    } finally {
      this.inFlight.set(transactionId, current - 1);
    }
  }

  private syntheticResponse(
    sql: string,
    parameterStrings: readonly string[],
  ): unknown {
    if (sql.includes('clock_timestamp()')) {
      return {
        records: [[{ stringValue: CLOCK_VALUE }]],
        $metadata: {},
      };
    }
    if (sql.includes('from "users"') && sql.includes('order by')) {
      return {
        records: [
          [{ stringValue: USER_ID }],
          [{ stringValue: SECOND_USER_ID }],
        ],
        $metadata: {},
      };
    }
    if (sql.includes('from "users"')) {
      const userId = parameterStrings.includes(SECOND_USER_ID)
        ? SECOND_USER_ID
        : USER_ID;
      const isSecondUser = userId === SECOND_USER_ID;
      return {
        records: [
          [
            { stringValue: userId },
            {
              stringValue: isSecondUser
                ? 'synthetic-google-subject-2675'
                : 'synthetic-google-subject-2670',
            },
            {
              stringValue: isSecondUser
                ? 'synthetic-operator@psd401.net'
                : 'synthetic-admin@psd401.net',
            },
            {
              stringValue: isSecondUser
                ? 'Synthetic Operator'
                : 'Synthetic Administrator',
            },
            { stringValue: 'district' },
            { stringValue: CLOCK_VALUE },
            { isNull: true },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.includes('role_base_grants')) {
      return {
        records: [[{ stringValue: 'admin' }, { booleanValue: true }]],
        $metadata: {},
      };
    }
    if (sql.includes('from "user_roles"')) {
      return {
        records: [[{ stringValue: 'admin' }]],
        $metadata: {},
      };
    }
    if (sql.includes('from "user_facility_scopes"')) {
      return { records: [], $metadata: {} };
    }
    if (sql.startsWith('insert into "idempotency_records"')) {
      const key = parameterStrings.find((value) =>
        value.startsWith('synthetic-data-api-'),
      );
      if (key === undefined) {
        throw new Error('The synthetic idempotency insert lost its key.');
      }
      const existing = [...this.idempotencyById.values()].find(
        (record) => record.key === key,
      );
      if (existing !== undefined) {
        return { records: [], numberOfRecordsUpdated: 0, $metadata: {} };
      }
      const requestDigest = parameterStrings
        .filter((value) => /^[a-f0-9]{64}$/u.test(value))
        .at(-1);
      if (requestDigest === undefined) {
        throw new Error(
          'The synthetic idempotency insert lost its request digest.',
        );
      }
      this.nextIdempotencyRecord += 1;
      const id = `00000000-0000-4000-8000-${String(2678 + this.nextIdempotencyRecord).padStart(12, '0')}`;
      this.idempotencyById.set(id, {
        id,
        key,
        requestDigest,
        status: 'in-progress',
        resultReference: null,
      });
      return {
        records: [[{ stringValue: id }]],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.includes('from "idempotency_records"')) {
      const key = parameterStrings.find((value) =>
        value.startsWith('synthetic-data-api-'),
      );
      const record = [...this.idempotencyById.values()].find(
        (candidate) => candidate.key === key,
      );
      if (record === undefined) return { records: [], $metadata: {} };
      return {
        records: [
          [
            { stringValue: record.requestDigest },
            { stringValue: record.status },
            record.resultReference === null
              ? { isNull: true }
              : { stringValue: record.resultReference },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.startsWith('update "idempotency_records"')) {
      const record = [...this.idempotencyById.values()].find(({ id }) =>
        parameterStrings.includes(id),
      );
      const resultReference = parameterStrings.find(
        (value) => value.length > 80 && !/^[a-f0-9]{64}$/u.test(value),
      );
      if (record === undefined || resultReference === undefined) {
        throw new Error(
          'The synthetic idempotency completion lost its record or result.',
        );
      }
      record.status = 'completed';
      record.resultReference = resultReference;
      return {
        records: [[{ stringValue: record.id }]],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (
      sql.startsWith('insert into "integration_channel_change_authorizations"')
    ) {
      return {
        records: [[{ stringValue: LIVE_AUTHORIZATION_ID }]],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "channel_configurations"')) {
      const integrationId = parameterStrings.find(
        (value) =>
          value === MOCKED_INTEGRATION_ID || value === LIVE_INTEGRATION_ID,
      );
      if (integrationId === undefined) {
        throw new Error(
          'The synthetic channel upsert lost its integration ID.',
        );
      }
      this.configuredIntegrations.add(integrationId);
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.includes('from "integration_statuses"')) {
      const integrationId = parameterStrings.find(
        (value) =>
          value === MOCKED_INTEGRATION_ID || value === LIVE_INTEGRATION_ID,
      );
      if (integrationId === undefined) {
        return { records: [], $metadata: {} };
      }
      const live = integrationId === LIVE_INTEGRATION_ID;
      return {
        records: [
          [
            { stringValue: live ? LIVE_STATUS_ID : MOCKED_STATUS_ID },
            { stringValue: integrationId },
            { stringValue: live ? 'live-verified' : 'mocked' },
            live ? { stringValue: CLOCK_VALUE } : { isNull: true },
            live ? { stringValue: USER_ID } : { isNull: true },
            live
              ? { stringValue: LIVE_AUTHORIZATION_COMMITMENT }
              : { isNull: true },
            { isNull: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        $metadata: {},
      };
    }
    if (
      sql.includes('from "channel_configurations"') &&
      sql.includes('inner join "integration_statuses"')
    ) {
      const integrationId = parameterStrings.find(
        (value) =>
          value === MOCKED_INTEGRATION_ID || value === LIVE_INTEGRATION_ID,
      );
      if (
        integrationId === undefined ||
        !this.configuredIntegrations.has(integrationId)
      ) {
        return { records: [], $metadata: {} };
      }
      const live = integrationId === LIVE_INTEGRATION_ID;
      return {
        records: [
          [
            { stringValue: integrationId },
            { booleanValue: true },
            { stringValue: CLOCK_VALUE },
            { stringValue: live ? 'live-verified' : 'mocked' },
            live ? { stringValue: CLOCK_VALUE } : { isNull: true },
            live ? { stringValue: USER_ID } : { isNull: true },
            live
              ? { stringValue: LIVE_AUTHORIZATION_COMMITMENT }
              : { isNull: true },
            { isNull: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        $metadata: {},
      };
    }
    if (
      sql.includes('from "channel_configurations"') ||
      sql.includes('from "roster_snapshots"') ||
      sql.includes('from "roster_sync_results"') ||
      sql.includes('from "security_audit_chain_anchors"') ||
      sql.includes('from "security_audit_entries"')
    ) {
      return { records: [], $metadata: {} };
    }
    if (
      sql.startsWith('set transaction isolation level') ||
      sql.includes('pg_advisory_xact_lock') ||
      sql.startsWith('insert into "security_audit_entries"')
    ) {
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    throw new Error(`The fake Data API client received unexpected SQL: ${sql}`);
  }
}

function authenticatedAdministrator(): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: USER_ID, sessionId: SESSION_ID },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: {
      connectivityEpoch: {
        id: '00000000-0000-4000-8000-000000002672',
      },
    },
  } as unknown as AuthenticatedSession;
}

function fakeDatabase(client: FakeRdsDataClient): Database {
  return drizzleAwsDataApi(client as unknown as RDSDataClient, {
    database: 'synthetic_admin_test',
    resourceArn:
      'arn:aws:rds:us-west-2:000000000000:cluster:synthetic-admin-test',
    secretArn:
      'arn:aws:secretsmanager:us-west-2:000000000000:secret:synthetic-admin-test',
  }) as unknown as Database;
}

describe('admin Aurora Data API transport regression', () => {
  test('maps the database clock row and serializes each transaction ID', async () => {
    const client = new FakeRdsDataClient();
    const authenticated = authenticatedAdministrator();
    const store = createDrizzleAdminCapabilityStore(
      fakeDatabase(client),
      authenticated,
    );

    const databaseTime = await store.transaction((transaction) =>
      transaction.readCurrentTime(new Date(0)),
    );
    expect(databaseTime.toISOString()).toBe(CLOCK_VALUE);

    const users = await executeListUsersCapability({
      authenticated,
      store,
      query: {
        facilityId: null,
        includeDisabled: true,
        cursor: null,
        limit: 10,
      },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000002673',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(users.items.map(({ id }) => id)).toEqual([USER_ID, SECOND_USER_ID]);

    const integration = await executeIntegrationHealthProjection({
      authenticated,
      store,
      query: { integrationId: null },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000002674',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(integration.health.observedAt).toBe(CLOCK_VALUE);
    expect(integration.health.statuses).toEqual([]);
    expect(integration.channels).toEqual([]);

    const roster = await executeRosterHealthProjection({
      authenticated,
      store,
      query: {
        population: 'synthetic',
        facilityId: null,
        cursor: null,
        limit: 10,
      },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000002680',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(roster.lastSync).toBeNull();
    expect(roster.report).toMatchObject({
      status: 'unknown',
      latestCompleteSnapshotId: null,
      staleRecipients: [],
    });

    const mockedChannel = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: MOCKED_INTEGRATION_ID,
        enabled: true,
        authorization: null,
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-mocked-channel',
        requestId: '00000000-0000-4000-8000-000000002681',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(mockedChannel).toMatchObject({
      integrationId: MOCKED_INTEGRATION_ID,
      enabled: true,
      status: { label: 'mocked' },
    });
    expect(
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: MOCKED_INTEGRATION_ID,
          enabled: true,
          authorization: null,
        },
        metadata: {
          idempotencyKey: 'synthetic-data-api-mocked-channel',
          requestId: '00000000-0000-4000-8000-000000002683',
          now: new Date(CLOCK_VALUE),
        },
      }),
    ).toEqual(mockedChannel);

    const liveChannel = await executeSetChannelEnabledCapability({
      authenticated,
      store,
      command: {
        integrationId: LIVE_INTEGRATION_ID,
        enabled: true,
        authorization: LIVE_AUTHORIZATION,
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-live-channel',
        requestId: '00000000-0000-4000-8000-000000002682',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(liveChannel).toMatchObject({
      integrationId: LIVE_INTEGRATION_ID,
      enabled: true,
      status: { label: 'live-verified' },
    });
    expect(
      await executeSetChannelEnabledCapability({
        authenticated,
        store,
        command: {
          integrationId: LIVE_INTEGRATION_ID,
          enabled: true,
          authorization: LIVE_AUTHORIZATION,
        },
        metadata: {
          idempotencyKey: 'synthetic-data-api-live-channel',
          requestId: '00000000-0000-4000-8000-000000002684',
          now: new Date(CLOCK_VALUE),
        },
      }),
    ).toEqual(liveChannel);

    const clockStatement = client.statements.find(({ sql }) =>
      sql.includes('clock_timestamp()'),
    );
    expect(clockStatement?.sql).toContain(
      'from (select clock_timestamp() as value) as admin_database_clock',
    );
    expect(client.statements.length).toBeGreaterThan(30);
    expect(
      [...client.maximumInFlight.values()].every((maximum) => maximum === 1),
    ).toBe(true);
    expect(
      client.statements.some(({ sql }) =>
        sql.includes(
          'set transaction isolation level repeatable read, read only',
        ),
      ),
    ).toBe(true);
    expect(
      client.statements.some(({ sql }) =>
        sql.startsWith(
          'insert into "integration_channel_change_authorizations"',
        ),
      ),
    ).toBe(true);
  });
});
