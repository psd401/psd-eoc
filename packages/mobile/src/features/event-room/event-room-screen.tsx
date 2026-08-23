import {
  LocationPayloadSchema,
  projectJournalEntryForRead,
  type JournalEntryReadProjection,
  type LifecycleConsequencePreview,
  type LocationPayload,
  type EventKind,
  type EventStatus,
  type FacilityScope,
  type JournalEntry,
  type Role,
  type TemplateMode,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClassificationBanner } from '../../components/classification-banner';
import { AuthenticatedApiError } from '../../lib/api';
import {
  OFFLINE_ACTION_MESSAGE,
  useMobileAuth,
  type MobileAuthContextValue,
} from '../../lib/auth';
import { getEventTheme } from '../../theme/event-theme';
import { EventRoomApi } from './api';
import {
  adjustKnownLocation,
  formatAccuracyRadius,
  formatLocationPayload,
  isEventComposerVisible,
  isNearLiveEdge,
  journalEntryActionEligibility,
  retainPendingTimelineFollow,
  timelineEntryAccessibilityLabel,
  timelineEntryText,
} from './model';
import { EventRoomSyncController } from './sync-controller';
import {
  useEventPhotoDraft,
  type EventPhotoDraftWorkflow,
} from './use-event-photo-draft';

const TEXT_LIMIT = 10_000;
const LOCATION_LABEL_LIMIT = 200;
const LOCATION_REASON_LIMIT = 500;
const PIN_ADJUSTMENT_METRES = 5;
const LOCATION_CAPTURE_TIMEOUT_MS = 10_000;
const JOURNAL_ACTION_REASON_LIMIT = 1_000;

export const EVENT_ROOM_MUTED_TEXT_COLOR = '#486581';

type LifecycleAction = 'all-clear' | 'close';
type LocationMode = 'known' | 'ambiguous' | 'unknown';
type KnownLocation = Extract<LocationPayload, { state: 'known' }>;
type CorrectableJournalEntry = Extract<
  JournalEntry,
  { kind: 'text' | 'location' }
>;
type JournalEntryAction = 'correction' | 'redaction';

export function userCanManageEventJournal(
  roles: readonly Role[],
  scope: FacilityScope,
  facilityId: string,
): boolean {
  return (
    roles.length > 0 &&
    (scope.kind === 'district' || scope.facilityIds.includes(facilityId))
  );
}

export function journalActionError(error: unknown): string {
  if (error instanceof AuthenticatedApiError) {
    switch (error.status) {
      case 400:
        return 'Check the replacement content and reason, then try again.';
      case 403:
        return 'Your current role or site access no longer permits this entry action. Refresh your session or contact an administrator.';
      case 404:
        return 'This timeline entry is no longer available to your session. Refresh the timeline and choose it again.';
      case 409:
        return 'This entry changed or was already superseded. Refresh the timeline and choose the latest entry.';
    }
  }
  return publicError(
    error,
    'The entry action did not complete. Reconnect and retry the retained request.',
  );
}

export interface JournalMutationIdentity {
  readonly idempotencyKey: string;
  readonly clientTime: string;
  readonly canonicalDraft: string;
}

/** Retains the complete canonical request identity after an uncertain result. */
export function retainJournalMutationIdentity(
  current: JournalMutationIdentity | null,
  canonicalDraft: string,
  createIdempotencyKey: () => string,
  createClientTime: () => string,
): JournalMutationIdentity {
  return (
    (current?.canonicalDraft === canonicalDraft ? current : null) ??
    Object.freeze({
      idempotencyKey: createIdempotencyKey(),
      clientTime: createClientTime(),
      canonicalDraft,
    })
  );
}

interface ForegroundPosition {
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number | null;
  };
}

export interface ForegroundLocationCaptureDependencies {
  readonly requestPermission: () => Promise<{ readonly status: string }>;
  readonly getPosition: () => Promise<ForegroundPosition>;
  readonly isCurrentForegroundCapture: () => boolean;
  readonly timeoutMilliseconds?: number;
}

export function eventStatusAcceptsTimelinePosts(
  status: EventStatus | null | undefined,
): boolean {
  return status === 'active' || status === 'all-clear';
}

export function invalidateLocationCaptureForPostingState(
  eventAcceptsPosts: boolean,
  activeGeneration: number,
): number {
  return eventAcceptsPosts ? activeGeneration : activeGeneration + 1;
}

