import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  RosterSnapshotSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import type { ResolveAudienceInput } from '../roster/resolve';
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

function audienceInput(): ResolveAudienceInput {
  return {
    facilityId: IDS.facility,
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
    rosterSnapshotId?: string;
  }> = {},
): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: overrides.rosterSnapshotId ?? IDS.roster,
    rosterPopulation: 'staff',
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
      subject: '[DRILL] Staff drill',
      textBody: '[DRILL] LIVE CANARY — TRAINING ONLY.',
    },
    integrationId: 'ses-email',
    sequence: 1,
    endpointCount: overrides.endpointCount ?? 2,
    createdAt: TIMESTAMP,
  });
}

function evidenceFor(
  query: EmailEndpointPolicyQuery,
  overrides: Readonly<{
    canaryStatus?: 'active' | 'disabled' | 'invalid';
  }> = {},
): readonly Readonly<{
  recipientId: string;
  endpointId: string;
  status: 'active' | 'disabled' | 'invalid';
}>[] {
  return query.candidates.map((candidate) => ({
    ...candidate,
    status:
      candidate.endpointId === IDS.canaryEmail
        ? (overrides.canaryStatus ?? 'active')
        : 'active',
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
  test('resolves every active staff address and sends no destination to the policy store', async () => {
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
    expect(resolved.map((item) => item.recipientId)).toEqual([
      IDS.canaryRecipient,
      IDS.ordinaryRecipient,
    ]);
    expect(resolved.map((item) => item.endpoint.email)).toEqual([
      CANARY_ADDRESS,
      ORDINARY_ADDRESS,
    ]);
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

  test('drops an endpoint whose current status is no longer active', async () => {
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy(query) {
        return Promise.resolve(evidenceFor(query, { canaryStatus: 'invalid' }));
      },
    };

    const resolved = await resolveEmailEndpoints(
      { batch: emailBatch(), audience: audienceInput() },
      store,
    );

    expect(resolved.map((item) => item.endpoint.email)).toEqual([
      ORDINARY_ADDRESS,
    ]);
  });

  test('count mismatch returns no partial destination', async () => {
    let returnedDestinations: readonly string[] | undefined;
    const store: EmailEndpointPolicyStore = {
      loadEndpointPolicy(query) {
        return Promise.resolve(evidenceFor(query));
      },
    };

    await expectResolutionFailure(
      resolveEmailEndpoints(
        {
          batch: emailBatch({ endpointCount: 1 }),
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
