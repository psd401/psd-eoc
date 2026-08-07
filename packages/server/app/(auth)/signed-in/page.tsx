export default function SignedInPage() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="signed-in-heading">
        <h1 id="signed-in-heading">Return to PSD EOC</h1>
        <p>
          PSD EOC verifies your session again before showing protected content.
        </p>
        <p className="supporting-text">
          No incident was started and no notification was sent.
        </p>
      </section>
    </main>
  );
}
