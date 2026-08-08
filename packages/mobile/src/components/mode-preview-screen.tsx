import type { TemplateMode } from '@psd-eoc/contracts';
import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getEventTheme } from '../theme/event-theme';
import { ClassificationBanner } from './classification-banner';

export interface ModePreviewScreenProps {
  readonly mode: TemplateMode;
}

/** Read-only visual preview; it intentionally exposes no event mutation. */
export function ModePreviewScreen({ mode }: ModePreviewScreenProps) {
  const theme = getEventTheme(mode);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.pageBackground }}
    >
      <ClassificationBanner mode={mode} />

      <View
        style={[
          styles.previewCard,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text style={[styles.kicker, { color: theme.colors.textMuted }]}>
          VISUAL PREVIEW ONLY
        </Text>
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
          Classification is always visible
        </Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          PSD EOC repeats the classification with a distinct color, explicit
          wording, and icon. This scaffold cannot start an event or send a
          notification.
        </Text>
      </View>

      <Link href="/" asChild>
        <Pressable
          accessibilityHint="Returns to the PSD EOC home screen"
          accessibilityRole="link"
          style={({ pressed }) => [
            styles.homeLink,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[styles.homeLinkText, { color: theme.colors.textPrimary }]}
          >
            Return to home
          </Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 20,
    padding: 20,
    paddingBottom: 40,
  },
  previewCard: {
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  kicker: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 31,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
  },
  homeLink: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 2,
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  homeLinkText: {
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  pressed: {
    opacity: 0.72,
  },
});
