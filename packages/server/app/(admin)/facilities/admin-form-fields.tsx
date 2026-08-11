import { randomUUID } from 'node:crypto';

/** Server-rendered mutation metadata; neither value is accepted as identity. */
export function AdminMutationFields({
  csrfToken,
}: Readonly<{ csrfToken: string }>) {
  return (
    <>
      <input name="csrfToken" type="hidden" value={csrfToken} />
      <input name="idempotencyKey" type="hidden" value={randomUUID()} />
    </>
  );
}
