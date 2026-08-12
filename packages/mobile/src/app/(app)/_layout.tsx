import { Redirect, Stack, type Href } from 'expo-router';

import { useMobileAuth } from '../../lib/auth';

/** Defense-in-depth guard for every authenticated mobile application route. */
export default function AuthenticatedAppLayout() {
  const { hasCachedShell, state } = useMobileAuth();

  if (!hasCachedShell) {
    const destination =
      state.phase === 'booting' || state.phase === 'locked'
        ? '/unlock'
        : '/sign-in';
    return <Redirect href={destination as Href} />;
  }

  return (
    <Stack
      screenOptions={{
        headerBackTitle: 'Events',
        headerTintColor: '#17324D',
        headerTitleStyle: { fontWeight: '800' },
      }}
    >
      <Stack.Screen
        name="events/[id]/index"
        options={{ title: 'Event room' }}
      />
    </Stack>
  );
}
