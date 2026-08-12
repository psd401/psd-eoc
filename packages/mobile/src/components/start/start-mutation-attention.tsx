import type { TemplateMode } from '@psd-eoc/contracts';
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

export type StartMutationOperation = 'activate' | 'join';
export type StartMutationAttentionStatus = 'failed' | 'pending' | 'unresolved';

interface StartMutationAttentionIdentity {
  readonly eventTypeName: string;
  readonly mode: TemplateMode;
  readonly operation: StartMutationOperation;
  readonly testID?: string;
}

export interface PendingStartMutationAttentionProps
  extends StartMutationAttentionIdentity {
  readonly status: 'pending';
  readonly checking?: never;
  readonly checkError?: never;
  readonly onCheckActiveEvents?: never;
}

export interface FailedStartMutationAttentionProps
  extends StartMutationAttentionIdentity {
  readonly status: 'failed';
  readonly failureMessage: string;
  readonly checking?: boolean;
  readonly online?: boolean;
  readonly checkError?: string | null;
  readonly onRefreshActiveEvents: () => void;
  readonly onCheckActiveEvents?: never;
}

export interface UnresolvedStartMutationAttentionProps
  extends StartMutationAttentionIdentity {
  readonly status: 'unresolved';
  readonly outcomeMessage: string;
  readonly checking?: boolean;
  readonly online?: boolean;
  readonly checkError?: string | null;
  readonly onCheckActiveEvents: () => void;
}

export type StartMutationAttentionProps =
  | FailedStartMutationAttentionProps
  | PendingStartMutationAttentionProps
  | UnresolvedStartMutationAttentionProps;

export interface StartMutationAttentionCopy {
  readonly heading: string;
  readonly status: string;
  readonly consequence: string;
}

type CopyInput = Pick<
  StartMutationAttentionIdentity,
  'eventTypeName' | 'mode' | 'operation'
> & {
  readonly status: StartMutationAttentionStatus;
};

/** Truthful safety copy for a pending, definite-failure, or unknown outcome. */
export function startMutationAttentionCopy({
  eventTypeName,
  mode,
  operation,
  status,
}: CopyInput): StartMutationAttentionCopy {
  const classification = mode === 'real' ? 'REAL INCIDENT' : 'DRILL — PRACTICE';
  const operationName = operation === 'activate' ? 'start' : 'join';

  if (status === 'pending') {
    return Object.freeze({
      heading:
        operation === 'activate'
          ? 'Start request is still resolving'
          : 'Join request is still resolving',
      status: `Your ${operationName} request for ${classification}: ${eventTypeName} is waiting for the server outcome. Nothing will retry automatically.`,
      consequence:
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
      consequence:
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
    consequence:
      operation === 'activate'
        ? 'Load fresh active events to check for exact activation evidence. Absence is not proof of failure and will not clear this outcome. Checking does not retry the start request.'
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
  const { eventTypeName, mode, operation, status, testID } = props;
  const theme = getEventTheme(mode);
  const copy = startMutationAttentionCopy({
    eventTypeName,
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
      <ClassificationBanner mode={mode} />
      <Call911Affordance />

      <View
        accessibilityLabel={
          unresolved || failed
            ? undefined
            : `${copy.heading}. ${copy.status} ${copy.consequence}`
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
        <Text style={[styles.consequence, { color: theme.colors.textPrimary }]}>
          {copy.consequence}
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
                ? 'Loads fresh active events and checks for exact activation evidence. Absence is not proof of failure and does not clear this outcome. It never retries the start request.'
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

export interface OtherSessionStartMutationAttentionProps {
  readonly status?: 'pending' | 'unresolved';
  readonly testID?: string;
}

export interface StartMutationRecoveryBlockedAttentionProps {
  readonly message: string;
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
        <Text style={[styles.consequence, styles.neutralHeading]}>
          Nothing will be sent or queued while this check completes.
        </Text>
      </View>
    </ScrollView>
  );
}

/** Identity-free hard stop when durable recovery storage cannot be trusted. */
export function StartMutationRecoveryBlockedAttention({
  message,
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
        <Text style={[styles.consequence, styles.neutralHeading]}>
          No request will be sent or queued while recovery is unavailable.
        </Text>
      </View>
    </ScrollView>
  );
}

/**
 * Neutral attention state when the preceding authenticated session owns the
 * still-resolving request. No event identity is exposed across the session.
 */
export function OtherSessionStartMutationAttention({
  status = 'pending',
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
        <Text style={[styles.consequence, styles.neutralHeading]}>
          {unresolved
            ? 'New start and join actions are blocked. Sign back into the session that made the request to check exact activation evidence or contact district technology support.'
            : 'Do not make a new start or join decision while it resolves. Sign back into the session that made the request to see its classified event details.'}
        </Text>
        <Text style={[styles.truth, styles.neutralText]}>
          This status does not claim that an event was started or joined. It
          provides no evidence of provider acceptance or human receipt and does
          not claim either one.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  consequence: {
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
