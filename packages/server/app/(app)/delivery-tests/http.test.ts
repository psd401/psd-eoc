import { describe, expect, test } from 'bun:test';

import type { CapabilityInput } from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import type { TrustedCapabilityInvocation } from '../../../lib/capabilities/engine';
import {
  DELIVERY_TEST_IDEMPOTENCY_HEADER,
  handleCreateDeliveryTestPreview,
  handleCreateDeliveryTestTargetSetVersion,
  handleRecordDeliveryTestCanaryEligibility,
  type DeliveryTestWebRuntime,
} from './http';

const IDS = Object.freeze({
  endpointEmail: '90000000-0000-4000-8000-000000000001',
  endpointPush: '90000000-0000-4000-8000-000000000002',
  eligibilityEmail: '90000000-0000-4000-8000-000000000013',
  eligibilityPush: '90000000-0000-4000-8000-000000000014',
  eventType: '90000000-0000-4000-8000-000000000003',
  facility: '90000000-0000-4000-8000-000000000004',
  recipientEmail: '90000000-0000-4000-8000-000000000005',
  recipientPush: '90000000-0000-4000-8000-000000000006',
  request: '90000000-0000-4000-8000-000000000007',
  roster: '90000000-0000-4000-8000-000000000008',
  session: '90000000-0000-4000-8000-000000000009',
  targetSet: '90000000-0000-4000-8000-000000000010',
  user: '90000000-0000-4000-8000-000000000011',
  epoch: '90000000-0000-4000-8000-000000000012',
});
const NOW = new Date('2026-08-13T18:00:00.000Z');
const IDEMPOTENCY_KEY = 'delivery-target-version-0001';

function authenticated(): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    result: {
      session: { id: IDS.session },
      connectivityEpoch: { id: IDS.epoch },
    },
  } as unknown as AuthenticatedSession;
}

interface InvocationCall {
  readonly input: unknown;
  readonly invocation: TrustedCapabilityInvocation;
}

function runtimeFixture() {
  const previews: InvocationCall[] = [];
  const eligibilityFacts: unknown[] = [];
  const targetSets: unknown[] = [];
  const runtime: DeliveryTestWebRuntime = {
    createRequestId: () => IDS.request,
    now: () => NOW,
    authenticate: async () => authenticated(),
    executePreview: async (input, invocation) => {
      previews.push({ input, invocation });
      return { accepted: true };
    },
    createTargetSetVersion: async (input) => {
      targetSets.push(input);
      return { accepted: true };
    },
    recordCanaryEligibility: async (input) => {
      eligibilityFacts.push(input);
      return { accepted: true };
    },
  };
  return { eligibilityFacts, previews, runtime, targetSets };
}

function request(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey !== undefined) {
    headers.set(DELIVERY_TEST_IDEMPOTENCY_HEADER, idempotencyKey);
  }
  return new Request(`https://eoc.example.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function previewInput(): CapabilityInput<'create-delivery-test-preview'> {
  return {
    targetSet: { id: IDS.targetSet, version: 2 },
    eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' },
  };
}

function targetSetInput() {
  return {
    previousVersion: { id: IDS.targetSet, version: 1 },
    facilityId: IDS.facility,
    rosterSnapshotId: IDS.roster,
    eligibilityFactIds: [IDS.eligibilityPush, IDS.eligibilityEmail],
  };
}

describe('delivery-test browser adapters', () => {
  test('executes the exact drill preview as a human query with no mutation authority', async () => {
    const fixture = runtimeFixture();
    const response = await handleCreateDeliveryTestPreview(
      request('/delivery-tests/api/preview', previewInput()),
      fixture.runtime,
    );

    expect(response.status).toBe(200);
    expect(fixture.previews).toHaveLength(1);
    expect(fixture.previews[0]).toMatchObject({
      input: previewInput(),
      invocation: {
        actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
        requestId: IDS.request,
        serverTime: NOW,
        source: 'web',
        mutation: null,
      },
    });
  });

  test('rejects client confirmation or idempotency metadata on a consequence preview', async () => {
    const fixture = runtimeFixture();
    const previewRequest = request(
      '/delivery-tests/api/preview',
      previewInput(),
      IDEMPOTENCY_KEY,
    );
    previewRequest.headers.set('human-confirmation-id', IDS.request);

    const response = await handleCreateDeliveryTestPreview(
      previewRequest,
      fixture.runtime,
    );

    expect(response.status).toBe(400);
    expect(fixture.previews).toHaveLength(0);
  });

  test('forwards a destination-free target version with server-owned human metadata', async () => {
    const fixture = runtimeFixture();
    const command = targetSetInput();
    const response = await handleCreateDeliveryTestTargetSetVersion(
      request('/delivery-tests/api/target-sets', command, IDEMPOTENCY_KEY),
      fixture.runtime,
    );

    expect(response.status).toBe(200);
    expect(fixture.targetSets).toEqual([
      {
        authenticated: authenticated(),
        command,
        metadata: {
          idempotencyKey: IDEMPOTENCY_KEY,
          requestId: IDS.request,
          now: NOW,
        },
      },
    ]);
  });

  test('forwards only an opaque product-owner eligibility decision with server-owned provenance', async () => {
    const fixture = runtimeFixture();
    const command = {
      supersedesFactId: null,
      facilityId: IDS.facility,
      rosterSnapshotId: IDS.roster,
      recipientId: IDS.recipientPush,
      endpointId: IDS.endpointPush,
      channel: 'push' as const,
      decision: 'approved-synthetic-canary' as const,
      optedInAt: '2026-08-13T16:00:00.000Z',
      authorizationReference: 'po-approval-2026-08',
    };
    const response = await handleRecordDeliveryTestCanaryEligibility(
      request('/delivery-tests/api/eligibility', command, IDEMPOTENCY_KEY),
      fixture.runtime,
    );

    expect(response.status).toBe(200);
    expect(fixture.eligibilityFacts).toEqual([
      {
        authenticated: authenticated(),
        command,
        metadata: {
          idempotencyKey: IDEMPOTENCY_KEY,
          requestId: IDS.request,
          now: NOW,
        },
      },
    ]);
  });

  test('rejects caller-forged endpoint attestations before capability execution and never reflects destination-shaped values', async () => {
    const fixture = runtimeFixture();
    const unsafeDestination = true;
    const command = targetSetInput();
    const response = await handleCreateDeliveryTestTargetSetVersion(
      request(
        '/delivery-tests/api/target-sets',
        {
          ...command,
          endpoints: [
            {
              recipientId: IDS.recipientPush,
              endpointId: IDS.endpointPush,
              attestation: 'approved-synthetic-canary',
              destination: unsafeDestination,
            },
          ],
        },
        IDEMPOTENCY_KEY,
      ),
      fixture.runtime,
    );

    expect(response.status).toBe(400);
    expect(fixture.targetSets).toHaveLength(0);
    expect(await response.text()).not.toContain('recipientPush');
  });

  test('rejects a non-drill template before creating a delivery-test preview', async () => {
    const fixture = runtimeFixture();
    const response = await handleCreateDeliveryTestPreview(
      request('/delivery-tests/api/preview', {
        ...previewInput(),
        eventTypeVersion: { id: IDS.eventType, templateMode: 'real' },
      }),
      fixture.runtime,
    );

    expect(response.status).toBe(400);
    expect(fixture.previews).toHaveLength(0);
  });
});
