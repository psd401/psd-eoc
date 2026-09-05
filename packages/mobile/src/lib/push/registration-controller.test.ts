import { describe, expect, test } from 'bun:test';
import {
  PushTokenRegistrationReceiptSchema,
  PushTokenUnregistrationReceiptSchema,
  type RegisterPushTokenInput,
  type UnregisterPushTokenInput,
} from '@psd-eoc/contracts';

import {
  pushRegistrationFailureMessage,
  PushRegistrationController,
  parsePushRegistrationConfiguration,
  type NativePushToken,
  type PushNativePort,
  type PushPermissionStatus,
  type PushRegistrationSession,
} from './registration-controller';

const DEVICE_ID = '00000000-0000-4000-8000-000000002321';
const PROJECT_ID = '00000000-0000-4000-8000-000000002322';
const BUILD = Object.freeze({
  applicationId: 'example.synthetic.eoc',
  applicationVersion: '1.0.4',
  nativeBuildVersion: '7',
  expoProjectId: PROJECT_ID,
  updateMode: 'embedded-only' as const,
});
const OTHER_DEVICE_ID = '00000000-0000-4000-8000-000000002323';
const NATIVE_TOKEN = Object.freeze({
  type: 'ios',
  data: 'synthetic-apns-token',
});
const EXPO_TOKEN = 'ExponentPushToken[synthetic-issue-23-device]';

class NativePort implements PushNativePort {
  public prepareCalls = 0;
  public permissionChecks = 0;
  public permissionRequests = 0;
  public deviceTokenCalls = 0;
  public expoInputs: Array<{
    projectId: string;
    devicePushToken: NativePushToken;
    serviceEnvironment: 'development' | 'production';
  }> = [];
  public settingsCalls = 0;
  public listener: ((token: NativePushToken) => Promise<void>) | null = null;
  public failPrepare = false;
  public alertChannelMuted = false;

  public constructor(public permission: PushPermissionStatus) {}

  public async prepare(): Promise<void> {
    this.prepareCalls += 1;
    if (this.failPrepare) throw new Error('local safety setup failed');
  }
  public async getPermissionStatus(): Promise<PushPermissionStatus> {
    this.permissionChecks += 1;
    return this.permission;
  }
  public async isAlertChannelMuted(): Promise<boolean> {
    return this.alertChannelMuted;
  }
  public async requestPermission(): Promise<PushPermissionStatus> {
    this.permissionRequests += 1;
    return this.permission;
  }
  public async getDevicePushToken(): Promise<NativePushToken> {
    this.deviceTokenCalls += 1;
    return NATIVE_TOKEN;
  }
  public async getServiceEnvironment(): Promise<'production'> {
    return 'production';
  }
  public async getExpoPushToken(input: {
    projectId: string;
    devicePushToken: NativePushToken;
    serviceEnvironment: 'development' | 'production';
    signal: AbortSignal;
  }): Promise<string> {
    this.expoInputs.push({
      projectId: input.projectId,
      devicePushToken: input.devicePushToken,
      serviceEnvironment: input.serviceEnvironment,
    });
    return EXPO_TOKEN;
  }
  public addPushTokenListener(
    listener: (token: NativePushToken) => Promise<void>,
  ) {
    this.listener = listener;
    return { remove: () => (this.listener = null) };
  }
  public async openSettings(): Promise<void> {
    this.settingsCalls += 1;
  }
}

function session() {
  const registrations: RegisterPushTokenInput[] = [];
  const unregistrations: UnregisterPushTokenInput[] = [];
  const binding: PushRegistrationSession = {
    deviceEnrollmentId: DEVICE_ID,
    platform: 'ios',
    isActive: () => true,
    async register(input) {
      registrations.push(input);
      return PushTokenRegistrationReceiptSchema.parse({
        deviceEnrollmentId: DEVICE_ID,
        platform: 'ios',
        provider: input.provider,
        serviceEnvironment: input.serviceEnvironment,
        status: 'registered',
      });
    },
    async unregister(input) {
      unregistrations.push(input);
      return PushTokenUnregistrationReceiptSchema.parse({
        deviceEnrollmentId: DEVICE_ID,
        status: 'unregistered',
      });
    },
  };
  return { binding, registrations, unregistrations };
}

