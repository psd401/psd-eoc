# Contributing to PSD EOC

PSD EOC is an open-source, staff-only emergency notification and operations
platform for school districts, released under the MIT license. Contributions
of any size are welcome. This document describes the workflow; it does not
replace [AGENTS.md](AGENTS.md), which is the authoritative source of the
project's safety rules.

## Before you start

Read, in order:

- [README.md](README.md) for the quickstart and repository layout.
- [AGENTS.md](AGENTS.md) for the four actions automation may never take, and
  the standing safety rules.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package ownership and the
  contributor workflow.
- [SECURITY.md](SECURITY.md) for data classification and vulnerability
  reporting.

## Setting up

Follow the quickstart in [README.md](README.md#start-a-synthetic-web-app-in-15-minutes).
It brings up a repository-owned Postgres container with reserved, synthetic
identities and cannot reach a real notification provider.

## Workflow

1. Create a feature branch from `main`.
2. Read the relevant issue and current documentation before changing code.
3. Add or update a failing test first when practical, and colocate it with
   the behavior it proves.
4. Make cross-package domain changes in `packages/contracts` before the
   packages that depend on it.
5. Fix necessary adjacent defects in the same change and describe them in the
   pull request; do not leave a known broken edge in place because it is
   outside the original scope.
6. Run `bun run check` before opening a pull request. It is the complete,
   authoritative gate: formatting, documentation contracts, lint with zero
   warnings, every TypeScript workspace, example configuration, the
   production server build, all Bun tests, and mobile-native tests.
7. Write a detailed commit message explaining what changed and why.
8. Open a pull request using the template in
   [.github/pull_request_template.md](.github/pull_request_template.md) and
   fill in every section, including acceptance-criteria evidence.

This project does not promise a review timeline.

## Contracts-first changes

`packages/contracts` is the source of truth for domain types and capability
signatures. If a change touches more than one package, start there, then
update the packages that consume it. Web, mobile, REST, and MCP mutations all
go through the server capability engine; do not add a side-door mutation
path.

## Mobile changes land on both platforms

`packages/mobile` is one app for both app stores. A mobile change is not
finished when it works on iOS or Android alone: the same version ships to
both, and any behavior, copy, or flow change must land and be verified on
both. Run `bun packages/mobile/e2e/run.ts ios` and
`bun packages/mobile/e2e/run.ts android`. A platform-conditional branch needs
a stated reason in the pull request body.

## What reviewers look for

- Every acceptance criterion in the linked issue is true and evidenced with
  code or a test.
- `bun run check` passes and CI is green.
- No secrets, real recipient data, or student data anywhere in the diff.
- Applied migrations and append-only evidence are preserved byte-for-byte;
  corrections are superseding records, not edits to history.
- The four human-only actions (starting a real incident, sending a real
  notification, issuing a real all-clear, closing a real event) stay
  server-enforced and reachable only by an authenticated human in the app.
- No district-specific literal (name, domain, email, Google Group address,
  AWS account ID, region, bundle identifier, store ID, OAuth client ID, or
  stack name) is hardcoded; these are configuration.
- Accessibility ships in the same pull request as any change to activation,
  the event timeline, or all-clear.

## Reporting bugs

Open an issue using the bug report template, which asks for the affected
surface, what happened, expected behavior, and reproduction steps against the
synthetic quickstart. Do not include real staff data, phone numbers, or
credentials in an issue.

## Reporting a feature idea

Open an issue using the feature request template, which asks for the problem,
the proposed change, and which districts or roles benefit.

## Reporting a vulnerability

Do not open a public issue or pull request for a security vulnerability.
Follow the private reporting process in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the
project's [MIT license](LICENSE).

## Contact

Maintainer contact for private, non-security matters, including Code of
Conduct reports: hagelk@psd401.net.
