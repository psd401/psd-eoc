import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import type {
  AgentApiKeyIssuance,
  AgentApiKeyRevocation,
  AgentApiKeySummary,
} from '@psd-eoc/contracts';

import {
  AgentApiKeyError,
  AgentApiKeyIssuanceReplayError,
} from '../../../lib/agents/keys';
import {
  handleIssueAgentApiKeyAction,
  handleRevokeAgentApiKeyAction,
  type AgentAdminActionHandlerDependencies,
} from './action-handlers';

const IDS = Object.freeze({
  user: '30000000-0000-4000-8000-000000000001',
  session: '30000000-0000-4000-8000-000000000002',
  connectivityEpoch: '30000000-0000-4000-8000-000000000003',
  agent: '30000000-0000-4000-8000-000000000004',
  apiKey: '30000000-0000-4000-8000-000000000005',
  facility: '30000000-0000-4000-8000-000000000006',
  revocation: '30000000-0000-4000-8000-000000000007',
});

const SUBMITTED_IDEMPOTENCY_KEY = 'issue-agent-key-request-0001';
const GENERATED_IDEMPOTENCY_KEY = 'issue-agent-key-request-0002';

const KEY: AgentApiKeySummary = Object.freeze({
  id: IDS.apiKey,
  agentId: IDS.agent,
  displayName: 'Synthetic reporting agent',
  facilityScope: {
    kind: 'facilities' as const,
    facilityIds: [IDS.facility],
  },
  capabilityIds: ['get-event', 'prepare-activation'] as const,
  keyPrefix: 'synthkey01',
  issuedByUserId: IDS.user,
  issuedAt: '2026-08-10T18:00:00.000Z',
  expiresAt: '2026-11-08T18:00:00.000Z',
  revokedAt: null,
});

const ISSUANCE: AgentApiKeyIssuance = Object.freeze({
  key: KEY,
  oneTimeCredential: 'synthetic-one-time-value'.padEnd(32, 'x'),
});

const REVOCATION: AgentApiKeyRevocation = Object.freeze({
  id: IDS.revocation,
  apiKeyId: IDS.apiKey,
  revokedByUserId: IDS.user,
  reasonCode: 'ADMIN_KEY_ROTATION',
  revokedAt: '2026-08-10T18:05:00.000Z',
});

const ACCESS = Object.freeze({
  actor: {
    kind: 'human' as const,
    userId: IDS.user,
    sessionId: IDS.session,
  },
  source: 'web' as const,
  roles: ['admin'] as const,
  capabilityGrants: [] as const,
  scope: { facilityScope: { kind: 'district' as const } },
  connectivityEpochId: IDS.connectivityEpoch,
});

type Administration = AgentAdminActionHandlerDependencies['administration'];
type IssueRequest = Parameters<Administration['issue']>[0];
type RevokeRequest = Parameters<Administration['revoke']>[0];

interface ActionHarness {
  readonly dependencies: AgentAdminActionHandlerDependencies;
  readonly issueCalls: IssueRequest[];
  readonly revokeCalls: RevokeRequest[];
  readonly revalidationCalls: { count: number };
}

function actionHarness(
  input: Readonly<{
    issueError?: Error;
    revokeError?: Error;
    revalidated?: boolean;
    revalidationError?: Error;
  }> = {},
): ActionHarness {
  const issueCalls: IssueRequest[] = [];
  const revokeCalls: RevokeRequest[] = [];
  const revalidationCalls = { count: 0 };
  return {
    issueCalls,
    revokeCalls,
    revalidationCalls,
    dependencies: {
      access: ACCESS,
      administration: {
        async issue(request) {
          issueCalls.push(request);
          if (input.issueError !== undefined) throw input.issueError;
          return ISSUANCE;
        },
        async revoke(request) {
          revokeCalls.push(request);
          if (input.revokeError !== undefined) throw input.revokeError;
          return REVOCATION;
        },
      },
      createIdempotencyKey: () => GENERATED_IDEMPOTENCY_KEY,
      revalidateAgents() {
        revalidationCalls.count += 1;
        if (input.revalidationError !== undefined) {
          throw input.revalidationError;
        }
        return input.revalidated ?? true;
      },
    },
  };
}

function submission(
  fields: Readonly<Record<string, string | readonly string[]>>,
): FormData {
  const formData = new FormData();
  for (const [name, rawValues] of Object.entries(fields)) {
    const values = typeof rawValues === 'string' ? [rawValues] : rawValues;
    for (const value of values) formData.append(name, value);
  }
  return formData;
}

