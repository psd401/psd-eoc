import type {
  ActivationPreview,
  EventKind,
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
  readonly channels: ActivationPreview['channels'];
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly eventTypeName: string;
  readonly eventKind: EventKind;
  readonly facilityName: string;
  readonly mode: TemplateMode;
  readonly onConfirm: () => void;
  readonly recipientCount: number;
  readonly rosterPopulation: RosterPopulation;
  readonly sendReadiness: ActivationPreview['sendReadiness'];
  readonly testID?: string;
  /** The chosen threat, with the operator's words when it required them. */
  readonly threatLabel: string;
}

type PreviewChannel = ActivationPreview['channels'][number];

function channelName(channel: PreviewChannel['channel']): string {
  switch (channel) {
    case 'push':
      return 'Push notifications';
    case 'email':
      return 'Email';
    case 'sms':
      return 'Text messages';
  }
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

/** Hides internal readiness tokens behind one bounded recovery instruction. */
export function publicBlockingMessages(
  reasonCodes: readonly string[],
): readonly string[] {
  return reasonCodes.length === 0
    ? []
    : [
        'One or more server prerequisites are unavailable. Refresh the preview; if it remains blocked, contact an administrator.',
      ];
}

/**
 * Third-tap consequence confirmation. Active-event joins can be rendered in
 * `children`; when any exist, the final action explicitly says “separate.”
 */
export function ActivationConfirmation({
  activeEventCount = 0,
  blockingMessages = [],
  busy = false,
  channels,
  children,
  disabled = false,
  eventTypeName,
  eventKind,
  facilityName,
  mode,
  onConfirm,
  recipientCount,
  rosterPopulation,
  sendReadiness,
  testID,
  threatLabel,
}: ActivationConfirmationProps) {
  const theme = getEventTheme(mode, eventKind);
  const classification = theme.classificationWord;
  const audience = activationAudienceLabel(recipientCount, rosterPopulation);
  const separate = activeEventCount > 0;
  const blocked = sendReadiness === 'blocked';
  const unavailable = disabled || busy || blocked;
  const action = `${separate ? 'Start a separate ' : 'Start '}${classification} and notify ${audience}`;

  return (
    <View style={styles.container}>
      <ClassificationBanner kind={eventKind} mode={mode} />

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
        <Text style={[styles.summaryText, { color: theme.colors.textPrimary }]}>
          Threat: {threatLabel}
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
            Join the event below, or start a separate one that notifies staff
            again.
          </Text>
        </View>
      ) : null}

      {children}

      <View style={styles.consequences}>
        <Text accessibilityRole="header" style={styles.consequencesHeading}>
          Who gets notified
        </Text>
        <Text style={styles.consequencesIntroduction}>
          {/* Reach, not copy. The operator is deciding whether to start an
              event; the wording is configured per response and is not
              theirs to change here, so printing every rendered body buried
              the decision under boilerplate. */}
          Starting this {classification} notifies staff on these channels.
        </Text>

        {channels.map((channel) => {
          const friendlyChannelName = channelName(channel.channel);

          return (
            <View
              key={channel.channel}
              style={[
                styles.channelCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Text
                accessibilityLabel={`${classification}, ${friendlyChannelName} consequence`}
                accessibilityRole="header"
                style={[
                  styles.channelHeading,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {classification} · {friendlyChannelName}
              </Text>
              <Text style={styles.fact}>
                <Text style={styles.factLabel}>Reaches: </Text>
                {channel.endpointCount}
              </Text>
            </View>
          );
        })}

        {channels.some((channel) => channel.channel === 'sms') ? null : (
          <View
            style={[
              styles.channelCard,
              styles.channelCardDisabled,
              { borderColor: theme.colors.border },
            ]}
          >
            <Text accessibilityRole="header" style={styles.channelHeading}>
              Text messages
            </Text>
            <Text style={styles.fact}>
              <Text style={styles.factLabel}>Not included. </Text>
              Text messaging is not enabled for this preview.
            </Text>
            <Text style={styles.fact}>No text message is sent.</Text>
          </View>
        )}

        <Text style={styles.endpointTruth}>
          Counts are the people PSD EOC can reach, not the people who have read
          it.
        </Text>
      </View>

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
          Start this {mode === 'real' ? 'incident' : 'drill'}
        </Text>
        <Text style={styles.confirmationBody}>
          Starts a {classification} at {facilityName} and notifies {audience}.
        </Text>
        <Pressable
          accessibilityHint="Starts the event and notifies staff on the channels shown above."
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
  consequences: {
    gap: 12,
  },
  consequencesHeading: {
    color: '#102A43',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 29,
  },
  consequencesIntroduction: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  channelCard: {
    borderRadius: 16,
    borderWidth: 2,
    gap: 8,
    padding: 16,
  },
  channelCardDisabled: {
    backgroundColor: '#EDF2F7',
  },
  channelHeading: {
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
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
  fact: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  factLabel: {
    color: '#102A43',
    fontWeight: '900',
  },
  endpointTruth: {
    color: '#486581',
    fontSize: 14,
    lineHeight: 20,
  },
  messageField: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  messageHeading: {
    color: '#102A43',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 22,
    marginTop: 4,
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
