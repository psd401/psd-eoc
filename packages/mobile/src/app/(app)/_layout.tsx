import { Redirect, Stack, useRouter, type Href } from 'expo-router';
import { Pressable, Text, StyleSheet } from 'react-native';

import { useMobileAuth } from '../../lib/auth';

/**
 * Always leaves the event room, whether or not there is history behind it.
 *
 * This stack holds the event room alone, so a room opened from a push
 * notification is its own root and the navigator renders no back control. An
 * operator who ended an event then had no way out of the room at all and had to
 * force-quit the app. Going back is still preferred when there is somewhere to
 * go back to, so the ordinary path keeps its behaviour.
 */
export function LeaveEventRoomButton() {
  const router = useRouter();
  return (
    <Pressable
      accessibilityHint="Leaves the event room and returns to the event list"
      accessibilityLabel="Events"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => {
        if (router.canGoBack()) {
          router.back();
          return;
        }
        router.replace('/' as Href);
      }}
      style={({ pressed }) => [styles.leave, pressed && styles.pressed]}
    >
      <Text style={styles.leaveText}>Events</Text>
    </Pressable>
  );
}

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
        options={{
          title: 'Event room',
          headerLeft: () => <LeaveEventRoomButton />,
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  leave: {
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  leaveText: {
    color: '#17324D',
    fontSize: 17,
    fontWeight: '700',
  },
});
