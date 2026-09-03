'use client';

import {
  ActivationPreviewSchema,
  getEventClassificationPresentation,
  JoinEventResultSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type Event,
  type EventKind,
  type TemplateMode,
} from '@psd-eoc/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  StartFlowRequestError,
  requestActiveEvent,
  requestStartFlow,
  requireMatchingActiveJoinedEvent,
  requireMatchingActivationResult,
} from '../_lib/client-request';
import { ClassificationBanner } from './classification-banner';
import { ClassificationIcon } from './classification-icon';
import { blockingReasonSentence } from '../../../../lib/events/blocking-reasons';

export interface ConfirmedSelection {
  readonly eventKind: Extract<EventKind, 'incident' | 'drill'>;
  readonly eventTypeName: string;
  readonly eventTypeVersionId: string;
  readonly facilityId: string;
  readonly facilityName: string;
  /** The operator's words for an "Other" response, when one was required. */
  readonly responseDetail: string | null;
  readonly templateMode: TemplateMode;
  /** The operator's words for an "Other" threat, when one was required. */
  readonly threatDetail: string | null;
  readonly threatId: string;
  readonly threatName: string;
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
      eventKind: EventKind;
      eventId: string;
      eventTypeName: string;
      templateMode: TemplateMode;
    }>
  | Readonly<{
      kind: 'joined';
      eventKind: EventKind;
      eventId: string;
      eventTypeName: string;
      templateMode: TemplateMode;
    }>;

type ResolvedActiveEventChoice = ActiveEventChoice;

type MutationOperation =
  | Readonly<{
      kind: 'activate';
      eventKind: EventKind;
      templateMode: TemplateMode;
    }>
  | Readonly<{
      eventId: string;
      eventKind: EventKind;
      eventTypeName: string;
      kind: 'join';
      templateMode: TemplateMode;
    }>;

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

