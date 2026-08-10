import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileAuth } from './auth-provider';

export function ConnectivityBanner() {
  const { state, retryConnection } = useMobileAuth();
  if (state.phase !== 'cached-checking' && state.phase !== 'offline-cached') {
    return null;
  }
  const checking = state.phase === 'cached-checking';
  const title = checking
    ? 'Checking secure connection'
    : 'Offline — cached view only';
  const body = checking
    ? 'Starting an incident and other changes are unavailable until the server check succeeds.'
    : 'Starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again.';

  return (
    <View
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
      style={styles.banner}
    >
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      {!checking && (
        <Pressable
          accessibilityHint="Checks the server and creates a fresh secure connection"
          accessibilityLabel="Retry secure connection"
          accessibilityRole="button"
          onPress={() => {
            void retryConnection();
          }}
          style={({ pressed }) => [
            styles.retryButton,
            pressed && styles.retryPressed,
          ]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: 'center',
    backgroundColor: '#FFF4D6',
    borderBottomColor: '#9B6A00',
    borderBottomWidth: 2,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: '#5D3D00',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 20,
  },
  body: {
    color: '#5D3D00',
    fontSize: 13,
    lineHeight: 18,
  },
  retryButton: {
    backgroundColor: '#17324D',
    borderRadius: 10,
    minHeight: 44,
    minWidth: 68,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  retryPressed: {
    opacity: 0.72,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
});
