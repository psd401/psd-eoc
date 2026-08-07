const denialMessages = {
  access: 'Your account is not currently in a PSD EOC access group.',
  callback: 'Google sign-in could not be verified. No session was created.',
  configuration:
    'PSD EOC sign-in is temporarily unavailable because access is not configured.',
} as const;

type DenialReason = keyof typeof denialMessages;

function isDenialReason(value: string | undefined): value is DenialReason {
  return value !== undefined && Object.hasOwn(denialMessages, value);
}

export default async function DeniedPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly reason?: string }>;
}) {
  const { reason } = await searchParams;
  const message = isDenialReason(reason)
    ? denialMessages[reason]
    : 'PSD EOC could not sign you in. No session was created.';

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="denied-heading">
        <h1 id="denied-heading">Access not granted</h1>
        <p role="alert">{message}</p>
        <p>
          If you believe you should have access, contact the district technology
          team and ask them to verify your Google Group membership.
        </p>
        <a className="button-link" href="/login">
          Return to sign in
        </a>
      </section>
    </main>
  );
}
