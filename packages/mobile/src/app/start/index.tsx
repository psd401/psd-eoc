import {
  CreateActivationPreviewInputSchema,
  FacilityIdSchema,
  type ActivationPreview,
  type EventTypeListItem,
  type TemplateMode,
  type Threat,
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
  TextInput,
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
  publicBlockingMessages,
  StartMutationAttention,
  StartMutationRecoveryBlockedAttention,
  StartMutationRecoveryCheckingAttention,
  SyntheticModeBanner,
  ThreatChoice,
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
  return 'PSD EOC could not check who would be notified. No event was started and nothing was sent.';
}

export function unresolvedOutcomeRefreshError(): string {
  return 'PSD EOC could not load fresh active events. This refresh did not determine the earlier request outcome. That outcome remains unresolved, and nothing retried automatically.';
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
  // The threat comes first. A threat or response that requires the
  // operator's own words holds the flow on a short description before the
  // next step; the trimmed words travel with the preview and the event.
  const [selectedThreat, setSelectedThreat] = useState<Threat | null>(null);
  const [pendingDetailThreat, setPendingDetailThreat] = useState<Threat | null>(
    null,
  );
  const [threatDetail, setThreatDetail] = useState<string | null>(null);
  const [threatDetailDraft, setThreatDetailDraft] = useState('');
  const [pendingDetailType, setPendingDetailType] =
    useState<EventTypeListItem | null>(null);
  const [responseDetail, setResponseDetail] = useState<string | null>(null);
  const [responseDetailDraft, setResponseDetailDraft] = useState('');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [outcomeCheckError, setOutcomeCheckError] = useState<string | null>(
    null,
  );
  const [outcomeActiveEvents, setOutcomeActiveEvents] = useState<
    readonly StartHomeActiveEvent[] | null
  >(null);
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
    setOutcomeActiveEvents(null);
    return () => {
      outcomeRequestGeneration.current += 1;
    };
  }, [requestAuthenticated, isFocused, state.phase, state.session?.session.id]);

  useEffect(() => {
    previewRequestGeneration.current += 1;
    previewInFlight.current = false;
    setSelectedType(null);
    setSelectedThreat(null);
    setPendingDetailThreat(null);
    setThreatDetail(null);
    setThreatDetailDraft('');
    setPendingDetailType(null);
    setResponseDetail(null);
    setResponseDetailDraft('');
    setDetailError(null);
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
  const threats = data?.threats ?? [];
  const theme = mode === null ? null : getEventTheme(mode);
  const boundPreview = getBoundActivationPreview({
    activeEvents: data?.activeEvents.map((choice) => choice.event) ?? [],
    facilityId,
    mode,
    preview,
    responseDetail,
    selectedThreat,
    selectedType,
    threatDetail,
  });
  const threatLabel =
    selectedThreat === null
      ? ''
      : threatDetail === null
        ? selectedThreat.name
        : `${selectedThreat.name} — ${threatDetail}`;
  const responseLabel =
    selectedType === null
      ? ''
      : responseDetail === null
        ? selectedType.latestVersion.name
        : `${selectedType.latestVersion.name} — ${responseDetail}`;

  function chooseThreat(threat: Threat): void {
    setDetailError(null);
    if (threat.requiresDetail) {
      setPendingDetailThreat(threat);
      setThreatDetailDraft('');
      AccessibilityInfo.announceForAccessibility(
        `${threat.name}. Describe the threat in a few words, then continue.`,
      );
      return;
    }
    setThreatDetail(null);
    setSelectedThreat(threat);
    AccessibilityInfo.announceForAccessibility(
      `Threat ${threat.name}. Now choose the response.`,
    );
  }

  function continueWithThreatDetail(): void {
    if (pendingDetailThreat === null) return;
    const trimmed = threatDetailDraft.trim();
    if (trimmed.length === 0) {
      const message =
        'Type a short description of the threat before continuing.';
      setDetailError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    setThreatDetail(trimmed);
    setSelectedThreat(pendingDetailThreat);
    setPendingDetailThreat(null);
    setDetailError(null);
    AccessibilityInfo.announceForAccessibility(
      `Threat ${pendingDetailThreat.name}, ${trimmed}. Now choose the response.`,
    );
  }

  function changeThreat(): void {
    previewRequestGeneration.current += 1;
    previewInFlight.current = false;
    setSelectedThreat(null);
    setPendingDetailThreat(null);
    setThreatDetail(null);
    setThreatDetailDraft('');
    setPendingDetailType(null);
    setResponseDetail(null);
    setResponseDetailDraft('');
    setDetailError(null);
    setSelectedType(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }

  function chooseResponse(item: EventTypeListItem): void {
    setDetailError(null);
    if (item.eventType.requiresDetail) {
      setPendingDetailType(item);
      setResponseDetailDraft('');
      AccessibilityInfo.announceForAccessibility(
        `${item.latestVersion.name}. Describe the response in a few words, then continue.`,
      );
      return;
    }
    void chooseEventType(item, null);
  }

  function continueWithResponseDetail(): void {
    if (pendingDetailType === null) return;
    const trimmed = responseDetailDraft.trim();
    if (trimmed.length === 0) {
      const message =
        'Type a short description of the response before continuing.';
      setDetailError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    const item = pendingDetailType;
    setPendingDetailType(null);
    setDetailError(null);
    void chooseEventType(item, trimmed);
  }

  async function chooseEventType(
    item: EventTypeListItem,
    itemDetail: string | null,
  ): Promise<void> {
    if (
      facility === undefined ||
      mode === null ||
      selectedThreat === null ||
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
    const chosenThreat = selectedThreat;
    const chosenThreatDetail = threatDetail;
    setSelectedType(item);
    setResponseDetail(itemDetail);
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
          threatId: chosenThreat.id,
          threatDetail: chosenThreatDetail,
          responseDetail: itemDetail,
        }),
        Crypto.randomUUID(),
      );
      if (previewRequestGeneration.current !== requestGeneration) return;

      let currentData = data;
      const previewMatches = (candidateData: StartHomeData | null): boolean =>
        getBoundActivationPreview({
          activeEvents:
            candidateData?.activeEvents.map((choice) => choice.event) ?? [],
          facilityId: selectedFacilityId,
          mode: selectedMode,
          preview: nextPreview,
          responseDetail: itemDetail,
          selectedThreat: chosenThreat,
          selectedType: item,
          threatDetail: chosenThreatDetail,
        }) !== null;
      if (!previewMatches(currentData)) {
        currentData = await loadStartHomeData(requestAuthenticated);
        if (previewRequestGeneration.current !== requestGeneration) return;
      }
      if (!previewMatches(currentData)) {
        throw new StartClientError(
          'Active-event details do not match this site. Load a fresh preview.',
          true,
          false,
        );
      }

      setData(currentData);
      setPreview(nextPreview);
      const previewClassification = getEventTheme(
        nextPreview.templateMode,
        nextPreview.kind,
      ).classificationWord;
      AccessibilityInfo.announceForAccessibility(
        `Ready to start ${previewClassification}. ${activationAudienceLabel(nextPreview.recipientCount, nextPreview.rosterPopulation)} will be notified. The exact messages are shown below.`,
      );
    } catch (error) {
      if (previewRequestGeneration.current !== requestGeneration) return;
      setPreviewError(previewFailureMessage(error));
      AccessibilityInfo.announceForAccessibility(
        'PSD EOC could not check who would be notified. No event was started and nothing was sent.',
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
      eventTypeName: responseLabel,
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

  // Starting or joining opens the event room. A confirmation screen in between
  // is one more tap during the minute that matters most.
  useEffect(() => {
    if (!isFocused || mutationSnapshot.phase !== 'succeeded') return;
    const { eventId } = mutationSnapshot.completion;
    if (!startMutation.acknowledge()) return;
    router.replace({
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
            {selectedThreat === null
              ? 'Step 2 of 4'
              : boundPreview === null
                ? 'Step 3 of 4'
                : 'Step 4 of 4'}
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

        {facility !== undefined && mode !== null && selectedThreat === null ? (
          <View style={styles.selection}>
            <View style={styles.heading}>
              <Text style={styles.eyebrow}>{facility.code}</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Choose threat
              </Text>
              <Text style={styles.subtitle}>{facility.name}</Text>
              <Text style={styles.helpText}>
                Choosing a threat does not start an event or notify anyone. You
                choose the response next.
              </Text>
            </View>

            {pendingDetailThreat !== null ? (
              <View style={styles.detailForm}>
                <Text accessibilityRole="header" style={styles.detailHeading}>
                  Describe the threat
                </Text>
                <Text style={styles.helpText}>
                  {pendingDetailThreat.name}: a few words. Staff see exactly
                  what you type.
                </Text>
                <TextInput
                  accessibilityLabel="Threat description"
                  autoCapitalize="sentences"
                  autoFocus
                  maxLength={200}
                  onChangeText={(text) => {
                    setThreatDetailDraft(text);
                    setDetailError(null);
                  }}
                  onSubmitEditing={continueWithThreatDetail}
                  returnKeyType="done"
                  style={styles.input}
                  value={threatDetailDraft}
                />
                {detailError === null ? null : (
                  <Text
                    accessibilityLiveRegion="assertive"
                    accessibilityRole="alert"
                    style={styles.errorText}
                  >
                    {detailError}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={continueWithThreatDetail}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    Continue with {pendingDetailThreat.name}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setPendingDetailThreat(null);
                    setThreatDetailDraft('');
                    setDetailError(null);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    Back to threats
                  </Text>
                </Pressable>
              </View>
            ) : threats.length === 0 ? (
              <View accessibilityRole="alert" style={styles.error}>
                <Text style={styles.errorHeading}>
                  No threats are configured
                </Text>
                <Text style={styles.errorText}>
                  No event was started. Contact a PSD EOC administrator.
                </Text>
              </View>
            ) : (
              <View style={styles.choiceList}>
                {threats.map((threat, index) => (
                  <ThreatChoice
                    key={threat.id}
                    mode={mode}
                    name={threat.name}
                    onPress={() => {
                      chooseThreat(threat);
                    }}
                    requiresDetail={threat.requiresDetail}
                    {...(SYNTHETIC_FIXTURE_ENABLED &&
                    mode === 'drill' &&
                    index === 0
                      ? { testID: ISSUE_21_MAESTRO_IDS.drillThreat }
                      : {})}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {facility !== undefined &&
        mode !== null &&
        selectedThreat !== null &&
        boundPreview === null ? (
          <View style={styles.selection}>
            <View style={styles.heading}>
              <Text style={styles.eyebrow}>{facility.code}</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Choose response
              </Text>
              <Text style={styles.subtitle}>{facility.name}</Text>
              <Text style={styles.chosenThreat}>Threat: {threatLabel}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={previewLoading}
                onPress={changeThreat}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>Change threat</Text>
              </Pressable>
              <Text style={styles.helpText}>
                Choosing a response loads a current consequence preview. It does
                not start an event or notify anyone.
              </Text>
            </View>

            {previewLoading ? (
              <View
                accessibilityLabel="Checking who would be notified"
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
                  Could not check who would be notified
                </Text>
                <Text style={styles.errorText}>{previewError}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedType(null);
                    setResponseDetail(null);
                    setPreviewError(null);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    Return to responses
                  </Text>
                </Pressable>
              </View>
            )}

            {!previewLoading && previewError === null ? (
              pendingDetailType !== null ? (
                <View style={styles.detailForm}>
                  <Text accessibilityRole="header" style={styles.detailHeading}>
                    Describe the response
                  </Text>
                  <Text style={styles.helpText}>
                    {pendingDetailType.latestVersion.name}: a few words. They
                    replace the response name in every notification.
                  </Text>
                  <TextInput
                    accessibilityLabel="Response description"
                    autoCapitalize="sentences"
                    autoFocus
                    maxLength={200}
                    onChangeText={(text) => {
                      setResponseDetailDraft(text);
                      setDetailError(null);
                    }}
                    onSubmitEditing={continueWithResponseDetail}
                    returnKeyType="done"
                    style={styles.input}
                    value={responseDetailDraft}
                  />
                  {detailError === null ? null : (
                    <Text
                      accessibilityLiveRegion="assertive"
                      accessibilityRole="alert"
                      style={styles.errorText}
                    >
                      {detailError}
                    </Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    onPress={continueWithResponseDetail}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>
                      Continue with {pendingDetailType.latestVersion.name}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setPendingDetailType(null);
                      setResponseDetailDraft('');
                      setDetailError(null);
                    }}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>
                      Back to responses
                    </Text>
                  </Pressable>
                </View>
              ) : eventTypes.length === 0 ? (
                <View accessibilityRole="alert" style={styles.error}>
                  <Text style={styles.errorHeading}>No enabled responses</Text>
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
                        chooseResponse(item);
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
            blockingMessages={publicBlockingMessages(
              boundPreview.blockingReasonCodes,
            )}
            busy={
              mutationSnapshot.phase === 'pending' &&
              mutationSnapshot.visibility === 'owner' &&
              mutationSnapshot.operation === 'activate'
            }
            channels={boundPreview.channels}
            disabled={mutationPending}
            eventKind={boundPreview.kind}
            eventTypeName={responseLabel}
            facilityName={facility.name}
            mode={mode}
            onConfirm={() => {
              confirmActivation();
            }}
            recipientCount={boundPreview.recipientCount}
            rosterPopulation={boundPreview.rosterPopulation}
            sendReadiness={boundPreview.sendReadiness}
            threatLabel={threatLabel}
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
  chosenThreat: {
    color: '#102A43',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  detailForm: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  detailHeading: {
    color: '#102A43',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 26,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#486581',
    borderRadius: 10,
    borderWidth: 2,
    color: '#102A43',
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#17324D',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 22,
    textAlign: 'center',
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
