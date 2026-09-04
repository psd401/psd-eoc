import type { TemplateMode } from '@psd-eoc/contracts';
import * as Haptics from 'expo-haptics';
import {
  type Href,
  useFocusEffect,
  useIsFocused,
  useRouter,
} from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  announceActivationResult,
  ActiveEventJoinAction,
  Call911Affordance,
  ISSUE_21_MAESTRO_IDS,
  OtherSessionStartMutationAttention,
  StartModeAction,
  StartMutationAttention,
  StartMutationRecoveryBlockedAttention,
  StartMutationRecoveryCheckingAttention,
  SyntheticModeBanner,
} from '../components/start';
import { OFFLINE_ACTION_MESSAGE, useMobileAuth } from '../lib/auth';
import {
  deliverClaimedStartMutationSuccessFeedback,
  isIssue21SyntheticFixtureEnabled,
  loadStartHomeData,
  requestStartRouteNavigation,
  StartClientError,
  type StartHomeActiveEvent,
  type StartHomeData,
  useStartMutation,
  useStartMutationHardwareBackGuard,
  useStartMutationNavigationGuard,
} from '../lib/start';
import { SMS_CONSENT_TEST_IDS } from '../features/sms-consent/sms-consent-screen';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Los_Angeles',
});

const SYNTHETIC_FIXTURE_ENABLED = isIssue21SyntheticFixtureEnabled();

function publicLoadError(error: unknown): string {
  return error instanceof StartClientError
    ? error.message
    : 'PSD EOC could not load the current authorized sites and events. No action was taken.';
}

export function unresolvedOutcomeRefreshError(): string {
  return 'PSD EOC could not load fresh active events. This refresh did not determine the earlier request outcome. That outcome remains unresolved, and nothing retried automatically.';
}

