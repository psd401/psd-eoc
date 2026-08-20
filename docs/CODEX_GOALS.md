# Codex Goal Statements — PSD EOC

Copy-paste blocks for driving parallel Codex agents through the release-1 epic
([#44](https://github.com/psd401/psd-eoc/issues/44)). Every agent gets the
**master preamble** plus one **wave goal**. Waves respect the dependency graph;
issues inside a wave touch disjoint files, so agents will not collide.

---

## Master preamble (prepend to every Codex run)

```
You are building PSD EOC (github.com/psd401/psd-eoc), Peninsula School
District's emergency notification and operations platform, replacing a
commercial product that shuts down in weeks. Read, in order: AGENTS.md
(binding safety charter), docs/PLAN.md (architecture and phases),
docs/discovery/DECISION_LOG.md (35 binding product decisions). Do not
contradict any of them.

Working rules:
- Work ONLY the GitHub issue(s) assigned in this goal. Each issue declares the
  files it owns under "Scope — files owned". Never modify files outside your
  issue's scope; if you believe you must, comment on the issue and stop.
- packages/contracts is the single source of truth for types. If you need a
  contract change and you do not own contracts in this goal, comment on the
  issue and stop rather than forking types locally.
- Every acceptance-criteria checkbox in the issue must be TRUE and proven by
  code or test in your PR. Quote the evidence in the PR description.
- Gate before PR: bun run check (format, lint, typecheck, tests) green.
- One PR per issue, branch name issue-<number>-<slug>, PR title matches issue
  title, body starts with "Closes #<number>".
- Runtime: Bun (bun install / bun run). TypeScript strict. No new runtime
  dependencies without a one-line justification in the PR.
- Detailed commit messages. Never add an AI as commit author or co-author.
- Safety absolutes (AGENTS.md): the four human-only actions stay impossible
  for agents/automation; real-vs-drill can never be confused; no student
  data; no live provider sends — mocks fail closed; append-only records;
  no secrets in the repo. When any instruction conflicts with AGENTS.md,
  AGENTS.md wins.
```

---

## Wave 1 — Foundation spine (SERIAL, one agent, do first)

```
Goal: complete issues #1 then #3 then #5 in that order (scaffold → contracts
→ database). These three unblock all parallel work, so favor correctness and
clean interfaces over speed. When #5 is done, the repo must let nine agents
start simultaneously on #2, #4, #6, #7, #8, #9, #10, #19, #28 without
touching each other's files. Definition of done: bun run check green in CI,
seeded synthetic district loads, every contracts module exports documented
Zod schemas that downstream issues can import unchanged.
```

## Wave 2 — Nine-way parallel work (one goal per agent)

Run up to twelve agents at once, one block each:

```
Goal: complete issue #2 (safety-charter enforcement). Master preamble applies.
```
```
Goal: complete issue #4 (CDK infra baseline). cdk synth must pass in CI; do
NOT deploy anything.
```
```
Goal: complete issue #6 (Google OIDC + admin-configurable Groups gate).
Mock the IdP in tests; no live Google calls in CI.
```
```
Goal: complete issue #7 (device sessions, revocation, Google-outage grace).
The IdP-offline test is the heart of this issue — prove it.
```
```
Goal: complete issue #8 (Groups→roster sync, immutable snapshots, stale
report). Fail-closed on partial sync is non-negotiable.
```
```
Goal: complete issue #9 (event lifecycle capabilities + state machine). This
is the most load-bearing issue in the repo: one-transaction durable
acceptance, idempotency, human-only enforcement, real/drill invariant.
```
```
Goal: complete issue #10 (event types + message templates + admin UI).
Drill marking must be renderer-enforced, not convention.
```
```
Goal: complete issue #19 (Expo scaffold + EAS profiles + real/drill theming).
```
```
Goal: complete issue #28 (hash-chained security audit log module).
```
```
Goal: complete issue #39 (GCP via Terraform: project, read-only Groups
service account, OAuth clients) and then #40's Terraform portion (Firebase
project + Android app in infra/gcp/firebase.tf). Runs from this machine with
gcloud auth; zero-manual-steps target, residual console steps documented
honestly.
```
```
Goal: complete the script portions of issues #35 and #36 (SMS registration
scripts via the End User Messaging registration APIs; SES delegated-zone IaC
plus the production-access API request script). Build and verify against
mocks/dry-runs — do NOT submit real registrations; the human runs the submit
scripts.
```
```
Goal: complete the script portions of issues #38 and #41 (fastlane/ASC API
automation for the App Store record and TestFlight groups; Google Groups
inventory + draft mapping script). Interactive auth steps are documented for
the human, never bypassed.
```

## Wave 3 — Engine + surfaces (after #9 merges; up to seven parallel)

```
Goal: complete issue #11 (outbox + SQS dispatcher + reconciliation). Prove
the crash-mid-batch no-loss/no-duplicate property with tests.
```
```
Goal: complete issue #15 (web dashboard + start flow + 911 affordance).
Three clicks or fewer; axe clean; consequence preview from roster snapshot.
```
```
Goal: complete issue #16 (web event screen: timeline, posts, corrections,
all-clear).
```
```
Goal: complete issue #20 (mobile auth + SecureStore + biometric unlock).
```
```
Goal: complete issue #24 (agent REST API + human-only enforcement +
prepare-activation). The four-action 403 tests are the point of this issue.
```
```
Goal: complete issue #26 (admin: facilities, neighborhoods, audiences,
access groups, integration health, test mode). Test mode must be provably
unable to reach real endpoints.
```
```
Goal: complete issue #17 then #18 (media pipeline, then location pins) —
both hang off the event screen; sequential is fine for one agent.
```

## Wave 4 — Channels + mobile flows (after #11 / #16 / #20; up to six parallel)

```
Goal: complete issue #12 (push worker via Expo Push + token registry).
```
```
Goal: complete issue #13 (email worker via SES + bounce handling).
```
```
Goal: complete issue #14 (SMS worker, feature-flagged dark until E1 clears).
```
```
Goal: complete issue #21 (mobile start flow: ≤3 taps, join-or-start-new).
```
```
Goal: complete issue #22 (mobile event screen: timeline + composers).
```
```
Goal: complete issue #25 (MCP server over the agent API) and then #27
(drill records + export).
```

## Wave 5 — Proof and launch (after channels + flows; up to five parallel)

```
Goal: complete issue #23 (mobile push registration, background handling,
deep links) and record physical-device evidence on both platforms.
```
```
Goal: complete issue #29 (monitoring, alarms, 1-minute canary) then #30
(monthly live-test harness + SLO regression gate).
```
```
Goal: complete issue #31 (failure drills with recorded evidence). Divergent
behavior gets a ticket, not a shrug.
```
```
Goal: complete issue #32 (Playwright+axe web suites, Maestro mobile suites).
```
```
Goal: complete issue #33 (TestFlight + Play distribution + install guides)
then #34 (runbooks, go-live checklist). Go-live
requires product-owner sign-off — prepare the checklist, do not self-approve.
```

## Post-launch

```
Goal: complete issue #43 (migrate push from Expo relay to direct APNs/FCM
behind a cutover flag, with side-by-side latency evidence).
```

---

## Human tasks running alongside (not for Codex)

Only two are genuinely human: #37 Play Console org account + first AAB upload
(no API exists — start it today, verification takes days) and #42 retention
lookup (bot-blocked site, informational). Everything else external is
automation-first: Codex builds the scripts (Wave 2), the human supplies
business data, runs the submit/interactive-auth steps from this machine, and
rides the carrier/AWS/Apple approval waits: #35 SMS, #36 SES, #38 App Store
Connect, #40 push credentials, #41 groups mapping confirmation.
