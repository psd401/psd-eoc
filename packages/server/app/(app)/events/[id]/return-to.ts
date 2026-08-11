import { EventIdSchema } from '@psd-eoc/contracts';

export type EventRoomSignInReason = 'session-expired' | 'session-required';

/** Builds the issue #76 return target only from a canonical event UUID. */
export function eventRoomSignInUrl(
  eventIdValue: string,
  reason: EventRoomSignInReason,
): string {
  const eventId = EventIdSchema.parse(eventIdValue);
  const query = new URLSearchParams({
    reason,
    returnTo: `/events/${encodeURIComponent(eventId)}`,
  });
  return `/login?${query.toString()}`;
}
