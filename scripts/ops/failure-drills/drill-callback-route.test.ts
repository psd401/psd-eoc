import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  authorizeSyntheticCallbackRequest,
  createSyntheticCallbackRequest,
} from './drill-callback-route';

const ENVIRONMENT = {
  AWS_ACCOUNT_ID: '111111111111',
  AWS_REGION: 'us-west-2',
  GOOGLE_OIDC_APPLICATION_ORIGIN:
    'https://synthetic.us-west-2.awsapprunner.com',
  GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
  PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
  PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN: 'synthetic-operator-token',
  PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
  PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
} as const;
const previous = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [name, value] of Object.entries(ENVIRONMENT)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const name of Object.keys(ENVIRONMENT)) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previous.clear();
});

describe('deployed synthetic callback route', () => {
  test('uses one validated drill account for SNS and SES correlation', async () => {
    const outer = new Request(
      `${ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN}/api/failure-drills/callback`,
      {
        headers: {
          Authorization: `Bearer ${ENVIRONMENT.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN}`,
        },
      },
    );
    const boundary = authorizeSyntheticCallbackRequest(outer);
    const topicArn = `arn:aws:sns:${boundary.region}:${boundary.accountId}:synthetic-failure-drill`;
    const callback = createSyntheticCallbackRequest(
      boundary.origin,
      boundary.accountId,
      boundary.region,
      topicArn,
      '00000000-0000-4000-8000-000000000071',
      '2026-08-26T12:00:00.000Z',
      {
        id: '00000000-0000-4000-8000-000000000072',
        endpointId: '00000000-0000-4000-8000-000000000073',
        rosterSnapshotId: '00000000-0000-4000-8000-000000000074',
        recipientId: '00000000-0000-4000-8000-000000000075',
        templateMode: 'drill',
        eventKind: 'drill',
      },
    );
    const envelope = (await callback.json()) as Readonly<{
      Message: string;
      TopicArn: string;
    }>;
    const message = JSON.parse(envelope.Message) as Readonly<{
      mail: Readonly<{ sendingAccountId: string }>;
    }>;
    expect(envelope.TopicArn).toBe(topicArn);
    expect(message.mail.sendingAccountId).toBe(boundary.accountId);
  });

  test('fails closed when the App Runner account identity is absent', () => {
    delete process.env.AWS_ACCOUNT_ID;
    expect(() =>
      authorizeSyntheticCallbackRequest(
        new Request(
          `${ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN}/api/failure-drills/callback`,
          {
            headers: {
              Authorization: `Bearer ${ENVIRONMENT.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN}`,
            },
          },
        ),
      ),
    ).toThrow('boundary is unavailable');
  });
});
