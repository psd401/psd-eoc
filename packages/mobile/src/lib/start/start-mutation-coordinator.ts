import {
  DeviceEnrollmentIdSchema,
  EventIdSchema,
  EventSchema,
  IdempotencyKeySchema,
  SessionIdSchema,
  TemplateModeSchema,
  UserIdSchema,
  type ActivationPreview,
  type DeviceEnrollmentId,
  type Event,
  type EventId,
  type EventKind,
  type EventTypeVersionRef,
  type IdempotencyKey,
  type JoinEventResult,
  type RosterPopulation,
  type SessionId,
  type StartEventResult,
  type TemplateMode,
  type UserId,
} from '@psd-eoc/contracts';

import type { AuthPhase } from '../auth/auth-controller';
import { OfflineMutationDeniedError } from '../auth/auth-errors';
import { StartClientError } from './start-api-client';

export interface StartMutationOwner {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly deviceEnrollmentId: DeviceEnrollmentId;
}

export type StartMutationOperation = 'activate' | 'join';

export interface StartMutationCompletion {
  readonly kind: 'activated' | 'joined';
  readonly eventId: EventId;
  readonly eventTypeName: string;
  readonly mode: TemplateMode;
}

export type StartMutationPublicError =
  | Readonly<{
      message: string;
      outcomeUnknown: false;
    }>
  | Readonly<{
      message: string;
      outcomeUnknown: true;
    }>;

export interface StartMutationDisplay {
  readonly operation: StartMutationOperation;
  readonly eventTypeName: string;
  readonly mode: TemplateMode;
}

interface StartMutationPresentation extends StartMutationDisplay {
  readonly idempotencyKey: IdempotencyKey;
}

/** Minimized activation facts sufficient to recognize exact durable success. */
export interface StartMutationActivationEvidence {
  readonly previewId: string;
  readonly facilityId: string;
  readonly kind: EventKind;
  readonly mode: TemplateMode;
  readonly eventTypeVersion: EventTypeVersionRef;
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: RosterPopulation;
  readonly consequenceDigest: string;
}

export type StartMutationRecoveryRecord =
  | Readonly<
      StartMutationPresentation & {
        phase: 'unresolved';
        owner: StartMutationOwner;
        activationEvidence: StartMutationActivationEvidence | null;
        error: Extract<StartMutationPublicError, { outcomeUnknown: true }>;
      }
    >
  | Readonly<
      StartMutationPresentation & {
        phase: 'failed';
        owner: StartMutationOwner;
        activationEvidence: StartMutationActivationEvidence | null;
        error: Extract<StartMutationPublicError, { outcomeUnknown: false }>;
      }
    >
  | Readonly<
      StartMutationPresentation & {
        phase: 'succeeded';
        owner: StartMutationOwner;
        activationEvidence: StartMutationActivationEvidence | null;
        completion: StartMutationCompletion;
        feedbackClaimed: boolean;
      }
    >;

export interface StartMutationPersistence {
  read(): StartMutationRecoveryRecord | null;
  write(record: StartMutationRecoveryRecord): void;
  clear(): void;
}

export type StartMutationSnapshot =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'checking-recovery' }>
  | Readonly<
      Omit<StartMutationDisplay, 'operation'> & {
        phase: 'pending';
        visibility: 'owner';
        operation: 'activate';
      }
    >
  | Readonly<
      Omit<StartMutationDisplay, 'operation'> & {
        phase: 'pending';
        visibility: 'owner';
        operation: 'join';
        eventId: EventId;
      }
    >
  | Readonly<{
      phase: 'pending';
      visibility: 'pending-other-session';
    }>
  | Readonly<{
      phase: 'unresolved-other-session';
    }>
  | Readonly<{
      phase: 'recovery-blocked';
      message: string;
    }>
  | Readonly<{
      phase: 'succeeded';
      completion: StartMutationCompletion;
    }>
  | Readonly<
      StartMutationDisplay & {
        phase: 'failed';
        error: Extract<StartMutationPublicError, { outcomeUnknown: false }>;
      }
    >
  | Readonly<
      StartMutationDisplay & {
        phase: 'unresolved';
        error: Extract<StartMutationPublicError, { outcomeUnknown: true }>;
      }
    >;

interface StartMutationSubmissionCommon extends StartMutationPresentation {
  readonly owner: StartMutationOwner;
}

