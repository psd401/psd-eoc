/**
 * Sends alarm notifications as ordinary email, through SES.
 *
 * SNS can email a subscriber directly, and that is how this started. It cost a
 * full working day. Every SNS email carries an unsubscribe link in its footer,
 * every subscription needs a confirmation click, and subscription state gets
 * stuck in ways the API reports success for: `Subscribe` returns "pending
 * confirmation" whether or not it sent anything, and a subscription can
 * deactivate itself without anything in CloudTrail to show for it. An alerting
 * path is the one thing that has to work while everything else is broken, and
 * that one has a one-click off switch sitting in the footer of every message it
 * sends.
 *
 * So the topics stay, the alarms stay, and only the last hop changes. This
 * function subscribes to both alarm topics and sends the mail itself: no
 * confirmation step, no subscription state, and no unsubscribe link for a mail
 * scanner or a mis-click to find.
 *
 * It sends operational alarms to the operations team. It is not the staff
 * notification path and shares nothing with it — different sender, no
 * configuration set, and no access to a roster or a recipient.
 */
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

const client = new SESv2Client({});
const MAX_BODY_CHARS = 60_000;

function requiredAddress(environment, name) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 320 ||
    !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(value)
  ) {
    throw new Error(`${name} is not a usable email address.`);
  }
  return value;
}

function recipients(environment) {
  const raw = environment.ALARM_TO_ADDRESSES;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('ALARM_TO_ADDRESSES is not configured.');
  }
  const parsed = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (parsed.length === 0 || parsed.length > 10) {
    throw new Error(
      'ALARM_TO_ADDRESSES must name between one and ten inboxes.',
    );
  }
  for (const address of parsed) {
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(address)) {
      throw new Error('ALARM_TO_ADDRESSES contains an unusable address.');
    }
  }
  return parsed;
}

/** A CloudWatch alarm payload, or null when the message is something else. */
function parseAlarm(message) {
  if (typeof message !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return typeof parsed.AlarmName === 'string' ? parsed : null;
}

function line(label, value) {
  return value === undefined || value === null || value === ''
    ? null
    : `${label}: ${String(value)}`;
}

export function formatAlarmEmail(record) {
  const sns = record?.Sns ?? {};
  const alarm = parseAlarm(sns.Message);
  if (alarm === null) {
    // Not an alarm shape. Forward it rather than drop it: an alerting path that
    // silently discards what it does not recognise is how an outage goes unseen.
    const subject =
      typeof sns.Subject === 'string' && sns.Subject.length > 0
        ? sns.Subject
        : 'PSD EOC notification';
    return {
      body: String(sns.Message ?? '').slice(0, MAX_BODY_CHARS),
      subject: subject.slice(0, 200),
    };
  }

  const state = String(alarm.NewStateValue ?? 'UNKNOWN');
  const name = String(alarm.AlarmName);
  // The ARN is the reliable source for the region; `Region` is a display name
  // like "US West (Oregon)" and is not usable in a console URL.
  const arnParts = String(alarm.AlarmArn ?? '').split(':');
  const region = arnParts.length > 3 ? arnParts[3] : '';
  const body = [
    line('Alarm', name),
    line('State', `${String(alarm.OldStateValue ?? '?')} -> ${state}`),
    line('Reason', alarm.NewStateReason),
    line('Time', alarm.StateChangeTime),
    line('Region', alarm.Region),
    line('Account', alarm.AWSAccountId),
    '',
    line('Description', alarm.AlarmDescription),
    '',
    region === ''
      ? null
      : `Console: https://${region}.console.aws.amazon.com/cloudwatch/deeplink.js?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`,
  ]
    .filter((value) => value !== null)
    .join('\n');

  return {
    body: body.slice(0, MAX_BODY_CHARS),
    subject: `[${state}] ${name}`.slice(0, 200),
  };
}

export async function mailAlarms(event, dependencies = {}) {
  const send = dependencies.send ?? ((input) => client.send(input));
  const environment = dependencies.environment ?? process.env;
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) {
    return { sent: 0 };
  }

  const from = requiredAddress(environment, 'ALARM_FROM_ADDRESS');
  const to = recipients(environment);

  let sent = 0;
  for (const record of records) {
    const { body, subject } = formatAlarmEmail(record);
    await send(
      new SendEmailCommand({
        Content: {
          Simple: {
            Body: { Text: { Charset: 'UTF-8', Data: body } },
            Subject: { Charset: 'UTF-8', Data: subject },
          },
        },
        Destination: { ToAddresses: to },
        FromEmailAddress: from,
      }),
    );
    sent += 1;
  }
  // Throwing on failure is deliberate: SNS retries a failed Lambda delivery,
  // and a dropped alarm is worse than a duplicate one.
  return { sent };
}

export async function handler(event) {
  return mailAlarms(event);
}
