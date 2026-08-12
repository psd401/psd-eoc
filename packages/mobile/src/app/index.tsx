import type { JoinEventResult, TemplateMode } from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  ActivationResult,
  ActiveEventJoinAction,
  Call911Affordance,
  ISSUE_21_MAESTRO_IDS,
  StartModeAction,
  SyntheticModeBanner,
} from '../components/start';
import {
  OFFLINE_ACTION_MESSAGE,
  OfflineMutationDeniedError,
  useMobileAuth,
} from '../lib/auth';
import {
  createIdempotentSubmission,
  type IdempotentSubmissionController,
  isIssue21SyntheticFixtureEnabled,
  isStartMutationPending,
  join,
  loadStartHomeData,
  requestStartRouteNavigation,
  StartClientError,
  type StartHomeActiveEvent,
  type StartHomeData,
  useStartMutationHardwareBackGuard,
  useStartMutationNavigationGuard,
} from '../lib/start';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Los_Angeles',
});

const SYNTHETIC_FIXTURE_ENABLED = isIssue21SyntheticFixtureEnabled();

interface CompletedAction {
  readonly eventTypeName: string;
  readonly kind: 'joined';
  readonly mode: TemplateMode;
}

function publicLoadError(error: unknown): string {
  return error instanceof StartClientError
    ? error.message
    : 'PSD EOC could not load the current authorized sites and events. No action was taken.';
}

function publicJoinError(error: unknown): string {
  if (error instanceof OfflineMutationDeniedError) {
    return `${error.message} No event was joined and nothing was queued.`;
  }
  return error instanceof StartClientError
    ? error.message
    : 'The join outcome is unknown. Check the active-events list before making another decision. Nothing will retry automatically.';
}

