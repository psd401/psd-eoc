import { describe, expect, test } from 'bun:test';
import {
  RosterHealthQuerySchema,
  SMS_OPT_OUT_REASON_CODE,
  executeCapability,
  type CapabilityExecutionAuthorizer,
  type RosterHealthQuery,
} from '@psd-eoc/contracts';

import {
  buildStaleRosterReport,
  createGetStaleRosterReportHandler,
  type ScopedStaleRosterEvidence,
  type StaleRosterReportStore,
} from './stale-report';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const STALE_THRESHOLD_SECONDS = 3_600;
const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_FACILITY_ID = '00000000-0000-4000-8000-000000000002';
const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000001';
const GROUP_SOURCE_ID = '20000000-0000-4000-8000-000000000001';
const RECIPIENT_ONE = '30000000-0000-4000-8000-000000000001';
const RECIPIENT_TWO = '30000000-0000-4000-8000-000000000002';
const ENDPOINT_ID = '40000000-0000-4000-8000-000000000001';

interface TestContext {
  readonly population: 'staff';
  readonly allowedFacilityIds: ReadonlySet<string>;
}

const DEFAULT_QUERY: RosterHealthQuery = RosterHealthQuerySchema.parse({
  population: 'staff',
  facilityId: FACILITY_ID,
  cursor: null,
  limit: 200,
});

function secondsBefore(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1_000).toISOString();
}

function snapshot(
  capturedSecondsAgo: number,
  recipientHealth: ScopedStaleRosterEvidence['latestCompleteSnapshot'] extends infer Snapshot
    ? Snapshot extends { readonly recipientHealth: infer Recipients }
      ? Recipients
      : never
    : never,
  hasUnreportedStaleRecipients = false,
  staleEndpoints: NonNullable<
    ScopedStaleRosterEvidence['latestCompleteSnapshot']
  >['staleEndpoints'] = [],
  hasUnreportedStaleEndpoints = false,
): NonNullable<ScopedStaleRosterEvidence['latestCompleteSnapshot']> {
  return {
    id: SNAPSHOT_ID,
    capturedAt: secondsBefore(capturedSecondsAgo),
    recipientHealth,
    hasUnreportedStaleRecipients,
    staleEndpoints,
    hasUnreportedStaleEndpoints,
  };
}

function groupFailure(attemptedSecondsAgo: number) {
  return {
    groupSourceRef: {
      id: GROUP_SOURCE_ID,
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: FACILITY_ID,
    },
    errorCode: 'GOOGLE_GROUP_PAGE_FAILED',
    attemptedAt: secondsBefore(attemptedSecondsAgo),
  };
}

function createAuthorizer(): CapabilityExecutionAuthorizer<TestContext> {
  return {
    authorize(request): void {
      expect(request.definition.id).toBe('get-stale-roster-report');
      expect(request.definition.operation).toBe('query');
      expect(request.humanActionRequirement.actionIds).toEqual([]);
      expect(request.invocationPolicy.principalKinds).toContain('agent');
      expect(request.invocationPolicy.sources).toContain('agent-rest');

      const query = RosterHealthQuerySchema.parse(request.input);
      if (query.population !== request.context.population) {
        throw new Error('FORBIDDEN_POPULATION');
      }
      if (
        query.facilityId !== null &&
        !request.context.allowedFacilityIds.has(query.facilityId)
      ) {
        throw new Error('FORBIDDEN_FACILITY');
      }
    },
  };
}

async function executeReport(
  evidence: ScopedStaleRosterEvidence,
  options: {
    readonly now?: Date;
    readonly query?: RosterHealthQuery;
    readonly context?: TestContext;
    readonly onStoreRead?: () => void;
  } = {},
) {
  const context =
    options.context ??
    ({
      population: 'staff',
      allowedFacilityIds: new Set([FACILITY_ID]),
    } satisfies TestContext);
  const store: StaleRosterReportStore<TestContext> = {
    async loadScopedEvidence(query, storeContext) {
      options.onStoreRead?.();
      if (query.population !== storeContext.population) {
        throw new Error('STORE_SCOPE_MISMATCH');
      }
      if (
        query.facilityId !== null &&
        !storeContext.allowedFacilityIds.has(query.facilityId)
      ) {
        throw new Error('STORE_SCOPE_MISMATCH');
      }
      return evidence;
    },
  };

  return executeCapability(
    createGetStaleRosterReportHandler({
      store,
      clock: () => options.now ?? NOW,
      staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
    }),
    options.query ?? DEFAULT_QUERY,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createAuthorizer(),
    },
  );
}

