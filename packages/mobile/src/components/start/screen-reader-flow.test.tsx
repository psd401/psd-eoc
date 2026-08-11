import { describe, expect, mock, test } from 'bun:test';

import type { ReactElement, ReactNode } from 'react';

mock.module('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: {
    create: <Styles,>(styles: Styles): Styles => styles,
  },
  Text: 'Text',
  View: 'View',
}));

const { ClassificationBanner } = await import('../classification-banner');
const { ActivationConfirmation, activationAudienceLabel } = await import(
  './activation-confirmation'
);
const { ActiveEventJoinAction } = await import('./active-event-join-action');
const { ClassifiedActionButton } = await import('./classified-action-button');
const { EventTypeChoice } = await import('./event-type-choice');
const { StartModeAction } = await import('./start-mode-action');

type Element = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return [];
  }
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}

function minimumHeight(element: Element): number {
  const styleValue = element.props.style;
  const resolved =
    typeof styleValue === 'function'
      ? (styleValue as (state: { pressed: boolean }) => unknown)({
          pressed: false,
        })
      : styleValue;
  const styles = Array.isArray(resolved) ? resolved : [resolved];
  return styles.reduce((height, style) => {
    if (typeof style !== 'object' || style === null) return height;
    const candidate = (style as { minHeight?: unknown }).minHeight;
    return typeof candidate === 'number' ? Math.max(height, candidate) : height;
  }, 0);
}

function renderClassifiedAction(element: Element): Element {
  return ClassifiedActionButton(
    element.props as unknown as Parameters<typeof ClassifiedActionButton>[0],
  ) as Element;
}

describe('VoiceOver and TalkBack start-flow contract', () => {
  test('exposes the three-tap path as classified buttons with large targets', () => {
    for (const mode of ['real', 'drill'] as const) {
      const modeChoice = StartModeAction({
        facilityName: 'Synthetic Test School',
        mode,
        onPress: () => {},
      }) as Element;
      const modeButton = renderClassifiedAction(modeChoice);
      expect(modeButton.props.accessibilityRole).toBe('button');
      expect(modeButton.props.accessibilityLabel).toContain(
        mode === 'real' ? 'REAL INCIDENT' : 'DRILL — PRACTICE',
      );
      expect(modeButton.props.accessibilityHint).toContain(
        'does not start an event',
      );
      expect(minimumHeight(modeButton)).toBeGreaterThanOrEqual(48);

      const typeChoice = EventTypeChoice({
        mode,
        name: 'Earthquake',
        onPress: () => {},
      }) as Element;
      const typeButton = renderClassifiedAction(typeChoice);
      expect(typeButton.props.accessibilityRole).toBe('button');
      expect(typeButton.props.accessibilityLabel).toContain('Earthquake');
      expect(typeButton.props.accessibilityHint).toContain(
        'No event is started',
      );
      expect(minimumHeight(typeButton)).toBeGreaterThanOrEqual(48);

      const confirmation = ActivationConfirmation({
        eventTypeName: 'Earthquake',
        facilityName: 'Synthetic Test School',
        mode,
        onConfirm: () => {},
        recipientCount: 2,
        rosterPopulation: 'staff',
        sendReadiness: 'ready',
      }) as Element;
      const confirmationNodes = elements(confirmation);
      const banner = confirmationNodes.find(
        (node) => node.type === ClassificationBanner,
      );
      const confirmButton = confirmationNodes.find(
        (node) => node.type === 'Pressable',
      );
      expect(banner?.props.mode).toBe(mode);
      expect(confirmButton?.props.accessibilityRole).toBe('button');
      expect(confirmButton?.props.accessibilityLabel).toContain(
        mode === 'real' ? 'REAL incident' : 'DRILL — PRACTICE',
      );
      expect(confirmButton?.props.accessibilityHint).toContain(
        'Final human confirmation',
      );
      expect(confirmButton?.props.accessibilityState).toEqual({
        busy: false,
        disabled: false,
      });
      if (confirmButton === undefined) {
        throw new Error('The confirmation button is missing.');
      }
      expect(minimumHeight(confirmButton)).toBeGreaterThanOrEqual(48);
    }
  });

  test('announces an exact join choice without implying another notification', () => {
    const joinChoice = ActiveEventJoinAction({
      eventTypeName: 'Earthquake drill',
      facilityName: 'Synthetic Test School',
      mode: 'drill',
      onPress: () => {},
      startedLabel: 'Aug 11, 2026 at 10:00 AM',
    }) as Element;
    const joinButton = renderClassifiedAction(joinChoice);

    expect(joinButton.props.accessibilityRole).toBe('button');
    expect(joinButton.props.accessibilityLabel).toContain(
      'Join existing DRILL — PRACTICE',
    );
    expect(joinButton.props.accessibilityHint).toContain(
      'does not create another event or notification intent',
    );
    expect(minimumHeight(joinButton)).toBeGreaterThanOrEqual(48);
  });

  test('announces synthetic and staff audience truth without substitution', () => {
    expect(activationAudienceLabel(1, 'synthetic')).toBe(
      '1 synthetic recipient',
    );
    expect(activationAudienceLabel(2, 'synthetic')).toBe(
      '2 synthetic recipients',
    );
    expect(activationAudienceLabel(1, 'staff')).toBe('1 selected staff member');
    expect(activationAudienceLabel(2, 'staff')).toBe(
      '2 selected staff members',
    );
  });

  test('keeps the 911 and full-screen result announcements in the native tree', async () => {
    const call911Source = await Bun.file(
      new URL('./call-911-affordance.tsx', import.meta.url),
    ).text();
    const resultSource = await Bun.file(
      new URL('./activation-result.tsx', import.meta.url),
    ).text();

    expect(call911Source).toContain("const DIALER_URL = 'tel:911'");
    expect(call911Source).toContain('accessibilityLabel="Call 911 first"');
    expect(call911Source).toContain('accessibilityRole="link"');
    expect(call911Source).toContain('PSD EOC does not contact 911');
    expect(resultSource).toContain(
      'AccessibilityInfo.announceForAccessibility',
    );
    expect(resultSource).toContain('accessibilityLiveRegion="assertive"');
    expect(resultSource).toContain(
      'Provider acceptance and human receipt are tracked separately',
    );
  });

  test('guards the executable Maestro flows and fixes activation at three taps', async () => {
    const startFlow = await Bun.file(
      new URL('../../../.maestro/issue-21/start-drill.yaml', import.meta.url),
    ).text();
    const joinFlow = await Bun.file(
      new URL('../../../.maestro/issue-21/join-existing.yaml', import.meta.url),
    ).text();

    expect(startFlow.match(/^\s*- tapOn:/gmu)).toHaveLength(3);
    expect(joinFlow.match(/^\s*- tapOn:/gmu)).toHaveLength(1);
    expect(startFlow.indexOf("id: 'issue-21-synthetic-mode'")).toBeLessThan(
      startFlow.indexOf("id: 'issue-21-start-drill'"),
    );
    expect(joinFlow.indexOf("id: 'issue-21-synthetic-mode'")).toBeLessThan(
      joinFlow.indexOf("id: 'issue-21-join-existing'"),
    );
    expect(startFlow).toContain("assertVisible: 'DRILL — PRACTICE'");
    expect(joinFlow).toContain("assertVisible: 'DRILL — PRACTICE'");
  });
});