function notifiedByLabel(preview: ActivationPreview): string {
  const names = preview.channels.map((channel) =>
    channelName(channel.channel).toLowerCase(),
  );
  if (names.length === 0) return 'no channel';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function audienceLabel(preview: ActivationPreview): string {
  return preview.rosterPopulation === 'staff'
    ? 'staff recipients'
    : 'synthetic recipients';
}

function classificationLabel(eventKind: EventKind, mode: TemplateMode): string {
  return getEventClassificationPresentation({
    kind: eventKind,
    templateMode: mode,
  }).label;
}

function shortEventId(eventId: string): string {
  return eventId.slice(-8);
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
  eventKind,
  eventTypeName,
  facilityName,
  responseDetail,
  templateMode,
  threatDetail,
  threatName,
}: Readonly<{
  eventKind: EventKind;
  eventTypeName: string;
  facilityName: string;
  responseDetail: string | null;
  templateMode: TemplateMode;
  threatDetail: string | null;
  threatName: string;
}>) {
  return (
    <section className="panel" aria-labelledby="selection-heading">
      <h2 id="selection-heading">Selected event</h2>
      <dl className="facts">
        <dt>Facility</dt>
        <dd>{facilityName}</dd>
        <dt>Threat</dt>
        <dd>
          {threatName}
          {threatDetail === null ? null : ` — ${threatDetail}`}
        </dd>
        <dt>Response</dt>
        <dd>
          {eventTypeName}
          {responseDetail === null ? null : ` — ${responseDetail}`}
        </dd>
        <dt>Classification</dt>
        <dd>
          <span
            className={`classification-label classification-label--${templateMode}`}
          >
            <ClassificationIcon kind={eventKind} mode={templateMode} />{' '}
            {classificationLabel(eventKind, templateMode)}
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
    preview.rosterPopulation !== 'staff' ||
    preview.threat === null ||
    preview.threat.id !== selection.threatId ||
    preview.threat.detail !== selection.threatDetail ||
    preview.responseDetail !== selection.responseDetail
  ) {
    throw new StartFlowRequestError(
      'PSD EOC checked a different event than the one you selected. No event was started and nothing was sent.',
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
  const [pendingOperation, setPendingOperation] =
    useState<MutationOperation | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [failedOperation, setFailedOperation] =
    useState<MutationOperation | null>(null);
  const [mutationUnknown, setMutationUnknown] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const previewStatusRef = useRef<HTMLParagraphElement>(null);
  const focusPreviewStatusOnRetry = useRef(false);
  const mutationInFlight = useRef(false);
  const joinIdempotencyKeys = useRef(new Map<string, string>());
  const mutationPending = pendingOperation !== null;
  const router = useRouter();

  // Starting or joining an event puts the operator in the event room, ready to
  // post. An interstitial between the two is one more click during the minute
  // that matters most.
  useEffect(() => {
    if (result === null) return;
    router.replace(`/events/${result.eventId}`);
  }, [result, router]);

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
          threatId: selection.threatId,
          threatDetail: selection.threatDetail,
          responseDetail: selection.responseDetail,
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
            : 'PSD EOC could not check who would be notified.',
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
    selection.responseDetail,
    selection.templateMode,
    selection.threatDetail,
    selection.threatId,
  ]);

  useEffect(() => {
    if (mutationError !== null || result !== null) {
      feedbackRef.current?.focus();
    }
  }, [mutationError, result]);

  useEffect(() => {
    if (previewLoading && focusPreviewStatusOnRetry.current) {
      focusPreviewStatusOnRetry.current = false;
      previewStatusRef.current?.focus();
    }
  }, [previewLoading]);

  function retryPreview() {
    focusPreviewStatusOnRetry.current = true;
    setPreviewAttempt((attempt) => attempt + 1);
  }

  async function activate() {
    if (
      preview === null ||
      preview.sendReadiness !== 'ready' ||
      mutationInFlight.current ||
      mutationUnknown ||
      result !== null
    ) {
      return;
    }
    const operation: MutationOperation = {
      eventKind: selection.eventKind,
      kind: 'activate',
      templateMode: selection.templateMode,
    };
    mutationInFlight.current = true;
    setPendingOperation(operation);
    setMutationError(null);
    setFailedOperation(null);
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
      const event = requireMatchingActivationResult(
        activated,
        preview,
        selection,
      );
      setResult({
        eventKind: event.kind,
        kind: 'activated',
        eventId: event.id,
        eventTypeName: selection.eventTypeName,
        templateMode: event.templateMode,
      });
    } catch (error) {
      setFailedOperation(operation);
      setMutationUnknown(
        error instanceof StartFlowRequestError && error.outcomeUnknown,
      );
      setMutationError(
        error instanceof Error
          ? error.message
          : 'The activation was not accepted.',
      );
    } finally {
      mutationInFlight.current = false;
      setPendingOperation(null);
    }
  }

  async function join(choice: ResolvedActiveEventChoice) {
    if (mutationInFlight.current || result !== null) return;
    const operation: MutationOperation = {
      eventId: choice.event.id,
      eventKind: choice.event.kind,
      eventTypeName: choice.label,
      kind: 'join',
      templateMode: choice.event.templateMode,
    };
    mutationInFlight.current = true;
    setPendingOperation(operation);
    setMutationError(null);
    setFailedOperation(null);
    setMutationUnknown(false);
    try {
      let idempotencyKey = joinIdempotencyKeys.current.get(choice.event.id);
      if (idempotencyKey === undefined) {
        idempotencyKey = `join:${crypto.randomUUID()}`;
        joinIdempotencyKeys.current.set(choice.event.id, idempotencyKey);
      }
      const joined = await requestStartFlow(
        '/start/api/join',
        { eventId: choice.event.id },
        csrfCookieName,
        JoinEventResultSchema,
        idempotencyKey,
      );
      const event = requireMatchingActiveJoinedEvent(
        joined.event,
        choice.event,
      );
      setResult({
        eventKind: event.kind,
        kind: 'joined',
        eventId: event.id,
        eventTypeName: choice.label,
        templateMode: event.templateMode,
      });
    } catch (error) {
      setFailedOperation(operation);
      setMutationUnknown(
        error instanceof StartFlowRequestError && error.outcomeUnknown,
      );
      setMutationError(
        error instanceof Error ? error.message : 'The event was not joined.',
      );
    } finally {
      mutationInFlight.current = false;
      setPendingOperation(null);
    }
  }

  if (result !== null) {
    return (
      <div>
        <ClassificationBanner
          kind={result.eventKind}
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
          <p role="status">Opening the event room…</p>
          <p>
            <Link className="button" href={`/events/${result.eventId}`}>
              Open event
            </Link>
          </p>
        </section>
      </div>
    );
  }

  return (
    <div>
      <ClassificationBanner
        kind={selection.eventKind}
        mode={selection.templateMode}
        detail={
          selection.templateMode === 'real'
            ? 'Final confirmation starts a real incident and creates real staff-notification intents only when integrations are live-verified.'
            : 'Final confirmation starts a training drill. Every resulting event and message remains marked DRILL.'
        }
      />

      <SelectedEventSummary
        eventKind={selection.eventKind}
        eventTypeName={selection.eventTypeName}
        facilityName={selection.facilityName}
        responseDetail={selection.responseDetail}
        templateMode={selection.templateMode}
        threatDetail={selection.threatDetail}
        threatName={selection.threatName}
      />

      <div aria-busy={previewLoading} className="consequence-preview">
        <p
          aria-atomic="true"
          aria-live="polite"
          className="status-message"
          ref={previewStatusRef}
          role="status"
          tabIndex={-1}
        >
          {previewLoading
            ? 'Checking who will be notified…'
            : previewError !== null || preview === null
              ? 'PSD EOC could not check who will be notified.'
              : preview.sendReadiness === 'ready'
                ? `Ready to start. ${preview.recipientCount} ${audienceLabel(preview)} will be notified by ${notifiedByLabel(preview)}.`
                : 'Notifications are not ready, so this event cannot be started yet.'}
        </p>

        {previewError !== null ? (
          <section className="error-summary" role="alert">
            <h2>Could not check who will be notified</h2>
            <p>{previewError}</p>
            <p>No event was started and no notification was queued.</p>
            <button
              className="button button--secondary"
              type="button"
              onClick={retryPreview}
            >
              Try again
            </button>
          </section>
        ) : null}

        {preview !== null ? (
          <>
            <section aria-labelledby="audience-heading">
              <h2 id="audience-heading">Who gets notified</h2>
              <p>
                <strong>
                  {preview.recipientCount} {audienceLabel(preview)}
                </strong>{' '}
                at {selection.facilityName}, by {notifiedByLabel(preview)}.
              </p>
              <details className="message-preview">
                <summary>See the exact message</summary>
                <div className="channel-grid">
                  {preview.channels.map((channel) => (
                    <article className="channel-card" key={channel.channel}>
                      <h3>{channelName(channel.channel)}</h3>
                      <p>
                        <strong>{channel.endpointCount}</strong> recipient
                        {channel.endpointCount === 1 ? '' : 's'} —{' '}
                        {integrationLabel(channel.integrationStatus.label)}
                      </p>
                      <ExactChannelMessage channel={channel} />
                    </article>
                  ))}
                </div>
              </details>
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
                  {resolvedActiveEvents.map((choice) => {
                    const joiningThisEvent =
                      pendingOperation?.kind === 'join' &&
                      pendingOperation.eventId === choice.event.id;
                    const eventTime =
                      choice.event.activatedAt ?? choice.event.createdAt;
                    return (
                      <button
                        className={`button join-choice join-choice--${choice.event.templateMode}`}
                        disabled={mutationPending || mutationUnknown}
                        key={choice.event.id}
                        type="button"
                        onClick={() => void join(choice)}
                      >
                        <ClassificationIcon
                          kind={choice.event.kind}
                          mode={choice.event.templateMode}
                        />
                        <span>
                          {joiningThisEvent ? (
                            `Joining ${classificationLabel(choice.event.kind, choice.event.templateMode)} once…`
                          ) : (
                            <>
                              Join {choice.label} —{' '}
                              <strong>
                                {classificationLabel(
                                  choice.event.kind,
                                  choice.event.templateMode,
                                )}
                              </strong>
                            </>
                          )}
                          <span className="join-choice__detail">
                            Started{' '}
                            <time dateTime={eventTime}>
                              {TIME_FORMATTER.format(new Date(eventTime))}
                            </time>{' '}
                            — event {shortEventId(choice.event.id)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {preview.sendReadiness === 'blocked' ? (
              <section className="error-summary" role="alert">
                <h2>Notifications are not ready</h2>
                <p>The event cannot be started from this preview.</p>
                {preview.blockingReasonCodes.length > 0 ? (
                  <ul>
                    {preview.blockingReasonCodes.map((code) => (
                      <li key={code}>{blockingReasonSentence(code)}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    One or more server prerequisites are unavailable. Refresh
                    the preview; if it remains blocked, contact an
                    administrator.
                  </p>
                )}
                <p>No event was started and no notification was queued.</p>
              </section>
            ) : (
              <section aria-labelledby="confirm-heading">
                <h2 id="confirm-heading">
                  Start this{' '}
                  {selection.templateMode === 'real' ? 'incident' : 'drill'}
                </h2>
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
                  {pendingOperation?.kind === 'activate'
                    ? `Starting ${classificationLabel(selection.eventKind, selection.templateMode)} ${selection.eventTypeName} at ${selection.facilityName} once…`
                    : `${preview.activeEventIds.length > 0 ? 'Start a separate ' : 'Start '}${
                        selection.templateMode === 'real'
                          ? 'REAL incident'
                          : 'DRILL'
                      } and notify ${preview.recipientCount} ${audienceLabel(preview)}`}
                </button>
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
            {failedOperation === null ? null : (
              <p>
                <strong>Attempted action:</strong>{' '}
                {failedOperation.kind === 'activate'
                  ? `Start ${classificationLabel(failedOperation.eventKind, failedOperation.templateMode)} event ${selection.eventTypeName}`
                  : `Join ${classificationLabel(failedOperation.eventKind, failedOperation.templateMode)} event ${failedOperation.eventTypeName} — event ${shortEventId(failedOperation.eventId)}`}
                .
              </p>
            )}
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
