import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { failureDetail } from './failure-detail';

describe('worker failure detail', () => {
  test('never echoes an error message', () => {
    // A delivery failure often originates at a provider, and a
    // provider-controlled string can carry the token or recipient the message
    // was for. The class and code identify the failure without it.
    const detail = failureDetail(
      Object.assign(new Error('ExponentPushToken[abc] was rejected'), {
        name: 'ExpoPushError',
        code: 'DEVICE_NOT_REGISTERED',
      }),
    );
    expect(detail).not.toContain('ExponentPushToken');
    expect(detail).not.toContain('rejected');
    expect(detail).toContain('ExpoPushError');
    expect(detail).toContain('DEVICE_NOT_REGISTERED');
  });

  test('carries the classification these clients actually set', () => {
    // EmailRuntimeClientError raises one fixed sentence and puts the useful
    // part in a code, so the code is the only thing that identifies it.
    const detail = failureDetail(
      Object.assign(new Error('The email runtime request failed safely.'), {
        name: 'EmailRuntimeClientError',
        code: 'RETRYABLE_RESPONSE',
        status: 503,
      }),
    );
    expect(detail).toBe(
      'EmailRuntimeClientError — code RETRYABLE_RESPONSE — status 503',
    );
  });

  test('a schema refusal names fields, never the value refused', () => {
    const result = z
      .object({ recipient: z.string().email(), token: z.string().min(64) })
      .safeParse({ recipient: 'not-an-address', token: 'short' });
    expect(result.success).toBe(false);
    const detail = failureDetail(result.success ? null : result.error);
    expect(detail).toContain('recipient');
    expect(detail).toContain('token');
    expect(detail).not.toContain('not-an-address');
  });

  test('always says something', () => {
    expect(failureDetail(null)).toBe('unclassified failure');
    expect(failureDetail({ issues: [] })).toBe('schema refused the message');
  });
});
