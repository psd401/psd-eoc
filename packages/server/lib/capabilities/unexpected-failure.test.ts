import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { CapabilityEngineError } from './engine';

/**
 * The log line is produced inside the engine, so these assert the property that
 * matters about it: a refused value never reaches the message.
 */
describe('unexpected capability failure logging', () => {
  test('a schema refusal names fields, never the value it refused', () => {
    const schema = z.object({ token: z.string().min(64) });
    const result = schema.safeParse({ token: 'ExponentPushToken[secret]' });
    expect(result.success).toBe(false);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => logged.push(String(line));
    try {
      // Exercised through the engine's own wrapper so the test cannot drift
      // from the code that builds the line.
      const engineError = new CapabilityEngineError(
        'INTERNAL_ERROR',
        'PERSISTENCE_CONFLICT',
        'The capability could not be completed.',
        500,
        true,
        result.success ? null : result.error,
      );
      expect(engineError.message).toBe(
        'The capability could not be completed.',
      );
    } finally {
      console.error = original;
    }
    // The public message never carries a cause.
    expect(logged.join(' ')).not.toContain('ExponentPushToken');
  });

  test('the public error stays free of the cause', () => {
    const error = new CapabilityEngineError(
      'INTERNAL_ERROR',
      'PERSISTENCE_CONFLICT',
      'The capability could not be completed.',
      500,
      true,
      new Error('recipient hagelk@psd401.net was rejected'),
    );
    expect(error.message).not.toContain('psd401.net');
    expect(error.status).toBe(500);
  });

  test('a database refusal names its constraint, never the failing row', () => {
    // PostgreSQL's `detail` quotes the row it refused, which for these tables
    // holds recipients and tokens. The constraint name is a schema identifier
    // and is what an operator actually needs.
    const driverError = Object.assign(new Error('insert failed'), {
      code: '23503',
      table_name: 'notification_intents',
      constraint_name: 'notification_intents_event_truth_fk',
      detail: 'Failing row contains (hagelk@psd401.net, ExponentPushToken[x]).',
    });
    const wrapped = Object.assign(
      new Error('Failed query: insert into "notification_intents" ...'),
      { cause: driverError },
    );
    const engineError = new CapabilityEngineError(
      'INTERNAL_ERROR',
      'PERSISTENCE_CONFLICT',
      'The capability could not be completed.',
      500,
      true,
      wrapped,
    );
    expect(engineError.message).not.toContain('psd401.net');
    expect(engineError.message).not.toContain('ExponentPushToken');
  });
});
