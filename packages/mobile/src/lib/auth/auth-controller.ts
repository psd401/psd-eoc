import {
  IdempotencyKeySchema,
  type MobileSessionResponse,
  type SessionEstablishmentResult,
} from '@psd-eoc/contracts';

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
  readonly connectivityEpochId: string | null;
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

export interface AuthenticatedRequestInput {
  readonly operation: 'query' | 'mutation';
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export type MobileAuthenticatedRequest = (
  input: AuthenticatedRequestInput,
) => Promise<Response>;

export type AuthenticatedFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type AuthenticatedRequestTransport = (
  bearer: string,
  input: AuthenticatedRequestInput,
) => Promise<Response>;

export interface AuthTimer {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export interface MobileAuthControllerDependencies {
  readonly api: SessionApi;
  readonly authenticatedRequest: AuthenticatedRequestTransport;
  readonly createIdempotencyKey: () => string;
  readonly localAuthenticator: LocalAuthenticator;
  readonly now?: () => Date;
  readonly storage: AuthStorage;
  readonly timer?: AuthTimer;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function validatedAuthenticatedRequest(
  input: AuthenticatedRequestInput,
): AuthenticatedRequestInput {
  if (
    !input.path.startsWith('/') ||
    input.path.startsWith('//') ||
    hasAsciiControlCharacter(input.path) ||
    input.path.includes('#')
  ) {
    throw new TypeError('Authenticated requests require an app-relative path.');
  }
  const parsedPath = new URL(input.path, 'https://psd-eoc.invalid');
  if (
    parsedPath.origin !== 'https://psd-eoc.invalid' ||
    parsedPath.username.length > 0 ||
    parsedPath.password.length > 0
  ) {
    throw new TypeError('Authenticated requests require an app-relative path.');
  }
  if (input.method === 'GET' && input.body !== undefined) {
    throw new TypeError('Authenticated GET requests cannot carry a body.');
  }
  if (input.method === 'GET' && input.idempotencyKey !== undefined) {
    throw new TypeError(
      'Authenticated GET requests cannot carry mutation metadata.',
    );
  }
  if (input.method === 'POST' && input.body === undefined) {
    throw new TypeError('Authenticated POST requests require a JSON body.');
  }
  if (input.operation === 'mutation') {
    if (input.method !== 'POST') {
      throw new TypeError('Authenticated mutations require POST.');
    }
    IdempotencyKeySchema.parse(input.idempotencyKey ?? '');
  } else if (input.idempotencyKey !== undefined) {
    throw new TypeError(
      'Authenticated queries cannot carry mutation metadata.',
    );
  }
  return Object.freeze({ ...input });
}

/**
 * Builds the only bearer-aware network adapter used by mobile UI code. The
 * caller supplies app-relative paths, while this closure resolves them against
 * the already-validated PSD EOC origin and injects the credential privately.
 */
export function createAuthenticatedRequestTransport(
  getApiOrigin: () => string,
  fetchImplementation: AuthenticatedFetch = fetch,
): AuthenticatedRequestTransport {
  return async (bearer, rawInput) => {
    const input = validatedAuthenticatedRequest(rawInput);
    const configuredValue = getApiOrigin();
    const configured = new URL(configuredValue);
    if (
      configured.origin !== configuredValue ||
      configured.pathname !== '/' ||
      configured.search.length > 0 ||
      configured.hash.length > 0 ||
      configured.username.length > 0 ||
      configured.password.length > 0
    ) {
      throw new TypeError('The PSD EOC API origin is invalid.');
    }
    const target = new URL(input.path, `${configured.origin}/`);
    if (target.origin !== configured.origin) {
      throw new TypeError(
        'Authenticated requests require an app-relative path.',
      );
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
      'Cache-Control': 'no-store',
    };
    if (input.method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    if (input.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = input.idempotencyKey;
    }
    return fetchImplementation(target.toString(), {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  };
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

/**
 * Pure session lifecycle. Native modules are injected, making every safety
 * transition independently testable without a simulator or live provider.
 */
export class MobileAuthController {
  private state: AuthState = initialState;
  private readonly listeners = new Set<AuthListener>();
  private vault: StoredAuthVault | null = null;
  private refreshAbortController: AbortController | null = null;
  private lifecycleGeneration = 0;
  private credentialGeneration = 0;
  private credentialOperationTail: Promise<void> = Promise.resolve();
  private unlockPromise: Promise<void> | null = null;
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
    this.refreshAbortController?.abort();
    this.refreshAbortController = null;
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
    connectivityEpochId: string;
  }> {
    if (
      this.state.phase !== 'online' ||
      this.state.connectivityEpochId === null ||
      this.state.session === null
    ) {
      throw new OfflineMutationDeniedError();
    }
    if (!locallyUsableSession(this.state.session, this.now())) {
      void this.expireSession();
      throw new OfflineMutationDeniedError();
    }
    return Object.freeze({
      connectivityEpochId: this.state.connectivityEpochId,
    });
  }

  /**
   * Performs one online request without returning the bearer to React state or
   * the caller. Mutations fail before transport whenever connectivity has not
   * been freshly established, so no offline action can be queued for replay.
   */
  public authenticatedRequest: MobileAuthenticatedRequest = (rawInput) => {
    const input = validatedAuthenticatedRequest(rawInput);
    this.assertMutationAllowed();
    const vault = this.vault;
    if (vault === null) {
      throw new OfflineMutationDeniedError();
    }
    return this.dependencies.authenticatedRequest(vault.refreshToken, input);
  };

  public async signOut(): Promise<void> {
    const current = this.vault;
    const shouldRevoke = current !== null && this.state.phase === 'online';
    await this.clearAndSignOut(null);
    if (shouldRevoke) {
      try {
        await this.dependencies.api.revoke(
          current.refreshToken,
          current.session.session.id,
          this.dependencies.createIdempotencyKey(),
        );
      } catch {
        // Local sign-out is intentionally final. Remote revocation is not queued.
      }
    }
  }

  private async clearAndSignOut(message: string | null): Promise<void> {
    const credentialGeneration = this.invalidateCredentials();
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