export type StartMutationSubmission =
  | Readonly<
      StartMutationSubmissionCommon & {
        operation: 'activate';
        activationEvidence: StartMutationActivationEvidence;
        run: () => Promise<StartEventResult>;
      }
    >
  | Readonly<
      StartMutationSubmissionCommon & {
        operation: 'join';
        eventId: EventId;
        activationEvidence?: never;
        run: () => Promise<JoinEventResult>;
      }
    >;

export type StartMutationAdmission =
  | Readonly<{ accepted: false }>
  | Readonly<{ accepted: true; completion: Promise<void> }>;

export interface StartMutationAuthObservation {
  readonly phase: AuthPhase;
  readonly owner: StartMutationOwner | null;
}

type StartMutationListener = () => void;

interface IdleState {
  readonly phase: 'idle';
}

interface PendingState extends StartMutationPresentation {
  readonly phase: 'pending';
  readonly owner: StartMutationOwner;
  readonly token: number;
  readonly quarantined: boolean;
  readonly activationEvidence: StartMutationActivationEvidence | null;
  readonly ownerSnapshot: Extract<
    StartMutationSnapshot,
    { readonly phase: 'pending'; readonly visibility: 'owner' }
  >;
}

interface SucceededState {
  readonly phase: 'succeeded';
  readonly owner: StartMutationOwner;
  readonly feedbackClaimed: boolean;
  readonly presentation: StartMutationPresentation;
  readonly activationEvidence: StartMutationActivationEvidence | null;
  readonly ownerSnapshot: Extract<
    StartMutationSnapshot,
    { readonly phase: 'succeeded' }
  >;
}

interface FailedState extends StartMutationDisplay {
  readonly phase: 'failed';
  readonly owner: StartMutationOwner;
  readonly presentation: StartMutationPresentation | null;
  readonly activationEvidence: StartMutationActivationEvidence | null;
  readonly ownerSnapshot: Extract<
    StartMutationSnapshot,
    { readonly phase: 'failed' }
  >;
}

interface UnresolvedState extends StartMutationPresentation {
  readonly phase: 'unresolved';
  readonly owner: StartMutationOwner;
  readonly activationEvidence: StartMutationActivationEvidence | null;
  readonly ownerSnapshot: Extract<
    StartMutationSnapshot,
    { readonly phase: 'unresolved' }
  >;
}

interface RecoveryBlockedState {
  readonly phase: 'recovery-blocked';
}

type InternalState =
  | IdleState
  | PendingState
  | SucceededState
  | FailedState
  | UnresolvedState
  | RecoveryBlockedState;

const IDLE_INTERNAL_STATE: IdleState = Object.freeze({ phase: 'idle' });
const IDLE_SNAPSHOT: StartMutationSnapshot = Object.freeze({ phase: 'idle' });
const PENDING_OTHER_SESSION_SNAPSHOT: StartMutationSnapshot = Object.freeze({
  phase: 'pending',
  visibility: 'pending-other-session',
});
const UNRESOLVED_OTHER_SESSION_SNAPSHOT: StartMutationSnapshot = Object.freeze({
  phase: 'unresolved-other-session',
});
const RECOVERY_BLOCKED_INTERNAL_STATE: RecoveryBlockedState = Object.freeze({
  phase: 'recovery-blocked',
});
const RECOVERY_BLOCKED_SNAPSHOT: StartMutationSnapshot = Object.freeze({
  phase: 'recovery-blocked',
  message:
    'PSD EOC cannot safely read or retain the prior start request on this device. Start and join actions are blocked. Restart the app; if this remains, contact district technology support.',
});
const REJECTED_ADMISSION: StartMutationAdmission = Object.freeze({
  accepted: false,
});

const UNKNOWN_OUTCOME_MESSAGE =
  'The outcome is unknown. Check active events before making another decision. Nothing will retry automatically.';
const RESULT_MISMATCH_MESSAGE =
  'PSD EOC returned a completion that does not match the confirmed start action. Treat the outcome as unresolved; no automatic retry will occur.';
const RECOVERED_UNKNOWN_MESSAGE =
  'The prior request ended without a verified response. Its outcome remains unresolved and no start or join action will retry automatically.';

