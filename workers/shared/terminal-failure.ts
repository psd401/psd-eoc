/**
 * Whether a failed message is worth handing back to the queue, and what to do
 * when it is not.
 *
 * Every channel worker used to answer the first question the same way: it
 * logged the failure and returned, leaving the message for the queue's redrive
 * policy. That is right for a timeout and wrong for a refusal. A message the
 * server answers with 409 gets the identical 409 on every one of its five
 * receives, and between them it sits visible on the queue driving
 * `ApproximateAgeOfOldestMessage` up and down -- so one undeliverable message
 * spent ten minutes producing alarm-and-recovery pairs before reaching the
 * dead-letter queue it was always going to reach.
 *
 * A failure that says it will not succeed on retry is retired immediately
 * instead: copied to the dead-letter queue, then deleted from the source. The
 * evidence an operator needs is in the same place it would have been, the
 * `*-dlq-depth` alarm still fires, and the ten minutes of oscillation are gone.
 */
import { DeleteMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';

/** How far to follow `cause` before giving up. Guards a cyclic chain. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when retrying this failure cannot change its outcome.
 *
 * Only an error that states `retryable: false` counts. Anything else -- an
 * unrecognised throw, a network fault, an error that carries no opinion -- is
 * treated as retryable, so an unclassified failure keeps exactly the behavior
 * it has today and reaches the dead-letter queue the slow way. The bias is
 * deliberate: retiring a message that would have succeeded loses a
 * notification, and losing a notification is the one outcome this system may
 * not have.
 */
export function isTerminalFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object') return false;
    const carried = current as { retryable?: unknown; cause?: unknown };
    if (typeof carried.retryable === 'boolean') return !carried.retryable;
    current = carried.cause;
  }
  return false;
}

interface SqsMessageClient {
  send(command: unknown): Promise<unknown>;
}

export interface RetireMessageRequest {
  readonly client: SqsMessageClient;
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly receiptHandle: string;
  /** The message body, forwarded unchanged so a redrive replays the original. */
  readonly body: string;
}

/**
 * Moves a message the worker cannot process to its dead-letter queue.
 *
 * The copy happens before the delete, never the other way round. If the delete
 * fails after a successful copy the message is redelivered, fails again, and
 * is copied again -- duplicated evidence, which an operator can see through. If
 * the delete came first and the copy failed, the message would be gone with no
 * record, which an operator cannot.
 */
export async function retireMessage(
  request: RetireMessageRequest,
): Promise<void> {
  await request.client.send(
    new SendMessageCommand({
      QueueUrl: request.deadLetterQueueUrl,
      MessageBody: request.body,
    }),
  );
  await request.client.send(
    new DeleteMessageCommand({
      QueueUrl: request.queueUrl,
      ReceiptHandle: request.receiptHandle,
    }),
  );
}
