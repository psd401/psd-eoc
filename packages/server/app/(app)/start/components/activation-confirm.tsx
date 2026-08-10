'use client';

import {
  ActivationPreviewSchema,
  JoinEventResultSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type Event,
  type EventKind,
  type TemplateMode,
} from '@psd-eoc/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  StartFlowRequestError,
  requestActiveEvent,
  requestStartFlow,
} from '../_lib/client-request';
import { ClassificationBanner } from './classification-banner';
import { ClassificationIcon } from './classification-icon';

export interface ConfirmedSelection {
  readonly eventKind: Extract<EventKind, 'incident' | 'drill'>;
  readonly eventTypeName: string;
  readonly eventTypeVersionId: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly templateMode: TemplateMode;
}

export interface ActiveEventChoice {
  readonly event: Event;
  readonly label: string;
}

interface ActivationConfirmProps {
  readonly activationIdempotencyKey: string;
  readonly activeEvents: readonly ActiveEventChoice[];
  readonly csrfCookieName: string;
  readonly selection: ConfirmedSelection;
}

type MutationResult =
  | Readonly<{
      kind: 'activated';
      eventId: string;
      eventTypeName: string;
      templateMode: TemplateMode;
    }>
  | Readonly<{
      kind: 'joined';
      eventId: string;
      eventTypeName: string;
      templateMode: TemplateMode;
    }>;

type ResolvedActiveEventChoice = ActiveEventChoice;

const TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function channelName(
  channel: ActivationPreview['channels'][number]['channel'],
) {
  switch (channel) {
    case 'push':
      return 'Push notifications';
    case 'email':
      return 'Email';
    case 'sms':
      return 'Text messages';
  }
}

function integrationLabel(
  label: ActivationPreview['channels'][number]['integrationStatus']['label'],
) {
  switch (label) {
    case 'live-verified':
      return 'Live integration verified';
    case 'mocked':
      return 'Mocked — training data only';
    case 'configured-unverified':
      return 'Configured, not verified';
    case 'blocked':
      return 'Blocked';
  }
}

function blockingReason(reason: string): string {
  return reason.toLowerCase().replaceAll('_', ' ');
}

function audienceLabel(preview: ActivationPreview): string {
  return preview.rosterPopulation === 'staff'
    ? 'staff recipients'
    : 'synthetic recipients';
}

function classificationLabel(mode: TemplateMode): string {
  return mode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY';
}

function fallbackEventName(kind: EventKind): string {
  switch (kind) {
    case 'incident':
      return 'Incident';
    case 'drill':
      return 'Drill';
    case 'test':
      return 'Test event';
  }
}

function SelectedEventSummary({
  eventTypeName,
  facilityName,
  templateMode,
}: Readonly<{
  eventTypeName: string;
  facilityName: string;
  templateMode: TemplateMode;
}>) {
  return (
    <section className="panel" aria-labelledby="selection-heading">
      <h2 id="selection-heading">Selected event</h2>
      <dl className="facts">
        <dt>Facility</dt>
        <dd>{facilityName}</dd>
        <dt>Event type</dt>
        <dd>{eventTypeName}</dd>
        <dt>Classification</dt>
        <dd>
          <span
            className={`classification-label classification-label--${templateMode}`}
          >
            <ClassificationIcon mode={templateMode} />{' '}
            {classificationLabel(templateMode)}
          </span>
        </dd>
      </dl>
      <p className="supporting-text">
        Reaching this page has not started an event or queued a notification.
      </p>
    </section>
  );
}

