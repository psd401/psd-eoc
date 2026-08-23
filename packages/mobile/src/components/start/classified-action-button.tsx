import type { EventKind, TemplateMode } from '@psd-eoc/contracts';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';

import { getEventTheme } from '../../theme/event-theme';

export interface ClassifiedActionButtonProps {
  readonly accessibilityHint: string;
  readonly accessibilityLabel?: string;
  readonly busy?: boolean;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly emphasis?: 'primary' | 'secondary';
  readonly kind?: EventKind;
  readonly mode: TemplateMode;
  readonly onPress: (event: GestureResponderEvent) => void;
  readonly testID?: string;
  readonly title: string;
}

/**
 * Large classification-aware action with a 48dp minimum target. The visible
 * word and icon repeat mode so the distinction never relies on color alone.
 */
export function ClassifiedActionButton({
  accessibilityHint,
  accessibilityLabel,
  busy = false,
  detail,
  disabled = false,
  emphasis = 'secondary',
  kind,
  mode,
  onPress,
  testID,
  title,
}: ClassifiedActionButtonProps) {
  const theme = getEventTheme(mode, kind);
  const unavailable = disabled || busy;
  const primary = emphasis === 'primary';
  const foreground = primary ? theme.colors.onBanner : theme.colors.textPrimary;
  const secondaryForeground = primary
    ? theme.colors.onBanner
    : theme.colors.textMuted;

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={
        accessibilityLabel ??
        `${theme.classificationWord}. ${title}${detail === undefined ? '' : `. ${detail}`}`
      }
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: unavailable }}
      disabled={unavailable}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary
            ? theme.colors.bannerBackground
            : theme.colors.surface,
          borderColor: theme.colors.border,
        },
        pressed && styles.pressed,
        unavailable && styles.unavailable,
      ]}
      testID={testID}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.icon,
          {
            borderColor: foreground,
          },
        ]}
      >
        <Text style={[styles.iconGlyph, { color: foreground }]}>
          {theme.icon.glyph}
        </Text>
      </View>
      <View style={styles.copy}>
        <Text style={[styles.classification, { color: foreground }]}>
          {theme.classificationWord}
        </Text>
        <Text style={[styles.title, { color: foreground }]}>{title}</Text>
        {detail === undefined ? null : (
          <Text style={[styles.detail, { color: secondaryForeground }]}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 14,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 14,
    width: '100%',
  },
  classification: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.7,
    lineHeight: 18,
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  detail: {
    fontSize: 15,
    lineHeight: 21,
  },
  icon: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 2,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  iconGlyph: {
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 28,
  },
  pressed: {
    opacity: 0.72,
  },
  title: {
    fontSize: 19,
    fontWeight: '900',
    lineHeight: 25,
  },
  unavailable: {
    opacity: 0.55,
  },
});
