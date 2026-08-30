import type { z } from 'zod';

/**
 * A response payload can only gain so many new fields between the build a
 * phone is running and the server it is talking to. The bound keeps a
 * pathological payload from looping.
 */
const MAX_UNKNOWN_FIELD_PASSES = 8;

type UnknownKeyIssue = Readonly<{
  path: readonly PropertyKey[];
  keys: readonly string[];
}>;

/**
 * Collects unrecognized-key issues, or reports that this failure is something
 * else. A single issue of any other kind means the payload is genuinely wrong
 * and must still fail: this never rescues a malformed or hostile response.
 *
 * A union reports one nested issue list per branch, with paths relative to the
 * union itself, so branch paths are rebased onto the union's own path. The
 * first branch that failed on unknown keys alone is the branch the payload was
 * meant for; the others failed on their discriminant and say nothing useful.
 */
function unknownKeyIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[],
): readonly UnknownKeyIssue[] | null {
  const collected: UnknownKeyIssue[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') {
      collected.push({ path, keys: issue.keys });
      continue;
    }
    if (issue.code === 'invalid_union') {
      const branch = firstUnknownKeyBranch(issue.errors, path);
      if (branch === null) return null;
      collected.push(...branch);
      continue;
    }
    return null;
  }
  return collected.length === 0 ? null : collected;
}

function firstUnknownKeyBranch(
  branches: readonly (readonly z.core.$ZodIssue[])[],
  prefix: readonly PropertyKey[],
): readonly UnknownKeyIssue[] | null {
  for (const branch of branches) {
    const issues = unknownKeyIssues(branch, prefix);
    if (issues !== null) return issues;
  }
  return null;
}

function withoutUnknownKeys(
  value: unknown,
  issues: readonly UnknownKeyIssue[],
): unknown {
  // The payload is decoded JSON, so a round trip is a sufficient deep copy and
  // keeps the caller's value untouched.
  const copy: unknown = JSON.parse(JSON.stringify(value));
  for (const issue of issues) {
    let target: unknown = copy;
    for (const segment of issue.path) {
      if (typeof target !== 'object' || target === null) {
        target = null;
        break;
      }
      target = (target as Record<PropertyKey, unknown>)[segment];
    }
    if (typeof target !== 'object' || target === null) continue;
    for (const key of issue.keys) {
      delete (target as Record<string, unknown>)[key];
    }
  }
  return copy;
}

/**
 * Parses a server response while tolerating fields this build has never heard
 * of.
 *
 * The wire schemas reject unknown keys, which is the behavior we want for
 * anything a client sends. Applied to what a client *reads*, it makes every
 * additive server field a breaking change for every installed app: adding
 * `authorDisplayName` to journal entries left shipped builds parsing every
 * timeline page into an error and showing a permanent "Event room
 * unavailable", with no over-the-air update able to reach them.
 *
 * So an unrecognized key is dropped and the payload is parsed again. Every
 * other failure -- a missing field, a wrong type, a value that fails a
 * refinement -- is still raised unchanged.
 */
export function parseIgnoringNewServerFields<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  let candidate = value;
  for (let pass = 0; pass < MAX_UNKNOWN_FIELD_PASSES; pass += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    const issues = unknownKeyIssues(parsed.error.issues, []);
    if (issues === null) throw parsed.error;
    candidate = withoutUnknownKeys(candidate, issues);
  }
  return schema.parse(candidate);
}

/**
 * Wraps a wire schema for use as a response parser, tolerating fields a newer
 * server has added. Use it wherever a client reads; never where it writes.
 */
export function tolerantResponseSchema<Schema extends z.ZodType>(
  schema: Schema,
): Readonly<{ parse(value: unknown): z.output<Schema> }> {
  return {
    parse: (value: unknown): z.output<Schema> =>
      parseIgnoringNewServerFields(schema, value),
  };
}