function startedLabel(event: StartHomeActiveEvent): string {
  return DATE_FORMATTER.format(
    new Date(event.event.activatedAt ?? event.event.createdAt),
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { requestAuthenticated, retryConnection, state } = useMobileAuth();
  const startMutation = useStartMutation();
  const [data, setData] = useState<StartHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [outcomeCheckError, setOutcomeCheckError] = useState<string | null>(
    null,
  );
  const [outcomeActiveEvents, setOutcomeActiveEvents] = useState<
    readonly StartHomeActiveEvent[] | null
  >(null);
  const outcomeRequestGeneration = useRef(0);
  const outcomeOwnerKey =
    state.phase === 'online' && state.session !== null
      ? [
          state.session.user.id,
          state.session.session.id,
          state.session.deviceEnrollment.id,
        ].join(':')
      : null;
  const outcomeOwnerKeyRef = useRef<string | null>(outcomeOwnerKey);
  outcomeOwnerKeyRef.current = outcomeOwnerKey;
  const outcomeFocusedRef = useRef(isFocused);
  outcomeFocusedRef.current = isFocused;
  const mutationPending = startMutation.snapshot.phase === 'pending';
  const announcePendingMutation = useCallback((message: string): void => {
    AccessibilityInfo.announceForAccessibility(message);
  }, []);
  const isMutationPendingNow = useCallback(
    () => startMutation.isPendingNow(),
    [startMutation],
  );
  useStartMutationHardwareBackGuard(
    isMutationPendingNow,
    announcePendingMutation,
  );
  useStartMutationNavigationGuard(
    mutationPending && state.phase === 'online',
    announcePendingMutation,
  );
  useEffect(() => {
    if (!isFocused) return;
    deliverClaimedStartMutationSuccessFeedback(
      startMutation.claimSuccessFeedback,
      {
        announce: (completion) => {
          announceActivationResult(completion);
        },
        haptic: () =>
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
      },
    );
  }, [isFocused, startMutation]);

  useEffect(() => {
    outcomeRequestGeneration.current += 1;
    setCheckingOutcome(false);
    setOutcomeCheckError(null);
    setOutcomeActiveEvents(null);
    return () => {
      outcomeRequestGeneration.current += 1;
    };
  }, [requestAuthenticated, isFocused, state.phase, state.session?.session.id]);

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
    void loadStartHomeData(requestAuthenticated).then(
      (nextData) => {
        if (!active) return;
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
  }, [requestAuthenticated, state.message, state.phase]);

  useFocusEffect(load);

  function openStart(facilityId: string, mode: TemplateMode): void {
    requestStartRouteNavigation(
      startMutation.isPendingNow(),
      () => {
        router.push({
          pathname: '/start',
          params: { facilityId, mode },
        } as unknown as Href);
      },
      announcePendingMutation,
    );
  }

  function joinExisting(choice: StartHomeActiveEvent): void {
    const admission = startMutation.submitJoin({ choice });
    if (admission.accepted) {
      void admission.completion;
    }
  }

  const mutationSnapshot = startMutation.snapshot;

  // Starting or joining opens the event room. A confirmation screen in between
  // is one more tap during the minute that matters most.
  useEffect(() => {
    if (!isFocused || mutationSnapshot.phase !== 'succeeded') return;
    const { eventId } = mutationSnapshot.completion;
    if (!startMutation.acknowledge()) return;
    router.push({
      pathname: '/events/[id]',
      params: { id: eventId },
    } as Href);
  }, [isFocused, mutationSnapshot, router, startMutation]);
  if (isFocused && mutationSnapshot.phase === 'checking-recovery') {
    return (
      <SafeAreaView style={styles.page}>
        <StartMutationRecoveryCheckingAttention />
      </SafeAreaView>
    );
  }
  if (isFocused && mutationSnapshot.phase === 'recovery-blocked') {
    return (
      <SafeAreaView style={styles.page}>
        <StartMutationRecoveryBlockedAttention
          message={mutationSnapshot.message}
        />
      </SafeAreaView>
    );
  }
  if (isFocused && mutationSnapshot.phase === 'succeeded') {
    return (
      <SafeAreaView style={styles.page}>
        <ActivationResult
          announceOnMount={false}
          eventKind={mutationSnapshot.completion.eventKind}
          eventTypeName={mutationSnapshot.completion.eventTypeName}
          kind={mutationSnapshot.completion.kind}
          mode={mutationSnapshot.completion.mode}
          onOpenEvent={() => {
            if (!startMutation.acknowledge()) return;
            router.push({
              pathname: '/events/[id]',
              params: { id: mutationSnapshot.completion.eventId },
            } as Href);
          }}
          onReturnHome={() => {
            startMutation.acknowledge();
          }}
          {...(SYNTHETIC_FIXTURE_ENABLED
            ? {
                testID:
                  mutationSnapshot.completion.kind === 'activated'
                    ? ISSUE_21_MAESTRO_IDS.activationResult
                    : ISSUE_21_MAESTRO_IDS.joinedResult,
              }
            : {})}
        />
      </SafeAreaView>
    );
  }

  if (
    isFocused &&
    mutationSnapshot.phase === 'pending' &&
    mutationSnapshot.visibility === 'pending-other-session'
  ) {
    return (
      <SafeAreaView style={styles.page}>
        <OtherSessionStartMutationAttention />
      </SafeAreaView>
    );
  }

  if (isFocused && mutationSnapshot.phase === 'unresolved-other-session') {
    return (
      <SafeAreaView style={styles.page}>
        <OtherSessionStartMutationAttention status="unresolved" />
      </SafeAreaView>
    );
  }

  if (
    isFocused &&
    (mutationSnapshot.phase === 'failed' ||
      mutationSnapshot.phase === 'unresolved' ||
      (mutationSnapshot.phase === 'pending' &&
        mutationSnapshot.visibility === 'owner'))
  ) {
    const failed = mutationSnapshot.phase === 'failed';
    const unresolved = mutationSnapshot.phase === 'unresolved';
    return (
      <SafeAreaView style={styles.page}>
        <StartMutationAttention
          eventKind={mutationSnapshot.eventKind}
          eventTypeName={mutationSnapshot.eventTypeName}
          mode={mutationSnapshot.mode}
          operation={mutationSnapshot.operation}
          {...(failed
            ? {
                checkError: outcomeCheckError,
                checking: checkingOutcome,
                failureMessage: mutationSnapshot.error.message,
                online: state.phase === 'online',
                onRefreshActiveEvents: () => {
                  if (checkingOutcome || state.phase !== 'online') return;
                  const requestGeneration =
                    outcomeRequestGeneration.current + 1;
                  outcomeRequestGeneration.current = requestGeneration;
                  const requestOwnerKey = outcomeOwnerKeyRef.current;
                  setCheckingOutcome(true);
                  setOutcomeCheckError(null);
                  void loadStartHomeData(requestAuthenticated).then(
                    (nextData) => {
                      if (
                        outcomeRequestGeneration.current !==
                          requestGeneration ||
                        requestOwnerKey === null ||
                        outcomeOwnerKeyRef.current !== requestOwnerKey ||
                        !outcomeFocusedRef.current
                      )
                        return;
                      setData(nextData);
                      setCheckingOutcome(false);
                      startMutation.acknowledge();
                    },
                    (error: unknown) => {
                      if (
                        outcomeRequestGeneration.current !==
                          requestGeneration ||
                        requestOwnerKey === null ||
                        outcomeOwnerKeyRef.current !== requestOwnerKey ||
                        !outcomeFocusedRef.current
                      )
                        return;
                      setOutcomeCheckError(publicLoadError(error));
                      setCheckingOutcome(false);
                    },
                  );
                },
                status: 'failed' as const,
              }
            : unresolved
              ? {
                  ...(outcomeActiveEvents === null
                    ? {}
                    : {
                        activeEvents: outcomeActiveEvents.map((choice) => ({
                          eventId: choice.event.id,
                          eventKind: choice.event.kind,
                          eventTypeName: choice.eventTypeName,
                          facilityName: choice.facilityName,
                          mode: choice.event.templateMode,
                          startedLabel: startedLabel(choice),
                        })),
                      }),
                  checkError: outcomeCheckError,
                  checking: checkingOutcome,
                  online: state.phase === 'online',
                  onCheckActiveEvents: () => {
                    if (checkingOutcome || state.phase !== 'online') return;
                    const requestGeneration =
                      outcomeRequestGeneration.current + 1;
                    outcomeRequestGeneration.current = requestGeneration;
                    const requestOwnerKey = outcomeOwnerKeyRef.current;
                    const operation = mutationSnapshot.operation;
                    setCheckingOutcome(true);
                    setOutcomeCheckError(null);
                    setOutcomeActiveEvents(null);
                    void loadStartHomeData(requestAuthenticated).then(
                      (nextData) => {
                        if (
                          outcomeRequestGeneration.current !==
                            requestGeneration ||
                          requestOwnerKey === null ||
                          outcomeOwnerKeyRef.current !== requestOwnerKey ||
                          !outcomeFocusedRef.current
                        )
                          return;
                        setData(nextData);
                        setOutcomeActiveEvents(nextData.activeEvents);
                        setCheckingOutcome(false);
                        setOutcomeCheckError(
                          operation === 'activate'
                            ? 'Active events were refreshed, but the list does not carry the request-specific idempotency evidence needed to prove which request created an event. The outcome remains unresolved; contact district technology support before making another start or join decision.'
                            : 'The active-event list cannot prove participant join membership. The join outcome remains unresolved; contact district technology support before making another start or join decision.',
                        );
                      },
                      () => {
                        if (
                          outcomeRequestGeneration.current !==
                            requestGeneration ||
                          requestOwnerKey === null ||
                          outcomeOwnerKeyRef.current !== requestOwnerKey ||
                          !outcomeFocusedRef.current
                        )
                          return;
                        setOutcomeCheckError(unresolvedOutcomeRefreshError());
                        setCheckingOutcome(false);
                      },
                    );
                  },
                  outcomeMessage: mutationSnapshot.error.message,
                  status: 'unresolved' as const,
                }
              : { status: 'pending' as const })}
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
                      busy={
                        mutationSnapshot.phase === 'pending' &&
                        mutationSnapshot.visibility === 'owner' &&
                        mutationSnapshot.operation === 'join' &&
                        mutationSnapshot.eventId === choice.event.id
                      }
                      disabled={mutationPending}
                      eventId={choice.event.id}
                      eventKind={choice.event.kind}
                      eventTypeName={choice.eventTypeName}
                      facilityName={choice.facilityName}
                      key={choice.event.id}
                      mode={choice.event.templateMode}
                      onPress={() => {
                        joinExisting(choice);
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

            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.sectionHeading}>
                Start an event
              </Text>
              <Text style={styles.sectionIntro}>
                Choosing a site and mode does not start an event or notify
                anyone. You confirm before anything is sent.
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

        <View style={styles.releaseTools}>
          <Text style={styles.releaseToolsText}>
            Emergency texts are one more way to reach you when the app and email
            cannot. You choose whether to give a number.
          </Text>
          <Pressable
            accessibilityHint="Opens your emergency text message settings"
            accessibilityLabel="Emergency text messages"
            accessibilityRole="button"
            accessibilityState={{ disabled: mutationPending }}
            disabled={mutationPending}
            onPress={() => {
              requestStartRouteNavigation(
                startMutation.isPendingNow(),
                () => {
                  router.push('/text-alerts' as Href);
                },
                announcePendingMutation,
              );
            }}
            style={({ pressed }) => [
              styles.releaseToolsButton,
              pressed && !mutationPending && styles.pressed,
              mutationPending && styles.releaseToolsButtonDisabled,
            ]}
            testID={SMS_CONSENT_TEST_IDS.homeEntry}
          >
            <Text style={styles.releaseToolsButtonText}>
              Emergency text messages
            </Text>
          </Pressable>
        </View>

        <View style={styles.releaseTools}>
          <Text style={styles.releaseToolsText}>
            District Technology can verify the exact update launched on this
            device without changing update or provider state.
          </Text>
          <Pressable
            accessibilityHint="Shows read-only installed release identity"
            accessibilityLabel="Open release diagnostics"
            accessibilityRole="button"
            accessibilityState={{ disabled: mutationPending }}
            disabled={mutationPending}
            onPress={() => {
              requestStartRouteNavigation(
                startMutation.isPendingNow(),
                () => {
                  router.push('/release-diagnostic' as Href);
                },
                announcePendingMutation,
              );
            }}
            style={({ pressed }) => [
              styles.releaseToolsButton,
              pressed && !mutationPending && styles.pressed,
              mutationPending && styles.releaseToolsButtonDisabled,
            ]}
          >
            <Text style={styles.releaseToolsButtonText}>
              Release diagnostics
            </Text>
          </Pressable>
        </View>
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
  releaseTools: {
    borderTopColor: '#BCCCDC',
    borderTopWidth: 1,
    gap: 10,
    paddingTop: 18,
  },
  releaseToolsButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#175A8E',
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  releaseToolsButtonDisabled: {
    opacity: 0.55,
  },
  releaseToolsButtonText: {
    color: '#175A8E',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 21,
  },
  releaseToolsText: {
    color: '#486581',
    fontSize: 14,
    lineHeight: 21,
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
