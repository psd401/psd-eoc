# AGENTS.md — how to work in psd-eoc

The product owner, the maintainer listed in `CODEOWNERS`, is the sole
decision-maker for this repository.

## Authority

The product owner's instruction in the current session outranks every rule in
this file except the four under "Automation never does". If an instruction
conflicts with a rule, say in one sentence which rule you are setting aside and
why, then do it. Do not refuse, stall, ask them to re-confirm, or cite this
file back at them. State a scope concern once, in a sentence, then do the work.
Everything else here is the default when the product owner has not said
otherwise.

## Automation never does

No agent, script, scheduled job, webhook, link preview, or test may:

1. Start a real incident
2. Send a real notification to a real person
3. Issue a real all-clear
4. Close a real event

These require an authenticated human acting in the app, because a false
emergency alert to district staff cannot be taken back. The registry is
`packages/contracts/src/human-only.ts`. Keep the server-side enforcement
intact. Mocks and synthetic targets are always fine.

## Safety

- No student data. Staff only: no rosters, schedules, locations, guardian
  data, or reunification. A change to that scope is the product owner's call,
  not an issue.
- No secrets or real contact data in the repo: no credentials, tokens, phone
  numbers, or real recipient exports. Synthetic fixtures only.
- Real vs. drill never blurs. A drill must never render or transmit as real,
  or vice versa. Prove it in tests.
- Event journals are append-only. Corrections are superseding entries. Never
  rewrite history or run a down migration, and preserve applied migrations
  byte-for-byte.
- Deny by default. Authorize every capability server-side, scoped by facility
  and role. No client-side-only gating.
- Treat external data as untrusted: Google Groups payloads, uploads, message
  content, API responses. Validate by content, strip EXIF.
- Don't point a write-capable flow at a live provider (SES, SMS, Expo,
  InformaCast) without the product owner saying so in that session.

## Tenant configuration

Any school district must be able to clone this repository, supply its own
configuration, and run it. District names, domains, email addresses, Google
Group addresses, AWS account IDs, regions, bundle identifiers, store IDs, OAuth
client IDs, and stack names are configuration (environment variables,
deployment parameters, or database rows), never literals in source. The AWS
account ID, the SMS support phone, and the Google Cloud billing account never
enter the repository; they live in git-ignored `infra/cdk.local.json` (shape:
`infra/cdk.local.example.json`; see `docs/CONFIGURATION.md`).

The literals that remain are deliberate: the mobile bundle identifier and
keychain service names (renaming them signs out every installed device),
applied migrations, and leak-detector assertions
(`git grep psd401 -- '*.ts' '*.tsx'` lists them). Do not add to that number.
Test fixtures use invented districts, schools, and people.

## Commands

Bun only: `bun install`, `bun run`, `bun test`. Not npm, npx, or node.

```sh
bun install --frozen-lockfile
bun run test:db:start   # export the TEST_DATABASE_URL it prints
bun run test:db:migrate
bun run test:db:seed
bun run check           # the complete gate
bun run test:db:stop
```

`bun run test:unit` is a database-free diagnostic subset, not a substitute for
`bun run check`. `bun run test:web` starts a dev server for manual use; it
never exits and asserts nothing.

## How to work

- Fix the thing. If you find a bug next to the one you were sent for, fix it
  in the same PR and mention what you touched in the PR body.
- Don't split work into micro-issues. If a task needs four files changed,
  change four files.
- Simple and working beats clever and complete. No new datastores, queues,
  services, or abstractions without a measured need.
- Contracts first. `packages/contracts` (Zod) is the source of truth for
  domain types and capability signatures. Cross-package changes land there
  first.
- One capability layer. Web, mobile, REST, and MCP mutations use the server
  capability engine. Never add a side-door mutation path.
- iOS and Android stay in sync. The same version ships to both stores, and any
  behavior, copy, or flow change lands for both and is verified on both:
  `bun packages/mobile/e2e/run.ts ios` and
  `bun packages/mobile/e2e/run.ts android`.
- Activation, event timeline, and all-clear must be keyboard- and
  screen-reader-operable in the PR that builds them.
- Do not suppress TypeScript errors or lint findings.
- Commit messages explain what changed and why. Never list an AI as author or
  co-author.
- Write documentation as what is true and current. If the deployed origin
  resolves and serves, the doc says it works.
- Don't write proof steps that can fail after the work succeeded. A
  post-deploy readback that fails on a missing IAM read permission has broken
  the deploy for no safety benefit. Verify what matters; let the rest be logs.
- Delete the branch when the PR merges. Remove the worktree when you're done.

## Where current truth lives

- `docs/ARCHITECTURE.md`: package ownership and capability execution.
- `docs/CONFIGURATION.md`: the tenant manifest and direct CDK parameters.
- `docs/INTEGRATIONS.md`: the only current source for deployed-stack, DNS,
  OIDC, alarm, provider, and mobile readiness. Runbooks in `docs/runbooks/`
  hold stable procedures and defer current state to it.

## Production

The product owner approves production changes by asking for them. Deployment
follows psd-dev-standards
[08-iac](https://github.com/psd401/psd-dev-standards/blob/main/standards/08-iac.md),
which sets two paths, and there is no third:

- **Terraform** applies only from CI. The pull request shows the plan, a
  GitHub `production` environment approval gates the apply, and the apply runs
  through an OIDC role pinned to that environment. Nobody applies Terraform
  locally and nobody holds long-lived cloud keys. The one exception is the
  one-time apply of `infra/terraform/state-bootstrap`, which phase 1 of the
  [migration plan](docs/terraform-migration-plan.md) will create: the product
  owner runs it once to create the state bucket and those CI roles.
- **CDK**, until a stack migrates to Terraform, deploys only from a human's
  locally authenticated, short-lived AWS session with a direct `cdk deploy`.
  No workflow deploys CDK, CloudFormation, App Runner, or a container image.

Agents never run `apply`, `deploy`, or `import` against a real account. An
agent prepares the change: a pinned clean worktree, a `cdk diff` or plan, and
the exact command. A human runs it, and the agent verifies the result
afterwards. When a deploy or infrastructure change is risky, say what will
happen in plain language before the human runs it.

Failure drills do not own infrastructure. Never add a repository-hosted
failure-drill stack, deployment workflow, or fault-injection runtime.
