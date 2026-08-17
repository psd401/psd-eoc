'use client';

import {
  ApiErrorSchema,
  StartEventInputSchema,
  type DeliveryTestPreview,
  type Event,
  type StartEventInput,
  type StartEventResult,
} from '@psd-eoc/contracts';

import {
  StartFlowRequestError,
  requireMatchingActivationResult,
} from '../start/_lib/client-request';

export const DELIVERY_TEST_PREVIEW_PATH =
  '/delivery-tests/api/preview' as const;
export const DELIVERY_TEST_TARGET_SET_PATH =
  '/delivery-tests/api/target-sets' as const;
export const DELIVERY_TEST_ELIGIBILITY_PATH =
  '/delivery-tests/api/eligibility' as const;
export const DELIVERY_TEST_ACTIVATE_PATH =
  '/delivery-tests/api/activate' as const;

type DeliveryTestRequestPath =
  | typeof DELIVERY_TEST_PREVIEW_PATH
  | typeof DELIVERY_TEST_ELIGIBILITY_PATH
  | typeof DELIVERY_TEST_TARGET_SET_PATH
  | typeof DELIVERY_TEST_ACTIVATE_PATH;

const REQUEST_TIMEOUT_MS = 20_000;

export class DeliveryTestRequestError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = 'DeliveryTestRequestError';
  }
}

export interface DeliveryTestPreviewSelection {
  readonly targetSet: Readonly<{ id: string; version: number }>;
  readonly eventTypeVersion: Readonly<{
    id: string;
    templateMode: 'drill';
  }>;
}