/** Maps any thrown value to bounded text and truth metadata safe for the UI. */
export function mapStartMutationError(
  error: unknown,
): StartMutationPublicError {
  if (error instanceof OfflineMutationDeniedError) {
    return Object.freeze({
      message: `${error.message} No event was started or joined, and nothing was queued.`,
      outcomeUnknown: false,
    });
  }
  if (error instanceof StartClientError) {
    return error.outcomeUnknown
      ? Object.freeze({
          message: error.message,
          outcomeUnknown: true as const,
        })
      : Object.freeze({
          message: error.message,
          outcomeUnknown: false as const,
        });
  }
  return Object.freeze({
    message: UNKNOWN_OUTCOME_MESSAGE,
    outcomeUnknown: true,
  });
}

function validatedOwner(owner: StartMutationOwner): StartMutationOwner {
  return Object.freeze({
    userId: UserIdSchema.parse(owner.userId),
    sessionId: SessionIdSchema.parse(owner.sessionId),
    deviceEnrollmentId: DeviceEnrollmentIdSchema.parse(
      owner.deviceEnrollmentId,
    ),
  });
}

function sameOwner(
  left: StartMutationOwner | null,
  right: StartMutationOwner | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.userId === right.userId &&
    left.sessionId === right.sessionId &&
    left.deviceEnrollmentId === right.deviceEnrollmentId
  );
}

function activationEvidenceFromPreview(
  preview: ActivationPreview,
): StartMutationActivationEvidence {
  return Object.freeze({
    previewId: preview.id,
    facilityId: preview.facilityId,
    kind: preview.kind,
    mode: preview.templateMode,
    eventTypeVersion: Object.freeze({ ...preview.eventTypeVersion }),
    rosterSnapshotId: preview.rosterSnapshotId,
    rosterPopulation: preview.rosterPopulation,
    consequenceDigest: preview.consequenceDigest,
  });
}

export function createStartMutationActivationEvidence(
  preview: ActivationPreview,
): StartMutationActivationEvidence {
  return activationEvidenceFromPreview(preview);
}

function eventMatchesActivationEvidence(
  eventInput: Event,
  evidence: StartMutationActivationEvidence,
): boolean {
  const parsed = EventSchema.safeParse(eventInput);
  if (!parsed.success) return false;
  const event = parsed.data;
  const authorization = event.activationAuthorization;
  return (
    event.id.length > 0 &&
    event.facilityId === evidence.facilityId &&
    event.kind === evidence.kind &&
    event.templateMode === evidence.mode &&
    event.eventTypeVersion.id === evidence.eventTypeVersion.id &&
    event.eventTypeVersion.templateMode ===
      evidence.eventTypeVersion.templateMode &&
    event.rosterSnapshotId === evidence.rosterSnapshotId &&
    event.rosterPopulation === evidence.rosterPopulation &&
    event.status === 'active' &&
    authorization !== null &&
    authorization.activationPreviewId === evidence.previewId &&
    authorization.consequenceDigest === evidence.consequenceDigest
  );
}

function pendingOwnerSnapshot(
  submission: StartMutationSubmission,
  presentation: StartMutationPresentation,
): PendingState['ownerSnapshot'] {
  return submission.operation === 'join'
    ? Object.freeze({
        phase: 'pending',
        visibility: 'owner',
        operation: 'join',
        eventId: EventIdSchema.parse(submission.eventId),
        eventTypeName: presentation.eventTypeName,
        mode: presentation.mode,
      })
    : Object.freeze({
        phase: 'pending',
        visibility: 'owner',
        operation: 'activate',
        eventTypeName: presentation.eventTypeName,
        mode: presentation.mode,
      });
}

function succeededOwnerSnapshot(
  completion: StartMutationCompletion,
): SucceededState['ownerSnapshot'] {
  return Object.freeze({
    phase: 'succeeded',
    completion,
  });
}

function unresolvedOwnerSnapshot(
  presentation: StartMutationPresentation,
  error: Extract<StartMutationPublicError, { outcomeUnknown: true }>,
): UnresolvedState['ownerSnapshot'] {
  return Object.freeze({
    phase: 'unresolved',
    operation: presentation.operation,
    eventTypeName: presentation.eventTypeName,
    mode: presentation.mode,
    error,
  });
}

