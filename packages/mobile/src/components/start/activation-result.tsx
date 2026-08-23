import type { EventKind, TemplateMode } from '@psd-eoc/contracts';
import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ClassificationBanner } from '../classification-banner';
import { getEventTheme } from '../../theme/event-theme';

export interface ActivationResultProps {
  /** Defaults true. App-lifetime owners announce from their single claim. */
  readonly announceOnMount?: boolean;
  readonly eventTypeName: string;
  readonly eventKind: EventKind;
  readonly kind: 'activated' | 'joined';
  readonly mode: TemplateMode;
  readonly onOpenEvent?: () => void;
  readonly onReturnHome?: () => void;
  readonly testID?: string;
}

type ResultIdentity = Pick<
  ActivationResultProps,
  'eventKind' | 'eventTypeName' | 'kind' | 'mode'
>;

function resultCopy({ kind, mode }: ResultIdentity) {
  const activated = kind === 'activated';
  return Object.freeze({
    heading: activated
      ? mode === 'real'
        ? 'Incident started'
        : 'Drill started'
      : 'Event joined',
    status: activated
      ? `PSD EOC durably accepted the ${mode === 'real' ? 'incident' : 'drill'} and recorded its notification intent.`
      : 'You joined the existing event. Joining did not create another event or notification.',
  });
}

export function activationResultAnnouncement(input: ResultIdentity): string {
  const theme = getEventTheme(input.mode, input.eventKind);
  const { heading, status } = resultCopy(input);
  return `${heading}. ${theme.classificationWord}. ${input.eventTypeName}. ${status}`;
}

type Announce = (message: string) => void;

/** Executes the exact announcement used by the mounted result screen. */
export function announceActivationResult(
  input: ResultIdentity,
  announce: Announce = (message) =>
    AccessibilityInfo.announceForAccessibility(message),
): void {
  announce(activationResultAnnouncement(input));
}

/** Full-screen result with a standalone one-announcement-per-mount default. */
export function ActivationResult({
  announceOnMount = true,
  eventKind,
  eventTypeName,
  kind,
  mode,
  onOpenEvent,
  onReturnHome,
  testID,
}: ActivationResultProps) {
  const announced = useRef(false);
  const announcement = activationResultAnnouncement({
    eventTypeName,
    eventKind,
    kind,
    mode,
  });

  useEffect(() => {
    if (!announceOnMount || announced.current) return;
    announced.current = true;
    announceActivationResult({ eventKind, eventTypeName, kind, mode });
  }, [announceOnMount, announcement, eventKind, eventTypeName, kind, mode]);

  return (
    <ActivationResultContent
      eventTypeName={eventTypeName}
      eventKind={eventKind}
      kind={kind}
      mode={mode}
      {...(onOpenEvent === undefined ? {} : { onOpenEvent })}
      {...(onReturnHome === undefined ? {} : { onReturnHome })}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

/** Pure native result tree shared with renderer-independent accessibility tests. */
export function ActivationResultContent({
  eventTypeName,
  eventKind,
  kind,
  mode,
  onOpenEvent,
  onReturnHome,
  testID,
}: ActivationResultProps) {
  const theme = getEventTheme(mode, eventKind);
  const activated = kind === 'activated';
  const { heading, status } = resultCopy({
    eventKind,
    eventTypeName,
    kind,
    mode,
  });

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
      testID={testID}
    >
      <ClassificationBanner kind={eventKind} mode={mode} />
      <View
        accessibilityLiveRegion="assertive"
        style={[
          styles.result,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.colors.textPrimary }]}
        >
          {heading}
        </Text>
        <Text style={[styles.eventType, { color: theme.colors.textPrimary }]}>
          {eventTypeName}
        </Text>
        <Text style={[styles.status, { color: theme.colors.textMuted }]}>
          {status}
        </Text>
        {activated ? (
          <Text style={[styles.truth, { color: theme.colors.textMuted }]}>
            Provider acceptance and human receipt are tracked separately; this
            screen does not claim either one.
          </Text>
        ) : null}
      </View>

      {onOpenEvent === undefined && onReturnHome === undefined ? null : (
        <View style={styles.actions}>
          {onOpenEvent === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={onOpenEvent}
              style={({ pressed }) => [
                styles.primaryAction,
                { backgroundColor: theme.colors.bannerBackground },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.primaryActionText,
                  { color: theme.colors.onBanner },
                ]}
              >
                Open event
              </Text>
            </Pressable>
          )}
          {onReturnHome === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={onReturnHome}
              style={({ pressed }) => [
                styles.secondaryAction,
                { borderColor: theme.colors.border },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.secondaryActionText,
                  { color: theme.colors.textPrimary },
                ]}
              >
                Return home
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    marginTop: 'auto',
    width: '100%',
  },
  content: {
    flexGrow: 1,
    gap: 20,
    padding: 20,
    width: '100%',
  },
  eventType: {
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 27,
  },
  heading: {
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 38,
  },
  page: {
    flex: 1,
    width: '100%',
  },
  pressed: {
    opacity: 0.72,
  },
  primaryAction: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryActionText: {
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  result: {
    borderRadius: 18,
    borderWidth: 2,
    gap: 12,
    padding: 20,
    width: '100%',
  },
  secondaryAction: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  secondaryActionText: {
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  status: {
    fontSize: 17,
    lineHeight: 25,
  },
  truth: {
    fontSize: 15,
    lineHeight: 22,
  },
});
