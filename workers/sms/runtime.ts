import {
  EndpointStatusRecordSchema,
  SmsLifecycleCapabilityContextSchema,
  SmsOptOutRecordSchema,
  type EndpointStatusRecord,
  type RecordEndpointStatusInput,
  type RecordSmsOptOutInput,
  type SmsLifecycleCapabilityContext,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import {
  WorkerAttemptProcessor,
  type AttemptEvidenceWriter,
  type AttemptExecutionStore,
  type LiveProviderAuthorizer,
  type WorkerAttemptProcessResult,
} from '../shared';
import {
  AwsEumSmsAdapter,
  type AwsEumSmsAdapterOptions,
  type AwsEumSmsLiveAuthorizer,
} from './aws-eum-adapter';
import {
  createAwsEumSingleAttemptClient,
  type AwsEumSingleAttemptClient,
  type AwsEumSingleAttemptClientConfig,
} from './aws-eum-client';
import {
  SmsDeliveryEventProcessor,
  type AwsEumSmsDeliveryEventConfiguration,
  type AwsEumSmsEventBridgeAuthorizer,
  type AwsEumSmsEventBridgeInvocation,
  type SmsDeliveryAttemptLookup,
  type SmsDeliveryEventProcessResult,
} from './delivery-events';
import {
  SmsOptOutReconciler,
  recordAwsManagedOptIn,
  validateAwsEumOptOutListIdentity,
  type AwsEumOptOutListIdentity,
  type RecordAwsManagedOptInOptions,
  type SmsEndpointStatusRecorder,
  type SmsOptInInvocation,
  type SmsOptInInvocationAuthorizer,
  type SmsOptOutDestinationResolver,
  type SmsOptOutReconcileInput,
  type SmsOptOutReconcileReport,
  type SmsOptOutRecorder,
} from './opt-out';
import { processSmsWorkItem, type SmsWorkerProcessResult } from './worker';

const QUEUE_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov):sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}$/u;
const SCHEDULE_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov):events:[a-z0-9-]+:\d{12}:rule\/[A-Za-z0-9._/-]{1,256}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SmsLifecycleCapabilityRequest =
  | Readonly<{
      capabilityId: 'record-sms-opt-out';
      context: Extract<
        SmsLifecycleCapabilityContext,
        { source: 'worker' | 'scheduled-job' }
      >;
      input: RecordSmsOptOutInput;
    }>
  | Readonly<{
      capabilityId: 'record-endpoint-status';
      context: Extract<SmsLifecycleCapabilityContext, { source: 'webhook' }>;
      input: RecordEndpointStatusInput;
    }>;

/** Must execute the named mutation through server `executeCapability`. */
export interface SmsCanonicalCapabilityExecutor {
  execute(request: SmsLifecycleCapabilityRequest): Promise<unknown>;
}

export interface SmsQueueInvocation {
  readonly requestId: string;
  readonly sourceArn: string;
  readonly authorization: unknown;
}

export interface SmsScheduledInvocation {
  readonly requestId: string;
  readonly ruleArn: string;
  readonly authorization: unknown;
}

export type SmsQueueInvocationAuthorizer = (
  invocation: SmsQueueInvocation,
) => boolean | Promise<boolean>;

export type SmsScheduledInvocationAuthorizer = (
  invocation: SmsScheduledInvocation,
) => boolean | Promise<boolean>;

export type SmsRuntimeMode =
  | Readonly<{ state: 'dark' }>
  | Readonly<{
      state: 'enabled';
      authorizeLiveProvider: LiveProviderAuthorizer;
      authorizeLiveSend: AwsEumSmsLiveAuthorizer;
    }>;

