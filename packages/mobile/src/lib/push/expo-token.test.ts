import { describe, expect, test } from 'bun:test';

import { requestExplicitExpoPushToken } from './expo-token';

const PROJECT_ID = '00000000-0000-4000-8000-000000002322';
const EXPO_TOKEN = 'ExponentPushToken[synthetic-issue-23-device]';

describe('explicit Expo push-token request', () => {
  test('uses the fixed endpoint and bounded provider request', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const timeoutHandle = Object.freeze({ kind: 'synthetic-timeout' });
    const timerObservation: { cancelled: unknown; delay: number | null } = {
      cancelled: null,
      delay: null,
    };
    const token = await requestExplicitExpoPushToken(
      {
        applicationId: 'invalid.example.eoc',
        development: true,
        deviceId: 'SYNTHETIC-INSTALLATION-ID',
        devicePushToken: { type: 'ios', data: 'synthetic-apns-token' },
        projectId: PROJECT_ID,
        signal: new AbortController().signal,
      },
      async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({ data: { expoPushToken: EXPO_TOKEN } }),
          { status: 200 },
        );
      },
      {
        schedule(_callback, delayMilliseconds) {
          timerObservation.delay = delayMilliseconds;
          return timeoutHandle;
        },
        cancel(handle) {
          timerObservation.cancelled = handle;
        },
      },
    );

    expect(token).toBe(EXPO_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      'https://exp.host/--/api/v2/push/getExpoPushToken',
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(timerObservation.delay).toBe(8_000);
    expect(timerObservation.cancelled).toBe(timeoutHandle);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: 'apns',
      deviceId: 'synthetic-installation-id',
      development: true,
      appId: 'invalid.example.eoc',
      deviceToken: 'synthetic-apns-token',
      projectId: PROJECT_ID,
    });
  });

  test('rejects untrusted responses without reflecting token material', async () => {
    const secretLikeResponse = 'synthetic-secret-provider-response';
    let error: unknown;
    try {
      await requestExplicitExpoPushToken(
        {
          applicationId: 'invalid.example.eoc',
          development: false,
          deviceId: 'synthetic-installation-id',
          devicePushToken: { type: 'android', data: 'synthetic-fcm-token' },
          projectId: PROJECT_ID,
          signal: new AbortController().signal,
        },
        async () =>
          new Response(
            JSON.stringify({
              data: { expoPushToken: secretLikeResponse },
            }),
            { status: 200 },
          ),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secretLikeResponse);
  });

  test('aborts a hanging provider exchange at the fixed deadline', async () => {
    const caller = new AbortController();
    const timeoutHandle = Object.freeze({ kind: 'synthetic-timeout' });
    const observation: {
      cancelled: unknown;
      deadline: (() => void) | null;
      signal: AbortSignal | null;
    } = { cancelled: null, deadline: null, signal: null };
    const request = requestExplicitExpoPushToken(
      {
        applicationId: 'invalid.example.eoc',
        development: false,
        deviceId: 'synthetic-installation-id',
        devicePushToken: { type: 'android', data: 'synthetic-fcm-token' },
        projectId: PROJECT_ID,
        signal: caller.signal,
      },
      (_input, init) => {
        observation.signal = init.signal as AbortSignal;
        return new Promise(() => {});
      },
      {
        schedule(callback, delayMilliseconds) {
          expect(delayMilliseconds).toBe(8_000);
          observation.deadline = callback;
          return timeoutHandle;
        },
        cancel(handle) {
          observation.cancelled = handle;
        },
      },
    );

    expect(observation.signal?.aborted).toBeFalse();
    if (observation.deadline === null) {
      throw new Error('Expected an Expo token deadline.');
    }
    observation.deadline();

    await expect(request).rejects.toThrow('timed out');
    expect(observation.signal?.aborted).toBeTrue();
    expect(observation.cancelled).toBe(timeoutHandle);
  });

  test('links caller cancellation without reflecting its reason', async () => {
    const caller = new AbortController();
    const secretReason = 'ExponentPushToken[synthetic-caller-secret]';
    const observation: { signal: AbortSignal | null } = { signal: null };
    let timerCancelled = false;
    const request = requestExplicitExpoPushToken(
      {
        applicationId: 'invalid.example.eoc',
        development: false,
        deviceId: 'synthetic-installation-id',
        devicePushToken: { type: 'android', data: 'synthetic-fcm-token' },
        projectId: PROJECT_ID,
        signal: caller.signal,
      },
      (_input, init) => {
        observation.signal = init.signal as AbortSignal;
        return new Promise(() => {});
      },
      {
        schedule() {
          return 'synthetic-timeout-handle';
        },
        cancel() {
          timerCancelled = true;
        },
      },
    );

    caller.abort(new Error(secretReason));
    let error: unknown;
    try {
      await request;
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('cancelled');
    expect(String(error)).not.toContain(secretReason);
    expect(observation.signal?.aborted).toBeTrue();
    expect(timerCancelled).toBeTrue();
  });

  test('does not contact Expo for an already-cancelled request', async () => {
    const caller = new AbortController();
    caller.abort();
    let fetchCalls = 0;

    await expect(
      requestExplicitExpoPushToken(
        {
          applicationId: 'invalid.example.eoc',
          development: false,
          deviceId: 'synthetic-installation-id',
          devicePushToken: { type: 'android', data: 'synthetic-fcm-token' },
          projectId: PROJECT_ID,
          signal: caller.signal,
        },
        async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      ),
    ).rejects.toThrow('cancelled');
    expect(fetchCalls).toBe(0);
  });
});