async function beforeDeadline<Value>(
  operation: Promise<Value>,
  deadlineAt: number,
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => {
        reject(
          new Error(
            'GPS capture timed out. Choose ambiguous or unknown instead.',
          ),
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/** Bounds native GPS work and rejects results from an interrupted foreground generation. */
export async function captureForegroundPosition({
  getPosition,
  isCurrentForegroundCapture,
  requestPermission,
  timeoutMilliseconds = LOCATION_CAPTURE_TIMEOUT_MS,
}: ForegroundLocationCaptureDependencies): Promise<ForegroundPosition> {
  const deadlineAt = Date.now() + timeoutMilliseconds;
  const permission = await beforeDeadline(requestPermission(), deadlineAt);
  if (!isCurrentForegroundCapture()) {
    throw new Error(
      'GPS capture stopped when the app left the foreground. Capture again or choose ambiguous or unknown.',
    );
  }
  if (permission.status !== 'granted') {
    throw new Error(
      'Foreground location permission was not granted. Choose ambiguous or unknown instead.',
    );
  }
  const captured = await beforeDeadline(getPosition(), deadlineAt);
  if (!isCurrentForegroundCapture()) {
    throw new Error(
      'GPS capture stopped when the app left the foreground. Capture again or choose ambiguous or unknown.',
    );
  }
  return captured;
}

export interface EventRoomTargetIdentity {
  readonly eventKind?: EventKind;
  readonly eventTypeName: string;
  readonly facilityName: string;
  readonly facilityCode: string;
}

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function actorText(projection: JournalEntryReadProjection): string {
  switch (projection.entry.author.kind) {
    case 'human':
      return 'Staff member';
    case 'agent':
      return 'District agent';
    case 'system':
      return 'PSD EOC system';
  }
}

function renderedChannelCopy(
  channel: LifecycleConsequencePreview['channels'][number],
): string {
  const message = channel.renderedMessage;
  switch (message.channel) {
    case 'push':
      return `${message.classificationMarker}: ${message.title}. ${message.body}`;
    case 'email':
      return `${message.classificationMarker}: ${message.subject}. ${message.textBody}`;
    case 'sms':
      return `${message.classificationMarker}: ${message.body}`;
  }
}

function ActionButton({
  accessibilityHint,
  accessibilityLabel,
  disabled = false,
  destructive = false,
  label,
  onPress,
  testID,
}: Readonly<{
  accessibilityHint?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  destructive?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}>) {
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        destructive ? styles.destructiveButton : styles.primaryButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}
    >
      <Text
        style={
          destructive ? styles.destructiveButtonText : styles.primaryButtonText
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

function EventTargetContext({
  mode,
  target,
}: Readonly<{
  mode: TemplateMode;
  target: EventRoomTargetIdentity;
}>) {
  return (
    <View style={styles.eventTargetContext}>
      <ClassificationBanner
        {...(target.eventKind === undefined ? {} : { kind: target.eventKind })}
        mode={mode}
      />
      <View
        accessibilityLabel={`Event target. ${target.eventTypeName}. ${target.facilityName}, ${target.facilityCode}. Classification and target are immutable.`}
        accessibilityRole="summary"
        accessible
        style={styles.eventTargetCard}
      >
        <Text style={styles.eventTargetType}>{target.eventTypeName}</Text>
        <Text style={styles.eventTargetFacility}>
          {target.facilityName} · {target.facilityCode}
        </Text>
        <Text style={styles.immutableNotice}>
          Classification and event target are immutable and cannot be changed
          here.
        </Text>
      </View>
    </View>
  );
}

function TimelinePhoto({
  altText,
  api,
  eventId,
  mediaId,
}: Readonly<{
  altText: string;
  api?: Pick<EventRoomApi, 'getMediaReadGrant'>;
  eventId: string;
  mediaId: string;
}>) {
  const [uri, setUri] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (api === undefined) return;
    const controller = new AbortController();
    setUri(null);
    setUnavailable(false);
    void api
      .getMediaReadGrant(eventId, mediaId, controller.signal)
      .then((grant) => {
        if (!controller.signal.aborted) setUri(grant.readUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [api, attempt, eventId, mediaId]);

  if (uri !== null) {
    return (
      <Image
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onError={() => {
          setUri(null);
          setUnavailable(true);
        }}
        resizeMode="cover"
        source={{ uri }}
        style={styles.timelinePhoto}
      />
    );
  }
  if (unavailable) {
    return (
      <View style={styles.photoPlaceholder}>
        <Text style={styles.photoPlaceholderText}>
          Photo temporarily unavailable
        </Text>
        <ActionButton
          accessibilityHint={`Requests a fresh authorized read for ${altText}`}
          label="Retry loading photo"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.photoPlaceholder}
    >
      <ActivityIndicator color="#17324D" />
      <Text style={styles.photoPlaceholderText}>{`Loading ${altText}`}</Text>
    </View>
  );
}

export interface TimelineEntryCardProps {
  readonly projection: JournalEntryReadProjection;
  readonly api?: Pick<EventRoomApi, 'getMediaReadGrant'>;
  readonly actionEligibility?: ReturnType<typeof journalEntryActionEligibility>;
  readonly onCorrect?: () => void;
  readonly onRedact?: () => void;
}

/** One append-only timeline fact grouped into a single screen-reader stop. */
export function TimelineEntryCard({
  actionEligibility,
  api,
  onCorrect,
  onRedact,
  projection,
}: TimelineEntryCardProps) {
  const { entry } = projection;
  const visiblePhoto =
    projection.visibility === 'visible' && projection.entry.kind === 'photo'
      ? projection.entry.payload
      : null;

  return (
    <View style={styles.timelineCard}>
      <View
        accessibilityLabel={timelineEntryAccessibilityLabel(projection)}
        accessibilityRole="text"
        accessible
        testID={`timeline-entry-${entry.sequence}`}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.timelineMetaRow}
        >
          <Text style={styles.timelineActor}>{actorText(projection)}</Text>
          <Text style={styles.timelineTime}>
            {new Date(entry.serverTime).toLocaleString()}
          </Text>
        </View>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.timelineBody}
        >
          {timelineEntryText(projection)}
        </Text>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.timelineSequence}
        >
          Timeline entry {entry.sequence}
        </Text>
      </View>
      {visiblePhoto === null ? null : (
        <TimelinePhoto
          altText={visiblePhoto.altText}
          eventId={entry.eventId}
          mediaId={visiblePhoto.mediaId}
          {...(api === undefined ? {} : { api })}
        />
      )}
      {actionEligibility === undefined ? null : (
        <View style={styles.entryActionArea}>
          <View style={styles.entryActionRow}>
            {actionEligibility.correction.allowed && onCorrect !== undefined ? (
              <ActionButton label="Correct…" onPress={onCorrect} />
            ) : null}
            {actionEligibility.redaction.allowed && onRedact !== undefined ? (
              <ActionButton destructive label="Redact…" onPress={onRedact} />
            ) : null}
          </View>
          {actionEligibility.correction.allowed ||
          actionEligibility.correction.unavailableReason ===
            actionEligibility.redaction.unavailableReason ? null : (
            <Text accessibilityRole="summary" style={styles.entryActionHelp}>
              Correction unavailable:{' '}
              {actionEligibility.correction.unavailableReason}
            </Text>
          )}
          {!actionEligibility.correction.allowed &&
          !actionEligibility.redaction.allowed ? (
            <Text accessibilityRole="summary" style={styles.entryActionHelp}>
              Entry actions unavailable:{' '}
              {actionEligibility.correction.unavailableReason ??
                actionEligibility.redaction.unavailableReason}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

export type JournalActionSubmission =
  | Readonly<{ action: 'redaction'; reason: string }>
  | Readonly<{
      action: 'correction';
      reason: string;
      replacement: Readonly<
        | { kind: 'text'; text: string }
        | { kind: 'location'; payload: LocationPayload }
      >;
    }>;

interface JournalActionDialogProps {
  readonly action: JournalEntryAction;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onDismiss: () => void;
  readonly onSubmit: (submission: JournalActionSubmission) => void;
  readonly target: JournalEntryReadProjection;
}

/** Explicit append-only correction/redaction editor for one retained entry. */
export function JournalActionDialog({
  action,
  busy,
  error,
  onDismiss,
  onSubmit,
  target,
}: JournalActionDialogProps) {
  const visibleEntry = target.visibility === 'visible' ? target.entry : null;
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [knownLatitude, setKnownLatitude] = useState('');
  const [knownLongitude, setKnownLongitude] = useState('');
  const [knownAccuracy, setKnownAccuracy] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [locationDetail, setLocationDetail] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setReason('');
    setValidationError(null);
    if (visibleEntry?.kind === 'text') {
      setText(visibleEntry.payload.text);
      return;
    }
    if (visibleEntry?.kind !== 'location') return;
    const payload = visibleEntry.payload;
    if (payload.state === 'known') {
      setKnownLatitude(String(payload.latitude));
      setKnownLongitude(String(payload.longitude));
      setKnownAccuracy(String(payload.accuracyMeters));
      setLocationLabel(payload.label ?? '');
      setLocationDetail('');
    } else if (payload.state === 'ambiguous') {
      setLocationLabel(payload.label);
      setLocationDetail(payload.reason);
    } else {
      setLocationLabel('');
      setLocationDetail(payload.reason);
    }
  }, [action, target.entry.id, visibleEntry]);

  const submit = () => {
    const canonicalReason = reason.trim();
    if (canonicalReason.length === 0) {
      setValidationError('Explain why this entry needs this action.');
      return;
    }
    if (action === 'redaction') {
      onSubmit({ action, reason: canonicalReason });
      return;
    }
    if (visibleEntry?.kind === 'text') {
      const canonicalText = text.trim();
      if (canonicalText.length === 0) {
        setValidationError('Enter the corrected timeline text.');
        return;
      }
      onSubmit({
        action,
        reason: canonicalReason,
        replacement: { kind: 'text', text: canonicalText },
      });
      return;
    }
    if (visibleEntry?.kind !== 'location') {
      setValidationError(
        'This entry cannot be corrected. Close this sheet and choose an available action.',
      );
      return;
    }
    const original = visibleEntry.payload;
    const candidate =
      original.state === 'known'
        ? {
            state: 'known' as const,
            latitude: Number(knownLatitude),
            longitude: Number(knownLongitude),
            accuracyMeters: Number(knownAccuracy),
            label: locationLabel.trim() || null,
          }
        : original.state === 'ambiguous'
          ? {
              state: 'ambiguous' as const,
              label: locationLabel.trim(),
              reason: locationDetail.trim(),
            }
          : {
              state: 'unknown' as const,
              reason: locationDetail.trim(),
            };
    const parsed = LocationPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationError(
        'Check the corrected location details, including coordinates and accuracy.',
      );
      return;
    }
    onSubmit({
      action,
      reason: canonicalReason,
      replacement: { kind: 'location', payload: parsed.data },
    });
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onDismiss}
      presentationStyle="pageSheet"
      visible
    >
      <SafeAreaView style={styles.modalPage}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalPage}
        >
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalTitleRow}>
              <Text accessibilityRole="header" style={styles.modalTitle}>
                {action === 'correction'
                  ? `Correct timeline entry ${target.entry.sequence}`
                  : `Redact timeline entry ${target.entry.sequence}`}
              </Text>
              <Pressable
                accessibilityLabel="Cancel entry action"
                accessibilityRole="button"
                disabled={busy}
                onPress={onDismiss}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.closeButtonText}>Cancel</Text>
              </Pressable>
            </View>

            <View accessible style={styles.retainedNotice}>
              <Text style={styles.retainedTitle}>Original entry retained</Text>
              <Text style={styles.retainedText}>
                {action === 'correction'
                  ? 'Submitting appends a correction linked to the original. It never rewrites or deletes history.'
                  : 'Redaction hides the original from outward views, but the original remains retained in append-only history.'}
              </Text>
            </View>
            <Text accessibilityRole="summary" style={styles.safetyHelp}>
              Current content: {timelineEntryText(target)}
            </Text>

            {action !== 'correction' ||
            visibleEntry === null ? null : visibleEntry.kind === 'text' ? (
              <View style={styles.editorSection}>
                <Text style={styles.inputLabel}>Corrected text</Text>
                <TextInput
                  accessibilityLabel="Corrected timeline text"
                  editable={!busy}
                  maxLength={TEXT_LIMIT}
                  multiline
                  onChangeText={(value) => {
                    setText(value);
                    setValidationError(null);
                  }}
                  style={[styles.textField, styles.multilineField]}
                  value={text}
                />
              </View>
            ) : visibleEntry.kind === 'location' ? (
              <View style={styles.editorSection}>
                {visibleEntry.payload.state === 'known' ? (
                  <>
                    <Text style={styles.inputLabel}>Latitude</Text>
                    <TextInput
                      accessibilityLabel="Corrected latitude"
                      editable={!busy}
                      keyboardType="numbers-and-punctuation"
                      onChangeText={setKnownLatitude}
                      style={styles.textField}
                      value={knownLatitude}
                    />
                    <Text style={styles.inputLabel}>Longitude</Text>
                    <TextInput
                      accessibilityLabel="Corrected longitude"
                      editable={!busy}
                      keyboardType="numbers-and-punctuation"
                      onChangeText={setKnownLongitude}
                      style={styles.textField}
                      value={knownLongitude}
                    />
                    <Text style={styles.inputLabel}>
                      Accuracy radius in metres
                    </Text>
                    <TextInput
                      accessibilityLabel="Corrected accuracy radius in metres"
                      editable={!busy}
                      keyboardType="decimal-pad"
                      onChangeText={setKnownAccuracy}
                      style={styles.textField}
                      value={knownAccuracy}
                    />
                  </>
                ) : null}
                {visibleEntry.payload.state === 'unknown' ? null : (
                  <>
                    <Text style={styles.inputLabel}>Location label</Text>
                    <TextInput
                      accessibilityLabel="Corrected location label"
                      editable={!busy}
                      maxLength={LOCATION_LABEL_LIMIT}
                      onChangeText={setLocationLabel}
                      style={styles.textField}
                      value={locationLabel}
                    />
                  </>
                )}
                {visibleEntry.payload.state === 'known' ? null : (
                  <>
                    <Text style={styles.inputLabel}>Location detail</Text>
                    <TextInput
                      accessibilityLabel="Corrected location detail"
                      editable={!busy}
                      maxLength={LOCATION_REASON_LIMIT}
                      multiline
                      onChangeText={setLocationDetail}
                      style={[styles.textField, styles.multilineField]}
                      value={locationDetail}
                    />
                  </>
                )}
              </View>
            ) : null}

            <Text style={styles.inputLabel}>
              {action === 'correction'
                ? 'Reason for correction'
                : 'Reason for redaction'}
            </Text>
            <TextInput
              accessibilityLabel={
                action === 'correction'
                  ? 'Reason for correction'
                  : 'Reason for redaction'
              }
              editable={!busy}
              maxLength={JOURNAL_ACTION_REASON_LIMIT}
              multiline
              onChangeText={(value) => {
                setReason(value);
                setValidationError(null);
              }}
              placeholder="Explain the retained audit reason"
              style={[styles.textField, styles.multilineField]}
              value={reason}
            />
            {validationError === null && error === null ? null : (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {validationError ?? error}
              </Text>
            )}
            <ActionButton
              destructive={action === 'redaction'}
              disabled={busy}
              label={
                busy
                  ? 'Submitting…'
                  : action === 'correction'
                    ? 'Append correction'
                    : 'Append redaction'
              }
              onPress={submit}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export interface LifecycleConfirmationDialogProps {
  readonly visible: boolean;
  readonly action: LifecycleAction;
  readonly mode: TemplateMode;
  readonly target: EventRoomTargetIdentity;
  readonly preview: LifecycleConsequencePreview | null;
  readonly loadingPreview: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly phrase: string;
  readonly onPhraseChange: (value: string) => void;
  readonly onDismiss: () => void;
  readonly onRefreshPreview: () => void;
  readonly onConfirm: () => void;
}

/** Exact-phrase, foreground-only lifecycle consequence confirmation UI. */
export function LifecycleConfirmationDialog({
  action,
  busy,
  error,
  loadingPreview,
  mode,
  onConfirm,
  onDismiss,
  onPhraseChange,
  onRefreshPreview,
  phrase,
  preview,
  target,
  visible,
}: LifecycleConfirmationDialogProps) {
  const requiredPhrase = action === 'all-clear' ? 'ALL CLEAR' : 'CLOSE EVENT';
  const [freshnessTick, setFreshnessTick] = useState(0);
  const previewExpiresAt =
    preview === null ? Number.NaN : Date.parse(preview.expiresAt);
  const previewFresh =
    preview !== null &&
    Number.isFinite(previewExpiresAt) &&
    Date.now() < previewExpiresAt;
  const previewReady =
    action === 'close' || (preview?.sendReadiness === 'ready' && previewFresh);
  const canConfirm =
    !busy && !loadingPreview && previewReady && phrase === requiredPhrase;

  useEffect(() => {
    if (action !== 'all-clear' || preview === null) return;
    const expiresAt = Date.parse(preview.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    const handle = setTimeout(
      () => setFreshnessTick((value) => value + 1),
      Math.min(expiresAt - Date.now() + 1, 2_147_000_000),
    );
    return () => clearTimeout(handle);
  }, [action, freshnessTick, preview]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onDismiss}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.modalPage}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalPage}
        >
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalTitleRow}>
              <Text accessibilityRole="header" style={styles.modalTitle}>
                {action === 'all-clear'
                  ? 'Confirm all-clear'
                  : 'Confirm event close'}
              </Text>
              <Pressable
                accessibilityLabel="Cancel confirmation"
                accessibilityRole="button"
                onPress={onDismiss}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.closeButtonText}>Cancel</Text>
              </Pressable>
            </View>

            <EventTargetContext mode={mode} target={target} />

            {action === 'all-clear' ? (
              loadingPreview ? (
                <View accessibilityRole="progressbar" style={styles.loadingBox}>
                  <ActivityIndicator color="#17324D" />
                  <Text style={styles.secondaryText}>
                    Fetching a fresh consequence preview…
                  </Text>
                </View>
              ) : preview === null ? (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>Preview unavailable</Text>
                  <Text style={styles.warningText}>
                    A fresh server preview is required before all-clear.
                  </Text>
                  <ActionButton
                    disabled={busy}
                    label="Fetch fresh preview"
                    onPress={onRefreshPreview}
                  />
                </View>
              ) : (
                <View style={styles.previewCard} testID="all-clear-preview">
                  <Text accessibilityRole="header" style={styles.sectionTitle}>
                    Server consequence preview
                  </Text>
                  <Text style={styles.previewFact}>
                    Recipients: {preview.recipientCount}
                  </Text>
                  <Text style={styles.previewFact}>
                    Readiness:{' '}
                    {preview.sendReadiness === 'ready' ? 'Ready' : 'Blocked'}
                  </Text>
                  <Text style={styles.previewFact}>
                    Consequence: change this event to all-clear and create a{' '}
                    {
                      getEventTheme(preview.templateMode, preview.kind)
                        .classificationWord
                    }{' '}
                    all-clear notification for the channel plan below.
                  </Text>
                  <View style={styles.channelList}>
                    {preview.channels.map((channel) => {
                      const copy = renderedChannelCopy(channel);
                      return (
                        <View
                          key={channel.channel}
                          accessible
                          accessibilityLabel={`${channel.channel}. ${channel.endpointCount} endpoints. Integration ${channel.integrationStatus.label}. Message preview: ${copy}`}
                          style={styles.channelRow}
                        >
                          <Text style={styles.channelName}>
                            {channel.channel}
                          </Text>
                          <Text style={styles.channelDetail}>
                            {channel.endpointCount} endpoints ·{' '}
                            {channel.integrationStatus.label}
                          </Text>
                          <Text style={styles.channelMessage}>{copy}</Text>
                        </View>
                      );
                    })}
                  </View>
                  {preview.blockingReasonCodes.length === 0 ? null : (
                    <Text accessibilityRole="alert" style={styles.warningText}>
                      This action is unavailable because one or more server
                      prerequisites are not ready. Refresh the preview; if it
                      remains blocked, contact an administrator.
                    </Text>
                  )}
                  <Text selectable style={styles.digestText}>
                    Consequence reference: {preview.consequenceDigest}
                  </Text>
                  <Text style={styles.expiryText}>
                    Preview expires{' '}
                    {new Date(preview.expiresAt).toLocaleString()}.
                  </Text>
                  {previewFresh ? null : (
                    <View style={styles.warningBox}>
                      <Text
                        accessibilityRole="alert"
                        style={styles.warningText}
                      >
                        This consequence preview expired. Fetch and review a
                        fresh preview before confirming.
                      </Text>
                      <ActionButton
                        disabled={busy}
                        label="Fetch fresh preview"
                        onPress={onRefreshPreview}
                      />
                    </View>
                  )}
                </View>
              )
            ) : (
              <View style={styles.previewCard}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  Consequence
                </Text>
                <Text style={styles.previewFact}>
                  This closes the all-clear event record. Closing does not send
                  another notification. The append-only timeline remains
                  retained.
                </Text>
              </View>
            )}

            <View style={styles.phraseGroup}>
              <Text style={styles.inputLabel}>
                Type {requiredPhrase} exactly
              </Text>
              <TextInput
                accessibilityLabel={`Type ${requiredPhrase} exactly`}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!busy}
                onChangeText={onPhraseChange}
                style={styles.phraseInput}
                testID="lifecycle-confirmation-input"
                value={phrase}
              />
            </View>

            {error === null ? null : (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            )}

            <ActionButton
              accessibilityHint={`Requires the exact phrase ${requiredPhrase}`}
              destructive
              disabled={!canConfirm}
              label={
                busy
                  ? 'Submitting…'
                  : action === 'all-clear'
                    ? 'Issue all-clear'
                    : 'Close event'
              }
              onPress={onConfirm}
              testID="lifecycle-confirm-button"
            />
            <Text style={styles.noRetryText}>
              PSD EOC never submits this action in the background and never
              retries it automatically.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export interface LocationComposerDialogProps {
  readonly visible: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  readonly captureBusy?: boolean;
  readonly submitBusy?: boolean;
  readonly templateMode: TemplateMode;
  readonly target: EventRoomTargetIdentity;
  readonly mode: LocationMode;
  readonly known: KnownLocation | null;
  readonly knownLabel: string;
  readonly ambiguousLabel: string;
  readonly ambiguousReason: string;
  readonly unknownReason: string;
  readonly error: string | null;
  readonly onDismiss: () => void;
  readonly onModeChange: (mode: LocationMode) => void;
  readonly onCapture: () => void;
  readonly onAdjust: (direction: 'north' | 'south' | 'east' | 'west') => void;
  readonly onKnownLabelChange: (value: string) => void;
  readonly onAmbiguousLabelChange: (value: string) => void;
  readonly onAmbiguousReasonChange: (value: string) => void;
  readonly onUnknownReasonChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function LocationComposerDialog(props: LocationComposerDialogProps) {
  const captureBusy = props.captureBusy ?? props.busy;
  const submitBusy = props.submitBusy ?? props.busy;
  const valid =
    (props.mode === 'known' && props.known !== null) ||
    (props.mode === 'ambiguous' &&
      props.ambiguousLabel.trim().length > 0 &&
      props.ambiguousReason.trim().length > 0) ||
    (props.mode === 'unknown' && props.unknownReason.trim().length > 0);

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onDismiss}
      presentationStyle="pageSheet"
      visible={props.visible}
    >
      <SafeAreaView style={styles.modalPage}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalPage}
        >
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalTitleRow}>
              <Text accessibilityRole="header" style={styles.modalTitle}>
                Post a location
              </Text>
              <Pressable
                accessibilityLabel="Close location composer"
                accessibilityRole="button"
                onPress={props.onDismiss}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.closeButtonText}>Done</Text>
              </Pressable>
            </View>

            <EventTargetContext
              mode={props.templateMode}
              target={props.target}
            />
            <Text style={styles.secondaryText}>
              Choose the truth you know. PSD EOC does not infer location from
              photos and does not turn uncertainty into coordinates.
            </Text>
            <Text accessibilityRole="summary" style={styles.safetyHelp}>
              Do not include student data. Post only the precision you can
              support. Corrections append a new entry; they never rewrite
              history.
            </Text>
            <View accessibilityRole="tablist" style={styles.segmentedRow}>
              {(['known', 'ambiguous', 'unknown'] as const).map((mode) => (
                <Pressable
                  accessibilityLabel={`${mode} location`}
                  accessibilityRole="tab"
                  accessibilityState={{
                    disabled: props.busy,
                    selected: props.mode === mode,
                  }}
                  disabled={props.busy}
                  key={mode}
                  onPress={() => props.onModeChange(mode)}
                  style={({ pressed }) => [
                    styles.segmentButton,
                    props.mode === mode && styles.segmentButtonSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      props.mode === mode && styles.segmentTextSelected,
                    ]}
                  >
                    {mode[0]?.toUpperCase()}
                    {mode.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>

            {props.mode === 'known' ? (
              <View style={styles.editorSection}>
                <ActionButton
                  disabled={props.busy}
                  label={
                    captureBusy
                      ? 'Capturing GPS…'
                      : props.known === null
                        ? 'Capture foreground GPS'
                        : 'Recapture foreground GPS'
                  }
                  onPress={props.onCapture}
                />
                {props.known === null ? (
                  <Text style={styles.secondaryText}>
                    No coordinate fix has been captured.
                  </Text>
                ) : (
                  <View
                    accessibilityLabel={`${formatLocationPayload({
                      ...props.known,
                      label: props.knownLabel.trim() || null,
                    })} Exact GPS-reported accuracy ${props.known.accuracyMeters} metres.`}
                    accessible
                    style={styles.locationTruthCard}
                  >
                    <Text style={styles.locationCoordinate}>
                      Latitude {props.known.latitude.toFixed(6)}
                    </Text>
                    <Text style={styles.locationCoordinate}>
                      Longitude {props.known.longitude.toFixed(6)}
                    </Text>
                    <Text style={styles.locationAccuracy}>
                      Exact GPS-reported accuracy: {props.known.accuracyMeters}{' '}
                      metres
                    </Text>
                    <Text style={styles.locationAccuracy}>
                      Conservative display radius:{' '}
                      {formatAccuracyRadius(props.known.accuracyMeters)}
                    </Text>
                    <Text style={styles.roomDisclaimer}>
                      GPS does not establish room-level location. The displayed
                      accuracy radius is preserved exactly and is not improved
                      by moving the pin.
                    </Text>
                  </View>
                )}
                <Text style={styles.inputLabel}>Optional location label</Text>
                <TextInput
                  accessibilityLabel="Optional known location label"
                  editable={!props.busy}
                  maxLength={LOCATION_LABEL_LIMIT}
                  onChangeText={props.onKnownLabelChange}
                  placeholder="For example, west entrance"
                  style={styles.textField}
                  value={props.knownLabel}
                />
                <Text style={styles.inputLabel}>
                  Adjust pin in 5 metre steps
                </Text>
                <View style={styles.adjustGrid}>
                  {(['north', 'south', 'east', 'west'] as const).map(
                    (direction) => (
                      <Pressable
                        accessibilityLabel={`Move pin 5 metres ${direction}`}
                        accessibilityRole="button"
                        accessibilityState={{
                          disabled: props.known === null || props.busy,
                        }}
                        disabled={props.known === null || props.busy}
                        key={direction}
                        onPress={() => props.onAdjust(direction)}
                        style={({ pressed }) => [
                          styles.adjustButton,
                          (props.known === null || props.busy) &&
                            styles.disabledButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.adjustText}>
                          {direction[0]?.toUpperCase()}
                          {direction.slice(1)} 5 m
                        </Text>
                      </Pressable>
                    ),
                  )}
                </View>
              </View>
            ) : props.mode === 'ambiguous' ? (
              <View style={styles.editorSection}>
                <Text style={styles.inputLabel}>Approximate label</Text>
                <TextInput
                  accessibilityLabel="Ambiguous location label"
                  editable={!props.busy}
                  maxLength={LOCATION_LABEL_LIMIT}
                  onChangeText={props.onAmbiguousLabelChange}
                  placeholder="For example, near the gym"
                  style={styles.textField}
                  value={props.ambiguousLabel}
                />
                <Text style={styles.inputLabel}>Why it is ambiguous</Text>
                <TextInput
                  accessibilityLabel="Reason location is ambiguous"
                  editable={!props.busy}
                  maxLength={LOCATION_REASON_LIMIT}
                  multiline
                  onChangeText={props.onAmbiguousReasonChange}
                  placeholder="Describe what remains uncertain"
                  style={[styles.textField, styles.multilineField]}
                  value={props.ambiguousReason}
                />
                <Text style={styles.roomDisclaimer}>
                  Ambiguous posts contain no coordinates or claimed accuracy.
                </Text>
              </View>
            ) : (
              <View style={styles.editorSection}>
                <Text style={styles.inputLabel}>Why location is unknown</Text>
                <TextInput
                  accessibilityLabel="Reason location is unknown"
                  editable={!props.busy}
                  maxLength={LOCATION_REASON_LIMIT}
                  multiline
                  onChangeText={props.onUnknownReasonChange}
                  placeholder="For example, it is not safe to determine location"
                  style={[styles.textField, styles.multilineField]}
                  value={props.unknownReason}
                />
                <Text style={styles.roomDisclaimer}>
                  Unknown posts contain no coordinates or claimed accuracy.
                </Text>
              </View>
            )}

            {props.error === null ? null : (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {props.error}
              </Text>
            )}
            <ActionButton
              disabled={!props.online || !valid || props.busy}
              label={submitBusy ? 'Posting…' : 'Post location'}
              onPress={props.onSubmit}
            />
            {!props.online ? (
              <Text accessibilityRole="alert" style={styles.offlineText}>
                {OFFLINE_ACTION_MESSAGE}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export interface PhotoComposerDialogProps {
  readonly newPostsAllowed: boolean;
  readonly onDismiss: () => void;
  readonly online: boolean;
  readonly photo: EventPhotoDraftWorkflow;
  readonly target: EventRoomTargetIdentity;
  readonly templateMode: TemplateMode;
  readonly visible: boolean;
}

export function PhotoComposerDialog({
  newPostsAllowed,
  onDismiss,
  online,
  photo,
  target,
  templateMode,
  visible,
}: PhotoComposerDialogProps) {
  const draft = photo.draft;
  const selected = draft !== null && draft.stage !== 'describe';
  const progress = Math.round(
    Math.max(0, Math.min(1, draft?.progress ?? 0)) * 100,
  );
  const retryable =
    draft !== null &&
    ['failed', 'unknown', 'cleanup-pending', 'blocked'].includes(draft.stage);
  const recoveryOnly = !newPostsAllowed || draft?.localCleanupOnly === true;
  const descriptionEditable =
    !recoveryOnly &&
    !photo.busy &&
    (draft?.stage === 'describe' || draft?.stage === 'ready');

  const confirmDiscard = () => {
    Alert.alert(
      'Discard retained photo draft?',
      draft?.localCleanupOnly === true
        ? 'This explicitly removes or releases only the exact owner-bound private local data. It cannot post or replay anything here.'
        : !newPostsAllowed
          ? 'This event is closed. This explicitly removes the private local draft and its replay data without posting or uploading anything.'
          : 'This explicitly removes the private draft. Closing this composer alone keeps it.',
      [
        { text: 'Keep draft', style: 'cancel' },
        {
          text: 'Discard draft',
          style: 'destructive',
          onPress: () => {
            void photo.discard();
          },
        },
      ],
    );
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onDismiss}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.modalPage}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalPage}
        >
          <ScrollView
            contentContainerStyle={styles.modalContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalTitleRow}>
              <Text accessibilityRole="header" style={styles.modalTitle}>
                {recoveryOnly ? 'Recover photo draft' : 'Post a photo'}
              </Text>
              <Pressable
                accessibilityHint="Closes this sheet and keeps the draft"
                accessibilityLabel="Close and keep photo draft"
                accessibilityRole="button"
                onPress={onDismiss}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.closeButtonText}>Keep & close</Text>
              </Pressable>
            </View>

            <EventTargetContext mode={templateMode} target={target} />
            <View accessibilityRole="summary" style={styles.retainedNotice}>
              <Text style={styles.retainedTitle}>Draft retained privately</Text>
              <Text style={styles.retainedText}>
                Closing this sheet, losing connection, or backgrounding the app
                does not silently discard or automatically post the draft.
              </Text>
            </View>
            <Text accessibilityRole="summary" style={styles.safetyHelp}>
              Do not include student data. Photos are untrusted input; PSD EOC
              validates their bytes and strips EXIF and GPS metadata. Record
              location only through the explicit location workflow.
            </Text>

            <Text style={styles.inputLabel}>Alternative text (required)</Text>
            <TextInput
              accessibilityHint="Describe the important visual information for screen-reader users"
              accessibilityLabel="Photo alternative text, required"
              editable={descriptionEditable}
              maxLength={500}
              multiline
              onChangeText={photo.setAltText}
              placeholder="Describe what the photo shows"
              style={[styles.textField, styles.multilineField]}
              value={draft?.altText ?? ''}
            />
            <Text style={styles.inputLabel}>Optional caption</Text>
            <TextInput
              accessibilityLabel="Optional photo caption"
              editable={descriptionEditable}
              maxLength={2_000}
              multiline
              onChangeText={photo.setCaption}
              placeholder="Add context for staff"
              style={[styles.textField, styles.multilineField]}
              value={draft?.caption ?? ''}
            />

            {descriptionEditable ? null : (
              <Text accessibilityRole="summary" style={styles.safetyHelp}>
                {draft?.localCleanupOnly === true
                  ? 'The retained description is read-only and cannot be adopted by this event or signed-in session.'
                  : 'Photo description is locked after network work starts. The retained canonical alternative text and caption cannot be changed during retry, reconciliation, or private cleanup.'}
              </Text>
            )}

            {recoveryOnly ? null : (
              <View style={styles.actionGroup}>
                <ActionButton
                  disabled={
                    selected ||
                    photo.busy ||
                    (draft?.altText.trim().length ?? 0) === 0
                  }
                  label="Take Photo"
                  onPress={() => {
                    void photo.takePhoto();
                  }}
                />
                <ActionButton
                  disabled={
                    selected ||
                    photo.busy ||
                    (draft?.altText.trim().length ?? 0) === 0
                  }
                  label="Choose Existing Photo"
                  onPress={() => {
                    void photo.choosePhoto();
                  }}
                />
                {selected ? (
                  <Text accessibilityRole="summary" style={styles.safetyHelp}>
                    Photo retained privately and ready to upload.
                  </Text>
                ) : null}
              </View>
            )}

            {draft === null ? null : (
              <View style={styles.progressCard}>
                <Text style={styles.progressTitle}>
                  Stage: {draft.stage.replaceAll('-', ' ')}
                </Text>
                <View
                  accessibilityLabel={`Photo progress ${progress} percent`}
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: 100, now: progress }}
                  style={styles.progressTrack}
                >
                  <View
                    style={[styles.progressFill, { width: `${progress}%` }]}
                  />
                </View>
                <Text style={styles.progressText}>{progress}%</Text>
              </View>
            )}

            {draft?.error === null || draft?.error === undefined ? null : (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {draft.error}
              </Text>
            )}
            {retryable && draft?.localCleanupOnly !== true ? (
              <ActionButton
                disabled={
                  photo.busy ||
                  (draft?.stage !== 'blocked' &&
                    newPostsAllowed &&
                    draft?.stage !== 'cleanup-pending' &&
                    !online)
                }
                label={
                  draft?.stage === 'blocked'
                    ? 'Retry local recovery'
                    : draft?.stage === 'cleanup-pending'
                      ? 'Retry private cleanup'
                      : !newPostsAllowed
                        ? 'Reconcile with timeline'
                        : 'Retry retained draft'
                }
                onPress={() => {
                  void photo.retry();
                }}
              />
            ) : null}
            {recoveryOnly ? null : (
              <ActionButton
                disabled={
                  !online ||
                  photo.busy ||
                  draft?.stage !== 'ready' ||
                  (draft?.altText.trim().length ?? 0) === 0
                }
                label={
                  photo.busy ? 'Working with photo…' : 'Upload and post photo'
                }
                onPress={() => {
                  void photo.submit();
                }}
              />
            )}
            <Pressable
              accessibilityLabel="Discard retained photo draft"
              accessibilityRole="button"
              onPress={confirmDiscard}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Discard draft…</Text>
            </Pressable>
            {!online ? (
              <Text accessibilityRole="alert" style={styles.offlineText}>
                {OFFLINE_ACTION_MESSAGE}
              </Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function AuthenticatedEventRoomScreen({
  auth,
  eventId,
  sessionId,
}: Readonly<{
  auth: MobileAuthContextValue;
  eventId: string;
  sessionId: string;
}>) {
  const { assertMutationAllowed, requestAuthenticated, state } = auth;
  const api = useMemo(
    () => new EventRoomApi(requestAuthenticated),
    [requestAuthenticated],
  );
  const controller = useMemo(
    () =>
      new EventRoomSyncController(eventId, api, (message) => {
        AccessibilityInfo.announceForAccessibility(message);
      }),
    [api, eventId],
  );
  const sync = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const listRef = useRef<FlatList<JournalEntryReadProjection>>(null);
  const nearLiveEdgeRef = useRef(true);
  const followOnNextLayoutRef = useRef(true);
  const previousEntryCountRef = useRef(0);

  const [textDraft, setTextDraft] = useState('');
  const [textBusy, setTextBusy] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const textMutationIdentityRef = useRef<JournalMutationIdentity | null>(null);

  const [journalActionTarget, setJournalActionTarget] = useState<Readonly<{
    action: JournalEntryAction;
    projection: JournalEntryReadProjection;
  }> | null>(null);
  const [journalActionBusy, setJournalActionBusy] = useState(false);
  const [journalActionErrorText, setJournalActionErrorText] = useState<
    string | null
  >(null);
  const journalActionMutationIdentityRef =
    useRef<JournalMutationIdentity | null>(null);

  const [composer, setComposer] = useState<'location' | 'photo' | null>(null);
  const [locationMode, setLocationMode] = useState<LocationMode>('known');
  const [knownLocation, setKnownLocation] = useState<KnownLocation | null>(
    null,
  );
  const [knownLabel, setKnownLabel] = useState('');
  const [ambiguousLabel, setAmbiguousLabel] = useState('');
  const [ambiguousReason, setAmbiguousReason] = useState('');
  const [unknownReason, setUnknownReason] = useState('');
  const [locationCaptureBusy, setLocationCaptureBusy] = useState(false);
  const [locationSubmitBusy, setLocationSubmitBusy] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const locationMutationIdentityRef = useRef<JournalMutationIdentity | null>(
    null,
  );
  const locationCaptureGenerationRef = useRef(0);
  const locationCaptureActiveRef = useRef(false);

  const [lifecycleAction, setLifecycleAction] =
    useState<LifecycleAction | null>(null);
  const [lifecyclePreview, setLifecyclePreview] =
    useState<LifecycleConsequencePreview | null>(null);
  const [lifecyclePhrase, setLifecyclePhrase] = useState('');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleLoadingPreview, setLifecycleLoadingPreview] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const lifecycleAbortRef = useRef<AbortController | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const lifecycleIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      locationCaptureGenerationRef.current += 1;
      lifecycleGenerationRef.current += 1;
      lifecycleAbortRef.current?.abort();
      lifecycleAbortRef.current = null;
    },
    [],
  );

  const online = state.phase === 'online';
  const event = sync.model.event;
  const eventClosed = event?.status === 'closed';
  const eventAcceptsPosts = eventStatusAcceptsTimelinePosts(event?.status);

  const followConfirmedEntry = useCallback(
    (projection: JournalEntryReadProjection) => {
      if (nearLiveEdgeRef.current) followOnNextLayoutRef.current = true;
      controller.applyConfirmed(null, [projection]);
    },
    [controller],
  );

  const photo = useEventPhotoDraft({
    eventId,
    sessionId,
    newPostsAllowed: eventAcceptsPosts,
    api,
    entries: sync.model.entries,
    onAppended: followConfirmedEntry,
  });

  const journalActionsAuthorized =
    event !== null &&
    state.session !== null &&
    userCanManageEventJournal(
      state.session.user.roles,
      state.session.user.facilityScope,
      event.facilityId,
    );

  const openJournalAction = useCallback(
    (action: JournalEntryAction, projection: JournalEntryReadProjection) => {
      journalActionMutationIdentityRef.current = null;
      setJournalActionErrorText(null);
      setJournalActionTarget(Object.freeze({ action, projection }));
    },
    [],
  );

  const dismissJournalAction = useCallback(() => {
    if (journalActionBusy) return;
    journalActionMutationIdentityRef.current = null;
    setJournalActionErrorText(null);
    setJournalActionTarget(null);
  }, [journalActionBusy]);

  const submitJournalAction = useCallback(
    async (submission: JournalActionSubmission) => {
      const selected = journalActionTarget;
      if (selected === null || journalActionBusy) return;
      setJournalActionBusy(true);
      setJournalActionErrorText(null);
      try {
        assertMutationAllowed();
        const currentModel = controller.getSnapshot().model;
        const current = currentModel.entries.find(
          ({ entry }) => entry.id === selected.projection.entry.id,
        );
        if (current === undefined || !journalActionsAuthorized) {
          throw new Error(
            'This timeline entry is no longer available to your current site access. Refresh and choose it again.',
          );
        }
        const eligibility = journalEntryActionEligibility(
          current,
          currentModel.entries,
          currentModel.historyComplete,
        );
        const availability = eligibility[selected.action];
        if (!availability.allowed) {
          throw new Error(
            availability.unavailableReason ??
              'This entry action is no longer available.',
          );
        }
        if (submission.action !== selected.action) {
          throw new Error('The selected entry action changed. Open it again.');
        }
        const canonicalDraft = JSON.stringify({
          action: submission.action,
          entryId: current.entry.id,
          entrySequence: current.entry.sequence,
          submission,
        });
        const identity = retainJournalMutationIdentity(
          journalActionMutationIdentityRef.current,
          canonicalDraft,
          Crypto.randomUUID,
          () => new Date().toISOString(),
        );
        journalActionMutationIdentityRef.current = identity;
        const target = {
          entryId: current.entry.id,
          entrySequence: current.entry.sequence,
        };
        let projection: JournalEntryReadProjection;
        if (submission.action === 'redaction') {
          projection = await api.redactEntry(
            eventId,
            sessionId,
            target,
            submission.reason,
            identity.idempotencyKey,
            identity.clientTime,
          );
        } else if (
          current.visibility === 'visible' &&
          current.entry.kind === 'text' &&
          submission.replacement.kind === 'text'
        ) {
          const correctable: CorrectableJournalEntry = current.entry;
          projection = await api.correctText(
            eventId,
            sessionId,
            {
              entryId: correctable.id,
              entrySequence: correctable.sequence,
            },
            submission.replacement.text,
            submission.reason,
            identity.idempotencyKey,
            identity.clientTime,
          );
        } else if (
          current.visibility === 'visible' &&
          current.entry.kind === 'location' &&
          submission.replacement.kind === 'location'
        ) {
          const correctable: CorrectableJournalEntry = current.entry;
          projection = await api.correctLocation(
            eventId,
            sessionId,
            {
              entryId: correctable.id,
              entrySequence: correctable.sequence,
            },
            submission.replacement.payload,
            submission.reason,
            identity.idempotencyKey,
            identity.clientTime,
          );
        } else {
          throw new Error(
            'The replacement no longer matches this entry. Refresh and choose it again.',
          );
        }
        followConfirmedEntry(projection);
        journalActionMutationIdentityRef.current = null;
        setJournalActionTarget(null);
      } catch (error) {
        setJournalActionErrorText(journalActionError(error));
      } finally {
        setJournalActionBusy(false);
      }
    },
    [
      api,
      assertMutationAllowed,
      controller,
      eventId,
      followConfirmedEntry,
      journalActionBusy,
      journalActionTarget,
      journalActionsAuthorized,
      sessionId,
    ],
  );

  const dismissLifecycle = useCallback(() => {
    lifecycleGenerationRef.current += 1;
    lifecycleAbortRef.current?.abort();
    lifecycleAbortRef.current = null;
    lifecycleIdempotencyKeyRef.current = null;
    setLifecycleAction(null);
    setLifecyclePreview(null);
    setLifecyclePhrase('');
    setLifecycleBusy(false);
    setLifecycleLoadingPreview(false);
    setLifecycleError(null);
  }, []);

  useEffect(() => {
    let appActive = AppState.currentState === 'active';
    const updateSync = () => {
      if (appActive && state.phase === 'online') {
        void controller.start();
      } else {
        controller.pause();
      }
    };
    updateSync();
    const subscription = AppState.addEventListener('change', (nextState) => {
      appActive = nextState === 'active';
      if (!appActive) {
        if (locationCaptureActiveRef.current) {
          locationCaptureGenerationRef.current += 1;
          locationCaptureActiveRef.current = false;
          setLocationCaptureBusy(false);
          setLocationError(
            'GPS capture stopped when the app left the foreground. Capture again or choose ambiguous or unknown.',
          );
        }
        dismissLifecycle();
      }
      updateSync();
    });
    return () => subscription.remove();
  }, [controller, dismissLifecycle, state.phase]);

  useEffect(() => () => controller.stop(), [controller]);

  useLayoutEffect(() => {
    const count = sync.model.entries.length;
    if (count > previousEntryCountRef.current && nearLiveEdgeRef.current) {
      followOnNextLayoutRef.current = true;
    }
    previousEntryCountRef.current = count;
  }, [sync.model.entries.length]);

  useEffect(() => {
    if (!online && lifecycleAction !== null) dismissLifecycle();
  }, [dismissLifecycle, lifecycleAction, online]);

  useEffect(() => {
    if (eventAcceptsPosts) return;
    locationCaptureGenerationRef.current =
      invalidateLocationCaptureForPostingState(
        false,
        locationCaptureGenerationRef.current,
      );
    locationCaptureActiveRef.current = false;
    setLocationCaptureBusy(false);
    if (composer !== 'photo') setComposer(null);
  }, [composer, eventAcceptsPosts]);

  const submitText = useCallback(async () => {
    const text = textDraft.trim();
    if (text.length === 0 || textBusy || !eventAcceptsPosts) return;
    setTextBusy(true);
    setTextError(null);
    try {
      assertMutationAllowed();
      const identity = retainJournalMutationIdentity(
        textMutationIdentityRef.current,
        text,
        Crypto.randomUUID,
        () => new Date().toISOString(),
      );
      textMutationIdentityRef.current = identity;
      const projection = await api.postText(
        eventId,
        sessionId,
        text,
        identity.idempotencyKey,
        identity.clientTime,
      );
      followConfirmedEntry(projection);
      textMutationIdentityRef.current = null;
      setTextDraft('');
    } catch (error) {
      setTextError(
        publicError(error, 'The update was not posted. Your text is retained.'),
      );
    } finally {
      setTextBusy(false);
    }
  }, [
    api,
    assertMutationAllowed,
    eventAcceptsPosts,
    eventId,
    followConfirmedEntry,
    sessionId,
    textBusy,
    textDraft,
  ]);

  const resetLocationFailure = () => setLocationError(null);

  const captureLocation = useCallback(async () => {
    if (
      locationCaptureBusy ||
      locationSubmitBusy ||
      !eventAcceptsPosts ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    const generation = locationCaptureGenerationRef.current + 1;
    locationCaptureGenerationRef.current = generation;
    locationCaptureActiveRef.current = true;
    setLocationCaptureBusy(true);
    setLocationError(null);
    try {
      const isCurrentForegroundCapture = () =>
        locationCaptureGenerationRef.current === generation &&
        AppState.currentState === 'active' &&
        eventStatusAcceptsTimelinePosts(
          controller.getSnapshot().model.event?.status,
        );
      const captured = await captureForegroundPosition({
        requestPermission: Location.requestForegroundPermissionsAsync,
        getPosition: () =>
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          }),
        isCurrentForegroundCapture,
      });
      const accuracy = captured.coords.accuracy;
      if (accuracy === null || !Number.isFinite(accuracy) || accuracy <= 0) {
        throw new Error(
          'GPS did not provide an accuracy radius. Choose ambiguous or unknown instead.',
        );
      }
      const parsed = LocationPayloadSchema.safeParse({
        state: 'known',
        latitude: captured.coords.latitude,
        longitude: captured.coords.longitude,
        accuracyMeters: accuracy,
        label: knownLabel.trim() || null,
      });
      if (!parsed.success || parsed.data.state !== 'known') {
        throw new Error(
          'GPS returned invalid coordinates or accuracy. Choose ambiguous or unknown instead.',
        );
      }
      setKnownLocation(parsed.data);
      resetLocationFailure();
    } catch (error) {
      if (locationCaptureGenerationRef.current === generation) {
        setLocationError(
          publicError(error, 'PSD EOC could not capture foreground GPS.'),
        );
      }
    } finally {
      if (locationCaptureGenerationRef.current === generation) {
        locationCaptureActiveRef.current = false;
        setLocationCaptureBusy(false);
      }
    }
  }, [
    controller,
    eventAcceptsPosts,
    knownLabel,
    locationCaptureBusy,
    locationSubmitBusy,
  ]);

  const dismissLocationComposer = useCallback(() => {
    locationCaptureGenerationRef.current += 1;
    locationCaptureActiveRef.current = false;
    setLocationCaptureBusy(false);
    if (!locationSubmitBusy) setLocationError(null);
    setComposer(null);
  }, [locationSubmitBusy]);

  const adjustLocation = useCallback(
    (direction: 'north' | 'south' | 'east' | 'west') => {
      setKnownLocation((current) =>
        current === null
          ? null
          : adjustKnownLocation(current, direction, PIN_ADJUSTMENT_METRES),
      );
      resetLocationFailure();
    },
    [],
  );

  const submitLocation = useCallback(async () => {
    if (locationCaptureBusy || locationSubmitBusy || !eventAcceptsPosts) return;
    let candidate: unknown;
    if (locationMode === 'known') {
      if (knownLocation === null) return;
      candidate = {
        ...knownLocation,
        label: knownLabel.trim() || null,
      };
    } else if (locationMode === 'ambiguous') {
      const label = ambiguousLabel.trim();
      const reason = ambiguousReason.trim();
      if (label.length === 0 || reason.length === 0) return;
      candidate = { state: 'ambiguous', label, reason };
    } else {
      const reason = unknownReason.trim();
      if (reason.length === 0) return;
      candidate = { state: 'unknown', reason };
    }
    const parsedPayload = LocationPayloadSchema.safeParse(candidate);
    if (!parsedPayload.success) {
      setLocationError(
        'The location draft is invalid. Review the label and reason before posting.',
      );
      return;
    }
    const payload = parsedPayload.data;

    setLocationSubmitBusy(true);
    setLocationError(null);
    try {
      assertMutationAllowed();
      const identity = retainJournalMutationIdentity(
        locationMutationIdentityRef.current,
        JSON.stringify(payload),
        Crypto.randomUUID,
        () => new Date().toISOString(),
      );
      locationMutationIdentityRef.current = identity;
      const projection = await api.postLocation(
        eventId,
        sessionId,
        payload,
        identity.idempotencyKey,
        identity.clientTime,
      );
      followConfirmedEntry(projection);
      locationMutationIdentityRef.current = null;
      setKnownLocation(null);
      setKnownLabel('');
      setAmbiguousLabel('');
      setAmbiguousReason('');
      setUnknownReason('');
      setComposer(null);
    } catch (error) {
      setLocationError(
        publicError(
          error,
          'The location was not posted. Your location draft is retained.',
        ),
      );
    } finally {
      setLocationSubmitBusy(false);
    }
  }, [
    ambiguousLabel,
    ambiguousReason,
    api,
    assertMutationAllowed,
    eventAcceptsPosts,
    eventId,
    followConfirmedEntry,
    knownLabel,
    knownLocation,
    locationCaptureBusy,
    locationMode,
    locationSubmitBusy,
    sessionId,
    unknownReason,
  ]);

  const fetchAllClearPreview = useCallback(async () => {
    const currentEvent = controller.getSnapshot().model.event;
    if (
      currentEvent === null ||
      currentEvent.status !== 'active' ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    setLifecycleAction('all-clear');
    setLifecyclePreview(null);
    setLifecyclePhrase('');
    setLifecycleError(null);
    setLifecycleLoadingPreview(true);
    lifecycleIdempotencyKeyRef.current = null;
    const generation = ++lifecycleGenerationRef.current;
    const abort = new AbortController();
    lifecycleAbortRef.current?.abort();
    lifecycleAbortRef.current = abort;
    try {
      assertMutationAllowed();
      const preview = await api.previewAllClear(
        eventId,
        Crypto.randomUUID(),
        abort.signal,
      );
      if (
        generation !== lifecycleGenerationRef.current ||
        abort.signal.aborted ||
        AppState.currentState !== 'active'
      ) {
        return;
      }
      if (
        preview.eventId !== currentEvent.id ||
        preview.kind !== currentEvent.kind ||
        preview.templateMode !== currentEvent.templateMode ||
        preview.eventTypeVersion.id !== currentEvent.eventTypeVersion.id ||
        preview.eventTypeVersion.templateMode !==
          currentEvent.eventTypeVersion.templateMode ||
        preview.rosterSnapshotId !== currentEvent.rosterSnapshotId ||
        preview.rosterPopulation !== currentEvent.rosterPopulation
      ) {
        throw new Error(
          'PSD EOC rejected a consequence preview that did not match this event.',
        );
      }
      setLifecyclePreview(preview);
    } catch (error) {
      if (
        !isAbortError(error) &&
        generation === lifecycleGenerationRef.current
      ) {
        setLifecycleError(
          publicError(error, 'A fresh all-clear preview is unavailable.'),
        );
      }
    } finally {
      if (generation === lifecycleGenerationRef.current) {
        setLifecycleLoadingPreview(false);
      }
      if (lifecycleAbortRef.current === abort) lifecycleAbortRef.current = null;
    }
  }, [api, assertMutationAllowed, controller, eventId]);

  const openCloseConfirmation = useCallback(() => {
    if (
      controller.getSnapshot().model.event?.status !== 'all-clear' ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    try {
      assertMutationAllowed();
      lifecycleGenerationRef.current += 1;
      lifecycleIdempotencyKeyRef.current = null;
      setLifecycleAction('close');
      setLifecyclePreview(null);
      setLifecyclePhrase('');
      setLifecycleBusy(false);
      setLifecycleLoadingPreview(false);
      setLifecycleError(null);
    } catch (error) {
      setTextError(publicError(error, OFFLINE_ACTION_MESSAGE));
    }
  }, [assertMutationAllowed, controller]);

  const submitLifecycle = useCallback(async () => {
    const action = lifecycleAction;
    const preview = lifecyclePreview;
    const requiredPhrase = action === 'all-clear' ? 'ALL CLEAR' : 'CLOSE EVENT';
    if (
      action === null ||
      lifecycleBusy ||
      lifecyclePhrase !== requiredPhrase ||
      AppState.currentState !== 'active'
    ) {
      return;
    }
    if (action === 'all-clear' && preview === null) return;
    if (
      action === 'all-clear' &&
      (!Number.isFinite(Date.parse(preview!.expiresAt)) ||
        Date.now() >= Date.parse(preview!.expiresAt))
    ) {
      lifecycleIdempotencyKeyRef.current = null;
      setLifecyclePreview(null);
      setLifecycleError(
        'The consequence preview expired. Fetch and review a fresh preview before confirming.',
      );
      return;
    }

    const generation = ++lifecycleGenerationRef.current;
    const abort = new AbortController();
    lifecycleAbortRef.current?.abort();
    lifecycleAbortRef.current = abort;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      assertMutationAllowed();
      const key = lifecycleIdempotencyKeyRef.current ?? Crypto.randomUUID();
      lifecycleIdempotencyKeyRef.current = key;
      const result =
        action === 'all-clear'
          ? await api.allClear(
              eventId,
              preview!.id,
              lifecyclePhrase,
              key,
              abort.signal,
            )
          : await api.close(eventId, lifecyclePhrase, key, abort.signal);
      if (
        generation !== lifecycleGenerationRef.current ||
        abort.signal.aborted ||
        AppState.currentState !== 'active'
      ) {
        return;
      }
      const entries = result.journalEntries.map((entry) =>
        projectJournalEntryForRead(entry, false),
      );
      if (nearLiveEdgeRef.current) followOnNextLayoutRef.current = true;
      controller.applyConfirmed(result.event, entries);
      dismissLifecycle();
    } catch (error) {
      if (
        !isAbortError(error) &&
        generation === lifecycleGenerationRef.current
      ) {
        setLifecycleError(
          publicError(
            error,
            'The lifecycle action did not complete. It was not retried automatically.',
          ),
        );
      }
    } finally {
      if (generation === lifecycleGenerationRef.current) {
        setLifecycleBusy(false);
      }
      if (lifecycleAbortRef.current === abort) lifecycleAbortRef.current = null;
    }
  }, [
    api,
    assertMutationAllowed,
    controller,
    dismissLifecycle,
    eventId,
    lifecycleAction,
    lifecycleBusy,
    lifecyclePhrase,
    lifecyclePreview,
  ]);

  const onTimelineScroll = useCallback(
    (eventValue: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        eventValue.nativeEvent;
      const near = isNearLiveEdge(
        contentSize.height,
        layoutMeasurement.height,
        Math.max(0, contentOffset.y),
      );
      nearLiveEdgeRef.current = near;
      followOnNextLayoutRef.current = retainPendingTimelineFollow(
        followOnNextLayoutRef.current,
        near,
      );
      controller.setNearLiveEdge(near);
    },
    [controller],
  );

  const jumpToLatest = useCallback(() => {
    nearLiveEdgeRef.current = true;
    followOnNextLayoutRef.current = false;
    controller.setNearLiveEdge(true);
    controller.markSeen();
    listRef.current?.scrollToEnd({ animated: true });
  }, [controller]);

  const renderTimelineEntry = useCallback(
    ({ item }: ListRenderItemInfo<JournalEntryReadProjection>) => {
      const actionEligibility =
        journalActionsAuthorized && sync.model.historyComplete
          ? journalEntryActionEligibility(
              item,
              sync.model.entries,
              sync.model.historyComplete,
            )
          : undefined;
      return (
        <TimelineEntryCard
          {...(actionEligibility === undefined
            ? {}
            : {
                actionEligibility,
                onCorrect: () => openJournalAction('correction', item),
                onRedact: () => openJournalAction('redaction', item),
              })}
          api={api}
          projection={item}
        />
      );
    },
    [
      api,
      journalActionsAuthorized,
      openJournalAction,
      sync.model.entries,
      sync.model.historyComplete,
    ],
  );

  if (event === null || sync.model.header === null) {
    return (
      <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.page}>
        <View style={styles.centeredState}>
          {sync.phase === 'error' ? null : (
            <ActivityIndicator color="#17324D" />
          )}
          <Text accessibilityRole="header" style={styles.stateTitle}>
            {sync.phase === 'error'
              ? 'Event room unavailable'
              : online
                ? 'Loading event timeline'
                : 'Reconnect to load this event'}
          </Text>
          <Text
            accessibilityRole={sync.error === null ? undefined : 'alert'}
            style={styles.secondaryText}
          >
            {sync.error ??
              (online
                ? 'Reading append-only history…'
                : OFFLINE_ACTION_MESSAGE)}
          </Text>
          <ActionButton
            disabled={!online}
            label="Try again"
            onPress={() => {
              void controller.refresh();
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  const header = sync.model.header;
  const theme = getEventTheme(event.templateMode, event.kind);
  const postingDisabled = !online || !eventAcceptsPosts;
  const target: EventRoomTargetIdentity = {
    eventKind: event.kind,
    eventTypeName: header.eventType.name,
    facilityName: header.facility.name,
    facilityCode: header.facility.code,
  };

  return (
    <SafeAreaView
      edges={['left', 'right', 'bottom']}
      style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
    >
      <View style={styles.roomHeader}>
        <View
          accessibilityLabel={`${header.eventType.name}. ${header.facility.name}, ${header.facility.code}.`}
          accessibilityRole="header"
          accessible
          style={styles.trustedHeader}
        >
          <Text
            style={[styles.eventTypeName, { color: theme.colors.textPrimary }]}
          >
            {header.eventType.name}
          </Text>
          <Text
            style={[styles.facilityName, { color: theme.colors.textMuted }]}
          >
            {header.facility.name} · {header.facility.code}
          </Text>
        </View>
        <ClassificationBanner
          compact
          kind={event.kind}
          mode={event.templateMode}
        />
        <View style={styles.statusRow}>
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.statusText, { color: theme.colors.textPrimary }]}
          >
            Status: {event.status.replaceAll('-', ' ')}
          </Text>
          {event.status === 'active' ? (
            <ActionButton
              disabled={!online}
              label="All-clear…"
              onPress={() => {
                void fetchAllClearPreview();
              }}
            />
          ) : event.status === 'all-clear' ? (
            <ActionButton
              disabled={!online}
              label="Close event…"
              onPress={openCloseConfirmation}
            />
          ) : null}
        </View>
      </View>

      {sync.error === null ? null : (
        <View accessibilityRole="alert" style={styles.syncErrorRow}>
          <Text style={styles.syncErrorText}>{sync.error}</Text>
          <ActionButton
            disabled={!online}
            label="Refresh now"
            onPress={() => {
              void controller.refresh();
            }}
          />
        </View>
      )}

      {journalActionsAuthorized && !sync.model.historyComplete ? (
        <Text accessibilityRole="summary" style={styles.actionUnavailableText}>
          Corrections and redactions become available after the complete
          timeline loads.
        </Text>
      ) : null}

      <View style={styles.timelineRegion}>
        <FlatList
          contentContainerStyle={
            sync.model.entries.length === 0
              ? styles.emptyTimelineContent
              : styles.timelineContent
          }
          data={sync.model.entries}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(projection) => projection.entry.id}
          ListEmptyComponent={
            <View accessible style={styles.emptyTimeline}>
              <Text style={styles.stateTitle}>No timeline updates yet</Text>
              <Text style={styles.secondaryText}>
                Pull to refresh. New updates will appear in server order.
              </Text>
            </View>
          }
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={() => {
            if (followOnNextLayoutRef.current) {
              followOnNextLayoutRef.current = false;
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onScroll={onTimelineScroll}
          ref={listRef}
          refreshControl={
            <RefreshControl
              accessibilityLabel="Refresh event timeline"
              onRefresh={() => {
                void controller.refresh();
              }}
              refreshing={sync.refreshing}
            />
          }
          renderItem={renderTimelineEntry}
          scrollEventThrottle={100}
        />
        {sync.model.unseenUpdateCount === 0 ? null : (
          <Pressable
            accessibilityHint="Moves to the newest timeline entry"
            accessibilityLabel={`${sync.model.unseenUpdateCount} unseen timeline updates. Jump to latest.`}
            accessibilityRole="button"
            onPress={jumpToLatest}
            style={({ pressed }) => [
              styles.unseenButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.unseenButtonText}>
              {sync.model.unseenUpdateCount} new{' '}
              {sync.model.unseenUpdateCount === 1 ? 'update' : 'updates'} · Jump
              to latest
            </Text>
          </Pressable>
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
      >
        <View style={styles.composerBar}>
          {!eventAcceptsPosts ? (
            <>
              <Text accessibilityRole="summary" style={styles.closedNotice}>
                {eventClosed
                  ? 'This event is closed. Its append-only timeline remains readable.'
                  : 'This event no longer accepts timeline posts. Its append-only timeline remains readable.'}
              </Text>
              {photo.draft?.stage === 'describe' ? null : (
                <ActionButton
                  label="Recover retained photo draft…"
                  onPress={() => setComposer('photo')}
                />
              )}
            </>
          ) : (
            <>
              <View style={styles.textComposerRow}>
                <TextInput
                  accessibilityLabel="Timeline text update"
                  editable={!postingDisabled && !textBusy}
                  maxLength={TEXT_LIMIT}
                  multiline
                  onChangeText={(value) => {
                    setTextDraft(value);
                    setTextError(null);
                  }}
                  placeholder={
                    postingDisabled ? 'Reconnect to post' : 'Post an update'
                  }
                  style={styles.textComposerInput}
                  value={textDraft}
                />
                <ActionButton
                  disabled={
                    postingDisabled || textBusy || textDraft.trim().length === 0
                  }
                  label={textBusy ? 'Posting…' : 'Post'}
                  onPress={() => {
                    void submitText();
                  }}
                />
              </View>
              <Text accessibilityRole="summary" style={styles.safetyHelp}>
                Do not include student data. A submitted update is append-only;
                corrections create a new entry.
              </Text>
              {textError === null ? null : (
                <Text accessibilityRole="alert" style={styles.errorText}>
                  {textError}
                </Text>
              )}
              <View style={styles.attachmentRow}>
                <ActionButton
                  disabled={postingDisabled}
                  label="Location…"
                  onPress={() => setComposer('location')}
                />
                <ActionButton
                  disabled={postingDisabled}
                  label={
                    photo.draft?.stage === 'describe'
                      ? 'Photo…'
                      : 'Photo draft…'
                  }
                  onPress={() => setComposer('photo')}
                />
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>

      <LocationComposerDialog
        ambiguousLabel={ambiguousLabel}
        ambiguousReason={ambiguousReason}
        busy={locationCaptureBusy || locationSubmitBusy}
        captureBusy={locationCaptureBusy}
        error={locationError}
        known={knownLocation}
        knownLabel={knownLabel}
        mode={locationMode}
        onAdjust={adjustLocation}
        onAmbiguousLabelChange={(value) => {
          setAmbiguousLabel(value);
          resetLocationFailure();
        }}
        onAmbiguousReasonChange={(value) => {
          setAmbiguousReason(value);
          resetLocationFailure();
        }}
        onCapture={() => {
          void captureLocation();
        }}
        onDismiss={dismissLocationComposer}
        onKnownLabelChange={(value) => {
          setKnownLabel(value);
          setKnownLocation((current) =>
            current === null
              ? null
              : { ...current, label: value.trim() || null },
          );
          resetLocationFailure();
        }}
        onModeChange={(value) => {
          setLocationMode(value);
          resetLocationFailure();
        }}
        onSubmit={() => {
          void submitLocation();
        }}
        onUnknownReasonChange={(value) => {
          setUnknownReason(value);
          resetLocationFailure();
        }}
        online={online}
        target={target}
        templateMode={event.templateMode}
        submitBusy={locationSubmitBusy}
        unknownReason={unknownReason}
        visible={isEventComposerVisible(composer, 'location', event.status)}
      />
      <PhotoComposerDialog
        newPostsAllowed={eventAcceptsPosts}
        onDismiss={() => setComposer(null)}
        online={online}
        photo={photo}
        target={target}
        templateMode={event.templateMode}
        visible={
          isEventComposerVisible(composer, 'photo', event.status) ||
          (composer === 'photo' &&
            eventClosed &&
            photo.draft?.stage !== 'describe')
        }
      />
      {journalActionTarget === null ? null : (
        <JournalActionDialog
          action={journalActionTarget.action}
          busy={journalActionBusy}
          error={journalActionErrorText}
          onDismiss={dismissJournalAction}
          onSubmit={(submission) => {
            void submitJournalAction(submission);
          }}
          target={journalActionTarget.projection}
        />
      )}
      <LifecycleConfirmationDialog
        action={lifecycleAction ?? 'all-clear'}
        busy={lifecycleBusy}
        error={lifecycleError}
        loadingPreview={lifecycleLoadingPreview}
        mode={event.templateMode}
        onConfirm={() => {
          void submitLifecycle();
        }}
        onDismiss={dismissLifecycle}
        onPhraseChange={(value) => {
          setLifecyclePhrase(value);
          setLifecycleError(null);
        }}
        onRefreshPreview={() => {
          void fetchAllClearPreview();
        }}
        phrase={lifecyclePhrase}
        preview={lifecyclePreview}
        target={target}
        visible={lifecycleAction !== null}
      />
    </SafeAreaView>
  );
}

export interface EventRoomScreenProps {
  readonly eventId: string;
}

export function EventRoomScreen({ eventId }: EventRoomScreenProps) {
  const auth = useMobileAuth();
  const sessionId = auth.state.session?.session.id ?? null;
  if (sessionId === null) {
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.centeredState}>
          <Text accessibilityRole="alert" style={styles.stateTitle}>
            Unlock PSD EOC to open this event.
          </Text>
        </View>
      </SafeAreaView>
    );
  }
  return (
    <AuthenticatedEventRoomScreen
      auth={auth}
      eventId={eventId}
      key={`${sessionId}:${eventId}`}
      sessionId={sessionId}
    />
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F4F7FA' },
  centeredState: {
    alignItems: 'center',
    flex: 1,
    gap: 14,
    justifyContent: 'center',
    padding: 24,
  },
  stateTitle: {
    color: '#102A43',
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 27,
    textAlign: 'center',
  },
  secondaryText: {
    color: '#486581',
    fontSize: 15,
    lineHeight: 22,
  },
  roomHeader: { gap: 10, paddingHorizontal: 16, paddingTop: 10 },
  trustedHeader: { gap: 2 },
  eventTypeName: { fontSize: 24, fontWeight: '900', lineHeight: 30 },
  facilityName: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  statusText: { flex: 1, fontSize: 15, fontWeight: '800', lineHeight: 21 },
  actionButton: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  primaryButton: { backgroundColor: '#17324D' },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 20,
  },
  destructiveButton: { backgroundColor: '#8B1526' },
  destructiveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 20,
  },
  disabledButton: { opacity: 0.42 },
  pressed: { opacity: 0.7 },
  syncErrorRow: {
    alignItems: 'center',
    backgroundColor: '#FFF4D6',
    borderColor: '#9B6A00',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 10,
  },
  syncErrorText: { color: '#5D3D00', flex: 1, fontSize: 14, lineHeight: 20 },
  timelineRegion: { flex: 1, position: 'relative' },
  timelineContent: { gap: 10, padding: 16, paddingBottom: 24 },
  emptyTimelineContent: { flexGrow: 1, padding: 16 },
  emptyTimeline: {
    alignItems: 'center',
    flex: 1,
    gap: 8,
    justifyContent: 'center',
  },
  timelineCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  entryActionArea: { gap: 8 },
  entryActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  entryActionHelp: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    fontSize: 13,
    lineHeight: 18,
  },
  actionUnavailableText: {
    backgroundColor: '#FFF4D6',
    color: '#5D3D00',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  timelineMetaRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  timelineActor: { color: '#17324D', fontSize: 14, fontWeight: '900' },
  timelineTime: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    flexShrink: 1,
    fontSize: 12,
    textAlign: 'right',
  },
  timelineBody: { color: '#102A43', fontSize: 16, lineHeight: 23 },
  timelineSequence: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    fontSize: 12,
    lineHeight: 16,
  },
  timelinePhoto: { borderRadius: 10, height: 200, width: '100%' },
  photoPlaceholder: {
    alignItems: 'center',
    backgroundColor: '#E8F1F8',
    borderRadius: 10,
    gap: 8,
    height: 120,
    justifyContent: 'center',
    padding: 12,
  },
  photoPlaceholderText: { color: '#334E68', fontSize: 14, lineHeight: 20 },
  unseenButton: {
    alignSelf: 'center',
    backgroundColor: '#17324D',
    borderRadius: 22,
    bottom: 10,
    minHeight: 44,
    paddingHorizontal: 18,
    position: 'absolute',
    justifyContent: 'center',
  },
  unseenButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  composerBar: {
    backgroundColor: '#FFFFFF',
    borderTopColor: '#BCCCDC',
    borderTopWidth: 1,
    gap: 8,
    padding: 10,
  },
  textComposerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 8 },
  textComposerInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#829AB1',
    borderRadius: 12,
    borderWidth: 1,
    color: '#102A43',
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  attachmentRow: { flexDirection: 'row', gap: 10 },
  closedNotice: {
    color: '#334E68',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
    minHeight: 44,
    padding: 10,
  },
  modalPage: { backgroundColor: '#F4F7FA', flex: 1 },
  modalContent: { gap: 16, padding: 20, paddingBottom: 40 },
  modalTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  modalTitle: {
    color: '#102A43',
    flex: 1,
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 32,
  },
  closeButton: {
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 10,
  },
  closeButtonText: { color: '#17324D', fontSize: 15, fontWeight: '800' },
  eventTargetContext: { gap: 8 },
  eventTargetCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#9FB3C8',
    borderRadius: 12,
    borderWidth: 1,
    gap: 3,
    padding: 12,
  },
  eventTargetType: {
    color: '#102A43',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  eventTargetFacility: {
    color: '#334E68',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  immutableNotice: { color: '#334E68', fontSize: 14, lineHeight: 20 },
  loadingBox: { alignItems: 'center', gap: 10, padding: 20 },
  warningBox: {
    backgroundColor: '#FFF4D6',
    borderColor: '#9B6A00',
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  warningTitle: { color: '#5D3D00', fontSize: 17, fontWeight: '900' },
  warningText: { color: '#5D3D00', fontSize: 14, lineHeight: 20 },
  previewCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#9FB3C8',
    borderRadius: 14,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  sectionTitle: {
    color: '#102A43',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  previewFact: { color: '#243B53', fontSize: 15, lineHeight: 22 },
  channelList: { gap: 8 },
  channelRow: {
    backgroundColor: '#E8F1F8',
    borderRadius: 10,
    gap: 2,
    padding: 10,
  },
  channelName: {
    color: '#102A43',
    fontSize: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  channelDetail: { color: '#334E68', fontSize: 13, lineHeight: 18 },
  channelMessage: { color: '#102A43', fontSize: 13, lineHeight: 19 },
  digestText: {
    color: '#486581',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
  },
  expiryText: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    fontSize: 13,
    lineHeight: 18,
  },
  phraseGroup: { gap: 6 },
  inputLabel: {
    color: '#102A43',
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 21,
  },
  phraseInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#8B1526',
    borderRadius: 12,
    borderWidth: 2,
    color: '#2B0B0E',
    fontSize: 18,
    fontWeight: '900',
    minHeight: 48,
    paddingHorizontal: 12,
  },
  noRetryText: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  errorText: {
    color: '#8B1526',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  offlineText: {
    color: '#5D3D00',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  segmentedRow: { flexDirection: 'row', gap: 6 },
  segmentButton: {
    alignItems: 'center',
    backgroundColor: '#E8F1F8',
    borderColor: '#9FB3C8',
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  segmentButtonSelected: { backgroundColor: '#17324D', borderColor: '#17324D' },
  segmentText: { color: '#17324D', fontSize: 13, fontWeight: '800' },
  segmentTextSelected: { color: '#FFFFFF' },
  editorSection: { gap: 10 },
  locationTruthCard: {
    backgroundColor: '#E8F1F8',
    borderRadius: 12,
    gap: 4,
    padding: 14,
  },
  locationCoordinate: { color: '#102A43', fontSize: 15, fontWeight: '800' },
  locationAccuracy: { color: '#102A43', fontSize: 15, lineHeight: 21 },
  roomDisclaimer: { color: '#486581', fontSize: 14, lineHeight: 20 },
  safetyHelp: {
    color: EVENT_ROOM_MUTED_TEXT_COLOR,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  textField: {
    backgroundColor: '#FFFFFF',
    borderColor: '#829AB1',
    borderRadius: 12,
    borderWidth: 1,
    color: '#102A43',
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multilineField: { minHeight: 88, textAlignVertical: 'top' },
  adjustGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  adjustButton: {
    alignItems: 'center',
    backgroundColor: '#E8F1F8',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: '47%',
    paddingHorizontal: 10,
  },
  adjustText: { color: '#17324D', fontSize: 14, fontWeight: '800' },
  retainedNotice: {
    backgroundColor: '#E8F1F8',
    borderRadius: 12,
    gap: 4,
    padding: 14,
  },
  retainedTitle: { color: '#102A43', fontSize: 16, fontWeight: '900' },
  retainedText: { color: '#334E68', fontSize: 14, lineHeight: 20 },
  actionGroup: { gap: 10 },
  progressCard: { gap: 6 },
  progressTitle: {
    color: '#102A43',
    fontSize: 14,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  progressTrack: {
    backgroundColor: '#D9E2EC',
    borderRadius: 6,
    height: 12,
    overflow: 'hidden',
  },
  progressFill: { backgroundColor: '#176B4D', height: '100%' },
  progressText: { color: EVENT_ROOM_MUTED_TEXT_COLOR, fontSize: 13 },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#8B1526',
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
  },
  secondaryButtonText: { color: '#8B1526', fontSize: 15, fontWeight: '800' },
});
