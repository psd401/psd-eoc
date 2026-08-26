# PSD EOC

PSD EOC is an open-source emergency notification and operations platform for
school districts. Staff can activate incidents or drills, notify staff over
configured channels, collaborate in a live event timeline, and retain an
append-only record.

**Call 911 first.** PSD EOC notifies and documents; it does not contact
emergency services.

## Start a synthetic web app in 15 minutes

This path uses only reserved example identities, unroutable recipients, and a
repository-owned PostgreSQL container. It cannot contact a notification
provider.

Install these prerequisites:

- [Bun 1.2.23](https://bun.sh/docs/installation)
- [Docker](https://docs.docker.com/get-docker/) with Compose
- Poppler's `pdftotext` (`brew install poppler` on macOS or
  `apt-get install poppler-utils` on Debian/Ubuntu)

From a clean checkout, run:

```sh
bun install --frozen-lockfile
bun run test:db:start
bun run test:db:migrate
bun run test:db:seed
bun run test:web
```

`test:db:start` writes ignored root and server `.env.local` files containing
the assigned loopback database port and the reserved values from
`.env.example`. The migrate, seed, and web commands validate those files and
pin their child processes to that synthetic database, even if your shell has
other database variables. Startup refuses conflicting ambient database
configuration or a file it did not generate. Open
[http://127.0.0.1:3000/login](http://127.0.0.1:3000/login) and confirm the page
names the synthetic example district.

In a second terminal, run the authoritative repository gate:

```sh
bun run check
```

That command checks formatting, documentation contracts, lint with zero
warnings, every TypeScript workspace, example configuration, the production
server build, all Bun tests, and mobile-native tests. It is the only complete
local verification command.

When finished, stop the repository-owned database and remove its synthetic
volume and generated environment file:

```sh
bun run test:db:stop
```

## Current documentation

- [Architecture and contributing](docs/ARCHITECTURE.md) — package ownership,
  capability execution, data rules, and contributor workflow
- [Configuration and deployment](docs/CONFIGURATION.md) — tenant manifest,
  runtime environment and direct CloudFormation parameter index
- [Operational readiness](docs/INTEGRATIONS.md) — the only current register of
  deployment, provider, DNS, monitoring, and mobile readiness
- [Operations runbooks](docs/runbooks/README.md) — durable response and
  maintenance procedures
- [Security policy](SECURITY.md) — security posture and data classification
- [Historical archive](docs/archive/README.md) — planning records and preserved
  one-off evidence; never a current instruction source

## Repository layout

```text
packages/contracts   Zod domain and capability contracts
packages/server      Next.js web, REST, capability engine, and database
packages/mobile      Expo native iOS and Android client
packages/mcp         MCP adapter over the agent REST capability surface
workers              Notification routing and channel workers
infra                AWS CDK and Google Cloud configuration
scripts              Repository verification and operator tooling
docs                 Current guides, runbooks, readiness, and history
```

Read [AGENTS.md](AGENTS.md) before making a change. In particular, automation
must never start a real incident, send a real notification, issue a real
all-clear, or close a real event.
