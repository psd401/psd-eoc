import { createHash } from 'node:crypto';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import {
  type AttemptIdempotentProviderAdapter,
  type ProviderSendOutcome,
  type ProviderSendRequest,
} from '../shared/processor';
import { ProviderDispatchError } from '../shared/retry';
import { buildEmailMessageContent } from './email-message';
import { SES_EMAIL_INTEGRATION_ID } from './ses-adapter';

export const MOCK_SES_PROVIDER = 'mock-ses' as const;

interface MockSendRecord {
  readonly fingerprint: string;
  readonly outcome: ProviderSendOutcome;
}

function fingerprint(workItem: WorkerAttemptWorkItem): string {
  return createHash('sha256')
    .update(JSON.stringify(workItem), 'utf8')
    .digest('hex');
}

function isUnroutableEmail(value: string): boolean {
  const separator = value.lastIndexOf('@');
  return (
    separator > 0 &&
    value
      .slice(separator + 1)
      .toLowerCase()
      .endsWith('.invalid')
  );
}

/**
 * CI-only SES substitute. It has no network dependency and accepts only the
 * canonical mocked synthetic path with a reserved unroutable destination.
 */
export class MockSesEmailAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'email' as const;
  public readonly integrationId = SES_EMAIL_INTEGRATION_ID;
  public readonly truthLabel = 'mocked' as const;
  public readonly provider = MOCK_SES_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #sends = new Map<string, MockSendRecord>();

  public get logicalSendCount(): number {
    return this.#sends.size;
  }

  public async send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const workItem = parseWorkerAttemptWorkItem(request.workItem);
    if (
      request.idempotencyKey !== workItem.attempt.id ||
      workItem.batch.channel !== 'email' ||
      workItem.attempt.channel !== 'email' ||
      workItem.endpoint.channel !== 'email' ||
      workItem.batch.rosterPopulation !== 'synthetic' ||
      workItem.batch.integrationStatus.integrationId !==
        SES_EMAIL_INTEGRATION_ID ||
      workItem.batch.integrationStatus.label !== 'mocked' ||
      !isUnroutableEmail(workItem.endpoint.email)
    ) {
      throw new ProviderDispatchError(
        'MOCK_SES_WORK_ITEM_REJECTED',
        'terminal-failure',
      );
    }

    // Validate the canonical copy through the same renderer used by live SES.
    buildEmailMessageContent(workItem.batch.renderedMessage);
    const currentFingerprint = fingerprint(workItem);
    const existing = this.#sends.get(workItem.attempt.id);
    if (existing !== undefined) {
      if (existing.fingerprint !== currentFingerprint) {
        throw new ProviderDispatchError(
          'MOCK_SES_IDEMPOTENCY_CONFLICT',
          'terminal-failure',
        );
      }
      return existing.outcome;
    }

    const outcome = Object.freeze({
      state: 'provider-accepted' as const,
      provider: MOCK_SES_PROVIDER,
      providerReference: `${MOCK_SES_PROVIDER}:${workItem.attempt.id}`,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
    this.#sends.set(
      workItem.attempt.id,
      Object.freeze({ fingerprint: currentFingerprint, outcome }),
    );
    return outcome;
  }
}
