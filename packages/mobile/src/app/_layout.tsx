import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { configureAlertChannel } from '../notifications/alert-channel';

export default function RootLayout() {
  useEffect(() => {
    void configureAlertChannel().catch(() => {
      console.error('Failed to configure the Android alert channel.');
    });
  }, []);

  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Home',
        headerTintColor: '#17324D',
        headerTitleStyle: {
          fontWeight: '800',
        },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'PSD EOC' }} />
      <Stack.Screen
        name="preview/real"
        options={{ title: 'Real incident preview' }}
      />
      <Stack.Screen name="preview/drill" options={{ title: 'Drill preview' }} />
    </Stack>
  );
}
