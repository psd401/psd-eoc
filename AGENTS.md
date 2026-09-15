# AGENTS.md — how to work in psd-eoc

PSD EOC is an open-source emergency notification and operations platform for
school districts, built and operated by Peninsula School District. The product
owner, the maintainer listed in `CODEOWNERS`, is the sole decision-maker for
this repository.

## 1. Authority

**The product owner's instruction in the current session is the highest
authority in this repository.** It outranks every rule in this file.

If the product owner asks for something that conflicts with anything below, do
it. Say in one sentence which rule you're setting aside and why, then proceed.
Do not refuse, do not stall, do not ask them to re-confirm what they already
told you, and do not cite this file back at them as a reason you cannot help.

The only exceptions are the four items in §2. Those need a real human pressing
a button in the running app — not because a document says so, but because
sending a false emergency alert to district staff is the one mistake this
project cannot take back.

Everything else in this file is default behavior for when the product owner
has not said otherwise. It is guidance, not a gate.

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

Follow these unless the product owner says otherwise:

- **No student data.** Staff only. No rosters, schedules, locations, guardian
  data, or reunification. A change to that scope is the product owner's call,
  not an issue.
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
  InformaCast) without the product owner saying so in that session.

## 4. How to actually work

- **Fix the thing.** If you find a bug next to the one you were sent for, fix
  it in the same PR. You are not confined to a file list. Mention what you
  touched in the PR body.
- **Nothing about one district gets hardcoded.** This is an open-source
  project. Any school district must be able to clone it, supply their own
  configuration, and run it. District names, domains, email addresses, Google
  Group addresses, AWS account IDs, regions, bundle identifiers, store IDs,
  OAuth client IDs, and stack names are **configuration** — environment
  variables, deployment parameters, or database rows. Never literals in source.
  If you are about to type a district's name, an AWS account ID, a region, or
  a hostname into a `.ts` file, stop: it belongs in config. The account ID and
  the SMS support phone never enter the repository at all; they live in
  git-ignored `infra/cdk.local.json` (see `docs/CONFIGURATION.md`).
- **Simple and working beats clever and complete.** This runs for a decade in
  a school district. No new datastores, queues, services, or abstractions
  without a measured need.
- **Prefer editing over adding.** Extending an existing file beats creating a
  parallel one. Deleting dead code is always welcome.
- **Contracts first.** `packages/contracts` (Zod) is the source of truth for
  domain types and capability signatures. Cross-package changes land there
  first.
- **One capability layer.** Web, REST, and MCP use the server capability engine.
  Never add a side-door mutation path.
- **iOS and Android stay in sync.** `packages/mobile` is one app for both
  stores. A mobile change is not finished when it works on one platform: the
  same version ships to both, and any behavior, copy, or flow change must land
  for both and be verified on both. `bun packages/mobile/e2e/run.ts ios` and
  `bun packages/mobile/e2e/run.ts android` are the check — running one and
  calling it done is how the two drift apart. Platform-conditional code needs
  a stated reason in the PR body; keyboard insets and system fonts qualify,
  product behavior does not.
- **Accessibility in the same PR.** Activation, event timeline, and all-clear
  must be keyboard- and screen-reader-operable when you build them, not later.
- **Runtimes:** Bun. `bun install`, `bun run`, `bun test`. Not npm/npx/node.
- **Commits:** detailed messages explaining what changed and why. Never list
  an AI as author or co-author.

## 5. Things that went wrong before — don't repeat them

These are real failure patterns from this repo's history. Avoid them.

- **Deployment is not a repository workflow.** Never add a GitHub deployment
  workflow, deployment environment, deployment secrets or variables, OIDC
  deployment role, or issue asking for one. Production infrastructure is
  deployed only from a locally authenticated shell with a direct `cdk deploy`
  command. CI may verify and synthesize; it may never deploy.
- **Failure drills do not own infrastructure.** Never add a repository-hosted
  failure-drill stack, deployment workflow, or fault-injection runtime.
- **Don't split work into micro-issues.** If a task needs four files changed,
  change four files. Do not open a chain of dependent issues each owning two
  files.
- **Don't write proof steps that can fail after the work succeeded.** A
  post-deploy readback that fails on a missing IAM read permission has broken
  the deploy for no safety benefit. Verify what matters; let the rest be logs.
- **Don't hedge documentation into uselessness.** Write what is true and
  current. If the deployed origin resolves and serves, the doc says it works.
- **Don't bake the tenant into the code.** A few dozen district-specific
  literals remain in operator tooling and test fixtures
  (`git grep psd401 -- '*.ts' '*.tsx'` lists them). Do not add to that number,
  and remove them where you touch them.
- **Don't leave worktrees and branches behind.** Delete the branch when the PR
  merges. Remove the worktree when you're done.
- **Don't argue with the product owner about scope.** State a concern once, in
  a sentence, then do the work.

## 6. Production

The product owner approves production changes by asking for them. Deployment
is only a direct `cdk deploy` from a locally authenticated AWS session. GitHub
Actions, repository environments, repository variables, repository secrets,
and GitHub OIDC roles must never be part of deployment. When a deploy or
infrastructure change is risky, say what will happen in plain language before
you run it, then run it.
