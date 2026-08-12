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
          mode === 'real' ? 'REAL INCIDENT' : 'DRILL — PRACTICE',
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
          eventTypeName: 'Synthetic earthquake',
          mode,
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
            ? 'Absence is not proof of failure'
            : 'cannot prove join membership',
        );
        expect(checkAction?.props.accessibilityLabel).toBe(
          'Check active events',
        );
        expect(checkAction?.props.accessibilityHint).toContain(
          operation === 'activate'
            ? 'Absence is not proof of failure'
            : 'cannot prove join membership',
        );
        expect(checkAction?.props.accessibilityHint).toContain('never retries');
      }
    }
  });

  test('invokes the explicit fresh-active-events callback exactly once', () => {
    let checks = 0;
    const result = StartMutationAttentionContent({
      eventTypeName: 'Synthetic medical response',
      mode: 'drill',
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

  test('disables refresh while checking and keeps refresh failures unresolved', () => {
    const checkingResult = StartMutationAttentionContent({
      checking: true,
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
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
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
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
      eventTypeName: 'Synthetic wildlife response with a long localized name',
      mode: 'drill',
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
    expect(text).not.toContain('DRILL — PRACTICE');
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
    expect(text).toContain('DRILL — PRACTICE');
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
    expect(text).not.toContain('DRILL — PRACTICE');
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
      eventTypeName: 'Synthetic earthquake',
      mode: 'drill',
      online: false,
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
        eventTypeName: 'Lockdown practice',
        mode: 'drill',
        operation: 'join',
        status: 'unresolved',
      }),
    ).toMatchObject({
      heading: 'Join outcome needs attention',
      status: expect.stringContaining('DRILL — PRACTICE: Lockdown practice'),
    });
  });
});
