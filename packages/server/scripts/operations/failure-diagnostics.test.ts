import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { z } from 'zod';

import {
  describeDriverError,
  describeFailure,
  invalidConfigurationFields,
  isDriverError,
  singleLine,
  withReducedDriverErrors,
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
    expect(lines.slice(1).every((line) => /^\s+at\s/u.test(line))).toBe(true);
  });

  test('excises the message before reading frames, so none can be forged', () => {
    // The stack begins with `Name: message`, so a message carrying a newline
    // and a frame-shaped line would otherwise emit it as a genuine frame.
    const error = new Error('boom\n    at totallyReal (production.ts:1:1)');
    const frames = describeFailure(PREFIX, error).split('\n').slice(1);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain('    at totallyReal (production.ts:1:1)');
    expect(frames.join('\n')).toContain('failure-diagnostics.test.ts');
  });

  test('collapses every character a log reader may treat as a break', () => {
    for (const character of [
      '\u0000',
      '\u000b',
      '\u000c',
      '\u001f',
      '\u007f',
      '\u0085',
      '\u2028',
      '\u2029',
    ]) {
      expect(singleLine(`a${character}b`, 64)).toBe('a b');
    }
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

describe('driver errors', () => {
  function postgresError(): Error {
    return Object.assign(new Error('invalid input syntax for type uuid: "x"'), {
      name: 'PostgresError',
      code: '22P02',
      severity: 'ERROR',
      routine: 'string_to_uuid',
      schema_name: 'public',
      table_name: 'access_group_members',
      constraint_name: 'access_group_members_pkey',
      detail: 'Key (email)=(staff@example.invalid) already exists.',
      hint: 'Perhaps you meant to reference the column "t.email".',
      where: 'PL/pgSQL function inline_code_block line 3',
      query: "ALTER ROLE x WITH PASSWORD 'SECRET-PASSWORD-VALUE'",
    });
  }

  test('recognizes a driver error by name, or by SQLSTATE with severity', () => {
    expect(isDriverError(postgresError())).toBe(true);
    expect(
      isDriverError(
        Object.assign(new Error('x'), { code: '42501', severity: 'ERROR' }),
      ),
    ).toBe(true);
    expect(isDriverError(new Error('authored'))).toBe(false);
    expect(
      isDriverError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ).toBe(false);
  });

  test('never mistakes a Node errno code for a SQLSTATE', () => {
    // These are all exactly five uppercase characters. Classifying one as a
    // driver error would suppress the message naming the path or endpoint at
    // fault, and this container runs on a read-only root filesystem reading a
    // certificate by path, so they are reachable.
    for (const code of [
      'EPIPE',
      'EPERM',
      'EBUSY',
      'EROFS',
      'EBADF',
      'EINTR',
      'ESRCH',
      'EXDEV',
      'ENXIO',
      'ELOOP',
      'EIDRM',
    ]) {
      const error = Object.assign(new Error(`write ${code} /etc/rds-ca.pem`), {
        code,
      });

      expect(isDriverError(error)).toBe(false);
      expect(describeFailure(PREFIX, error)).toContain(
        `message=write ${code} /etc/rds-ca.pem`,
      );
    }
  });

  test('reduces a driver error to allowlisted fields', () => {
    // The names are the driver's, not the wire protocol's: postgres.js maps
    // the server's s/t/c/n fields to schema_name/table_name/column_name/
    // constraint_name, so the shorter names matched nothing at all.
    expect(describeDriverError(postgresError())).toBe(
      ' code=22P02 severity=ERROR routine=string_to_uuid schema_name=public' +
        ' table_name=access_group_members' +
        ' constraint_name=access_group_members_pkey',
    );
  });

  test('ignores the source position Bun hangs on every error', () => {
    // Bun sets `line` and `column` on errors as JavaScript source offsets.
    // Allowlisting `column` surfaced one as though it named a database column.
    const error = Object.assign(new Error('x'), {
      name: 'PostgresError',
      code: '42601',
      severity: 'ERROR',
      column: '21',
      line: '331',
    });

    expect(describeDriverError(error)).toBe(' code=42601 severity=ERROR');
  });

  test('never describes a driver error by its message', () => {
    // migrate, seedReference, bootstrapAccess, and the access-sync capability
    // all run SQL through the connection directly rather than through the
    // bootstrap statement executor, so an unreduced driver error reaches here.
    const described = describeFailure(PREFIX, postgresError());

    expect(described.split('\n')[0]).toBe(
      `${PREFIX} name=PostgresError code=22P02 severity=ERROR` +
        ' routine=string_to_uuid schema_name=public' +
        ' table_name=access_group_members' +
        ' constraint_name=access_group_members_pkey',
    );
    for (const leak of [
      'invalid input syntax',
      'staff@example.invalid',
      'Perhaps you meant',
      'PL/pgSQL function',
      'SECRET-PASSWORD-VALUE',
    ]) {
      expect(described).not.toContain(leak);
    }
  });
});

describe('hostile error objects', () => {
  test('does not throw when an accessor throws', () => {
    // Escaping the caller's catch would hand the raw error to the runtime's
    // default handler, which prints enumerable own properties — including the
    // detail and hint fields the allowlist exists to suppress.
    const hostile = new Error('x');
    for (const key of ['name', 'message', 'stack', 'code']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error('getter exploded');
        },
        configurable: true,
      });
    }

    expect(describeFailure(PREFIX, hostile)).toBe(PREFIX);
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

  test('falls back to issue codes when no issue names a field', () => {
    // A root-level refusal carries an empty path and is not an unrecognized
    // key, so collecting only named fields reproduced the very bug this
    // function exists to fix: a refusal that blamed nothing at all.
    expect(fieldsFor('not an object at all')).toEqual(['invalid_type']);
  });

  test('merges both kinds of refusal, sorted and deduplicated', () => {
    expect(fieldsFor({ DATABASE_HOST: 1, PSD_EOC_FACILITIES: 'a' })).toEqual([
      'DATABASE_HOST',
      'PSD_EOC_FACILITIES',
      'SOURCE_SHA',
    ]);
  });
});

describe('withReducedDriverErrors', () => {
  // The published types declare `PostgresError(message?: string)`, but the
  // driver constructs it from the wire fields it received and copies them onto
  // the instance (src/errors.js). Building it the driver's way is what makes
  // `instanceof` meaningful here.
  const DriverError = postgres.PostgresError as unknown as new (
    fields: Readonly<Record<string, string>>,
  ) => Error;

  /** Built the way the driver builds one, from the wire fields it received. */
  function driverFailure(): Error {
    return new DriverError({
      severity: 'ERROR',
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      detail: 'Key (email)=(staff@example.invalid) already exists.',
      hint: 'A member with that address is already recorded.',
      where: 'SQL statement "INSERT INTO access_group_members"',
      schema_name: 'public',
      table_name: 'access_group_members',
      constraint_name: 'access_group_members_pkey',
      routine: '_bt_check_unique',
    });
  }

  test('reduces a driver error at the step that raised it', async () => {
    const rejected = withReducedDriverErrors('reference seed', () =>
      Promise.reject(driverFailure()),
    );

    await expect(rejected).rejects.toThrow(
      'The reference seed step failed in the database. code=23505' +
        ' severity=ERROR routine=_bt_check_unique schema_name=public' +
        ' table_name=access_group_members' +
        ' constraint_name=access_group_members_pkey',
    );
  });

  test('leaves nothing for describeFailure to have to recognize', async () => {
    // The point of reducing here rather than at the log: what reaches the entry
    // point is an authored error, so redaction no longer depends on a guess.
    const error = await withReducedDriverErrors('migration', () =>
      Promise.reject(driverFailure()),
    ).catch((raised: unknown) => raised as object);

    expect(error instanceof postgres.PostgresError).toBe(false);
    expect(isDriverError(error)).toBe(false);
    for (const leak of [
      'duplicate key value',
      'staff@example.invalid',
      'A member with that address',
      'INSERT INTO access_group_members',
    ]) {
      expect(describeFailure(PREFIX, error)).not.toContain(leak);
    }
  });

  test('rethrows a non-driver failure untouched', async () => {
    // Reducing these too would recreate the errno regression: the message is
    // the only thing naming the file or endpoint at fault.
    const authored = new Error('Google Cloud Identity refused the request.');
    const errno = Object.assign(
      new Error('EROFS: read-only file system, open /etc/rds-ca.pem'),
      { code: 'EROFS' },
    );

    for (const original of [authored, errno]) {
      const raised = await withReducedDriverErrors('access bootstrap', () =>
        Promise.reject(original),
      ).catch((error: unknown) => error);

      expect(raised).toBe(original);
      expect(describeFailure(PREFIX, raised)).toContain(
        `message=${original.message}`,
      );
    }
  });

  test('returns the value when the step succeeds', async () => {
    await expect(
      withReducedDriverErrors('migration', () => Promise.resolve({ ok: 7 })),
    ).resolves.toEqual({ ok: 7 });
  });
});
