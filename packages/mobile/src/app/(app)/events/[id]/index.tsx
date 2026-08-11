import { EventIdSchema } from '@psd-eoc/contracts';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EventRoomScreen } from '../../../../features/event-room/event-room-screen';

export default function EventRoomRoute() {
  const parameters = useLocalSearchParams<{ id?: string | string[] }>();
  const parsed =
    typeof parameters.id === 'string'
      ? EventIdSchema.safeParse(parameters.id)
      : { success: false as const };

  if (!parsed.success) {
    return (
      <SafeAreaView style={styles.page}>
        <View accessibilityRole="alert" style={styles.message}>
          <Text style={styles.title}>Invalid event link</Text>
          <Text style={styles.body}>
            This link does not identify a PSD EOC event. Return to the event
            list and open it again.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return <EventRoomScreen eventId={parsed.data} />;
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  message: {
    alignItems: 'center',
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#102A43',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 29,
    textAlign: 'center',
  },
  body: {
    color: '#486581',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
});
