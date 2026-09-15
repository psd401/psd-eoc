# CLAUDE.md — PSD EOC orientation

Read [AGENTS.md](AGENTS.md) first. It defines repository authority and the
safety rules that apply to every contributor and automation surface.

PSD EOC is an open-source, staff-only emergency notification and operations
platform for school districts. District identity, cloud targets, domains,
facilities, provider identities, and mobile identifiers are configuration,
never application literals.

## Current sources

- [Architecture and contributing](docs/ARCHITECTURE.md) describes package
  ownership, capability execution, contracts-first changes, and append-only
  data.
- [Configuration and deployment](docs/CONFIGURATION.md) indexes the tenant
  manifest and direct CDK parameters.
- [Operational readiness](docs/INTEGRATIONS.md) is the only current source for
  deployed-stack, DNS, OIDC, alarm, provider, and mobile readiness.
- [Runbooks](docs/runbooks/README.md) contain stable procedures and always
  defer current state to the readiness register.

## Commands

Use Bun only:

```sh
bun install --frozen-lockfile
bun run test:db:start
bun run test:db:migrate
bun run test:db:seed
bun run test:web
bun run check
bun run test:db:stop
```

`bun run check` is the complete gate. `bun run test:unit` is a database-free
diagnostic subset, not a substitute.

## Working conventions

- TypeScript is strict; do not suppress errors or lint findings.
- Colocate tests with the behavior they prove.
- Prettier owns formatting.
- Prefer server components; add `'use client'` only when interaction requires
  it.
- Fix necessary adjacent defects in the same change and describe them in the
  pull request.
- Cross-package domain changes start in `packages/contracts`.
- Web, mobile, REST, and MCP mutations use the server capability engine.
- Mobile is one app for two stores: land and verify every change on iOS _and_
  Android, never one of them.
- Preserve applied migrations and append-only evidence byte-for-byte; correct
  current truth with a superseding record.
