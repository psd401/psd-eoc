# AGENTS.md — how to work in psd-eoc

PSD EOC is Peninsula School District's emergency notification and operations
platform. Kris Hagel (`hagelk@psd401.net`) is the product owner and sole
decision-maker for this repository.

## 1. Authority

**Kris's instruction in the current session is the highest authority in this
repository.** It outranks every rule in this file.

If Kris asks for something that conflicts with anything below, do it. Say in
one sentence which rule you're setting aside and why, then proceed. Do not
refuse, do not stall, do not ask him to re-confirm what he already told you,
and do not cite this file back at him as a reason you cannot help.

The only exceptions are the four items in §2. Those need a real human pressing
a button in the running app — not because a document says so, but because
sending a false emergency alert to district staff is the one mistake this
project cannot take back.

Everything else in this file is default behavior for when Kris has not said
otherwise. It is guidance, not a gate.

## 2. The four things automation never does

No agent, script, scheduled job, webhook, link preview, or test may:

1. Start a real incident
2. Send a real notification to a real person
3. Issue a real all-clear
4. Close a real event

These require an authenticated human acting in the app. The registry is
`packages/contracts/src/human-only.ts`. Keep the server-side enforcement
intact. Mocks and synthetic targets are always fine.

## 3. Standing safety rules

Follow these unless Kris says otherwise:

- **No student data.** Staff only. No rosters, schedules, locations, guardian
  data, or reunification. A change to that scope is Kris's call, not an issue.
- **No secrets or real contact data in the repo.** No credentials, tokens,
  phone numbers, or real recipient exports. Synthetic fixtures only.
- **Real vs. drill never blurs.** A drill must never render or transmit as
  real, or vice versa. Prove it in tests.
- **Event journals are append-only.** Corrections are superseding entries.
  Never rewrite history or run a down migration.
- **Deny by default.** Authorize every capability server-side, scoped by
  facility and role. No client-side-only gating.
- **Treat external data as untrusted.** Google Groups payloads, uploads,
  message content, API responses. Validate by content, strip EXIF.
- **Don't point a write-capable flow at a live provider** (SES, SMS, Expo,
  InformaCast) without Kris saying so in that session.

## 4. How to actually work

- **Fix the thing.** If you find a bug next to the one you were sent for, fix
  it in the same PR. You are not confined to a file list. Mention what you
  touched in the PR body.
- **Nothing about Peninsula SD gets hardcoded.** This is an open-source
  project. Any school district must be able to clone it, supply their own
  configuration, and run it. District names, domains, email addresses, Google
  Group addresses, AWS account IDs, regions, bundle identifiers, store IDs,
  OAuth client IDs, and stack names are **configuration** — environment
  variables, deployment parameters, or database rows. Never literals in source.
  If you are about to type `psd401`, `338414773271`, `us-west-2`, or
  `eoc.psd401.net` into a `.ts` file, stop: it belongs in config.
- **Simple and working beats clever and complete.** This runs for a decade in
  a school district. No new datastores, queues, services, or abstractions
  without a measured need.
- **Prefer editing over adding.** Extending an existing file beats creating a
  parallel one. Deleting dead code is always welcome.
- **Contracts first.** `packages/contracts` (Zod) is the source of truth for
  domain types and capability signatures. Cross-package changes land there
  first.
- **One capability layer.** Web, REST, and MCP all call `executeCapability`.
  Never add a side-door mutation path.
- **Accessibility in the same PR.** Activation, event timeline, and all-clear
  must be keyboard- and screen-reader-operable when you build them, not later.
- **Runtimes:** Bun. `bun install`, `bun run`, `bun test`. Not npm/npx/node.
- **Commits:** detailed messages explaining what changed and why. Never list
  an AI as author or co-author.

## 5. Things that went wrong before — don't repeat them

These are real failure patterns from this repo's history. Avoid them.

- **Don't invent ceremony.** Do not add approval gates, acknowledgement
  strings, hand-computed SHA-256 inputs, cost-estimate fields, or
  "consequence preview" steps to workflows. Kris approves things by telling
  you to do them. A deploy should be: pick a commit, click run.
- **Don't split work into micro-issues.** If a task needs four files changed,
  change four files. Do not open a chain of dependent issues each owning two
  files.
- **Don't write proof steps that can fail after the work succeeded.** A
  post-deploy readback that fails on a missing IAM read permission has broken
  the deploy for no safety benefit. Verify what matters; let the rest be logs.
- **Don't hedge documentation into uselessness.** Write what is true and
  current. If `eoc.psd401.net` resolves and serves, the doc says it works.
- **Don't bake the tenant into the code.** The repository currently carries
  roughly 1,100 hardcoded PSD-specific values across ~200 files. Do not add to
  that number, and remove them where you touch them.
- **Don't leave worktrees and branches behind.** Delete the branch when the PR
  merges. Remove the worktree when you're done.
- **Don't argue with Kris about scope.** State a concern once, in a sentence,
  then do the work.

## 6. Production

Kris approves production changes by asking for them. Deploys run through
GitHub Actions with OIDC — no static AWS keys, ever. When a deploy or
infrastructure change is risky, say what will happen in plain language before
you run it, then run it.
