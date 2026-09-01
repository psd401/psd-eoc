import type {
  ConnectivityEpochId,
  DeviceEnrollmentId,
  MobileSessionResponse,
  SessionId,
  SessionEstablishmentResult,
  UserId,
} from '@psd-eoc/contracts';

import {
  AuthenticatedApiError,
  AuthenticatedRequestFailure,
  type AuthenticatedRequestOptions,
  type AuthenticatedRequestTransport,
  type RequestAuthenticated,
} from '../api';
import { MobileAuthError, OfflineMutationDeniedError } from './auth-errors';

export const OFFLINE_ACTION_MESSAGE =
  'Offline — starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again.';

const EXPIRED_SESSION_MESSAGE =
  'This device session has expired or is no longer available. Sign in again.';
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type AuthPhase =
  | 'booting'
  | 'locked'
  | 'signed-out'
  | 'cached-checking'
  | 'offline-cached'
  | 'online'
  | 'blocked';

export interface StoredAuthVault {
  readonly refreshToken: string;
  readonly pendingRefreshIdempotencyKey: string | null;
  readonly session: SessionEstablishmentResult;
}

export interface AuthState {
  readonly phase: AuthPhase;
  readonly session: SessionEstablishmentResult | null;
  readonly connectivityEpochId: ConnectivityEpochId | null;
  readonly message: string | null;
}

export interface AuthStorage {
  getOrCreateInstallationId(): Promise<string>;
  hasEnrollment(): Promise<boolean>;
  readVault(): Promise<StoredAuthVault | null>;
  writeVault(vault: StoredAuthVault): Promise<void>;
  clearSession(): Promise<void>;
}

export interface LocalAuthenticator {
  authenticate(): Promise<
    Readonly<{ success: true }> | Readonly<{ success: false; message: string }>
  >;
}

