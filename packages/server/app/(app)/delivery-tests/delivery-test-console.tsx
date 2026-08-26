'use client';

import {
  CreateDeliveryTestPreviewInputSchema,
  CreateDeliveryTestTargetSetVersionInputSchema,
  DeliveryTestCanaryEligibilityFactSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestTargetSetVersionSchema,
  getEventClassificationPresentation,
  StartEventResultSchema,
  RecordDeliveryTestCanaryEligibilityInputSchema,
  type DeliveryTestCanaryEligibilityFact,
  type DeliveryTestPreview,
  type DeliveryTestTargetSetVersion,
  type EventTypeListItem,
} from '@psd-eoc/contracts';
import { useEffect, useRef, useState } from 'react';

import {
  DELIVERY_TEST_ACTIVATE_PATH,
  DELIVERY_TEST_ELIGIBILITY_PATH,
  DELIVERY_TEST_PREVIEW_PATH,
  DELIVERY_TEST_TARGET_SET_PATH,
  canActivateDeliveryTest,
  deliveryTestActivationInput,
  isDeliveryTestMutationOutcomeUnknown,
  requestDeliveryTest,
  requireMatchingDeliveryTestActivationResult,
  requireMatchingDeliveryTestPreview,
  type DeliveryTestPreviewSelection,
} from './client-request';

export interface DeliveryTestFacilityOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

interface DeliveryTestConsoleProps {
  readonly csrfCookieName: string;
  readonly drillEventTypes: readonly EventTypeListItem[];
  readonly facilities: readonly DeliveryTestFacilityOption[];
  readonly showTargetConfiguration: boolean;
}

interface TargetDraft {
  readonly mode:
    | 'multi-channel'
    | 'controlled-email-canary'
    | 'controlled-push-canary'
    | 'controlled-sms-canary';
  readonly previousVersionId: string;
  readonly previousVersionNumber: string;
  readonly facilityId: string;
  readonly rosterSnapshotId: string;
  readonly eligibilityFactIds: string;
}

const EMPTY_TARGET_DRAFT: TargetDraft = Object.freeze({
  mode: 'multi-channel',
  previousVersionId: '',
  previousVersionNumber: '',
  facilityId: '',
  rosterSnapshotId: '',
  eligibilityFactIds: '[]',
});

interface EligibilityDraft {
  readonly supersedesFactId: string;
  readonly facilityId: string;
  readonly rosterSnapshotId: string;
  readonly recipientId: string;
  readonly endpointId: string;
  readonly channel: 'push' | 'email' | 'sms';
  readonly decision: 'approved-synthetic-canary' | 'revoked';
  readonly optedInAt: string;
  readonly authorizationReference: string;
}

const EMPTY_ELIGIBILITY_DRAFT: EligibilityDraft = Object.freeze({
  supersedesFactId: '',
  facilityId: '',
  rosterSnapshotId: '',
  recipientId: '',
  endpointId: '',
  channel: 'push',
  decision: 'approved-synthetic-canary',
  optedInAt: '',
  authorizationReference: '',
});

function integrationTruthLabel(label: string): string {
  switch (label) {
    case 'live-verified':
      return 'Live integration and credentials verified';
    case 'mocked':
      return 'Mocked — live run blocked';
    case 'configured-unverified':
      return 'Configured but unverified — live run blocked';
    case 'blocked':
      return 'Blocked — live run unavailable';
    default:
      return 'Unknown integration state — live run blocked';
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'push':
      return 'Push';
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    default:
      return channel;
  }
}

function exactMessage(
  message: DeliveryTestPreview['activationPreview']['channels'][number]['renderedMessage'],
): Readonly<{ heading: string; body: string }> {
  if (message.channel === 'push') {
    return { heading: message.title, body: message.body };
  }
  if (message.channel === 'email') {
    return { heading: message.subject, body: message.textBody };
  }
  return { heading: 'SMS message', body: message.body };
}

