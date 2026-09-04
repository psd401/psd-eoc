import { describe, expect, test } from 'bun:test';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import {
  handleRecordSmsConsentAction,
  handleWithdrawSmsConsentAction,
  type TextAlertsActionDependencies,
} from './action-handlers';
import type { TextAlertsState } from './text-alerts-view';

const STATE: TextAlertsState = Object.freeze({
  notice: null,
  idempotencyKey: 'key-one',
});

interface Harness {
  readonly dependencies: TextAlertsActionDependencies;
  readonly recorded: {
    phoneNumber: string;
    disclosureVersion: string;
    idempotencyKey: string;
  }[];
  readonly withdrawn: { idempotencyKey: string }[];
  readonly revalidations: number[];
}

function harness(
  overrides: Partial<TextAlertsActionDependencies> = {},
): Harness {
  const recorded: Harness['recorded'] = [];
  const withdrawn: Harness['withdrawn'] = [];
  const revalidations: number[] = [];
  let keys = 0;
  const dependencies: TextAlertsActionDependencies = {
    async recordConsent(input) {
      recorded.push({ ...input });
      return {
        consentId: '11111111-1111-4111-8111-111111111111',
        disclosureVersion: input.disclosureVersion,
        status: 'consented',
        recordedAt: '2026-09-04T00:00:00.000Z',
      };
    },
    async withdrawConsent(input) {
      withdrawn.push({ ...input });
      return {
        consentId: '11111111-1111-4111-8111-111111111111',
        status: 'withdrawn',
        recordedAt: '2026-09-04T00:00:00.000Z',
      };
    },
    createIdempotencyKey: () => `fresh-${++keys}`,
    revalidate: () => revalidations.push(1),
    ...overrides,
  };
  return { dependencies, recorded, withdrawn, revalidations };
}

function form(entries: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

const VALID = Object.freeze({
  phoneNumber: '(253) 555-0123',
  disclosureVersion: '2026-09-04',
  agreed: 'yes',
});

describe('recording SMS consent from the web form', () => {
  test('normalizes the typed number and records it once', async () => {
    const { dependencies, recorded, revalidations } = harness();

    const next = await handleRecordSmsConsentAction(
      STATE,
      form(VALID),
      dependencies,
    );

    expect(recorded).toEqual([
      {
        phoneNumber: '+12535550123',
        disclosureVersion: '2026-09-04',
        idempotencyKey: 'key-one',
      },
    ]);
    expect(next.notice?.kind).toBe('success');
    expect(revalidations).toHaveLength(1);
  });

  test('issues a new idempotency key so the next submit is not a replay', async () => {
    const { dependencies } = harness();

    const next = await handleRecordSmsConsentAction(
      STATE,
      form(VALID),
      dependencies,
    );

    expect(next.idempotencyKey).not.toBe(STATE.idempotencyKey);
  });

  test('refuses an unticked agreement box and records nothing', async () => {
    const { dependencies, recorded } = harness();
    const data = form({
      phoneNumber: VALID.phoneNumber,
      disclosureVersion: VALID.disclosureVersion,
    });

    const next = await handleRecordSmsConsentAction(STATE, data, dependencies);

    expect(recorded).toEqual([]);
    expect(next.notice?.kind).toBe('error');
    expect(next.notice?.message).toContain('Tick the box');
  });

  test('refuses a number that is not a usable US mobile number', async () => {
    const { dependencies, recorded } = harness();

    const next = await handleRecordSmsConsentAction(
      STATE,
      form({ ...VALID, phoneNumber: '555-0123' }),
      dependencies,
    );

    expect(recorded).toEqual([]);
    expect(next.notice?.kind).toBe('error');
  });

  test('never echoes the submitted number back to the browser', async () => {
    const { dependencies } = harness({
      recordConsent: async () => {
        throw new CapabilityEngineError(
          'CONFLICT',
          'PERSISTENCE_CONFLICT',
          'The consent could not be recorded.',
          409,
        );
      },
    });

    const rejected = await handleRecordSmsConsentAction(
      STATE,
      form({ ...VALID, phoneNumber: '(360) 555-0199' }),
      dependencies,
    );
    const invalid = await handleRecordSmsConsentAction(
      STATE,
      form({ ...VALID, phoneNumber: '360-555-0199x' }),
      dependencies,
    );

    // Asserts on what the caller actually submitted. The invalid-number copy
    // deliberately contains a fixed example number, so a blanket digit check
    // here would pass or fail for the wrong reason.
    for (const message of [rejected.notice?.message, invalid.notice?.message]) {
      expect(message).not.toContain('0199');
      expect(message).not.toContain('360');
      expect(message).not.toContain('+13605550199');
    }
  });

  test('surfaces the capability failure without revalidating', async () => {
    const { dependencies, revalidations } = harness({
      recordConsent: async () => {
        throw new CapabilityEngineError(
          'CONFLICT',
          'PERSISTENCE_CONFLICT',
          'The previous consent changed while this one was being recorded.',
          409,
        );
      },
    });

    const next = await handleRecordSmsConsentAction(
      STATE,
      form(VALID),
      dependencies,
    );

    expect(next.notice).toEqual({
      kind: 'error',
      message:
        'The previous consent changed while this one was being recorded.',
    });
    expect(revalidations).toEqual([]);
  });
});

describe('withdrawing SMS consent from the web form', () => {
  test('withdraws with the pending key and refreshes the page', async () => {
    const { dependencies, withdrawn, revalidations } = harness();

    const next = await handleWithdrawSmsConsentAction(
      STATE,
      form({}),
      dependencies,
    );

    expect(withdrawn).toEqual([{ idempotencyKey: 'key-one' }]);
    expect(next.notice?.kind).toBe('success');
    expect(revalidations).toHaveLength(1);
  });

  test('reports a missing live consent instead of claiming success', async () => {
    const { dependencies, revalidations } = harness({
      withdrawConsent: async () => {
        throw new CapabilityEngineError(
          'NOT_FOUND',
          'PERSISTENCE_CONFLICT',
          'There is no live SMS consent to withdraw.',
          404,
        );
      },
    });

    const next = await handleWithdrawSmsConsentAction(
      STATE,
      form({}),
      dependencies,
    );

    expect(next.notice).toEqual({
      kind: 'error',
      message: 'There is no live SMS consent to withdraw.',
    });
    expect(revalidations).toEqual([]);
  });
});
