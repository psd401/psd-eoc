import { describe, expect, test } from 'bun:test';

import type { MobileSessionResponse } from '@psd-eoc/contracts';

import {
  AuthenticatedApiError,
  AuthenticatedRequestFailure,
  type AuthenticatedRequestOptions,
  type AuthenticatedRequestTransport,
} from '../api';
import {
  MobileAuthController,
  type AuthStorage,
  type AuthTimer,
  type LocalAuthenticator,
  type SessionApi,
  type StoredAuthVault,
} from './auth-controller';
import { MobileAuthError, OfflineMutationDeniedError } from './auth-errors';
import {
  sessionFixture,
  TEST_NEXT_TOKEN,
  TEST_NOW,
  TEST_TOKEN,
} from './auth-test-fixtures';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeStorage implements AuthStorage {
  public clearCount = 0;
  public readCount = 0;
  public writes: StoredAuthVault[] = [];
  public failEnrollmentRead = false;
  public failClear = false;
  public failWrite = false;
  public failWriteAfterPersist = false;
  public beforeWrite: ((vault: StoredAuthVault) => Promise<void>) | null = null;

  public constructor(public vault: StoredAuthVault | null) {}

  public async getOrCreateInstallationId(): Promise<string> {
    return 'synthetic-installation-0001';
  }

  public async hasEnrollment(): Promise<boolean> {
    if (this.failEnrollmentRead) {
      throw new Error('unavailable');
    }
    return this.vault !== null;
  }

  public async readVault(): Promise<StoredAuthVault | null> {
    this.readCount += 1;
    return this.vault;
  }

  public async writeVault(vault: StoredAuthVault): Promise<void> {
    if (this.failWrite) {
      throw new Error('write failed');
    }
    await this.beforeWrite?.(vault);
    this.vault = vault;
    if (this.failWriteAfterPersist) {
      throw new Error('write failed after partial persistence');
    }
    this.writes.push(vault);
  }

  public async clearSession(): Promise<void> {
    this.clearCount += 1;
    if (this.failClear) {
      throw new Error('clear failed');
    }
    this.vault = null;
  }
}

class FakeTimer implements AuthTimer {
  private nextHandle = 1;
  private readonly scheduled = new Map<
    number,
    Readonly<{ callback: () => void; delayMilliseconds: number }>
  >();

  public schedule(callback: () => void, delayMilliseconds: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.set(handle, { callback, delayMilliseconds });
    return handle;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === 'number') {
      this.scheduled.delete(handle);
    }
  }

  public latestDelay(): number {
    const latest = [...this.scheduled.values()].at(-1);
    if (latest === undefined) {
      throw new Error('No expiry timer is scheduled.');
    }
    return latest.delayMilliseconds;
  }

  public fireLatest(): void {
    const latest = [...this.scheduled.entries()].at(-1);
    if (latest === undefined) {
      throw new Error('No expiry timer is scheduled.');
    }
    this.scheduled.delete(latest[0]);
    latest[1].callback();
  }
}

const inertTimer: AuthTimer = Object.freeze({
  schedule: () => 1,
  cancel: () => {},
});

function storedVault(): StoredAuthVault {
  return {
    refreshToken: TEST_TOKEN,
    pendingRefreshIdempotencyKey: null,
    session: sessionFixture(),
  };
}

function successfulPayload(): MobileSessionResponse {
  return {
    refreshToken: TEST_NEXT_TOKEN,
    tokenType: 'Bearer',
    session: sessionFixture('00000000-0000-4000-8000-000000000006'),
  };
}