export interface AwsEumSmsRuntimeOptions {
  readonly mode?: SmsRuntimeMode;
  readonly awsClient: AwsEumSingleAttemptClientConfig;
  readonly adapter: Omit<
    AwsEumSmsAdapterOptions,
    'client' | 'featureEnabled' | 'authorizeLiveSend'
  >;
  readonly executionStore: AttemptExecutionStore;
  readonly evidenceWriter: AttemptEvidenceWriter;
  readonly attempts: SmsDeliveryAttemptLookup;
  readonly capabilities: SmsCanonicalCapabilityExecutor;
  readonly destinationResolver: SmsOptOutDestinationResolver;
  readonly optOutList: AwsEumOptOutListIdentity;
  readonly queueArn: string;
  readonly scheduleRuleArn: string;
  readonly authorizeQueueInvocation: SmsQueueInvocationAuthorizer;
  readonly authorizeScheduledInvocation: SmsScheduledInvocationAuthorizer;
  readonly authorizeOptInInvocation: SmsOptInInvocationAuthorizer;
  readonly deliveryConfiguration: AwsEumSmsDeliveryEventConfiguration;
  readonly authorizeEventBridgeInvocation: AwsEumSmsEventBridgeAuthorizer;
}

export type AwsEumSmsRuntimeErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVOCATION_UNVERIFIED'
  | 'FEATURE_DISABLED';

export class AwsEumSmsRuntimeError extends Error {
  public constructor(public readonly code: AwsEumSmsRuntimeErrorCode) {
    super('The AWS EUM SMS runtime request was rejected safely.');
    this.name = 'AwsEumSmsRuntimeError';
  }
}

async function authorized<
  Invocation extends SmsQueueInvocation | SmsScheduledInvocation,
>(
  invocation: unknown,
  expectedArn: string,
  arnKey: 'sourceArn' | 'ruleArn',
  authorize: (invocation: Invocation) => boolean | Promise<boolean>,
): Promise<Invocation> {
  if (
    invocation === null ||
    typeof invocation !== 'object' ||
    Array.isArray(invocation)
  ) {
    throw new AwsEumSmsRuntimeError('INVOCATION_UNVERIFIED');
  }
  const candidate = invocation as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.requestId !== 'string' ||
    !UUID_PATTERN.test(candidate.requestId) ||
    candidate[arnKey] !== expectedArn
  ) {
    throw new AwsEumSmsRuntimeError('INVOCATION_UNVERIFIED');
  }
  const parsed = invocation as Invocation;
  let allowed = false;
  try {
    allowed = (await authorize(parsed)) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new AwsEumSmsRuntimeError('INVOCATION_UNVERIFIED');
  }
  return parsed;
}

function lifecycleRecorders(
  executor: SmsCanonicalCapabilityExecutor,
  contextValue: SmsLifecycleCapabilityContext,
): Readonly<{
  optOut: SmsOptOutRecorder;
  endpointStatus: SmsEndpointStatusRecorder;
}> {
  if (typeof executor?.execute !== 'function') {
    throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
  }
  const context = SmsLifecycleCapabilityContextSchema.parse(contextValue);
  return Object.freeze({
    optOut: Object.freeze({
      async recordSmsOptOut(
        input: RecordSmsOptOutInput,
      ): Promise<SmsOptOutRecord> {
        if (context.source === 'webhook') {
          throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
        }
        return SmsOptOutRecordSchema.parse(
          await executor.execute({
            capabilityId: 'record-sms-opt-out',
            context,
            input,
          }),
        );
      },
    }),
    endpointStatus: Object.freeze({
      async recordEndpointStatus(
        input: RecordEndpointStatusInput,
      ): Promise<EndpointStatusRecord> {
        if (context.source !== 'webhook') {
          throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
        }
        return EndpointStatusRecordSchema.parse(
          await executor.execute({
            capabilityId: 'record-endpoint-status',
            context,
            input,
          }),
        );
      },
    }),
  });
}

function workerLifecycleContext(
  invocation: SmsQueueInvocation,
): Extract<SmsLifecycleCapabilityContext, { source: 'worker' }> {
  return SmsLifecycleCapabilityContextSchema.parse({
    actor: { kind: 'system', serviceId: 'sms-worker' },
    source: 'worker',
    transport: 'sqs',
    requestId: invocation.requestId,
    authenticated: true,
  }) as Extract<SmsLifecycleCapabilityContext, { source: 'worker' }>;
}