function failedOwnerSnapshot(
  presentation: StartMutationDisplay,
  error: Extract<StartMutationPublicError, { outcomeUnknown: false }>,
): FailedState['ownerSnapshot'] {
  return Object.freeze({
    phase: 'failed',
    operation: presentation.operation,
    eventTypeName: presentation.eventTypeName,
    mode: presentation.mode,
    error,
  });
}

function resultCompletion(
  submission: StartMutationSubmission,
  result: StartEventResult | JoinEventResult,
): StartMutationCompletion {
  const hasActivationTransition =
    'transition' in result && result.transition.transition === 'activate';
  const hasJoinEvidence = 'joined' in result && result.joined === true;
  const matchesOperation =
    submission.operation === 'activate'
      ? hasActivationTransition && !hasJoinEvidence
      : hasJoinEvidence && !hasActivationTransition;
  const mode = TemplateModeSchema.parse(result.event.templateMode);

  if (
    !matchesOperation ||
    mode !== submission.mode ||
    result.event.eventTypeVersion.templateMode !== mode
  ) {
    throw new StartClientError(RESULT_MISMATCH_MESSAGE, false, true);
  }

  return Object.freeze({
    kind: submission.operation === 'activate' ? 'activated' : 'joined',
    eventId: EventIdSchema.parse(result.event.id),
    eventTypeName: submission.eventTypeName,
    mode,
  });
}

function presentationOf(
  submission: StartMutationSubmission,
): StartMutationPresentation {
  return Object.freeze({
    operation: submission.operation,
    eventTypeName: submission.eventTypeName,
    mode: TemplateModeSchema.parse(submission.mode),
    idempotencyKey: IdempotencyKeySchema.parse(submission.idempotencyKey),
  });
}

/**
 * App-lifetime owner for activation and join mutations. It invokes only an
 * explicitly supplied human operation, exactly once, and never queues,
 * retries, or schedules work.
 */
export class StartMutationCoordinator {
  private readonly listeners = new Set<StartMutationListener>();
  private state: InternalState = IDLE_INTERNAL_STATE;
  private snapshot: StartMutationSnapshot = IDLE_SNAPSHOT;
  private onlineOwner: StartMutationOwner | null = null;
  private nextToken = 1;

  public constructor(
    private readonly persistence: StartMutationPersistence | null = null,
  ) {}

  public getSnapshot = (): StartMutationSnapshot => this.snapshot;

