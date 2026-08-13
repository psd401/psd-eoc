import { describe, expect, test } from 'bun:test';
import {
  AudienceConfigSchema,
  DispatchBatchSchema,
  RosterSnapshotSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import type { ResolveAudienceInput } from '../roster/resolve';
import { deliveryTestEndpointReferenceDigest } from '../testing/e2e-delivery';
import {
  EmailEndpointResolutionError,
  resolveEmailEndpoints,
  type EmailEndpointPolicyQuery,
  type EmailEndpointPolicyStore,
} from './dispatcher';

const TIMESTAMP = '2026-08-13T16:00:00.000Z';

const IDS = Object.freeze({
  actor: '00000000-0000-4000-8000-000000000001',
  session: '00000000-0000-4000-8000-000000000002',
  request: '00000000-0000-4000-8000-000000000003',
  confirmation: '00000000-0000-4000-8000-000000000004',
  preview: '00000000-0000-4000-8000-000000000005',
  facility: '00000000-0000-4000-8000-000000000006',
  group: '00000000-0000-4000-8000-000000000007',
  configuration: '00000000-0000-4000-8000-000000000008',
  audience: '00000000-0000-4000-8000-000000000009',
  roster: '00000000-0000-4000-8000-000000000010',
  otherRoster: '00000000-0000-4000-8000-000000000011',
  eventTypeVersion: '00000000-0000-4000-8000-000000000012',
  event: '00000000-0000-4000-8000-000000000013',
  intent: '00000000-0000-4000-8000-000000000014',
  batch: '00000000-0000-4000-8000-000000000015',
  targetSet: '00000000-0000-4000-8000-000000000016',
  canaryRecipient: '00000000-0000-4000-8000-000000000017',
  ordinaryRecipient: '00000000-0000-4000-8000-000000000018',
  canaryEmail: '00000000-0000-4000-8000-000000000019',
  ordinaryEmail: '00000000-0000-4000-8000-000000000020',
  canaryPush: '00000000-0000-4000-8000-000000000021',
});

const CANARY_ADDRESS = 'controlled.canary@example.invalid';
const ORDINARY_ADDRESS = 'ordinary.staff@example.invalid';

const GROUP = Object.freeze({
  id: IDS.group,
  kind: 'google-group' as const,
  purpose: 'building' as const,
  facilityId: IDS.facility,
});

const TARGET_DIGEST = deliveryTestEndpointReferenceDigest([
  {
    recipientId: IDS.canaryRecipient,
    endpointId: IDS.canaryEmail,
    channel: 'email',
  },
  {
    recipientId: IDS.canaryRecipient,
    endpointId: IDS.canaryPush,
    channel: 'push',
  },
]);

function audienceInput(): ResolveAudienceInput {
  return {
    audienceConfig: AudienceConfigSchema.parse({
      id: IDS.audience,
      facilityId: IDS.facility,
      version: 1,
      targets: [{ kind: 'building', facilityId: IDS.facility }],
      createdAt: TIMESTAMP,
    }),
    neighborhoodVersions: [],
    rosterSnapshot: RosterSnapshotSchema.parse({
      id: IDS.roster,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfiguration: { id: IDS.configuration, version: 1 },
      facilityIds: [IDS.facility],
      expectedSourceGroupRefs: [GROUP],
      sourceGroupRefs: [GROUP],
      recipients: [
        {
          id: IDS.canaryRecipient,
          population: 'staff',
          googleSubject: 'synthetic-canary-subject',
          displayName: 'Synthetic Canary Staff',
          groupSourceRefs: [GROUP],
          endpoints: [
            {
              id: IDS.canaryEmail,
              channel: 'email',
              status: 'active',
              capturedAt: TIMESTAMP,
              email: CANARY_ADDRESS,
            },
          ],
        },
        {
          id: IDS.ordinaryRecipient,
          population: 'staff',
          googleSubject: 'synthetic-ordinary-subject',
          displayName: 'Synthetic Ordinary Staff',
          groupSourceRefs: [GROUP],
          endpoints: [
            {
              id: IDS.ordinaryEmail,
              channel: 'email',
              status: 'active',
              capturedAt: TIMESTAMP,
              email: ORDINARY_ADDRESS,
            },
          ],
        },
      ],
      syncStartedAt: TIMESTAMP,
      capturedAt: TIMESTAMP,
    }),
  };
}

function emailBatch(
  overrides: Readonly<{
    endpointCount?: number;
    endpointReferenceDigest?: string;
    rosterSnapshotId?: string;
  }> = {},
): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: overrides.rosterSnapshotId ?? IDS.roster,
    rosterPopulation: 'staff',
    audienceConfig: { id: IDS.audience, version: 1 },
    deliveryTest: {
      purpose: 'monthly-live-delivery-test',
      targetSet: { id: IDS.targetSet, version: 1 },
      endpointReferenceDigest:
        overrides.endpointReferenceDigest ?? TARGET_DIGEST,
    },
    requestId: IDS.request,
    authorization: {
      kind: 'human-confirmed',
      activationPreviewId: IDS.preview,
      preparedActivationId: null,
      confirmationId: IDS.confirmation,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'email',
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'email',
      subject: '[DRILL] Monthly delivery test',
      textBody: '[DRILL] LIVE CANARY — TRAINING ONLY.',
    },
    integrationStatus: {
      integrationId: 'ses-email',
      label: 'live-verified',
      verifiedAt: TIMESTAMP,
      verifiedByUserId: IDS.actor,
      authorizationReference: 'synthetic-product-owner-approval',
      reasonCode: null,
      observedAt: TIMESTAMP,
    },
    sequence: 1,
    endpointCount: overrides.endpointCount ?? 1,
    createdAt: TIMESTAMP,
  });
}