function scheduledLifecycleContext(
  invocation: SmsScheduledInvocation,
): Extract<SmsLifecycleCapabilityContext, { source: 'scheduled-job' }> {
  return SmsLifecycleCapabilityContextSchema.parse({
    actor: { kind: 'system', serviceId: 'sms-opt-out-reconciler' },
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    requestId: invocation.requestId,
    authenticated: true,
  }) as Extract<SmsLifecycleCapabilityContext, { source: 'scheduled-job' }>;
}

function webhookLifecycleContext(
  invocation: SmsOptInInvocation,
): Extract<SmsLifecycleCapabilityContext, { source: 'webhook' }> {
  return SmsLifecycleCapabilityContextSchema.parse({
    actor: { kind: 'system', serviceId: 'sms-opt-in-webhook' },
    source: 'webhook',
    transport: 'provider-webhook',
    requestId: invocation.requestId,
    authenticated: true,
  }) as Extract<SmsLifecycleCapabilityContext, { source: 'webhook' }>;
}

/**
 * Production composition seam. Construction performs no network I/O and the
 * omitted mode is dark: retained truth may replay, but new provider sends and
 * scheduled AWS reads remain impossible until an explicit enabled mode exists.
 */
export class AwsEumSmsRuntime {
  readonly #mode: SmsRuntimeMode;
  readonly #queueArn: string;
  readonly #scheduleRuleArn: string;
  readonly #authorizeQueue: SmsQueueInvocationAuthorizer;
  readonly #authorizeSchedule: SmsScheduledInvocationAuthorizer;
  readonly #attemptProcessor: WorkerAttemptProcessor;
  readonly #deliveryProcessor: SmsDeliveryEventProcessor;
  readonly #capabilities: SmsCanonicalCapabilityExecutor;
  readonly #optOutTransport: AwsEumSingleAttemptClient;
  readonly #destinationResolver: SmsOptOutDestinationResolver;
  readonly #authorizeOptIn: SmsOptInInvocationAuthorizer;
  readonly #optOutList: AwsEumOptOutListIdentity;

