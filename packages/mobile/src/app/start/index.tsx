import {
  CreateActivationPreviewInputSchema,
  FacilityIdSchema,
  type ActivationPreview,
  type EventTypeListItem,
  type TemplateMode,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import {
  type Href,
  useIsFocused,
  useLocalSearchParams,
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

import { ClassificationBanner } from '../../components/classification-banner';
import {
  ActivationConfirmation,
  ActivationResult,
  announceActivationResult,
  ActiveEventJoinAction,
  activationAudienceLabel,
  Call911Affordance,
  EventTypeChoice,
  ISSUE_21_MAESTRO_IDS,
  OtherSessionStartMutationAttention,
  StartMutationAttention,
  StartMutationRecoveryBlockedAttention,
  StartMutationRecoveryCheckingAttention,
  SyntheticModeBanner,
} from '../../components/start';
import {
  OFFLINE_ACTION_MESSAGE,
  OfflineMutationDeniedError,
  useMobileAuth,
} from '../../lib/auth';
import {
  createPreview,
  deliverClaimedStartMutationSuccessFeedback,
  getBoundActivationPreview,
  isIssue21SyntheticFixtureEnabled,
  loadStartHomeData,
  requestStartRouteNavigation,
  StartClientError,
  type StartHomeActiveEvent,
  type StartHomeData,
  useStartMutation,
  useStartMutationHardwareBackGuard,
  useStartMutationNavigationGuard,
} from '../../lib/start';
import { getEventTheme } from '../../theme/event-theme';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Los_Angeles',
});

const SYNTHETIC_FIXTURE_ENABLED = isIssue21SyntheticFixtureEnabled();

