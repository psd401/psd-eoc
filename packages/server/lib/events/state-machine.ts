import type { EventStatus, EventTransitionKind } from '@psd-eoc/contracts';

/** Safe client- and audit-facing reason for a rejected lifecycle transition. */
export const EVENT_TRANSITION_NOT_ALLOWED =
  'EVENT_TRANSITION_NOT_ALLOWED' as const;

/** The canonical source and destination for every event lifecycle action. */
export const EVENT_STATUS_TRANSITIONS = Object.freeze({
  activate: Object.freeze({ from: 'draft', to: 'active' }),
  'all-clear': Object.freeze({ from: 'active', to: 'all-clear' }),
  reactivate: Object.freeze({ from: 'all-clear', to: 'active' }),
  close: Object.freeze({ from: 'all-clear', to: 'closed' }),
  'reopen-as-correction': Object.freeze({ from: 'closed', to: 'draft' }),
}) satisfies Readonly<
  Record<EventTransitionKind, Readonly<{ from: EventStatus; to: EventStatus }>>
>;

/** Typed denial that exposes only bounded lifecycle enum values. */
export class EventStateTransitionError extends Error {
  public readonly code = EVENT_TRANSITION_NOT_ALLOWED;

  public constructor(
    public readonly currentStatus: EventStatus,
    public readonly transition: EventTransitionKind,
  ) {
    super('Event transition is not allowed from the current event status.');
    this.name = 'EventStateTransitionError';
  }
}

/** Returns whether a lifecycle action is valid from the current event state. */
export function canTransitionEventStatus(
  currentStatus: EventStatus,
  transition: EventTransitionKind,
): boolean {
  return EVENT_STATUS_TRANSITIONS[transition].from === currentStatus;
}

/** Applies one valid event lifecycle action or throws a typed safe denial. */
export function transitionEventStatus(
  currentStatus: EventStatus,
  transition: EventTransitionKind,
): EventStatus {
  const rule = EVENT_STATUS_TRANSITIONS[transition];
  if (rule.from !== currentStatus) {
    throw new EventStateTransitionError(currentStatus, transition);
  }
  return rule.to;
}
