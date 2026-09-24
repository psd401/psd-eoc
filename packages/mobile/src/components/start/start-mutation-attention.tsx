import type { EventKind, TemplateMode } from '@psd-eoc/contracts';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getEventTheme } from '../../theme/event-theme';
import { ClassificationBanner } from '../classification-banner';
import { Call911Affordance } from './call-911-affordance';

export interface StartMutationActiveEventSummary {
  readonly eventId: string;
  readonly eventKind: EventKind;
  readonly eventTypeName: string;
  readonly facilityName: string;
  readonly mode: TemplateMode;
  readonly startedLabel: string;
}

export type StartMutationOperation = 'activate' | 'join';
export type StartMutationAttentionStatus = 'failed' | 'pending' | 'unresolved';

interface StartMutationAttentionIdentity {
  readonly eventKind: EventKind;
  readonly eventTypeName: string;
  readonly mode: TemplateMode;
  readonly operation: StartMutationOperation;
  readonly testID?: string;
}

export interface PendingStartMutationAttentionProps extends StartMutationAttentionIdentity {
  readonly status: 'pending';
  readonly checking?: never;
  readonly checkError?: never;
  readonly onCheckActiveEvents?: never;
  readonly onAcknowledgeUnresolved?: never;
}

export interface FailedStartMutationAttentionProps extends StartMutationAttentionIdentity {
  readonly status: 'failed';
  readonly failureMessage: string;
  readonly checking?: boolean;
  readonly online?: boolean;
  readonly checkError?: string | null;
  readonly onRefreshActiveEvents: () => void;
  readonly onCheckActiveEvents?: never;
  readonly onAcknowledgeUnresolved?: never;
}

export interface UnresolvedStartMutationAttentionProps extends StartMutationAttentionIdentity {
  readonly status: 'unresolved';
  readonly activeEvents?: readonly StartMutationActiveEventSummary[];
  readonly outcomeMessage: string;
  readonly checking?: boolean;
  readonly online?: boolean;
  readonly checkError?: string | null;
  readonly onCheckActiveEvents: () => void;
  readonly onAcknowledgeUnresolved: () => void;
}

export type StartMutationAttentionProps =
  | FailedStartMutationAttentionProps
  | PendingStartMutationAttentionProps
  | UnresolvedStartMutationAttentionProps;

export interface StartMutationAttentionCopy {
  readonly heading: string;
  readonly status: string;
  readonly guidance: string;
}

type CopyInput = Pick<
  StartMutationAttentionIdentity,
  'eventKind' | 'eventTypeName' | 'mode' | 'operation'
> & {
  readonly status: StartMutationAttentionStatus;
};

/** Truthful safety copy for a pending, definite-failure, or unknown outcome. */
export function startMutationAttentionCopy({
  eventTypeName,
  eventKind,
  mode,
  operation,
  status,
}: CopyInput): StartMutationAttentionCopy {
  const classification = getEventTheme(mode, eventKind).classificationWord;
  const operationName = operation === 'activate' ? 'start' : 'join';

  if (status === 'pending') {
    return Object.freeze({
      heading:
        operation === 'activate'
          ? 'Start request is still resolving'
          : 'Join request is still resolving',
      status: `Your ${operationName} request for ${classification}: ${eventTypeName} is waiting for the server outcome. Nothing will retry automatically.`,
      guidance:
        'Keep this screen open. Do not make another start or join decision while the request resolves.',
    });
  }

  if (status === 'failed') {
    return Object.freeze({
      heading:
        operation === 'activate'
          ? 'Start request was not completed'
          : 'Join request was not completed',
      status: `Your ${operationName} request for ${classification}: ${eventTypeName} failed without a completed action. Nothing was queued and nothing will retry automatically.`,
      guidance:
        operation === 'activate'
          ? 'Review the failure below, then return to active events before making a fresh start decision.'
          : 'Review the failure below, then return to active events before making a fresh join or start decision.',
    });
  }

  return Object.freeze({
    heading:
      operation === 'activate'
        ? 'Start outcome needs attention'
        : 'Join outcome needs attention',
    status: `PSD EOC could not determine the server outcome of your ${operationName} request for ${classification}: ${eventTypeName}. Nothing will retry automatically.`,
    guidance:
      operation === 'activate'
        ? 'Load fresh active events for situational awareness. The list cannot prove which request created an event or clear this outcome. Checking does not retry the start request.'
        : 'Load fresh active events for situational awareness. The list cannot prove join membership or clear this outcome. Checking does not retry the join request.',
  });
}

