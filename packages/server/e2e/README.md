# Issue #32 web E2E evidence

This suite runs only against an isolated synthetic PostgreSQL database. It
never invokes a channel worker or messaging provider. Browser-intercepted
activation responses carry an explicit
`synthetic-only-does-not-prove-live-integration` header; persisted lifecycle
actions operate on synthetic-roster drills created by the canonical capability
layer. The keyboard browser journey bridges its intercepted staff-ready result
to a separately seeded canonical synthetic drill; it does not claim one
persisted staff activation-to-room transaction. Staff activation remains
fail-closed without live-verified integrations.

Run the same web gate as CI:

```sh
PSD_EOC_E2E_SYNTHETIC_ONLY=true \
TEST_DATABASE_URL=postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:5432/psd_eoc_test \
bun packages/server/e2e/run-ci.ts
```

The runner proves:

- provider-free browser-intercepted real/drill start results and explicit
  join-existing behavior;
- one keyboard-only drill path from selection through post and all-clear;
- forced-colors activation and an explicit 200% root-page zoom/reflow check;
- late join, text, photo, location, all-clear, and close behavior;
- event-type publication plus facilities/access/integration administration;
- pinned axe-core WCAG 2.2 A/AA assertions on every screen touched by the
  issue-owned critical journey and admin accessibility tests.

All notification recipient addresses and tokens are synthetic and unroutable;
no provider worker is started. Synthetic sign-in identities and facilities are
fixtures only. A passing suite is evidence for mocked browser behavior, seeded
canonical capabilities, and no external integration being live.
