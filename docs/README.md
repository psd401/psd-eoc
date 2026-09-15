# Documentation index

This directory holds the repository's current documentation. Root-level
`ARCHITECTURE.md`, `CONFIGURATION.md`, and `INTEGRATIONS.md` are the primary
current sources; the subdirectories below hold guides, runbooks, and history.

## Top-level documents

- [Architecture and contributing](ARCHITECTURE.md) — package ownership,
  capability execution, contracts-first changes, data-retention rules, and
  the contributor workflow.
- [Configuration and deployment](CONFIGURATION.md) — the tenant manifest and
  direct CDK deployment parameter index.
- [Operational readiness](INTEGRATIONS.md) — the only current source for
  deployed-stack, DNS, OIDC, alarm, provider, and mobile readiness.

## Subdirectories

- [`guides/`](guides/) — end-user setup guides: getting a first administrator
  admitted, and installing the mobile app on iOS and Android.
- [`runbooks/`](runbooks/) — stable operational procedures for alarms,
  providers, releases, and maintenance; see
  [`runbooks/README.md`](runbooks/README.md) for the index.
- [`learnings/`](learnings/) — dated, tagged notes on failure patterns and
  fixes, grouped by category (database, security, test-failures, ui,
  workflow).

## History

Planning records, decision logs, and one-off deployment evidence from before
the public release are retained in the maintaining district's private
operations records, not in this repository. Current documents are the only
instruction source.