function validIssueSubmission(): FormData {
  return submission({
    idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
    agentId: '',
    displayName: 'Synthetic reporting agent',
    facilityScopeKind: 'facilities',
    facilityIds: [IDS.facility],
    capabilityIds: ['get-event', 'prepare-activation'],
    expiresInSeconds: '7776000',
  });
}

function validRevokeSubmission(): FormData {
  return submission({
    confirmRevocation: 'confirmed',
    apiKeyId: IDS.apiKey,
    reasonCode: 'ADMIN_KEY_ROTATION',
    idempotencyKey: `revoke-agent-key:${IDS.apiKey}`,
  });
}

describe('agent administration action handlers', () => {
  test('keeps server-only actions responsible for authentication and production wiring', () => {
    const source = readFileSync(
      new URL('./actions.ts', import.meta.url),
      'utf8',
    );

    expect(source.startsWith("'use server';")).toBe(true);
    expect(
      source.match(/await authenticateAdministrationSession\(\)/gu),
    ).toHaveLength(2);
    expect(source).toContain('getDefaultAgentApiKeyAdministration()');
    expect(source).toContain(
      'agentApiKeyAdministrationAccessFromSession(authenticated)',
    );
    expect(source).toContain('revalidateAgents: bestEffortRevalidateAgents');
  });

  test('parses a scoped issuance and rotates the form idempotency key only after success', async () => {
    const harness = actionHarness();
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      validIssueSubmission(),
      harness.dependencies,
    );

    expect(harness.issueCalls).toEqual([
      {
        access: ACCESS,
        value: {
          agentId: null,
          displayName: 'Synthetic reporting agent',
          facilityScope: {
            kind: 'facilities',
            facilityIds: [IDS.facility],
          },
          capabilityIds: ['get-event', 'prepare-activation'],
          expiresInSeconds: 7_776_000,
        },
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        csrfVerified: true,
      },
    ]);
    expect(result.issuedKey?.key).toEqual(KEY);
    expect(result.idempotencyKey).toBe(GENERATED_IDEMPOTENCY_KEY);
    expect(result.notice).toMatchObject({ kind: 'success' });
    expect(harness.revalidationCalls.count).toBe(1);
  });

  test('retains a successful issuance when cache revalidation is unavailable', async () => {
    const harness = actionHarness({ revalidated: false });
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      validIssueSubmission(),
      harness.dependencies,
    );

    expect(result.issuedKey?.key.id).toBe(IDS.apiKey);
    expect(result.notice).toMatchObject({ kind: 'success' });
    expect(result.notice?.message).toContain('then refresh');
  });

  test('retains a successful issuance when revalidation throws after commit', async () => {
    const harness = actionHarness({
      revalidationError: new Error('Synthetic cache failure.'),
    });
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      validIssueSubmission(),
      harness.dependencies,
    );

    expect(result.issuedKey?.key.id).toBe(IDS.apiKey);
    expect(result.notice).toMatchObject({ kind: 'success' });
    expect(result.notice?.message).toContain('then refresh');
  });

  test('rejects malformed issuance form data without calling administration', async () => {
    const harness = actionHarness();
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      submission({
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        displayName: '',
        facilityScopeKind: 'facilities',
        facilityIds: [IDS.facility],
        capabilityIds: ['get-event'],
        expiresInSeconds: 'not-a-number',
      }),
      harness.dependencies,
    );

    expect(harness.issueCalls).toEqual([]);
    expect(result).toMatchObject({
      issuedKey: null,
      idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
      notice: { kind: 'error' },
    });
    expect(harness.revalidationCalls.count).toBe(0);
  });

  test('replaces invalid retained idempotency state when the submission is invalid', async () => {
    const harness = actionHarness();
    const result = await handleIssueAgentApiKeyAction(
      { issuedKey: null, idempotencyKey: 'invalid', notice: null },
      submission({ idempotencyKey: 'invalid' }),
      harness.dependencies,
    );

    expect(harness.issueCalls).toEqual([]);
    expect(result.idempotencyKey).toBe(GENERATED_IDEMPOTENCY_KEY);
    expect(result.notice).toMatchObject({ kind: 'error' });
  });

  test('reports issuance replay without re-emitting a credential', async () => {
    const harness = actionHarness({
      issueError: new AgentApiKeyIssuanceReplayError(KEY),
    });
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      validIssueSubmission(),
      harness.dependencies,
    );

    expect(result.issuedKey).toBeNull();
    expect(result.idempotencyKey).toBe(SUBMITTED_IDEMPOTENCY_KEY);
    expect(result.notice?.message).toContain(KEY.keyPrefix);
    expect(result.notice?.message).toContain('cannot be shown again');
    expect(harness.revalidationCalls.count).toBe(1);
  });

  test('bounds an unknown issuance failure without revalidation', async () => {
    const harness = actionHarness({
      issueError: new Error('Synthetic internal failure.'),
    });
    const result = await handleIssueAgentApiKeyAction(
      {
        issuedKey: null,
        idempotencyKey: SUBMITTED_IDEMPOTENCY_KEY,
        notice: null,
      },
      validIssueSubmission(),
      harness.dependencies,
    );

    expect(result).toMatchObject({
      issuedKey: null,
      notice: {
        kind: 'error',
        message:
          'The key was not issued. Check the requested scope or ask a district administrator to review access.',
      },
    });
    expect(harness.revalidationCalls.count).toBe(0);
  });

  test('requires an explicit revocation confirmation before parsing or mutation', async () => {
    const harness = actionHarness();
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      submission({
        apiKeyId: IDS.apiKey,
        reasonCode: 'ADMIN_KEY_ROTATION',
        idempotencyKey: `revoke-agent-key:${IDS.apiKey}`,
      }),
      harness.dependencies,
    );

    expect(result.notice).toEqual({
      kind: 'error',
      message: 'Confirm revocation before submitting this action.',
    });
    expect(harness.revokeCalls).toEqual([]);
    expect(harness.revalidationCalls.count).toBe(0);
  });

  test('rejects malformed confirmed revocation data without mutation', async () => {
    const harness = actionHarness();
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      submission({
        confirmRevocation: 'confirmed',
        apiKeyId: 'not-a-key-id',
        reasonCode: 'invalid reason',
        idempotencyKey: 'short',
      }),
      harness.dependencies,
    );

    expect(result.notice).toMatchObject({ kind: 'error' });
    expect(harness.revokeCalls).toEqual([]);
    expect(harness.revalidationCalls.count).toBe(0);
  });

  test('submits append-only revocation metadata and reports success', async () => {
    const harness = actionHarness();
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      validRevokeSubmission(),
      harness.dependencies,
    );

    expect(harness.revokeCalls).toEqual([
      {
        access: ACCESS,
        value: {
          apiKeyId: IDS.apiKey,
          reasonCode: 'ADMIN_KEY_ROTATION',
        },
        idempotencyKey: `revoke-agent-key:${IDS.apiKey}`,
        csrfVerified: true,
      },
    ]);
    expect(result.notice).toEqual({
      kind: 'success',
      message: 'The key was revoked and can no longer authenticate.',
    });
    expect(harness.revalidationCalls.count).toBe(1);
  });

  test('retains revocation truth when cache revalidation is unavailable', async () => {
    const harness = actionHarness({ revalidated: false });
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      validRevokeSubmission(),
      harness.dependencies,
    );

    expect(result.notice).toMatchObject({ kind: 'success' });
    expect(result.notice?.message).toContain('Refresh to update');
  });

  test('retains revocation truth when revalidation throws after commit', async () => {
    const harness = actionHarness({
      revalidationError: new Error('Synthetic cache failure.'),
    });
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      validRevokeSubmission(),
      harness.dependencies,
    );

    expect(result.notice).toMatchObject({ kind: 'success' });
    expect(result.notice?.message).toContain('Refresh to update');
  });

  test('reports an already-revoked key as retained append-only truth', async () => {
    const harness = actionHarness({
      revokeError: new AgentApiKeyError(
        'KEY_ALREADY_REVOKED',
        'The agent API key is already revoked.',
      ),
    });
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      validRevokeSubmission(),
      harness.dependencies,
    );

    expect(result.notice).toMatchObject({ kind: 'info' });
    expect(result.notice?.message).toContain('already revoked');
    expect(harness.revalidationCalls.count).toBe(1);
  });

  test('bounds an unknown revocation failure without revalidation', async () => {
    const harness = actionHarness({
      revokeError: new Error('Synthetic internal failure.'),
    });
    const result = await handleRevokeAgentApiKeyAction(
      { notice: null },
      validRevokeSubmission(),
      harness.dependencies,
    );

    expect(result.notice).toEqual({
      kind: 'error',
      message:
        'The key was not revoked. Refresh the page or ask a district administrator to review it.',
    });
    expect(harness.revalidationCalls.count).toBe(0);
  });
});
