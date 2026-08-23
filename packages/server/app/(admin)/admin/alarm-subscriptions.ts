import {
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import {
  AlarmTopicReadinessSchema,
  type AdminReadiness,
} from '@psd-eoc/contracts';
import { z } from 'zod';

const MAX_SUBSCRIPTION_PAGES = 10;
const ALARM_SUBSCRIPTION_DEADLINE_MS = 5_000;
const TOPIC_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn):sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$/u;
const SUBSCRIPTION_ID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

const subscriptionPageSchema = z
  .object({
    Subscriptions: z
      .array(
        z
          .object({
            SubscriptionArn: z.string().min(1).max(2_048),
          })
          .passthrough(),
      )
      .max(100)
      .optional(),
    NextToken: z.string().min(1).max(2_048).optional(),
  })
  .passthrough();

export const ALARM_TOPIC_ENVIRONMENT_KEYS = Object.freeze({
  operations: 'PSD_EOC_OPERATIONS_ALARM_TOPIC_ARN',
  critical: 'PSD_EOC_CRITICAL_ALARM_TOPIC_ARN',
} as const);

type AlarmTopicKind = keyof typeof ALARM_TOPIC_ENVIRONMENT_KEYS;
type ReadinessEnvironment = Readonly<Record<string, string | undefined>>;

export interface AlarmSubscriptionProvider {
  listSubscriptions(
    input: Readonly<{
      topicArn: string;
      nextToken?: string;
      abortSignal: AbortSignal;
    }>,
  ): Promise<unknown>;
}

async function withinDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error('The alarm subscription read timed out.');
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new Error('The alarm subscription read timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/** Counts confirmed subscriptions without retaining provider endpoints. */
export async function countConfirmedAlarmSubscriptions(
  provider: AlarmSubscriptionProvider,
  topicArn: string,
): Promise<number> {
  if (!TOPIC_ARN_PATTERN.test(topicArn)) {
    throw new Error('The alarm topic ARN is unavailable or invalid.');
  }

  const confirmedSubscriptionArns = new Set<string>();
  let nextToken: string | undefined;
  const seenTokens = new Set<string>();
  const abortSignal = AbortSignal.timeout(ALARM_SUBSCRIPTION_DEADLINE_MS);
  for (
    let pageNumber = 0;
    pageNumber < MAX_SUBSCRIPTION_PAGES;
    pageNumber += 1
  ) {
    const page = subscriptionPageSchema.parse(
      await withinDeadline(
        provider.listSubscriptions({
          topicArn,
          abortSignal,
          ...(nextToken === undefined ? {} : { nextToken }),
        }),
        abortSignal,
      ),
    );
    for (const subscription of page.Subscriptions ?? []) {
      const subscriptionArn = subscription.SubscriptionArn;
      if (
        subscriptionArn === 'PendingConfirmation' ||
        subscriptionArn === 'Deleted'
      ) {
        continue;
      }
      const subscriptionId = subscriptionArn.slice(topicArn.length + 1);
      if (
        !subscriptionArn.startsWith(`${topicArn}:`) ||
        !SUBSCRIPTION_ID_PATTERN.test(subscriptionId)
      ) {
        throw new Error('SNS returned an invalid alarm subscription identity.');
      }
      confirmedSubscriptionArns.add(subscriptionArn);
    }
    nextToken = page.NextToken;
    if (nextToken === undefined) return confirmedSubscriptionArns.size;
    if (seenTokens.has(nextToken)) {
      throw new Error('SNS repeated an alarm subscription cursor.');
    }
    seenTokens.add(nextToken);
  }
  throw new Error('SNS exceeded the bounded alarm subscription page limit.');
}

const defaultSnsClient = new SNSClient({ maxAttempts: 1 });
const defaultAlarmSubscriptionProvider: AlarmSubscriptionProvider = {
  listSubscriptions: ({ topicArn, nextToken, abortSignal }) =>
    defaultSnsClient.send(
      new ListSubscriptionsByTopicCommand({
        TopicArn: topicArn,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
      { abortSignal },
    ),
};

async function readTopic(
  kind: AlarmTopicKind,
  provider: AlarmSubscriptionProvider,
  environment: ReadinessEnvironment,
): Promise<AdminReadiness['alarmTopics'][number]> {
  try {
    const topicArn = environment[ALARM_TOPIC_ENVIRONMENT_KEYS[kind]];
    const confirmedSubscriberCount = await countConfirmedAlarmSubscriptions(
      provider,
      topicArn ?? '',
    );
    return AlarmTopicReadinessSchema.parse({
      kind,
      status: confirmedSubscriberCount > 0 ? 'ready' : 'action-required',
      confirmedSubscriberCount,
    });
  } catch {
    return AlarmTopicReadinessSchema.parse({
      kind,
      status: 'unavailable',
      confirmedSubscriberCount: null,
    });
  }
}

/** Reads both alarm topics independently so one provider error cannot mask the other. */
export async function readAlarmTopicReadiness(
  provider: AlarmSubscriptionProvider = defaultAlarmSubscriptionProvider,
  environment: ReadinessEnvironment = process.env,
): Promise<AdminReadiness['alarmTopics']> {
  return Promise.all([
    readTopic('operations', provider, environment),
    readTopic('critical', provider, environment),
  ]);
}
