import type { TemplateMode } from '@psd-eoc/contracts';
import { Link, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassificationBanner } from '../components/classification-banner';
import { getEventTheme } from '../theme/event-theme';

interface PreviewLinkProps {
  readonly href: Href;
  readonly mode: TemplateMode;
}

function PreviewLink({ href, mode }: PreviewLinkProps) {
  const theme = getEventTheme(mode);

  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityHint={`Opens the ${theme.classificationWord.toLowerCase()} visual preview`}
        accessibilityLabel={`${theme.classificationWord}. View this visual state`}
        accessibilityRole="link"
        style={({ pressed }) => [
          styles.previewLink,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
          pressed && styles.pressed,
        ]}
      >
        <ClassificationBanner compact mode={mode} />
        <Text style={[styles.linkCopy, { color: theme.colors.textPrimary }]}>
          View this visual state
        </Text>
      </Pressable>
    </Link>
  );
}

export default function HomeScreen() {
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.page}
      >
        <View style={styles.introduction}>
          <Text style={styles.eyebrow}>PENINSULA SCHOOL DISTRICT</Text>
          <Text style={styles.title}>PSD EOC</Text>
          <Text style={styles.subtitle}>
            Emergency notification and operations mobile foundation
          </Text>
        </View>

        <View accessibilityRole="summary" style={styles.notice}>
          <Text style={styles.noticeTitle}>Scaffold preview</Text>
          <Text style={styles.noticeBody}>
            These links demonstrate classification styling and navigation only.
            No incident, drill, or notification can be started here.
          </Text>
        </View>

        <View style={styles.previews}>
          <PreviewLink href="/preview/real" mode="real" />
          <PreviewLink href="/preview/drill" mode="drill" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  content: {
    gap: 24,
    padding: 20,
    paddingBottom: 40,
  },
  introduction: {
    gap: 6,
    paddingTop: 8,
  },
  eyebrow: {
    color: '#3B5874',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
  },
  title: {
    color: '#102A43',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -0.5,
    lineHeight: 43,
  },
  subtitle: {
    color: '#486581',
    fontSize: 17,
    lineHeight: 25,
  },
  notice: {
    backgroundColor: '#E8F1F8',
    borderColor: '#9DB8CF',
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 18,
  },
  noticeTitle: {
    color: '#102A43',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 23,
  },
  noticeBody: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  previews: {
    gap: 18,
  },
  previewLink: {
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 12,
  },
  linkCopy: {
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 21,
    paddingHorizontal: 4,
    paddingBottom: 2,
  },
  pressed: {
    opacity: 0.72,
  },
});
