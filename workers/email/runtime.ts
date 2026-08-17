import {
  WorkerAttemptProcessor,
  type AttemptEvidenceWriter,
  type AttemptExecutionStore,
  type FanoutControlAuthorizer,
  type LiveProviderAuthorizer,
  type ProviderSendAuthorizer,
  type WorkerAttemptProcessResult,
} from '../shared';
import {
  SES_FROM_EMAIL_ADDRESS,
  SesV2EmailAdapter,
  type DurableSesSendLedger,
  type SesV2Client,
} from './ses-adapter';

export const SES_EMAIL_QUEUE_ARN =
  'arn:aws:sqs:us-west-2:<aws-account-id>:psd-eoc-email' as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SesEmailQueueInvocation {
  readonly requestId: string;
  readonly sourceArn: string;
  readonly authorization: unknown;
}

export type SesEmailQueueInvocationAuthorizer = (
  invocation: SesEmailQueueInvocation,
) => boolean | Promise<boolean>;

export type SesEmailRuntimeMode =
  | Readonly<{ state: 'dark' }>
  | Readonly<{
      state: 'enabled';
      client: SesV2Client;
      sendLedger: DurableSesSendLedger;
      executionStore: AttemptExecutionStore;
      evidenceWriter: AttemptEvidenceWriter;
      authorizeFanout: FanoutControlAuthorizer;
      authorizeLiveProvider: LiveProviderAuthorizer;
      authorizeProviderSend: ProviderSendAuthorizer;
    }>;

export interface SesEmailRuntimeOptions {
  readonly authorizeQueueInvocation: SesEmailQueueInvocationAuthorizer;
  readonly mode?: SesEmailRuntimeMode;
}

export type SesEmailRuntimeErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVOCATION_UNVERIFIED'
  | 'FEATURE_DISABLED';

export class SesEmailRuntimeError extends Error {
  public constructor(public readonly code: SesEmailRuntimeErrorCode) {
    super('The SES email runtime request was rejected safely.');
    this.name = 'SesEmailRuntimeError';
  }
}

function enabledModeIsComplete(
  mode: Extract<SesEmailRuntimeMode, { state: 'enabled' }>,
): boolean {
  return (
    mode.client !== null &&
    typeof mode.client === 'object' &&
    typeof mode.client.sendEmail === 'function' &&
    mode.sendLedger !== null &&
    typeof mode.sendLedger === 'object' &&
    mode.sendLedger.durability === 'durable' &&
    typeof mode.sendLedger.claim === 'function' &&
    typeof mode.sendLedger.complete === 'function' &&
    typeof mode.sendLedger.release === 'function' &&
    mode.executionStore !== null &&
    typeof mode.executionStore === 'object' &&
    typeof mode.executionStore.lookup === 'function' &&
    typeof mode.executionStore.claim === 'function' &&
    typeof mode.executionStore.complete === 'function' &&
    typeof mode.executionStore.release === 'function' &&
    mode.evidenceWriter !== null &&
    typeof mode.evidenceWriter === 'object' &&
    typeof mode.evidenceWriter.recordAttemptEvidence === 'function' &&
    typeof mode.authorizeFanout === 'function' &&
    typeof mode.authorizeLiveProvider === 'function' &&
    typeof mode.authorizeProviderSend === 'function'
  );
}

async function authorizeInvocation(
  value: unknown,
  queueArn: string,
  authorize: SesEmailQueueInvocationAuthorizer,
): Promise<void> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SesEmailRuntimeError('INVOCATION_UNVERIFIED');
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.requestId !== 'string' ||
    !UUID_PATTERN.test(candidate.requestId) ||
    candidate.sourceArn !== queueArn
  ) {
    throw new SesEmailRuntimeError('INVOCATION_UNVERIFIED');
  }
  const invocation = value as SesEmailQueueInvocation;
  let allowed = false;
  try {
    allowed = (await authorize(invocation)) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new SesEmailRuntimeError('INVOCATION_UNVERIFIED');
  }
}

/**
 * Production email composition seam. The omitted mode is dark and constructs
 * no provider adapter. An enabled mode is possible only after callers supply
 * the durable execution and SES ledgers plus fresh fan-out, live-provider,
 * and final-send authorizers. Construction itself performs no network I/O.
 */
export class SesEmailRuntime {
  readonly #mode: 'dark' | 'enabled';
  readonly #queueArn: string;
  readonly #authorizeQueueInvocation: SesEmailQueueInvocationAuthorizer;
  readonly #attemptProcessor: WorkerAttemptProcessor | null;

  public constructor(options: SesEmailRuntimeOptions) {
    if (options === null || typeof options !== 'object') {
      throw new SesEmailRuntimeError('INVALID_CONFIGURATION');
    }
    const mode = options.mode ?? { state: 'dark' as const };
    if (
      typeof options.authorizeQueueInvocation !== 'function' ||
      (mode.state !== 'dark' && mode.state !== 'enabled') ||
      (mode.state === 'enabled' && !enabledModeIsComplete(mode))
    ) {
      throw new SesEmailRuntimeError('INVALID_CONFIGURATION');
    }

    this.#queueArn = SES_EMAIL_QUEUE_ARN;
    this.#authorizeQueueInvocation = options.authorizeQueueInvocation;
    this.#mode = mode.state;
    this.#attemptProcessor =
      mode.state === 'dark'
        ? null
        : new WorkerAttemptProcessor({
            adapter: new SesV2EmailAdapter({
              client: mode.client,
              sendLedger: mode.sendLedger,
              fromEmailAddress: SES_FROM_EMAIL_ADDRESS,
              truthLabel: 'live-verified',
            }),
            executionStore: mode.executionStore,
            evidenceWriter: mode.evidenceWriter,
            authorizeFanout: mode.authorizeFanout,
            authorizeLiveProvider: mode.authorizeLiveProvider,
            authorizeProviderSend: mode.authorizeProviderSend,
          });
  }

  public async processQueueAttempt(
    workItem: unknown,
    invocation: unknown,
  ): Promise<WorkerAttemptProcessResult> {
    await authorizeInvocation(
      invocation,
      this.#queueArn,
      this.#authorizeQueueInvocation,
    );
    if (this.#mode === 'dark' || this.#attemptProcessor === null) {
      throw new SesEmailRuntimeError('FEATURE_DISABLED');
    }
    return this.#attemptProcessor.process(workItem);
  }
}
