import type {
  ActivationPreview,
  RosterPopulation,
  TemplateMode,
} from '@psd-eoc/contracts';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ClassificationBanner } from '../classification-banner';
import { getEventTheme } from '../../theme/event-theme';

export interface ActivationConfirmationProps {
  readonly activeEventCount?: number;
  readonly blockingMessages?: readonly string[];
  readonly busy?: boolean;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly eventTypeName: string;
  readonly facilityName: string;
  readonly mode: TemplateMode;
  readonly onConfirm: () => void;
  readonly recipientCount: number;
  readonly rosterPopulation: RosterPopulation;
  readonly sendReadiness: ActivationPreview['sendReadiness'];
  readonly testID?: string;
}

export function activationAudienceLabel(
  recipientCount: number,
  rosterPopulation: RosterPopulation,
): string {
  if (rosterPopulation === 'synthetic') {
    return `${recipientCount} synthetic recipient${recipientCount === 1 ? '' : 's'}`;
  }
  return `${recipientCount} selected staff member${recipientCount === 1 ? '' : 's'}`;
}

/**
 * Third-tap consequence confirmation. Active-event joins can be rendered in
 * `children`; when any exist, the final action explicitly says “separate.”
 */
export function ActivationConfirmation({
  activeEventCount = 0,
  blockingMessages = [],
  busy = false,
  children,
  disabled = false,
  eventTypeName,
  facilityName,
  mode,
  onConfirm,
  recipientCount,
  rosterPopulation,
  sendReadiness,
  testID,
}: ActivationConfirmationProps) {
  const theme = getEventTheme(mode);
  const real = mode === 'real';
  const classification = real ? 'REAL INCIDENT' : 'DRILL — PRACTICE';
  const audience = activationAudienceLabel(recipientCount, rosterPopulation);
  const separate = activeEventCount > 0;
  const blocked = sendReadiness === 'blocked';
  const unavailable = disabled || busy || blocked;
  const action = `${separate ? 'Start a separate ' : 'Start '}${
    real ? 'REAL incident' : 'DRILL — PRACTICE'
  } and record notification intents for ${audience}`;

  return (
    <View style={styles.container}>
      <ClassificationBanner mode={mode} />

      <View
        style={[
          styles.summary,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text accessibilityRole="header" style={styles.summaryHeading}>
          Review and confirm
        </Text>
        <Text style={[styles.summaryText, { color: theme.colors.textPrimary }]}>
          {eventTypeName} at {facilityName}
        </Text>
        <Text style={[styles.audience, { color: theme.colors.textPrimary }]}>
          {audience}
        </Text>
        <Text style={[styles.supporting, { color: theme.colors.textMuted }]}>
          Reaching this screen has not started an event or queued a
          notification.
        </Text>
      </View>

      {separate ? (
        <View
          accessibilityLiveRegion="polite"
          style={[
            styles.activeChoice,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text accessibilityRole="header" style={styles.activeChoiceHeading}>
            {activeEventCount === 1
              ? 'An event is already active here'
              : 'Events are already active here'}
          </Text>
          <Text style={styles.activeChoiceBody}>
            Choose explicitly: join an existing event below, or start a separate
            event with another set of notification intents.
          </Text>
        </View>
      ) : null}

      {children}

      {blocked ? (
        <View
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.blocked}
        >
          <Text style={styles.blockedHeading}>Notifications are not ready</Text>
          <Text style={styles.blockedText}>
            No event can be started from this preview. Nothing was queued.
          </Text>
          {blockingMessages.map((message) => (
            <Text key={message} style={styles.blockedText}>
              • {message}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.confirmation}>
        <Text accessibilityRole="header" style={styles.confirmationHeading}>
          Confirm the consequence
        </Text>
        <Text style={styles.confirmationBody}>
          This will start a {classification} at {facilityName} and record
          notification intents for {audience}.
        </Text>
        <Pressable
          accessibilityHint="Final human confirmation. PSD EOC will not queue an automatic retry."
          accessibilityLabel={busy ? `${action}. Starting once.` : action}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: unavailable }}
          disabled={unavailable}
          onPress={onConfirm}
          style={({ pressed }) => [
            styles.confirmButton,
            { backgroundColor: theme.colors.bannerBackground },
            pressed && styles.pressed,
            unavailable && styles.unavailable,
          ]}
          testID={testID}
        >
          <Text
            style={[styles.confirmButtonText, { color: theme.colors.onBanner }]}
          >
            {busy ? `Starting ${classification} once…` : action}
          </Text>
        </Pressable>
        <Text style={styles.neverQueue}>
          PSD EOC never queues this activation for an automatic retry.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  activeChoice: {
    borderRadius: 16,
    borderWidth: 2,
    gap: 6,
    padding: 16,
  },
  activeChoiceBody: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  activeChoiceHeading: {
    color: '#102A43',
    fontSize: 19,
    fontWeight: '900',
    lineHeight: 25,
  },
  audience: {
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  blocked: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
    borderRadius: 16,
    borderWidth: 2,
    gap: 6,
    padding: 16,
  },
  blockedHeading: {
    color: '#6B101B',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  blockedText: {
    color: '#6B101B',
    fontSize: 15,
    lineHeight: 21,
  },
  confirmation: {
    gap: 12,
  },
  confirmationBody: {
    color: '#334E68',
    fontSize: 16,
    lineHeight: 24,
  },
  confirmationHeading: {
    color: '#102A43',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 29,
  },
  confirmButton: {
    alignItems: 'center',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  confirmButtonText: {
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
    textAlign: 'center',
  },
  container: {
    gap: 18,
    width: '100%',
  },
  neverQueue: {
    color: '#486581',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
  summary: {
    borderRadius: 16,
    borderWidth: 2,
    gap: 8,
    padding: 16,
  },
  summaryHeading: {
    color: '#102A43',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 26,
  },
  summaryText: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 23,
  },
  supporting: {
    fontSize: 14,
    lineHeight: 20,
  },
  unavailable: {
    opacity: 0.55,
  },
});
