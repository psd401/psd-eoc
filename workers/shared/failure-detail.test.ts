import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { failureDetail } from './failure-detail';

describe('worker failure detail', () => {
  test('a schema refusal names fields, never the value refused', () => {
    // The refused value here is a staff address and a provider token, which is
    // exactly what must not reach a log line.
    const result = z
      .object({ recipient: z.string().email(), token: z.string().min(64) })
      .safeParse({ recipient: 'not-an-address', token: 'short' });
    expect(result.success).toBe(false);
    const detail = failureDetail(result.success ? null : result.error);
    expect(detail).toContain('recipient');
    expect(detail).toContain('token');
    expect(detail).not.toContain('not-an-address');
    expect(detail).not.toContain('short');
  });

  test('repeats a bounded provider message', () => {
    expect(failureDetail(new Error('SES rejected the sender'))).toBe(
      'SES rejected the sender',
    );
    expect(failureDetail(new Error('x'.repeat(500))).length).toBeLessThan(320);
  });

  test('always says something', () => {
    expect(failureDetail(null)).toBe('no message');
    expect(failureDetail(new Error('   '))).toBe('no message');
    expect(failureDetail({ issues: [] })).toBe('schema refused the message');
  });
});
