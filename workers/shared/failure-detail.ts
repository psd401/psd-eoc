/**
 * Why a worker could not handle a message, using only classifications this
 * system controls.
 *
 * An error's message is never echoed. A delivery failure often originates at a
 * provider, and a provider-controlled string may carry the push token or the
 * recipient the message was for; `workers/push/service.test.ts` asserts that
 * such text never reaches a log line. Nothing here is drawn from a message,
 * a payload, or a provider response body.
 *
 * What is safe is what the system itself assigned: the error's class, the
 * error code these clients raise (`RETRYABLE_RESPONSE`, `INVALID_RESPONSE`),
 * an HTTP status, and the field paths a schema refused. That is also what
 * actually identifies a failure -- these clients raise one fixed sentence and
 * put the useful part in a code, so the message was never the answer.
 *
 * Workers previously logged these failures as a bare count. A message that
 * could not be handled looked identical whether the payload was malformed, a
 * provider rejected it, or a callback was refused, and it retried until its
 * redrive policy gave up.
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
  const carried = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    causeName?: unknown;
  } | null;
  const parts = [
    typeof carried?.name === 'string' && carried.name.length > 0
      ? [carried.name]
      : [],
    typeof carried?.code === 'string' && carried.code.length > 0
      ? [`code ${carried.code}`]
      : [],
    typeof carried?.status === 'number' ? [`status ${carried.status}`] : [],
    typeof carried?.causeName === 'string' && carried.causeName.length > 0
      ? [`caused by ${carried.causeName}`]
      : [],
  ].flat();
  return parts.length === 0 ? 'unclassified failure' : parts.join(' — ');
}