function newIdempotencyKey(
  prefix: 'activate' | 'eligibility' | 'target-set',
): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function parseOpaqueEndpointReferences(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new SyntaxError('Endpoint references must be a JSON array.');
  }
  for (const endpoint of parsed) {
    if (typeof endpoint !== 'object' || endpoint === null) {
      throw new SyntaxError('Each endpoint reference must be an object.');
    }
    const forbiddenFields = [
      'address',
      'destination',
      'email',
      'phone',
      'phoneNumber',
      'pushToken',
      'token',
    ];
    if (forbiddenFields.some((field) => field in endpoint)) {
      throw new SyntaxError(
        'Endpoint destinations and contact values are forbidden. Use opaque IDs only.',
      );
    }
  }
  return parsed;
}

function parseEligibilityFactIds(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    throw new SyntaxError('Eligibility fact IDs must be a JSON string array.');
  }
  return parsed;
}

interface DeliveryTestPreviewConfirmationProps {
  readonly activateOutcomeUnknown: boolean;
  readonly activatePending: boolean;
  readonly activated: boolean;
  readonly onActivate: () => void;
  readonly preview: DeliveryTestPreview;
}

/** Exact preview UI kept independently renderable for safety-state tests. */
export function DeliveryTestPreviewConfirmation({
  activateOutcomeUnknown,
  activatePending,
  activated,
  onActivate,
  preview,
}: DeliveryTestPreviewConfirmationProps) {
  const classification = getEventClassificationPresentation({
    kind: 'test',
    templateMode: 'drill',
  });
  const previewReady = canActivateDeliveryTest(preview);
  const channelSummary = preview.channels
    .map(
      (channel) =>
        `${channelLabel(channel.channel)} (${channel.endpointCount} endpoint${
          channel.endpointCount === 1 ? '' : 's'
        })`,
    )
    .join(', ');
  return (
    <section
      className="panel delivery-test-drill"
      aria-labelledby="live-canary-confirm-heading"
    >
      <p
        className="delivery-test-classification"
        style={{
          backgroundColor: classification.colors.bannerBackground,
          borderColor: classification.colors.border,
          color: classification.colors.onBanner,
        }}
      >
        {classification.label} · LIVE CANARY
      </p>
      <h2 id="live-canary-confirm-heading">
        3. Review consequences and confirm
      </h2>
      <p>
        This is a real provider send to the exact approved controlled canary
        endpoints. {classification.explanation}
      </p>
      <p className="delivery-test-consequence-summary">
        <strong>
          {preview.activationPreview.recipientCount} approved recipients across{' '}
          {preview.channels.length} channels:
        </strong>{' '}
        {channelSummary}. Select “Confirm and start DRILL live canary” to send
        the exact DRILL messages shown below, or leave this page to send
        nothing.
      </p>
      <div className="delivery-test-channels">
        {preview.channels.map((channel) => {
          const consequence = preview.activationPreview.channels.find(
            (candidate) => candidate.channel === channel.channel,
          );
          if (consequence === undefined) return null;
          const message = exactMessage(consequence.renderedMessage);
          return (
            <article className="delivery-test-channel" key={channel.channel}>
              <h3>{channelLabel(channel.channel)}</h3>
              <p>
                <strong>{channel.endpointCount}</strong> exact approved endpoint
                {channel.endpointCount === 1 ? '' : 's'}
              </p>
              <p>{integrationTruthLabel(channel.integrationStatus.label)}</p>
              <div className="exact-message">
                <h4>Exact DRILL message</h4>
                <p>
                  <strong>{message.heading}</strong>
                </p>
                <p>{message.body}</p>
              </div>
            </article>
          );
        })}
      </div>

      {!previewReady ? (
        <div className="delivery-test-blocked" role="alert">
          <h3>Live canary run blocked</h3>
          <p>
            Every channel must be live-verified with verified credentials,
            nonzero approved endpoints, and a current exact preview.
          </p>
        </div>
      ) : null}

      <details className="delivery-test-technical-details">
        <summary>Technical preview details</summary>
        <dl className="facts">
          <dt>Target set ID</dt>
          <dd className="code-value">
            <code>{preview.targetSet.id}</code>
          </dd>
          <dt>Target version</dt>
          <dd>{preview.targetSet.version}</dd>
          <dt>Event type version ID</dt>
          <dd className="code-value">
            <code>{preview.activationPreview.eventTypeVersion.id}</code>
          </dd>
          <dt>Approved endpoint-reference digest</dt>
          <dd className="code-value">
            <code>{preview.endpointReferenceDigest}</code>
          </dd>
          <dt>Consequence digest</dt>
          <dd className="code-value">
            <code>{preview.consequenceDigest}</code>
          </dd>
          <dt>Preview expires</dt>
          <dd>
            <time dateTime={preview.expiresAt}>{preview.expiresAt}</time>
          </dd>
        </dl>
        {preview.activationPreview.blockingReasonCodes.length > 0 ? (
          <p role="alert">
            This delivery test is unavailable because one or more integration
            prerequisites are not ready. Refresh the preview; if it remains
            blocked, contact an administrator.
          </p>
        ) : null}
      </details>
      <button
        className="button delivery-test-activate"
        disabled={
          !previewReady ||
          activatePending ||
          activateOutcomeUnknown ||
          activated
        }
        onClick={onActivate}
        type="button"
      >
        {activatePending
          ? 'Starting DRILL live canary…'
          : 'Confirm and start DRILL live canary'}
      </button>
      <p className="supporting-text">
        Nothing sends automatically. Closing this page, losing the connection,
        or letting the preview expire requires a fresh preview and a fresh human
        decision. Provider acceptance is not delivery or human receipt.
      </p>
    </section>
  );
}

