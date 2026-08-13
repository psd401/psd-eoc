import type { FanoutStatus } from '@psd-eoc/contracts';
import { StyleSheet, Text, View } from 'react-native';

export interface FanoutControlBannerProps {
  readonly state: FanoutStatus | null;
}

/** True only when a verified current record explicitly enables fanout. */
export function isFanoutActivationEnabled(state: FanoutStatus | null): boolean {
  return state?.status === 'enabled';
}

/**
 * Fail-visible, read-only activation status. It deliberately contains no
 * button, mutation, approval control, or protected lifecycle action.
 */
export function FanoutControlBanner({ state }: FanoutControlBannerProps) {
  if (isFanoutActivationEnabled(state)) return null;

  const checking = state === null;
  const explicitlyDisabled = state?.status === 'emergency-disabled';
  const title = checking
    ? 'Checking notification controls'
    : explicitlyDisabled
      ? 'Emergency notification fanout disabled'
      : 'Notification controls unavailable';
  const body = checking
    ? 'New incident and drill activation remains blocked until PSD EOC verifies the current notification control state.'
    : explicitlyDisabled
      ? 'New incident and drill activation is blocked. Nothing will be queued for later. Existing active events remain available.'
      : 'PSD EOC cannot verify that notification fanout is enabled. New incident and drill activation is blocked. Nothing will be queued for later. Contact District Technology.';

  return (
    <View
      accessibilityLabel={`${title}. ${body}`}
      accessibilityLiveRegion={checking ? 'polite' : 'assertive'}
      accessibilityRole={checking ? 'progressbar' : 'alert'}
      accessible
      style={[styles.banner, checking ? styles.checking : styles.blocked]}
      testID="fanout-control-status"
    >
      <Text style={[styles.title, checking ? styles.checkingText : null]}>
        {title}
      </Text>
      <Text style={[styles.body, checking ? styles.checkingText : null]}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 16,
    borderWidth: 3,
    gap: 8,
    padding: 16,
    width: '100%',
  },
  blocked: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
  },
  body: {
    color: '#6B101B',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 23,
  },
  checking: {
    backgroundColor: '#FFF4D6',
    borderColor: '#9B6A00',
  },
  checkingText: {
    color: '#5D3D00',
  },
  title: {
    color: '#6B101B',
    fontSize: 19,
    fontWeight: '900',
    lineHeight: 25,
  },
});
