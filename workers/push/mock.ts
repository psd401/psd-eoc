import type { IntegrationTruthLabel } from '@psd-eoc/contracts';

import { parseWorkerAttemptWorkItem } from '../shared/attempt';
import type {
  AttemptIdempotentProviderAdapter,
  ProviderSendOutcome,
  ProviderSendRequest,
} from '../shared/processor';
import { ProviderDispatchError } from '../shared/retry';
import {
  EXPO_RECEIPT_CHUNK_SIZE,
  EXPO_SEND_CHUNK_SIZE,
  createExpoPushMessage,
  failed,
  unknown,
  type ExpoProviderOutcome,
} from './protocol';
import type { ExpoPushTransport } from './transport';

export const MOCK_EXPO_PUSH_PROVIDER = 'mock-expo-push' as const;

function mockReference(attemptId: string): string {
  return `mock-expo-${attemptId}`;
}

function mockAccepted(attemptId: string): ExpoProviderOutcome {
  return Object.freeze({
    kind: 'provider-accepted',
    state: 'provider-accepted',
    providerReference: mockReference(attemptId),
    reasonCode: null,
    invalidatesEndpoint: false,
  });
}

export type MockExpoBehavior =
  | 'accepted'
  | 'device-not-registered'
  | 'message-rate-exceeded'
  | 'unknown';

export interface MockExpoPushTransportOptions {
  readonly behaviors?: readonly MockExpoBehavior[];
}

function assertMockedWork(value: unknown) {
  const workItem = parseWorkerAttemptWorkItem(value);
  if (
    workItem.batch.integrationStatus.label !== 'mocked' ||
    workItem.batch.integrationStatus.integrationId !== 'expo-push' ||
    workItem.batch.rosterPopulation !== 'synthetic'
  ) {
    throw new TypeError('Mock Expo transport accepts synthetic work only.');
  }
  createExpoPushMessage(workItem);
  return workItem;
}

/** Deterministic dev/CI transport with no fetch or provider-network seam. */
export class MockExpoPushTransport implements ExpoPushTransport {
  public readonly sends: string[][] = [];
  public readonly receiptQueries: string[][] = [];
  readonly #behaviors: readonly MockExpoBehavior[];

  public constructor(options: MockExpoPushTransportOptions = {}) {
    this.#behaviors = options.behaviors ?? [];
  }

  public sendChunk(
    workValues: readonly unknown[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    if (workValues.length < 1 || workValues.length > EXPO_SEND_CHUNK_SIZE) {
      throw new TypeError('Mock Expo send chunk is invalid.');
    }
    const workItems = workValues.map(assertMockedWork);
    this.sends.push(workItems.map((item) => item.attempt.id));
    return Promise.resolve(
      Object.freeze(
        workItems.map((item, index) => {
          switch (this.#behaviors[index] ?? 'accepted') {
            case 'accepted':
              return mockAccepted(item.attempt.id);
            case 'device-not-registered':
              return failed('EXPO_DEVICE_NOT_REGISTERED', null, true);
            case 'message-rate-exceeded':
              return Object.freeze({
                kind: 'retry' as const,
                state: 'failed' as const,
                providerReference: null,
                reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED' as const,
                invalidatesEndpoint: false as const,
              });
            case 'unknown':
              return unknown('EXPO_TICKET_ERROR_UNKNOWN');
          }
        }),
      ),
    );
  }

  public queryReceiptChunk(
    receiptIds: readonly string[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    if (receiptIds.length < 1 || receiptIds.length > EXPO_RECEIPT_CHUNK_SIZE) {
      throw new TypeError('Mock Expo receipt chunk is invalid.');
    }
    this.receiptQueries.push([...receiptIds]);
    return Promise.resolve(
      Object.freeze(
        receiptIds.map((id) => ({
          kind: 'provider-accepted' as const,
          state: 'provider-accepted' as const,
          providerReference: id,
          reasonCode: null,
          invalidatesEndpoint: false as const,
        })),
      ),
    );
  }
}

/** Shared processor-compatible deterministic adapter for mocked work. */
export class MockExpoPushAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'push' as const;
  public readonly integrationId = 'expo-push' as const;
  public readonly truthLabel: IntegrationTruthLabel = 'mocked';
  public readonly provider = MOCK_EXPO_PUSH_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;
  public readonly requests: ProviderSendRequest[] = [];
  public logicalSends = 0;
  readonly #outcomes = new Map<string, ProviderSendOutcome>();
  readonly #behaviors: readonly MockExpoBehavior[];

  public constructor(options: MockExpoPushTransportOptions = {}) {
    this.#behaviors = options.behaviors ?? [];
  }

  public send(request: ProviderSendRequest): Promise<ProviderSendOutcome> {
    const workItem = assertMockedWork(request.workItem);
    if (request.idempotencyKey !== workItem.attempt.id) {
      throw new TypeError('Mock Expo idempotency key is invalid.');
    }
    this.requests.push(request);
    const existing = this.#outcomes.get(request.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);
    this.logicalSends += 1;
    const behavior = this.#behaviors[this.requests.length - 1] ?? 'accepted';
    if (behavior === 'message-rate-exceeded') {
      return Promise.reject(
        new ProviderDispatchError(
          'EXPO_MESSAGE_RATE_EXCEEDED',
          'safe-to-retry',
        ),
      );
    }
    const outcome: ProviderSendOutcome =
      behavior === 'accepted'
        ? Object.freeze({
            state: 'provider-accepted' as const,
            provider: this.provider,
            providerReference: mockReference(workItem.attempt.id),
            proof: null,
            reasonCode: null,
            diagnosticDigest: null,
          })
        : behavior === 'device-not-registered'
          ? Object.freeze({
              state: 'failed' as const,
              provider: this.provider,
              providerReference: null,
              proof: null,
              reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
              diagnosticDigest: null,
            })
          : Object.freeze({
              state: 'unknown' as const,
              provider: this.provider,
              providerReference: null,
              proof: null,
              reasonCode: 'EXPO_TICKET_ERROR_UNKNOWN',
              diagnosticDigest: null,
            });
    this.#outcomes.set(request.idempotencyKey, outcome);
    return Promise.resolve(outcome);
  }
}