/** Stateful entry point used by the authenticated app-lifetime attention gate. */
export function StartMutationAttention(props: StartMutationAttentionProps) {
  return <StartMutationAttentionContent {...props} />;
}

/** Pure native tree kept separate for renderer-independent accessibility tests. */
export function StartMutationAttentionContent(
  props: StartMutationAttentionProps,
) {
  const { eventKind, eventTypeName, mode, operation, status, testID } = props;
  const theme = getEventTheme(mode, eventKind);
  const copy = startMutationAttentionCopy({
    eventTypeName,
    eventKind,
    mode,
    operation,
    status,
  });
  const unresolved = props.status === 'unresolved';
  const failed = props.status === 'failed';
  const checking = (unresolved || failed) && (props.checking ?? false);
  const online = (unresolved || failed) && (props.online ?? true);
  const actionDisabled = checking || !online;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
      testID={testID}
    >
      <ClassificationBanner kind={eventKind} mode={mode} />
      <Call911Affordance />

      <View
        accessibilityLabel={
          unresolved || failed
            ? undefined
            : `${copy.heading}. ${copy.status} ${copy.guidance}`
        }
        accessibilityLiveRegion={unresolved || failed ? 'assertive' : 'polite'}
        accessibilityRole={unresolved || failed ? 'alert' : 'progressbar'}
        style={[
          styles.statusCard,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
        ]}
      >
        {unresolved || failed ? null : (
          <ActivityIndicator
            accessibilityElementsHidden
            color={theme.colors.bannerBackground}
            importantForAccessibility="no-hide-descendants"
            size="large"
          />
        )}
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: theme.colors.textPrimary }]}
        >
          {copy.heading}
        </Text>
        <Text style={[styles.eventType, { color: theme.colors.textPrimary }]}>
          {eventTypeName}
        </Text>
        <Text style={[styles.status, { color: theme.colors.textMuted }]}>
          {copy.status}
        </Text>
        <Text style={[styles.guidance, { color: theme.colors.textPrimary }]}>
          {copy.guidance}
        </Text>
        {failed ? (
          <Text style={[styles.failure, { color: theme.colors.textPrimary }]}>
            {props.failureMessage}
          </Text>
        ) : null}
        {unresolved ? (
          <Text style={[styles.failure, { color: theme.colors.textPrimary }]}>
            {props.outcomeMessage}
          </Text>
        ) : null}
        <Text style={[styles.truth, { color: theme.colors.textMuted }]}>
          This status does not claim that an event was started or joined. It
          provides no evidence of provider acceptance or human receipt and does
          not claim either one.
        </Text>
      </View>

      {unresolved && props.activeEvents !== undefined ? (
        <View style={styles.activeEventSummarySection}>
          <Text
            accessibilityRole="header"
            style={[styles.summaryHeading, { color: theme.colors.textPrimary }]}
          >
            Fresh active events
          </Text>
          {props.activeEvents.length === 0 ? (
            <Text
              style={[styles.summaryText, { color: theme.colors.textMuted }]}
            >
              No active events appeared in the refreshed authorized list.
              Absence is not proof that the earlier request failed.
            </Text>
          ) : (
            props.activeEvents.map((event) => {
              const eventTheme = getEventTheme(event.mode, event.eventKind);
              return (
                <View
                  accessible
                  accessibilityLabel={`${eventTheme.classificationWord}. ${event.eventTypeName} at ${event.facilityName}. Started ${event.startedLabel}. Event ID ${event.eventId}. Read only; this does not resolve the earlier request.`}
                  accessibilityRole="summary"
                  key={event.eventId}
                  style={[
                    styles.activeEventSummary,
                    {
                      backgroundColor: eventTheme.colors.surface,
                      borderColor: eventTheme.colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.summaryClassification,
                      { color: eventTheme.colors.textPrimary },
                    ]}
                  >
                    {eventTheme.classificationWord}
                  </Text>
                  <Text
                    style={[
                      styles.summaryHeading,
                      { color: eventTheme.colors.textPrimary },
                    ]}
                  >
                    {event.eventTypeName}
                  </Text>
                  <Text
                    style={[
                      styles.summaryText,
                      { color: eventTheme.colors.textMuted },
                    ]}
                  >
                    {event.facilityName} · Started {event.startedLabel} · Event
                    ID {event.eventId}
                  </Text>
                </View>
              );
            })
          )}
          <Text style={[styles.summaryText, { color: theme.colors.textMuted }]}>
            This read-only list cannot prove which request created an event and
            does not clear the unresolved outcome.
          </Text>
        </View>
      ) : null}

      {unresolved ? (
        <View style={styles.actions}>
          {props.checkError === undefined ||
          props.checkError === null ? null : (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              style={[styles.checkError, { borderColor: theme.colors.border }]}
            >
              <Text
                accessibilityRole="header"
                style={[
                  styles.checkErrorHeading,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {unresolved
                  ? 'Outcome remains unresolved'
                  : 'Active events could not be refreshed'}
              </Text>
              <Text
                style={[
                  styles.checkErrorText,
                  { color: theme.colors.textMuted },
                ]}
              >
                {props.checkError}
              </Text>
              <Text
                style={[
                  styles.checkErrorText,
                  { color: theme.colors.textMuted },
                ]}
              >
                This outcome remains unresolved. Nothing retried automatically.
              </Text>
            </View>
          )}

          {!online ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.offline, { color: theme.colors.textPrimary }]}
            >
              Reconnect before checking. No request was made and nothing will
              retry automatically.
            </Text>
          ) : null}
          <Pressable
            accessibilityHint={
              operation === 'activate'
                ? 'Loads fresh active events for situational awareness. The list cannot prove which request created an event or clear this outcome, and it never retries the start request.'
                : 'Loads fresh active events for situational awareness. The list cannot prove join membership or clear this outcome, and it never retries the join request.'
            }
            accessibilityLabel={
              checking ? 'Checking fresh active events' : 'Check active events'
            }
            accessibilityRole="button"
            accessibilityState={{ busy: checking, disabled: actionDisabled }}
            disabled={actionDisabled}
            onPress={props.onCheckActiveEvents}
            style={({ pressed }) => [
              styles.checkAction,
              { backgroundColor: theme.colors.bannerBackground },
              pressed && !actionDisabled && styles.pressed,
              actionDisabled && styles.disabled,
            ]}
          >
            <Text
              style={[styles.checkActionText, { color: theme.colors.onBanner }]}
            >
              {checking ? 'Checking active events…' : 'Check active events'}
            </Text>
          </Pressable>
          <Text
            style={[styles.acknowledgeNote, { color: theme.colors.textMuted }]}
          >
            Clearing this does not resolve the earlier request and makes no
            claim that it succeeded or failed. It restores start and join on
            this device so a new emergency can be raised.
          </Text>
          <Pressable
            accessibilityHint={
              operation === 'activate'
                ? 'Clears this unresolved start so start and join work again. It does not retry or resolve the earlier request.'
                : 'Clears this unresolved join so start and join work again. It does not retry or resolve the earlier request.'
            }
            accessibilityLabel="Clear and allow new decisions"
            accessibilityRole="button"
            accessibilityState={{ disabled: !online }}
            disabled={!online}
            onPress={props.onAcknowledgeUnresolved}
            style={({ pressed }) => [
              styles.acknowledgeAction,
              { borderColor: theme.colors.border },
              pressed && online && styles.pressed,
              !online && styles.disabled,
            ]}
          >
            <Text
              style={[
                styles.acknowledgeActionText,
                { color: theme.colors.textPrimary },
              ]}
            >
              Clear and allow new decisions
            </Text>
          </Pressable>
        </View>
      ) : failed ? (
        <View style={styles.actions}>
          {props.checkError === undefined ||
          props.checkError === null ? null : (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              style={[styles.checkError, { borderColor: theme.colors.border }]}
            >
              <Text
                accessibilityRole="header"
                style={[
                  styles.checkErrorHeading,
                  { color: theme.colors.textPrimary },
                ]}
              >
                Active events could not be refreshed
              </Text>
              <Text
                style={[
                  styles.checkErrorText,
                  { color: theme.colors.textMuted },
                ]}
              >
                {props.checkError}
              </Text>
              <Text
                style={[
                  styles.checkErrorText,
                  { color: theme.colors.textMuted },
                ]}
              >
                The failure remains visible. Nothing retried automatically.
              </Text>
            </View>
          )}
          {!online ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.offline, { color: theme.colors.textPrimary }]}
            >
              Reconnect before refreshing. No request was made and nothing will
              retry automatically.
            </Text>
          ) : null}
          <Pressable
            accessibilityHint="Loads fresh active events before this failure can clear. It does not retry the failed start or join request."
            accessibilityLabel={
              checking ? 'Refreshing active events' : 'Refresh active events'
            }
            accessibilityRole="button"
            accessibilityState={{ busy: checking, disabled: actionDisabled }}
            disabled={actionDisabled}
            onPress={props.onRefreshActiveEvents}
            style={({ pressed }) => [
              styles.checkAction,
              { backgroundColor: theme.colors.bannerBackground },
              pressed && !actionDisabled && styles.pressed,
              actionDisabled && styles.disabled,
            ]}
          >
            <Text
              style={[styles.checkActionText, { color: theme.colors.onBanner }]}
            >
              {checking ? 'Refreshing active events…' : 'Refresh active events'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

export interface UnresolvedOutcomeNoticeProps {
  readonly online?: boolean;
  readonly onDismiss: () => void;
  readonly testID?: string;
}

/**
 * Discloses an unknown outcome without taking the screen or blocking anything.
 * The operator keeps every action; what they gain is the knowledge that an
 * earlier request was never confirmed, so they can read the active-event list
 * on the confirmation screen with that in mind.
 */
export function UnresolvedOutcomeNotice({
  online = true,
  onDismiss,
  testID,
}: UnresolvedOutcomeNoticeProps) {
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={styles.notice}
      testID={testID}
    >
      <Text accessibilityRole="header" style={styles.noticeHeading}>
        A previous request outcome is unknown
      </Text>
      <Text style={styles.noticeText}>
        PSD EOC could not confirm what the server did with an earlier start or
        join request. It makes no claim that an event was or was not created.
        Starting and joining are not blocked; the confirmation screen lists the
        events already active at the site.
      </Text>
      <Pressable
        accessibilityHint="Dismisses this notice. It does not retry or resolve the earlier request."
        accessibilityLabel="Dismiss"
        accessibilityRole="button"
        accessibilityState={{ disabled: !online }}
        disabled={!online}
        onPress={onDismiss}
        style={({ pressed }) => [
          styles.noticeAction,
          pressed && online && styles.pressed,
          !online && styles.disabled,
        ]}
      >
        <Text style={styles.noticeActionText}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

export interface OtherSessionStartMutationAttentionProps {
  readonly status?: 'pending' | 'unresolved';
  readonly online?: boolean;
  readonly onAcknowledgeUnresolved?: () => void;
  readonly testID?: string;
}

export interface StartMutationRecoveryBlockedAttentionProps {
  readonly message: string;
  readonly online?: boolean;
  readonly onContinueWithoutRecovery?: () => void;
  readonly testID?: string;
}

export interface StartMutationRecoveryCheckingAttentionProps {
  readonly testID?: string;
}

/** Neutral first-paint gate while encrypted retained truth is reconciled. */
export function StartMutationRecoveryCheckingAttention({
  testID,
}: StartMutationRecoveryCheckingAttentionProps) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.page, styles.neutralPage]}
      testID={testID}
    >
      <Call911Affordance />
      <View
        accessibilityLabel="Checking prior start and join request recovery. New actions remain blocked and nothing will be sent or queued."
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        style={[styles.statusCard, styles.neutralCard]}
      >
        <ActivityIndicator
          accessibilityElementsHidden
          color="#6B3A05"
          importantForAccessibility="no-hide-descendants"
          size="large"
        />
        <Text
          accessibilityRole="header"
          style={[styles.heading, styles.neutralHeading]}
        >
          Checking prior requests
        </Text>
        <Text style={[styles.status, styles.neutralText]}>
          PSD EOC is checking encrypted recovery information from this device
          before enabling start or join actions.
        </Text>
        <Text style={[styles.guidance, styles.neutralHeading]}>
          Nothing will be sent or queued while this check completes.
        </Text>
      </View>
    </ScrollView>
  );
}

