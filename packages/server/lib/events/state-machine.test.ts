import { describe, expect, test } from 'bun:test';

import type { EventStatus, EventTransitionKind } from '@psd-eoc/contracts';

import {
  canTransitionEventStatus,
  EVENT_STATUS_TRANSITIONS,
  EVENT_TRANSITION_NOT_ALLOWED,
  EventStateTransitionError,
  transitionEventStatus,
} from './state-machine';

const eventStatuses = [
  'draft',
  'active',
  'all-clear',
  'closed',
] as const satisfies readonly EventStatus[];

const eventTransitions = [
  'activate',
  'all-clear',
  'reactivate',
  'close',
  'reopen-as-correction',
] as const satisfies readonly EventTransitionKind[];

const expectedTransitions = {
  activate: { from: 'draft', to: 'active' },
  'all-clear': { from: 'active', to: 'all-clear' },
  reactivate: { from: 'all-clear', to: 'active' },
  close: { from: 'all-clear', to: 'closed' },
  'reopen-as-correction': { from: 'closed', to: 'draft' },
} as const satisfies Readonly<
  Record<EventTransitionKind, Readonly<{ from: EventStatus; to: EventStatus }>>
>;

describe('event lifecycle state machine', () => {
  for (const currentStatus of eventStatuses) {
    for (const transition of eventTransitions) {
      const rule = expectedTransitions[transition];
      const allowed = rule.from === currentStatus;

      test(`${currentStatus} + ${transition} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(canTransitionEventStatus(currentStatus, transition)).toBe(
          allowed,
        );

        if (allowed) {
          expect(transitionEventStatus(currentStatus, transition)).toBe(
            rule.to,
          );
          return;
        }

        try {
          transitionEventStatus(currentStatus, transition);
          throw new Error('Expected an invalid event transition to fail.');
        } catch (error) {
          expect(error).toBeInstanceOf(EventStateTransitionError);
          if (!(error instanceof EventStateTransitionError)) {
            throw error;
          }
          expect(error).toMatchObject({
            name: 'EventStateTransitionError',
            code: EVENT_TRANSITION_NOT_ALLOWED,
            currentStatus,
            transition,
            message:
              'Event transition is not allowed from the current event status.',
          });
        }
      });
    }
  }

  test('supports repeated all-clear/reactivation cycles and correction reopening', () => {
    const transitions = [
      'activate',
      'all-clear',
      'reactivate',
      'all-clear',
      'reactivate',
      'all-clear',
      'close',
      'reopen-as-correction',
      'activate',
    ] as const satisfies readonly EventTransitionKind[];
    const expectedStatuses = [
      'active',
      'all-clear',
      'active',
      'all-clear',
      'active',
      'all-clear',
      'closed',
      'draft',
      'active',
    ] as const satisfies readonly EventStatus[];

    let status: EventStatus = 'draft';
    const actualStatuses = transitions.map((transition) => {
      status = transitionEventStatus(status, transition);
      return status;
    });

    expect(actualStatuses).toEqual([...expectedStatuses]);
  });

  test('publishes an immutable canonical transition table', () => {
    expect(EVENT_STATUS_TRANSITIONS).toEqual(expectedTransitions);
    expect(Object.isFrozen(EVENT_STATUS_TRANSITIONS)).toBe(true);
    for (const transition of eventTransitions) {
      expect(Object.isFrozen(EVENT_STATUS_TRANSITIONS[transition])).toBe(true);
    }
  });
});
