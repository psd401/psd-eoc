import type { DispatchBatch } from '@psd-eoc/contracts';
import { and, eq } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { events, eventTransitions } from '../../db/schema';

/**
 * Row lock taken on the event while its lifecycle is read. `share` is the
 * email store's authorization read, which must not race a concurrent
 * transition; `no key update` is its batch resolution; `null` reads without
 * locking, as the SMS store always has.
 */
export type BatchLifecycleLock = 'share' | 'no key update' | null;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Whether a dispatch batch still describes the event's current lifecycle,
 * so that a queued send is still the send a human confirmed.
 *
 * An activation is current while the event is active and has not been
 * cleared or reactivated since, under the same authorization. A lifecycle
 * batch (all-clear or reactivation) is current while the transition it was
 * confirmed for is the event's latest of that kind, under the same request
 * and authorization.
 *
 * An all-clear stays current after the event is closed. Ending an event
 * from the event room issues the all-clear and closes the event in the same
 * breath, one second apart in production, and the close carries no
 * notification of its own: the all-clear is the message staff are told the
 * event ended by. Requiring the event to still be in `all-clear` refused
 * every SMS all-clear sent that way (2026-09-08, events 59de5613 and
 * 5c17f59c), and the email store's older rule, which required an active
 * event for every batch, refused every all-clear email ever queued, while
 * push carried the same message without either check.
 */
export async function batchHasCurrentLifecycle(
  database: Database,
  batch: DispatchBatch,
  lock: BatchLifecycleLock = null,
): Promise<boolean> {
  const eventQuery = database
    .select({
      status: events.status,
      allClearAt: events.allClearAt,
      reactivatedAt: events.reactivatedAt,
      activationAuthorization: events.activationAuthorization,
    })
    .from(events)
    .where(eq(events.id, batch.eventId))
    .limit(1);
  const [event] = await (lock === null ? eventQuery : eventQuery.for(lock));
  if (event === undefined) return false;
  if (batch.purpose === 'activation') {
    return (
      event.status === 'active' &&
      event.allClearAt === null &&
      event.reactivatedAt === null &&
      sameJson(event.activationAuthorization, batch.authorization)
    );
  }
  const authorization = batch.authorization;
  if (
    !('transitionId' in authorization) ||
    authorization.purpose !== batch.purpose
  ) {
    return false;
  }
  const [transition] = await database
    .select({
      transition: eventTransitions.transition,
      occurredAt: eventTransitions.occurredAt,
      requestId: eventTransitions.requestId,
      notificationAuthorization: eventTransitions.notificationAuthorization,
    })
    .from(eventTransitions)
    .where(
      and(
        eq(eventTransitions.id, authorization.transitionId),
        eq(eventTransitions.eventId, batch.eventId),
      ),
    )
    .limit(1);
  const expectedTransition =
    batch.purpose === 'all-clear' ? 'all-clear' : 'reactivate';
  const currentOccurredAt =
    batch.purpose === 'all-clear' ? event.allClearAt : event.reactivatedAt;
  const statusIsCurrent =
    batch.purpose === 'all-clear'
      ? event.status === 'all-clear' || event.status === 'closed'
      : event.status === 'active';
  return (
    statusIsCurrent &&
    transition?.transition === expectedTransition &&
    currentOccurredAt?.getTime() === transition.occurredAt.getTime() &&
    transition.requestId === batch.requestId &&
    sameJson(transition.notificationAuthorization, authorization)
  );
}
