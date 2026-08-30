import { describe, expect, mock, test } from 'bun:test';

import { type ActivationPreview } from '@psd-eoc/contracts';
import type { ReactElement, ReactNode } from 'react';

const announcements: string[] = [];
const dialerUrls: string[] = [];

mock.module('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AccessibilityInfo: {
    announceForAccessibility: (message: string) => {
      announcements.push(message);
    },
  },
  Linking: {
    openURL: async (url: string) => {
      dialerUrls.push(url);
    },
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <Styles,>(styles: Styles): Styles => styles,
  },
  Text: 'Text',
  View: 'View',
}));

const { ClassificationBanner } = await import('../classification-banner');
const {
  ActivationConfirmation,
  activationAudienceLabel,
  publicBlockingMessages,
} = await import('./activation-confirmation');
const { ActivationResultContent, announceActivationResult } = await import(
  './activation-result'
);
const { ActiveEventJoinAction } = await import('./active-event-join-action');
const { Call911Action, open911Dialer } = await import('./call-911-affordance');
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

function renderedElements(node: ReactNode): Element[] {
  if (Array.isArray(node)) {
    return node.flatMap(renderedElements);
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return [];
  }
  const element = node as Element;
  if (typeof element.type === 'function') {
    const render = element.type as (
      props: Record<string, unknown>,
    ) => ReactNode;
    return [element, ...renderedElements(render(element.props))];
  }
  return [element, ...renderedElements(element.props.children as ReactNode)];
}

