# Issue 21 Maestro preconditions

These flows are intentionally synthetic-only. Before running either flow:

1. Build a development client with
   `EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE=issue-21`. This selects the bundled,
   fail-closed operational fixture: one synthetic site, one synthetic drill,
   only mocked integration labels, and no network or provider I/O for start
   operations. The fixture rejects real mode and all unexpected requests.
2. Enroll and unlock a synthetic staff session, then leave that session retained
   on the device. The flows use `clearState: false` and do not automate biometric
   or Google authentication.
3. Confirm the `SyntheticModeBanner` is visible before running either flow.
   The fixture supplies the stable controls and result states used by these
   scripts.

The synthetic-mode assertion runs before the first tap. Do not remove it, point
these flows at production, use staff recipient data, or enable a live provider.
The start-drill flow contains exactly three `tapOn` commands: site + mode, event
type, and final human confirmation.
