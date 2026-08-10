'use client';

import { JoinEventResultSchema } from '@psd-eoc/contracts';
import Link from 'next/link';
import { useRef, useState } from 'react';

import { requestStartFlow } from '../_lib/client-request';

interface JoinEventButtonProps {
  readonly csrfCookieName: string;
  readonly eventId: string;
  readonly label: string;
}

export function JoinEventButton({
  csrfCookieName,
  eventId,
  label,
}: JoinEventButtonProps) {
  const idempotencyKey = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    if (pending || joined) return;
    idempotencyKey.current ??= `join:${crypto.randomUUID()}`;
    setPending(true);
    setError(null);
    try {
      await requestStartFlow(
        '/start/api/join',
        { eventId },
        csrfCookieName,
        JoinEventResultSchema,
        idempotencyKey.current,
      );
      setJoined(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The event was not joined.',
      );
    } finally {
      setPending(false);
    }
  }

  if (joined) {
    return (
      <p className="status-message" role="status">
        Event joined. <Link href={`/events/${eventId}`}>Open event</Link>
      </p>
    );
  }

  return (
    <div>
      <button
        className="button button--secondary"
        disabled={pending}
        type="button"
        onClick={() => void join()}
      >
        {pending ? 'Joining once…' : `Join ${label}`}
      </button>
      {error === null ? null : (
        <p className="status-message" role="alert">
          {error} Check the dashboard before trying again.
        </p>
      )}
    </div>
  );
}
