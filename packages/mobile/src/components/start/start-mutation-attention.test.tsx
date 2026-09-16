import { describe, expect, mock, test } from 'bun:test';

import type { ReactElement, ReactNode } from 'react';

mock.module('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: () => {},
  },
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: async () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <Styles,>(styles: Styles): Styles => styles,
  },
  Text: 'Text',
  View: 'View',
}));

const { ClassificationBanner } = await import('../classification-banner');
const { Call911Affordance } = await import('./call-911-affordance');
const {
  OtherSessionStartMutationAttention,
  StartMutationAttentionContent,
  StartMutationRecoveryBlockedAttention,
  StartMutationRecoveryCheckingAttention,
  startMutationAttentionCopy,
} = await import('./start-mutation-attention');

type Element = ReactElement<Record<string, unknown>>;

function renderedElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) {
    return node.flatMap(renderedElements);
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return [];
  }
  const element = node as Element;
  if (element.type === Call911Affordance) {
    return [element];
  }
  if (typeof element.type === 'function') {
    const render = element.type as (
      props: Record<string, unknown>,
    ) => ReactNode;
    return [element, ...renderedElements(render(element.props))];
  }
  return [element, ...renderedElements(element.props.children as ReactNode)];
}

function renderedText(node: ReactNode): string {
  if (Array.isArray(node)) {
    return node.map(renderedText).join(' ');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return '';
  }
  const element = node as Element;
  if (element.type === Call911Affordance) {
    return '';
  }
  if (typeof element.type === 'function') {
    const render = element.type as (
      props: Record<string, unknown>,
    ) => ReactNode;
    return renderedText(render(element.props));
  }
  return renderedText(element.props.children as ReactNode);
}

function normalizedText(node: ReactNode): string {
  return renderedText(node).replaceAll(/\s+/gu, ' ').trim();
}

function action(nodes: readonly Element[]): Element | undefined {
  return nodes.find(
    (node) =>
      node.type === 'Pressable' && node.props.accessibilityRole === 'button',
  );
}

function press(element: Element): void {
  const onPress = element.props.onPress;
  if (typeof onPress !== 'function') {
    throw new Error('The attention action is missing its callback.');
  }
  (onPress as () => void)();
}

