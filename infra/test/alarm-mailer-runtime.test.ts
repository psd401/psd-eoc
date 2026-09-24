import { describe, expect, it, mock } from 'bun:test';

mock.module('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class SESv2Client {},
  SendEmailCommand: class SendEmailCommand {
    public constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const { formatAlarmEmail, mailAlarms } =
  await import('../lambda/alarm-mailer/index.mjs');

const ENVIRONMENT = Object.freeze({
  ALARM_FROM_ADDRESS: 'eoc-alarms@example.invalid',
  ALARM_TO_ADDRESSES: 'ops@example.invalid',
});

const ALARM = Object.freeze({
  AWSAccountId: '123456789012',
  AlarmArn:
    'arn:aws:cloudwatch:us-west-2:123456789012:alarm:psd-eoc-apprunner-5xx',
  AlarmDescription:
    'One or more App Runner 5xx responses occurred. Runbook: https://example.invalid/runbook',
  AlarmName: 'psd-eoc-apprunner-5xx',
  NewStateReason: 'Threshold crossed.',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  Region: 'US West (Oregon)',
  StateChangeTime: '2026-08-21T20:07:50.000+0000',
});

function record(message: unknown, subject?: string) {
  return {
    Sns: {
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(subject === undefined ? {} : { Subject: subject }),
    },
  };
}

type Sent = { readonly input: Record<string, unknown> };

function collector() {
  const sent: Sent[] = [];
  return {
    sent,
    send: (command: unknown) => {
      sent.push(command as Sent);
      return Promise.resolve({ MessageId: 'synthetic' });
    },
  };
}

describe('alarm mailer', () => {
  it('sends one SES email per alarm, from and to the configured addresses', async () => {
    const { sent, send } = collector();
    const result = await mailAlarms(
      { Records: [record(ALARM)] },
      { environment: ENVIRONMENT, send },
    );

    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const input = sent[0]?.input ?? {};
    expect(input.FromEmailAddress).toBe('eoc-alarms@example.invalid');
    expect(input.Destination).toEqual({ ToAddresses: ['ops@example.invalid'] });
    // No configuration set: this is operational mail and must not be entangled
    // with the staff notification path's SES configuration.
    expect(input).not.toHaveProperty('ConfigurationSetName');
  });

  it('puts the state and alarm name in the subject and the detail in the body', () => {
    const { body, subject } = formatAlarmEmail(record(ALARM));
    expect(subject).toBe('[ALARM] psd-eoc-apprunner-5xx');
    expect(body).toContain('State: OK -> ALARM');
    expect(body).toContain('Threshold crossed.');
    expect(body).toContain('https://example.invalid/runbook');
    // Region for the console URL comes from the ARN, not the display name.
    expect(body).toContain(
      'https://us-west-2.console.aws.amazon.com/cloudwatch/deeplink.js?region=us-west-2#alarmsV2:alarm/psd-eoc-apprunner-5xx',
    );
    expect(body).not.toContain('US%20West');
  });

  it('carries no unsubscribe link, which is the entire point', async () => {
    const { sent, send } = collector();
    await mailAlarms(
      { Records: [record(ALARM)] },
      { environment: ENVIRONMENT, send },
    );
    const serialized = JSON.stringify(sent[0]?.input ?? {});
    expect(serialized.toLowerCase()).not.toContain('unsubscribe');
    expect(serialized).not.toContain('sns.us-west-2.amazonaws.com');
  });

  it('forwards a message it cannot parse rather than dropping it', () => {
    const { body, subject } = formatAlarmEmail(
      record('not json at all', 'Something happened'),
    );
    expect(subject).toBe('Something happened');
    expect(body).toBe('not json at all');
  });

  it('refuses to run without usable addresses', async () => {
    const { sent, send } = collector();
    for (const environment of [
      {},
      { ALARM_FROM_ADDRESS: 'not-an-address', ALARM_TO_ADDRESSES: 'a@b.co' },
      { ALARM_FROM_ADDRESS: 'a@b.co' },
      { ALARM_FROM_ADDRESS: 'a@b.co', ALARM_TO_ADDRESSES: '' },
      { ALARM_FROM_ADDRESS: 'a@b.co', ALARM_TO_ADDRESSES: 'nope' },
    ]) {
      await expect(
        mailAlarms({ Records: [record(ALARM)] }, { environment, send }),
      ).rejects.toThrow();
    }
    expect(sent).toHaveLength(0);
  });

  it('sends to every configured inbox', async () => {
    const { sent, send } = collector();
    await mailAlarms(
      { Records: [record(ALARM)] },
      {
        environment: {
          ...ENVIRONMENT,
          ALARM_TO_ADDRESSES: ' ops@example.invalid , oncall@example.invalid ',
        },
        send,
      },
    );
    expect(sent[0]?.input.Destination).toEqual({
      ToAddresses: ['ops@example.invalid', 'oncall@example.invalid'],
    });
  });

  it('does nothing for an empty event', async () => {
    const { sent, send } = collector();
    for (const event of [{}, { Records: [] }, null]) {
      expect(
        (await mailAlarms(event, { environment: ENVIRONMENT, send })).sent,
      ).toBe(0);
    }
    expect(sent).toHaveLength(0);
  });

  it('propagates a send failure so SNS retries instead of losing the alarm', async () => {
    await expect(
      mailAlarms(
        { Records: [record(ALARM)] },
        {
          environment: ENVIRONMENT,
          send: () => Promise.reject(new Error('synthetic SES failure')),
        },
      ),
    ).rejects.toThrow('synthetic SES failure');
  });
});
