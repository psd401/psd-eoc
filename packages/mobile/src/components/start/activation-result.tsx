import type { TemplateMode } from '@psd-eoc/contracts';
import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ClassificationBanner } from '../classification-banner';
import { getEventTheme } from '../../theme/event-theme';

export interface ActivationResultProps {
  readonly eventTypeName: string;
  readonly kind: 'activated' | 'joined';
  readonly mode: TemplateMode;
  readonly onOpenEvent?: () => void;
  readonly onReturnHome?: () => void;
  readonly testID?: string;
}

/**
 * Full-screen result content. Haptics intentionally remain a screen concern so
 * feedback occurs only after that screen validates the server result.
 */
export function ActivationResult({
  eventTypeName,
  kind,
  mode,
  onOpenEvent,
  onReturnHome,
  testID,
}: ActivationResultProps) {
  const announced = useRef(false);
  const theme = getEventTheme(mode);
  const activated = kind === 'activated';
  const heading = activated
    ? mode === 'real'
      ? 'Incident started'
      : 'Drill started'
    : 'Event joined';
  const status = activated
    ? `PSD EOC durably accepted the ${mode === 'real' ? 'incident' : 'drill'} and recorded its notification intent.`
    : 'You joined the existing event. Joining did not create another event or notification.';

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    AccessibilityInfo.announceForAccessibility(
      `${heading}. ${theme.classificationWord}. ${eventTypeName}. ${status}`,
    );
  }, [eventTypeName, heading, status, theme.classificationWord]);

  return (
    <View
      style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
      testID={testID}
    >
      <ClassificationBanner mode={mode} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
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
    gap: 20,
    padding: 20,
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
