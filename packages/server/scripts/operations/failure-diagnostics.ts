import type { z } from 'zod';

const MAX_LABEL_CHARS = 64;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 2_000;

/**
 * Every character a log reader may treat as ending a record: the C0 controls,
 * DEL, NEL, and the Unicode line and paragraph separators. Collapsing only CR
 * and LF left U+2028, U+2029, U+0085, VT, FF, and NUL intact, so a value
 * carrying one could still render as a second record downstream.
 */
// eslint-disable-next-line no-control-regex -- stripping them is the point
const LINE_BREAKING = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/gu;

/** Collapses a value onto one line so it cannot forge a second log record. */
export function singleLine(value: string, maximum: number): string {
  return value.replace(LINE_BREAKING, ' ').slice(0, maximum);
}

/**
 * The fields of a driver error that carry no caller data.
 *
 * `message`, `detail`, `hint`, and `where` can echo a rejected value, and
 * postgres.js hangs the statement text on `query` — which for the bootstrap
 * role DDL is the application password literal. This is an allowlist for that
 * reason: `PostgresError` copies every field the server sent onto itself, so
 * anything not named here must be assumed to carry a value.
 */
const SAFE_DRIVER_ERROR_FIELDS = Object.freeze([
  'code',
  'severity',
  'routine',
  'schema',
  'table',
  'column',
  'constraint',
] as const);

const SQLSTATE = /^[0-9A-Z]{5}$/u;

/** Reads a string property without letting an exotic accessor escape. */
function readString(source: object, key: string): string | undefined {
  try {
    const value = Reflect.get(source, key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an error came from the database driver, and so must be reduced to
 * allowlisted fields rather than described by its message.
 */
export function isDriverError(error: object): boolean {
  const code = readString(error, 'code');
  return (
    readString(error, 'name') === 'PostgresError' ||
    (code !== undefined && SQLSTATE.test(code))
  );
}

/** Reduces a driver error to its allowlisted, bounded fields. */
export function describeDriverError(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  return SAFE_DRIVER_ERROR_FIELDS.map((field) => {
    const value = readString(error, field);
    return value === undefined
      ? ''
      : ` ${field}=${singleLine(value, MAX_LABEL_CHARS)}`;
  }).join('');
}

/** Reports an authored error in full; nothing on that path echoes a value. */
function describeAuthoredError(
  error: object,
  message: string | undefined,
): string {
  const code = readString(error, 'code');
  return (
    (code === undefined ? '' : ` code=${singleLine(code, MAX_LABEL_CHARS)}`) +
    (message === undefined
      ? ''
      : ` message=${singleLine(message, MAX_MESSAGE_CHARS)}`)
  );
}

/**
 * The call frames of a stack, with the leading `Name: message` header removed.
 *
 * The header repeats the message verbatim and uncollapsed, so a message
 * containing a newline followed by `    at ...` would otherwise emit a line
 * that passes the frame filter and reads as a genuine frame. Excising the
 * message itself, rather than matching a header pattern, is what makes that
 * impossible.
 */
function stackFrames(stack: string, message: string | undefined): string {
  const start =
    message !== undefined && stack.includes(message)
      ? stack.indexOf(message) + message.length
      : 0;
  return stack
    .slice(start)
    .split('\n')
    .filter((line) => /^\s+at\s/u.test(line))
    .join('\n')
    .slice(0, MAX_STACK_CHARS);
}

/**
 * Names a failure without reflecting the input that caused it.
 *
 * These scripts run unattended in ECS, where the only evidence a failure leaves
 * is what it wrote before exiting. Discarding the error rendered every failure
 * as one indistinguishable line, so a failed run could be told apart only by
 * reproducing it out of band.
 *
 * A driver error is described by its allowlisted fields and never by its
 * message, because the paths reaching here are not all funnelled through the
 * bootstrap statement executor: `migrate`, `seedReference`, `bootstrapAccess`,
 * and the whole access-sync capability run SQL through the connection directly,
 * and Postgres echoes a rejected value into `message` for a class of errors.
 * Authored messages — a configuration refusal naming environment variables, or
 * the executor's own summary — carry no value and are reported in full.
 *
 * This function does not throw. A hostile accessor on the error would otherwise
 * escape the caller's catch and reach the runtime's default handler, which
 * prints enumerable own properties and would publish the very `detail` and
 * `hint` fields the allowlist exists to suppress.
 */
export function describeFailure(prefix: string, error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    let rendered: string;
    try {
      rendered = String(error);
    } catch {
      rendered = 'unrenderable';
    }
    return `${prefix} value=${singleLine(rendered, MAX_MESSAGE_CHARS)}`;
  }
  const name = readString(error, 'name');
  const message = readString(error, 'message');
  const described =
    prefix +
    (name === undefined ? '' : ` name=${singleLine(name, MAX_LABEL_CHARS)}`) +
    (isDriverError(error)
      ? describeDriverError(error)
      : describeAuthoredError(error, message));
  const stack = readString(error, 'stack');
  const frames = stack === undefined ? '' : stackFrames(stack, message);
  return frames.length > 0 ? `${described}\n${frames}` : described;
}

/**
 * The configuration fields a Zod refusal blames.
 *
 * A `.strict()` schema reports an unrecognized key with an empty `path` and the
 * offending names under `keys`, so reading `path[0]` alone named nothing and
 * produced a refusal that blamed no field at all. Issue codes stand in when no
 * issue names a field, so the list is never empty and the refusal always says
 * something. Only names are collected; a rejected value never appears.
 */
export function invalidConfigurationFields(
  error: z.ZodError,
): readonly string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.add(key);
      }
      continue;
    }
    const [field] = issue.path;
    if (typeof field === 'string') {
      fields.add(field);
    }
  }
  if (fields.size === 0) {
    for (const issue of error.issues) {
      fields.add(issue.code);
    }
  }
  return Object.freeze([...fields].sort());
}