function one(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function previewFailureMessage(error: unknown): string {
  if (error instanceof OfflineMutationDeniedError) {
    return `${error.message} No event was started and nothing was queued.`;
  }
  if (error instanceof StartClientError) {
    return `${error.message} No event was started and nothing was queued.`;
  }
  return 'The consequence preview is unavailable. No event was started and nothing was queued.';
}

function blockingMessage(code: string): string {
  const words = code.replaceAll('_', ' ').toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function startedLabel(choice: StartHomeActiveEvent): string {
  return DATE_FORMATTER.format(
    new Date(choice.event.activatedAt ?? choice.event.createdAt),
  );
}

export default function StartEventScreen() {
  const parameters = useLocalSearchParams();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { requestAuthenticated, state } = useMobileAuth();
  const startMutation = useStartMutation();
  const facilityResult = FacilityIdSchema.safeParse(one(parameters.facilityId));
  const modeValue = one(parameters.mode);
  const mode: TemplateMode | null =
    modeValue === 'real' || modeValue === 'drill' ? modeValue : null;
  const facilityId = facilityResult.success ? facilityResult.data : null;
  const [data, setData] = useState<StartHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<EventTypeListItem | null>(
    null,
  );
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [outcomeCheckError, setOutcomeCheckError] = useState<string | null>(
    null,
  );
  const previewInFlight = useRef(false);
  const previewRequestGeneration = useRef(0);
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
  useStartMutationNavigationGuard(
    mutationPending && state.phase === 'online',
    announcePendingMutation,
  );
  useStartMutationHardwareBackGuard(
    isMutationPendingNow,
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
    return () => {
      outcomeRequestGeneration.current += 1;
    };
  }, [requestAuthenticated, isFocused, state.phase, state.session?.session.id]);

  useEffect(() => {
    previewRequestGeneration.current += 1;
    previewInFlight.current = false;
    setSelectedType(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);

    if (facilityId === null || mode === null) {
      setLoadError('The site or event mode is invalid. No action was taken.');
      setLoading(false);
      return;
    }
    if (state.phase !== 'online') {
      setData(null);
      setLoading(state.phase !== 'offline-cached');
      setLoadError(
        state.phase === 'offline-cached'
          ? `${state.message ?? OFFLINE_ACTION_MESSAGE} No event was started or joined, and nothing was queued.`
          : null,
      );
      return;
    }
    let active = true;
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
        setLoadError(previewFailureMessage(error));
        setLoading(false);
      },
    );
    return () => {
      active = false;
      previewRequestGeneration.current += 1;
      previewInFlight.current = false;
    };
  }, [requestAuthenticated, facilityId, mode, state.message, state.phase]);

  const facility =
    facilityId === null
      ? undefined
      : data?.facilities.find((candidate) => candidate.id === facilityId);
  const eventTypes =
    mode === null || data === null
      ? []
      : data.eventTypes.filter(
          (item) =>
            item.eventType.templateMode === mode && item.latestVersion.enabled,
        );
  const theme = mode === null ? null : getEventTheme(mode);
  const boundPreview = getBoundActivationPreview({
    facilityId,
    mode,
    preview,
    selectedType,
  });

  async function chooseEventType(item: EventTypeListItem): Promise<void> {
    if (
      facility === undefined ||
      mode === null ||
      previewLoading ||
      previewInFlight.current
    ) {
      return;
    }
    previewInFlight.current = true;
    const requestGeneration = previewRequestGeneration.current + 1;
    previewRequestGeneration.current = requestGeneration;
    const selectedFacilityId = facility.id;
    const selectedMode = mode;
    const selectedVersionId = item.latestVersion.id;
    setSelectedType(item);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const nextPreview = await createPreview(
        requestAuthenticated,
        CreateActivationPreviewInputSchema.parse({
          facilityId: selectedFacilityId,
          kind: selectedMode === 'real' ? 'incident' : 'drill',
          templateMode: selectedMode,
          eventTypeVersion: {
            id: selectedVersionId,
            templateMode: selectedMode,
          },
          rosterPopulation: SYNTHETIC_FIXTURE_ENABLED ? 'synthetic' : 'staff',
        }),
        Crypto.randomUUID(),
      );
      if (previewRequestGeneration.current !== requestGeneration) return;

      let currentData = data;
      const knownEventIds = new Set(
        currentData?.activeEvents.map((choice) => choice.event.id) ?? [],
      );
      if (
        nextPreview.activeEventIds.some(
          (eventId) => !knownEventIds.has(eventId),
        )
      ) {
        currentData = await loadStartHomeData(requestAuthenticated);
        if (previewRequestGeneration.current !== requestGeneration) return;
      }
      const refreshedIds = new Set(
        currentData?.activeEvents.map((choice) => choice.event.id) ?? [],
      );
      if (
        nextPreview.activeEventIds.some((eventId) => !refreshedIds.has(eventId))
      ) {
        throw new StartClientError(
          'Active-event details changed before confirmation. Load a fresh preview.',
          true,
          false,
        );
      }

      setData(currentData);
      setPreview(nextPreview);
      const previewClassification =
        nextPreview.templateMode === 'real'
          ? 'REAL INCIDENT'
          : 'DRILL — PRACTICE';
      AccessibilityInfo.announceForAccessibility(
        `Consequence preview ready for ${previewClassification}. ${activationAudienceLabel(nextPreview.recipientCount, nextPreview.rosterPopulation)}. ${nextPreview.channels.length} channels list the exact rendered messages, endpoint counts, and integration truth labels. Review before confirming.`,
      );
    } catch (error) {
      if (previewRequestGeneration.current !== requestGeneration) return;
      setPreviewError(previewFailureMessage(error));
      AccessibilityInfo.announceForAccessibility(
        'Consequence preview unavailable. No event was started and nothing was queued.',
      );
    } finally {
      if (previewRequestGeneration.current === requestGeneration) {
        previewInFlight.current = false;
        setPreviewLoading(false);
      }
    }
  }

  function confirmActivation(): void {
    if (boundPreview === null || selectedType === null) return;
    const admission = startMutation.submitActivation({
      eventTypeName: selectedType.latestVersion.name,
      preview: boundPreview,
    });
    if (admission.accepted) {
      void admission.completion;
    }
  }

  function joinExisting(choice: StartHomeActiveEvent): void {
    const admission = startMutation.submitJoin({ choice });
    if (admission.accepted) {
      void admission.completion;
    }
  }

  function returnHome(): void {
    router.dismissTo('/' as Href);
  }

  const mutationSnapshot = startMutation.snapshot;
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
          eventTypeName={mutationSnapshot.completion.eventTypeName}
          kind={mutationSnapshot.completion.kind}
          mode={mutationSnapshot.completion.mode}
          onOpenEvent={() => {
            if (!startMutation.acknowledge()) return;
            router.replace({
              pathname: '/events/[id]',
              params: { id: mutationSnapshot.completion.eventId },
            } as Href);
          }}
          onReturnHome={() => {
            startMutation.acknowledge();
            returnHome();
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
                      if (startMutation.acknowledge()) returnHome();
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
                      setOutcomeCheckError(previewFailureMessage(error));
                      setCheckingOutcome(false);
                    },
                  );
                },
                status: 'failed' as const,
              }
            : unresolved
              ? {
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
                        const resolved =
                          operation === 'activate' &&
                          startMutation.resolveActivationFromFreshEvents(
                            nextData.activeEvents.map((choice) => choice.event),
                          );
                        if (!resolved) {
                          setOutcomeCheckError(
                            operation === 'activate'
                              ? 'No exact matching activation evidence was found. Absence from this list is not proof of failure. The outcome remains unresolved; contact district technology support before making another start or join decision.'
                              : 'The active-event list cannot prove participant join membership. The join outcome remains unresolved; contact district technology support before making another start or join decision.',
                          );
                        }
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
                        setOutcomeCheckError(previewFailureMessage(error));
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

  const activeChoices =
    boundPreview === null || data === null
      ? []
      : boundPreview.activeEventIds
          .map((eventId) =>
            data.activeEvents.find((choice) => choice.event.id === eventId),
          )
          .filter(
            (choice): choice is StartHomeActiveEvent => choice !== undefined,
          );

  return (
    <SafeAreaView
      style={[
        styles.page,
        theme === null
          ? null
          : { backgroundColor: theme.colors.pageBackground },
      ]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        style={styles.page}
      >
        <View style={styles.topBar}>
          <Pressable
            accessibilityHint={
              mutationPending
                ? 'Wait for the current request to finish before leaving this screen.'
                : undefined
            }
            accessibilityLabel="Back to active events"
            accessibilityRole="button"
            accessibilityState={{ disabled: mutationPending }}
            disabled={mutationPending}
            onPress={() => {
              requestStartRouteNavigation(
                startMutation.isPendingNow(),
                () => {
                  router.back();
                },
                announcePendingMutation,
              );
            }}
            style={({ pressed }) => [
              styles.backButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.stepText}>
            {boundPreview === null ? 'Step 2 of 3' : 'Step 3 of 3'}
          </Text>
        </View>

        {SYNTHETIC_FIXTURE_ENABLED ? <SyntheticModeBanner /> : null}

        {mode === null ? null : boundPreview === null ? (
          <ClassificationBanner mode={mode} />
        ) : null}

        <Call911Affordance />

        {loading ? (
          <View accessibilityRole="progressbar" style={styles.loading}>
            <ActivityIndicator
              color={theme?.colors.bannerBackground ?? '#175A8E'}
              size="large"
            />
            <Text style={styles.loadingText}>Loading event choices</Text>
          </View>
        ) : null}

        {loadError === null && facility === undefined && !loading ? (
          <View accessibilityRole="alert" style={styles.error}>
            <Text accessibilityRole="header" style={styles.errorHeading}>
              Site unavailable
            </Text>
            <Text style={styles.errorText}>
              This site is not active in your authorized scope. No action was
              taken.
            </Text>
          </View>
        ) : null}

        {loadError === null ? null : (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.error}
          >
            <Text accessibilityRole="header" style={styles.errorHeading}>
              Start flow unavailable
            </Text>
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        )}

        {facility !== undefined && mode !== null && boundPreview === null ? (
          <View style={styles.selection}>
            <View style={styles.heading}>
              <Text style={styles.eyebrow}>{facility.code}</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Choose event type
              </Text>
              <Text style={styles.subtitle}>{facility.name}</Text>
              <Text style={styles.helpText}>
                Choosing a type loads a current consequence preview. It does not
                start an event or notify anyone.
              </Text>
            </View>

            {previewLoading ? (
              <View
                accessibilityLabel="Loading current consequence preview"
                accessibilityRole="progressbar"
                style={styles.loading}
              >
                <ActivityIndicator
                  color={theme?.colors.bannerBackground ?? '#175A8E'}
                  size="large"
                />
                <Text style={styles.loadingText}>
                  Loading current roster, active events, and channels
                </Text>
              </View>
            ) : null}

            {previewError === null ? null : (
              <View
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                style={styles.error}
              >
                <Text accessibilityRole="header" style={styles.errorHeading}>
                  Consequence preview unavailable
                </Text>
                <Text style={styles.errorText}>{previewError}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedType(null);
                    setPreviewError(null);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    Return to event types
                  </Text>
                </Pressable>
              </View>
            )}

            {!previewLoading && previewError === null ? (
              eventTypes.length === 0 ? (
                <View accessibilityRole="alert" style={styles.error}>
                  <Text style={styles.errorHeading}>
                    No enabled event types
                  </Text>
                  <Text style={styles.errorText}>
                    No event was started. Contact a PSD EOC administrator.
                  </Text>
                </View>
              ) : (
                <View style={styles.choiceList}>
                  {eventTypes.map((item, index) => (
                    <EventTypeChoice
                      description={item.latestVersion.description}
                      disabled={previewLoading}
                      key={item.eventType.id}
                      mode={mode}
                      name={item.latestVersion.name}
                      onPress={() => {
                        void chooseEventType(item);
                      }}
                      {...(SYNTHETIC_FIXTURE_ENABLED &&
                      mode === 'drill' &&
                      index === 0
                        ? { testID: ISSUE_21_MAESTRO_IDS.drillEventType }
                        : {})}
                    />
                  ))}
                </View>
              )
            ) : null}
          </View>
        ) : null}

        {facility !== undefined &&
        mode !== null &&
        selectedType !== null &&
        boundPreview !== null ? (
          <ActivationConfirmation
            activeEventCount={boundPreview.activeEventIds.length}
            blockingMessages={boundPreview.blockingReasonCodes.map(
              blockingMessage,
            )}
            busy={
              mutationSnapshot.phase === 'pending' &&
              mutationSnapshot.visibility === 'owner' &&
              mutationSnapshot.operation === 'activate'
            }
            channels={boundPreview.channels}
            disabled={mutationPending}
            eventTypeName={selectedType.latestVersion.name}
            facilityName={facility.name}
            mode={mode}
            onConfirm={() => {
              confirmActivation();
            }}
            recipientCount={boundPreview.recipientCount}
            rosterPopulation={boundPreview.rosterPopulation}
            sendReadiness={boundPreview.sendReadiness}
            {...(SYNTHETIC_FIXTURE_ENABLED && mode === 'drill'
              ? { testID: ISSUE_21_MAESTRO_IDS.confirmDrill }
              : {})}
          >
            {activeChoices.length === 0 ? null : (
              <View style={styles.activeChoiceSection}>
                <Text accessibilityRole="header" style={styles.activeHeading}>
                  An event is already active here
                </Text>
                <Text style={styles.helpText}>
                  Choose explicitly: join an existing event, or start a separate
                  event with another notification intent.
                </Text>
                {activeChoices.map((choice, index) => (
                  <ActiveEventJoinAction
                    busy={
                      mutationSnapshot.phase === 'pending' &&
                      mutationSnapshot.visibility === 'owner' &&
                      mutationSnapshot.operation === 'join' &&
                      mutationSnapshot.eventId === choice.event.id
                    }
                    disabled={mutationPending}
                    eventId={choice.event.id}
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
          </ActivationConfirmation>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  activeChoiceSection: {
    gap: 12,
  },
  activeHeading: {
    color: '#102A43',
    fontSize: 21,
    fontWeight: '900',
    lineHeight: 28,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#9DB8CF',
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 15,
  },
  backButtonText: {
    color: '#17324D',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  choiceList: {
    gap: 12,
  },
  content: {
    gap: 20,
    padding: 20,
    paddingBottom: 44,
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
    fontWeight: '900',
    letterSpacing: 1.1,
    lineHeight: 16,
  },
  heading: {
    gap: 6,
  },
  helpText: {
    color: '#486581',
    fontSize: 15,
    lineHeight: 22,
  },
  loading: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  loadingText: {
    color: '#334E68',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 22,
    textAlign: 'center',
  },
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  pressed: {
    opacity: 0.72,
  },
  secondaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#17324D',
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#17324D',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 21,
    textAlign: 'center',
  },
  selection: {
    gap: 18,
  },
  stepText: {
    color: '#486581',
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 21,
  },
  subtitle: {
    color: '#334E68',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 25,
  },
  title: {
    color: '#102A43',
    fontSize: 31,
    fontWeight: '900',
    lineHeight: 38,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
