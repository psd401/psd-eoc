const EXPO_PUSH_TOKEN_URL =
  'https://exp.host/--/api/v2/push/getExpoPushToken' as const;
const EXPO_PUSH_TOKEN_TIMEOUT_MS = 8_000;
const EXPO_PUSH_TOKEN_PATTERN =
  /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,4064}\]$/u;

interface ExpoPushTokenRequest {
  readonly applicationId: string;
  readonly development: boolean;
  readonly deviceId: string;
  readonly devicePushToken: Readonly<{
    readonly data: string;
    readonly type: 'android' | 'ios';
  }>;
  readonly projectId: string;
  readonly signal: AbortSignal;
}

type ExpoTokenFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>;

interface ExpoTokenTimer {
  readonly schedule: (
    callback: () => void,
    delayMilliseconds: number,
  ) => unknown;
  readonly cancel: (handle: unknown) => void;
}

const defaultTimer: ExpoTokenTimer = Object.freeze({
  schedule: (callback: () => void, delayMilliseconds: number) =>
    globalThis.setTimeout(callback, delayMilliseconds),
  cancel: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function boundedIdentity(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512;
}

function expoTokenFrom(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const data = Reflect.get(value, 'data');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const token = Reflect.get(data, 'expoPushToken');
  return typeof token === 'string' && EXPO_PUSH_TOKEN_PATTERN.test(token)
    ? token
    : null;
}

async function fetchValidatedToken(
  input: ExpoPushTokenRequest,
  signal: AbortSignal,
  fetchToken: ExpoTokenFetch,
): Promise<string> {
  let response: Pick<Response, 'json' | 'ok' | 'status'>;
  try {
    response = await fetchToken(EXPO_PUSH_TOKEN_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: input.devicePushToken.type === 'ios' ? 'apns' : 'fcm',
        deviceId: input.deviceId.toLowerCase(),
        development: input.development,
        appId: input.applicationId,
        deviceToken: input.devicePushToken.data,
        projectId: input.projectId,
      }),
    });
  } catch {
    throw new Error('Expo push-token request failed.');
  }
  if (!response.ok) {
    throw new Error(
      `Expo push-token request failed with status ${response.status}.`,
    );
  }

  let token: string | null;
  try {
    token = expoTokenFrom(await response.json());
  } catch {
    throw new Error('Expo push-token response was invalid.');
  }
  if (token === null) {
    throw new Error('Expo push-token response was invalid.');
  }
  return token;
}

/**
 * Performs one explicit, non-persisting Expo token exchange. The controller is
 * the only caller and invokes this after build opt-in, auth, permission, and
 * native-token validation. Provider responses are never reflected in errors.
 */
export async function requestExplicitExpoPushToken(
  input: ExpoPushTokenRequest,
  fetchToken: ExpoTokenFetch = globalThis.fetch,
  timer: ExpoTokenTimer = defaultTimer,
): Promise<string> {
  if (
    !boundedIdentity(input.applicationId) ||
    !boundedIdentity(input.deviceId) ||
    !boundedIdentity(input.projectId) ||
    input.devicePushToken.data.length === 0 ||
    input.devicePushToken.data.length > 16_384
  ) {
    throw new Error('Expo push-token request identity is invalid.');
  }
  if (input.signal.aborted) {
    throw new Error('Expo push-token request was cancelled.');
  }

  const controller = new AbortController();
  let interruption: 'caller' | 'timeout' | null = null;
  let interrupt: (failure: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  const abortFromCaller = () => {
    if (interruption !== null) return;
    interruption = 'caller';
    const failure = new Error('Expo push-token request was cancelled.');
    interrupt(failure);
    controller.abort(failure);
  };
  input.signal.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = timer.schedule(() => {
    if (interruption !== null) return;
    interruption = 'timeout';
    const failure = new Error('Expo push-token request timed out.');
    interrupt(failure);
    controller.abort(failure);
  }, EXPO_PUSH_TOKEN_TIMEOUT_MS);

  try {
    return await Promise.race([
      fetchValidatedToken(input, controller.signal, fetchToken),
      interrupted,
    ]);
  } finally {
    timer.cancel(timeout);
    input.signal.removeEventListener('abort', abortFromCaller);
  }
}