function readCookie(name: string): string | null {
  for (const segment of document.cookie.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1 || segment.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function outcomeUnknown(path: DeliveryTestRequestPath, status?: number) {
  return path !== DELIVERY_TEST_PREVIEW_PATH && (status ?? 500) >= 500;
}

function safeFailureMessage(path: DeliveryTestRequestPath): string {
  if (path === DELIVERY_TEST_PREVIEW_PATH) {
    return 'The consequence preview could not be loaded. No event was started and no notification was queued.';
  }
  return 'The server outcome is unknown. Nothing will retry automatically. Check current events and delivery-test reports before making a fresh decision.';
}

/**
 * Performs exactly one explicit browser request. This helper never retries or
 * persists a request for later delivery.
 */
export async function requestDeliveryTest<Output>(
  path: DeliveryTestRequestPath,
  body: unknown,
  csrfCookieName: string,
  parser: Readonly<{ parse(value: unknown): Output }>,
  idempotencyKey?: string,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Output> {
  const csrfToken = readCookie(csrfCookieName);
  if (csrfToken === null) {
    throw new DeliveryTestRequestError(
      'Your secure browser session is incomplete. Sign in again before continuing.',
      false,
      false,
    );
  }
  if (
    path !== DELIVERY_TEST_PREVIEW_PATH &&
    (idempotencyKey === undefined || idempotencyKey.length === 0)
  ) {
    throw new DeliveryTestRequestError(
      'This explicit delivery-test action requires an idempotency key.',
      false,
      false,
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException('Request deadline exceeded.', 'AbortError'),
    );
  }, timeoutMs);
  const dispose = () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  };

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-psd-eoc-csrf': csrfToken,
        ...(idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    dispose();
    if (
      !timedOut &&
      signal?.aborted === true &&
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      throw error;
    }
    throw new DeliveryTestRequestError(
      safeFailureMessage(path),
      path === DELIVERY_TEST_PREVIEW_PATH,
      path !== DELIVERY_TEST_PREVIEW_PATH,
    );
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    dispose();
    throw new DeliveryTestRequestError(
      response.ok
        ? `PSD EOC returned an invalid ${path === DELIVERY_TEST_PREVIEW_PATH ? 'consequence preview' : 'action response'}. No automatic retry will occur.`
        : safeFailureMessage(path),
      path === DELIVERY_TEST_PREVIEW_PATH,
      outcomeUnknown(path, response.status),
    );
  }
  dispose();
  if (!response.ok) {
    const apiError = ApiErrorSchema.safeParse(payload);
    const unknown = outcomeUnknown(path, response.status);
    throw new DeliveryTestRequestError(
      apiError.success ? apiError.data.message : safeFailureMessage(path),
      !unknown && apiError.success && apiError.data.retryable,
      unknown,
    );
  }

  try {
    return parser.parse(payload);
  } catch {
    throw new DeliveryTestRequestError(
      path === DELIVERY_TEST_PREVIEW_PATH
        ? 'PSD EOC returned an invalid consequence preview. No event was started and no notification was queued.'
        : 'PSD EOC returned an invalid action response. Treat the outcome as unresolved and contact district technology.',
      path === DELIVERY_TEST_PREVIEW_PATH,
      path !== DELIVERY_TEST_PREVIEW_PATH,
    );
  }
}

/** Pins a server preview to the exact immutable target and DRILL version. */
export function requireMatchingDeliveryTestPreview(
  preview: DeliveryTestPreview,
  selection: DeliveryTestPreviewSelection,
): DeliveryTestPreview {
  const activation = preview.activationPreview;
  const metadata = activation.deliveryTest;
  if (
    preview.purpose !== 'monthly-live-delivery-test' ||
    preview.targetSet.id !== selection.targetSet.id ||
    preview.targetSet.version !== selection.targetSet.version ||
    activation.eventTypeVersion.id !== selection.eventTypeVersion.id ||
    activation.eventTypeVersion.templateMode !== 'drill' ||
    activation.kind !== 'drill' ||
    activation.templateMode !== 'drill' ||
    activation.rosterPopulation !== 'staff' ||
    metadata?.targetSet.id !== preview.targetSet.id ||
    metadata.targetSet.version !== preview.targetSet.version ||
    metadata.endpointReferenceDigest !== preview.endpointReferenceDigest ||
    activation.consequenceDigest !== preview.consequenceDigest
  ) {
    throw new DeliveryTestRequestError(
      'The server returned a consequence preview for a different DRILL target or event type. No event was started and no notification was queued.',
      false,
      false,
    );
  }
  return preview;
}

/** A live-canary send is enabled only while every current truth gate is ready. */
export function canActivateDeliveryTest(
  preview: DeliveryTestPreview,
  now: Date = new Date(),
): boolean {
  const activation = preview.activationPreview;
  const metadata = activation.deliveryTest;
  const controlledEmailCanary =
    preview.channels.length === 1 &&
    preview.channels[0]?.channel === 'email' &&
    preview.channels[0].endpointCount === 1 &&
    activation.channels.length === 1 &&
    activation.channels[0]?.channel === 'email' &&
    activation.channels[0].endpointCount === 1 &&
    activation.recipientCount === 1;
  return (
    Date.parse(preview.expiresAt) > now.getTime() &&
    activation.kind === 'drill' &&
    activation.templateMode === 'drill' &&
    activation.rosterPopulation === 'staff' &&
    activation.sendReadiness === 'ready' &&
    activation.blockingReasonCodes.length === 0 &&
    metadata?.purpose === 'monthly-live-delivery-test' &&
    metadata.targetSet.id === preview.targetSet.id &&
    metadata.targetSet.version === preview.targetSet.version &&
    metadata.endpointReferenceDigest === preview.endpointReferenceDigest &&
    preview.channels.length === activation.channels.length &&
    preview.channels.every(
      (channel) =>
        channel.endpointCount > 0 &&
        channel.credentialVerified &&
        channel.integrationStatus.label === 'live-verified',
    ) &&
    (controlledEmailCanary ||
      (preview.channels.some((channel) => channel.channel === 'push') &&
        preview.channels.some((channel) => channel.channel === 'email')))
  );
}

/** Exact start-event input produced only after the human activates the button. */
export function deliveryTestActivationInput(
  preview: DeliveryTestPreview,
): StartEventInput {
  return StartEventInputSchema.parse({
    source: 'activation-preview',
    activationPreviewId: preview.activationPreview.id,
    activeEventDecision: {
      decision: 'start-new',
      activeEventIdsSeen: preview.activationPreview.activeEventIds,
    },
  });
}

function resultMismatch(): DeliveryTestRequestError {
  return new DeliveryTestRequestError(
    'PSD EOC returned an event that does not match the confirmed DRILL canary preview. Treat the outcome as unresolved and check current events and reports.',
    false,
    true,
  );
}

/** Binds a successful start-event response to exact canary provenance. */
export function requireMatchingDeliveryTestActivationResult(
  result: StartEventResult,
  preview: DeliveryTestPreview,
  idempotencyKey: string,
): Event {
  const metadata = result.notificationIntent?.deliveryTest;
  if (
    metadata?.purpose !== 'monthly-live-delivery-test' ||
    metadata.targetSet.id !== preview.targetSet.id ||
    metadata.targetSet.version !== preview.targetSet.version ||
    metadata.endpointReferenceDigest !== preview.endpointReferenceDigest ||
    result.event.kind !== 'drill' ||
    result.event.templateMode !== 'drill' ||
    result.event.rosterPopulation !== 'staff'
  ) {
    throw resultMismatch();
  }

  try {
    return requireMatchingActivationResult(
      result,
      preview.activationPreview,
      {
        eventKind: 'drill',
        eventTypeVersionId: preview.activationPreview.eventTypeVersion.id,
        facilityId: preview.activationPreview.facilityId,
        templateMode: 'drill',
      },
      idempotencyKey,
    );
  } catch (error) {
    if (error instanceof StartFlowRequestError) throw resultMismatch();
    throw error;
  }
}

export function isDeliveryTestMutationOutcomeUnknown(error: unknown): boolean {
  return (
    (error instanceof DeliveryTestRequestError && error.outcomeUnknown) ||
    (error instanceof StartFlowRequestError && error.outcomeUnknown)
  );
}
