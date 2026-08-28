import {
  NativePushBuildIdentitySchema,
  RegisterPushTokenInputSchema,
  UuidSchema,
  type NativePushBuildIdentity,
  type PushTokenRegistrationReceipt,
  type PushTokenUnregistrationReceipt,
  type PushServiceEnvironment,
  type RegisterPushTokenInput,
  type UnregisterPushTokenInput,
} from '@psd-eoc/contracts';

type PushRegistrationStage =
  | 'assemble'
  | 'expo-token'
  | 'server'
  | 'service-environment';

/** At most this much of a provider or transport error is repeated back. */
const FAILURE_DETAIL_LIMIT = 160;

function failureDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim().replace(/\s+/gu, ' ');
  if (message.length === 0) return null;
  return message.length > FAILURE_DETAIL_LIMIT
    ? `${message.slice(0, FAILURE_DETAIL_LIMIT)}\u2026`
    : message;
}

/**
 * Names which step of registration failed, and why when that is knowable.
 *
 * A push token is a credential, so nothing here repeats the registration
 * itself. The assembly stage reports only which field a schema refused, never
 * the value it held; the other stages repeat a bounded provider or transport
 * message, which carries no token.
 */
export function pushRegistrationFailureMessage(
  stage: PushRegistrationStage,
  error: unknown,
): string {
  if (stage === 'assemble') {
    const issues = (
      error as { issues?: readonly { path?: readonly unknown[] }[] }
    ).issues;
    const fields = Array.isArray(issues)
      ? [
          ...new Set(
            issues.flatMap((issue) =>
              typeof issue.path?.[0] === 'string' ? [issue.path[0]] : [],
            ),
          ),
        ]
      : [];
    return fields.length > 0
      ? `This device assembled a push registration PSD EOC cannot accept (${fields.join(', ')}). Contact District Technology.`
      : 'This device assembled a push registration PSD EOC cannot accept. Contact District Technology.';
  }
  const detail = failureDetail(error);
  const suffix = detail === null ? '' : ` ${detail}`;
  if (stage === 'service-environment') {
    return `This device could not report which push environment it runs in. Reconnect and try again.${suffix}`;
  }
  if (stage === 'expo-token') {
    return `Expo did not issue a push token for this build. Reconnect and try again.${suffix}`;
  }
  return `PSD EOC did not accept this device\u2019s push registration. Reconnect and try again.${suffix}`;
}

export type PushPermissionStatus = 'denied' | 'granted' | 'undetermined';
export type NativePushPlatform = 'android' | 'ios';

export interface NativePushToken {
  readonly data: unknown;
  readonly type: string;
}

export interface PushSubscription {
  remove(): void;
}

export interface PushNativePort {
  prepare(): Promise<void>;
  getPermissionStatus(): Promise<PushPermissionStatus>;
  requestPermission(): Promise<PushPermissionStatus>;
  getDevicePushToken(): Promise<NativePushToken>;
  getServiceEnvironment(
    platform: NativePushPlatform,
  ): Promise<PushServiceEnvironment>;
  getExpoPushToken(
    input: Readonly<{
      projectId: string;
      devicePushToken: NativePushToken;
      serviceEnvironment: PushServiceEnvironment;
      signal: AbortSignal;
    }>,
  ): Promise<string>;
  addPushTokenListener(
    listener: (token: NativePushToken) => Promise<void>,
  ): PushSubscription;
  openSettings(): Promise<void>;
}

export interface PushRegistrationSession {
  readonly deviceEnrollmentId: string;
  readonly platform: NativePushPlatform;
  /** Reads authoritative auth state synchronously; never a React snapshot. */
  isActive(): boolean;
  register(
    input: RegisterPushTokenInput,
  ): Promise<PushTokenRegistrationReceipt>;
  unregister(
    input: UnregisterPushTokenInput,
  ): Promise<PushTokenUnregistrationReceipt>;
}

export type PushRegistrationPhase =
  | 'denied'
  | 'error'
  | 'explanation-required'
  | 'idle'
  | 'provider-disabled'
  | 'registered'
  | 'registering';

export interface PushRegistrationSnapshot {
  readonly message: string | null;
  readonly phase: PushRegistrationPhase;
  readonly platform: NativePushPlatform | null;
}

export interface PushRegistrationConfiguration {
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly build: NativePushBuildIdentity | null;
}

interface PushRegistrationControllerDependencies {
  readonly configuration: PushRegistrationConfiguration;
  readonly native: PushNativePort;
}

const IDLE_SNAPSHOT: PushRegistrationSnapshot = Object.freeze({
  phase: 'idle',
  platform: null,
  message: null,
});
const DENIED_CLEANUP_UNCONFIRMED_MESSAGE =
  'Notifications are disabled, and PSD EOC could not confirm push cleanup. Reconnect and retry before relying on the stale-endpoint report.';
