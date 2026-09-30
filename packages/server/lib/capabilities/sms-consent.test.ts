import { describe, expect, test } from 'bun:test';

import type { TrustedCapabilityInvocation } from './engine';
import {
  withRosterPublishOnConsentChange,
  type SmsConsentCapabilityRuntime,
  type SmsConsentCapabilityStore,
  type SmsConsentRosterPublisher,
} from './sms-consent';

const CONSENT_ID = '5b0f8d7e-2f7c-4a51-9d1e-3c6a2b8f4e10';
const RECORDED_AT = '2026-09-30T16:31:37.060Z';
const INVOCATION = {} as TrustedCapabilityInvocation;

const OUTPUTS = Object.freeze({
  'record-sms-consent': Object.freeze({
    consentId: CONSENT_ID,
    disclosureVersion: '2026-08-29',
    status: 'consented',
    recordedAt: RECORDED_AT,
  }),
  'withdraw-sms-consent': Object.freeze({
    consentId: CONSENT_ID,
    status: 'withdrawn',
    recordedAt: RECORDED_AT,
  }),
  'read-my-sms-consent': Object.freeze({ state: 'none' }),
});

function innerRuntime(
  execute: (capabilityId: keyof typeof OUTPUTS) => Promise<unknown> = (id) =>
    Promise.resolve(OUTPUTS[id]),
): SmsConsentCapabilityRuntime {
  return {
    store: {} as SmsConsentCapabilityStore,
    execute: ((capabilityId: keyof typeof OUTPUTS) =>
      execute(capabilityId)) as SmsConsentCapabilityRuntime['execute'],
    close: () => Promise.resolve(),
  };
}

function recordingPublisher(
  answer: () => ReturnType<SmsConsentRosterPublisher> = () =>
    Promise.resolve({
      kind: 'published',
      snapshotId: '0f6b2a52-8a0e-4f3e-9c1d-7e5a4b3c2d1e',
      completedAt: RECORDED_AT,
    }),
) {
  const calls: Parameters<SmsConsentRosterPublisher>[0][] = [];
  const publish: SmsConsentRosterPublisher = (change) => {
    calls.push(change);
    return answer();
  };
  return { calls, publish };
}

describe('SMS consent publishes the roster', () => {
  test('an opt-in publishes before the request answers', async () => {
    // The first school rollout: staff opted in, a drill ran twenty minutes
    // later, and their numbers were not in the snapshot it read.
    const publisher = recordingPublisher();
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(),
      publisher.publish,
      () => undefined,
    );

    const receipt = await runtime.execute('record-sms-consent', {}, INVOCATION);

    expect(receipt).toEqual(OUTPUTS['record-sms-consent']);
    expect(publisher.calls).toEqual([
      { consentId: CONSENT_ID, status: 'consented' },
    ]);
  });

  test('a withdrawal publishes so the number leaves the next snapshot', async () => {
    const publisher = recordingPublisher();
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(),
      publisher.publish,
      () => undefined,
    );

    await runtime.execute('withdraw-sms-consent', {}, INVOCATION);

    expect(publisher.calls).toEqual([
      { consentId: CONSENT_ID, status: 'withdrawn' },
    ]);
  });

  test('reading consent publishes nothing', async () => {
    const publisher = recordingPublisher();
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(),
      publisher.publish,
      () => undefined,
    );

    await runtime.execute('read-my-sms-consent', {}, INVOCATION);

    expect(publisher.calls).toEqual([]);
  });

  test('a consent that failed to record publishes nothing', async () => {
    const publisher = recordingPublisher();
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(() => Promise.reject(new Error('conflict'))),
      publisher.publish,
      () => undefined,
    );

    await expect(
      runtime.execute('record-sms-consent', {}, INVOCATION),
    ).rejects.toThrow('conflict');
    expect(publisher.calls).toEqual([]);
  });

  test('a failed publication keeps the recorded consent and is logged', async () => {
    // The consent is committed before the publication starts. Failing the
    // request would tell the person they are not signed up when they are.
    const logged: string[] = [];
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(),
      recordingPublisher(() => Promise.reject(new Error('lock timeout')))
        .publish,
      (line) => logged.push(line),
    );

    const receipt = await runtime.execute('record-sms-consent', {}, INVOCATION);

    expect(receipt).toEqual(OUTPUTS['record-sms-consent']);
    expect(logged.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        event: 'sms-consent-roster-publish-failed',
        consentId: CONSENT_ID,
        status: 'consented',
        errorName: 'Error',
      },
    ]);
  });

  test('a refused publication is logged with its guard codes', async () => {
    const logged: string[] = [];
    const runtime = withRosterPublishOnConsentChange(
      innerRuntime(),
      recordingPublisher(() =>
        Promise.resolve({
          kind: 'refused',
          outcome: 'rejected',
          errorCodes: ['EMPTY_BUILDING_GROUP'],
        }),
      ).publish,
      (line) => logged.push(line),
    );

    await runtime.execute('record-sms-consent', {}, INVOCATION);

    expect(logged.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        event: 'sms-consent-roster-publish-not-published',
        consentId: CONSENT_ID,
        status: 'consented',
        outcome: 'refused',
        rosterOutcome: 'rejected',
        errorCodes: ['EMPTY_BUILDING_GROUP'],
      },
    ]);
  });
});
