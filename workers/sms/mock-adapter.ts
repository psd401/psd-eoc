import type {
  AttemptIdempotentProviderAdapter,
  ProviderSendOutcome,
  ProviderSendRequest,
} from '../shared';
import { ProviderDispatchError, workerAttemptFingerprint } from '../shared';
import {
  AWS_EUM_SMS_INTEGRATION_ID,
  parseSmsProviderSendRequest,
} from './aws-eum-adapter';

export const MOCK_AWS_EUM_SMS_PROVIDER = 'mock-aws-eum-sms' as const;

interface StoredMockSend {
  readonly fingerprint: string;
  readonly outcome: ProviderSendOutcome;
}

/**
 * CI-only SMS adapter. It accepts only canonical synthetic/unroutable work,
 * retains no destination or message copy, and performs no network operation.
 */
export class MockAwsEumSmsAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'sms' as const;
  public readonly integrationId = AWS_EUM_SMS_INTEGRATION_ID;
  public readonly provider = MOCK_AWS_EUM_SMS_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #sends = new Map<string, StoredMockSend>();
  #logicalSendCount = 0;

  /** Number of unique synthetic attempts accepted by this mock instance. */
  public get logicalSendCount(): number {
    return this.#logicalSendCount;
  }

  public async send(
    requestValue: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const request = parseSmsProviderSendRequest(requestValue);
    if (request.workItem.batch.rosterPopulation !== 'synthetic') {
      throw new ProviderDispatchError(
        'AWS_EUM_WORK_ITEM_INVALID',
        'terminal-failure',
      );
    }
    const fingerprint = workerAttemptFingerprint(request.workItem);
    const existing = this.#sends.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ProviderDispatchError(
          'MOCK_SMS_IDEMPOTENCY_CONFLICT',
          'terminal-failure',
        );
      }
      return existing.outcome;
    }

    const outcome = Object.freeze({
      state: 'provider-accepted' as const,
      provider: this.provider,
      providerReference: `mock-sms:${request.idempotencyKey}`,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
    this.#sends.set(
      request.idempotencyKey,
      Object.freeze({ fingerprint, outcome }),
    );
    this.#logicalSendCount += 1;
    return outcome;
  }
}