function enabledController(native: NativePort) {
  return new PushRegistrationController({
    configuration: { enabled: true, projectId: PROJECT_ID, build: BUILD },
    native,
  });
}

describe('push registration controller', () => {
  test('requires an exact explicit opt-in and valid project identity', () => {
    expect(
      parsePushRegistrationConfiguration('true', PROJECT_ID, BUILD),
    ).toEqual({ enabled: true, projectId: PROJECT_ID, build: BUILD });
    expect(
      parsePushRegistrationConfiguration(undefined, PROJECT_ID, BUILD),
    ).toEqual({ enabled: false, projectId: PROJECT_ID, build: BUILD });
    expect(
      parsePushRegistrationConfiguration('TRUE', PROJECT_ID, BUILD).enabled,
    ).toBe(false);
    expect(
      parsePushRegistrationConfiguration('true', 'not-a-project', BUILD),
    ).toEqual({ enabled: false, projectId: null, build: null });
    expect(parsePushRegistrationConfiguration('true', PROJECT_ID)).toEqual({
      enabled: false,
      projectId: PROJECT_ID,
      build: null,
    });
  });

  test('disabled development and CI builds never request permission or contact Expo', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    const controller = new PushRegistrationController({
      configuration: { enabled: false, projectId: PROJECT_ID, build: BUILD },
      native,
    });

    await controller.start();
    await controller.reconcile(currentSession.binding);
    await controller.requestPermission();

    expect(native.prepareCalls).toBe(1);
    expect(native.permissionChecks).toBe(0);
    expect(native.permissionRequests).toBe(0);
    expect(native.deviceTokenCalls).toBe(0);
    expect(native.expoInputs).toEqual([]);
    expect(currentSession.registrations).toEqual([]);
    expect(currentSession.unregistrations).toEqual([
      { deviceEnrollmentId: DEVICE_ID },
    ]);
    expect(controller.getSnapshot().phase).toBe('provider-disabled');
  });

  test('enabled builds never contact Expo when the local safety boundary fails', async () => {
    const native = new NativePort('granted');
    native.failPrepare = true;
    const currentSession = session();
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(currentSession.binding);

    expect(native.permissionChecks).toBe(0);
    expect(native.permissionRequests).toBe(0);
    expect(native.deviceTokenCalls).toBe(0);
    expect(native.expoInputs).toEqual([]);
    expect(currentSession.registrations).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('safety boundary'),
    });
  });

  test('retry reruns transient local safety setup before registration', async () => {
    const native = new NativePort('granted');
    native.failPrepare = true;
    const currentSession = session();
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(currentSession.binding);
    native.failPrepare = false;
    await controller.retry();

    expect(native.prepareCalls).toBe(2);
    expect(currentSession.registrations).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe('registered');
  });

  test('registers native APNs and Expo fallback only after explanation and permission', async () => {
    const native = new NativePort('undetermined');
    const currentSession = session();
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(currentSession.binding);
    expect(controller.getSnapshot().phase).toBe('explanation-required');
    expect(native.permissionRequests).toBe(0);
    expect(native.expoInputs).toEqual([]);

    native.permission = 'granted';
    await controller.requestPermission();
    expect(native.permissionRequests).toBe(1);
    expect(native.expoInputs).toEqual([
      {
        projectId: PROJECT_ID,
        devicePushToken: NATIVE_TOKEN,
        serviceEnvironment: 'production',
      },
    ]);
    expect(currentSession.registrations).toEqual([
      {
        deviceEnrollmentId: DEVICE_ID,
        platform: 'ios',
        provider: 'apns',
        serviceEnvironment: 'production',
        build: BUILD,
        token: NATIVE_TOKEN.data,
        expoFallbackToken: EXPO_TOKEN,
      },
    ]);
    expect(controller.getSnapshot()).toEqual({
      phase: 'registered',
      platform: 'ios',
      message: null,
      alertsMuted: false,
    });
  });

  test('does not lose registration when the iOS permission prompt makes the app inactive', async () => {
    const native = new NativePort('undetermined');
    const currentSession = session();
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(currentSession.binding);
    native.permission = 'granted';

    // AppState inactive is a transient system interruption, not a true
    // background/auth close. The lifecycle must therefore leave the active
    // controller session intact while the permission promise settles.
    const request = controller.requestPermission();
    await request;

    expect(currentSession.registrations).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe('registered');
  });

  test('converts and registers the listener-provided native token after rotation', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    const controller = enabledController(native);
    await controller.start();
    await controller.reconcile(currentSession.binding);
    const rotated = { type: 'ios', data: 'synthetic-rotated-apns-token' };

    expect(native.listener).not.toBeNull();
    await native.listener?.(rotated);

    expect(native.deviceTokenCalls).toBe(1);
    expect(currentSession.registrations).toHaveLength(2);
    expect(native.expoInputs.at(-1)).toEqual({
      projectId: PROJECT_ID,
      devicePushToken: rotated,
      serviceEnvironment: 'production',
    });
    expect(currentSession.registrations.at(-1)).toEqual(
      expect.objectContaining({
        provider: 'apns',
        token: rotated.data,
        expoFallbackToken: EXPO_TOKEN,
      }),
    );
  });

  test('aborts in-flight Expo acquisition when authenticated auth goes offline', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    const observed: { signal: AbortSignal | null } = { signal: null };
    native.getExpoPushToken = (input) => {
      observed.signal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(new Error('synthetic provider request aborted')),
          { once: true },
        );
      });
    };
    const controller = enabledController(native);

    await controller.start();
    const registration = controller.reconcile(currentSession.binding);
    for (let turn = 0; turn < 10 && observed.signal === null; turn += 1) {
      await Promise.resolve();
    }
    expect(observed.signal?.aborted).toBeFalse();

    controller.suspendSession();
    await registration;

    expect(observed.signal?.aborted).toBeTrue();
    expect(currentSession.registrations).toEqual([]);
    expect(controller.getSnapshot()).toEqual({
      phase: 'idle',
      platform: null,
      message: null,
      alertsMuted: false,
    });
  });

  test('synchronously fences an in-flight Expo exchange when live auth closes', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    let active = true;
    const observed: { signal: AbortSignal | null } = { signal: null };
    native.getExpoPushToken = (input) => {
      observed.signal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(new Error('synthetic provider request aborted')),
          { once: true },
        );
      });
    };
    const binding: PushRegistrationSession = {
      ...currentSession.binding,
      isActive: () => active,
    };
    const controller = enabledController(native);

    await controller.start();
    const registration = controller.reconcile(binding);
    for (let turn = 0; turn < 10 && observed.signal === null; turn += 1) {
      await Promise.resolve();
    }
    expect(observed.signal?.aborted).toBeFalse();

    active = false;
    controller.fenceInactiveSession();
    await registration;

    expect(observed.signal?.aborted).toBeTrue();
    expect(currentSession.registrations).toEqual([]);
    expect(controller.getSnapshot()).toEqual({
      phase: 'idle',
      platform: null,
      message: null,
      alertsMuted: false,
    });
  });

  test('retains denied recovery and retries uncertain cleanup after offline auth returns', async () => {
    const native = new NativePort('denied');
    const currentSession = session();
    let cleanupAttempts = 0;
    const controllerRef: { current: PushRegistrationController | null } = {
      current: null,
    };
    const reconnectingSession: PushRegistrationSession = {
      ...currentSession.binding,
      async unregister(input) {
        currentSession.unregistrations.push(input);
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          // Mirrors requestAuthenticated moving auth to offline-cached before
          // rejecting the cleanup request and the lifecycle fencing session.
          controllerRef.current?.suspendSession();
          throw new Error('synthetic offline cleanup failure');
        }
        return PushTokenUnregistrationReceiptSchema.parse({
          deviceEnrollmentId: DEVICE_ID,
          status: 'unregistered',
        });
      },
    };
    const controller = enabledController(native);
    controllerRef.current = controller;

    await controller.start();
    await controller.reconcile(reconnectingSession);
    const uncertainDenied = controller.getSnapshot();
    expect(uncertainDenied).toMatchObject({
      phase: 'denied',
      platform: 'ios',
      message: expect.stringContaining('could not confirm push cleanup'),
    });

    expect(controller.getSnapshot()).toEqual(uncertainDenied);
    await native.listener?.({ type: 'ios', data: 'synthetic-offline-token' });
    expect(native.expoInputs).toEqual([]);

    await controller.reconcile(reconnectingSession);
    expect(currentSession.unregistrations).toEqual([
      { deviceEnrollmentId: DEVICE_ID },
      { deviceEnrollmentId: DEVICE_ID },
    ]);
    expect(controller.getSnapshot()).toEqual({
      phase: 'denied',
      platform: 'ios',
      message: null,
      alertsMuted: false,
    });
  });

  test('retries disabled cleanup after offline auth without provider contact', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    let cleanupAttempts = 0;
    const controllerRef: { current: PushRegistrationController | null } = {
      current: null,
    };
    const reconnectingSession: PushRegistrationSession = {
      ...currentSession.binding,
      async unregister(input) {
        currentSession.unregistrations.push(input);
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          controllerRef.current?.suspendSession();
          throw new Error('synthetic offline cleanup failure');
        }
        return PushTokenUnregistrationReceiptSchema.parse({
          deviceEnrollmentId: DEVICE_ID,
          status: 'unregistered',
        });
      },
    };
    const controller = new PushRegistrationController({
      configuration: { enabled: false, projectId: PROJECT_ID, build: BUILD },
      native,
    });
    controllerRef.current = controller;

    await controller.start();
    await controller.reconcile(reconnectingSession);
    const uncertainDisabled = controller.getSnapshot();
    expect(uncertainDisabled).toMatchObject({
      phase: 'provider-disabled',
      message: expect.stringContaining('could not confirm cleanup'),
    });

    expect(controller.getSnapshot()).toEqual(uncertainDisabled);
    await native.listener?.({ type: 'ios', data: 'synthetic-disabled-token' });
    await controller.reconcile(reconnectingSession);

    expect(native.permissionChecks).toBe(0);
    expect(native.permissionRequests).toBe(0);
    expect(native.deviceTokenCalls).toBe(0);
    expect(native.expoInputs).toEqual([]);
    expect(currentSession.unregistrations).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'provider-disabled',
      message: expect.stringContaining(
        'No notification provider was contacted',
      ),
    });
  });

  test('denial unregisters the endpoint without acquiring or converting a token', async () => {
    const native = new NativePort('denied');
    const currentSession = session();
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(currentSession.binding);

    expect(currentSession.unregistrations).toEqual([
      { deviceEnrollmentId: DEVICE_ID },
    ]);
    expect(native.deviceTokenCalls).toBe(0);
    expect(native.expoInputs).toEqual([]);
    expect(controller.getSnapshot().phase).toBe('denied');
  });

  test('rejects malformed or wrong-platform native tokens before Expo sees them', async () => {
    const native = new NativePort('granted');
    native.getDevicePushToken = async () => ({
      type: 'android',
      data: 'synthetic-fcm-token',
    });
    const currentSession = session();
    const controller = enabledController(native);
    await controller.start();
    await controller.reconcile(currentSession.binding);

    expect(native.expoInputs).toEqual([]);
    expect(currentSession.registrations).toEqual([]);
    expect(controller.getSnapshot().phase).toBe('error');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      'synthetic-fcm-token',
    );
  });

  test('rejects a schema-valid registration receipt for another device', async () => {
    const native = new NativePort('granted');
    const currentSession = session();
    const mismatchedSession: PushRegistrationSession = {
      ...currentSession.binding,
      async register(input) {
        currentSession.registrations.push(input);
        return PushTokenRegistrationReceiptSchema.parse({
          deviceEnrollmentId: OTHER_DEVICE_ID,
          platform: 'ios',
          provider: input.provider,
          serviceEnvironment: input.serviceEnvironment,
          status: 'registered',
        });
      },
    };
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(mismatchedSession);

    expect(currentSession.registrations).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('inconsistent'),
    });
  });

  test('clears prior cleanup evidence before an uncertain atomic mutation', async () => {
    const native = new NativePort('denied');
    const currentSession = session();
    const uncertainSession: PushRegistrationSession = {
      ...currentSession.binding,
      async register(input) {
        currentSession.registrations.push(input);
        throw new Error('synthetic uncertain registration');
      },
    };
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(uncertainSession);
    expect(currentSession.unregistrations).toHaveLength(1);

    native.permission = 'granted';
    await controller.retry();
    expect(currentSession.registrations).toHaveLength(1);

    native.permission = 'denied';
    await controller.retry();
    expect(currentSession.unregistrations).toHaveLength(2);
  });

  test('does not confirm cleanup from another device receipt', async () => {
    const native = new NativePort('denied');
    const currentSession = session();
    const mismatchedSession: PushRegistrationSession = {
      ...currentSession.binding,
      async unregister(input) {
        currentSession.unregistrations.push(input);
        return PushTokenUnregistrationReceiptSchema.parse({
          deviceEnrollmentId: OTHER_DEVICE_ID,
          status: 'unregistered',
        });
      },
    };
    const controller = enabledController(native);

    await controller.start();
    await controller.reconcile(mismatchedSession);

    expect(currentSession.unregistrations).toEqual([
      { deviceEnrollmentId: DEVICE_ID },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'denied',
      message: expect.stringContaining('could not confirm push cleanup'),
    });
  });
});