describe('stale roster report', () => {
  test('reports unknown before any complete snapshot or failed sync', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: null,
      latestFailedSync: null,
    });

    expect(report).toEqual({
      generatedAt: NOW.toISOString(),
      status: 'unknown',
      latestCompleteSnapshotId: null,
      latestCompleteCapturedAt: null,
      latestCompleteAgeSeconds: null,
      failedGroups: [],
      staleRecipients: [],
      staleEndpoints: [],
    });
  });

  test('reports a fresh snapshot with an active endpoint as current', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(60, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] },
      ]),
      latestFailedSync: null,
    });

    expect(report.status).toBe('current');
    expect(report.latestCompleteAgeSeconds).toBe(60);
    expect(report.staleRecipients).toEqual([]);
  });

  test('reports an old otherwise healthy snapshot as stale', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(STALE_THRESHOLD_SECONDS + 1, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] },
      ]),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.latestCompleteAgeSeconds).toBe(STALE_THRESHOLD_SECONDS + 1);
  });

  test('identifies a recipient with no endpoint without exposing PII', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(60, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: [] },
      ]),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([
      { recipientId: RECIPIENT_ONE, reason: 'no-endpoint' },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/email|phone|token/iu);
  });

  test('identifies a recipient whose endpoints are all inactive', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(60, [
        {
          recipientId: RECIPIENT_TWO,
          endpointStatuses: ['disabled', 'invalid'],
        },
      ]),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([
      { recipientId: RECIPIENT_TWO, reason: 'no-active-endpoint' },
    ]);
  });

  test('lists an opted-out SMS endpoint even when another channel is active', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(
        60,
        [{ recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] }],
        false,
        [
          {
            recipientId: RECIPIENT_ONE,
            endpointId: ENDPOINT_ID,
            channel: 'sms',
            status: 'disabled',
            reasonCode: SMS_OPT_OUT_REASON_CODE,
          },
        ],
      ),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([]);
    expect(report.staleEndpoints).toEqual([
      {
        recipientId: RECIPIENT_ONE,
        endpointId: ENDPOINT_ID,
        channel: 'sms',
        reason: 'sms-opted-out',
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/email|phone|token/iu);
  });

  test('keeps global stale truth when the requested page omits stale endpoints', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(60, [], false, [], true),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([]);
    expect(report.staleEndpoints).toEqual([]);
  });

  test('rejects endpoint evidence that exceeds the authorized recipient limit', async () => {
    await expect(
      executeReport(
        {
          latestCompleteSnapshot: snapshot(
            60,
            [{ recipientId: RECIPIENT_ONE, endpointStatuses: [] }],
            false,
            [
              {
                recipientId: RECIPIENT_TWO,
                endpointId: ENDPOINT_ID,
                channel: 'sms',
                status: 'disabled',
                reasonCode: SMS_OPT_OUT_REASON_CODE,
              },
            ],
          ),
          latestFailedSync: null,
        },
        {
          query: { ...DEFAULT_QUERY, limit: 1 },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_REPORT_EVIDENCE' }),
    );
  });

  test('gives a newer partial or failed sync priority over staleness', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(STALE_THRESHOLD_SECONDS + 10, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: [] },
      ]),
      latestFailedSync: {
        outcome: 'partial-rejected',
        completedAt: secondsBefore(30),
        groupFailures: [groupFailure(45)],
      },
    });

    expect(report.status).toBe('failed');
    expect(report.failedGroups).toEqual([groupFailure(45)]);
    expect(report.staleRecipients).toEqual([
      { recipientId: RECIPIENT_ONE, reason: 'no-endpoint' },
    ]);
  });

  test('clears old failure evidence after a newer complete snapshot recovers', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(60, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] },
      ]),
      latestFailedSync: {
        outcome: 'failed',
        completedAt: secondsBefore(120),
        groupFailures: [groupFailure(150)],
      },
    });

    expect(report.status).toBe('current');
    expect(report.failedGroups).toEqual([]);
  });

  test('uses exact whole-second age and becomes stale only above threshold', async () => {
    const evidence: ScopedStaleRosterEvidence = {
      latestCompleteSnapshot: snapshot(STALE_THRESHOLD_SECONDS, [
        { recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] },
      ]),
      latestFailedSync: null,
    };

    const atThreshold = buildStaleRosterReport(evidence, {
      generatedAt: NOW,
      staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
    });
    const aboveThreshold = await executeReport(evidence, {
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(atThreshold.latestCompleteAgeSeconds).toBe(STALE_THRESHOLD_SECONDS);
    expect(atThreshold.status).toBe('current');
    expect(aboveThreshold.latestCompleteAgeSeconds).toBe(
      STALE_THRESHOLD_SECONDS + 1,
    );
    expect(aboveThreshold.status).toBe('stale');
  });

  test('treats omitted stale recipients as stale without inventing identities', async () => {
    const report = await executeReport({
      latestCompleteSnapshot: snapshot(
        60,
        [{ recipientId: RECIPIENT_ONE, endpointStatuses: ['active'] }],
        true,
      ),
      latestFailedSync: null,
    });

    expect(report.status).toBe('stale');
    expect(report.staleRecipients).toEqual([]);
  });

  test('authorizes facility scope before the store can read evidence', async () => {
    let storeReads = 0;
    const unauthorizedQuery = RosterHealthQuerySchema.parse({
      ...DEFAULT_QUERY,
      facilityId: OTHER_FACILITY_ID,
    });

    await expect(
      executeReport(
        { latestCompleteSnapshot: null, latestFailedSync: null },
        {
          query: unauthorizedQuery,
          onStoreRead: () => {
            storeReads += 1;
          },
        },
      ),
    ).rejects.toThrow('FORBIDDEN_FACILITY');
    expect(storeReads).toBe(0);
  });

  test('rejects future and internally inconsistent store evidence', async () => {
    await expect(
      executeReport({
        latestCompleteSnapshot: {
          ...snapshot(60, []),
          capturedAt: new Date(NOW.getTime() + 1_000).toISOString(),
        },
        latestFailedSync: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REPORT_EVIDENCE' });

    await expect(
      executeReport({
        latestCompleteSnapshot: null,
        latestFailedSync: {
          outcome: 'failed',
          completedAt: secondsBefore(60),
          groupFailures: [groupFailure(30)],
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REPORT_EVIDENCE' });
  });
});
