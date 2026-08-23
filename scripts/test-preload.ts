/**
 * Runs the suite as a synthetic district.
 *
 * The three values the auth setup needs — the staff domain, the public
 * origin, and the bundle identifier — used to be written into source, so
 * tests inherited Peninsula School District's identity and never noticed. They are configuration now, and a
 * suite that supplies them from here proves that: nothing under test knows
 * which district it is running for.
 *
 * These are defaults, not overrides. A test that asserts what happens when a
 * value is absent or malformed passes its own environment to the reader, which
 * every reader in `lib/config/deployment.ts` accepts, so nothing here can mask
 * a fail-closed check.
 *
 * The domain is `.invalid`, which RFC 2606 reserves precisely so it can never
 * resolve. Nothing here can reach a real host, a real inbox, or a real account.
 */
const SYNTHETIC_DEPLOYMENT: Readonly<Record<string, string>> = Object.freeze({
  GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://eoc.example.invalid',
  GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
  PSD_EOC_IOS_BUNDLE_ID: 'invalid.example.eoc',
  PSD_EOC_ORGANIZATION_NAME: 'Example School District',
});

for (const [name, value] of Object.entries(SYNTHETIC_DEPLOYMENT)) {
  process.env[name] ??= value;
}
