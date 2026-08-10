import type { TemplateMode } from '@psd-eoc/contracts';
import { StyleSheet, Text, View } from 'react-native';

import { getEventTheme } from '../theme/event-theme';

export interface ClassificationBannerProps {
  readonly mode: TemplateMode;
  readonly compact?: boolean;
}

/** Color, word, and icon classification treatment shared by every screen. */
export function ClassificationBanner({
  mode,
  compact = false,
}: ClassificationBannerProps) {
  const theme = getEventTheme(mode);

  return (
    <View
      accessibilityLabel={`${theme.classificationWord}. ${theme.explanation}`}
      accessibilityRole="header"
      accessible
      style={[
        styles.banner,
        compact ? styles.compactBanner : styles.fullBanner,
        {
          backgroundColor: theme.colors.bannerBackground,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.icon,
          {
            borderColor: theme.colors.onBanner,
          },
        ]}
      >
        <Text
          style={[
            styles.iconGlyph,
            {
              color: theme.colors.onBanner,
            },
          ]}
        >
          {theme.icon.glyph}
        </Text>
      </View>
      <View style={styles.copy}>
        <Text
          style={[
            compact ? styles.compactWord : styles.classificationWord,
            {
              color: theme.colors.onBanner,
            },
          ]}
        >
          {theme.classificationWord}
        </Text>
        {!compact && (
          <Text
            style={[
              styles.explanation,
              {
                color: theme.colors.onBanner,
              },
            ]}
          >
            {theme.explanation}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: 'center',
    borderWidth: 2,
    flexDirection: 'row',
    width: '100%',
  },
  compactBanner: {
    borderRadius: 14,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  fullBanner: {
    borderRadius: 20,
    gap: 16,
    padding: 20,
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
  copy: {
    flex: 1,
    gap: 4,
  },
  classificationWord: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 0.8,
    lineHeight: 28,
  },
  compactWord: {
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0.6,
    lineHeight: 22,
  },
  explanation: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
  },
});
