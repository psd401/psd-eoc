/** At most this much of a failure is written to a worker log. */
const FAILURE_DETAIL_LIMIT = 300;

/**
 * A bounded, value-free description of why a worker could not handle a message.
 *
 * A delivery message names a recipient and carries a provider token, so the
 * failure itself must never be echoed. A schema refusal contributes the field
 * paths it rejected -- a Zod message can quote the value it refused, and here
 * that value is exactly the address or token that must not be logged.
 *
 * Workers used to log these failures as a bare count. A message that could not
 * be handled looked identical whether the queue payload was malformed, a
 * provider rejected it, or a database write was refused, and the message
 * retried until its redrive policy gave up.
 */
export function failureDetail(error: unknown): string {
  const issues = (
    error as { issues?: readonly { path?: readonly unknown[] }[] } | null
  )?.issues;
  if (Array.isArray(issues)) {
    const paths = [
      ...new Set(
        issues.map((issue) =>
          Array.isArray(issue.path) ? issue.path.join('.') : '',
        ),
      ),
    ]
      .filter((path) => path.length > 0)
      .sort();
    return paths.length > 0
      ? `schema refused: ${paths.join(', ')}`
      : 'schema refused the message';
  }
  if (!(error instanceof Error)) return 'no message';
  const message = error.message.trim().replace(/\s+/gu, ' ');
  if (message.length === 0) return 'no message';
  return message.length > FAILURE_DETAIL_LIMIT
    ? `${message.slice(0, FAILURE_DETAIL_LIMIT)}…`
    : message;
}