function controller(
  storage: FakeStorage,
  api: SessionApi,
  authenticate: LocalAuthenticator['authenticate'] = async () => ({
    success: true as const,
  }),
  overrides: Readonly<{
    authenticatedApi?: AuthenticatedRequestTransport;
    createIdempotencyKey?: () => string;
    now?: () => Date;
    timer?: AuthTimer;
  }> = {},
) {
  return new MobileAuthController({
    storage,
    api,
    ...(overrides.authenticatedApi === undefined
      ? {}
      : { authenticatedApi: overrides.authenticatedApi }),
    localAuthenticator: { authenticate },
    createIdempotencyKey:
      overrides.createIdempotencyKey ??
      (() => 'mobile-refresh-idempotency-0001'),
    now: overrides.now ?? (() => TEST_NOW),
    timer: overrides.timer ?? inertTimer,
  });
}

const stringSchema = Object.freeze({
  parse(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('invalid synthetic response');
    }
    return value;
  },
});

function pendingAuthenticatedRequest() {
  const started = deferred<void>();
  const result = deferred<unknown>();
  let capturedBearer: string | null = null;
  let capturedSignal: AbortSignal | null = null;
  const api: AuthenticatedRequestTransport = {
    async request<Output>(
      bearer: string,
      request: AuthenticatedRequestOptions<Output>,
      signal: AbortSignal,
    ): Promise<Output> {
      capturedBearer = bearer;
      capturedSignal = signal;
      started.resolve();
      return request.schema.parse(await result.promise);
    },
  };
  return {
    api,
    started: started.promise,
    resolve: result.resolve,
    bearer(): string {
      if (capturedBearer === null) {
        throw new Error('No authenticated request has started.');
      }
      return capturedBearer;
    },
    signal(): AbortSignal {
      if (capturedSignal === null) {
        throw new Error('No authenticated request has started.');
      }
      return capturedSignal;
    },
  };
}

const authenticatedGet = Object.freeze({
  method: 'GET' as const,
  path: '/api/events/synthetic-event',
  schema: stringSchema,
});