export function DeliveryTestConsole({
  csrfCookieName,
  drillEventTypes,
  facilities,
  showTargetConfiguration,
}: DeliveryTestConsoleProps) {
  const [eligibilityDraft, setEligibilityDraft] = useState<EligibilityDraft>(
    EMPTY_ELIGIBILITY_DRAFT,
  );
  const [eligibilityResult, setEligibilityResult] =
    useState<DeliveryTestCanaryEligibilityFact | null>(null);
  const [eligibilityPending, setEligibilityPending] = useState(false);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const eligibilityInFlight = useRef(false);
  const eligibilityIdempotencyKey = useRef(newIdempotencyKey('eligibility'));
  const [targetDraft, setTargetDraft] =
    useState<TargetDraft>(EMPTY_TARGET_DRAFT);
  const [targetResult, setTargetResult] =
    useState<DeliveryTestTargetSetVersion | null>(null);
  const [targetPending, setTargetPending] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const targetInFlight = useRef(false);
  const targetIdempotencyKey = useRef(newIdempotencyKey('target-set'));

  const [targetSetId, setTargetSetId] = useState('');
  const [targetSetVersion, setTargetSetVersion] = useState('');
  const [eventTypeVersionId, setEventTypeVersionId] = useState(
    drillEventTypes[0]?.latestVersion.id ?? '',
  );
  const [preview, setPreview] = useState<DeliveryTestPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewInFlight = useRef(false);
  const [activatePending, setActivatePending] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [activateOutcomeUnknown, setActivateOutcomeUnknown] = useState(false);
  const [activatedEventId, setActivatedEventId] = useState<string | null>(null);
  const activationInFlight = useRef(false);
  const activationIdempotencyKey = useRef(newIdempotencyKey('activate'));
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      eligibilityError !== null ||
      targetError !== null ||
      previewError !== null ||
      activateError !== null ||
      activatedEventId !== null
    ) {
      feedbackRef.current?.focus();
    }
  }, [
    activateError,
    activatedEventId,
    eligibilityError,
    previewError,
    targetError,
  ]);

  async function recordEligibility() {
    if (!showTargetConfiguration || eligibilityInFlight.current) return;
    eligibilityInFlight.current = true;
    setEligibilityPending(true);
    setEligibilityError(null);
    try {
      const command = RecordDeliveryTestCanaryEligibilityInputSchema.parse({
        ...eligibilityDraft,
        supersedesFactId:
          eligibilityDraft.supersedesFactId.length === 0
            ? null
            : eligibilityDraft.supersedesFactId,
        optedInAt: new Date(eligibilityDraft.optedInAt).toISOString(),
      });
      const result = await requestDeliveryTest(
        DELIVERY_TEST_ELIGIBILITY_PATH,
        command,
        csrfCookieName,
        DeliveryTestCanaryEligibilityFactSchema,
        eligibilityIdempotencyKey.current,
      );
      setEligibilityResult(result);
      setTargetDraft((current) => {
        let ids: string[] = [];
        try {
          const parsed = parseEligibilityFactIds(current.eligibilityFactIds);
          if (Array.isArray(parsed)) ids = parsed as string[];
        } catch {
          // Replace malformed local draft with the authoritative new fact ID.
        }
        return {
          ...current,
          eligibilityFactIds: JSON.stringify(
            [...new Set([...ids, result.id])],
            null,
            2,
          ),
        };
      });
      eligibilityIdempotencyKey.current = newIdempotencyKey('eligibility');
    } catch (error) {
      setEligibilityError(
        error instanceof Error
          ? error.message
          : 'The eligibility decision was not recorded.',
      );
    } finally {
      eligibilityInFlight.current = false;
      setEligibilityPending(false);
    }
  }

  async function createTargetSet() {
    if (!showTargetConfiguration || targetInFlight.current) return;
    targetInFlight.current = true;
    setTargetPending(true);
    setTargetError(null);
    try {
      const previousVersion =
        targetDraft.previousVersionId.length === 0 &&
        targetDraft.previousVersionNumber.length === 0
          ? null
          : {
              id: targetDraft.previousVersionId,
              version: Number(targetDraft.previousVersionNumber),
            };
      const command = CreateDeliveryTestTargetSetVersionInputSchema.parse({
        ...(targetDraft.mode === 'multi-channel'
          ? {}
          : { mode: targetDraft.mode }),
        previousVersion,
        facilityId: targetDraft.facilityId,
        rosterSnapshotId: targetDraft.rosterSnapshotId,
        eligibilityFactIds: parseEligibilityFactIds(
          targetDraft.eligibilityFactIds,
        ),
      });
      const result = await requestDeliveryTest(
        DELIVERY_TEST_TARGET_SET_PATH,
        command,
        csrfCookieName,
        DeliveryTestTargetSetVersionSchema,
        targetIdempotencyKey.current,
      );
      setTargetResult(result);
      setTargetSetId(result.id);
      setTargetSetVersion(String(result.version));
      targetIdempotencyKey.current = newIdempotencyKey('target-set');
    } catch (error) {
      setTargetError(
        error instanceof Error
          ? error.message
          : 'The target version was not accepted.',
      );
    } finally {
      targetInFlight.current = false;
      setTargetPending(false);
    }
  }

  async function loadPreview() {
    if (previewInFlight.current || activateOutcomeUnknown) return;
    previewInFlight.current = true;
    setPreviewPending(true);
    setPreview(null);
    setPreviewError(null);
    setActivateError(null);
    try {
      const eventType = drillEventTypes.find(
        ({ latestVersion }) => latestVersion.id === eventTypeVersionId,
      );
      const selection = CreateDeliveryTestPreviewInputSchema.parse({
        targetSet: {
          id: targetSetId,
          version: Number(targetSetVersion),
        },
        eventTypeVersion: {
          id: eventTypeVersionId,
          templateMode: eventType?.latestVersion.templateMode,
        },
      });
      const value = await requestDeliveryTest(
        DELIVERY_TEST_PREVIEW_PATH,
        selection,
        csrfCookieName,
        DeliveryTestPreviewSchema,
      );
      const exactSelection: DeliveryTestPreviewSelection = {
        targetSet: selection.targetSet,
        eventTypeVersion: {
          id: selection.eventTypeVersion.id,
          templateMode: 'drill',
        },
      };
      setPreview(requireMatchingDeliveryTestPreview(value, exactSelection));
      activationIdempotencyKey.current = newIdempotencyKey('activate');
    } catch (error) {
      setPreviewError(
        error instanceof Error
          ? error.message
          : 'The consequence preview could not be loaded. No notification was queued.',
      );
    } finally {
      previewInFlight.current = false;
      setPreviewPending(false);
    }
  }

  async function activate() {
    if (
      preview === null ||
      !canActivateDeliveryTest(preview) ||
      activationInFlight.current ||
      activateOutcomeUnknown ||
      activatedEventId !== null
    ) {
      return;
    }
    activationInFlight.current = true;
    setActivatePending(true);
    setActivateError(null);
    try {
      const idempotencyKey = activationIdempotencyKey.current;
      const result = await requestDeliveryTest(
        DELIVERY_TEST_ACTIVATE_PATH,
        deliveryTestActivationInput(preview),
        csrfCookieName,
        StartEventResultSchema,
        idempotencyKey,
      );
      const event = requireMatchingDeliveryTestActivationResult(
        result,
        preview,
        idempotencyKey,
      );
      setActivatedEventId(event.id);
    } catch (error) {
      setActivateOutcomeUnknown(isDeliveryTestMutationOutcomeUnknown(error));
      setActivateError(
        error instanceof Error
          ? error.message
          : 'The DRILL canary activation was not accepted.',
      );
    } finally {
      activationInFlight.current = false;
      setActivatePending(false);
    }
  }

  const selectedFacility = facilities.find(
    (facility) => facility.id === targetDraft.facilityId,
  );

  return (
    <div className="delivery-test-console">
      <div ref={feedbackRef} tabIndex={-1}>
        {eligibilityError !== null ? (
          <p role="alert">{eligibilityError}</p>
        ) : null}
        {targetError !== null ? <p role="alert">{targetError}</p> : null}
        {previewError !== null ? <p role="alert">{previewError}</p> : null}
        {activateError !== null ? <p role="alert">{activateError}</p> : null}
        {activatedEventId !== null ? (
          <section
            className="delivery-test-result delivery-test-result--accepted"
            aria-labelledby="delivery-test-accepted-heading"
          >
            <h2 id="delivery-test-accepted-heading">DRILL accepted</h2>
            <p role="status">
              PSD EOC durably accepted the DRILL and recorded its notification
              intent. This does not claim provider acceptance, delivery, or
              human receipt.
            </p>
            <a className="button" href={`/events/${activatedEventId}`}>
              Open DRILL event
            </a>
          </section>
        ) : null}
      </div>

      {showTargetConfiguration ? (
        <section className="panel" aria-labelledby="target-config-heading">
          <h2 id="target-config-heading">1. Configure controlled canaries</h2>
          <p>
            These append-only configuration actions cannot start an event or
            send a notification. Never enter an email address, phone number,
            push token, or other destination.
          </p>
          <h3>Record eligibility or revocation</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void recordEligibility();
            }}
          >
            <div className="delivery-test-grid">
              <label>
                Target mode
                <select
                  value={targetDraft.mode}
                  onChange={(event) => {
                    const mode = event.currentTarget
                      .value as TargetDraft['mode'];
                    setTargetDraft({
                      ...targetDraft,
                      mode,
                    });
                    if (mode !== 'multi-channel') {
                      setEligibilityDraft({
                        ...eligibilityDraft,
                        channel:
                          mode === 'controlled-push-canary'
                            ? 'push'
                            : mode === 'controlled-email-canary'
                              ? 'email'
                              : 'sms',
                      });
                    }
                  }}
                >
                  <option value="multi-channel">Push and email</option>
                  <option value="controlled-push-canary">
                    One approved push endpoint
                  </option>
                  <option value="controlled-email-canary">
                    One approved email endpoint
                  </option>
                  <option value="controlled-sms-canary">
                    One approved SMS endpoint
                  </option>
                </select>
              </label>
              <label>
                Facility
                <select
                  required
                  value={eligibilityDraft.facilityId}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      facilityId: event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Choose authorized facility</option>
                  {facilities.map((facility) => (
                    <option key={facility.id} value={facility.id}>
                      {facility.code} — {facility.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Current staff roster snapshot ID
                <input
                  required
                  spellCheck={false}
                  value={eligibilityDraft.rosterSnapshotId}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      rosterSnapshotId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Recipient ID
                <input
                  required
                  spellCheck={false}
                  value={eligibilityDraft.recipientId}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      recipientId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Endpoint ID
                <input
                  required
                  spellCheck={false}
                  value={eligibilityDraft.endpointId}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      endpointId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Channel
                <select
                  disabled={targetDraft.mode !== 'multi-channel'}
                  value={eligibilityDraft.channel}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      channel: event.currentTarget.value as
                        | 'push'
                        | 'email'
                        | 'sms',
                    })
                  }
                >
                  <option value="push">Push</option>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </label>
              {targetDraft.mode === 'controlled-sms-canary' ? (
                <p className="delivery-test-field-note">
                  SMS approval proves only the selected endpoint is eligible.
                  Provider acceptance is not handset delivery. A STOP reply is
                  append-only and keeps this snapshot endpoint suppressed until
                  the verified recovery procedure creates a new target version.
                </p>
              ) : null}
              <label>
                Decision
                <select
                  value={eligibilityDraft.decision}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      decision: event.currentTarget.value as
                        | 'approved-synthetic-canary'
                        | 'revoked',
                    })
                  }
                >
                  <option value="approved-synthetic-canary">
                    Approve controlled canary
                  </option>
                  <option value="revoked">Revoke eligibility</option>
                </select>
              </label>
              <label>
                Superseded eligibility fact ID (required for revocation)
                <input
                  spellCheck={false}
                  value={eligibilityDraft.supersedesFactId}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      supersedesFactId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Recorded opt-in time
                <input
                  required
                  type="datetime-local"
                  value={eligibilityDraft.optedInAt}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      optedInAt: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Non-secret opaque authorization reference
                <input
                  required
                  spellCheck={false}
                  value={eligibilityDraft.authorizationReference}
                  onChange={(event) =>
                    setEligibilityDraft({
                      ...eligibilityDraft,
                      authorizationReference: event.currentTarget.value,
                    })
                  }
                />
                <span className="supporting-text">
                  Letters, numbers, dot, underscore, colon, and hyphen only. Do
                  not enter contacts, destinations, credentials, or secrets.
                </span>
              </label>
            </div>
            <button
              className="button button--secondary"
              disabled={eligibilityPending}
            >
              {eligibilityPending
                ? 'Recording immutable decision…'
                : 'Record eligibility decision'}
            </button>
          </form>
          {eligibilityResult !== null ? (
            <div className="delivery-test-result" role="status">
              <p>
                Eligibility decision{' '}
                <strong>{eligibilityResult.decision}</strong> recorded. Fact ID:{' '}
                <code>{eligibilityResult.id}</code>
              </p>
              <p>No event was started and no notification was sent.</p>
            </div>
          ) : null}
          <h3>Approve an immutable target version from eligibility facts</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createTargetSet();
            }}
          >
            <div className="delivery-test-grid">
              <label>
                Facility
                <select
                  required
                  value={targetDraft.facilityId}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      facilityId: event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Choose authorized facility</option>
                  {facilities.map((facility) => (
                    <option key={facility.id} value={facility.id}>
                      {facility.code} — {facility.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Current staff roster snapshot ID
                <input
                  autoComplete="off"
                  required
                  spellCheck={false}
                  value={targetDraft.rosterSnapshotId}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      rosterSnapshotId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Previous target version ID (blank for version 1)
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={targetDraft.previousVersionId}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      previousVersionId: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                Previous version number
                <input
                  min="1"
                  step="1"
                  type="number"
                  value={targetDraft.previousVersionNumber}
                  onChange={(event) =>
                    setTargetDraft({
                      ...targetDraft,
                      previousVersionNumber: event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>
            <label>
              Current eligibility fact IDs (JSON string array)
              <textarea
                aria-describedby="endpoint-reference-help"
                required
                rows={12}
                spellCheck={false}
                value={targetDraft.eligibilityFactIds}
                onChange={(event) =>
                  setTargetDraft({
                    ...targetDraft,
                    eligibilityFactIds: event.currentTarget.value,
                  })
                }
              />
            </label>
            <p className="supporting-text" id="endpoint-reference-help">
              Enter only IDs from current approved eligibility facts. The server
              loads all endpoint identity, opt-in, product-owner, and revocation
              truth; this request cannot assert any attestation.
            </p>
            <button
              className="button button--secondary"
              disabled={targetPending}
            >
              {targetPending
                ? 'Saving immutable version…'
                : `Save target version${selectedFacility === undefined ? '' : ` for ${selectedFacility.code}`}`}
            </button>
          </form>
          {targetResult !== null ? (
            <div className="delivery-test-result" role="status">
              <p>
                Target version <strong>{targetResult.version}</strong> saved. It
                contains {targetResult.endpoints.length} opaque endpoint
                reference{targetResult.endpoints.length === 1 ? '' : 's'}.
              </p>
              <p className="code-value">
                Target ID: <code>{targetResult.id}</code>
              </p>
              <p>
                Saving did not start a DRILL or send any notification. A fresh
                preview and explicit human confirmation are still required.
              </p>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="panel" aria-labelledby="target-config-heading">
          <h2 id="target-config-heading">Canary target configuration</h2>
          <p>
            Only the product-owner administrator can approve immutable target
            versions. Authorized staff may preview and explicitly run a
            previously approved version within their facility scope.
          </p>
        </section>
      )}

      <section className="panel" aria-labelledby="preview-heading">
        <h2 id="preview-heading">2. Load exact DRILL consequence preview</h2>
        <p>
          Loading a preview is read-only: it never starts an event, queues a
          notification, or contacts a provider. Only the exact pinned approved
          endpoint references may route if a human later confirms.
        </p>
        {drillEventTypes.length === 0 ? (
          <p role="alert">
            No enabled DRILL event type is available. A preview cannot be
            created and nothing can send.
          </p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void loadPreview();
          }}
        >
          <div className="delivery-test-grid">
            <label>
              Approved target version ID
              <input
                autoComplete="off"
                required
                spellCheck={false}
                value={targetSetId}
                onChange={(event) => setTargetSetId(event.currentTarget.value)}
              />
            </label>
            <label>
              Target version number
              <input
                min="1"
                required
                step="1"
                type="number"
                value={targetSetVersion}
                onChange={(event) =>
                  setTargetSetVersion(event.currentTarget.value)
                }
              />
            </label>
            <label>
              DRILL event type
              <select
                required
                value={eventTypeVersionId}
                onChange={(event) =>
                  setEventTypeVersionId(event.currentTarget.value)
                }
              >
                {drillEventTypes.map(({ latestVersion }) => (
                  <option key={latestVersion.id} value={latestVersion.id}>
                    {latestVersion.name} — DRILL
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="button button--secondary"
            disabled={
              drillEventTypes.length === 0 ||
              previewPending ||
              activateOutcomeUnknown
            }
          >
            {previewPending ? 'Loading consequence preview…' : 'Load preview'}
          </button>
        </form>
      </section>

      {preview !== null ? (
        <DeliveryTestPreviewConfirmation
          activateOutcomeUnknown={activateOutcomeUnknown}
          activatePending={activatePending}
          activated={activatedEventId !== null}
          onActivate={() => void activate()}
          preview={preview}
        />
      ) : null}
    </div>
  );
}
