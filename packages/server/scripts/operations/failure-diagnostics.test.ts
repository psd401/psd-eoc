import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  describeFailure,
  invalidConfigurationFields,
  singleLine,
} from './failure-diagnostics';

const PREFIX = 'Database bootstrap failed closed.';

describe('describeFailure', () => {
  test('names the thrown error rather than discarding it', () => {
    const error = new Error('Invalid bootstrap configuration: DATABASE_HOST.');
    error.name = 'BootstrapConfigurationError';
    const [headline, ...stack] = describeFailure(PREFIX, error).split('\n');

    expect(headline).toBe(
      `${PREFIX} name=BootstrapConfigurationError` +
        ' message=Invalid bootstrap configuration: DATABASE_HOST.',
    );
    expect(stack.join('\n')).toContain('failure-diagnostics.test.ts');
  });

  test('reports a driver code alongside the message', () => {
    const error = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });

    expect(describeFailure(PREFIX, error).split('\n')[0]).toBe(
      `${PREFIX} name=Error code=ECONNREFUSED message=connection refused`,
    );
  });

  test('keeps the message on one line so it cannot forge a log record', () => {
    const forged = '{"event":"access-membership-sync-complete"}';

    const lines = describeFailure(PREFIX, new Error(`first\n${forged}`)).split(
      '\n',
    );

    expect(lines[0]).toBe(`${PREFIX} name=Error message=first ${forged}`);
    // Every remaining line is a call frame, so the newline in the message
    // cannot reappear below the headline and forge a second record.
    expect(lines.slice(1).every((line) => /^\s+at\s/u.test(line))).toBe(true);
  });

  test('bounds an unbounded message and stack', () => {
    const error = new Error('x'.repeat(5_000));
    error.stack = [
      'Error: boom',
      ...Array(400).fill('    at frame (a.ts:1:1)'),
    ].join('\n');
    const [headline, ...stack] = describeFailure(PREFIX, error).split('\n');

    expect(headline).toHaveLength(`${PREFIX} name=Error message=`.length + 300);
    expect(stack.join('\n')).toHaveLength(2_000);
  });

  test('drops a stack that carries no call frames', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\nnot a frame';

    expect(describeFailure(PREFIX, error)).toBe(
      `${PREFIX} name=Error message=boom`,
    );
  });

  test('describes a value thrown in place of an error', () => {
    expect(describeFailure(PREFIX, 'boom')).toBe(`${PREFIX} value=boom`);
    expect(describeFailure(PREFIX, undefined)).toBe(
      `${PREFIX} value=undefined`,
    );
    expect(describeFailure(PREFIX, 7)).toBe(`${PREFIX} value=7`);
  });

  test('omits fields the error does not carry', () => {
    expect(describeFailure(PREFIX, Object.create(null))).toBe(PREFIX);
  });
});

describe('singleLine', () => {
  test('collapses every newline form and truncates', () => {
    expect(singleLine('a\r\nb\n\nc', 64)).toBe('a b c');
    expect(singleLine('abcdef', 3)).toBe('abc');
  });
});

describe('invalidConfigurationFields', () => {
  const Schema = z
    .object({ DATABASE_HOST: z.string(), SOURCE_SHA: z.string() })
    .strict();

  function fieldsFor(value: unknown): readonly string[] {
    const parsed = Schema.safeParse(value);
    if (parsed.success) {
      throw new Error('expected the schema to refuse this value');
    }
    return invalidConfigurationFields(parsed.error);
  }

  test('names a field whose value is missing or malformed', () => {
    expect(fieldsFor({ SOURCE_SHA: 'abc' })).toEqual(['DATABASE_HOST']);
  });

  test('names the keys a strict schema did not recognize', () => {
    // A `.strict()` refusal carries an empty path and puts the offending names
    // under `keys`. Reading `path[0]` alone reported no field at all, so a
    // deployment passing a variable the running image had never heard of
    // failed with a message that blamed nothing.
    expect(
      fieldsFor({
        DATABASE_HOST: 'host',
        SOURCE_SHA: 'abc',
        PSD_EOC_FACILITIES: 'a',
        PSD_EOC_NEIGHBORHOODS: 'b',
      }),
    ).toEqual(['PSD_EOC_FACILITIES', 'PSD_EOC_NEIGHBORHOODS']);
  });

  test('merges both kinds of refusal, sorted and deduplicated', () => {
    expect(fieldsFor({ DATABASE_HOST: 1, PSD_EOC_FACILITIES: 'a' })).toEqual([
      'DATABASE_HOST',
      'PSD_EOC_FACILITIES',
      'SOURCE_SHA',
    ]);
  });
});
