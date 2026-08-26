import { describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import {
  ExpoPushServiceError,
  SqsExpoPushRetryPublisher,
  readExpoPushServiceConfiguration,
  runExpoPushService,
} from './service';

const TOKEN = 'x'.repeat(48);
const ENABLED_ENVIRONMENT = Object.freeze({
  EXPO_ACCESS_TOKEN: TOKEN,
  PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: TOKEN,
  PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: TOKEN,
  PSD_EOC_EXPO_CREDENTIAL_STATUS: 'verified',
  PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE: 'eas:build:proof-278',
  PSD_EOC_EXPO_PUSH_PROVIDER_AUTHORIZED: 'true',
  PSD_EOC_EXPO_PUSH_RUNTIME_MODE: 'enabled',
  PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN: TOKEN,
  PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN: TOKEN,
  PSD_EOC_PUSH_PROVIDER_CUTOVER: '{"version":1,"ios":"expo","android":"expo"}',
  PSD_EOC_SERVICE_ORIGIN: 'https://eoc.example.invalid',
  PUSH_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/push',
});

describe('Expo push service configuration', () => {
  test('requires both exact enablement gates and retained credential proof', () => {
    for (const environment of [
      {},
      { ...ENABLED_ENVIRONMENT, PSD_EOC_EXPO_PUSH_RUNTIME_MODE: 'dark' },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_EXPO_PUSH_PROVIDER_AUTHORIZED: 'TRUE',
      },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE: 'UNVERIFIED',
      },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_EXPO_CREDENTIAL_STATUS: 'UNCONFIGURED',
      },
    ]) {
      expect(() => readExpoPushServiceConfiguration(environment)).toThrow(
        expect.objectContaining({ code: 'FEATURE_DISABLED' }),
      );
    }
    expect(readExpoPushServiceConfiguration(ENABLED_ENVIRONMENT)).toEqual({
      queueUrl: ENABLED_ENVIRONMENT.PUSH_QUEUE_URL,
      serviceOrigin: ENABLED_ENVIRONMENT.PSD_EOC_SERVICE_ORIGIN,
      expoAccessToken: TOKEN,
      attemptExecutionToken: TOKEN,
      deliveryStateToken: TOKEN,
      endpointWorkerToken: TOKEN,
      pushRuntimeToken: TOKEN,
      verificationReference: 'eas:build:proof-278',
      cutover: { version: 1, ios: 'expo', android: 'expo' },
      direct: null,
    });
    expect(
      readExpoPushServiceConfiguration({
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE: 'v1',
      }).verificationReference,
    ).toBe('v1');
  });

  test('requires exact direct credentials before a direct platform cutover', () => {
    expect(() =>
      readExpoPushServiceConfiguration({
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_PUSH_PROVIDER_CUTOVER:
          '{"version":1,"ios":"direct","android":"expo"}',
      }),
    ).toThrow(expect.objectContaining({ code: 'FEATURE_DISABLED' }));

    const directEnvironment = {
      ...ENABLED_ENVIRONMENT,
      APNS_CREDENTIAL_STATUS: 'verified',
      APNS_ENVIRONMENT: 'production',
      APNS_KEY_ID: 'KEYID12345',
      APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(128)}\n-----END PRIVATE KEY-----\n`,
      APNS_TEAM_ID: 'TEAMID1234',
      APNS_TOPIC: 'org.example.eoc',
      FCM_CLIENT_EMAIL: 'push-sender@example-project.iam.gserviceaccount.com',
      FCM_CREDENTIAL_STATUS: 'verified',
      FCM_ENVIRONMENT: 'production',
      FCM_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${'B'.repeat(128)}\n-----END PRIVATE KEY-----\n`,
      FCM_PROJECT_ID: 'example-project',
      PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE:
        'direct:credential-proof-43',
      PSD_EOC_DIRECT_PUSH_PROVIDER_AUTHORIZED: 'true',
      PSD_EOC_IOS_BUNDLE_ID: 'org.example.eoc',
      PSD_EOC_PUSH_PROVIDER_CUTOVER:
        '{"version":1,"ios":"direct","android":"direct"}',
    } as const;
    expect(readExpoPushServiceConfiguration(directEnvironment)).toMatchObject({
      cutover: { version: 1, ios: 'direct', android: 'direct' },
      direct: {
        verificationReference: 'direct:credential-proof-43',
        apns: { topic: 'org.example.eoc', environment: 'production' },
        fcm: { projectId: 'example-project', environment: 'production' },
      },
    });
    expect(
      readExpoPushServiceConfiguration(directEnvironment).direct,
    ).toMatchObject({
      apns: {
        privateKey: directEnvironment.APNS_PRIVATE_KEY.slice(0, -1),
      },
      fcm: {
        privateKey: directEnvironment.FCM_PRIVATE_KEY.slice(0, -1),
      },
    });
    expect(() =>
      readExpoPushServiceConfiguration({
        ...directEnvironment,
        PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE: 'short',
      }),
    ).toThrow(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    expect(() =>
      readExpoPushServiceConfiguration({
        ...directEnvironment,
        APNS_CREDENTIAL_STATUS: 'UNCONFIGURED',
      }),
    ).toThrow(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    expect(() =>
      readExpoPushServiceConfiguration({
        ...directEnvironment,
        FCM_PRIVATE_KEY: `${directEnvironment.FCM_PRIVATE_KEY}\n`,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    for (const privateKey of [
      directEnvironment.FCM_PRIVATE_KEY.replace('BBBB', 'BB\0BB'),
      directEnvironment.FCM_PRIVATE_KEY.replace('BBBB', 'BB\tBB'),
      directEnvironment.FCM_PRIVATE_KEY.replace('BBBB', 'BB\u007fBB'),
    ]) {
      expect(() =>
        readExpoPushServiceConfiguration({
          ...directEnvironment,
          FCM_PRIVATE_KEY: privateKey,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
  });

  test('refuses unsafe origins, queues, and short worker credentials', () => {
    for (const environment of [
      { ...ENABLED_ENVIRONMENT, PSD_EOC_SERVICE_ORIGIN: 'http://localhost' },
      {
        ...ENABLED_ENVIRONMENT,
        PUSH_QUEUE_URL: 'https://example.invalid/not-sqs',
      },
      {
        ...ENABLED_ENVIRONMENT,
        PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN: 'short',
      },
    ]) {
      expect(() => readExpoPushServiceConfiguration(environment)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    }
  });
});

describe('opaque Expo retry publisher', () => {
  test('publishes only the attempt reference with a bounded SQS delay', async () => {
    const commands: unknown[] = [];
    const publisher = new SqsExpoPushRetryPublisher(
      {
        send(command) {
          commands.push(command);
          return Promise.resolve({});
        },
      },
      ENABLED_ENVIRONMENT.PUSH_QUEUE_URL,
    );
    await publisher.publishAttemptReference(
      '00000000-0000-4000-8000-000000000278',
      90,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
    expect((commands[0] as SendMessageCommand).input).toEqual({
      QueueUrl: ENABLED_ENVIRONMENT.PUSH_QUEUE_URL,
      DelaySeconds: 90,
      MessageBody: JSON.stringify({
        kind: 'expo-push-attempt-reference',
        attemptId: '00000000-0000-4000-8000-000000000278',
      }),
    });
    expect(
      JSON.stringify((commands[0] as SendMessageCommand).input),
    ).not.toContain('ExponentPushToken');
  });

  test('rejects provider-controlled or unbounded retry delays', async () => {
    const publisher = new SqsExpoPushRetryPublisher(
      { send: () => Promise.resolve({}) },
      ENABLED_ENVIRONMENT.PUSH_QUEUE_URL,
    );
    for (const delay of [-1, 901, 1.5]) {
      await expect(
        publisher.publishAttemptReference(
          '00000000-0000-4000-8000-000000000278',
          delay,
        ),
      ).rejects.toBeInstanceOf(ExpoPushServiceError);
    }
  });
});

describe('Expo push long-poll service', () => {
  test('deletes completed work and emits distinct latency and incomplete facts', async () => {
    const now = Date.parse('2026-08-26T12:00:00.000Z');
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    let loopChecks = 0;
    await runExpoPushService({
      environment: ENABLED_ENVIRONMENT,
      now: () => now,
      shouldContinue: () => loopChecks++ === 0,
      log: (event) => logs.push(event),
      runtime: {
        runDueReceipts: () => Promise.resolve([]),
        readStuckOutboxCount: () => Promise.resolve(4),
        processQueueMessage: () =>
          Promise.resolve({
            kind: 'completed',
            outboxCreatedAt: '2026-08-26T11:59:55.000Z',
            acceptedCount: 2,
            incompleteCount: 1,
          }),
      },
      sqs: {
        send(command) {
          commands.push(command);
          if (command instanceof ReceiveMessageCommand) {
            return Promise.resolve({
              Messages: [
                {
                  Body: JSON.stringify({ safe: true }),
                  ReceiptHandle: 'synthetic-receipt-handle',
                  Attributes: { SentTimestamp: String(now) },
                },
              ],
            });
          }
          return Promise.resolve({});
        },
      },
    });

    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(true);
    expect(logs).toContainEqual({
      event: 'push-worker-message-completed',
      count: 2,
      durationMilliseconds: 5_000,
    });
    expect(logs).toContainEqual({
      event: 'push-worker-message-incomplete',
      count: 1,
    });
    expect(logs).toContainEqual({
      event: 'push-worker-stuck-outbox-sample',
      count: 4,
    });
    expect(JSON.stringify(logs)).not.toContain('synthetic-receipt-handle');
  });

  test('retains failed work for SQS redrive and logs no provider detail', async () => {
    const now = Date.parse('2026-08-26T12:00:00.000Z');
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    let loopChecks = 0;
    await runExpoPushService({
      environment: ENABLED_ENVIRONMENT,
      now: () => now,
      shouldContinue: () => loopChecks++ === 0,
      log: (event) => logs.push(event),
      runtime: {
        runDueReceipts: () => Promise.resolve([]),
        readStuckOutboxCount: () => Promise.resolve(0),
        processQueueMessage: () =>
          Promise.reject(new Error('provider-controlled secret detail')),
      },
      sqs: {
        send(command) {
          commands.push(command);
          if (command instanceof ReceiveMessageCommand) {
            return Promise.resolve({
              Messages: [
                {
                  Body: JSON.stringify({ safe: true }),
                  ReceiptHandle: 'synthetic-receipt-handle',
                  Attributes: { SentTimestamp: String(now) },
                },
              ],
            });
          }
          return Promise.resolve({});
        },
      },
    });

    expect(
      commands.some((command) => command instanceof DeleteMessageCommand),
    ).toBe(false);
    expect(logs).toContainEqual({
      event: 'push-worker-message-failed',
      count: 1,
    });
    expect(JSON.stringify(logs)).not.toContain('provider-controlled');
  });
});
