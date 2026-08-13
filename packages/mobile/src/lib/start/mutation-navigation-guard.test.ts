import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface NavigationAction {
  readonly payload?: unknown;
  readonly type: string;
}

interface PreventRegistration {
  readonly callback: (options: {
    readonly data: { readonly action: NavigationAction };
  }) => void;
  readonly preventRemove: boolean;
}

const registrations: PreventRegistration[] = [];

mock.module('expo-router/react-navigation', () => ({
  usePreventRemove: (
    preventRemove: boolean,
    callback: PreventRegistration['callback'],
  ) => {
    registrations.push({ callback, preventRemove });
  },
}));

const {
  PENDING_START_MUTATION_MESSAGE,
  isStartMutationPending,
  requestStartRouteNavigation,
  subscribeToStartMutationHardwareBack,
  useStartMutationNavigationGuard,
} = await import('./mutation-navigation-guard');

function GuardHarness({
  announce,
  pending,
}: {
  readonly announce: (message: string) => void;
  readonly pending: boolean;
}): null {
  useStartMutationNavigationGuard(pending, announce);
  return null;
}

beforeEach(() => {
  registrations.length = 0;
});

describe('start mutation navigation guard', () => {
  test('registers the route guard for both activation and join requests', () => {
    for (const pendingAction of [
      'activate',
      '71000000-0000-4000-8000-000000000013',
    ]) {
      registrations.length = 0;
      GuardHarness({
        announce: () => {},
        pending: isStartMutationPending(pendingAction),
      });
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.preventRemove).toBe(true);
    }
    expect(isStartMutationPending(null)).toBe(false);
  });

  test('blocks explicit Back and forward navigation throughout either mutation', () => {
    for (const pendingAction of [
      'activate',
      '71000000-0000-4000-8000-000000000013',
    ]) {
      const announcements: string[] = [];
      let navigationCount = 0;
      const allowed = requestStartRouteNavigation(
        isStartMutationPending(pendingAction),
        () => {
          navigationCount += 1;
        },
        (message) => {
          announcements.push(message);
        },
      );

      expect(allowed).toBe(false);
      expect(navigationCount).toBe(0);
      expect(announcements).toEqual([PENDING_START_MUTATION_MESSAGE]);
    }
  });

  test('prevents Android Back and iOS native-pop route removals without redispatch', () => {
    const announcements: string[] = [];
    GuardHarness({
      announce: (message) => {
        announcements.push(message);
      },
      pending: true,
    });
    const registration = registrations[0];
    if (registration === undefined) {
      throw new Error('The pending route guard was not registered.');
    }

    expect(() =>
      registration.callback({ data: { action: { type: 'GO_BACK' } } }),
    ).not.toThrow();
    expect(() =>
      registration.callback({
        data: { action: { payload: { count: 1 }, type: 'POP' } },
      }),
    ).not.toThrow();

    expect(announcements).toEqual([
      PENDING_START_MUTATION_MESSAGE,
      PENDING_START_MUTATION_MESSAGE,
    ]);
  });

  test('consumes root-screen Android Back only while a request is pending', () => {
    const announcements: string[] = [];
    let listener: (() => boolean) | undefined;
    let removeCount = 0;
    let subscribeCount = 0;
    const subscribe = (
      eventName: 'hardwareBackPress',
      handler: () => boolean,
    ) => {
      expect(eventName).toBe('hardwareBackPress');
      subscribeCount += 1;
      listener = handler;
      return {
        remove: () => {
          removeCount += 1;
        },
      };
    };

    let pending = false;
    const unsubscribe = subscribeToStartMutationHardwareBack(
      () => pending,
      (message) => {
        announcements.push(message);
      },
      subscribe,
    );
    expect(subscribeCount).toBe(1);
    expect(listener?.()).toBe(false);
    expect(announcements).toEqual([]);

    pending = true;
    expect(listener?.()).toBe(true);
    expect(announcements).toEqual([PENDING_START_MUTATION_MESSAGE]);

    unsubscribe?.();
    expect(removeCount).toBe(1);
  });

  test('releases navigation only after the request settles', () => {
    let navigationCount = 0;
    GuardHarness({ announce: () => {}, pending: false });
    expect(registrations[0]?.preventRemove).toBe(false);

    expect(
      requestStartRouteNavigation(
        false,
        () => {
          navigationCount += 1;
        },
        () => {},
      ),
    ).toBe(true);
    expect(navigationCount).toBe(1);
  });

  test('keeps navigation blocked if accessibility feedback throws', () => {
    GuardHarness({
      announce: () => {
        throw new Error('synthetic announcement failure');
      },
      pending: true,
    });
    const registration = registrations[0];
    if (registration === undefined) {
      throw new Error('The pending route guard was not registered.');
    }

    expect(() =>
      registration.callback({ data: { action: { type: 'GO_BACK' } } }),
    ).not.toThrow();
    expect(
      requestStartRouteNavigation(
        true,
        () => {
          throw new Error('Navigation must not run.');
        },
        () => {
          throw new Error('synthetic announcement failure');
        },
      ),
    ).toBe(false);

    let listener: (() => boolean) | undefined;
    subscribeToStartMutationHardwareBack(
      () => true,
      () => {
        throw new Error('synthetic announcement failure');
      },
      (_eventName, handler) => {
        listener = handler;
        return { remove: () => {} };
      },
    );
    expect(() => listener?.()).not.toThrow();
    expect(listener?.()).toBe(true);
  });
});
