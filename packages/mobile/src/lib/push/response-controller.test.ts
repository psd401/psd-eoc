import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_NOTIFICATION_ACTION,
  PushResponseController,
  type PushNotificationResponseLike,
} from './response-controller';
import {
  authChangeRouteReadiness,
  committedAuthRouteReadiness,
} from './app-state-readiness';

const EVENT_ID = '00000000-0000-4000-8000-000000002311';
const OTHER_EVENT_ID = '00000000-0000-4000-8000-000000002312';

function response(
  identifier: string,
  eventId = EVENT_ID,
  overrides: Partial<PushNotificationResponseLike> = {},
): PushNotificationResponseLike {
  return {
    actionIdentifier: DEFAULT_NOTIFICATION_ACTION,
    notification: {
      request: {
        identifier,
        content: {
          title: '[DRILL] Synthetic drill',
          body: '[DRILL] Synthetic drill instructions.',
          data: {
            version: 1,
            eventId,
            eventKind: 'drill',
            templateMode: 'drill',
            facilityId: '00000000-0000-4000-8000-000000002313',
            eventTypeVersionId: '00000000-0000-4000-8000-000000002314',
            purpose: 'activation',
          },
        },
      },
    },
    ...overrides,
  };
}

describe('push response routing', () => {
  test('routes a locked DRILL tap to its exact event only after local authentication', () => {
    const routed: string[] = [];
    let drained = 0;
    const controller = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        drained += 1;
      },
    );

    expect(controller.receive(response('locked-drill-response'))).toBe(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(routed).toEqual([]);
    expect(drained).toBe(0);

    controller.setRouteReady(true);
    expect(routed).toEqual([EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(1);
  });

  test('reopens after every committed unlock revision and an offline-cached transition', () => {
    const routed: string[] = [];
    let drained = 0;
    const controller = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        drained += 1;
      },
    );
    const publishAuthState = () => {
      controller.setRouteReady(authChangeRouteReadiness());
    };
    const commitAuthState = (hasCachedShell: boolean) => {
      controller.setRouteReady(
        committedAuthRouteReadiness(hasCachedShell, 'active'),
      );
    };

    // Locked killed launch: the DRILL target waits for local authentication.
    commitAuthState(false);
    expect(controller.receive(response('locked-drill-sequence'))).toBe(true);
    expect(routed).toEqual([]);

    // Device authentication publishes cached-checking and then commits the
    // protected shell, which routes the exact retained target.
    publishAuthState();
    commitAuthState(true);
    expect(routed).toEqual([EVENT_ID]);
    expect(drained).toBe(1);

    // Refresh completion publishes online while hasCachedShell remains true.
    // Its distinct committed auth revision must reopen the synchronously closed
    // gate so a subsequent foreground tap routes immediately.
    publishAuthState();
    commitAuthState(true);
    expect(
      controller.receive(response('online-foreground', OTHER_EVENT_ID)),
    ).toBe(true);
    expect(routed).toEqual([EVENT_ID, OTHER_EVENT_ID]);
    expect(drained).toBe(2);

    // A network failure publishes offline-cached and closes before React
    // commits. A tap in that gap is retained, then the committed cached shell
    // reopens and routes it without requiring online mutation authority.
    publishAuthState();
    expect(controller.receive(response('offline-cached', EVENT_ID))).toBe(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(routed).toEqual([EVENT_ID, OTHER_EVENT_ID]);
    commitAuthState(true);
    expect(routed).toEqual([EVENT_ID, OTHER_EVENT_ID, EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(3);
  });

  test('retains two locked taps and navigates both in arrival order after unlock', () => {
    const routed: string[] = [];
    let drained = 0;
    const controller = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        drained += 1;
      },
    );

    expect(controller.receive(response('locked-first'))).toBe(true);
    expect(controller.receive(response('locked-second', OTHER_EVENT_ID))).toBe(
      true,
    );
    expect(routed).toEqual([]);
    expect(drained).toBe(0);

    controller.setRouteReady(true);
    expect(routed).toEqual([EVENT_ID, OTHER_EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(1);
  });

  test('keeps killed-launch evidence recoverable across a pre-unlock restart', () => {
    let nativeLastResponseClears = 0;
    const firstProcess = new PushResponseController(
      () => {
        throw new Error('locked process must not navigate');
      },
      () => {
        nativeLastResponseClears += 1;
      },
    );
    const killedResponse = response('killed-restart');

    expect(firstProcess.receive(killedResponse)).toBe(true);
    expect(firstProcess.hasPendingRoute()).toBe(true);
    expect(nativeLastResponseClears).toBe(0);

    const routed: string[] = [];
    const restartedProcess = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        nativeLastResponseClears += 1;
      },
    );
    expect(restartedProcess.receive(killedResponse)).toBe(true);
    expect(nativeLastResponseClears).toBe(0);
    restartedProcess.setRouteReady(true);

    expect(routed).toEqual([EVENT_ID]);
    expect(nativeLastResponseClears).toBe(1);
  });

  test('routes foreground/background taps once to the exact canonical event', () => {
    const routed: string[] = [];
    const controller = new PushResponseController((payload) =>
      routed.push(payload.eventId),
    );
    controller.setRouteReady(true);

    const tapped = response('background-response', OTHER_EVENT_ID);
    expect(controller.receive(tapped)).toBe(true);
    expect(controller.receive(tapped)).toBe(false);
    expect(routed).toEqual([OTHER_EVENT_ID]);
  });

  test('ignores custom actions, malformed data, and confused visible classification', () => {
    const routed: string[] = [];
    const controller = new PushResponseController((payload) =>
      routed.push(payload.eventId),
    );
    controller.setRouteReady(true);

    expect(
      controller.receive(
        response('custom-action', EVENT_ID, {
          actionIdentifier: 'untrusted-custom-action',
        }),
      ),
    ).toBe(false);
    const malformed = response('malformed');
    expect(
      controller.receive({
        ...malformed,
        notification: {
          request: {
            ...malformed.notification.request,
            content: {
              ...malformed.notification.request.content,
              data: { eventId: EVENT_ID },
            },
          },
        },
      }),
    ).toBe(false);
    const confused = response('confused');
    expect(
      controller.receive({
        ...confused,
        notification: {
          request: {
            ...confused.notification.request,
            content: {
              ...confused.notification.request.content,
              title: '[INCIDENT] Incorrect drill title',
            },
          },
        },
      }),
    ).toBe(false);
    expect(routed).toEqual([]);
  });

  test('retains a pending route if the router temporarily rejects navigation', () => {
    let attempts = 0;
    let drained = 0;
    const controller = new PushResponseController(
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error('router not mounted');
      },
      () => {
        drained += 1;
      },
    );

    expect(controller.receive(response('router-race'))).toBe(true);
    controller.setRouteReady(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(drained).toBe(0);
    controller.setRouteReady(true);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(attempts).toBe(2);
    expect(drained).toBe(1);
  });

  test('does not consume native evidence when auth closes before the readiness effect', () => {
    const routed: string[] = [];
    let drained = 0;
    let protectedShellReady = true;
    const controller = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        drained += 1;
      },
      () => protectedShellReady,
    );
    controller.setRouteReady(true);

    // Models the synchronous auth source changing before React commits the
    // corresponding setRouteReady(false) layout effect.
    protectedShellReady = false;
    expect(controller.receive(response('auth-loss-race'))).toBe(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(routed).toEqual([]);
    expect(drained).toBe(0);

    controller.setRouteReady(false);
    protectedShellReady = true;
    controller.setRouteReady(true);
    expect(routed).toEqual([EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(1);
  });

  test('replays the exact target when auth closes during router push without accepting a duplicate response', () => {
    const routingAttempts: string[] = [];
    let drained = 0;
    const controller = new PushResponseController(
      (payload) => {
        routingAttempts.push(payload.eventId);
        if (routingAttempts.length === 1) {
          // Models the synchronous auth subscription closing Stack.Protected
          // after router.push but before this target is stably consumed.
          controller.setRouteReady(false);
        }
      },
      () => {
        drained += 1;
      },
    );
    controller.setRouteReady(true);

    const tapped = response('navigation-auth-race', OTHER_EVENT_ID);
    expect(controller.receive(tapped)).toBe(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(routingAttempts).toEqual([OTHER_EVENT_ID]);
    expect(drained).toBe(0);
    // The same native evidence may arrive from both the listener and getLast.
    // It must not enqueue a second copy while the original exact target waits.
    expect(controller.receive(tapped)).toBe(false);

    controller.setRouteReady(true);
    expect(routingAttempts).toEqual([OTHER_EVENT_ID, OTHER_EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(1);
  });

  test('a synchronous background close queues the tap until a fresh unlock', () => {
    const routed: string[] = [];
    let drained = 0;
    const controller = new PushResponseController(
      (payload) => routed.push(payload.eventId),
      () => {
        drained += 1;
      },
    );
    controller.setRouteReady(true);

    // The AppState callback closes routing before React can be suspended.
    controller.setRouteReady(false);
    expect(controller.receive(response('background-race'))).toBe(true);
    expect(controller.hasPendingRoute()).toBe(true);
    expect(routed).toEqual([]);
    expect(drained).toBe(0);

    controller.setRouteReady(true);
    expect(routed).toEqual([EVENT_ID]);
    expect(controller.hasPendingRoute()).toBe(false);
    expect(drained).toBe(1);
  });
});