  public subscribe = (listener: StartMutationListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private refreshSnapshot(notify: boolean): void {
    const nextSnapshot = this.visibleSnapshot();
    if (Object.is(nextSnapshot, this.snapshot)) return;
    this.snapshot = nextSnapshot;
    if (!notify) return;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private visibleSnapshot(): StartMutationSnapshot {
    if (this.state.phase === 'idle') return IDLE_SNAPSHOT;
    if (this.state.phase === 'recovery-blocked') {
      return RECOVERY_BLOCKED_SNAPSHOT;
    }
    if (this.state.phase === 'pending') {
      return !this.state.quarantined &&
        sameOwner(this.state.owner, this.onlineOwner)
        ? this.state.ownerSnapshot
        : PENDING_OTHER_SESSION_SNAPSHOT;
    }
    if (this.state.phase === 'unresolved') {
      return sameOwner(this.state.owner, this.onlineOwner)
        ? this.state.ownerSnapshot
        : UNRESOLVED_OTHER_SESSION_SNAPSHOT;
    }
    return sameOwner(this.state.owner, this.onlineOwner)
      ? this.state.ownerSnapshot
      : IDLE_SNAPSHOT;
  }

  private recoveryRecord(): StartMutationRecoveryRecord | null {
    if (this.state.phase === 'unresolved') {
      return Object.freeze({
        phase: 'unresolved',
        owner: this.state.owner,
        operation: this.state.operation,
        eventTypeName: this.state.eventTypeName,
        mode: this.state.mode,
        idempotencyKey: this.state.idempotencyKey,
        activationEvidence: this.state.activationEvidence,
        error: this.state.ownerSnapshot.error,
      });
    }
    if (this.state.phase === 'succeeded') {
      return Object.freeze({
        phase: 'succeeded',
        owner: this.state.owner,
        ...this.state.presentation,
        activationEvidence: this.state.activationEvidence,
        completion: this.state.ownerSnapshot.completion,
        feedbackClaimed: this.state.feedbackClaimed,
      });
    }
    if (this.state.phase === 'failed' && this.state.presentation !== null) {
      return Object.freeze({
        phase: 'failed',
        owner: this.state.owner,
        ...this.state.presentation,
        activationEvidence: this.state.activationEvidence,
        error: this.state.ownerSnapshot.error,
      });
    }
    return null;
  }

  private persistCurrentStateOrBlock(): boolean {
    const record = this.recoveryRecord();
    if (record === null || this.persistence === null) return true;
    try {
      this.persistence.write(record);
      return true;
    } catch {
      this.state = RECOVERY_BLOCKED_INTERNAL_STATE;
      this.refreshSnapshot(true);
      return false;
    }
  }

  private clearDurableRecordOrBlock(): boolean {
    if (this.persistence === null) return true;
    try {
      this.persistence.clear();
      return true;
    } catch {
      this.state = RECOVERY_BLOCKED_INTERNAL_STATE;
      this.refreshSnapshot(true);
      return false;
    }
  }

  /** Hydrates retained mutation truth after local authentication succeeds. */
  public hydrate(notify = true): boolean {
    if (this.persistence === null || this.state.phase !== 'idle') return false;
    let record: StartMutationRecoveryRecord | null;
    try {
      record = this.persistence.read();
    } catch {
      this.state = RECOVERY_BLOCKED_INTERNAL_STATE;
      this.refreshSnapshot(notify);
      return false;
    }
    if (record === null) return true;

    const presentation: StartMutationPresentation = Object.freeze({
      operation: record.operation,
      eventTypeName: record.eventTypeName,
      mode: record.mode,
      idempotencyKey: record.idempotencyKey,
    });
    if (record.phase === 'succeeded') {
      this.state = Object.freeze({
        phase: 'succeeded',
        owner: record.owner,
        presentation,
        activationEvidence: record.activationEvidence,
        feedbackClaimed: record.feedbackClaimed,
        ownerSnapshot: succeededOwnerSnapshot(record.completion),
      });
    } else if (record.phase === 'failed') {
      this.state = Object.freeze({
        phase: 'failed',
        owner: record.owner,
        presentation,
        activationEvidence: record.activationEvidence,
        ...presentation,
        ownerSnapshot: failedOwnerSnapshot(presentation, record.error),
      });
    } else {
      const error = Object.freeze({
        message: RECOVERED_UNKNOWN_MESSAGE,
        outcomeUnknown: true as const,
      });
      this.state = Object.freeze({
        phase: 'unresolved',
        owner: record.owner,
        activationEvidence: record.activationEvidence,
        ...presentation,
        ownerSnapshot: unresolvedOwnerSnapshot(presentation, error),
      });
    }
    this.refreshSnapshot(notify);
    return true;
  }

  /** Reconciles auth visibility without using connectivity epochs as identity. */
  public reconcile(
    observation: StartMutationAuthObservation,
    notify = true,
  ): void {
    const nextOwner =
      observation.owner === null ? null : validatedOwner(observation.owner);

    if (observation.phase === 'online' && nextOwner === null) {
      throw new TypeError('Online start-mutation state requires an owner.');
    }

    if (observation.phase === 'online') {
      this.onlineOwner = nextOwner;
      if (
        this.state.phase !== 'idle' &&
        this.state.phase !== 'recovery-blocked' &&
        !sameOwner(this.state.owner, nextOwner)
      ) {
        if (this.state.phase === 'pending') {
          this.state = Object.freeze({
            ...this.state,
            quarantined: true,
          });
        } else if (
          this.state.phase === 'succeeded' ||
          this.state.phase === 'failed'
        ) {
          if (!this.clearDurableRecordOrBlock()) return;
          this.state = IDLE_INTERNAL_STATE;
        }
      }
      this.refreshSnapshot(notify);
      return;
    }

    this.onlineOwner = null;
    if (observation.phase === 'signed-out' || observation.phase === 'blocked') {
      if (this.state.phase === 'pending') {
        this.state = Object.freeze({
          ...this.state,
          quarantined: true,
        });
      } else if (
        this.state.phase === 'succeeded' ||
        this.state.phase === 'failed'
      ) {
        if (!this.clearDurableRecordOrBlock()) return;
        this.state = IDLE_INTERNAL_STATE;
      }
    }
    this.refreshSnapshot(notify);
  }

  /**
   * Synchronously admits at most one operation. The operation is called in
   * this stack after pending state is published, so reentrant or double taps
   * cannot start a second activation or join.
   */
  public submit(submission: StartMutationSubmission): StartMutationAdmission {
    const owner = validatedOwner(submission.owner);
    if (this.state.phase !== 'idle' || !sameOwner(owner, this.onlineOwner)) {
      return REJECTED_ADMISSION;
    }

    const presentation = presentationOf(submission);
    const ownerSnapshot = pendingOwnerSnapshot(submission, presentation);
    const activationEvidence =
      submission.operation === 'activate'
        ? submission.activationEvidence
        : null;

    if (this.persistence !== null) {
      try {
        this.persistence.write(
          Object.freeze({
            phase: 'unresolved',
            owner,
            ...presentation,
            activationEvidence,
            error: Object.freeze({
              message: RECOVERED_UNKNOWN_MESSAGE,
              outcomeUnknown: true as const,
            }),
          }),
        );
      } catch {
        this.state = RECOVERY_BLOCKED_INTERNAL_STATE;
        this.refreshSnapshot(true);
        return REJECTED_ADMISSION;
      }
    }
    const token = this.nextToken;
    this.nextToken += 1;
    this.state = Object.freeze({
      phase: 'pending',
      owner,
      token,
      quarantined: false,
      activationEvidence,
      ...presentation,
      ownerSnapshot,
    });
    this.refreshSnapshot(true);

    let operation: Promise<StartEventResult | JoinEventResult>;
    try {
      operation = submission.run();
    } catch (error) {
      this.settleFailure(token, error);
      return Object.freeze({
        accepted: true,
        completion: Promise.resolve(),
      });
    }

    const completion = Promise.resolve(operation).then(
      (result) => {
        this.settleSuccess(token, submission, result);
      },
      (error: unknown) => {
        this.settleFailure(token, error);
      },
    );
    return Object.freeze({ accepted: true, completion });
  }

  private settleSuccess(
    token: number,
    submission: StartMutationSubmission,
    result: StartEventResult | JoinEventResult,
  ): void {
    if (this.state.phase !== 'pending' || this.state.token !== token) return;
    const pending = this.state;
    let completion: StartMutationCompletion;
    try {
      completion = resultCompletion(submission, result);
    } catch (error) {
      this.settleFailure(token, error);
      return;
    }
    if (pending.quarantined) {
      if (!this.clearDurableRecordOrBlock()) return;
      this.state = IDLE_INTERNAL_STATE;
      this.refreshSnapshot(true);
      return;
    }
    const presentation: StartMutationPresentation = Object.freeze({
      operation: pending.operation,
      eventTypeName: pending.eventTypeName,
      mode: pending.mode,
      idempotencyKey: pending.idempotencyKey,
    });
    this.state = Object.freeze({
      phase: 'succeeded',
      owner: pending.owner,
      presentation,
      activationEvidence: pending.activationEvidence,
      feedbackClaimed: false,
      ownerSnapshot: succeededOwnerSnapshot(completion),
    });
    if (!this.persistCurrentStateOrBlock()) return;
    this.refreshSnapshot(true);
  }

  private settleFailure(token: number, thrown: unknown): void {
    if (this.state.phase !== 'pending' || this.state.token !== token) return;
    const pending = this.state;
    const error = mapStartMutationError(thrown);
    const presentation: StartMutationPresentation = Object.freeze({
      operation: pending.operation,
      eventTypeName: pending.eventTypeName,
      mode: pending.mode,
      idempotencyKey: pending.idempotencyKey,
    });
    this.state = error.outcomeUnknown
      ? Object.freeze({
          phase: 'unresolved',
          owner: pending.owner,
          activationEvidence: pending.activationEvidence,
          ...presentation,
          ownerSnapshot: unresolvedOwnerSnapshot(presentation, error),
        })
      : Object.freeze({
          phase: 'failed',
          owner: pending.owner,
          presentation,
          activationEvidence: pending.activationEvidence,
          ...presentation,
          ownerSnapshot: failedOwnerSnapshot(presentation, error),
        });
    if (pending.quarantined && !error.outcomeUnknown) {
      if (!this.clearDurableRecordOrBlock()) return;
      this.state = IDLE_INTERNAL_STATE;
      this.refreshSnapshot(true);
      return;
    }
    if (!this.persistCurrentStateOrBlock()) return;
    this.refreshSnapshot(true);
  }

  /** Clears a displayed terminal result only for its exact owner. */
  public acknowledge(ownerInput: StartMutationOwner): boolean {
    const owner = validatedOwner(ownerInput);
    if (
      (this.state.phase !== 'succeeded' && this.state.phase !== 'failed') ||
      !sameOwner(this.state.owner, owner) ||
      !sameOwner(this.onlineOwner, owner)
    ) {
      return false;
    }
    if (!this.clearDurableRecordOrBlock()) return false;
    this.state = IDLE_INTERNAL_STATE;
    this.refreshSnapshot(true);
    return true;
  }

  /** Publishes a pre-transport denial without creating a key or running work. */
  public reportDeniedSubmission(
    ownerInput: StartMutationOwner,
    display: StartMutationDisplay,
    thrown: unknown,
  ): boolean {
    const owner = validatedOwner(ownerInput);
    if (this.state.phase !== 'idle' || !sameOwner(owner, this.onlineOwner)) {
      return false;
    }
    const error = mapStartMutationError(thrown);
    if (error.outcomeUnknown) return false;
    const ownerSnapshot: FailedState['ownerSnapshot'] = Object.freeze({
      phase: 'failed',
      operation: display.operation,
      eventTypeName: display.eventTypeName,
      mode: TemplateModeSchema.parse(display.mode),
      error,
    });
    this.state = Object.freeze({
      phase: 'failed',
      owner,
      presentation: null,
      activationEvidence: null,
      operation: ownerSnapshot.operation,
      eventTypeName: ownerSnapshot.eventTypeName,
      mode: ownerSnapshot.mode,
      ownerSnapshot,
    });
    this.refreshSnapshot(true);
    return true;
  }

  /** Returns a success exactly once so remounts cannot repeat haptics. */
  public claimSuccessFeedback(
    ownerInput: StartMutationOwner,
  ): StartMutationCompletion | null {
    const owner = validatedOwner(ownerInput);
    if (
      this.state.phase !== 'succeeded' ||
      this.state.feedbackClaimed ||
      !sameOwner(this.state.owner, owner) ||
      !sameOwner(this.onlineOwner, owner)
    ) {
      return null;
    }
    const completion = this.state.ownerSnapshot.completion;
    this.state = Object.freeze({
      ...this.state,
      feedbackClaimed: true,
    });
    if (!this.persistCurrentStateOrBlock()) return null;
    return completion;
  }

  /** Resolves only exact durable activation evidence; absence never clears. */
  public resolveActivationFromFreshEvents(
    ownerInput: StartMutationOwner,
    events: readonly Event[],
  ): boolean {
    const owner = validatedOwner(ownerInput);
    if (
      this.state.phase !== 'unresolved' ||
      this.state.operation !== 'activate' ||
      this.state.activationEvidence === null ||
      !sameOwner(this.state.owner, owner) ||
      !sameOwner(this.onlineOwner, owner)
    ) {
      return false;
    }
    const unresolved = this.state;
    const evidence = unresolved.activationEvidence;
    const matchingEvent =
      evidence === null
        ? undefined
        : events.find((event) =>
            eventMatchesActivationEvidence(event, evidence),
          );
    if (matchingEvent === undefined) {
      return false;
    }
    const completion = Object.freeze({
      kind: 'activated' as const,
      eventId: EventIdSchema.parse(matchingEvent.id),
      eventTypeName: unresolved.eventTypeName,
      mode: unresolved.mode,
    });
    this.state = Object.freeze({
      phase: 'succeeded',
      owner: unresolved.owner,
      presentation: Object.freeze({
        operation: unresolved.operation,
        eventTypeName: unresolved.eventTypeName,
        mode: unresolved.mode,
        idempotencyKey: unresolved.idempotencyKey,
      }),
      activationEvidence: evidence,
      feedbackClaimed: false,
      ownerSnapshot: succeededOwnerSnapshot(completion),
    });
    if (!this.persistCurrentStateOrBlock()) return false;
    this.refreshSnapshot(true);
    return true;
  }
}

export function createStartMutationCoordinator(
  persistence: StartMutationPersistence | null = null,
): StartMutationCoordinator {
  return new StartMutationCoordinator(persistence);
}