describe('start mutation attention presentation', () => {
  test('keeps every pending real/drill start/join classified and action-free', () => {
    for (const mode of ['real', 'drill'] as const) {
      for (const operation of ['activate', 'join'] as const) {
        const result = StartMutationAttentionContent({
          eventKind: mode === 'real' ? 'incident' : 'drill',
          eventTypeName: 'Synthetic earthquake',
          mode,
          operation,
          status: 'pending',
        }) as Element;
        const nodes = renderedElements(result);
        const text = normalizedText(result);
        const banner = nodes.find((node) => node.type === ClassificationBanner);
        const progress = nodes.find(
          (node) => node.props.accessibilityRole === 'progressbar',
        );

        expect(result.type).toBe('ScrollView');
        expect(nodes.some((node) => node.type === Call911Affordance)).toBe(
          true,
        );
        expect(banner?.props.mode).toBe(mode);
        expect(text).toContain('Synthetic earthquake');
        expect(text).toContain(
          mode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY',
        );
        expect(text).toContain(
          operation === 'activate'
            ? 'Start request is still resolving'
            : 'Join request is still resolving',
        );
        expect(text).toContain('waiting for the server outcome');
        expect(text).toContain('Nothing will retry automatically');
        expect(text).toContain(
          'does not claim that an event was started or joined',
        );
        expect(text).toContain('no evidence of provider acceptance');
        expect(text).toContain('human receipt');
        expect(progress?.props.accessibilityLiveRegion).toBe('polite');
        expect(action(nodes)).toBeUndefined();
      }
    }
  });

  test('makes every unresolved real/drill start/join assertive and check-only', () => {
    for (const mode of ['real', 'drill'] as const) {
      for (const operation of ['activate', 'join'] as const) {
        const result = StartMutationAttentionContent({
          eventKind: mode === 'real' ? 'incident' : 'drill',
          eventTypeName: 'Synthetic earthquake',
          mode,
          onAcknowledgeUnresolved: () => {},
          onCheckActiveEvents: () => {},
          operation,
          outcomeMessage:
            'The request timed out, so the server outcome is unknown.',
          status: 'unresolved',
        }) as Element;
        const nodes = renderedElements(result);
        const text = normalizedText(result);
        const alert = nodes.find(
          (node) =>
            node.props.accessibilityRole === 'alert' &&
            node.props.accessibilityLiveRegion === 'assertive',
        );
        const checkAction = action(nodes);

        expect(alert).toBeDefined();
        expect(text).toContain(
          operation === 'activate'
            ? 'Start outcome needs attention'
            : 'Join outcome needs attention',
        );
        expect(text).toContain('could not determine the server outcome');
        expect(text).toContain(
          'The request timed out, so the server outcome is unknown.',
        );
        expect(text).toContain('Load fresh active events');
        expect(text).toContain(
          operation === 'activate'
            ? 'cannot prove which request created an event'
            : 'cannot prove join membership',
        );
        expect(checkAction?.props.accessibilityLabel).toBe(
          'Check active events',
        );
        expect(checkAction?.props.accessibilityHint).toContain(
          operation === 'activate'
            ? 'cannot prove which request created an event'
            : 'cannot prove join membership',
        );
        expect(checkAction?.props.accessibilityHint).toContain('never retries');
      }
    }
  });

  test('invokes the explicit fresh-active-events callback exactly once', () => {
    let checks = 0;
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic medical response',
      mode: 'drill',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {
        checks += 1;
      },
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const checkAction = action(renderedElements(result));

    if (checkAction === undefined) {
      throw new Error('The fresh-active-events action is missing.');
    }
    press(checkAction);
    expect(checks).toBe(1);
  });

  test('renders refreshed active events as read-only classified evidence without resolving', () => {
    const result = StartMutationAttentionContent({
      activeEvents: [
        {
          eventId: '00000000-0000-4000-8000-000000000901',
          eventKind: 'incident',
          eventTypeName: 'Synthetic lockdown',
          facilityName: 'Synthetic High School',
          mode: 'real',
          startedLabel: 'Aug 12, 2026, 9:00 AM',
        },
        {
          eventId: '00000000-0000-4000-8000-000000000902',
          eventKind: 'drill',
          eventTypeName: 'Synthetic earthquake practice',
          facilityName: 'Synthetic Middle School',
          mode: 'drill',
          startedLabel: 'Aug 12, 2026, 9:05 AM',
        },
        {
          eventId: '00000000-0000-4000-8000-000000000903',
          eventKind: 'test',
          eventTypeName: 'Synthetic delivery test',
          facilityName: 'Synthetic Elementary School',
          mode: 'drill',
          startedLabel: 'Aug 12, 2026, 9:10 AM',
        },
      ],
      eventKind: 'drill',
      eventTypeName: 'Synthetic medical response',
      mode: 'drill',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);
    const summaries = nodes.filter(
      (node) => node.props.accessibilityRole === 'summary',
    );

    expect(text).toContain('Fresh active events');
    expect(text).toContain('REAL INCIDENT');
    expect(text).toContain('DRILL — TRAINING ONLY');
    expect(text).toContain('TEST — NOT A REAL INCIDENT');
    expect(text).toContain('Synthetic High School');
    expect(text).toContain('00000000-0000-4000-8000-000000000901');
    expect(text).toContain('cannot prove which request created an event');
    expect(summaries).toHaveLength(3);
    expect(
      summaries.every((summary) => summary.props.accessible === true),
    ).toBe(true);
    expect(
      summaries.every((summary) =>
        String(summary.props.accessibilityLabel).includes(
          'does not resolve the earlier request',
        ),
      ),
    ).toBe(true);
    // The read-only summaries carry no controls: the only pressables are the
    // two explicit actions, so nothing in the list can resolve the outcome.
    expect(
      nodes
        .filter((node) => node.type === 'Pressable')
        .map((node) => String(node.props.accessibilityLabel)),
    ).toEqual(['Check active events', 'Clear and allow new decisions']);
  });

  test('renders an empty refreshed list without claiming prior failure', () => {
    const result = StartMutationAttentionContent({
      activeEvents: [],
      eventKind: 'drill',
      eventTypeName: 'Synthetic medical response',
      mode: 'drill',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const text = normalizedText(result);

    expect(text).toContain('No active events appeared');
    expect(text).toContain('Absence is not proof');
    expect(text).toContain('does not clear the unresolved outcome');
  });

  test('disables refresh while checking and keeps refresh failures unresolved', () => {
    const checkingResult = StartMutationAttentionContent({
      checking: true,
      eventKind: 'incident',
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'join',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const checkingAction = action(renderedElements(checkingResult));

    expect(checkingAction?.props.disabled).toBe(true);
    expect(checkingAction?.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(normalizedText(checkingResult)).toContain('Checking active events…');

    const failedResult = StartMutationAttentionContent({
      checkError: 'Fresh active events are unavailable.',
      eventKind: 'incident',
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'join',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const failedNodes = renderedElements(failedResult);
    const alerts = failedNodes.filter(
      (node) =>
        node.props.accessibilityRole === 'alert' &&
        node.props.accessibilityLiveRegion === 'assertive',
    );

    expect(alerts).toHaveLength(2);
    expect(normalizedText(failedResult)).toContain(
      'Fresh active events are unavailable.',
    );
    expect(normalizedText(failedResult)).toContain(
      'This outcome remains unresolved. Nothing retried automatically.',
    );
  });

  test('is scrollable and avoids fixed content height for large text', () => {
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic wildlife response with a long localized name',
      mode: 'drill',
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;

    expect(result.type).toBe('ScrollView');
    expect(result.props.contentContainerStyle).toMatchObject({ flexGrow: 1 });
    expect(result.props.contentContainerStyle).not.toHaveProperty('height');
    expect(result.props.contentContainerStyle).not.toHaveProperty('maxHeight');
    for (const text of renderedElements(result).filter(
      (node) => node.type === 'Text',
    )) {
      expect(text.props.numberOfLines).toBeUndefined();
      expect(text.props.allowFontScaling).not.toBe(false);
    }
  });

  test('keeps a previous-session pending request neutral and identity-free', () => {
    const result = OtherSessionStartMutationAttention({}) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);

    expect(result.type).toBe('ScrollView');
    expect(result.props.contentContainerStyle).toMatchObject({ flexGrow: 1 });
    expect(nodes.some((node) => node.type === ClassificationBanner)).toBe(
      false,
    );
    expect(nodes.some((node) => node.type === Call911Affordance)).toBe(true);
    expect(text).toContain('Previous request is still resolving');
    expect(text).toContain('previous signed-in session');
    expect(text).toContain('Nothing will retry automatically');
    expect(text).not.toContain('Synthetic earthquake');
    expect(text).not.toContain('REAL INCIDENT');
    expect(text).not.toContain('DRILL — TRAINING ONLY');
    expect(action(nodes)).toBeUndefined();
  });

  test('keeps a previous-session unresolved outcome neutral and truthfully fenced', () => {
    const result = OtherSessionStartMutationAttention({
      status: 'unresolved',
    }) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);

    expect(text).toContain('Previous request outcome is unresolved');
    expect(text).toContain('could not verify the server outcome');
    expect(text).toContain('New start and join actions are blocked');
    expect(text).toContain('Nothing will retry automatically');
    expect(text).not.toContain('Synthetic earthquake');
    expect(nodes.some((node) => node.type === ClassificationBanner)).toBe(
      false,
    );
    expect(action(nodes)).toBeUndefined();
  });

  test('renders a definite classified failure without calling it unknown', () => {
    let acknowledgements = 0;
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic earthquake',
      failureMessage:
        'Offline — no event was started or joined, and nothing was queued.',
      mode: 'drill',
      onRefreshActiveEvents: () => {
        acknowledgements += 1;
      },
      operation: 'activate',
      status: 'failed',
    }) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);
    const returnAction = action(nodes);

    expect(text).toContain('Start request was not completed');
    expect(text).toContain('DRILL — TRAINING ONLY');
    expect(text).toContain('nothing was queued');
    expect(text).toContain('Offline — no event was started or joined');
    expect(text).not.toContain('could not determine the server outcome');
    expect(returnAction?.props.accessibilityLabel).toBe(
      'Refresh active events',
    );
    if (returnAction === undefined) {
      throw new Error('The definite-failure return action is missing.');
    }
    press(returnAction);
    expect(acknowledgements).toBe(1);
  });

  test('disables a definite-failure refresh while it is checking', () => {
    const result = StartMutationAttentionContent({
      checking: true,
      eventKind: 'drill',
      eventTypeName: 'Synthetic earthquake',
      failureMessage: 'The server rejected the request.',
      mode: 'drill',
      onRefreshActiveEvents: () => {},
      operation: 'activate',
      status: 'failed',
    }) as Element;
    const refresh = action(renderedElements(result));

    expect(refresh?.props.disabled).toBe(true);
    expect(refresh?.props.accessibilityState).toEqual({
      busy: true,
      disabled: true,
    });
    expect(normalizedText(result)).toContain('Refreshing active events…');
  });

  test('renders an identity-free recovery hard stop with no mutation action', () => {
    const result = StartMutationRecoveryBlockedAttention({
      message: 'Recovery storage is unavailable. Contact support.',
    }) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);

    expect(nodes.some((node) => node.type === Call911Affordance)).toBe(true);
    expect(nodes.some((node) => node.type === ClassificationBanner)).toBe(
      false,
    );
    expect(text).toContain('Start and join actions are blocked');
    expect(text).toContain('No request will be sent or queued');
    expect(text).not.toContain('REAL INCIDENT');
    expect(text).not.toContain('DRILL — TRAINING ONLY');
    expect(action(nodes)).toBeUndefined();
  });

  test('blocks first paint while retained recovery is checked in commit phase', () => {
    const result = StartMutationRecoveryCheckingAttention({}) as Element;
    const nodes = renderedElements(result);
    const text = normalizedText(result);

    expect(nodes.some((node) => node.type === Call911Affordance)).toBe(true);
    expect(nodes.some((node) => node.type === ClassificationBanner)).toBe(
      false,
    );
    expect(text).toContain('Checking prior requests');
    expect(text).toContain('before enabling start or join actions');
    expect(text).toContain('Nothing will be sent or queued');
    expect(action(nodes)).toBeUndefined();
  });

  test('disables attention checks while offline with explicit fail-closed copy', () => {
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic earthquake',
      mode: 'drill',
      online: false,
      onAcknowledgeUnresolved: () => {},
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The outcome remains unknown.',
      status: 'unresolved',
    }) as Element;
    const check = action(renderedElements(result));

    expect(check?.props.disabled).toBe(true);
    expect(normalizedText(result)).toContain('Reconnect before checking');
    expect(normalizedText(result)).toContain('No request was made');
  });

  test('copy helper preserves operation and classification semantics', () => {
    expect(
      startMutationAttentionCopy({
        eventKind: 'incident',
        eventTypeName: 'Lockdown',
        mode: 'real',
        operation: 'activate',
        status: 'pending',
      }),
    ).toMatchObject({
      heading: 'Start request is still resolving',
      status: expect.stringContaining('REAL INCIDENT: Lockdown'),
    });
    expect(
      startMutationAttentionCopy({
        eventKind: 'drill',
        eventTypeName: 'Lockdown practice',
        mode: 'drill',
        operation: 'join',
        status: 'unresolved',
      }),
    ).toMatchObject({
      heading: 'Join outcome needs attention',
      status: expect.stringContaining(
        'DRILL — TRAINING ONLY: Lockdown practice',
      ),
    });
    expect(
      startMutationAttentionCopy({
        eventKind: 'test',
        eventTypeName: 'Synthetic delivery test',
        mode: 'drill',
        operation: 'join',
        status: 'pending',
      }),
    ).toMatchObject({
      heading: 'Join request is still resolving',
      status: expect.stringContaining(
        'TEST — NOT A REAL INCIDENT: Synthetic delivery test',
      ),
    });
  });

  test('offers an explicit unresolved clear that never claims the earlier outcome', () => {
    let cleared = 0;
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic investigation',
      mode: 'drill',
      onAcknowledgeUnresolved: () => {
        cleared += 1;
      },
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const nodes = renderedElements(result);
    const clear = nodes.find(
      (node) =>
        node.type === 'Pressable' &&
        node.props.accessibilityLabel === 'Clear and allow new decisions',
    );

    if (clear === undefined) {
      throw new Error('The unresolved clear action is missing.');
    }
    expect(clear.props.accessibilityState).toEqual({ disabled: false });
    press(clear);
    expect(cleared).toBe(1);

    const text = normalizedText(result);
    expect(text).toContain('does not resolve the earlier request');
    expect(text).toContain('makes no claim that it succeeded or failed');
    expect(text).toContain('so a new emergency can be raised');
    expect(text).toContain('does not claim that an event was started');
  });

  test('disables the unresolved clear while the device is offline', () => {
    const result = StartMutationAttentionContent({
      eventKind: 'drill',
      eventTypeName: 'Synthetic investigation',
      mode: 'drill',
      online: false,
      onAcknowledgeUnresolved: () => {
        throw new Error('An offline clear must never fire.');
      },
      onCheckActiveEvents: () => {},
      operation: 'activate',
      outcomeMessage: 'The server outcome is unknown.',
      status: 'unresolved',
    }) as Element;
    const clear = renderedElements(result).find(
      (node) =>
        node.type === 'Pressable' &&
        node.props.accessibilityLabel === 'Clear and allow new decisions',
    );

    if (clear === undefined) {
      throw new Error('The unresolved clear action is missing.');
    }
    expect(clear.props.accessibilityState).toEqual({ disabled: true });
    expect(clear.props.disabled).toBe(true);
  });

  test('gives an orphaned previous-session fence a way out and drops the impossible instruction', () => {
    let cleared = 0;
    const result = OtherSessionStartMutationAttention({
      onAcknowledgeUnresolved: () => {
        cleared += 1;
      },
      status: 'unresolved',
    }) as Element;
    const text = normalizedText(result);
    const clear = renderedElements(result).find(
      (node) =>
        node.type === 'Pressable' &&
        node.props.accessibilityLabel === 'Clear and allow new decisions',
    );

    if (clear === undefined) {
      throw new Error('The previous-session fence still has no way out.');
    }
    press(clear);
    expect(cleared).toBe(1);

    // A session cannot be re-entered, so this must never be the instruction.
    expect(text).not.toContain('Sign back into the session that made the');
    expect(text).toContain('cannot be signed back into');
    expect(text).toContain('does not resolve the earlier request');
    expect(text).toContain('does not claim that an event was started');
    // Another person's classified event details must still never appear here.
    expect(text).not.toContain('Synthetic earthquake');
    expect(text).not.toContain('REAL INCIDENT');
  });

  test('disables the previous-session clear while the device is offline', () => {
    const result = OtherSessionStartMutationAttention({
      online: false,
      onAcknowledgeUnresolved: () => {
        throw new Error('An offline clear must never fire.');
      },
      status: 'unresolved',
    }) as Element;
    const clear = renderedElements(result).find(
      (node) =>
        node.type === 'Pressable' &&
        node.props.accessibilityLabel === 'Clear and allow new decisions',
    );

    if (clear === undefined) {
      throw new Error('The previous-session fence still has no way out.');
    }
    expect(clear.props.accessibilityState).toEqual({ disabled: true });
    expect(clear.props.disabled).toBe(true);
  });

  test('gives the recovery-blocked screen a way out', () => {
    let continued = 0;
    const result = StartMutationRecoveryBlockedAttention({
      message: 'PSD EOC cannot safely read or retain the prior start request.',
      onContinueWithoutRecovery: () => {
        continued += 1;
      },
    }) as Element;
    const text = normalizedText(result);
    const action = renderedElements(result).find(
      (node) =>
        node.type === 'Pressable' &&
        node.props.accessibilityLabel === 'Continue without recovery',
    );

    if (action === undefined) {
      throw new Error('The recovery-blocked screen still has no way out.');
    }
    press(action);
    expect(continued).toBe(1);
    expect(text).toContain('nothing already stored is deleted');
    expect(text).toContain('will not be recoverable here');
  });
});
