import { describe, expect, test } from 'bun:test';
import type {
  AgentGrantableCapabilityId,
  FacilityScope,
} from '@psd-eoc/contracts';

import type { TrustedCapabilityInvocation } from '../capabilities/engine';
import type {
  ScopedStaleRosterEvidence,
  StaleRosterAuthorizationContext,
  StaleRosterReportStore,
} from '../roster/stale-report';
import type { AuthenticatedAgentApiKey } from './keys';
import {
  AGENT_ROSTER_STALE_THRESHOLD_SECONDS,
  createAgentRosterReportRuntime,
} from './roster-report';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000701',
  apiKey: '00000000-0000-4000-8000-000000000702',
  issuer: '00000000-0000-4000-8000-000000000703',
  facility: '00000000-0000-4000-8000-000000000704',
  otherFacility: '00000000-0000-4000-8000-000000000705',
  request: '00000000-0000-4000-8000-000000000706',
  snapshot: '00000000-0000-4000-8000-000000000707',
});

const NOW = new Date('2026-08-10T20:00:00.000Z');

function authenticated(
  facilityScope: FacilityScope,
  capabilityIds: readonly AgentGrantableCapabilityId[] = [
    'get-stale-roster-report',
  ],
): AuthenticatedAgentApiKey {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    scope: { facilityScope },
    capabilityIds,
    key: {
      id: IDS.apiKey,
      agentId: IDS.agent,
      displayName: 'Synthetic roster report agent',
      facilityScope,
      capabilityIds,
      keyPrefix: 'abcdefghijkl',
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T19:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

function invocation(
  agent: AuthenticatedAgentApiKey,
): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: agent.actor,
    source: 'agent-rest' as const,
    scope: agent.scope,
    requestId: IDS.request,
    serverTime: NOW,
    connectivityEpochId: null,
    mutation: null,
  });
}

function query(facilityId: string | null) {
  return {
    population: 'staff' as const,
    facilityId,
    cursor: null,
    limit: 200,
  };
}

function harness(evidence: ScopedStaleRosterEvidence) {
  const reads: Readonly<{
    facilityId: string | null;
    scope: FacilityScope;
  }>[] = [];
  const mutableReads = reads as {
    facilityId: string | null;
    scope: FacilityScope;
  }[];
  const store: StaleRosterReportStore<StaleRosterAuthorizationContext> = {
    async loadScopedEvidence(input, context) {
      mutableReads.push({
        facilityId: input.facilityId,
        scope: context.facilityScope,
      });
      return evidence;
    },
  };
  return {
    reads,
    runtime: createAgentRosterReportRuntime({ store }),
  };
}

describe('agent stale-roster report adapter', () => {
  test('executes the canonical report with the authenticated facility scope', async () => {
    const agent = authenticated({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const { reads, runtime } = harness({
      latestCompleteSnapshot: null,
      latestFailedSync: null,
    });

    const report = await runtime.execute(
      query(IDS.facility),
      invocation(agent),
      agent,
    );

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
    expect(reads).toEqual([
      {
        facilityId: IDS.facility,
        scope: {
          kind: 'facilities',
          facilityIds: [IDS.facility],
        },
      },
    ]);
  });

  test('denies an unscoped or cross-facility read before persistence', async () => {
    const agent = authenticated({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const { reads, runtime } = harness({
      latestCompleteSnapshot: null,
      latestFailedSync: null,
    });

    for (const facilityId of [null, IDS.otherFacility]) {
      await expect(
        runtime.execute(query(facilityId), invocation(agent), agent),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
        status: 403,
      });
    }
    expect(reads).toHaveLength(0);
  });

  test('requires an exact grant and matching authenticated actor', async () => {
    const ungranted = authenticated({ kind: 'district' }, []);
    const granted = authenticated({ kind: 'district' });
    const { reads, runtime } = harness({
      latestCompleteSnapshot: null,
      latestFailedSync: null,
    });

    await expect(
      runtime.execute(query(null), invocation(ungranted), ungranted),
    ).rejects.toMatchObject({
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      status: 403,
    });
    await expect(
      runtime.execute(query(null), invocation(granted), {
        ...granted,
        actor: { ...granted.actor, apiKeyId: IDS.otherFacility },
      }),
    ).rejects.toMatchObject({
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      status: 403,
    });
    expect(reads).toHaveLength(0);
  });

  test('uses the bounded seven-day freshness policy', async () => {
    const agent = authenticated({ kind: 'district' });
    const capturedAt = new Date(
      NOW.getTime() - (AGENT_ROSTER_STALE_THRESHOLD_SECONDS + 1) * 1_000,
    ).toISOString();
    const { runtime } = harness({
      latestCompleteSnapshot: {
        id: IDS.snapshot,
        capturedAt,
        recipientHealth: [],
        hasUnreportedStaleRecipients: false,
        staleEndpoints: [],
        hasUnreportedStaleEndpoints: false,
      },
      latestFailedSync: null,
    });

    const report = await runtime.execute(query(null), invocation(agent), agent);

    expect(report.status).toBe('stale');
    expect(report.latestCompleteAgeSeconds).toBe(
      AGENT_ROSTER_STALE_THRESHOLD_SECONDS + 1,
    );
  });
});
