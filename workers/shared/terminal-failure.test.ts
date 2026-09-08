import { describe, expect, test } from 'bun:test';

import { isTerminalFailure, retireMessage } from './terminal-failure';
import { EmailRuntimeClientError } from '../email/state-client';
import { ExpoPushRuntimeClientError } from '../push/state-client';
import { SmsRuntimeClientError } from '../sms/state-client';

describe('isTerminalFailure', () => {
  test('a failure that states it cannot be retried is terminal', () => {
    expect(isTerminalFailure({ retryable: false })).toBe(true);
  });

  test('a failure that states it can be retried is not', () => {
    expect(isTerminalFailure({ retryable: true })).toBe(false);
  });

  test('reads the flag through a wrapping error, which is how workers see it', () => {
    const inner = Object.assign(new Error('inner'), { retryable: false });
    const wrapper = new Error('wrapper', { cause: inner });
    expect(isTerminalFailure(wrapper)).toBe(true);
  });

  test('the outermost opinion wins over a deeper one', () => {
    const inner = Object.assign(new Error('inner'), { retryable: false });
    const wrapper = Object.assign(new Error('wrapper', { cause: inner }), {
      retryable: true,
    });
    expect(isTerminalFailure(wrapper)).toBe(false);
  });

  // The bias that keeps a notification from being dropped: anything that does
  // not say it is terminal keeps the redrive policy's behavior.
  const unopinionated: readonly (readonly [string, unknown])[] = [
    ['no opinion anywhere', new Error('plain')],
    ['a non-boolean flag', { retryable: 'false' }],
    ['a bare string', 'nope'],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, error] of unopinionated) {
    test(`${label} is treated as retryable`, () => {
      expect(isTerminalFailure(error)).toBe(false);
    });
  }

  test('a cyclic cause chain terminates instead of hanging', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(isTerminalFailure(first)).toBe(false);
  });
});

describe('deployment skew stays retryable', () => {
  // The runtime answers 403 when a worker presents a verification reference
  // the deployment has moved past -- every message it holds gets one, until
  // the worker is replaced with the matching image. If that counted as
  // terminal, a deploy would dead-letter whatever was in flight instead of
  // delivering it moments later, which is the one outcome this system may not
  // have. The three state clients therefore raise it as retryable.
  test.each([
    [
      'email',
      () => new EmailRuntimeClientError('REQUEST_UNAUTHORIZED', true, 403),
    ],
    [
      'push',
      () => new ExpoPushRuntimeClientError('REQUEST_UNAUTHORIZED', true, 403),
    ],
    ['sms', () => new SmsRuntimeClientError('REQUEST_UNAUTHORIZED', true, 403)],
  ])(
    '%s: an unauthorized runtime answer is not terminal',
    (_channel, build) => {
      expect(isTerminalFailure(build())).toBe(false);
    },
  );

  // A conflict is the opposite: the runtime looked at this exact message and
  // refused it, and will refuse it identically on every receive.
  test.each([
    ['email', () => new EmailRuntimeClientError('CONFLICT', false, 409)],
    ['push', () => new ExpoPushRuntimeClientError('CONFLICT', false, 409)],
    ['sms', () => new SmsRuntimeClientError('CONFLICT', false, 409)],
  ])('%s: a conflict is terminal', (_channel, build) => {
    expect(isTerminalFailure(build())).toBe(true);
  });
});

describe('retireMessage', () => {
  test('copies to the dead-letter queue before deleting from the source', async () => {
    const calls: string[] = [];
    await retireMessage({
      client: {
        send: (command: unknown) => {
          calls.push(
            (command as { constructor: { name: string } }).constructor.name,
          );
          return Promise.resolve({});
        },
      },
      queueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q',
      deadLetterQueueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q-dlq',
      receiptHandle: 'receipt',
      body: '{"kind":"batch"}',
    });
    expect(calls).toEqual(['SendMessageCommand', 'DeleteMessageCommand']);
  });

  test('forwards the body unchanged, so a redrive replays the original', async () => {
    const bodies: unknown[] = [];
    await retireMessage({
      client: {
        send: (command: unknown) => {
          const input = (command as { input?: Record<string, unknown> }).input;
          if (input?.MessageBody !== undefined) bodies.push(input.MessageBody);
          return Promise.resolve({});
        },
      },
      queueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q',
      deadLetterQueueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q-dlq',
      receiptHandle: 'receipt',
      body: '{"kind":"batch","id":"abc"}',
    });
    expect(bodies).toEqual(['{"kind":"batch","id":"abc"}']);
  });

  test('a failed copy leaves the message on the source queue', async () => {
    const calls: string[] = [];
    await expect(
      retireMessage({
        client: {
          send: (command: unknown) => {
            const name = (command as { constructor: { name: string } })
              .constructor.name;
            calls.push(name);
            return name === 'SendMessageCommand'
              ? Promise.reject(new Error('dlq unavailable'))
              : Promise.resolve({});
          },
        },
        queueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q',
        deadLetterQueueUrl: 'https://sqs.us-west-2.amazonaws.com/1/q-dlq',
        receiptHandle: 'receipt',
        body: '{}',
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(['SendMessageCommand']);
  });
});