export interface SessionApi {
  refresh(
    refreshToken: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<MobileSessionResponse>;
  revoke(
    refreshToken: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void>;
}

export interface AuthTimer {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export interface MobileAuthControllerDependencies {
  readonly api: SessionApi;
  readonly authenticatedApi?: AuthenticatedRequestTransport;
  readonly createIdempotencyKey: () => string;
  readonly localAuthenticator: LocalAuthenticator;
  readonly now?: () => Date;
  readonly storage: AuthStorage;
  readonly timer?: AuthTimer;
}

type AuthListener = () => void;

const initialState: AuthState = Object.freeze({
  phase: 'booting',
  session: null,
  connectivityEpochId: null,
  message: null,
});

const defaultTimer: AuthTimer = Object.freeze({
  schedule(callback: () => void, delayMilliseconds: number): unknown {
    return globalThis.setTimeout(callback, delayMilliseconds);
  },
  cancel(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

function locallyUsableSession(
  session: SessionEstablishmentResult,
  now: Date,
): boolean {
  const nowMilliseconds = now.getTime();
  const expiresAt = Date.parse(session.session.expiresAt);
  const graceUntil = Date.parse(
    session.session.authorization.membershipGraceUntil,
  );
  return (
    Number.isFinite(expiresAt) &&
    Number.isFinite(graceUntil) &&
    nowMilliseconds < expiresAt &&
    nowMilliseconds < graceUntil &&
    session.session.revokedAt === null &&
    session.deviceEnrollment.revokedAt === null &&
    session.user.disabledAt === null
  );
}

function localSessionDeadline(session: SessionEstablishmentResult): number {
  return Math.min(
    Date.parse(session.session.expiresAt),
    Date.parse(session.session.authorization.membershipGraceUntil),
  );
}

function authenticatedRequestAborted(): Error {
  const error = new Error('The authenticated request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Pure session lifecycle. Native modules are injected, making every safety
 * transition independently testable without a simulator or live provider.
 */
export class MobileAuthController {
  private state: AuthState = initialState;
  private readonly listeners = new Set<AuthListener>();
  private vault: StoredAuthVault | null = null;
  private refreshAbortController: AbortController | null = null;
  private readonly featureRequestAbortControllers = new Set<AbortController>();
  private lifecycleGeneration = 0;
  private credentialGeneration = 0;
  private credentialOperationTail: Promise<void> = Promise.resolve();
  private unlockPromise: Promise<void> | null = null;
  private signOutPromise: Promise<void> | null = null;
  private signOutInProgress = false;
  private cleanupConfirmedSessionId: string | null = null;
  private pendingRevocation: Readonly<{
    sessionId: string;
    idempotencyKey: string;
  }> | null = null;
  private expiryTimerHandle: unknown | null = null;
  private expiryClearPromise: Promise<void> | null = null;

  public constructor(
    private readonly dependencies: MobileAuthControllerDependencies,
  ) {}

  public getSnapshot = (): AuthState => this.state;

  public subscribe = (listener: AuthListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(next: AuthState): void {
    this.state = Object.freeze(next);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private timer(): AuthTimer {
    return this.dependencies.timer ?? defaultTimer;
  }

  private enqueueCredentialOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.credentialOperationTail.then(operation, operation);
    this.credentialOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private writeVaultIfCurrent(
    expectedCredentialGeneration: number,
    vault: StoredAuthVault,
  ): Promise<boolean> {
    return this.enqueueCredentialOperation(async () => {
      if (expectedCredentialGeneration !== this.credentialGeneration) {
        return false;
      }
      await this.dependencies.storage.writeVault(vault);
      return expectedCredentialGeneration === this.credentialGeneration;
    });
  }

  private async clearStoredSession(): Promise<boolean> {
    try {
      await this.enqueueCredentialOperation(async () => {
        await this.dependencies.storage.clearSession();
      });
      return true;
    } catch {
      return false;
    }
  }

  private cancelExpiryTimer(): void {
    const handle = this.expiryTimerHandle;
    this.expiryTimerHandle = null;
    if (handle !== null) {
      try {
        this.timer().cancel(handle);
      } catch {
        // Clearing credentials remains the fail-closed fallback below.
      }
    }
  }

  private abortFeatureRequests(): void {
    for (const controller of this.featureRequestAbortControllers) {
      controller.abort();
    }
    this.featureRequestAbortControllers.clear();
  }

  private scheduleExpiry(
    session: SessionEstablishmentResult,
    expectedCredentialGeneration = this.credentialGeneration,
  ): void {
    this.cancelExpiryTimer();
    const deadline = localSessionDeadline(session);
    const remaining = deadline - this.now().getTime();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      void this.expireSession();
      return;
    }
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    try {
      this.expiryTimerHandle = this.timer().schedule(() => {
        this.expiryTimerHandle = null;
        void this.recheckScheduledExpiry(expectedCredentialGeneration);
      }, delay);
    } catch {
      void this.expireSession();
    }
  }

  private async recheckScheduledExpiry(
    expectedCredentialGeneration: number,
  ): Promise<void> {
    if (expectedCredentialGeneration !== this.credentialGeneration) {
      return;
    }
    const session = this.vault?.session ?? this.state.session;
    if (session === null) {
      return;
    }
    if (locallyUsableSession(session, this.now())) {
      this.scheduleExpiry(session, expectedCredentialGeneration);
      return;
    }
    await this.expireSession();
  }

  private expireSession(): Promise<void> {
    if (this.expiryClearPromise !== null) {
      return this.expiryClearPromise;
    }
    // Hide cached and online shells synchronously; storage clearing is queued
    // behind any credential write that was already in flight.
    this.update({
      phase: 'blocked',
      session: null,
      connectivityEpochId: null,
      message: EXPIRED_SESSION_MESSAGE,
    });
    const clearing = this.clearAndSignOut(EXPIRED_SESSION_MESSAGE);
    this.expiryClearPromise = clearing;
    void clearing.finally(() => {
      if (this.expiryClearPromise === clearing) {
        this.expiryClearPromise = null;
      }
    });
    return clearing;
  }

  private invalidateCredentials(): number {
    this.lifecycleGeneration += 1;
    this.credentialGeneration += 1;
    this.cleanupConfirmedSessionId = null;
    this.pendingRevocation = null;
    this.refreshAbortController?.abort();
    this.refreshAbortController = null;
    this.abortFeatureRequests();
    this.cancelExpiryTimer();
    this.vault = null;
    return this.credentialGeneration;
  }

  public async bootstrap(): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const credentialGeneration = this.credentialGeneration;
    try {
      const enrolled = await this.dependencies.storage.hasEnrollment();
      if (
        credentialGeneration !== this.credentialGeneration ||
        this.state.phase !== 'booting'
      ) {
        return;
      }
      // A background transition may occur while the marker read is pending.
      // The result is still safe to expose because it contains no bearer.
      void lifecycleGeneration;
      this.update({
        phase: enrolled ? 'locked' : 'signed-out',
        session: null,
        connectivityEpochId: null,
        message: null,
      });
    } catch {
      if (
        credentialGeneration !== this.credentialGeneration ||
        this.state.phase !== 'booting'
      ) {
        return;
      }
      this.update({
        phase: 'blocked',
        session: null,
        connectivityEpochId: null,
        message:
          'Secure device storage is unavailable. PSD EOC cannot sign in safely on this device.',
      });
    }
  }

  public foreground(): Promise<void> {
    if (this.signOutInProgress) {
      return Promise.resolve();
    }
    if (this.state.phase !== 'locked') {
      return Promise.resolve();
    }
    this.unlockPromise ??= this.unlockAndRefresh().finally(() => {
      this.unlockPromise = null;
    });
    return this.unlockPromise;
  }

  private async unlockAndRefresh(): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const credentialGeneration = this.credentialGeneration;
    let unlocked: Awaited<ReturnType<LocalAuthenticator['authenticate']>>;
    try {
      unlocked = await this.dependencies.localAuthenticator.authenticate();
    } catch {
      if (
        lifecycleGeneration === this.lifecycleGeneration &&
        credentialGeneration === this.credentialGeneration
      ) {
        this.update({
          phase: 'locked',
          session: null,
          connectivityEpochId: null,
          message:
            'Device authentication could not be verified. PSD EOC remains locked. Try again.',
        });
      }
      return;
    }
    if (
      lifecycleGeneration !== this.lifecycleGeneration ||
      credentialGeneration !== this.credentialGeneration
    ) {
      return;
    }
    if (!unlocked.success) {
      this.update({
        phase: 'locked',
        session: null,
        connectivityEpochId: null,
        message: unlocked.message,
      });
      return;
    }

    let vault: StoredAuthVault | null;
    try {
      // This is deliberately the first credential read in the unlock path.
      vault = await this.dependencies.storage.readVault();
    } catch {
      vault = null;
    }
    if (
      lifecycleGeneration !== this.lifecycleGeneration ||
      credentialGeneration !== this.credentialGeneration
    ) {
      return;
    }
    if (vault === null || !locallyUsableSession(vault.session, this.now())) {
      await this.clearAndSignOut(EXPIRED_SESSION_MESSAGE);
      return;
    }

    this.vault = vault;
    this.update({
      phase: 'cached-checking',
      session: vault.session,
      connectivityEpochId: null,
      message:
        'Checking the secure connection. Starting an incident and other changes remain unavailable.',
    });
    this.scheduleExpiry(vault.session, credentialGeneration);
    await this.refreshCurrent(lifecycleGeneration, credentialGeneration);
  }

  public background(): void {
    this.lifecycleGeneration += 1;
    this.refreshAbortController?.abort();
    this.refreshAbortController = null;
    this.abortFeatureRequests();
    this.cancelExpiryTimer();
    this.vault = null;
    if (
      this.state.phase !== 'signed-out' &&
      this.state.phase !== 'booting' &&
      this.state.phase !== 'blocked'
    ) {
      this.update({
        phase: 'locked',
        session: null,
        connectivityEpochId: null,
        message: null,
      });
    }
  }

  public async enroll(payload: MobileSessionResponse): Promise<boolean> {
    if (this.signOutInProgress) {
      await this.revokeIssuedSession(payload);
      return false;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const credentialGeneration = this.credentialGeneration;
    let unlocked: Awaited<ReturnType<LocalAuthenticator['authenticate']>>;
    try {
      unlocked = await this.dependencies.localAuthenticator.authenticate();
    } catch {
      if (credentialGeneration !== this.credentialGeneration) {
        await this.revokeIssuedSession(payload);
        return false;
      }
      return this.rejectIssuedEnrollment(
        payload,
        'Device authentication could not be verified. PSD EOC did not enroll this device.',
      );
    }
    if (credentialGeneration !== this.credentialGeneration) {
      await this.revokeIssuedSession(payload);
      return false;
    }
    if (!unlocked.success) {
      return this.rejectIssuedEnrollment(
        payload,
        'Device authentication is required to enroll PSD EOC. No custom PIN is available.',
      );
    }

    const vault: StoredAuthVault = Object.freeze({
      refreshToken: payload.refreshToken,
      pendingRefreshIdempotencyKey: null,
      session: payload.session,
    });
    let written: boolean;
    try {
      written = await this.writeVaultIfCurrent(credentialGeneration, vault);
    } catch {
      if (credentialGeneration !== this.credentialGeneration) {
        await this.revokeIssuedSession(payload);
        return false;
      }
      return this.rejectIssuedEnrollment(
        payload,
        'PSD EOC could not safely save this device session.',
      );
    }
    if (!written || credentialGeneration !== this.credentialGeneration) {
      await this.revokeIssuedSession(payload);
      return false;
    }
    // Enrollment replaces the credential held by the controller. No feature
    // request authenticated with the previous bearer may outlive that change.
    this.abortFeatureRequests();
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      // Backgrounding is not a credential tombstone, so a completed enrollment
      // may remain encrypted. Never restore it to memory or bypass a fresh
      // foreground device-authentication challenge.
      this.vault = null;
      this.update({
        phase: 'locked',
        session: null,
        connectivityEpochId: null,
        message: null,
      });
      return true;
    }

    this.vault = vault;
    this.update({
      phase: 'online',
      session: payload.session,
      connectivityEpochId: payload.session.connectivityEpoch.id,
      message: null,
    });
    this.scheduleExpiry(payload.session, credentialGeneration);
    return true;
  }

  private async revokeIssuedSession(
    payload: MobileSessionResponse,
  ): Promise<boolean> {
    try {
      await this.dependencies.api.revoke(
        payload.refreshToken,
        payload.session.session.id,
        this.dependencies.createIdempotencyKey(),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async rejectIssuedEnrollment(
    payload: MobileSessionResponse,
    reason: string,
  ): Promise<false> {
    const credentialGeneration = this.invalidateCredentials();
    this.update({
      phase: 'blocked',
      session: null,
      connectivityEpochId: null,
      message: reason,
    });
    const localCleared = await this.clearStoredSession();
    const remotelyRevoked = await this.revokeIssuedSession(payload);
    if (credentialGeneration !== this.credentialGeneration) {
      return false;
    }
    const remoteWarning = remotelyRevoked
      ? ''
      : ' The server could not confirm cleanup; ask a district administrator to revoke this device session.';
    this.update({
      phase: localCleared ? 'signed-out' : 'blocked',
      session: null,
      connectivityEpochId: null,
      message: localCleared
        ? `${reason}${remoteWarning}`
        : `Secure device storage could not be cleared. Access remains blocked.${remoteWarning}`,
    });
    return false;
  }

  public async retryConnection(): Promise<void> {
    if (
      this.signOutInProgress ||
      this.vault === null ||
      (this.state.phase !== 'offline-cached' &&
        this.state.phase !== 'cached-checking')
    ) {
      return;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const credentialGeneration = this.credentialGeneration;
    if (!locallyUsableSession(this.vault.session, this.now())) {
      await this.expireSession();
      return;
    }
    this.update({
      phase: 'cached-checking',
      session: this.vault.session,
      connectivityEpochId: null,
      message:
        'Checking the secure connection. Starting an incident and other changes remain unavailable.',
    });
    await this.refreshCurrent(lifecycleGeneration, credentialGeneration);
  }

  private async refreshCurrent(
    lifecycleGeneration: number,
    credentialGeneration: number,
  ): Promise<void> {
    if (
      lifecycleGeneration !== this.lifecycleGeneration ||
      credentialGeneration !== this.credentialGeneration
    ) {
      return;
    }
    const current = this.vault;
    if (current === null) {
      return;
    }
    const idempotencyKey =
      current.pendingRefreshIdempotencyKey ??
      this.dependencies.createIdempotencyKey();
    const pending: StoredAuthVault = Object.freeze({
      ...current,
      pendingRefreshIdempotencyKey: idempotencyKey,
    });
    let pendingWritten: boolean;
    try {
      pendingWritten = await this.writeVaultIfCurrent(
        credentialGeneration,
        pending,
      );
    } catch {
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        credentialGeneration !== this.credentialGeneration
      ) {
        return;
      }
      this.cancelExpiryTimer();
      this.vault = null;
      this.update({
        phase: 'blocked',
        session: null,
        connectivityEpochId: null,
        message:
          'PSD EOC could not safely update secure device storage. Sign in again or contact district technology support.',
      });
      return;
    }
    if (
      !pendingWritten ||
      credentialGeneration !== this.credentialGeneration ||
      lifecycleGeneration !== this.lifecycleGeneration
    ) {
      return;
    }
    this.vault = pending;

    const abortController = new AbortController();
    this.refreshAbortController = abortController;
    let refreshed: MobileSessionResponse;
    try {
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        credentialGeneration !== this.credentialGeneration
      ) {
        return;
      }
      refreshed = await this.dependencies.api.refresh(
        pending.refreshToken,
        idempotencyKey,
        abortController.signal,
      );
    } catch (error) {
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        credentialGeneration !== this.credentialGeneration
      ) {
        return;
      }
      if (error instanceof MobileAuthError && error.kind === 'offline') {
        this.update({
          phase: 'offline-cached',
          session: pending.session,
          connectivityEpochId: null,
          message: OFFLINE_ACTION_MESSAGE,
        });
        return;
      }
      if (error instanceof MobileAuthError && error.kind === 'rejected') {
        await this.clearAndSignOut(
          'This device session is no longer available. Sign in again or contact district technology support.',
        );
        return;
      }
      this.cancelExpiryTimer();
      this.vault = null;
      this.update({
        phase: 'blocked',
        session: null,
        connectivityEpochId: null,
        message:
          'PSD EOC received an invalid authentication response. Sign in again or contact district technology support.',
      });
      return;
    } finally {
      if (this.refreshAbortController === abortController) {
        this.refreshAbortController = null;
      }
    }

    if (credentialGeneration !== this.credentialGeneration) {
      return;
    }
    // The server has rotated the bearer. Abort requests that may still be
    // using the retired credential before making the replacement current.
    this.abortFeatureRequests();
    const rotated: StoredAuthVault = Object.freeze({
      refreshToken: refreshed.refreshToken,
      pendingRefreshIdempotencyKey: null,
      session: refreshed.session,
    });
    let rotatedWritten: boolean;
    try {
      // A provider may complete rotation despite a background abort. Persisting
      // that response is safe while the credential generation is current and
      // avoids retaining a retired token; the bearer is not restored to memory.
      rotatedWritten = await this.writeVaultIfCurrent(
        credentialGeneration,
        rotated,
      );
    } catch {
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        credentialGeneration !== this.credentialGeneration
      ) {
        return;
      }
      this.cancelExpiryTimer();
      this.vault = null;
      this.update({
        phase: 'blocked',
        session: null,
        connectivityEpochId: null,
        message:
          'PSD EOC could not safely update secure device storage. Sign in again or contact district technology support.',
      });
      return;
    }
    if (
      !rotatedWritten ||
      credentialGeneration !== this.credentialGeneration ||
      lifecycleGeneration !== this.lifecycleGeneration
    ) {
      return;
    }
    this.vault = rotated;
    this.update({
      phase: 'online',
      session: refreshed.session,
      connectivityEpochId: refreshed.session.connectivityEpoch.id,
      message: null,
    });
    this.scheduleExpiry(refreshed.session, credentialGeneration);
  }

  public assertMutationAllowed(): Readonly<{
    connectivityEpochId: ConnectivityEpochId;
    userId: UserId;
    sessionId: SessionId;
    deviceEnrollmentId: DeviceEnrollmentId;
  }> {
    const session = this.state.session;
    const vault = this.vault;
    if (
      this.state.phase !== 'online' ||
      this.state.connectivityEpochId === null ||
      session === null ||
      vault === null
    ) {
      throw new OfflineMutationDeniedError();
    }
    if (
      !locallyUsableSession(session, this.now()) ||
      vault.session.user.id !== session.user.id ||
      vault.session.session.id !== session.session.id ||
      vault.session.deviceEnrollment.id !== session.deviceEnrollment.id ||
      vault.session.connectivityEpoch.id !== this.state.connectivityEpochId
    ) {
      void this.expireSession();
      throw new OfflineMutationDeniedError();
    }
    return Object.freeze({
      connectivityEpochId: this.state.connectivityEpochId,
      userId: session.user.id,
      sessionId: session.session.id,
      deviceEnrollmentId: session.deviceEnrollment.id,
    });
  }

  /**
   * The bearer for a read.
   *
   * Reads used to go through `currentAuthenticatedBearer`, which asserts the
   * preconditions for a *mutation*: the `online` phase, a non-null connectivity
   * epoch, and an epoch matching the vault. Those exist to give a mutation
   * provenance and idempotency. A timeline read needs none of them.
   *
   * The cost of that was severe and invisible. Whenever the app was not
   * strictly online with a live epoch, the event room's poll threw here before
   * any request was made -- so the timeline silently stopped updating, the
   * server recorded nothing because nothing arrived, and the room told the
   * operator that updates were not arriving during an emergency. It also meant
   * a read could reach the epoch mismatch branch and expire the session.
   *
   * A read still requires a usable session and a bearer; without one there is
   * nothing to send. What it no longer requires is permission to mutate. If the
   * network is genuinely unavailable the request now fails as a network error,
   * which is both truthful and reportable.
   */
  private currentReadBearer(): Readonly<{
    bearer: string;
    credentialGeneration: number;
  }> {
    const session = this.state.session;
    const vault = this.vault;
    if (
      session === null ||
      vault === null ||
      !locallyUsableSession(session, this.now())
    ) {
      throw new OfflineMutationDeniedError();
    }
    return Object.freeze({
      bearer: vault.refreshToken,
      credentialGeneration: this.credentialGeneration,
    });
  }

  private currentAuthenticatedBearer(): Readonly<{
    bearer: string;
    credentialGeneration: number;
  }> {
    this.assertMutationAllowed();
    const current = this.vault;
    if (current === null) throw new OfflineMutationDeniedError();
    return Object.freeze({
      bearer: current.refreshToken,
      credentialGeneration: this.credentialGeneration,
    });
  }

  private markOfflineAfterRequestFailure(
    expectedCredentialGeneration: number,
  ): void {
    if (
      expectedCredentialGeneration !== this.credentialGeneration ||
      this.state.phase !== 'online' ||
      this.state.session === null ||
      this.vault === null
    ) {
      return;
    }
    const session = this.state.session;
    this.abortFeatureRequests();
    this.update({
      phase: 'offline-cached',
      session,
      connectivityEpochId: null,
      message: OFFLINE_ACTION_MESSAGE,
    });
  }

  public requestAuthenticated: RequestAuthenticated = async <Output>(
    request: AuthenticatedRequestOptions<Output>,
  ): Promise<Output> => {
    // A read is not a mutation and is not gated as one.
    const credential =
      request.method === 'GET'
        ? this.currentReadBearer()
        : this.currentAuthenticatedBearer();
    const authenticatedApi = this.dependencies.authenticatedApi;
    if (authenticatedApi === undefined) {
      throw new AuthenticatedRequestFailure(
        'configuration',
        'PSD EOC authenticated requests are not configured for this build.',
      );
    }

    const controller = new AbortController();
    const abortFromCaller = () => {
      controller.abort();
    };
    if (request.signal !== undefined) {
      request.signal?.addEventListener('abort', abortFromCaller, {
        once: true,
      });
      // Recheck after subscribing so an abort racing listener registration
      // cannot let a caller-cancelled request escape the auth lifecycle.
      if (request.signal.aborted) controller.abort();
    }
    this.featureRequestAbortControllers.add(controller);

    try {
      const result = await authenticatedApi.request(
        credential.bearer,
        request,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        credential.credentialGeneration !== this.credentialGeneration ||
        // A mutation's result is only trusted while the session that authorised
        // it is still the live online one. A read carries no such claim, and
        // discarding a timeline page because the phase moved is what left the
        // room stale with nothing to show for it.
        (request.method !== 'GET' && this.state.phase !== 'online') ||
        this.vault?.refreshToken !== credential.bearer
      ) {
        throw authenticatedRequestAborted();
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw authenticatedRequestAborted();
      }
      if (
        error instanceof AuthenticatedRequestFailure &&
        error.kind === 'network'
      ) {
        this.markOfflineAfterRequestFailure(credential.credentialGeneration);
      } else if (
        (error instanceof AuthenticatedApiError && error.status === 401) ||
        (error instanceof AuthenticatedRequestFailure && error.status === 401)
      ) {
        await this.clearAndSignOut(
          'This device session is no longer available. Sign in again or contact district technology support.',
        );
      }
      throw error;
    } finally {
      this.featureRequestAbortControllers.delete(controller);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  };

  public signOut(): Promise<void> {
    if (this.signOutPromise !== null) return this.signOutPromise;
    this.signOutInProgress = true;
    this.signOutPromise = this.signOutSafely().finally(() => {
      this.signOutInProgress = false;
      this.signOutPromise = null;
    });
    return this.signOutPromise;
  }

  private beginSignOutFence(): Readonly<{
    credentialGeneration: number;
    lifecycleGeneration: number;
    previousState: AuthState;
    refreshWasInFlight: boolean;
  }> {
    const previousState = this.state;
    const refreshWasInFlight = this.refreshAbortController !== null;
    this.lifecycleGeneration += 1;
    this.credentialGeneration += 1;
    this.cleanupConfirmedSessionId = null;
    const lifecycleGeneration = this.lifecycleGeneration;
    const credentialGeneration = this.credentialGeneration;
    this.refreshAbortController?.abort();
    this.refreshAbortController = null;
    this.abortFeatureRequests();
    this.cancelExpiryTimer();
    // Keep the credential in protected memory and storage until the server's
    // canonical revocation receipt proves session and push cleanup. The locked
    // state immediately closes every authenticated mutation path.
    this.update({
      phase: 'locked',
      session: null,
      connectivityEpochId: null,
      message: 'Confirming server sign-out and push cleanup.',
    });
    return Object.freeze({
      credentialGeneration,
      lifecycleGeneration,
      previousState,
      refreshWasInFlight,
    });
  }

  private restoreAfterFailedSignOut(
    current: StoredAuthVault,
    fence: ReturnType<MobileAuthController['beginSignOutFence']>,
    message: string,
  ): void {
    const fenceIsCurrent =
      fence.credentialGeneration === this.credentialGeneration &&
      fence.lifecycleGeneration === this.lifecycleGeneration;
    const canRestoreUnlockedState =
      fenceIsCurrent &&
      !fence.refreshWasInFlight &&
      (fence.previousState.phase === 'online' ||
        fence.previousState.phase === 'offline-cached') &&
      locallyUsableSession(current.session, this.now());
    if (!canRestoreUnlockedState) {
      // A background transition or an interrupted credential rotation makes
      // the in-memory bearer ambiguous. Keep encrypted enrollment intact but
      // require a fresh device-authenticated refresh before any app access.
      this.vault = null;
      this.update({
        phase: 'locked',
        session: null,
        connectivityEpochId: null,
        message,
      });
      return;
    }
    this.vault = current;
    this.update({ ...fence.previousState, message });
    this.scheduleExpiry(current.session, fence.credentialGeneration);
  }

  private async signOutSafely(): Promise<void> {
    const protectedReadRequired =
      this.vault === null &&
      (this.state.phase === 'locked' || this.state.phase === 'blocked');
    let current = protectedReadRequired ? null : this.vault;
    if (protectedReadRequired) {
      const protectedPhase = this.state.phase;
      let authenticated: Awaited<
        ReturnType<LocalAuthenticator['authenticate']>
      >;
      try {
        authenticated =
          await this.dependencies.localAuthenticator.authenticate();
      } catch {
        authenticated = {
          success: false,
          message: 'Device authentication could not be verified.',
        };
      }
      if (!authenticated.success) {
        const message = `${authenticated.message} PSD EOC kept the enrolled session and push endpoint unchanged.`;
        this.update({
          phase: protectedPhase,
          session: null,
          connectivityEpochId: null,
          message,
        });
        throw new MobileAuthError('rejected', message);
      }
      try {
        current = await this.dependencies.storage.readVault();
      } catch {
        current = null;
      }
      if (current === null) {
        const message =
          'PSD EOC could not read the enrolled session, so sign-out and push cleanup were not attempted.';
        this.update({
          phase: protectedPhase,
          session: null,
          connectivityEpochId: null,
          message,
        });
        throw new MobileAuthError('invalid-response', message);
      }
    }

    if (
      current !== null &&
      this.state.phase === 'blocked' &&
      this.cleanupConfirmedSessionId === current.session.session.id
    ) {
      await this.clearAndSignOut(null, this.cleanupConfirmedSessionId);
      return;
    }

    if (current === null) {
      if (this.state.phase === 'signed-out') {
        await this.clearAndSignOut(null);
        return;
      }
      const message =
        'PSD EOC cannot confirm server and push cleanup without the protected device credential.';
      this.update({ ...this.state, message });
      throw new MobileAuthError('rejected', message);
    }

    const sessionId = current.session.session.id;
    const pendingRevocation =
      this.pendingRevocation?.sessionId === sessionId
        ? this.pendingRevocation
        : Object.freeze({
            sessionId,
            idempotencyKey: this.dependencies.createIdempotencyKey(),
          });
    this.pendingRevocation = pendingRevocation;
    const fence = this.beginSignOutFence();

    try {
      // The server appends token-free push unregistration facts in the same
      // transaction as session revocation. Local credentials remain intact
      // unless that authoritative cleanup succeeds.
      await this.dependencies.api.revoke(
        current.refreshToken,
        sessionId,
        pendingRevocation.idempotencyKey,
      );
    } catch {
      const message =
        'Sign-out was not completed because PSD EOC could not confirm server and push cleanup. Reconnect and try again.';
      this.restoreAfterFailedSignOut(current, fence, message);
      throw new MobileAuthError('offline', message);
    }
    await this.clearAndSignOut(null, sessionId);
  }

  private async clearAndSignOut(
    message: string | null,
    cleanupConfirmedSessionId: string | null = null,
  ): Promise<void> {
    const credentialGeneration = this.invalidateCredentials();
    this.cleanupConfirmedSessionId = cleanupConfirmedSessionId;
    this.update({
      phase: 'blocked',
      session: null,
      connectivityEpochId: null,
      message,
    });
    const cleared = await this.clearStoredSession();
    if (credentialGeneration !== this.credentialGeneration) {
      return;
    }
    if (cleared) {
      this.cleanupConfirmedSessionId = null;
    }
    this.update({
      phase: cleared ? 'signed-out' : 'blocked',
      session: null,
      connectivityEpochId: null,
      message: cleared
        ? message
        : 'PSD EOC could not clear secure device storage. Access remains blocked; contact district technology support.',
    });
  }
}
