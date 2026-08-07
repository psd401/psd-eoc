export default function LoginPage() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="auth-card" aria-labelledby="sign-in-heading">
        <h1 id="sign-in-heading">Sign in to PSD EOC</h1>
        <p>
          Use your Peninsula School District Google account. Access is limited
          to staff in an administrator-configured access group.
        </p>
        <a className="button-link" href="/auth/sign-in">
          Continue with Google
        </a>
        <p className="supporting-text">
          Signing in does not start an incident or send a notification.
        </p>
      </section>
    </main>
  );
}