const DISABLED_CLEANUP_UNCONFIRMED_MESSAGE =
  'Push registration is disabled, but PSD EOC could not confirm cleanup of an earlier endpoint. Reconnect and retry.';

type PushRegistrationListener = () => void;

/** Exact opt-in prevents ordinary development and CI from contacting Expo. */
export function parsePushRegistrationConfiguration(
  enabledValue: string | undefined,
  projectIdValue: unknown,
  buildIdentityValue?: unknown,
): PushRegistrationConfiguration {
  const parsedProjectId = UuidSchema.safeParse(projectIdValue);
  const parsedBuild =
    NativePushBuildIdentitySchema.safeParse(buildIdentityValue);
  const identityMatchesProject =
    parsedProjectId.success &&
    parsedBuild.success &&
    parsedBuild.data.expoProjectId === parsedProjectId.data;
  return Object.freeze({
    enabled: enabledValue === 'true' && identityMatchesProject,
    projectId: parsedProjectId.success ? parsedProjectId.data : null,
    build: identityMatchesProject ? parsedBuild.data : null,
  });
}

/**
 * Serializes native token acquisition and authenticated registry mutations.
 * Neither snapshots nor error messages ever retain provider or device tokens.
 */
export class PushRegistrationController {
  private snapshot: PushRegistrationSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<PushRegistrationListener>();
  private session: PushRegistrationSession | null = null;
  private generation = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private tokenSubscription: PushSubscription | null = null;
  private permissionStatus: PushPermissionStatus | null = null;
  private unregisteredSessionId: string | null = null;
  private providerRequestAbortController: AbortController | null = null;
  private running = false;
  private prepared = false;

  public constructor(
    private readonly dependencies: PushRegistrationControllerDependencies,
  ) {}

  public getSnapshot = (): PushRegistrationSnapshot => this.snapshot;

