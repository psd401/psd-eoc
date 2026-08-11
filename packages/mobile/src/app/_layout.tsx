import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { AuthProvider, ConnectivityBanner, useMobileAuth } from '../lib/auth';
import { configureAlertChannel } from '../notifications/alert-channel';

function AuthenticatedStack() {
  const { hasCachedShell, state } = useMobileAuth();
  const showUnlock =
    !hasCachedShell && (state.phase === 'booting' || state.phase === 'locked');
  const showSignIn =
    !hasCachedShell &&
    (state.phase === 'signed-out' || state.phase === 'blocked');

  return (
    <View style={styles.shell}>
      <ConnectivityBanner />
      <Stack
        screenOptions={{
          headerBackTitle: 'Home',
          headerTintColor: '#17324D',
          headerTitleStyle: {
            fontWeight: '800',
          },
        }}
      >
        <Stack.Protected guard={hasCachedShell}>
          <Stack.Screen name="index" options={{ title: 'PSD EOC' }} />
          <Stack.Screen
            name="start/index"
            options={{ headerShown: false, title: 'Start event' }}
          />
          <Stack.Screen
            name="preview/real"
            options={{ title: 'Real incident preview' }}
          />
          <Stack.Screen
            name="preview/drill"
            options={{ title: 'Drill preview' }}
          />
        </Stack.Protected>

        <Stack.Protected guard={showUnlock}>
          <Stack.Screen
            name="(auth)/unlock"
            options={{ headerShown: false, title: 'Unlock PSD EOC' }}
          />
        </Stack.Protected>

        <Stack.Protected guard={showSignIn}>
          <Stack.Screen
            name="(auth)/sign-in"
            options={{ headerShown: false, title: 'Sign in to PSD EOC' }}
          />
        </Stack.Protected>
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void configureAlertChannel().catch(() => {
      console.error('Failed to configure the Android alert channel.');
    });
  }, []);

  return (
    <AuthProvider>
      <AuthenticatedStack />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
});