describe('mobile auth controller', () => {
  test('makes the cached shell available under three seconds without waiting on refresh', async () => {
    const storage = new FakeStorage(storedVault());
    const refresh = deferred<MobileSessionResponse>();
    const api: SessionApi = {
      refresh: () => refresh.promise,
      revoke: async () => {},
    };
    const auth = controller(storage, api);
    await auth.bootstrap();
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(storage.readCount).toBe(0);

    const startedAt = performance.now();
    const cachedShellBeforeDeadline = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('Cached shell missed the three-second deadline.'));
      }, 3_000);
      const unsubscribe = auth.subscribe(() => {
        if (auth.getSnapshot().phase === 'cached-checking') {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
    const foreground = auth.foreground();
    await cachedShellBeforeDeadline;
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    expect(storage.readCount).toBe(1);
    expect(auth.getSnapshot().phase).toBe('cached-checking');
    expect(auth.getSnapshot().connectivityEpochId).toBeNull();

    refresh.reject(new MobileAuthError('offline', 'unreachable'));
    await foreground;
    expect(auth.getSnapshot().phase).toBe('offline-cached');
  });

  test('retains the same bearer and idempotency key after an uncertain refresh', async () => {
    const storage = new FakeStorage(storedVault());
    const calls: Array<{ token: string; key: string }> = [];
    let offline = true;
    const api: SessionApi = {
      async refresh(token, key) {
        calls.push({ token, key });
        if (offline) {
          throw new MobileAuthError('offline', 'unreachable');
        }
        return successfulPayload();
      },
      revoke: async () => {},
    };
    const auth = controller(storage, api);
    await auth.bootstrap();
    await auth.foreground();
    expect(storage.vault?.pendingRefreshIdempotencyKey).toBe(
      'mobile-refresh-idempotency-0001',
    );
    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );

    offline = false;
    await auth.retryConnection();
    expect(calls).toEqual([
      { token: TEST_TOKEN, key: 'mobile-refresh-idempotency-0001' },
      { token: TEST_TOKEN, key: 'mobile-refresh-idempotency-0001' },
    ]);
    expect(storage.vault?.refreshToken).toBe(TEST_NEXT_TOKEN);
    expect(storage.vault?.pendingRefreshIdempotencyKey).toBeNull();
    expect(auth.assertMutationAllowed()).toEqual({
      connectivityEpochId: '00000000-0000-4000-8000-000000000006',
      userId: sessionFixture().user.id,
      sessionId: sessionFixture().session.id,
      deviceEnrollmentId: sessionFixture().deviceEnrollment.id,
    });
  });

  test('clears a server-revoked device when the next foreground refresh is rejected as 401 or 403', async () => {
    const storage = new FakeStorage(storedVault());
    let refreshCount = 0;
    const auth = controller(storage, {
      refresh: async () => {
        refreshCount += 1;
        throw new MobileAuthError('rejected', 'revoked');
      },
      revoke: async () => {},
    });
    await auth.bootstrap();
    await auth.foreground();
    expect(refreshCount).toBe(1);
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(auth.getSnapshot().session).toBeNull();
    expect(storage.clearCount).toBe(1);
    expect(storage.vault).toBeNull();
  });

  test('sign-out blocks app access but preserves the credential until cleanup finishes', async () => {
    const storage = new FakeStorage(null);
    const revoke = deferred<void>();
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: () => revoke.promise,
    });
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    const signingOut = auth.signOut();
    await flush();
    expect(auth.getSnapshot()).toMatchObject({
      phase: 'locked',
      session: null,
      connectivityEpochId: null,
    });
    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    revoke.resolve();
    await signingOut;
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(storage.vault).toBeNull();
  });

  test('failed server cleanup leaves the online credential and push lifecycle intact', async () => {
    const storage = new FakeStorage(null);
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {
        throw new MobileAuthError('offline', 'unreachable');
      },
    });
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    await expect(auth.signOut()).rejects.toBeInstanceOf(MobileAuthError);
    expect(auth.getSnapshot().phase).toBe('online');
    expect(auth.getSnapshot().message).toContain('not completed');
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(storage.clearCount).toBe(0);
  });

  test('reuses the exact revocation key after a lost response', async () => {
    const storage = new FakeStorage(null);
    const revocations: Array<{
      token: string;
      sessionId: string;
      idempotencyKey: string;
    }> = [];
    let keyCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        async revoke(token, sessionId, idempotencyKey) {
          revocations.push({ token, sessionId, idempotencyKey });
          if (revocations.length === 1) {
            throw new MobileAuthError('offline', 'response lost');
          }
        },
      },
      undefined,
      {
        createIdempotencyKey: () => {
          keyCount += 1;
          return `mobile-revocation-idempotency-${String(keyCount).padStart(4, '0')}`;
        },
      },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    await expect(auth.signOut()).rejects.toBeInstanceOf(MobileAuthError);
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    await auth.signOut();

    expect(keyCount).toBe(1);
    expect(revocations).toEqual([
      {
        token: TEST_TOKEN,
        sessionId: sessionFixture().session.id,
        idempotencyKey: 'mobile-revocation-idempotency-0001',
      },
      {
        token: TEST_TOKEN,
        sessionId: sessionFixture().session.id,
        idempotencyKey: 'mobile-revocation-idempotency-0001',
      },
    ]);
    expect(storage.vault).toBeNull();
    expect(auth.getSnapshot().phase).toBe('signed-out');
  });

  test('failed cleanup during refresh stays locked until a fresh authenticated recovery', async () => {
    const storage = new FakeStorage(storedVault());
    const refreshStarted = deferred<void>();
    const refresh = deferred<MobileSessionResponse>();
    let refreshSignal: AbortSignal | null = null;
    const capturedRefreshSignal = (): AbortSignal => {
      if (refreshSignal === null) throw new Error('Refresh did not start.');
      return refreshSignal;
    };
    const auth = controller(storage, {
      refresh: (_token, _key, signal) => {
        refreshSignal = signal;
        refreshStarted.resolve();
        return refresh.promise;
      },
      revoke: async () => {
        throw new MobileAuthError('offline', 'unreachable');
      },
    });
    await auth.bootstrap();
    const foreground = auth.foreground();
    await refreshStarted.promise;

    await expect(auth.signOut()).rejects.toBeInstanceOf(MobileAuthError);
    expect(capturedRefreshSignal().aborted).toBe(true);
    expect(auth.getSnapshot()).toMatchObject({
      phase: 'locked',
      session: null,
      connectivityEpochId: null,
    });
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(storage.clearCount).toBe(0);

    refresh.resolve(successfulPayload());
    await foreground;
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(
      storage.writes.some((vault) => vault.refreshToken === TEST_NEXT_TOKEN),
    ).toBe(false);
  });

  test('locked sign-out authenticates before reading, revoking, and clearing', async () => {
    const storage = new FakeStorage(storedVault());
    const calls: Array<{ token: string; sessionId: string }> = [];
    let authenticationCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        async revoke(token, sessionId) {
          calls.push({ token, sessionId });
        },
      },
      async () => {
        authenticationCount += 1;
        return { success: true };
      },
    );
    await auth.bootstrap();

    await auth.signOut();

    expect(authenticationCount).toBe(1);
    expect(storage.readCount).toBe(1);
    expect(calls).toEqual([
      { token: TEST_TOKEN, sessionId: sessionFixture().session.id },
    ]);
    expect(storage.vault).toBeNull();
    expect(auth.getSnapshot().phase).toBe('signed-out');
  });

  test('locked sign-out denial preserves enrollment without server cleanup', async () => {
    const storage = new FakeStorage(storedVault());
    let revokeCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {
          revokeCount += 1;
        },
      },
      async () => ({
        success: false,
        message: 'Device security was cancelled.',
      }),
    );
    await auth.bootstrap();

    await expect(auth.signOut()).rejects.toBeInstanceOf(MobileAuthError);

    expect(revokeCount).toBe(0);
    expect(storage.readCount).toBe(0);
    expect(storage.clearCount).toBe(0);
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(auth.getSnapshot().phase).toBe('locked');
  });

  test('a pending SecureStore write cannot resurrect credentials after sign-out', async () => {
    const storage = new FakeStorage(storedVault());
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    storage.beforeWrite = async (vault) => {
      if (vault.pendingRefreshIdempotencyKey !== null) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
    };
    let refreshCount = 0;
    const auth = controller(storage, {
      refresh: async () => {
        refreshCount += 1;
        return successfulPayload();
      },
      revoke: async () => {},
    });
    await auth.bootstrap();
    const foreground = auth.foreground();
    await writeStarted.promise;

    const signingOut = auth.signOut();
    releaseWrite.resolve();
    await Promise.all([foreground, signingOut]);
    await flush();

    expect(refreshCount).toBe(0);
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(storage.vault).toBeNull();
    expect(storage.clearCount).toBe(1);
  });

  test('a late refresh response cannot rewrite credentials after sign-out', async () => {
    const storage = new FakeStorage(storedVault());
    const refreshStarted = deferred<void>();
    const refresh = deferred<MobileSessionResponse>();
    const revoke = deferred<void>();
    let refreshSignal: AbortSignal | null = null;
    const capturedRefreshSignal = (): AbortSignal => {
      if (refreshSignal === null) throw new Error('Refresh did not start.');
      return refreshSignal;
    };
    const auth = controller(storage, {
      refresh: (_token, _key, signal) => {
        refreshSignal = signal;
        refreshStarted.resolve();
        return refresh.promise;
      },
      revoke: () => revoke.promise,
    });
    await auth.bootstrap();
    const foreground = auth.foreground();
    await refreshStarted.promise;

    const signingOut = auth.signOut();
    await flush();
    expect(capturedRefreshSignal().aborted).toBe(true);
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(storage.vault).not.toBeNull();
    revoke.resolve();
    await signingOut;
    expect(storage.vault).toBeNull();
    refresh.resolve(successfulPayload());
    await foreground;
    await flush();

    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(storage.vault).toBeNull();
    expect(
      storage.writes.some((vault) => vault.refreshToken === TEST_NEXT_TOKEN),
    ).toBe(false);
  });

  test('persists a safe completed rotation after background without unlocking memory', async () => {
    const storage = new FakeStorage(storedVault());
    const refreshStarted = deferred<void>();
    const refresh = deferred<MobileSessionResponse>();
    const auth = controller(storage, {
      refresh: () => {
        refreshStarted.resolve();
        return refresh.promise;
      },
      revoke: async () => {},
    });
    await auth.bootstrap();
    const foreground = auth.foreground();
    await refreshStarted.promise;

    auth.background();
    refresh.resolve(successfulPayload());
    await foreground;

    expect(storage.vault?.refreshToken).toBe(TEST_NEXT_TOKEN);
    expect(storage.vault?.pendingRefreshIdempotencyKey).toBeNull();
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(auth.getSnapshot().session).toBeNull();
    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );
  });

  test('background during enrollment persists only encrypted state and requires a fresh unlock', async () => {
    const storage = new FakeStorage(null);
    const firstAuthentication = deferred<Readonly<{ success: true }>>();
    let authenticationCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {},
      },
      () => {
        authenticationCount += 1;
        return authenticationCount === 1
          ? firstAuthentication.promise
          : Promise.resolve({ success: true as const });
      },
    );
    await auth.bootstrap();
    const enrolling = auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    expect(authenticationCount).toBe(1);

    auth.background();
    firstAuthentication.resolve({ success: true });
    expect(await enrolling).toBe(true);
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(auth.getSnapshot().session).toBeNull();
    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );

    await auth.foreground();
    expect(authenticationCount).toBe(2);
    expect(auth.getSnapshot().phase).toBe('online');
  });

  test('cached authorization ages out at the earlier membership grace deadline while foregrounded', async () => {
    const storage = new FakeStorage(storedVault());
    const timer = new FakeTimer();
    let currentTime = TEST_NOW;
    const auth = controller(
      storage,
      {
        refresh: async () => {
          throw new MobileAuthError('offline', 'unreachable');
        },
        revoke: async () => {},
      },
      undefined,
      { now: () => currentTime, timer },
    );
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('offline-cached');

    const graceDeadline = Date.parse(
      sessionFixture().session.authorization.membershipGraceUntil,
    );
    expect(timer.latestDelay()).toBe(graceDeadline - TEST_NOW.getTime());
    currentTime = new Date(graceDeadline);
    timer.fireLatest();
    await flush();
    await flush();

    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(auth.getSnapshot().session).toBeNull();
    expect(storage.vault).toBeNull();
  });

  test('mutation guard rechecks local time and hides an expired online shell immediately', async () => {
    const storage = new FakeStorage(null);
    const timer = new FakeTimer();
    let currentTime = TEST_NOW;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {},
      },
      undefined,
      { now: () => currentTime, timer },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    currentTime = new Date(
      Date.parse(sessionFixture().session.authorization.membershipGraceUntil),
    );

    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );
    expect(auth.getSnapshot().phase).toBe('blocked');
    expect(auth.getSnapshot().session).toBeNull();
    await flush();
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(storage.vault).toBeNull();
  });

  test('fails closed when pending refresh state cannot be secured', async () => {
    const storage = new FakeStorage(storedVault());
    storage.failWrite = true;
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {},
    });
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('blocked');
    expect(auth.getSnapshot().connectivityEpochId).toBeNull();
  });

  test('background preserves a secure-storage blocked state', async () => {
    const storage = new FakeStorage(null);
    storage.failEnrollmentRead = true;
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {},
    });
    await auth.bootstrap();
    expect(auth.getSnapshot().phase).toBe('blocked');
    auth.background();
    expect(auth.getSnapshot().phase).toBe('blocked');
  });

  test('retries only local clearing after server cleanup was already confirmed', async () => {
    const storage = new FakeStorage(null);
    let revokeCount = 0;
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {
        revokeCount += 1;
      },
    });
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    storage.failClear = true;
    await auth.signOut();
    expect(auth.getSnapshot().phase).toBe('blocked');
    expect(auth.getSnapshot().connectivityEpochId).toBeNull();
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(revokeCount).toBe(1);

    storage.failClear = false;
    await auth.signOut();

    expect(revokeCount).toBe(1);
    expect(storage.clearCount).toBe(2);
    expect(storage.vault).toBeNull();
    expect(auth.getSnapshot().phase).toBe('signed-out');
  });

  test('blocked recovery authenticates and revokes a retained unrevoked vault before clearing', async () => {
    const storage = new FakeStorage(storedVault());
    storage.failWrite = true;
    const revocations: Array<{
      token: string;
      sessionId: string;
      key: string;
    }> = [];
    let authenticationCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async (token, sessionId, key) => {
          expect(storage.clearCount).toBe(0);
          revocations.push({ token, sessionId, key });
        },
      },
      async () => {
        authenticationCount += 1;
        return { success: true };
      },
    );
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('blocked');

    await auth.signOut();

    expect(authenticationCount).toBe(2);
    expect(storage.readCount).toBe(2);
    expect(revocations).toEqual([
      {
        token: TEST_TOKEN,
        sessionId: sessionFixture().session.id,
        key: 'mobile-refresh-idempotency-0001',
      },
    ]);
    expect(storage.clearCount).toBe(1);
    expect(storage.vault).toBeNull();
    expect(auth.getSnapshot().phase).toBe('signed-out');
  });

  test('blocked recovery never clears an unrevoked retained vault when cleanup fails', async () => {
    const storage = new FakeStorage(storedVault());
    storage.failWrite = true;
    let revokeCount = 0;
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {
        revokeCount += 1;
        throw new MobileAuthError('offline', 'unreachable');
      },
    });
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('blocked');

    await expect(auth.signOut()).rejects.toBeInstanceOf(MobileAuthError);

    expect(revokeCount).toBe(1);
    expect(storage.clearCount).toBe(0);
    expect(storage.vault?.refreshToken).toBe(TEST_TOKEN);
    expect(auth.getSnapshot().phase).toBe('locked');
  });

  test('keeps the device locked when local authentication rejects unexpectedly', async () => {
    const storage = new FakeStorage(storedVault());
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {},
      },
      async () => {
        throw new Error('native module rejected');
      },
    );
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(auth.getSnapshot().message).toContain('remains locked');
    expect(storage.readCount).toBe(0);
  });

  test('revokes and clears a just-issued session when device authentication is denied', async () => {
    const storage = new FakeStorage(null);
    let revokeCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {
          revokeCount += 1;
          throw new MobileAuthError('offline', 'unreachable');
        },
      },
      async () => ({
        success: false,
        message: 'PSD EOC remains locked.',
      }),
    );
    const enrolled = await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    expect(enrolled).toBe(false);
    expect(storage.clearCount).toBe(1);
    expect(revokeCount).toBe(1);
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(auth.getSnapshot().message).toContain('administrator');
  });

  test('clears and revokes a just-issued session when enrollment authentication rejects', async () => {
    const storage = new FakeStorage(null);
    let revokeCount = 0;
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {
          revokeCount += 1;
        },
      },
      async () => {
        throw new Error('native module rejected');
      },
    );
    const enrolled = await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    expect(enrolled).toBe(false);
    expect(storage.vault).toBeNull();
    expect(storage.clearCount).toBe(1);
    expect(revokeCount).toBe(1);
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(auth.getSnapshot().message).toContain('could not be verified');
  });

  test('clears partial storage and revokes when enrollment persistence fails', async () => {
    const storage = new FakeStorage(null);
    storage.failWriteAfterPersist = true;
    let revokeCount = 0;
    const auth = controller(storage, {
      refresh: async () => successfulPayload(),
      revoke: async () => {
        revokeCount += 1;
      },
    });
    const enrolled = await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    expect(enrolled).toBe(false);
    expect(storage.vault).toBeNull();
    expect(storage.clearCount).toBe(1);
    expect(revokeCount).toBe(1);
    expect(auth.getSnapshot().phase).toBe('signed-out');
  });

  test('keeps the bearer private while returning only caller-schema output', async () => {
    const pending = pendingAuthenticatedRequest();
    const storage = new FakeStorage(null);
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: async () => {},
      },
      undefined,
      { authenticatedApi: pending.api },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    const requesting = auth.requestAuthenticated(authenticatedGet);
    await pending.started;
    expect(pending.bearer()).toBe(TEST_TOKEN);
    expect(JSON.stringify(auth.getSnapshot())).not.toContain(TEST_TOKEN);
    pending.resolve('schema output');
    await expect(requesting).resolves.toBe('schema output');
  });

  test('requires a fresh online session to mutate, but still reads', async () => {
    const storage = new FakeStorage(storedVault());
    let requestCount = 0;
    const authenticatedApi: AuthenticatedRequestTransport = {
      async request<Output>(
        _bearer: string,
        request: AuthenticatedRequestOptions<Output>,
      ): Promise<Output> {
        requestCount += 1;
        return request.schema.parse('unexpected');
      },
    };
    const auth = controller(
      storage,
      {
        refresh: async () => {
          throw new MobileAuthError('offline', 'unreachable');
        },
        revoke: async () => {},
      },
      undefined,
      { authenticatedApi },
    );
    await auth.bootstrap();
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('offline-cached');

    // A read is attempted. It previously threw here before any request was
    // made, which is why the event room's timeline silently stopped updating
    // whenever the app was not strictly online with a live connectivity epoch:
    // nothing reached the server, so nothing explained it, and the room told
    // the operator that updates were not arriving during an emergency.
    await auth.requestAuthenticated(authenticatedGet).catch(() => undefined);
    expect(requestCount).toBe(1);

    // A mutation still requires the online session that gives it provenance
    // and idempotency, and is still refused without one.
    await expect(
      auth.requestAuthenticated({
        method: 'POST',
        path: '/api/events/synthetic-event/journal',
        idempotencyKey: 'synthetic-post-key-0001',
        body: { text: 'Synthetic update' },
        schema: stringSchema,
      }),
    ).rejects.toBeInstanceOf(OfflineMutationDeniedError);
    expect(requestCount).toBe(1);
  });

  test('aborts in-flight feature requests when the app backgrounds', async () => {
    const pending = pendingAuthenticatedRequest();
    const auth = controller(
      new FakeStorage(null),
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      { authenticatedApi: pending.api },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    const requesting = auth.requestAuthenticated(authenticatedGet);
    await pending.started;

    auth.background();
    expect(pending.signal().aborted).toBe(true);
    pending.resolve('late response');
    await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
    expect(auth.getSnapshot().phase).toBe('locked');
  });

  test('aborts in-flight feature requests on sign-out', async () => {
    const pending = pendingAuthenticatedRequest();
    const storage = new FakeStorage(null);
    const revoke = deferred<void>();
    const auth = controller(
      storage,
      {
        refresh: async () => successfulPayload(),
        revoke: () => revoke.promise,
      },
      undefined,
      { authenticatedApi: pending.api },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    const requesting = auth.requestAuthenticated(authenticatedGet);
    await pending.started;

    const signingOut = auth.signOut();
    await flush();
    expect(pending.signal().aborted).toBe(true);
    expect(auth.getSnapshot().phase).toBe('locked');
    await expect(
      auth.requestAuthenticated(authenticatedGet),
    ).rejects.toBeInstanceOf(OfflineMutationDeniedError);
    revoke.resolve();
    await signingOut;
    pending.resolve('late response');
    await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.vault).toBeNull();
  });

  test('aborts in-flight feature requests when the bearer rotates', async () => {
    const pending = pendingAuthenticatedRequest();
    const auth = controller(
      new FakeStorage(null),
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      { authenticatedApi: pending.api },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    const requesting = auth.requestAuthenticated(authenticatedGet);
    await pending.started;

    await auth.enroll({
      refreshToken: TEST_NEXT_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture('00000000-0000-4000-8000-000000000006'),
    });
    expect(pending.signal().aborted).toBe(true);
    pending.resolve('late response');
    await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('aborts in-flight feature requests when local authorization expires', async () => {
    const pending = pendingAuthenticatedRequest();
    const timer = new FakeTimer();
    let currentTime = TEST_NOW;
    const storage = new FakeStorage(null);
    const auth = controller(
      storage,
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      {
        authenticatedApi: pending.api,
        now: () => currentTime,
        timer,
      },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    const requesting = auth.requestAuthenticated(authenticatedGet);
    await pending.started;

    currentTime = new Date(
      Date.parse(sessionFixture().session.authorization.membershipGraceUntil),
    );
    timer.fireLatest();
    expect(pending.signal().aborted).toBe(true);
    pending.resolve('late response');
    await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(storage.vault).toBeNull();
  });

  test('links caller cancellation without exposing the internal lifecycle signal', async () => {
    const pending = pendingAuthenticatedRequest();
    const auth = controller(
      new FakeStorage(null),
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      { authenticatedApi: pending.api },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });
    const caller = new AbortController();
    const requesting = auth.requestAuthenticated({
      ...authenticatedGet,
      signal: caller.signal,
    });
    await pending.started;
    expect(pending.signal()).not.toBe(caller.signal);

    caller.abort();
    expect(pending.signal().aborted).toBe(true);
    pending.resolve('late response');
    await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
    expect(auth.getSnapshot().phase).toBe('online');
  });

  test('fails closed to cached offline state after a feature network failure', async () => {
    const networkFailure = new AuthenticatedRequestFailure(
      'network',
      'Synthetic bounded network failure.',
    );
    const authenticatedApi: AuthenticatedRequestTransport = {
      async request(): Promise<never> {
        throw networkFailure;
      },
    };
    const auth = controller(
      new FakeStorage(null),
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      { authenticatedApi },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    await expect(auth.requestAuthenticated(authenticatedGet)).rejects.toBe(
      networkFailure,
    );
    expect(auth.getSnapshot().phase).toBe('offline-cached');
    expect(auth.getSnapshot().connectivityEpochId).toBeNull();
    expect(() => auth.assertMutationAllowed()).toThrow(
      OfflineMutationDeniedError,
    );
  });

  test('clears a rejected bearer after a canonical 401 feature response', async () => {
    const apiFailure = new AuthenticatedApiError(
      {
        code: 'UNAUTHENTICATED',
        message: 'The synthetic device session was rejected.',
        requestId: '00000000-0000-4000-8000-000000000007',
        retryable: false,
        fieldErrors: [],
      },
      401,
    );
    const authenticatedApi: AuthenticatedRequestTransport = {
      async request(): Promise<never> {
        throw apiFailure;
      },
    };
    const storage = new FakeStorage(null);
    const auth = controller(
      storage,
      { refresh: async () => successfulPayload(), revoke: async () => {} },
      undefined,
      { authenticatedApi },
    );
    await auth.enroll({
      refreshToken: TEST_TOKEN,
      tokenType: 'Bearer',
      session: sessionFixture(),
    });

    await expect(auth.requestAuthenticated(authenticatedGet)).rejects.toBe(
      apiFailure,
    );
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(auth.getSnapshot().session).toBeNull();
    expect(storage.vault).toBeNull();
  });
});
