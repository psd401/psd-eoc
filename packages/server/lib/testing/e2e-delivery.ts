import {
  ActivationPreviewSchema,
  DeliveryTestChannelReportSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestRunSchema,
  DeliveryTestTargetSetVersionSchema,
  HumanConfirmationSchema,
  MonthlyDeliveryTestReportSchema,
  StartEventInputSchema,
  type AttemptDeliveryTruthState,
  type DeliveryTestChannelReport,
  type DeliveryTestPreview,
  type DeliveryTestRun,
  type DeliveryTestTargetSetVersion,
  type HumanConfirmation,
  type MonthlyDeliveryTestReport,
  type NotificationChannel,
  type StartEventInput,
  type StartEventResult,
} from '@psd-eoc/contracts';

import {
  digestCapabilityValue,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';

const DELIVERY_TEST_PURPOSE = 'monthly-live-delivery-test' as const;
export const DELIVERY_TEST_TARGET_LOCK_NAMESPACE = 30;

/** Shared lineage lock used by both target approval and protected activation. */
export function deliveryTestTargetLockIdentity(facilityId: string): string {
  return `delivery-test-target-set:${facilityId}`;
}
const REQUIRED_ACTIONS = Object.freeze(['send-real-notification'] as const);

const REPORT_STATES = Object.freeze([
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
] as const satisfies readonly AttemptDeliveryTruthState[]);

type EndpointReference = Readonly<{
  recipientId: string;
  endpointId: string;
  channel: NotificationChannel;
}>;

type HumanDeliveryTestInvocation = TrustedCapabilityInvocation &
  Readonly<{
    actor: Readonly<{ kind: 'human'; userId: string; sessionId: string }>;
    source: 'web' | 'mobile';
    connectivityEpochId: string;
    mutation: NonNullable<TrustedCapabilityInvocation['mutation']>;
  }>;

/** Safe fail-closed denial. Messages deliberately contain no endpoint data. */
export class DeliveryTestSafetyError extends Error {
  public constructor(
    public readonly code:
      | 'ACTIVATION_MISMATCH'
      | 'CONFIRMATION_INVALID'
      | 'INTEGRATION_NOT_READY'
      | 'INVOCATION_DENIED'
      | 'REPORT_INVALID'
      | 'TARGET_SET_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryTestSafetyError';
  }
}

export interface ResolvedDeliveryTestAudience {
  readonly targetSet: DeliveryTestTargetSetVersion;
  readonly activeEndpointRefs: readonly EndpointReference[];
}

export interface DeliveryTestExecutionDependencies {
  /** Resolves persisted immutable configuration; it must not perform I/O to a provider. */
  readonly resolveAudience: (
    preview: DeliveryTestPreview,
  ) => Promise<ResolvedDeliveryTestAudience>;
  /** The sole mutation seam. Production injects canonical executeCapability(start-event). */
  readonly executeStartEvent: (
    input: StartEventInput,
    invocation: TrustedCapabilityInvocation,
  ) => Promise<StartEventResult>;
  readonly createRunId: () => string;
}

export interface ExecuteMonthlyDeliveryTestInput {
  readonly preview: DeliveryTestPreview;
  readonly confirmation: HumanConfirmation;
  readonly startEventInput: StartEventInput;
  readonly invocation: TrustedCapabilityInvocation;
}

export interface ExecuteMonthlyDeliveryTestResult {
  readonly run: DeliveryTestRun;
  readonly activation: StartEventResult;
}

interface ReportAssemblyInput {
  readonly id: string;
  readonly run: DeliveryTestRun;
  readonly sequence: number;
  readonly supersedesReportId: string | null;
  readonly status: 'succeeded' | 'failed' | 'incomplete';
  readonly channels: readonly DeliveryTestChannelReport[];
  readonly generatedAt: string;
  readonly finalizedByServiceId: string;
  readonly source: 'worker';
  readonly reasonCode: string | null;
}

interface ChannelReportAssemblyInput {
  readonly channel: NotificationChannel;
  readonly endpointCount: number;
  readonly activationToProviderAcceptMs: number | null;
  readonly latestStateCounts: Readonly<
    Partial<Record<AttemptDeliveryTruthState, number>>
  >;
  readonly completedAt: string | null;
}

function deny(code: DeliveryTestSafetyError['code'], message: string): never {
  throw new DeliveryTestSafetyError(code, message);
}

function endpointKey(reference: EndpointReference): string {
  return `${reference.channel}\u0000${reference.recipientId}\u0000${reference.endpointId}`;
}

function canonicalEndpointReferences(
  references: readonly EndpointReference[],
): readonly EndpointReference[] {
  const canonical = references
    .map(({ recipientId, endpointId, channel }) => ({
      recipientId,
      endpointId,
      channel,
    }))
    .sort((left, right) => {
      const leftKey = endpointKey(left);
      const rightKey = endpointKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  if (
    canonical.some(
      (reference, index) =>
        index > 0 &&
        endpointKey(reference) === endpointKey(canonical[index - 1]!),
    )
  ) {
    deny('TARGET_SET_INVALID', 'The delivery-test target set is invalid.');
  }
  return Object.freeze(canonical.map((reference) => Object.freeze(reference)));
}

/** Recomputes the destination-free digest over sorted opaque endpoint refs. */
export function deliveryTestEndpointReferenceDigest(
  references: readonly EndpointReference[],
): string {
  const refs = canonicalEndpointReferences(references);
  return digestCapabilityValue({
    kind: 'delivery-test-endpoint-refs-v1',
    refs,
  });
}

function sameEndpointReferences(
  left: readonly EndpointReference[],
  right: readonly EndpointReference[],
): boolean {
  const first = canonicalEndpointReferences(left);
  const second = canonicalEndpointReferences(right);
  return (
    first.length === second.length &&
    first.every((reference, index) => {
      const candidate = second[index];
      return (
        candidate !== undefined &&
        endpointKey(reference) === endpointKey(candidate)
      );
    })
  );
}

/** True only when every approved ref is present in current eligible truth. */
export function isDeliveryTestEndpointReferenceSubset(
  approved: readonly EndpointReference[],
  eligible: readonly EndpointReference[],
): boolean {
  const approvedRefs = canonicalEndpointReferences(approved);
  const eligibleKeys = new Set(
    canonicalEndpointReferences(eligible).map(endpointKey),
  );
  return approvedRefs.every((reference) =>
    eligibleKeys.has(endpointKey(reference)),
  );
}

function sameRef(
  left: Readonly<{ id: string; version: number }>,
  right: Readonly<{ id: string; version: number }>,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function assertHumanInvocation(
  invocation: TrustedCapabilityInvocation,
  confirmation: HumanConfirmation,
  now: Date,
): asserts invocation is HumanDeliveryTestInvocation {
  const mutation = invocation.mutation;
  if (
    invocation.actor.kind !== 'human' ||
    (invocation.source !== 'web' && invocation.source !== 'mobile') ||
    invocation.connectivityEpochId === null ||
    mutation === null ||
    mutation.humanConfirmationId !== confirmation.id ||
    (invocation.source === 'web'
      ? mutation.transport.kind !== 'web-interactive'
      : mutation.transport.kind !== 'mobile-interactive')
  ) {
    deny(
      'INVOCATION_DENIED',
      'A monthly live delivery test requires an authenticated human in the app.',
    );
  }
  if (
    confirmation.capabilityId !== 'start-event' ||
    confirmation.confirmedByUserId !== invocation.actor.userId ||
    confirmation.confirmedWithSessionId !== invocation.actor.sessionId ||
    confirmation.connectivityEpochId !== invocation.connectivityEpochId ||
    Date.parse(confirmation.issuedAt) > now.getTime() ||
    Date.parse(confirmation.expiresAt) < now.getTime() ||
    confirmation.actionIds.length !== REQUIRED_ACTIONS.length ||
    confirmation.actionIds[0] !== REQUIRED_ACTIONS[0]
  ) {
    deny(
      'CONFIRMATION_INVALID',
      'The monthly live delivery-test confirmation is invalid or stale.',
    );
  }
}

function assertPreviewBindings(
  preview: DeliveryTestPreview,
  targetSet: DeliveryTestTargetSetVersion,
): void {
  const activation = preview.activationPreview;
  const metadata = activation.deliveryTest;
  if (
    preview.purpose !== DELIVERY_TEST_PURPOSE ||
    activation.kind !== 'drill' ||
    activation.templateMode !== 'drill' ||
    activation.rosterPopulation !== 'staff' ||
    metadata == null ||
    metadata.purpose !== DELIVERY_TEST_PURPOSE ||
    !sameRef(preview.targetSet, targetSet) ||
    !sameRef(metadata.targetSet, targetSet) ||
    activation.rosterSnapshotId !== targetSet.rosterSnapshotId ||
    preview.endpointReferenceDigest !== targetSet.endpointReferenceDigest ||
    metadata.endpointReferenceDigest !== targetSet.endpointReferenceDigest ||
    preview.consequenceDigest !== activation.consequenceDigest ||
    preview.consequenceDigest !== preview.activationPreview.consequenceDigest
  ) {
    deny(
      'ACTIVATION_MISMATCH',
      'The monthly delivery-test preview no longer matches its pinned activation.',
    );
  }

  const activationCounts = new Map(
    activation.channels.map((channel) => [
      channel.channel,
      channel.endpointCount,
    ]),
  );
  if (
    preview.channels.length !== activation.channels.length ||
    preview.channels.some(
      (channel) =>
        activationCounts.get(channel.channel) !== channel.endpointCount,
    )
  ) {
    deny(
      'ACTIVATION_MISMATCH',
      'The monthly delivery-test channel plan no longer matches its activation.',
    );
  }
}

function assertReadyChannels(preview: DeliveryTestPreview): void {
  if (
    preview.channels.some(
      (channel) =>
        channel.integrationStatus.label !== 'live-verified' ||
        channel.credentialVerified !== true,
    )
  ) {
    deny(
      'INTEGRATION_NOT_READY',
      'Every delivery-test channel must be live-verified with verified credentials.',
    );
  }
}

function assertTargetSet(
  preview: DeliveryTestPreview,
  resolved: ResolvedDeliveryTestAudience,
): void {
  const targetSet = DeliveryTestTargetSetVersionSchema.parse(
    resolved.targetSet,
  );
  const configuredRefs = targetSet.endpoints.map((endpoint) => ({
    recipientId: endpoint.recipientId,
    endpointId: endpoint.endpointId,
    channel: endpoint.channel,
  }));
  const activeRefs = canonicalEndpointReferences(resolved.activeEndpointRefs);
  const endpointCounts = new Map<NotificationChannel, number>();
  for (const endpoint of targetSet.endpoints) {
    endpointCounts.set(
      endpoint.channel,
      (endpointCounts.get(endpoint.channel) ?? 0) + 1,
    );
  }
  if (
    targetSet.endpoints.length === 0 ||
    targetSet.facilityId !== preview.activationPreview.facilityId ||
    targetSet.endpoints.some(
      (endpoint) =>
        endpoint.attestation !== 'approved-synthetic-canary' ||
        endpoint.authorizationReference.trim().length === 0,
    ) ||
    preview.channels.some(
      (channel) =>
        channel.endpointCount !== (endpointCounts.get(channel.channel) ?? 0),
    ) ||
    endpointCounts.size !== preview.channels.length ||
    !sameEndpointReferences(configuredRefs, activeRefs)
  ) {
    deny(
      'TARGET_SET_INVALID',
      'The active delivery-test audience is not the exact approved target set.',
    );
  }
  const digest = deliveryTestEndpointReferenceDigest(activeRefs);
  if (
    digest !== targetSet.endpointReferenceDigest ||
    digest !== preview.endpointReferenceDigest
  ) {
    deny(
      'TARGET_SET_INVALID',
      'The active delivery-test audience digest does not match its approval.',
    );
  }
  assertPreviewBindings(preview, targetSet);
}

/**
 * Executes only after every live-action gate is proven. The injected executor
 * is called exactly once and remains the sole route to event/outbox mutation.
 */
export async function executeMonthlyDeliveryTest(
  inputValue: ExecuteMonthlyDeliveryTestInput,
  dependencies: DeliveryTestExecutionDependencies,
): Promise<ExecuteMonthlyDeliveryTestResult> {
  const preview = DeliveryTestPreviewSchema.parse(inputValue.preview);
  const confirmation = HumanConfirmationSchema.parse(inputValue.confirmation);
  const startEventInput = StartEventInputSchema.parse(
    inputValue.startEventInput,
  );
  const activationPreview = ActivationPreviewSchema.parse(
    preview.activationPreview,
  );
  const now = new Date(inputValue.invocation.serverTime);

  if (!Number.isFinite(now.getTime())) {
    deny('INVOCATION_DENIED', 'The authoritative execution time is invalid.');
  }

  assertHumanInvocation(inputValue.invocation, confirmation, now);
  if (
    startEventInput.source !== 'activation-preview' ||
    startEventInput.activationPreviewId !== activationPreview.id ||
    confirmation.consequenceDigest !== preview.consequenceDigest
  ) {
    deny(
      'ACTIVATION_MISMATCH',
      'The start request or confirmation does not match the delivery-test preview.',
    );
  }
  if (
    now.getTime() < Date.parse(preview.createdAt) ||
    now.getTime() > Date.parse(preview.expiresAt) ||
    now.getTime() < Date.parse(activationPreview.createdAt) ||
    now.getTime() > Date.parse(activationPreview.expiresAt)
  ) {
    deny(
      'ACTIVATION_MISMATCH',
      'The monthly delivery-test preview is not current.',
    );
  }
  assertReadyChannels(preview);

  // This is the final read-only dependency call before the protected mutation.
  const resolved = await dependencies.resolveAudience(preview);
  assertTargetSet(preview, resolved);

  const activation = await dependencies.executeStartEvent(
    startEventInput,
    inputValue.invocation,
  );
  if (
    activation.event.kind !== 'drill' ||
    activation.event.templateMode !== 'drill' ||
    activation.event.rosterPopulation !== 'staff' ||
    activation.event.activationAuthorization?.kind !== 'human-confirmed' ||
    activation.event.activationAuthorization.activationPreviewId !==
      activationPreview.id ||
    activation.event.activationAuthorization.confirmationId !==
      confirmation.id ||
    activation.notificationIntent === null ||
    activation.notificationIntent.deliveryTest == null ||
    !sameRef(
      activation.notificationIntent.deliveryTest.targetSet,
      preview.targetSet,
    ) ||
    activation.notificationIntent.deliveryTest.endpointReferenceDigest !==
      preview.endpointReferenceDigest
  ) {
    // Canonical start-event must persist these bindings atomically. This error
    // cannot undo its transaction, so production integration must build them
    // from the same validated preview rather than accepting returned mismatch.
    deny(
      'ACTIVATION_MISMATCH',
      'Canonical activation did not retain the delivery-test safety evidence.',
    );
  }

  const run = DeliveryTestRunSchema.parse({
    id: dependencies.createRunId(),
    activationPreviewId: activationPreview.id,
    eventId: activation.event.id,
    notificationIntentId: activation.notificationIntent.id,
    targetSet: preview.targetSet,
    endpointReferenceDigest: preview.endpointReferenceDigest,
    consequenceDigest: preview.consequenceDigest,
    confirmationId: confirmation.id,
    startedByUserId: inputValue.invocation.actor.userId,
    startedWithSessionId: inputValue.invocation.actor.sessionId,
    startedAt: activation.event.activatedAt,
  });
  return Object.freeze({ run, activation });
}

/** Builds a destination-free per-channel truth projection. */
export function assembleDeliveryTestChannelReport(
  input: ChannelReportAssemblyInput,
): DeliveryTestChannelReport {
  const latestStateCounts = REPORT_STATES.flatMap((state) => {
    const count = input.latestStateCounts[state];
    return count === undefined ? [] : [{ state, count }];
  });
  return DeliveryTestChannelReportSchema.parse({
    channel: input.channel,
    endpointCount: input.endpointCount,
    activationToProviderAcceptMs: input.activationToProviderAcceptMs,
    latestStateCounts: Object.freeze(latestStateCounts),
    completedAt: input.completedAt,
  });
}

/**
 * Builds one append-only report version; storage must insert it and never
 * update or delete an earlier version.
 */
export function assembleMonthlyDeliveryTestReport(
  input: ReportAssemblyInput,
): MonthlyDeliveryTestReport {
  if (Date.parse(input.generatedAt) < Date.parse(input.run.startedAt)) {
    deny('REPORT_INVALID', 'A report cannot predate its delivery-test run.');
  }
  if (
    input.status === 'succeeded' &&
    input.channels.some((channel) => {
      const counted = channel.latestStateCounts.reduce(
        (total, row) => total + row.count,
        0,
      );
      return (
        counted !== channel.endpointCount ||
        channel.latestStateCounts.some(
          (row) =>
            row.count > 0 &&
            row.state !== 'provider-accepted' &&
            row.state !== 'delivered',
        )
      );
    })
  ) {
    deny(
      'REPORT_INVALID',
      'A succeeded report must account for every endpoint with provider acceptance or stronger evidence.',
    );
  }
  return MonthlyDeliveryTestReportSchema.parse({
    id: input.id,
    runId: input.run.id,
    sequence: input.sequence,
    supersedesReportId: input.supersedesReportId,
    status: input.status,
    channels: input.channels,
    generatedAt: input.generatedAt,
    finalizedBy: {
      kind: 'system',
      serviceId: input.finalizedByServiceId,
    },
    source: input.source,
    reasonCode: input.reasonCode,
  });
}