function startedLabel(event: StartHomeActiveEvent): string {
  return DATE_FORMATTER.format(
    new Date(event.event.activatedAt ?? event.event.createdAt),
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { authenticatedRequest, retryConnection, state } = useMobileAuth();
  const [data, setData] = useState<StartHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedAction | null>(null);
  const joinInFlight = useRef(false);
  const joinSubmissions = useRef(
    new Map<string, IdempotentSubmissionController<JoinEventResult>>(),
  );
  const mutationPending = isStartMutationPending(joiningEventId);
  const announcePendingMutation = useCallback((message: string): void => {
    AccessibilityInfo.announceForAccessibility(message);
  }, []);
  const isMutationPendingNow = useCallback(
    () => joinInFlight.current || mutationPending,
    [mutationPending],
  );
  useStartMutationHardwareBackGuard(
    isMutationPendingNow,
    announcePendingMutation,
  );
  useStartMutationNavigationGuard(
    mutationPending && state.phase === 'online',
    announcePendingMutation,
  );

  const load = useCallback(() => {
    let active = true;
    if (state.phase !== 'online') {
      setData(null);
      setLoading(state.phase !== 'offline-cached');
      setLoadError(
        state.phase === 'offline-cached'
          ? `${state.message ?? OFFLINE_ACTION_MESSAGE} No event was started or joined, and nothing was queued.`
          : null,
      );
      return () => {
        active = false;
      };
    }
    setLoading(true);
    setLoadError(null);
    void loadStartHomeData(authenticatedRequest).then(
      (nextData) => {
        if (!active) return;
        joinSubmissions.current.clear();
        setData(nextData);
        setLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setData(null);
        setLoadError(publicLoadError(error));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [authenticatedRequest, state.message, state.phase]);

  useFocusEffect(load);

  function openStart(facilityId: string, mode: TemplateMode): void {
    requestStartRouteNavigation(
      joinInFlight.current || mutationPending,
      () => {
        router.push({
          pathname: '/start',
          params: { facilityId, mode },
        } as Href);
      },
      announcePendingMutation,
    );
  }

  async function joinExisting(choice: StartHomeActiveEvent): Promise<void> {
    if (joinInFlight.current) return;
    joinInFlight.current = true;
    setJoinError(null);
    let submission = joinSubmissions.current.get(choice.event.id);
    if (submission === undefined) {
      submission = createIdempotentSubmission(Crypto.randomUUID(), (key) =>
        join(authenticatedRequest, choice.event, key),
      );
      joinSubmissions.current.set(choice.event.id, submission);
    }
    setJoiningEventId(choice.event.id);
    try {
      const result = await submission.submit();
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => undefined);
      setCompleted({
        eventTypeName: choice.eventTypeName,
        kind: 'joined',
        mode: result.event.templateMode,
      });
    } catch (error) {
      setJoinError(publicJoinError(error));
    } finally {
      joinInFlight.current = false;
      setJoiningEventId(null);
    }
  }

  if (completed !== null) {
    return (
      <SafeAreaView style={styles.page}>
        <ActivationResult
          eventTypeName={completed.eventTypeName}
          kind={completed.kind}
          mode={completed.mode}
          onReturnHome={() => {
            setCompleted(null);
          }}
          {...(SYNTHETIC_FIXTURE_ENABLED
            ? { testID: ISSUE_21_MAESTRO_IDS.joinedResult }
            : {})}
        />
      </SafeAreaView>
    );
  }

  const onlyFacility =
    data?.facilities.length === 1 ? data.facilities[0] : null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.page}
      >
        <View style={styles.introduction}>
          <Text style={styles.eyebrow}>STAFF EMERGENCY OPERATIONS</Text>
          <Text accessibilityRole="header" style={styles.title}>
            PSD EOC
          </Text>
          <Text style={styles.subtitle}>
            Join an active event or make an explicit choice to start a separate
            incident or drill.
          </Text>
        </View>

        {SYNTHETIC_FIXTURE_ENABLED ? <SyntheticModeBanner /> : null}
        <Call911Affordance />

        {loading ? (
          <View
            accessibilityLabel="Loading current authorized sites and active events"
            accessibilityRole="progressbar"
            style={styles.loading}
          >
            <ActivityIndicator color="#175A8E" size="large" />
            <Text style={styles.loadingText}>Loading current operations</Text>
          </View>
        ) : null}

        {loadError === null ? null : (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.error}
          >
            <Text accessibilityRole="header" style={styles.errorHeading}>
              Current operations unavailable
            </Text>
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable
              accessibilityLabel={
                state.phase === 'offline-cached'
                  ? 'Reconnect and load current operations'
                  : 'Try loading current operations again'
              }
              accessibilityRole="button"
              onPress={() => {
                if (state.phase === 'offline-cached') {
                  void retryConnection();
                } else {
                  load();
                }
              }}
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.retryButtonText}>
                {state.phase === 'offline-cached' ? 'Reconnect' : 'Try again'}
              </Text>
            </Pressable>
          </View>
        )}

        {data === null ? null : (
          <>
            <View style={styles.section}>
              <View style={styles.sectionHeadingRow}>
                <Text accessibilityRole="header" style={styles.sectionHeading}>
                  Active events
                </Text>
                <Text
                  accessibilityLabel={`${data.activeEvents.length} active events`}
                  style={styles.count}
                >
                  {data.activeEvents.length}
                </Text>
              </View>
              {data.activeEvents.length === 0 ? (
                <Text accessibilityRole="summary" style={styles.emptyText}>
                  No events are active in your authorized sites.
                </Text>
              ) : (
                <View style={styles.cardList}>
                  {data.activeEvents.map((choice, index) => (
                    <ActiveEventJoinAction
                      busy={joiningEventId === choice.event.id}
                      disabled={joiningEventId !== null}
                      eventTypeName={choice.eventTypeName}
                      facilityName={choice.facilityName}
                      key={choice.event.id}
                      mode={choice.event.templateMode}
                      onPress={() => {
                        void joinExisting(choice);
                      }}
                      startedLabel={startedLabel(choice)}
                      {...(SYNTHETIC_FIXTURE_ENABLED && index === 0
                        ? { testID: ISSUE_21_MAESTRO_IDS.joinExisting }
                        : {})}
                    />
                  ))}
                </View>
              )}
            </View>

            {joinError === null ? null : (
              <View
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                style={styles.error}
              >
                <Text accessibilityRole="header" style={styles.errorHeading}>
                  Join needs attention
                </Text>
                <Text style={styles.errorText}>{joinError}</Text>
              </View>
            )}

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionHeading}>
                Start an event
              </Text>
              <Text style={styles.sectionIntro}>
                Choosing a site and mode does not start an event or notify
                anyone. A separate consequence confirmation is always required.
              </Text>

              {data.facilities.length === 0 ? (
                <View accessibilityRole="alert" style={styles.error}>
                  <Text style={styles.errorHeading}>
                    No active assigned site
                  </Text>
                  <Text style={styles.errorText}>
                    No event was started. Contact a PSD EOC administrator.
                  </Text>
                </View>
              ) : (
                <View style={styles.facilityList}>
                  {data.facilities.map((facility) => (
                    <View style={styles.facilityCard} key={facility.id}>
                      <Text style={styles.facilityCode}>{facility.code}</Text>
                      <Text
                        accessibilityRole="header"
                        style={styles.facilityName}
                      >
                        {facility.name}
                      </Text>
                      <StartModeAction
                        disabled={mutationPending}
                        facilityName={facility.name}
                        mode="real"
                        onPress={() => {
                          openStart(facility.id, 'real');
                        }}
                      />
                      <StartModeAction
                        disabled={mutationPending}
                        facilityName={facility.name}
                        mode="drill"
                        onPress={() => {
                          openStart(facility.id, 'drill');
                        }}
                        {...(SYNTHETIC_FIXTURE_ENABLED &&
                        onlyFacility?.id === facility.id
                          ? { testID: ISSUE_21_MAESTRO_IDS.startDrill }
                          : {})}
                      />
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cardList: {
    gap: 12,
  },
  content: {
    gap: 22,
    padding: 20,
    paddingBottom: 44,
  },
  count: {
    backgroundColor: '#D9EAF5',
    borderRadius: 999,
    color: '#17324D',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 21,
    minWidth: 34,
    paddingHorizontal: 10,
    paddingVertical: 5,
    textAlign: 'center',
  },
  emptyText: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 14,
    borderWidth: 1,
    color: '#334E68',
    fontSize: 16,
    lineHeight: 23,
    padding: 16,
  },
  error: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
    borderRadius: 16,
    borderWidth: 2,
    gap: 9,
    padding: 16,
  },
  errorHeading: {
    color: '#6B101B',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  errorText: {
    color: '#6B101B',
    fontSize: 15,
    lineHeight: 22,
  },
  eyebrow: {
    color: '#3B5874',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
  },
  facilityCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  facilityCode: {
    color: '#486581',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
    lineHeight: 17,
  },
  facilityList: {
    gap: 16,
  },
  facilityName: {
    color: '#102A43',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 29,
  },
  introduction: {
    gap: 6,
    paddingTop: 8,
  },
  loading: {
    alignItems: 'center',
    gap: 12,
    padding: 28,
  },
  loadingText: {
    color: '#334E68',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  pressed: {
    opacity: 0.72,
  },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#17324D',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 22,
  },
  section: {
    gap: 13,
  },
  sectionHeading: {
    color: '#102A43',
    flex: 1,
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 31,
  },
  sectionHeadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  sectionIntro: {
    color: '#486581',
    fontSize: 15,
    lineHeight: 22,
  },
  subtitle: {
    color: '#486581',
    fontSize: 17,
    lineHeight: 25,
  },
  title: {
    color: '#102A43',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -0.5,
    lineHeight: 43,
  },
});