function evidenceFor(
  query: EmailEndpointPolicyQuery,
  overrides: Readonly<{
    canaryApproved?: boolean;
    canaryStatus?: 'active' | 'disabled' | 'invalid';
  }> = {},
): readonly Readonly<{
  recipientId: string;
  endpointId: string;
  status: 'active' | 'disabled' | 'invalid';
  approvedForDeliveryTest: boolean;
}>[] {
  return query.candidates.map((candidate) => ({
    ...candidate,
    status:
      candidate.endpointId === IDS.canaryEmail
        ? (overrides.canaryStatus ?? 'active')
        : 'active',
    approvedForDeliveryTest:
      candidate.endpointId === IDS.canaryEmail &&
      (overrides.canaryApproved ?? true),
  }));
}

async function expectResolutionFailure(
  operation: Promise<unknown>,
  code: EmailEndpointResolutionError['code'],
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(EmailEndpointResolutionError);
  expect((failure as EmailEndpointResolutionError).code).toBe(code);
}

describe('email exact-target destination boundary', () => {
  test('excludes ordinary staff and sends no destination to the policy store', async () => {
    const observedQueries: EmailEndpointPolicyQuery[] = [];
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy(query) {
        observedQueries.push(query);
        expect(JSON.stringify(query)).not.toContain('@');
        expect(query.candidates).toEqual([
          {
            recipientId: IDS.canaryRecipient,
            endpointId: IDS.canaryEmail,
          },
          {
            recipientId: IDS.ordinaryRecipient,
            endpointId: IDS.ordinaryEmail,
          },
        ]);
        expect(
          query.candidates.every(
            (candidate) =>
              Object.keys(candidate).sort().join(',') ===
              'endpointId,recipientId',
          ),
        ).toBe(true);
        return Promise.resolve(evidenceFor(query));
      },
    };

    const resolved = await resolveEmailEndpoints(
      { batch: emailBatch(), audience: audienceInput() },
      store,
    );

    expect(observedQueries).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.recipientId).toBe(IDS.canaryRecipient);
    expect(resolved[0]?.endpoint.email).toBe(CANARY_ADDRESS);
    expect(resolved.map((item) => item.endpoint.email)).not.toContain(
      ORDINARY_ADDRESS,
    );
  });

  test('roster mismatch fails before policy lookup or destination release', async () => {
    let policyCalls = 0;
    let returnedDestination: string | undefined;
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy() {
        policyCalls += 1;
        return Promise.resolve([]);
      },
    };

    await expectResolutionFailure(
      resolveEmailEndpoints(
        {
          batch: emailBatch({ rosterSnapshotId: IDS.otherRoster }),
          audience: audienceInput(),
        },
        store,
      ).then((resolved) => {
        returnedDestination = resolved[0]?.endpoint.email;
      }),
      'EMAIL_ROSTER_MISMATCH',
    );
    expect(policyCalls).toBe(0);
    expect(returnedDestination).toBeUndefined();
  });

  test('digest mismatch fails closed without returning an address', async () => {
    let returnedDestination: string | undefined;
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy(query) {
        if (query.deliveryTest?.endpointReferenceDigest !== TARGET_DIGEST) {
          throw new Error('destination-free digest mismatch');
        }
        return Promise.resolve(evidenceFor(query));
      },
    };

    await expectResolutionFailure(
      resolveEmailEndpoints(
        {
          batch: emailBatch({ endpointReferenceDigest: 'e'.repeat(64) }),
          audience: audienceInput(),
        },
        store,
      ).then((resolved) => {
        returnedDestination = resolved[0]?.endpoint.email;
      }),
      'EMAIL_ENDPOINT_POLICY_INVALID',
    );
    expect(returnedDestination).toBeUndefined();
  });

  test.each([
    {
      name: 'revoked eligibility',
      endpointCount: 1,
      canaryApproved: false,
      canaryStatus: 'active' as const,
    },
    {
      name: 'invalid current endpoint status',
      endpointCount: 1,
      canaryApproved: true,
      canaryStatus: 'invalid' as const,
    },
    {
      name: 'channel target count mismatch',
      endpointCount: 2,
      canaryApproved: true,
      canaryStatus: 'active' as const,
    },
  ])('$name returns no partial destination', async (scenario) => {
    let returnedDestinations: readonly string[] | undefined;
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy(query) {
        return Promise.resolve(
          evidenceFor(query, {
            canaryApproved: scenario.canaryApproved,
            canaryStatus: scenario.canaryStatus,
          }),
        );
      },
    };

    await expectResolutionFailure(
      resolveEmailEndpoints(
        {
          batch: emailBatch({ endpointCount: scenario.endpointCount }),
          audience: audienceInput(),
        },
        store,
      ).then((resolved) => {
        returnedDestinations = resolved.map((item) => item.endpoint.email);
      }),
      'EMAIL_ENDPOINT_COUNT_MISMATCH',
    );
    expect(returnedDestinations).toBeUndefined();
  });
});