  public constructor(options: AwsEumSmsRuntimeOptions) {
    const configuredMode = options.mode ?? { state: 'dark' as const };
    if (
      !QUEUE_ARN_PATTERN.test(options.queueArn) ||
      !SCHEDULE_ARN_PATTERN.test(options.scheduleRuleArn) ||
      typeof options.authorizeQueueInvocation !== 'function' ||
      typeof options.authorizeScheduledInvocation !== 'function' ||
      typeof options.authorizeOptInInvocation !== 'function' ||
      typeof options.destinationResolver?.resolveSmsDestination !== 'function'
    ) {
      throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
    }
    if (configuredMode.state !== 'dark' && configuredMode.state !== 'enabled') {
      throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
    }
    if (
      configuredMode.state === 'enabled' &&
      (typeof configuredMode.authorizeLiveProvider !== 'function' ||
        typeof configuredMode.authorizeLiveSend !== 'function')
    ) {
      throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
    }
    const mode: SmsRuntimeMode =
      configuredMode.state === 'dark'
        ? Object.freeze({ state: 'dark' })
        : Object.freeze({
            state: 'enabled',
            authorizeLiveProvider: configuredMode.authorizeLiveProvider,
            authorizeLiveSend: configuredMode.authorizeLiveSend,
          });
    let optOutList: Readonly<AwsEumOptOutListIdentity>;
    try {
      optOutList = validateAwsEumOptOutListIdentity(options.optOutList);
    } catch {
      throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
    }
    const client = createAwsEumSingleAttemptClient(options.awsClient);
    if (typeof options.capabilities?.execute !== 'function') {
      throw new AwsEumSmsRuntimeError('INVALID_CONFIGURATION');
    }
    const adapter = new AwsEumSmsAdapter({
      ...options.adapter,
      client,
      featureEnabled: mode.state === 'enabled',
      ...(mode.state === 'enabled'
        ? { authorizeLiveSend: mode.authorizeLiveSend }
        : {}),
    });
    this.#attemptProcessor = new WorkerAttemptProcessor({
      adapter,
      executionStore: options.executionStore,
      evidenceWriter: options.evidenceWriter,
      ...(mode.state === 'enabled'
        ? { authorizeLiveProvider: mode.authorizeLiveProvider }
        : {}),
    });
    this.#deliveryProcessor = new SmsDeliveryEventProcessor({
      configuration: options.deliveryConfiguration,
      attempts: options.attempts,
      evidenceWriter: options.evidenceWriter,
      authorizeEventBridgeInvocation: options.authorizeEventBridgeInvocation,
    });
    this.#mode = mode;
    this.#queueArn = options.queueArn;
    this.#scheduleRuleArn = options.scheduleRuleArn;
    this.#authorizeQueue = options.authorizeQueueInvocation;
    this.#authorizeSchedule = options.authorizeScheduledInvocation;
    this.#capabilities = options.capabilities;
    this.#optOutTransport = client;
    this.#destinationResolver = options.destinationResolver;
    this.#authorizeOptIn = options.authorizeOptInInvocation;
    this.#optOutList = optOutList;
  }

  public async processQueueAttempt(
    value: unknown,
    invocation: unknown,
  ): Promise<SmsWorkerProcessResult> {
    const authenticatedInvocation = await authorized<SmsQueueInvocation>(
      invocation,
      this.#queueArn,
      'sourceArn',
      this.#authorizeQueue,
    );
    const recorders = lifecycleRecorders(
      this.#capabilities,
      workerLifecycleContext(authenticatedInvocation),
    );
    return processSmsWorkItem(value, {
      attemptProcessor: this.#attemptProcessor,
      optOutRecorder: recorders.optOut,
    });
  }

  public processDeliveryEvent(
    value: unknown,
    invocation: AwsEumSmsEventBridgeInvocation,
  ): Promise<SmsDeliveryEventProcessResult> {
    return this.#deliveryProcessor.process(value, invocation);
  }

  public async reconcileOptOuts(
    input: SmsOptOutReconcileInput,
    invocation: unknown,
  ): Promise<SmsOptOutReconcileReport> {
    const authenticatedInvocation = await authorized<SmsScheduledInvocation>(
      invocation,
      this.#scheduleRuleArn,
      'ruleArn',
      this.#authorizeSchedule,
    );
    if (this.#mode.state !== 'enabled') {
      throw new AwsEumSmsRuntimeError('FEATURE_DISABLED');
    }
    const recorders = lifecycleRecorders(
      this.#capabilities,
      scheduledLifecycleContext(authenticatedInvocation),
    );
    return new SmsOptOutReconciler({
      transport: this.#optOutTransport,
      resolver: this.#destinationResolver,
      recorder: recorders.optOut,
      optOutListName: this.#optOutList.name,
      optOutListArn: this.#optOutList.arn,
    }).reconcile(input);
  }

  public async recordProviderVerifiedOptIn(
    input: Readonly<{ rosterSnapshotId: string }>,
    invocation: SmsOptInInvocation,
  ): Promise<EndpointStatusRecord | null> {
    if (this.#mode.state !== 'enabled') {
      throw new AwsEumSmsRuntimeError('FEATURE_DISABLED');
    }
    return recordAwsManagedOptIn(input, this.#optOutList, invocation, {
      transport: this.#optOutTransport,
      resolver: this.#destinationResolver,
      recorder: Object.freeze({
        recordEndpointStatus: (recordInput: RecordEndpointStatusInput) =>
          lifecycleRecorders(
            this.#capabilities,
            webhookLifecycleContext(invocation),
          ).endpointStatus.recordEndpointStatus(recordInput),
      }),
      authorizeInvocation: this.#authorizeOptIn,
    } satisfies RecordAwsManagedOptInOptions);
  }
}

export function createAwsEumSmsRuntime(
  options: AwsEumSmsRuntimeOptions,
): AwsEumSmsRuntime {
  return new AwsEumSmsRuntime(options);
}

export type { WorkerAttemptProcessResult };
