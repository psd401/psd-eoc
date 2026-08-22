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
