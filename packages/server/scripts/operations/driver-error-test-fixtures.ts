import { DrizzleQueryError } from 'drizzle-orm/errors';
import postgres from 'postgres';

/**
 * The published types declare `PostgresError(message?: string)`, but the driver
 * constructs it from the wire fields it received and copies them onto the
 * instance (postgres/src/errors.js). Building one the driver's way is what
 * makes an `instanceof` assertion meaningful rather than a shape check.
 */
const DriverError = postgres.PostgresError as unknown as new (
  fields: Readonly<Record<string, string>>,
) => Error;

/**
 * A unique-constraint violation carrying every field redaction must suppress:
 * a message quoting the conflict, a `detail` and `hint` holding a member
 * address, and a `where` holding the statement. The allowlisted fields are the
 * only ones that may survive being described.
 */
export function driverFailureFixture(): Error {
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

/** The strings a described driver failure must never contain. */
export const DRIVER_FAILURE_LEAKS = Object.freeze([
  'duplicate key value',
  'staff@example.invalid',
  'A member with that address',
  'INSERT INTO access_group_members',
] as const);

/** The statement text and bound parameters a query wrapper carries. */
export const WRAPPED_STATEMENT =
  'INSERT INTO access_group_members (email) VALUES ($1)';
export const WRAPPED_PARAMETERS = Object.freeze(['staff@example.invalid']);

/** Every value carried only by the raw driver error or drizzle wrapper. */
export const WRAPPED_DRIVER_FAILURE_LEAKS = Object.freeze([
  ...DRIVER_FAILURE_LEAKS,
  WRAPPED_STATEMENT,
  ...WRAPPED_PARAMETERS,
  'Failed query',
  'params:',
] as const);

/**
 * A failure shaped as drizzle actually delivers one.
 *
 * Every failed query arrives wrapped: the real error is the `cause`, and the
 * wrapper's own message is `Failed query: <statement>\nparams: <parameters>`,
 * with both also kept on `query` and `params`. Tests that build a bare
 * `PostgresError` never see that wrapper and so cannot catch a leak through it.
 */
export function wrappedDriverFailureFixture(cause: Error): Error {
  return new DrizzleQueryError(
    WRAPPED_STATEMENT,
    [...WRAPPED_PARAMETERS],
    cause,
  );
}

/** A connection-level failure, which carries an errno rather than a SQLSTATE. */
export function connectionFailureFixture(): Error {
  return Object.assign(new Error('getaddrinfo ENOTFOUND'), {
    name: 'DNSException',
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
  });
}
