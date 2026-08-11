import {
  IntegrationChannelChangeAuthorizationSchema,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
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
import {
  executeListUsersCapability,
  executeSetUserRolesCapability,
} from '../access/capabilities';
import {
  executeIntegrationHealthProjection,
  executeSetChannelEnabledCapability,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
} from '../integrations/capabilities';
import { executeRosterHealthProjection } from '../integrations/roster-health';
import { createDrizzleAdminCapabilityStore } from './admin-core';
import {
  executeCreateAudienceConfigVersionCapability,
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeCreateNeighborhoodVersionCapability,
  executeGetAudienceConfigCapability,
  executeGetAudienceConfigVersionCapability,
  executeGetFacilityCapability,
  executeGetNeighborhoodVersionCapability,
  executeListFacilitiesCapability,
  executeListGroupSourcesCapability,
  executeListNeighborhoodsCapability,
  executeListNeighborhoodVersionsCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from './capabilities';

const CLOCK_VALUE = '2026-08-10T12:00:00.000Z';
const USER_ID = '00000000-0000-4000-8000-000000002670';
const SECOND_USER_ID = '00000000-0000-4000-8000-000000002675';
const SESSION_ID = '00000000-0000-4000-8000-000000002671';
const MOCKED_INTEGRATION_ID = 'synthetic-mocked-push';
const MOCKED_STATUS_ID = '00000000-0000-4000-8000-000000002676';
const LIVE_INTEGRATION_ID = 'synthetic-live-push';
const LIVE_STATUS_ID = '00000000-0000-4000-8000-000000002677';
const LIVE_AUTHORIZATION_ID = '00000000-0000-4000-8000-000000002678';
const FACILITY_ID = '00000000-0000-4000-8000-000000009001';
const NEIGHBORHOOD_ID = '00000000-0000-4000-8000-000000009002';
const ORIGINAL_GROUP_SOURCE_ID = '00000000-0000-4000-8000-000000009003';
const REPLACEMENT_GROUP_SOURCE_ID = '00000000-0000-4000-8000-000000009004';
const ROSTER_CONFIGURATION_ID = '00000000-0000-4000-8000-000000009005';
const AUDIENCE_CONFIGURATION_ID = '00000000-0000-4000-8000-000000009006';

const CAPABILITY_MATRIX = Object.freeze([
  'create-facility',
  'list-facilities',
  'get-facility',
  'update-facility',
  'create-neighborhood-version',
  'list-neighborhoods',
  'list-neighborhood-versions',
  'get-neighborhood-version',
  'create-group-source',
  'list-group-sources',
  'update-group-source',
  'create-audience-config-version',
  'get-audience-config',
  'get-audience-config-version',
  'list-users',
  'set-user-roles',
  'get-integration-health',
  'set-channel-enabled',
  'get-stale-roster-report',
] as const satisfies readonly RegisteredCapabilityId[]);

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
  private readonly groupSources = new Map<
    string,
    Readonly<{
      id: string;
      displayName: string;
      googleGroupId: string;
      email: string;
    }>
  >();
  private readonly idempotencyById = new Map<string, FakeIdempotencyRecord>();
  private readonly inFlight = new Map<string, number>();
  private audienceVersion = 0;
  private facilityCreated = false;
  private facilityUpdated = false;
  private neighborhoodVersion = 0;
  private nextIdempotencyRecord = 0;
  private nextTransaction = 0;
  private rosterConfigurationVersion = 0;
  private roleStaffGranted = false;

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
    if (sql.startsWith('insert into "facilities"')) {
      this.facilityCreated = true;
      return {
        records: [
          [
            { stringValue: FACILITY_ID },
            { stringValue: 'DATA-API' },
            { stringValue: 'Synthetic Data API facility' },
            { booleanValue: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.startsWith('update "facilities"')) {
      this.facilityUpdated = true;
      return {
        records: [
          [
            { stringValue: FACILITY_ID },
            { stringValue: 'DATA-API-2' },
            { stringValue: 'Synthetic Data API facility revised' },
            { booleanValue: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.includes('from "facilities"')) {
      if (!this.facilityCreated) return { records: [], $metadata: {} };
      if (sql.includes('"code"')) {
        return {
          records: [
            [
              { stringValue: FACILITY_ID },
              { stringValue: this.facilityUpdated ? 'DATA-API-2' : 'DATA-API' },
              {
                stringValue: this.facilityUpdated
                  ? 'Synthetic Data API facility revised'
                  : 'Synthetic Data API facility',
              },
              { booleanValue: true },
              { stringValue: CLOCK_VALUE },
            ],
          ],
          $metadata: {},
        };
      }
      if (sql.includes('"active"')) {
        return {
          records: [[{ stringValue: FACILITY_ID }, { booleanValue: true }]],
          $metadata: {},
        };
      }
      return {
        records: [[{ stringValue: FACILITY_ID }]],
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "neighborhood_versions"')) {
      this.neighborhoodVersion += 1;
      return {
        records: [
          [
            { stringValue: NEIGHBORHOOD_ID },
            { longValue: this.neighborhoodVersion },
            { stringValue: 'Synthetic Data API neighborhood' },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "neighborhood_facilities"')) {
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.includes('from "neighborhood_facilities"')) {
      return this.neighborhoodVersion > 0
        ? {
            records: [[{ stringValue: FACILITY_ID }]],
            $metadata: {},
          }
        : { records: [], $metadata: {} };
    }
    if (sql.includes('from "neighborhood_versions"')) {
      if (this.neighborhoodVersion === 0) {
        return { records: [], $metadata: {} };
      }
      if (
        sql.startsWith('select "version"') ||
        sql.startsWith('select "neighborhood_versions"."version"')
      ) {
        return {
          records: [[{ longValue: this.neighborhoodVersion }]],
          $metadata: {},
        };
      }
      if (
        !sql.includes('"neighborhood_versions"."name"') &&
        !sql.includes('"name"')
      ) {
        return {
          records: [[{ stringValue: NEIGHBORHOOD_ID }]],
          $metadata: {},
        };
      }
      return {
        records: [
          [
            { stringValue: NEIGHBORHOOD_ID },
            { longValue: this.neighborhoodVersion },
            { stringValue: 'Synthetic Data API neighborhood' },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "roster_source_configurations"')) {
      this.rosterConfigurationVersion += 1;
      return {
        records: [[{ stringValue: CLOCK_VALUE }]],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (
      sql.startsWith('insert into "roster_source_configuration_facilities"')
    ) {
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.startsWith('insert into "roster_source_configuration_groups"')) {
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.includes('from "roster_source_configurations"')) {
      const population = parameterStrings.find(
        (value) => value === 'staff' || value === 'synthetic',
      );
      if (population !== 'staff' || this.rosterConfigurationVersion === 0) {
        return { records: [], $metadata: {} };
      }
      if (sql.includes('group by')) {
        return {
          records: [[{ stringValue: ROSTER_CONFIGURATION_ID }]],
          $metadata: {},
        };
      }
      return {
        records: [
          [
            { stringValue: ROSTER_CONFIGURATION_ID },
            { longValue: this.rosterConfigurationVersion },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.includes('from "roster_source_configuration_facilities"')) {
      return this.rosterConfigurationVersion === 0
        ? { records: [], $metadata: {} }
        : {
            records: [[{ stringValue: FACILITY_ID }]],
            $metadata: {},
          };
    }
    if (
      sql.includes('from "roster_source_configuration_groups"') &&
      sql.includes('inner join "group_sources"')
    ) {
      const effectiveId =
        this.rosterConfigurationVersion >= 2
          ? REPLACEMENT_GROUP_SOURCE_ID
          : ORIGINAL_GROUP_SOURCE_ID;
      const source = this.groupSources.get(effectiveId);
      if (source === undefined) return { records: [], $metadata: {} };
      return {
        records: [
          [
            { stringValue: source.id },
            { stringValue: 'google-group' },
            { stringValue: 'building' },
            { stringValue: FACILITY_ID },
            { stringValue: source.displayName },
            { booleanValue: true },
            { stringValue: source.googleGroupId },
            { stringValue: source.email },
            { isNull: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "group_sources"')) {
      const replacement = this.groupSources.size > 0;
      const source = replacement
        ? {
            id: REPLACEMENT_GROUP_SOURCE_ID,
            displayName: 'Synthetic Data API building staff replacement',
            googleGroupId: 'synthetic-data-api-building-staff-v2',
            email: 'synthetic-data-api-building-staff-v2@example.invalid',
          }
        : {
            id: ORIGINAL_GROUP_SOURCE_ID,
            displayName: 'Synthetic Data API building staff',
            googleGroupId: 'synthetic-data-api-building-staff',
            email: 'synthetic-data-api-building-staff@example.invalid',
          };
      this.groupSources.set(source.id, source);
      return {
        records: [
          [
            { stringValue: source.id },
            { stringValue: 'google-group' },
            { stringValue: 'building' },
            { stringValue: FACILITY_ID },
            { stringValue: source.displayName },
            { booleanValue: true },
            { stringValue: source.googleGroupId },
            { stringValue: source.email },
            { isNull: true },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.includes('from "group_sources"')) {
      if (
        sql.includes('"facility_id"') &&
        sql.includes('"kind"') &&
        !sql.includes('"display_name"')
      ) {
        return {
          records: [
            [{ stringValue: FACILITY_ID }, { stringValue: 'google-group' }],
          ],
          $metadata: {},
        };
      }
      if (
        !sql.includes('"group_sources"."display_name"') &&
        !sql.includes('"display_name"')
      ) {
        return { records: [], $metadata: {} };
      }
      const requestedId = parameterStrings.find((value) =>
        this.groupSources.has(value),
      );
      const sources =
        requestedId === undefined
          ? [...this.groupSources.values()]
          : [this.groupSources.get(requestedId)].filter(
              (source): source is NonNullable<typeof source> =>
                source !== undefined,
            );
      return {
        records: sources.map((source) => [
          { stringValue: source.id },
          { stringValue: 'google-group' },
          { stringValue: 'building' },
          { stringValue: FACILITY_ID },
          { stringValue: source.displayName },
          { booleanValue: true },
          { stringValue: source.googleGroupId },
          { stringValue: source.email },
          { isNull: true },
          { stringValue: CLOCK_VALUE },
        ]),
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "audience_configurations"')) {
      this.audienceVersion += 1;
      return {
        records: [
          [
            { stringValue: AUDIENCE_CONFIGURATION_ID },
            { stringValue: FACILITY_ID },
            { longValue: this.audienceVersion },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        numberOfRecordsUpdated: 1,
        $metadata: {},
      };
    }
    if (sql.startsWith('insert into "audience_targets"')) {
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.includes('from "audience_targets"')) {
      return this.audienceVersion > 0
        ? {
            records: [
              [
                { stringValue: AUDIENCE_CONFIGURATION_ID },
                { longValue: this.audienceVersion },
                { longValue: 1 },
                { stringValue: 'building' },
                { stringValue: FACILITY_ID },
                { isNull: true },
                { isNull: true },
                { isNull: true },
              ],
            ],
            $metadata: {},
          }
        : { records: [], $metadata: {} };
    }
    if (sql.includes('from "audience_configurations"')) {
      if (this.audienceVersion === 0) return { records: [], $metadata: {} };
      if (sql.includes('group by')) {
        return {
          records: [[{ stringValue: AUDIENCE_CONFIGURATION_ID }]],
          $metadata: {},
        };
      }
      if (sql.startsWith('select "facility_id", "version"')) {
        return {
          records: [
            [{ stringValue: FACILITY_ID }, { longValue: this.audienceVersion }],
          ],
          $metadata: {},
        };
      }
      if (sql.startsWith('select "id", "version"')) {
        return {
          records: [
            [
              { stringValue: AUDIENCE_CONFIGURATION_ID },
              { longValue: this.audienceVersion },
            ],
          ],
          $metadata: {},
        };
      }
      return {
        records: [
          [
            { stringValue: AUDIENCE_CONFIGURATION_ID },
            { stringValue: FACILITY_ID },
            { longValue: this.audienceVersion },
            { stringValue: CLOCK_VALUE },
          ],
        ],
        $metadata: {},
      };
    }
    if (sql.includes('from "users"') && sql.includes('order by')) {
      return {
        records: [
          [
            { stringValue: USER_ID },
            { stringValue: 'synthetic-google-subject-2670' },
            { stringValue: 'synthetic-admin@psd401.net' },
            { stringValue: 'Synthetic Administrator' },
            { stringValue: 'district' },
            { stringValue: CLOCK_VALUE },
            { isNull: true },
          ],
          [
            { stringValue: SECOND_USER_ID },
            { stringValue: 'synthetic-google-subject-2675' },
            { stringValue: 'synthetic-operator@psd401.net' },
            { stringValue: 'Synthetic Operator' },
            { stringValue: 'district' },
            { stringValue: CLOCK_VALUE },
            { isNull: true },
          ],
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
    if (sql.startsWith('insert into "user_role_changes"')) {
      this.roleStaffGranted = true;
      return { numberOfRecordsUpdated: 1, $metadata: {} };
    }
    if (sql.includes('role_base_grants')) {
      return {
        records: [
          ...(this.roleStaffGranted
            ? [[{ stringValue: 'staff' }, { booleanValue: true }]]
            : []),
          [{ stringValue: 'admin' }, { booleanValue: true }],
        ],
        $metadata: {},
      };
    }
    if (
      sql.startsWith('select distinct on (') &&
      sql.includes('from "user_role_changes"') &&
      !sql.includes('effective_admin_roles')
    ) {
      return this.roleStaffGranted
        ? {
            records: [
              [
                { stringValue: SECOND_USER_ID },
                { longValue: 1 },
                { stringValue: 'staff' },
                { booleanValue: true },
              ],
            ],
            $metadata: {},
          }
        : { records: [], $metadata: {} };
    }
    if (sql.includes('effective_admin_roles')) {
      return {
        records: [
          [{ stringValue: USER_ID }],
          [{ stringValue: SECOND_USER_ID }],
        ],
        $metadata: {},
      };
    }
    if (sql.includes('from "user_roles"')) {
      if (sql.includes('"user_id"') && sql.includes('order by')) {
        return {
          records: [
            [{ stringValue: USER_ID }, { stringValue: 'admin' }],
            [{ stringValue: SECOND_USER_ID }, { stringValue: 'admin' }],
          ],
          $metadata: {},
        };
      }
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

    const executedCapabilities = new Set<RegisteredCapabilityId>();
    const createdFacility = await executeCreateFacilityCapability({
      authenticated,
      store,
      command: {
        code: 'DATA-API',
        name: 'Synthetic Data API facility',
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-create-facility',
        requestId: '00000000-0000-4000-8000-000000009101',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('create-facility');
    expect(createdFacility.id).toBe(FACILITY_ID);

    const facilities = await executeListFacilitiesCapability({
      authenticated,
      store,
      query: { includeInactive: true, cursor: null, limit: 10 },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009102',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('list-facilities');
    expect(facilities.items.map(({ id }) => id)).toEqual([FACILITY_ID]);

    const facility = await executeGetFacilityCapability({
      authenticated,
      store,
      query: { facilityId: FACILITY_ID },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009103',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('get-facility');
    expect(facility).toEqual(createdFacility);

    const updatedFacility = await executeUpdateFacilityCapability({
      authenticated,
      store,
      command: {
        facilityId: FACILITY_ID,
        code: 'DATA-API-2',
        name: 'Synthetic Data API facility revised',
        active: true,
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-update-facility',
        requestId: '00000000-0000-4000-8000-000000009104',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('update-facility');
    expect(updatedFacility).toMatchObject({
      id: FACILITY_ID,
      code: 'DATA-API-2',
      active: true,
    });

    await executeCreateNeighborhoodVersionCapability({
      authenticated,
      store,
      command: {
        neighborhoodId: null,
        name: 'Synthetic Data API neighborhood',
        facilityIds: [FACILITY_ID],
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-create-neighborhood',
        requestId: '00000000-0000-4000-8000-000000009105',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('create-neighborhood-version');
    const supersedingNeighborhood =
      await executeCreateNeighborhoodVersionCapability({
        authenticated,
        store,
        command: {
          neighborhoodId: NEIGHBORHOOD_ID,
          name: 'Synthetic Data API neighborhood revised',
          facilityIds: [FACILITY_ID],
        },
        metadata: {
          idempotencyKey: 'synthetic-data-api-supersede-neighborhood',
          requestId: '00000000-0000-4000-8000-000000009116',
          now: new Date(CLOCK_VALUE),
        },
      });
    expect(supersedingNeighborhood.version).toBe(2);

    const neighborhoods = await executeListNeighborhoodsCapability({
      authenticated,
      store,
      query: { cursor: null, limit: 10 },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009106',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('list-neighborhoods');
    expect(neighborhoods.items).toHaveLength(1);

    const neighborhoodVersions =
      await executeListNeighborhoodVersionsCapability({
        authenticated,
        store,
        query: {
          neighborhoodId: NEIGHBORHOOD_ID,
          cursor: null,
          limit: 10,
        },
        metadata: {
          requestId: '00000000-0000-4000-8000-000000009107',
          now: new Date(CLOCK_VALUE),
        },
      });
    executedCapabilities.add('list-neighborhood-versions');
    expect(neighborhoodVersions.items[0]?.version).toBe(2);

    const neighborhood = await executeGetNeighborhoodVersionCapability({
      authenticated,
      store,
      query: { neighborhood: { id: NEIGHBORHOOD_ID, version: 2 } },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009108',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('get-neighborhood-version');
    expect(neighborhood.facilityIds).toEqual([FACILITY_ID]);

    const originalGroup = await executeCreateGroupSourceCapability({
      authenticated,
      store,
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: FACILITY_ID,
        displayName: 'Synthetic Data API building staff',
        active: true,
        googleGroupId: 'synthetic-data-api-building-staff',
        email: 'synthetic-data-api-building-staff@example.invalid',
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-create-group-source',
        requestId: '00000000-0000-4000-8000-000000009109',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('create-group-source');
    expect(originalGroup.id).toBe(ORIGINAL_GROUP_SOURCE_ID);

    const groupSources = await executeListGroupSourcesCapability({
      authenticated,
      store,
      query: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: FACILITY_ID,
        active: null,
        cursor: null,
        limit: 10,
      },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009110',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('list-group-sources');
    expect(groupSources.items.map(({ id }) => id)).toEqual([
      ORIGINAL_GROUP_SOURCE_ID,
    ]);

    const replacementGroup = await executeUpdateGroupSourceCapability({
      authenticated,
      store,
      command: {
        id: ORIGINAL_GROUP_SOURCE_ID,
        kind: 'google-group',
        purpose: 'building',
        facilityId: FACILITY_ID,
        displayName: 'Synthetic Data API building staff replacement',
        active: true,
        googleGroupId: 'synthetic-data-api-building-staff-v2',
        email: 'synthetic-data-api-building-staff-v2@example.invalid',
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-replace-group-source',
        requestId: '00000000-0000-4000-8000-000000009111',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('update-group-source');
    expect(replacementGroup.id).toBe(REPLACEMENT_GROUP_SOURCE_ID);

    const createdAudience = await executeCreateAudienceConfigVersionCapability({
      authenticated,
      store,
      command: {
        audienceConfigId: null,
        facilityId: FACILITY_ID,
        targets: [{ kind: 'building', facilityId: FACILITY_ID }],
      },
      metadata: {
        idempotencyKey: 'synthetic-data-api-create-audience',
        requestId: '00000000-0000-4000-8000-000000009112',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('create-audience-config-version');
    expect(createdAudience.version).toBe(1);

    const supersedingAudience =
      await executeCreateAudienceConfigVersionCapability({
        authenticated,
        store,
        command: {
          audienceConfigId: AUDIENCE_CONFIGURATION_ID,
          facilityId: FACILITY_ID,
          targets: [{ kind: 'building', facilityId: FACILITY_ID }],
        },
        metadata: {
          idempotencyKey: 'synthetic-data-api-supersede-audience',
          requestId: '00000000-0000-4000-8000-000000009117',
          now: new Date(CLOCK_VALUE),
        },
      });
    expect(supersedingAudience.version).toBe(2);

    const audience = await executeGetAudienceConfigCapability({
      authenticated,
      store,
      query: { facilityId: FACILITY_ID },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009113',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('get-audience-config');
    expect(audience.facilityId).toBe(FACILITY_ID);

    const audienceVersion = await executeGetAudienceConfigVersionCapability({
      authenticated,
      store,
      query: {
        audienceConfig: { id: AUDIENCE_CONFIGURATION_ID, version: 2 },
      },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000009114',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('get-audience-config-version');
    expect(audienceVersion.targets).toEqual([
      { kind: 'building', facilityId: FACILITY_ID },
    ]);

    const listStatementStart = client.statements.length;
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
    executedCapabilities.add('list-users');
    expect(users.items.map(({ id }) => id)).toEqual([USER_ID, SECOND_USER_ID]);
    expect(users.items.map(({ roles }) => roles)).toEqual([
      ['admin'],
      ['admin'],
    ]);
    const listProjectionStatements = client.statements
      .slice(listStatementStart)
      .filter(
        ({ sql }) =>
          sql.includes('from "users"') ||
          sql.startsWith('select "user_id", "role" from "user_roles"') ||
          (sql.startsWith('select distinct on (') &&
            sql.includes('from "user_role_changes"')) ||
          sql.startsWith(
            'select "user_id", "facility_id" from "user_facility_scopes"',
          ),
      );
    expect(listProjectionStatements).toHaveLength(4);

    const roleResult = await executeSetUserRolesCapability({
      authenticated,
      store,
      command: { userId: SECOND_USER_ID, roles: ['staff', 'admin'] },
      metadata: {
        idempotencyKey: 'synthetic-data-api-set-user-roles',
        requestId: '00000000-0000-4000-8000-000000009115',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('set-user-roles');
    expect(roleResult.roles).toEqual(['staff', 'admin']);

    const usersAfterRoleChange = await executeListUsersCapability({
      authenticated,
      store,
      query: {
        facilityId: null,
        includeDisabled: true,
        cursor: null,
        limit: 10,
      },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000002685',
        now: new Date(CLOCK_VALUE),
      },
    });
    expect(
      usersAfterRoleChange.items.map(({ id, roles }) => ({ id, roles })),
    ).toEqual([
      { id: USER_ID, roles: ['admin'] },
      { id: SECOND_USER_ID, roles: ['staff', 'admin'] },
    ]);

    const integration = await executeIntegrationHealthProjection({
      authenticated,
      store,
      query: { integrationId: null },
      metadata: {
        requestId: '00000000-0000-4000-8000-000000002674',
        now: new Date(CLOCK_VALUE),
      },
    });
    executedCapabilities.add('get-integration-health');
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
    executedCapabilities.add('get-stale-roster-report');
    expect(roster.lastSync).toBeNull();
    expect(roster.report).toMatchObject({
      status: 'unknown',
      latestCompleteSnapshotId: null,
      staleRecipients: [],
    });
    executedCapabilities.add('set-channel-enabled');

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
    expect([...executedCapabilities].sort()).toEqual(
      [...CAPABILITY_MATRIX].sort(),
    );
  });
});
