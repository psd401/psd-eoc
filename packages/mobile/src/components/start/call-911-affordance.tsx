import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

const DIALER_URL = 'tel:911';

export interface Call911AffordanceProps {
  readonly onOpenDialer?: () => Promise<void> | void;
  readonly testID?: string;
}

/**
 * Explicit human-controlled dialer affordance. It never runs on mount and does
 * not claim that PSD EOC contacts or dispatches 911.
 */
export function Call911Affordance({
  onOpenDialer,
  testID = 'call-911-first',
}: Call911AffordanceProps) {
  const [error, setError] = useState<string | null>(null);

  async function openDialer() {
    setError(null);
    try {
      if (onOpenDialer === undefined) {
        await Linking.openURL(DIALER_URL);
      } else {
        await onOpenDialer();
      }
    } catch {
      setError(
        'The phone dialer could not be opened. Call 911 from your phone.',
      );
    }
  }

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityHint="Opens your phone dialer with 911. PSD EOC does not contact 911."
        accessibilityLabel="Call 911 first"
        accessibilityRole="link"
        hitSlop={4}
        onPress={() => {
          void openDialer();
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        testID={testID}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.icon}
        >
          <Text style={styles.iconText}>911</Text>
        </View>
        <View style={styles.copy}>
          <Text style={styles.linkText}>Call 911 first</Text>
          <Text style={styles.bodyText}>
            PSD EOC notifies staff; it does not contact 911.
          </Text>
        </View>
      </Pressable>
      {error === null ? null : (
        <Text
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 21,
  },
  container: {
    gap: 8,
    width: '100%',
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  error: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
    borderRadius: 10,
    borderWidth: 1,
    color: '#6B101B',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
    padding: 12,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: '#7A1020',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 56,
    paddingHorizontal: 8,
  },
  iconText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  linkText: {
    color: '#7A1020',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.72,
  },
  row: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#B42332',
    borderRadius: 16,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 14,
    minHeight: 72,
    padding: 12,
    width: '100%',
  },
});