/** Identity-free hard stop when durable recovery storage cannot be trusted. */
export function StartMutationRecoveryBlockedAttention({
  message,
  online = true,
  onContinueWithoutRecovery,
  testID,
}: StartMutationRecoveryBlockedAttentionProps) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.page, styles.neutralPage]}
      testID={testID}
    >
      <Call911Affordance />
      <View
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        style={[styles.statusCard, styles.neutralCard]}
      >
        <Text
          accessibilityRole="header"
          style={[styles.heading, styles.neutralHeading]}
        >
          Start and join actions are blocked
        </Text>
        <Text style={[styles.status, styles.neutralText]}>{message}</Text>
        <Text style={[styles.guidance, styles.neutralHeading]}>
          No request will be sent or queued while recovery is unavailable.
        </Text>
      </View>

      {onContinueWithoutRecovery === undefined ? null : (
        <View style={styles.actions}>
          <Text style={[styles.acknowledgeNote, styles.neutralText]}>
            You can carry on without recovery on this device. Start and join
            work again, and nothing already stored is deleted. If the app closes
            while a request is in flight, its outcome will not be recoverable
            here.
          </Text>
          <Pressable
            accessibilityHint="Restores start and join on this device without durable recovery. Nothing already stored is deleted."
            accessibilityLabel="Continue without recovery"
            accessibilityRole="button"
            accessibilityState={{ disabled: !online }}
            disabled={!online}
            onPress={onContinueWithoutRecovery}
            style={({ pressed }) => [
              styles.acknowledgeAction,
              styles.neutralAcknowledgeAction,
              pressed && online && styles.pressed,
              !online && styles.disabled,
            ]}
          >
            <Text style={[styles.acknowledgeActionText, styles.neutralHeading]}>
              Continue without recovery
            </Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Neutral attention state when the preceding authenticated session owns the
 * still-resolving request. No event identity is exposed across the session.
 */
export function OtherSessionStartMutationAttention({
  status = 'pending',
  online = true,
  onAcknowledgeUnresolved,
  testID,
}: OtherSessionStartMutationAttentionProps) {
  const unresolved = status === 'unresolved';
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.page, styles.neutralPage]}
      testID={testID}
    >
      <Call911Affordance />
      <View
        accessibilityLabel={
          unresolved
            ? 'Previous signed-in session request has an unresolved outcome. New start and join actions are blocked. Nothing will retry automatically.'
            : 'Previous signed-in session request is still resolving. Nothing will retry automatically.'
        }
        accessibilityLiveRegion={unresolved ? 'assertive' : 'polite'}
        accessibilityRole={unresolved ? 'alert' : 'progressbar'}
        style={[styles.statusCard, styles.neutralCard]}
      >
        {unresolved ? null : (
          <ActivityIndicator
            accessibilityElementsHidden
            color="#6B3A05"
            importantForAccessibility="no-hide-descendants"
            size="large"
          />
        )}
        <Text
          accessibilityRole="header"
          style={[styles.heading, styles.neutralHeading]}
        >
          {unresolved
            ? 'Previous request outcome is unresolved'
            : 'Previous request is still resolving'}
        </Text>
        <Text style={[styles.status, styles.neutralText]}>
          {unresolved
            ? 'PSD EOC could not verify the server outcome of a request from the previous signed-in session. Nothing will retry automatically.'
            : 'A request from the previous signed-in session is still waiting for its server outcome. Nothing will retry automatically.'}
        </Text>
        <Text style={[styles.guidance, styles.neutralHeading]}>
          {unresolved
            ? 'New start and join actions are blocked until this is cleared. The session that made the request has ended and cannot be signed back into, so its outcome cannot be checked from here.'
            : 'Do not make a new start or join decision while it resolves. Sign back into the session that made the request to see its classified event details.'}
        </Text>
        <Text style={[styles.truth, styles.neutralText]}>
          This status does not claim that an event was started or joined. It
          provides no evidence of provider acceptance or human receipt and does
          not claim either one.
        </Text>
      </View>

      {unresolved && onAcknowledgeUnresolved !== undefined ? (
        <View style={styles.actions}>
          <Text style={[styles.acknowledgeNote, styles.neutralText]}>
            Clearing this does not resolve the earlier request and makes no
            claim that it succeeded or failed. It restores start and join on
            this device so a new emergency can be raised.
          </Text>
          <Pressable
            accessibilityHint="Clears the unresolved request left by a previous sign-in so start and join work again. It does not retry or resolve that request."
            accessibilityLabel="Clear and allow new decisions"
            accessibilityRole="button"
            accessibilityState={{ disabled: !online }}
            disabled={!online}
            onPress={onAcknowledgeUnresolved}
            style={({ pressed }) => [
              styles.acknowledgeAction,
              styles.neutralAcknowledgeAction,
              pressed && online && styles.pressed,
              !online && styles.disabled,
            ]}
          >
            <Text style={[styles.acknowledgeActionText, styles.neutralHeading]}>
              Clear and allow new decisions
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  acknowledgeAction: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  notice: {
    backgroundColor: '#FFF8E7',
    borderColor: '#6B3A05',
    borderRadius: 14,
    borderWidth: 2,
    gap: 8,
    padding: 14,
  },
  noticeAction: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#6B3A05',
    borderRadius: 10,
    borderWidth: 2,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  noticeActionText: {
    color: '#6B3A05',
    fontSize: 16,
    fontWeight: '800',
  },
  noticeHeading: {
    color: '#3B2005',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  noticeText: {
    color: '#3B2005',
    fontSize: 15,
    lineHeight: 21,
  },
  neutralAcknowledgeAction: {
    borderColor: '#6B3A05',
  },
  acknowledgeActionText: {
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 24,
    textAlign: 'center',
  },
  acknowledgeNote: {
    fontSize: 15,
    lineHeight: 21,
  },
  activeEventSummary: {
    borderRadius: 16,
    borderWidth: 2,
    gap: 4,
    padding: 14,
  },
  activeEventSummarySection: {
    gap: 10,
  },
  actions: {
    gap: 14,
    marginTop: 'auto',
    width: '100%',
  },
  checkAction: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  checkActionText: {
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 24,
    textAlign: 'center',
  },
  checkError: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 2,
    gap: 8,
    padding: 16,
    width: '100%',
  },
  checkErrorHeading: {
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 25,
  },
  checkErrorText: {
    fontSize: 16,
    lineHeight: 23,
  },
  guidance: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 26,
  },
  content: {
    flexGrow: 1,
    gap: 20,
    padding: 20,
    width: '100%',
  },
  disabled: {
    opacity: 0.62,
  },
  eventType: {
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 30,
  },
  failure: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 25,
  },
  heading: {
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 39,
  },
  neutralCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#9A5A12',
  },
  neutralHeading: {
    color: '#422006',
  },
  neutralPage: {
    backgroundColor: '#FFF8E7',
  },
  offline: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 23,
  },
  neutralText: {
    color: '#6B3A05',
  },
  page: {
    flex: 1,
    width: '100%',
  },
  pressed: {
    opacity: 0.72,
  },
  status: {
    fontSize: 18,
    lineHeight: 26,
  },
  summaryClassification: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.7,
    lineHeight: 18,
  },
  summaryHeading: {
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  summaryText: {
    fontSize: 15,
    lineHeight: 22,
  },
  statusCard: {
    borderRadius: 18,
    borderWidth: 2,
    gap: 14,
    padding: 20,
    width: '100%',
  },
  truth: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 23,
  },
});