describe('push registration failure messages', () => {
  test('names the step that failed', () => {
    expect(
      pushRegistrationFailureMessage('expo-token', new Error('network down')),
    ).toContain('Expo did not issue a push token');
    expect(
      pushRegistrationFailureMessage('server', new Error('401')),
    ).toContain('did not accept');
    expect(
      pushRegistrationFailureMessage('service-environment', null),
    ).toContain('which push environment');
  });

  test('repeats a bounded provider message', () => {
    expect(
      pushRegistrationFailureMessage('server', new Error('refused upstream')),
    ).toContain('refused upstream');
    const long = 'x'.repeat(400);
    const rendered = pushRegistrationFailureMessage(
      'expo-token',
      new Error(long),
    );
    expect(rendered.length).toBeLessThan(300);
  });

  test('reports which field a schema refused, never its value', () => {
    // The refused field is almost always the token, which is a credential.
    const rendered = pushRegistrationFailureMessage('assemble', {
      issues: [{ path: ['expoFallbackToken'] }, { path: ['token'] }],
    });
    expect(rendered).toContain('expoFallbackToken');
    expect(rendered).toContain('token');
    expect(rendered).not.toContain('ExponentPushToken');
  });

  test('still says something when the error carries nothing', () => {
    expect(pushRegistrationFailureMessage('assemble', {})).toContain(
      'cannot accept',
    );
    expect(pushRegistrationFailureMessage('server', new Error('  '))).toContain(
      'did not accept',
    );
  });
});
