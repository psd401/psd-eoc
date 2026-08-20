/**
 * Moves an authorized notification batch from the delivery queue to the queue
 * for its channel.
 *
 * The dispatcher writes every channel's batch for one notification to a single
 * delivery queue in one SendMessageBatch. That is deliberate: if it wrote
 * straight to three channel queues and the second call failed, the outbox retry
 * would re-send to the queue that already succeeded. One queue means one
 * outcome, and this is the step that fans the result back out.
 *
 * It routes bytes. The body is forwarded exactly as received — this reads
 * `channel` to pick a destination and changes nothing else, because the batch
 * carries its own authorization and real/drill classification and a router has
 * no business touching either. Full contract validation is the channel worker's
 * job, at the boundary where it matters.
 *
 * Failures are reported per message with `batchItemFailures`, so one
 * unroutable batch does not drag its nine siblings back onto the queue.
 */
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const CHANNELS = Object.freeze(['email', 'push', 'sms']);
const MAX_BODY_BYTES = 256 * 1024;

const client = new SQSClient({});

/**
 * The destination queue for each channel, from the environment.
 *
 * Read once per invocation rather than at module load so a missing variable
 * fails the message and is retried, instead of killing every cold start with an
 * error that never reaches the delivery queue's dead-letter queue.
 */
function channelQueueUrls(environment) {
  const urls = new Map();
  for (const channel of CHANNELS) {
    const value = environment[`${channel.toUpperCase()}_QUEUE_URL`];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('A channel queue destination is unavailable.');
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('A channel queue destination is not a URL.');
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname.startsWith('sqs.')) {
      throw new Error('A channel queue destination is not an SQS queue.');
    }
    urls.set(channel, parsed.toString());
  }
  return urls;
}

/** The channel a batch names, or null when the body is not one we may route. */
function routableChannel(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return CHANNELS.includes(parsed.channel) ? parsed.channel : null;
}

export async function routeDeliveryBatches(event, dependencies = {}) {
  const send = dependencies.send ?? ((input) => client.send(input));
  const environment = dependencies.environment ?? process.env;
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) {
    return { batchItemFailures: [] };
  }

  const urls = channelQueueUrls(environment);
  const failures = [];
  for (const record of records) {
    const identifier = record?.messageId;
    if (typeof identifier !== 'string' || identifier.length === 0) {
      // Nothing to report a failure against; refusing the whole batch would
      // replay the messages that are fine.
      continue;
    }
    const channel = routableChannel(record?.body);
    if (channel === null) {
      // Deliberately not retried. A body this cannot read will not become
      // readable, and the delivery queue's redrive policy retains it for a
      // human after the configured receives.
      failures.push({ itemIdentifier: identifier });
      continue;
    }
    try {
      await send(
        new SendMessageCommand({
          MessageBody: record.body,
          QueueUrl: urls.get(channel),
        }),
      );
    } catch {
      failures.push({ itemIdentifier: identifier });
    }
  }
  return { batchItemFailures: failures };
}

export async function handler(event) {
  return routeDeliveryBatches(event);
}
