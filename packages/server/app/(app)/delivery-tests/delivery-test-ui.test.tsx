import { describe, expect, test } from 'bun:test';
import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  DeliveryTestPreviewSchema,
  MonthlyDeliveryTestReportSchema,
  StartEventResultSchema,
  type DeliveryTestPreview,
  type EventTypeListItem,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  activationPreviewFixture,
  activationResultFixture,
} from '../start/test/fixtures';
import {
  DELIVERY_TEST_ACTIVATE_PATH,
  DeliveryTestRequestError,
  canActivateDeliveryTest,
  requestDeliveryTest,
  requireMatchingDeliveryTestActivationResult,
  requireMatchingDeliveryTestPreview,
} from './client-request';
import {
  DeliveryTestConsole,
  DeliveryTestPreviewConfirmation,
  parseOpaqueEndpointReferences,
} from './delivery-test-console';
import { DeliveryTestReportList } from './report-list';

const uuid = (suffix: number): string =>
  `52000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  eventType: uuid(2),
  targetSet: uuid(3),
  report: uuid(4),
  run: uuid(5),
  finalizer: 'delivery-test-report-finalizer',
});

const TARGET = Object.freeze({ id: IDS.targetSet, version: 1 });
const EVENT_TYPE = Object.freeze({
  id: IDS.eventType,
  templateMode: 'drill' as const,
});
const SELECTION = CreateActivationPreviewInputSchema.parse({
  facilityId: IDS.facility,
  kind: 'drill',
  templateMode: 'drill',
  eventTypeVersion: EVENT_TYPE,
  rosterPopulation: 'staff',
});

function deliveryTestPreview(
  readiness: 'live' | 'mocked' | 'configured-unverified' = 'live',
): DeliveryTestPreview {
  const live = readiness === 'live';
  const base = activationPreviewFixture(SELECTION, {
    includeSms: false,
    simulatedReadyStaff: live,
  });
  const deliveryTest = {
    purpose: 'monthly-live-delivery-test' as const,
    targetSet: TARGET,
    endpointReferenceDigest: 'd'.repeat(64),
  };
  const channels =
    readiness === 'mocked'
      ? base.channels.map((channel) => ({
          ...channel,
          integrationStatus: {
            integrationId: channel.integrationStatus.integrationId,
            label: 'mocked' as const,
            verifiedAt: null,
            verifiedByUserId: null,
            authorizationReference: null,
            reasonCode: null,
            observedAt: base.createdAt,
          },
        }))
      : base.channels;
  const activationPreview = ActivationPreviewSchema.parse({
    ...base,
    deliveryTest,
    channels,
    sendReadiness: live ? 'ready' : 'blocked',
    blockingReasonCodes: live ? [] : ['INTEGRATION_NOT_LIVE_VERIFIED'],
  });
  return DeliveryTestPreviewSchema.parse({
    purpose: 'monthly-live-delivery-test',
    activationPreview,
    targetSet: TARGET,
    endpointReferenceDigest: deliveryTest.endpointReferenceDigest,
    channels: activationPreview.channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: channel.integrationStatus.label === 'live-verified',
    })),
    consequenceDigest: activationPreview.consequenceDigest,
    createdAt: activationPreview.createdAt,
    expiresAt: activationPreview.expiresAt,
  });
}

function boundResult(
  preview: DeliveryTestPreview,
  idempotencyKey: string,
): StartEventResult {
  const base = activationResultFixture(
    preview.activationPreview,
    idempotencyKey,
  );
  if (base.notificationIntent === null) {
    throw new Error('Synthetic activation result omitted its intent.');
  }
  return StartEventResultSchema.parse({
    ...base,
    notificationIntent: {
      ...base.notificationIntent,
      deliveryTest: preview.activationPreview.deliveryTest,
    },
  });
}

const EVENT_TYPE_ITEM = {
  latestVersion: {
    id: IDS.eventType,
    name: 'Synthetic monthly canary drill',
    templateMode: 'drill',
  },
} as unknown as EventTypeListItem;

describe('monthly delivery-test browser safety', () => {
  test('renders an unmistakable DRILL confirmation and requires an explicit human check', () => {
    const preview = deliveryTestPreview();
    const unchecked = renderToStaticMarkup(
      <DeliveryTestPreviewConfirmation
        activateOutcomeUnknown={false}
        activatePending={false}
        activated={false}
        humanChecked={false}
        onActivate={() => undefined}
        onHumanCheckedChange={() => undefined}
        preview={preview}
      />,
    );
    const checked = renderToStaticMarkup(
      <DeliveryTestPreviewConfirmation
        activateOutcomeUnknown={false}
        activatePending={false}
        activated={false}
        humanChecked
        onActivate={() => undefined}
        onHumanCheckedChange={() => undefined}
        preview={preview}
      />,
    );

    expect(unchecked).toContain('DRILL — LIVE CANARY — TRAINING ONLY');
    expect(unchecked).toContain('not a real incident');
    expect(unchecked).toContain('Nothing sends automatically');
    expect(unchecked).toMatch(
      /<button[^>]*disabled=""[^>]*>Confirm and start DRILL live canary<\/button>/u,
    );
    expect(checked).toMatch(
      /<button class="button delivery-test-activate" type="button">Confirm and start DRILL live canary<\/button>/u,
    );
  });

  test('mocked and configured-unverified readiness both disable the live run', () => {
    for (const readiness of ['mocked', 'configured-unverified'] as const) {
      const preview = deliveryTestPreview(readiness);
      expect(canActivateDeliveryTest(preview)).toBe(false);
      const markup = renderToStaticMarkup(
        <DeliveryTestPreviewConfirmation
          activateOutcomeUnknown={false}
          activatePending={false}
          activated={false}
          humanChecked
          onActivate={() => undefined}
          onHumanCheckedChange={() => undefined}
          preview={preview}
        />,
      );
      expect(markup).toContain('Live canary run blocked');
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*>Confirm and start DRILL live canary<\/button>/u,
      );
    }
  });

  test('rendering the console never starts a request and hides target config from non-admin staff', () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('Rendering must not make a request.');
    }) as unknown as typeof fetch;
    try {
      const markup = renderToStaticMarkup(
        <DeliveryTestConsole
          csrfCookieName="synthetic-csrf"
          drillEventTypes={[EVENT_TYPE_ITEM]}
          facilities={[
            { id: IDS.facility, code: 'SYN', name: 'Synthetic Campus' },
          ]}
          showTargetConfiguration={false}
        />,
      );
      expect(requests).toBe(0);
      expect(markup).toContain(
        'Authorized staff may preview and explicitly run a previously approved version',
      );
      expect(markup).not.toContain('Save target version');
      expect(markup).not.toContain('Confirm and start DRILL live canary');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a timed-out activation is outcome-unknown and is never retried automatically', async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'document',
    );
    const originalFetch = globalThis.fetch;
    let requests = 0;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'synthetic-csrf=synthetic-token' },
    });
    globalThis.fetch = ((_input, init) => {
      requests += 1;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(new DOMException('Synthetic timeout.', 'AbortError'));
        if (init?.signal?.aborted === true) rejectAbort();
        else
          init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }) as typeof fetch;
    try {
      let caught: unknown;
      try {
        await requestDeliveryTest(
          DELIVERY_TEST_ACTIVATE_PATH,
          { source: 'activation-preview' },
          'synthetic-csrf',
          { parse: (value: unknown) => value },
          'activate:synthetic-timeout',
          undefined,
          5,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeliveryTestRequestError);
      expect((caught as DeliveryTestRequestError).outcomeUnknown).toBe(true);
      expect((caught as DeliveryTestRequestError).retryable).toBe(false);
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (documentDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        Object.defineProperty(globalThis, 'document', documentDescriptor);
      }
    }
  });

  test('refuses a mismatched preview and a schema-valid mismatched result', () => {
    const preview = deliveryTestPreview();
    expect(() =>
      requireMatchingDeliveryTestPreview(preview, {
        targetSet: { ...TARGET, version: 2 },
        eventTypeVersion: EVENT_TYPE,
      }),
    ).toThrow(DeliveryTestRequestError);

    const idempotencyKey = 'activate:synthetic-delivery-test';
    const result = boundResult(preview, idempotencyKey);
    expect(
      requireMatchingDeliveryTestActivationResult(
        result,
        preview,
        idempotencyKey,
      ),
    ).toBe(result.event);
    if (result.notificationIntent === null) {
      throw new Error('Synthetic activation result omitted its intent.');
    }
    const mismatch = StartEventResultSchema.parse({
      ...result,
      notificationIntent: {
        ...result.notificationIntent,
        deliveryTest: {
          ...result.notificationIntent.deliveryTest,
          targetSet: { ...TARGET, version: 2 },
        },
      },
    });
    expect(() =>
      requireMatchingDeliveryTestActivationResult(
        mismatch,
        preview,
        idempotencyKey,
      ),
    ).toThrow(DeliveryTestRequestError);
  });

  test('rejects destination-shaped target data before contract parsing', () => {
    expect(() =>
      parseOpaqueEndpointReferences(
        JSON.stringify([
          {
            recipientId: uuid(20),
            endpointId: uuid(21),
            channel: 'email',
            email: true,
          },
        ]),
      ),
    ).toThrow('destinations and contact values are forbidden');
  });
});

describe('destination-free monthly report view', () => {
  test('shows provider acceptance and unknown as distinct truth without destinations', () => {
    const report = MonthlyDeliveryTestReportSchema.parse({
      id: IDS.report,
      runId: IDS.run,
      sequence: 1,
      supersedesReportId: null,
      status: 'incomplete',
      channels: [
        {
          channel: 'push',
          endpointCount: 2,
          activationToProviderAcceptMs: 740,
          latestStateCounts: [
            { state: 'provider-accepted', count: 1 },
            { state: 'unknown', count: 1 },
          ],
          completedAt: '2026-08-12T18:00:00.740Z',
        },
        {
          channel: 'email',
          endpointCount: 2,
          activationToProviderAcceptMs: null,
          latestStateCounts: [{ state: 'unknown', count: 2 }],
          completedAt: null,
        },
      ],
      generatedAt: '2026-08-12T18:01:00.000Z',
      finalizedBy: { kind: 'system', serviceId: IDS.finalizer },
      source: 'worker',
      reasonCode: 'PROVIDER_TRUTH_INCOMPLETE',
    });
    const markup = renderToStaticMarkup(
      <DeliveryTestReportList reports={[report]} />,
    );

    expect(markup).toContain('Provider accepted:');
    expect(markup).toContain('Unknown:');
    expect(markup).toContain('does not prove delivery or human receipt');
    expect(markup).not.toContain('recipientId');
    expect(markup).not.toContain('endpointId');
    expect(markup).not.toContain('@');
    expect(markup).not.toContain('+1');
  });
});