function renderedText(node: ReactNode): readonly string[] {
  if (Array.isArray(node)) {
    return node.flatMap(renderedText);
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) {
    return [];
  }
  const element = node as Element;
  if (typeof element.type === 'function') {
    const render = element.type as (
      props: Record<string, unknown>,
    ) => ReactNode;
    return renderedText(render(element.props));
  }
  return renderedText(element.props.children as ReactNode);
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

function press(element: Element): void {
  const onPress = element.props.onPress;
  if (typeof onPress !== 'function') {
    throw new Error('The accessible action is missing its press handler.');
  }
  (onPress as () => void)();
}

const TEST_CHANNELS = [
  {
    channel: 'push',
    endpointCount: 2,
    renderedMessage: {
      channel: 'push',
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      title: '[DRILL] Synthetic earthquake drill',
      body: '[DRILL] Synthetic recipients only.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: '2026-08-11T18:00:00.000Z',
    },
  },
  {
    channel: 'email',
    endpointCount: 2,
    renderedMessage: {
      channel: 'email',
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      subject: '[DRILL] Synthetic earthquake drill',
      textBody: '[DRILL] Synthetic recipients only.',
    },
    integrationStatus: {
      integrationId: 'ses-email',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: '2026-08-11T18:00:00.000Z',
    },
  },
] as const satisfies ActivationPreview['channels'];

const REAL_TEST_CHANNELS = [
  {
    channel: 'push',
    endpointCount: 2,
    renderedMessage: {
      channel: 'push',
      eventKind: 'incident',
      templateMode: 'real',
      purpose: 'activation',
      classificationMarker: 'INCIDENT',
      title: '[INCIDENT] Synthetic safety test',
      body: '[INCIDENT] Synthetic fixture; no provider contacted.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'live-verified',
      verifiedAt: '2026-08-11T18:00:00.000Z',
      verifiedByUserId: '61000000-0000-4000-8000-000000000001',
      authorizationReference: 'contract-fixture-not-provider-evidence',
      reasonCode: null,
      observedAt: '2026-08-11T18:00:00.000Z',
    },
  },
  {
    channel: 'email',
    endpointCount: 2,
    renderedMessage: {
      channel: 'email',
      eventKind: 'incident',
      templateMode: 'real',
      purpose: 'activation',
      classificationMarker: 'INCIDENT',
      subject: '[INCIDENT] Synthetic safety test',
      textBody: '[INCIDENT] Synthetic fixture; no provider contacted.',
    },
    integrationStatus: {
      integrationId: 'ses-email',
      label: 'live-verified',
      verifiedAt: '2026-08-11T18:00:00.000Z',
      verifiedByUserId: '61000000-0000-4000-8000-000000000001',
      authorizationReference: 'contract-fixture-not-provider-evidence',
      reasonCode: null,
      observedAt: '2026-08-11T18:00:00.000Z',
    },
  },
] as const satisfies ActivationPreview['channels'];

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
        mode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY',
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
        channels: mode === 'real' ? REAL_TEST_CHANNELS : TEST_CHANNELS,
        eventKind: mode === 'real' ? 'incident' : 'drill',
        eventTypeName: 'Earthquake',
        facilityName: 'Synthetic Test School',
        mode,
        onConfirm: () => {},
        recipientCount: 2,
        rosterPopulation: mode === 'real' ? 'staff' : 'synthetic',
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
        mode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY',
      );
      expect(confirmButton?.props.accessibilityHint).toContain(
        'Starts the event',
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

  test('executes the ordered three-tap semantic path through final confirmation', () => {
    const completedSteps: string[] = [];
    const modeButton = renderClassifiedAction(
      StartModeAction({
        facilityName: 'Synthetic Test School',
        mode: 'drill',
        onPress: () => {
          completedSteps.push('site-and-mode');
        },
      }) as Element,
    );
    expect(modeButton.props.accessibilityLabel).toBe(
      'DRILL — TRAINING ONLY. Run practice drill at Synthetic Test School',
    );
    press(modeButton);

    const typeButton = renderClassifiedAction(
      EventTypeChoice({
        mode: 'drill',
        name: 'Synthetic earthquake drill',
        onPress: () => {
          completedSteps.push('event-type-and-preview');
        },
      }) as Element,
    );
    expect(typeButton.props.accessibilityLabel).toBe(
      'DRILL — TRAINING ONLY. Choose Synthetic earthquake drill',
    );
    press(typeButton);

    const confirmation = ActivationConfirmation({
      activeEventCount: 1,
      channels: TEST_CHANNELS,
      eventKind: 'drill',
      eventTypeName: 'Synthetic earthquake drill',
      facilityName: 'Synthetic Test School',
      mode: 'drill',
      onConfirm: () => {
        completedSteps.push('final-human-confirmation');
      },
      recipientCount: 2,
      rosterPopulation: 'synthetic',
      sendReadiness: 'ready',
    }) as Element;
    const confirmButton = renderedElements(confirmation).find(
      (node) =>
        node.type === 'Pressable' &&
        String(node.props.accessibilityLabel).startsWith('Start a separate'),
    );
    expect(confirmButton?.props.accessibilityLabel).toBe(
      'Start a separate DRILL — TRAINING ONLY and notify 2 synthetic recipients',
    );
    if (confirmButton === undefined) {
      throw new Error('The final human confirmation is missing.');
    }
    press(confirmButton);

    expect(completedSteps).toEqual([
      'site-and-mode',
      'event-type-and-preview',
      'final-human-confirmation',
    ]);
  });

  test('renders every signed channel consequence before confirmation', () => {
    const confirmation = ActivationConfirmation({
      channels: TEST_CHANNELS,
      eventKind: 'drill',
      eventTypeName: 'Synthetic earthquake drill',
      facilityName: 'Synthetic Test School',
      mode: 'drill',
      onConfirm: () => {},
      recipientCount: 2,
      rosterPopulation: 'synthetic',
      sendReadiness: 'ready',
    }) as Element;
    const text = renderedText(confirmation).join(' ').replaceAll(/\s+/gu, ' ');
    const nodes = renderedElements(confirmation);
    const confirmButton = nodes.find(
      (node) =>
        node.type === 'Pressable' &&
        String(node.props.accessibilityHint).startsWith('Starts the event'),
    );

    expect(text).toContain('Who gets notified');
    expect(text).toContain('DRILL — TRAINING ONLY · Push notifications');
    expect(text).toContain('[DRILL] Synthetic earthquake drill');
    expect(text).toContain('[DRILL] Synthetic recipients only.');
    expect(text).toContain('Eligible endpoints: 2');
    expect(text).toContain('Mocked — training data only');
    expect(text).toContain('Text messages');
    expect(text).toContain('Not included.');
    expect(text).toContain('No text message is sent.');
    expect(confirmButton?.props.accessibilityHint).toContain(
      'sends the messages shown above',
    );
  });

  test('announces an exact join choice without implying another notification', () => {
    const joinChoice = ActiveEventJoinAction({
      eventId: '21000000-0000-4000-8000-000000000001',
      eventKind: 'drill',
      eventTypeName: 'Earthquake drill',
      facilityName: 'Synthetic Test School',
      mode: 'drill',
      onPress: () => {},
      startedLabel: 'Aug 11, 2026 at 10:00 AM',
    }) as Element;
    const concurrentChoice = ActiveEventJoinAction({
      eventId: '21000000-0000-4000-8000-000000000002',
      eventKind: 'drill',
      eventTypeName: 'Earthquake drill',
      facilityName: 'Synthetic Test School',
      mode: 'drill',
      onPress: () => {},
      startedLabel: 'Aug 11, 2026 at 10:00 AM',
    }) as Element;
    const joinButton = renderClassifiedAction(joinChoice);
    const concurrentButton = renderClassifiedAction(concurrentChoice);

    expect(joinButton.props.accessibilityRole).toBe('button');
    expect(joinButton.props.accessibilityLabel).toContain(
      'Join existing DRILL — TRAINING ONLY',
    );
    expect(joinButton.props.accessibilityLabel).toContain(
      'Event ID 21000000-0000-4000-8000-000000000001',
    );
    expect(renderedText(joinButton).join(' ')).toContain(
      'Event ID 21000000-0000-4000-8000-000000000001',
    );
    expect(concurrentButton.props.accessibilityLabel).toContain(
      'Event ID 21000000-0000-4000-8000-000000000002',
    );
    expect(concurrentButton.props.accessibilityLabel).not.toBe(
      joinButton.props.accessibilityLabel,
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

  test('renders test join classification without leaking readiness reason codes', () => {
    const joinButton = renderClassifiedAction(
      ActiveEventJoinAction({
        eventId: '21000000-0000-4000-8000-000000000003',
        eventKind: 'test',
        eventTypeName: 'Synthetic delivery test',
        facilityName: 'Synthetic Test School',
        mode: 'drill',
        onPress: () => {},
        startedLabel: 'Aug 11, 2026 at 10:10 AM',
      }) as Element,
    );
    const blockingMessages = publicBlockingMessages([
      'EMAIL_NOT_LIVE_VERIFIED',
      'PROVIDER_TRUTH_INCOMPLETE',
    ]);

    expect(joinButton.props.accessibilityLabel).toContain(
      'Join existing TEST — NOT A REAL INCIDENT',
    );
    expect(renderedText(joinButton).join(' ')).toContain(
      'TEST — NOT A REAL INCIDENT',
    );
    expect(renderedText(joinButton).join(' ')).not.toContain(
      'DRILL — TRAINING ONLY',
    );
    expect(blockingMessages).toEqual([
      'One or more server prerequisites are unavailable. Refresh the preview; if it remains blocked, contact an administrator.',
    ]);
    expect(JSON.stringify(blockingMessages)).not.toContain(
      'EMAIL_NOT_LIVE_VERIFIED',
    );
    expect(JSON.stringify(blockingMessages)).not.toContain(
      'Provider truth incomplete',
    );
  });

  test('keeps the 911 and full-screen result announcements in the native tree', async () => {
    dialerUrls.length = 0;
    const call911 = Call911Action({
      error: null,
      onPress: () => {
        void open911Dialer();
      },
      testID: 'call-911-first',
    }) as Element;
    const call911Link = renderedElements(call911).find(
      (node) => node.props.accessibilityRole === 'link',
    );
    expect(call911Link?.props.accessibilityLabel).toBe('Call 911 first');
    expect(call911Link?.props.accessibilityHint).toContain(
      'PSD EOC does not contact 911',
    );
    if (call911Link === undefined) {
      throw new Error('The human-controlled 911 action is missing.');
    }
    expect(minimumHeight(call911Link)).toBeGreaterThanOrEqual(48);
    press(call911Link);
    await Promise.resolve();
    expect(dialerUrls).toEqual(['tel:911']);

    announcements.length = 0;
    let openedEvent = false;
    let returnedHome = false;
    const resultInput = {
      eventKind: 'drill' as const,
      eventTypeName: 'Synthetic earthquake drill',
      kind: 'activated' as const,
      mode: 'drill' as const,
      onOpenEvent: () => {
        openedEvent = true;
      },
      onReturnHome: () => {
        returnedHome = true;
      },
    };
    announceActivationResult(resultInput);
    const result = ActivationResultContent(resultInput) as Element;
    const resultNodes = renderedElements(result);
    const resultText = renderedText(result).join(' ').replaceAll(/\s+/gu, ' ');
    const openEvent = resultNodes.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        renderedText(node).join(' ').includes('Open event'),
    );
    const returnHome = resultNodes.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        renderedText(node).join(' ').includes('Return home'),
    );

    expect(result.type).toBe('ScrollView');
    expect(result.props.contentContainerStyle).toMatchObject({ flexGrow: 1 });
    expect(
      resultNodes.some(
        (node) => node.props.accessibilityLiveRegion === 'assertive',
      ),
    ).toBe(true);
    expect(resultText).toContain('Drill started');
    expect(resultText).toContain('Opening the drill…');
    expect(announcements).toEqual([
      expect.stringContaining(
        'Drill started. DRILL — TRAINING ONLY. Synthetic earthquake drill.',
      ),
    ]);
    if (openEvent === undefined || returnHome === undefined) {
      throw new Error('The scrollable result actions are missing.');
    }
    press(openEvent);
    expect(openedEvent).toBe(true);
    press(returnHome);
    expect(returnedHome).toBe(true);
  });

  test('announces a joined synthetic test without cross-rendering it as a drill', () => {
    announcements.length = 0;
    const resultInput = {
      eventKind: 'test' as const,
      eventTypeName: 'Synthetic delivery test',
      kind: 'joined' as const,
      mode: 'drill' as const,
    };

    announceActivationResult(resultInput);
    const result = ActivationResultContent(resultInput) as Element;
    const resultText = renderedText(result).join(' ').replaceAll(/\s+/gu, ' ');

    expect(resultText).toContain('TEST — NOT A REAL INCIDENT');
    expect(resultText).not.toContain('DRILL — TRAINING ONLY');
    expect(announcements).toEqual([
      expect.stringContaining(
        'Event joined. TEST — NOT A REAL INCIDENT. Synthetic delivery test.',
      ),
    ]);
  });

  test('guards the executable Maestro flows and fixes activation at three taps', async () => {
    const startFlow = await Bun.file(
      new URL('../../../.maestro/issue-21/start-drill.yaml', import.meta.url),
    ).text();
    const joinFlow = await Bun.file(
      new URL('../../../.maestro/issue-21/join-existing.yaml', import.meta.url),
    ).text();
    const flowReadme = await Bun.file(
      new URL('../../../.maestro/issue-21/README.md', import.meta.url),
    ).text();

    expect(startFlow.match(/^\s*- tapOn:/gmu)).toHaveLength(3);
    expect(joinFlow.match(/^\s*- tapOn:/gmu)).toHaveLength(1);
    expect(startFlow).toContain('stopApp: false');
    expect(joinFlow).toContain('stopApp: false');
    expect(startFlow).not.toContain('stopApp: true');
    expect(joinFlow).not.toContain('stopApp: true');
    expect(startFlow).toContain('scrollUntilVisible:');
    expect(startFlow.indexOf('scrollUntilVisible:')).toBeLessThan(
      startFlow.indexOf(
        "tapOn: 'Start a separate DRILL — TRAINING ONLY and record notification intents for 2 synthetic recipients'",
      ),
    );
    expect(startFlow.indexOf("id: 'issue-21-synthetic-mode'")).toBeLessThan(
      startFlow.indexOf("id: 'issue-21-start-drill'"),
    );
    expect(joinFlow.indexOf("id: 'issue-21-synthetic-mode'")).toBeLessThan(
      joinFlow.indexOf("id: 'issue-21-join-existing'"),
    );
    expect(startFlow).toContain("assertVisible: '.*DRILL — TRAINING ONLY.*'");
    expect(joinFlow).toContain("assertVisible: '.*DRILL — TRAINING ONLY.*'");
    expect(startFlow).toContain(
      "tapOn: 'DRILL — TRAINING ONLY. Run practice drill at Synthetic Test School'",
    );
    expect(startFlow).toContain(
      "tapOn: 'DRILL — TRAINING ONLY. Choose Synthetic earthquake drill'",
    );
    expect(startFlow).toContain(
      "tapOn: 'Start a separate DRILL — TRAINING ONLY and record notification intents for 2 synthetic recipients'",
    );
    expect(joinFlow).toContain(
      "tapOn: 'Join existing DRILL — TRAINING ONLY: Synthetic earthquake drill at Synthetic Test School.*'",
    );
    expect(flowReadme).toContain(
      'human-unlocked session and do not automate biometric or Google',
    );
    expect(flowReadme).toContain(
      'iPhone with VoiceOver and on an Android device',
    );
  });
});
