import type { z } from 'zod';

const MAX_LABEL_CHARS = 64;
const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 2_000;

/** Collapses a value onto one line so it cannot forge a second log record. */
export function singleLine(value: string, maximum: number): string {
  return value.replace(/[\r\n]+/gu, ' ').slice(0, maximum);
}

/**
 * Names a failure without reflecting the input that caused it.
 *
 * These scripts run unattended in ECS, where the only evidence a failure leaves
 * is what it wrote before exiting. Discarding the error rendered every failure
 * as one indistinguishable line, so a failed run could be told apart only by
 * reproducing it out of band.
 *
 * What reaches here is authored and bounded: a configuration refusal names the
 * environment variables at fault and never their values, and the bootstrap
 * statement executor reduces a driver error to allowlisted fields before it can
 * escape. Nothing on this path forwards a provider payload.
 */
/**
 * The call frames of a stack, without its leading `Name: message` line.
 *
 * That line repeats the message verbatim and uncollapsed, which would put a
 * newline the headline just removed straight back into the log — and a message
 * containing a newline can forge a second record. Frames cannot.
 */
function stackFrames(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => /^\s+at\s/u.test(line))
    .join('\n')
    .slice(0, MAX_STACK_CHARS);
}

export function describeFailure(prefix: string, error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return `${prefix} value=${singleLine(String(error), MAX_MESSAGE_CHARS)}`;
  }
  const name = Reflect.get(error, 'name');
  const code = Reflect.get(error, 'code');
  const message = Reflect.get(error, 'message');
  const stack = Reflect.get(error, 'stack');
  const described =
    prefix +
    (typeof name === 'string'
      ? ` name=${singleLine(name, MAX_LABEL_CHARS)}`
      : '') +
    (typeof code === 'string'
      ? ` code=${singleLine(code, MAX_LABEL_CHARS)}`
      : '') +
    (typeof message === 'string'
      ? ` message=${singleLine(message, MAX_MESSAGE_CHARS)}`
      : '');
  const frames = typeof stack === 'string' ? stackFrames(stack) : '';
  return frames.length > 0 ? `${described}\n${frames}` : described;
}

/**
 * The configuration fields a Zod refusal blames.
 *
 * A `.strict()` schema reports an unrecognized key with an empty `path` and the
 * offending names under `keys`, so reading `path[0]` alone named nothing and
 * produced a refusal that blamed no field at all. Only names are collected;
 * a rejected value never appears.
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
  return Object.freeze([...fields].sort());
}
