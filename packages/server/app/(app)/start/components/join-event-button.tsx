'use client';

import { JoinEventResultSchema, type Event } from '@psd-eoc/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  StartFlowRequestError,
  requestStartFlow,
  requireMatchingActiveJoinedEvent,
} from '../_lib/client-request';
import { ClassificationIcon } from './classification-icon';

interface JoinEventButtonProps {
  readonly csrfCookieName: string;
  readonly event: Event;
  readonly label: string;
}

export function JoinEventButton({
  csrfCookieName,
  event,
  label,
}: JoinEventButtonProps) {
  const idempotencyKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState(false);
  const [joinedEventId, setJoinedEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);

  useEffect(() => {
    if (joinedEventId !== null || error !== null) {
      feedbackRef.current?.focus();
    }
  }, [error, joinedEventId]);

  async function join() {
    if (inFlight.current || joinedEventId !== null || outcomeUnknown) return;
    inFlight.current = true;
    idempotencyKey.current ??= `join:${crypto.randomUUID()}`;
    setPending(true);
    setError(null);
    setOutcomeUnknown(false);
    try {
      const joined = await requestStartFlow(
        '/start/api/join',
        { eventId: event.id },
        csrfCookieName,
        JoinEventResultSchema,
        idempotencyKey.current,
      );
      const matchingEvent = requireMatchingActiveJoinedEvent(
        joined.event,
        event,
      );
      setJoinedEventId(matchingEvent.id);
    } catch (caught) {
      setOutcomeUnknown(
        caught instanceof StartFlowRequestError && caught.outcomeUnknown,
      );
      setError(
        caught instanceof Error ? caught.message : 'The event was not joined.',
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (joinedEventId !== null) {
    return (
      <p
        className="status-message"
        ref={feedbackRef}
        role="status"
        tabIndex={-1}
      >
        {event.templateMode === 'real'
          ? 'REAL INCIDENT'
          : 'DRILL — TRAINING ONLY'}{' '}
        event joined. <Link href={`/events/${joinedEventId}`}>Open event</Link>
      </p>
    );
  }

  return (
    <div>
      <button
        className="button button--secondary"
        disabled={pending || outcomeUnknown}
        type="button"
        onClick={() => void join()}
      >
        <ClassificationIcon mode={event.templateMode} />
        {pending
          ? `Joining ${event.templateMode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY'} once…`
          : `Join ${label}`}
      </button>
      {error === null ? null : (
        <p
          className="status-message"
          ref={feedbackRef}
          role="alert"
          tabIndex={-1}
        >
          <strong>
            {outcomeUnknown ? 'Outcome unknown.' : 'Join not accepted.'}
          </strong>{' '}
          {error} Check the dashboard before trying again.
        </p>
      )}
    </div>
  );
}