  public subscribe = (listener: PushRegistrationListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public start(): Promise<void> {
    this.running = true;
    this.prepared = false;
    return this.enqueue(async () => {
      try {
        // Always clear Expo's persisted automatic server registration before
        // checking the explicit opt-in. This keeps disabled builds fail closed.
        await this.dependencies.native.prepare();
        if (!this.running) return;
        this.tokenSubscription ??=
          this.dependencies.native.addPushTokenListener((token) =>
            this.handleNativeTokenRefresh(token),
          );
        this.prepared = true;
      } catch {
        this.prepared = false;
        if (!this.running) return;
        this.update({
          phase: 'error',
          platform: this.session?.platform ?? null,
          message:
            'PSD EOC could not establish the local notification safety boundary.',
        });
      }
    });
  }

  public stop(): void {
    this.running = false;
    this.prepared = false;
    this.generation += 1;
    this.session = null;
    this.permissionStatus = null;
    this.abortProviderRequest();
    this.tokenSubscription?.remove();
    this.tokenSubscription = null;
    this.update(IDLE_SNAPSHOT);
  }

  public clearSession(): void {
    this.generation += 1;
    this.session = null;
    this.permissionStatus = null;
    this.abortProviderRequest();
    this.unregisteredSessionId = null;
    this.update(IDLE_SNAPSHOT);
  }

  /**
   * Fences authenticated work while retaining actionable denied/disabled UI
   * through a temporary offline-cached auth state. A later online reconcile
   * rechecks permission and retries any cleanup that was not confirmed.
   */
  public suspendSession(): void {
    this.generation += 1;
    this.session = null;
    this.permissionStatus = null;
    this.abortProviderRequest();
    if (
      this.snapshot.phase !== 'denied' &&
      this.snapshot.phase !== 'provider-disabled'
    ) {
      this.update(IDLE_SNAPSHOT);
    }
  }

  /**
   * Called directly by the auth-state subscription because React effects may
   * be suspended after backgrounding or while sign-out closes the session.
   */
  public fenceInactiveSession(): void {
    const session = this.session;
    if (session !== null && !this.sessionIsActive(session)) {
      this.suspendSession();
    }
  }

  public reconcile(session: PushRegistrationSession): Promise<void> {
    const generation = ++this.generation;
    this.abortProviderRequest();
    this.session = session;
    return this.enqueue(() => this.reconcileCurrent(generation, session));
  }

  public requestPermission(): Promise<void> {
    const session = this.session;
    if (session === null) return Promise.resolve();
    const generation = ++this.generation;
    this.abortProviderRequest();
    return this.enqueue(async () => {
      if (!this.isCurrent(generation, session)) return;
      if (!this.configurationReady()) {
        await this.markProviderDisabled(generation, session);
        return;
      }
      if (!this.prepared) {
        this.failCurrent(
          generation,
          session,
          'PSD EOC could not establish the local notification safety boundary.',
        );
        return;
      }
      let permission: PushPermissionStatus;
      try {
        permission = await this.dependencies.native.requestPermission();
      } catch {
        this.failCurrent(
          generation,
          session,
          'PSD EOC could not open notification permission. Try again.',
        );
        return;
      }
      if (!this.isCurrent(generation, session)) return;
      this.permissionStatus = permission;
      if (permission !== 'granted') {
        await this.markDenied(generation, session);
        return;
      }
      await this.registerInitialToken(generation, session);
    });
  }

  public async retry(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    if (!this.prepared) {
      await this.start();
      if (this.session !== session) return;
    }
    await this.reconcile(session);
  }

  public async openSettings(): Promise<void> {
    try {
      await this.dependencies.native.openSettings();
    } catch {
      const current = this.session;
      this.update({
        phase: 'error',
        platform: current?.platform ?? null,
        message:
          'PSD EOC could not open system settings. Open this app in device Settings and enable Notifications.',
      });
    }
  }

  public handleNativeTokenRefresh(token: NativePushToken): Promise<void> {
    const session = this.session;
    if (
      session === null ||
      this.permissionStatus !== 'granted' ||
      !this.configurationReady() ||
      !this.prepared
    ) {
      return Promise.resolve();
    }
    const generation = this.generation;
    return this.enqueue(() =>
      this.registerNativeToken(generation, session, token),
    );
  }

  private get configuration(): PushRegistrationConfiguration {
    return this.dependencies.configuration;
  }

  private configurationReady(): boolean {
    return (
      this.configuration.enabled &&
      this.configuration.projectId !== null &&
      this.configuration.build !== null
    );
  }

  private async reconcileCurrent(
    generation: number,
    session: PushRegistrationSession,
  ): Promise<void> {
    if (!this.isCurrent(generation, session)) return;
    if (!this.configurationReady()) {
      await this.markProviderDisabled(generation, session);
      return;
    }
    if (!this.prepared) {
      this.failCurrent(
        generation,
        session,
        'PSD EOC could not establish the local notification safety boundary.',
      );
      return;
    }
    let permission: PushPermissionStatus;
    try {
      permission = await this.dependencies.native.getPermissionStatus();
    } catch {
      this.failCurrent(
        generation,
        session,
        'PSD EOC could not check notification readiness. Try again.',
      );
      return;
    }
    if (!this.isCurrent(generation, session)) return;
    this.permissionStatus = permission;
    if (permission === 'undetermined') {
      this.update({
        phase: 'explanation-required',
        platform: session.platform,
        message: null,
      });
      return;
    }
    if (permission === 'denied') {
      await this.markDenied(generation, session);
      return;
    }
    await this.registerInitialToken(generation, session);
  }

  private async registerInitialToken(
    generation: number,
    session: PushRegistrationSession,
  ): Promise<void> {
    this.update({
      phase: 'registering',
      platform: session.platform,
      message: null,
    });
    let nativeToken: NativePushToken;
    try {
      nativeToken = await this.dependencies.native.getDevicePushToken();
    } catch {
      this.failCurrent(
        generation,
        session,
        'PSD EOC could not prepare this device for push alerts. Reconnect and try again.',
      );
      return;
    }
    await this.registerNativeToken(generation, session, nativeToken);
  }

  private async registerNativeToken(
    generation: number,
    session: PushRegistrationSession,
    nativeToken: NativePushToken,
  ): Promise<void> {
    if (!this.isCurrent(generation, session)) return;
    const { build, projectId } = this.configuration;
    if (!this.configuration.enabled || projectId === null || build === null) {
      await this.markProviderDisabled(generation, session);
      return;
    }
    if (!this.prepared) {
      this.failCurrent(
        generation,
        session,
        'PSD EOC could not establish the local notification safety boundary.',
      );
      return;
    }
    if (
      nativeToken.type !== session.platform ||
      typeof nativeToken.data !== 'string' ||
      nativeToken.data.length === 0 ||
      nativeToken.data.length > 16_384
    ) {
      this.failCurrent(
        generation,
        session,
        'PSD EOC rejected an invalid native push-token response.',
      );
      return;
    }
    const providerRequest = new AbortController();
    this.providerRequestAbortController?.abort();
    this.providerRequestAbortController = providerRequest;
    // Four separate things can fail here and they need four different
    // responses. The catch used to discard the error and say only that
    // registration was not confirmed, so a device that could not register
    // reported the same sentence whether Expo was unreachable, the build
    // assembled an invalid registration, or the server refused it.
    let stage: PushRegistrationStage = 'service-environment';
    try {
      const serviceEnvironment =
        await this.dependencies.native.getServiceEnvironment(session.platform);
      stage = 'expo-token';
      const expoToken = await this.dependencies.native.getExpoPushToken({
        projectId,
        devicePushToken: nativeToken,
        serviceEnvironment,
        signal: providerRequest.signal,
      });
      if (!this.isCurrent(generation, session)) return;
      const nativeProvider = session.platform === 'ios' ? 'apns' : 'fcm';
      stage = 'assemble';
      const generationInput = RegisterPushTokenInputSchema.parse({
        deviceEnrollmentId: session.deviceEnrollmentId,
        platform: session.platform,
        provider: nativeProvider,
        serviceEnvironment,
        build,
        token: nativeToken.data,
        expoFallbackToken: expoToken,
      });
      // A failed or uncertain mutation must make the next disabled/denied
      // reconciliation retry cleanup instead of trusting an older marker.
      this.unregisteredSessionId = null;
      stage = 'server';
      const nativeReceipt = await session.register(generationInput);
      if (!this.isCurrent(generation, session)) return;
      if (
        nativeReceipt.deviceEnrollmentId !== session.deviceEnrollmentId ||
        nativeReceipt.platform !== session.platform ||
        nativeReceipt.provider !== nativeProvider ||
        nativeReceipt.serviceEnvironment !== serviceEnvironment
      ) {
        this.failCurrent(
          generation,
          session,
          'PSD EOC rejected an inconsistent push-registration receipt.',
        );
        return;
      }
      this.update({
        phase: 'registered',
        platform: session.platform,
        message: null,
      });
    } catch (error) {
      this.failCurrent(
        generation,
        session,
        pushRegistrationFailureMessage(stage, error),
      );
    } finally {
      if (this.providerRequestAbortController === providerRequest) {
        this.providerRequestAbortController = null;
      }
    }
  }

  private async markDenied(
    generation: number,
    session: PushRegistrationSession,
  ): Promise<void> {
    if (!this.isCurrent(generation, session)) return;
    // Cleanup begins as unconfirmed. If the authenticated request itself moves
    // auth offline and fences this operation, suspendSession retains this
    // truthful denied state rather than reverting to idle or implying success.
    this.update({
      phase: 'denied',
      platform: session.platform,
      message: DENIED_CLEANUP_UNCONFIRMED_MESSAGE,
    });
    const cleanupConfirmed = await this.confirmUnregistered(
      generation,
      session,
    );
    if (!this.isCurrent(generation, session)) return;
    this.update({
      phase: 'denied',
      platform: session.platform,
      message: cleanupConfirmed ? null : DENIED_CLEANUP_UNCONFIRMED_MESSAGE,
    });
  }

  private async markProviderDisabled(
    generation: number,
    session: PushRegistrationSession,
  ): Promise<void> {
    if (!this.isCurrent(generation, session)) return;
    this.update({
      phase: 'provider-disabled',
      platform: session.platform,
      message: DISABLED_CLEANUP_UNCONFIRMED_MESSAGE,
    });
    const cleanupConfirmed = await this.confirmUnregistered(
      generation,
      session,
    );
    if (!this.isCurrent(generation, session)) return;
    this.update({
      phase: 'provider-disabled',
      platform: session.platform,
      message: cleanupConfirmed
        ? 'Push registration is disabled for this build. No notification provider was contacted.'
        : DISABLED_CLEANUP_UNCONFIRMED_MESSAGE,
    });
  }

  private async confirmUnregistered(
    generation: number,
    session: PushRegistrationSession,
  ): Promise<boolean> {
    if (this.unregisteredSessionId === session.deviceEnrollmentId) return true;
    try {
      const receipt = await session.unregister({
        deviceEnrollmentId: session.deviceEnrollmentId,
      });
      if (
        !this.isCurrent(generation, session) ||
        receipt.deviceEnrollmentId !== session.deviceEnrollmentId
      ) {
        return false;
      }
      this.unregisteredSessionId = session.deviceEnrollmentId;
      return true;
    } catch {
      return false;
    }
  }

  private failCurrent(
    generation: number,
    session: PushRegistrationSession,
    message: string,
  ): void {
    if (!this.isCurrent(generation, session)) return;
    this.update({ phase: 'error', platform: session.platform, message });
  }

  private isCurrent(
    generation: number,
    session: PushRegistrationSession,
  ): boolean {
    return (
      generation === this.generation &&
      this.session === session &&
      this.sessionIsActive(session)
    );
  }

  private sessionIsActive(session: PushRegistrationSession): boolean {
    try {
      return session.isActive();
    } catch {
      return false;
    }
  }

  private abortProviderRequest(): void {
    this.providerRequestAbortController?.abort();
    this.providerRequestAbortController = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }

  private update(next: PushRegistrationSnapshot): void {
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
}
