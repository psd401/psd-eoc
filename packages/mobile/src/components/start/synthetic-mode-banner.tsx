import { StyleSheet, Text, View } from 'react-native';

import { ISSUE_21_MAESTRO_IDS } from './test-ids';

/** Fail-visible marker used by synthetic test builds and the guarded Maestro flows. */
export function SyntheticModeBanner() {
  return (
    <View
      accessibilityLabel="Synthetic test mode. Synthetic recipients only. No live provider sends."
      accessibilityRole="header"
      accessible
      style={styles.banner}
      testID={ISSUE_21_MAESTRO_IDS.syntheticMode}
    >
      <Text style={styles.title}>SYNTHETIC TEST MODE</Text>
      <Text style={styles.body}>
        Synthetic recipients only. No live provider sends.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#FFF4D6',
    borderColor: '#9B6A00',
    borderRadius: 14,
    borderWidth: 2,
    gap: 3,
    paddingHorizontal: 16,
    paddingVertical: 12,
    width: '100%',
  },
  body: {
    color: '#5D3D00',
    fontSize: 14,
    lineHeight: 20,
  },
  title: {
    color: '#5D3D00',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.7,
    lineHeight: 20,
  },
});
