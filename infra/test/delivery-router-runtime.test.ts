import { describe, expect, it, mock } from 'bun:test';

class ChangeMessageVisibilityCommand {
  public constructor(public readonly input: Record<string, unknown>) {}
}

class DeleteMessageCommand {
  public constructor(public readonly input: Record<string, unknown>) {}
}

class ReceiveMessageCommand {
  public constructor(public readonly input: Record<string, unknown>) {}
}

class SendMessageCommand {
  public constructor(public readonly input: Record<string, unknown>) {}
}

// Bun shares module mocks across files in one shard. Keep this test's SDK
// surface complete for every repository SQS consumer so parallel imports do
// not become order-dependent.
mock.module('@aws-sdk/client-sqs', () => ({
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient: class SQSClient {},
  SendMessageCommand,
}));

const { routeDeliveryBatches } = await import(
  '../lambda/delivery-router/index.mjs'
);

const ACCOUNT = '123456789012';
const queue = (name: string) =>
  `https://sqs.us-west-2.amazonaws.com/${ACCOUNT}/${name}`;

const ENVIRONMENT = Object.freeze({
  EMAIL_QUEUE_URL: queue('psd-eoc-email'),
  PUSH_QUEUE_URL: queue('psd-eoc-push'),
  SMS_QUEUE_URL: queue('psd-eoc-sms'),
});

/** A batch body carrying only what the router is allowed to look at. */
function body(channel: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channel,
    id: '00000000-0000-4000-8000-000000000001',
    templateMode: 'drill',
    ...extra,
  });
}

function record(messageId: string, messageBody: string) {
  return { messageId, body: messageBody };
}

type Sent = { readonly input: Record<string, unknown> };

function collector() {
  const sent: Sent[] = [];
  return {
    sent,
    send: (command: unknown) => {
      sent.push(command as Sent);
      return Promise.resolve({});
    },
  };
}

describe('delivery batch routing', () => {
  it('sends each batch to the queue for its channel', async () => {
    const { sent, send } = collector();
    const result = await routeDeliveryBatches(
      {
        Records: [
          record('m1', body('email')),
          record('m2', body('sms')),
          record('m3', body('push')),
        ],
      },
      { environment: ENVIRONMENT, send },
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(sent.map((command) => command.input.QueueUrl)).toEqual([
      queue('psd-eoc-email'),
      queue('psd-eoc-sms'),
      queue('psd-eoc-push'),
    ]);
  });

  it('forwards the body byte for byte', async () => {
    const { sent, send } = collector();
    // Authorization and real/drill classification travel inside this body. A
    // router that re-serialises it can change what the worker sees.
    const original = body('email', {
      authorization: { confirmedBy: 'synthetic-actor' },
      eventKind: 'incident',
    });
    await routeDeliveryBatches(
      { Records: [record('m1', original)] },
      { environment: ENVIRONMENT, send },
    );
    expect(sent[0]?.input.MessageBody).toBe(original);
  });

  it('fails only the unroutable message and delivers its siblings', async () => {
    const { sent, send } = collector();
    const result = await routeDeliveryBatches(
      {
        Records: [
          record('good-1', body('email')),
          record('bad', '{ not json'),
          record('good-2', body('sms')),
        ],
      },
      { environment: ENVIRONMENT, send },
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(sent).toHaveLength(2);
  });

  it('refuses a channel it has no queue for', async () => {
    const { sent, send } = collector();
    const result = await routeDeliveryBatches(
      {
        Records: [
          record('m1', body('informacast')),
          record('m2', JSON.stringify({ id: 'no-channel-at-all' })),
          record('m3', JSON.stringify(['not', 'an', 'object'])),
        ],
      },
      { environment: ENVIRONMENT, send },
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: 'm1' },
      { itemIdentifier: 'm2' },
      { itemIdentifier: 'm3' },
    ]);
    expect(sent).toHaveLength(0);
  });

  it('reports the message that failed to send, not the whole batch', async () => {
    const sent: Sent[] = [];
    const send = (command: unknown) => {
      const typed = command as Sent;
      sent.push(typed);
      return String(typed.input.QueueUrl).endsWith('psd-eoc-sms')
        ? Promise.reject(new Error('synthetic SQS failure'))
        : Promise.resolve({});
    };

    const result = await routeDeliveryBatches(
      {
        Records: [record('m1', body('email')), record('m2', body('sms'))],
      },
      { environment: ENVIRONMENT, send },
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });

  it('refuses to route anywhere when a destination is missing or not a queue', async () => {
    const { sent, send } = collector();
    for (const broken of [
      { ...ENVIRONMENT, SMS_QUEUE_URL: undefined },
      { ...ENVIRONMENT, SMS_QUEUE_URL: 'not-a-url' },
      { ...ENVIRONMENT, SMS_QUEUE_URL: 'http://sqs.us-west-2.amazonaws.com/1' },
      { ...ENVIRONMENT, SMS_QUEUE_URL: 'https://example.invalid/queue' },
    ]) {
      await expect(
        routeDeliveryBatches(
          { Records: [record('m1', body('email'))] },
          { environment: broken, send },
        ),
      ).rejects.toThrow();
    }
    expect(sent).toHaveLength(0);
  });

  it('does nothing for an empty or absent record list', async () => {
    const { sent, send } = collector();
    for (const event of [{}, { Records: [] }, null]) {
      const result = await routeDeliveryBatches(event, {
        environment: ENVIRONMENT,
        send,
      });
      expect(result.batchItemFailures).toEqual([]);
    }
    expect(sent).toHaveLength(0);
  });
});