function ExactChannelMessage({
  channel,
}: Readonly<{ channel: ActivationPreview['channels'][number] }>) {
  const message = channel.renderedMessage;

  return (
    <section
      className="exact-message"
      aria-label={`Exact ${channelName(channel.channel)} message preview`}
    >
      <h4>Exact message preview</h4>
      <dl className="exact-message__fields">
        {message.channel === 'push' ? (
          <>
            <dt>Title</dt>
            <dd>{message.title}</dd>
            <dt>Message</dt>
            <dd>{message.body}</dd>
          </>
        ) : null}
        {message.channel === 'email' ? (
          <>
            <dt>Subject</dt>
            <dd>{message.subject}</dd>
            <dt>Message</dt>
            <dd>{message.textBody}</dd>
          </>
        ) : null}
        {message.channel === 'sms' ? (
          <>
            <dt>Message</dt>
            <dd>{message.body}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function requireMatchingPreview(
  preview: ActivationPreview,
  selection: ConfirmedSelection,
): ActivationPreview {
  if (
    preview.facilityId !== selection.facilityId ||
    preview.kind !== selection.eventKind ||
    preview.templateMode !== selection.templateMode ||
    preview.eventTypeVersion.id !== selection.eventTypeVersionId ||
    preview.eventTypeVersion.templateMode !== selection.templateMode ||
    preview.rosterPopulation !== 'staff'
  ) {
    throw new StartFlowRequestError(
      'The server returned a consequence preview for a different event selection. No event was started and no notification was queued.',
      false,
      false,
    );
  }
  return preview;
}

function requireMatchingActiveEvent(
  event: Event,
  eventId: string,
  selection: ConfirmedSelection,
): Event {
  if (
    event.id !== eventId ||
    event.facilityId !== selection.facilityId ||
    event.status !== 'active'
  ) {
    throw new StartFlowRequestError(
      'The current active-event details do not match this facility and preview. No event can be started or joined until you load a fresh preview.',
      false,
      false,
    );
  }
  return event;
}

function requireMatchingActivation(
  event: Event,
  preview: ActivationPreview,
  selection: ConfirmedSelection,
): Event {
  if (
    event.facilityId !== selection.facilityId ||
    event.kind !== selection.eventKind ||
    event.templateMode !== selection.templateMode ||
    event.eventTypeVersion.id !== selection.eventTypeVersionId ||
    event.eventTypeVersion.templateMode !== selection.templateMode ||
    event.rosterSnapshotId !== preview.rosterSnapshotId ||
    event.rosterPopulation !== preview.rosterPopulation ||
    event.status !== 'active'
  ) {
    throw new StartFlowRequestError(
      'PSD EOC returned an event that does not match the confirmed preview. Treat the outcome as unresolved and check the dashboard before making another decision.',
      false,
      true,
    );
  }
  return event;
}

function requireMatchingJoinedEvent(event: Event, expected: Event): Event {
  if (
    event.id !== expected.id ||
    event.facilityId !== expected.facilityId ||
    event.kind !== expected.kind ||
    event.templateMode !== expected.templateMode ||
    event.eventTypeVersion.id !== expected.eventTypeVersion.id
  ) {
    throw new StartFlowRequestError(
      'PSD EOC returned a joined event that does not match the event you chose. Treat the outcome as unresolved and check the dashboard before making another decision.',
      false,
      true,
    );
  }
  return event;
}

export function ActivationConfirm({
  activationIdempotencyKey,
  activeEvents,
  csrfCookieName,
  selection,
}: ActivationConfirmProps) {
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [resolvedActiveEvents, setResolvedActiveEvents] = useState<
    readonly ResolvedActiveEventChoice[]
  >([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [mutationPending, setMutationPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationUnknown, setMutationUnknown] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setPreview(null);
    setResolvedActiveEvents([]);
    setPreviewError(null);
    setPreviewLoading(true);
    void (async () => {
      const value = await requestStartFlow(
        '/start/api/preview',
        {
          facilityId: selection.facilityId,
          kind: selection.eventKind,
          templateMode: selection.templateMode,
          eventTypeVersion: {
            id: selection.eventTypeVersionId,
            templateMode: selection.templateMode,
          },
          rosterPopulation: 'staff',
        },
        csrfCookieName,
        ActivationPreviewSchema,
        undefined,
        controller.signal,
      );
      const matchingPreview = requireMatchingPreview(value, selection);
      const currentActiveEvents = await Promise.all(
        matchingPreview.activeEventIds.map(async (eventId) => {
          const namedEvent = activeEvents.find(
            (candidate) => candidate.event.id === eventId,
          );
          const event = requireMatchingActiveEvent(
            namedEvent?.event ??
              (await requestActiveEvent(eventId, controller.signal)),
            eventId,
            selection,
          );
          return Object.freeze({
            label: namedEvent?.label ?? fallbackEventName(event.kind),
            event,
          });
        }),
      );
      if (active) {
        setResolvedActiveEvents(currentActiveEvents);
        setPreview(matchingPreview);
      }
    })()
      .catch((error: unknown) => {
        if (
          !active ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setPreviewError(
          error instanceof Error
            ? error.message
            : 'The consequence preview could not be loaded.',
        );
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    csrfCookieName,
    activeEvents,
    previewAttempt,
    selection.eventKind,
    selection.eventTypeVersionId,
    selection.facilityId,
    selection.templateMode,
  ]);

  useEffect(() => {
    if (mutationError !== null || result !== null) {
      feedbackRef.current?.focus();
    }
  }, [mutationError, result]);

  async function activate() {
    if (
      preview === null ||
      preview.sendReadiness !== 'ready' ||
      mutationPending ||
      mutationUnknown ||
      result !== null
    ) {
      return;
    }
    setMutationPending(true);
    setMutationError(null);
    setMutationUnknown(false);
    try {
      const activated = await requestStartFlow(
        '/start/api/activate',
        {
          source: 'activation-preview',
          activationPreviewId: preview.id,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: preview.activeEventIds,
          },
        },
        csrfCookieName,
        StartEventResultSchema,
        activationIdempotencyKey,
      );
      const event = requireMatchingActivation(
        activated.event,
        preview,
        selection,
      );
      setResult({
        kind: 'activated',
        eventId: event.id,
        eventTypeName: selection.eventTypeName,
        templateMode: event.templateMode,
      });
    } catch (error) {
      setMutationUnknown(
        error instanceof StartFlowRequestError && error.outcomeUnknown,
      );
      setMutationError(
        error instanceof Error
          ? error.message
          : 'The activation was not accepted.',
      );
    } finally {
      setMutationPending(false);
    }
  }

  async function join(choice: ResolvedActiveEventChoice) {
    if (mutationPending || result !== null) return;
    setMutationPending(true);
    setMutationError(null);
    setMutationUnknown(false);
    try {
      const joined = await requestStartFlow(
        '/start/api/join',
        { eventId: choice.event.id },
        csrfCookieName,
        JoinEventResultSchema,
        `join:${crypto.randomUUID()}`,
      );
      const event = requireMatchingJoinedEvent(joined.event, choice.event);
      setResult({
        kind: 'joined',
        eventId: event.id,
        eventTypeName: choice.label,
        templateMode: event.templateMode,
      });
    } catch (error) {
      setMutationUnknown(
        error instanceof StartFlowRequestError && error.outcomeUnknown,
      );
      setMutationError(
        error instanceof Error ? error.message : 'The event was not joined.',
      );
    } finally {
      setMutationPending(false);
    }
  }

  if (result !== null) {
    return (
      <div>
        <ClassificationBanner
          mode={result.templateMode}
          detail={
            result.kind === 'joined'
              ? 'This is the actual classification of the event you joined.'
              : 'This is the actual classification of the event PSD EOC accepted.'
          }
        />
        <section
          className="result-panel"
          aria-labelledby="result-heading"
          ref={feedbackRef}
          tabIndex={-1}
        >
          <h2 id="result-heading">
            {result.kind === 'activated'
              ? result.templateMode === 'real'
                ? 'Incident started'
                : 'Drill started'
              : 'Event joined'}
          </h2>
          <p>
            <strong>{result.eventTypeName}</strong> —{' '}
            <span
              className={`classification-label classification-label--${result.templateMode}`}
            >
              <ClassificationIcon mode={result.templateMode} />{' '}
              {classificationLabel(result.templateMode)}
            </span>
          </p>
          <p role="status">
            {result.kind === 'activated'
              ? `PSD EOC durably accepted the ${result.templateMode === 'real' ? 'incident' : 'drill'} and recorded its notification intent.`
              : 'You joined the existing event. Joining did not create another event or notification.'}
          </p>
          <p>
            Provider acceptance and human receipt are tracked separately; this
            screen does not claim either one.
          </p>
          <p className="action-grid">
            <Link className="button" href={`/events/${result.eventId}`}>
              Open event
            </Link>
            <Link className="button button--secondary" href="/">
              Return to dashboard
            </Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <ClassificationBanner
        mode={selection.templateMode}
        detail={
          selection.templateMode === 'real'
            ? 'Final confirmation starts a real incident and creates real staff-notification intents only when integrations are live-verified.'
            : 'Final confirmation starts a training drill. Every resulting event and message remains marked DRILL.'
        }
      />

      <SelectedEventSummary
        eventTypeName={selection.eventTypeName}
        facilityName={selection.facilityName}
        templateMode={selection.templateMode}
      />

      <div className="consequence-preview">
        {previewLoading ? (
          <p className="status-message" role="status">
            Loading the current roster snapshot, active events, and channel
            consequences…
          </p>
        ) : null}

        {previewError !== null ? (
          <section className="error-summary" role="alert">
            <h2>Consequence preview unavailable</h2>
            <p>{previewError}</p>
            <p>No event was started and no notification was queued.</p>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
            >
              Load a fresh preview
            </button>
          </section>
        ) : null}

        {preview !== null ? (
          <>
            <section aria-labelledby="audience-heading">
              <h2 id="audience-heading">
                Notification audience and eligible endpoints
              </h2>
              <p>
                <strong>
                  {preview.recipientCount} selected {audienceLabel(preview)}
                </strong>{' '}
                resolved from immutable roster snapshot{' '}
                <code>{preview.rosterSnapshotId}</code>.
              </p>
              <div className="channel-grid">
                {preview.channels.map((channel) => (
                  <article className="channel-card" key={channel.channel}>
                    <h3>{channelName(channel.channel)}</h3>
                    <p>
                      <strong>{channel.endpointCount}</strong> active endpoint
                      {channel.endpointCount === 1 ? '' : 's'} in the pinned
                      roster
                    </p>
                    <p>{integrationLabel(channel.integrationStatus.label)}</p>
                    <ExactChannelMessage channel={channel} />
                  </article>
                ))}
              </div>
              <p>
                Preview expires{' '}
                <time dateTime={preview.expiresAt}>
                  {TIME_FORMATTER.format(new Date(preview.expiresAt))}
                </time>
                . Counts describe eligible endpoints, not confirmed human
                receipt.
              </p>
            </section>

            {preview.activeEventIds.length > 0 ? (
              <section
                className="active-event-choice"
                aria-labelledby="active-event-heading"
              >
                <h2 id="active-event-heading">
                  An event is already active here
                </h2>
                <p>
                  Choose explicitly: join an existing event, or start a separate
                  event with another set of notification intents.
                </p>
                <div className="action-grid">
                  {resolvedActiveEvents.map((choice) => (
                    <button
                      className={`button join-choice join-choice--${choice.event.templateMode}`}
                      disabled={mutationPending || mutationUnknown}
                      key={choice.event.id}
                      type="button"
                      onClick={() => void join(choice)}
                    >
                      <ClassificationIcon mode={choice.event.templateMode} />
                      <span>
                        Join {choice.label} —{' '}
                        <strong>
                          {classificationLabel(choice.event.templateMode)}
                        </strong>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {preview.sendReadiness === 'blocked' ? (
              <section className="error-summary" role="alert">
                <h2>Notifications are not ready</h2>
                <p>The event cannot be started from this preview.</p>
                <ul>
                  {preview.blockingReasonCodes.map((reason) => (
                    <li key={reason}>{blockingReason(reason)}</li>
                  ))}
                </ul>
                <p>No event was started and no notification was queued.</p>
              </section>
            ) : (
              <section aria-labelledby="confirm-heading">
                <h2 id="confirm-heading">Confirm the consequence</h2>
                <p>
                  This will start a{' '}
                  {selection.templateMode === 'real' ? (
                    <strong>REAL INCIDENT</strong>
                  ) : (
                    <strong>DRILL — TRAINING ONLY</strong>
                  )}{' '}
                  at {selection.facilityName} and record notification intents
                  using the eligible endpoints shown above for an audience of{' '}
                  {preview.recipientCount} {audienceLabel(preview)}.
                </p>
                <button
                  className={`button ${
                    selection.templateMode === 'real'
                      ? 'button--real'
                      : 'button--drill'
                  }`}
                  disabled={mutationPending || mutationUnknown}
                  type="button"
                  onClick={() => void activate()}
                >
                  {mutationPending
                    ? 'Submitting once…'
                    : `${preview.activeEventIds.length > 0 ? 'Start a separate ' : 'Start '}${
                        selection.templateMode === 'real'
                          ? 'REAL incident'
                          : 'DRILL'
                      } and create notification intents for ${preview.recipientCount} selected ${audienceLabel(preview)}`}
                </button>
                <p className="supporting-text">
                  PSD EOC never queues this activation for an automatic retry.
                </p>
              </section>
            )}
          </>
        ) : null}

        {mutationError !== null ? (
          <section
            className="error-summary"
            ref={feedbackRef}
            role="alert"
            tabIndex={-1}
          >
            <h2>
              {mutationUnknown ? 'Outcome unknown' : 'Request not accepted'}
            </h2>
            <p>{mutationError}</p>
            <p>
              <Link href="/">Check the active-events dashboard</Link> before
              making another decision.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
