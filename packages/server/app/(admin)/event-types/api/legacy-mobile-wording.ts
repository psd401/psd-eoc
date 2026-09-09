/**
 * Transition shim for the installed mobile app.
 *
 * App 1.0.14 bundles the contract from before the wording change of
 * 2026-09-09 (PR #490), whose template grammar knows five tokens. The
 * response types it lists on its home screen now carry `{{updatedBy}}` and
 * `{{updatedAt}}` in their all-clear and reactivation wording, so that
 * contract refuses every response type and the app reports an invalid
 * authenticated response. The app never renders these templates itself; it
 * only has to accept them.
 *
 * For a mobile session, the two tokens are rewritten to the tokens the old
 * grammar accepts. The web administration page, which edits wording, sees
 * the real tokens. Remove this once every registered device reports an
 * application version of 1.0.15 or later; nothing else depends on it.
 */
const LEGACY_TOKEN_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['{{updatedBy}}', '{{initiator}}'],
  ['{{updatedAt}}', '{{startTime}}'],
];

function rewriteText(value: string): string {
  return LEGACY_TOKEN_REPLACEMENTS.reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    value,
  );
}

/**
 * Rewrites the two lifecycle-only tokens wherever they appear in a response
 * value, leaving every other string, number, and shape untouched.
 */
export function legacyMobileWording<Value>(value: Value): Value {
  if (typeof value === 'string') {
    return rewriteText(value) as Value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => legacyMobileWording(item)) as Value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        legacyMobileWording(item),
      ]),
    ) as Value;
  }
  return value;
}
