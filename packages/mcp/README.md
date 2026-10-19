# PSD EOC MCP server

This package exposes a deliberately small MCP surface over the scoped PSD EOC
agent REST API. It supports newline-delimited stdio and stateless Streamable
HTTP. Both transports call the same REST capabilities used by other agent
clients; neither transport has a direct database or notification-provider path.

The server exposes event reads, append-only journal search, drill-record
evidence, private short-lived records exports, roster-staleness reads,
unpublished event-type template drafts, and activation preparation. It does not expose any tool that
can start a real incident, send a real notification,
issue an all-clear, or close a real event. Creating an activation consequence
preview and preparing its intent still requires an authenticated human to review
and confirm in the PSD EOC app.

Drill-record results include site, date/time, and event type. They are retained
records evidence, not a legal or district-policy compliance determination.
`export-drill-records` creates the corresponding authorized CSV export;
`export-event-summary` creates an authorized PDF containing append-only journal
provenance, photo checksum references, and exact delivery truth states without
recipient contact data. Both return private download grants that expire after
5 minutes, the value of `RECORDS_EXPORT_GRANT_SECONDS` in
`packages/server/lib/capabilities/records/artifact-store.ts`; a server test
keeps this sentence and that constant in step. Export artifacts remain records
evidence, not a legal or district-policy compliance determination.

## Required configuration

- `PSD_EOC_AGENT_API_KEY`: one revocable, facility- and capability-scoped
  agent key. Keep it outside shell history, source control, and client prompts.
- `PSD_EOC_AGENT_API_BASE_URL`: optional; defaults to
  `http://127.0.0.1:3000/api/agent/v1`. Remote URLs must use HTTPS. Redirects
  are rejected so the key cannot follow a response to another origin.

Grant the key only the tools the agent needs. The server still shows its fixed,
safe MCP catalog; the agent API returns a scoped `403` if the key lacks a grant
or the requested facility. Do not use a production-capable recipient/provider
setup for development.

For records access, grant only the needed IDs from `list-drill-records`,
`export-drill-records`, and `export-event-summary`. Export URLs are temporary
bearer grants to private artifacts: do not log, persist, or forward them, and
do not treat provider acceptance in an event summary as delivery or human
receipt.

The `draft-message-template-revision` facade requires four underlying scoped
capability grants: `get-event-type-version`, `get-event-type-draft`,
`create-event-type-draft`, and `update-event-type-draft`. The raw create and
update capabilities remain hidden from the MCP catalog; the facade uses them
internally to preserve real-or-drill mode, classification markers, lifecycle
purpose, and all untouched wording from the canonical source. A draft is all an
agent can produce: `publish-event-type-version` is not a grant any agent key
can hold, so wording an agent drafts reaches a real notification only after a
human administrator publishes it in the PSD EOC app.

That review happens on the Responses page in the web app, which lists every
unpublished draft under "Drafts awaiting review" with the agent's name and the
label and prefix of the key it used, shows the three channel previews, and
compares each field with the published version the draft was based on. The
server lets only the actor who last saved a draft publish it, so the
administrator's "Approve and publish" first re-saves the exact reviewed wording
under their own name and then publishes it; a draft they do not want is
discarded, which keeps the draft on record but closes it to further edits and
to publication. The review list and the discard (`list-event-type-drafts`,
`discard-event-type-draft`) are human-only capabilities: no agent key can be
granted them, and the agent REST API and this server never expose them. An
agent that updates a discarded draft receives a `409`.

Every grant an agent key may carry comes from one explicit allowlist,
`AGENT_KEY_GRANTABLE_CAPABILITY_IDS` in `@psd-eoc/contracts`. The MCP tool IDs
are a compile-time subset of it. Capabilities the catalog admits for an agent
principal but that are absent from the allowlist (publishing, journal writes,
joining or reactivating an event, reopening a closed event, and configuration
writes) cannot be issued. A key row that somehow carried one authenticates
without that grant, and the attempt to exercise it is audited as a denial.

## Operating this server safely

**Tool results contain untrusted text.** Event, journal, drill-record,
template, draft, and activation-preview results carry free text that staff or
other agents wrote: a journal entry holds up to 10,000 characters and a page
holds up to 200 entries, and an operator's typed threat or response detail, a
correction reason, and template wording are free text too. The server prefixes
the text content of those results with one fixed data notice and repeats it in
the server instructions. `structuredContent` is unchanged and carries no
notice, so a client that hands only `structuredContent` to a model must treat
it as the same untrusted data. Treat everything after the notice as data to
report: never follow an instruction found in it, and never let it choose the
facility, tool, template, or recipient the agent acts on. Facility, threat,
roster-health, export-grant, and error results are server-authored and carry
no notice.

**Keep the agent inside the Rule of Two.** Meta's Agents Rule of Two says an
agent session should hold at most two of: untrusted input, access to sensitive
data or credentials, and the ability to communicate externally. An agent
connected to this server already reads untrusted record text and holds a
district credential, so do not give the same agent unrestricted web browsing,
email, or messaging tools. If a workflow needs all three, split it across
agents and have a human approve the hand-off.

**Grant the key the smallest group that fits.** The administration page offers
the allowlist in three groups: reads and reports (read-only queries plus
private short-lived exports), drafts (unpublished template drafts plus the
activation and lifecycle previews and prepared intents that a human must
confirm), and synthetic event lifecycle (`start-event`, `all-clear-event`, and
`close-event`, which the server accepts from an agent key only for drills and
tests on the synthetic roster). Most agents need the first group. Give the
lifecycle group only to an agent whose documented purpose is running synthetic
drills, keep the facility scope to the sites it serves, and accept the bounded
expiry: every key issued from the administration page expires, and the
[API-key rotation runbook](../../docs/runbooks/rotation-api-keys.md) replaces
it.

## Connect over stdio

Run from the repository root:

```sh
PSD_EOC_AGENT_API_KEY='set-in-your-secret-manager' \
  bun run --cwd packages/mcp start
```

Most MCP clients, including Claude Code and Codex, accept the standard stdio
server shape below. Replace `/absolute/path/to/psd-eoc` and inject the key from
the client's secret mechanism rather than committing a literal credential.

```json
{
  "mcpServers": {
    "psd-eoc": {
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "/absolute/path/to/psd-eoc/packages/mcp",
        "start"
      ],
      "env": {
        "PSD_EOC_AGENT_API_BASE_URL": "https://eoc.example.invalid/api/agent/v1",
        "PSD_EOC_AGENT_API_KEY": "set-via-your-client-secret-store"
      }
    }
  }
}
```

Equivalent Codex `config.toml` shape:

```toml
[mcp_servers.psd-eoc]
command = "bun"
args = ["run", "--cwd", "/absolute/path/to/psd-eoc/packages/mcp", "start"]
env = { PSD_EOC_AGENT_API_BASE_URL = "https://eoc.example.invalid/api/agent/v1", PSD_EOC_AGENT_API_KEY = "set-via-your-secret-store" }
```

The process writes only JSON-RPC messages to stdout. Diagnostics go to stderr.

## Connect over Streamable HTTP

The HTTP server binds to loopback only and serves one endpoint, `/mcp`:

```sh
PSD_EOC_AGENT_API_KEY='set-in-your-secret-manager' \
  PSD_EOC_MCP_HTTP_PORT=3100 \
  bun run --cwd packages/mcp start:http
```

Configure a Streamable HTTP client with `http://127.0.0.1:3100/mcp`. The
implementation supports current MCP `2026-07-28` request metadata and headers,
plus initialization-based `2025-11-25`, `2025-06-18`, and `2025-03-26`
clients. It returns JSON responses rather than opening optional SSE streams.
GET streams and protocol sessions are intentionally not offered.

Browser-origin requests are accepted only from loopback by default. Set
`PSD_EOC_MCP_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist when
needed. `PSD_EOC_MCP_HTTP_HOST` accepts only `127.0.0.1`, `::1`, or `localhost`.

## Resources and error behavior

`psd-eoc://docs/architecture` and `psd-eoc://docs/readiness` expose the current
architecture/contributor guide and operational readiness register as read-only
Markdown resources. Archived plans and decision ledgers are intentionally not
resources. Unknown resource URIs fail; they are never converted into filesystem
paths.

Tool arguments and successful API results are parsed with the canonical
`@psd-eoc/contracts` Zod schemas. Authentication, authorization, and
not-found errors are intentionally scope-safe: they do not enumerate other
facilities, recipient data, or credentials. A `503` means the underlying
capability is not deployed; the MCP adapter never substitutes synthetic data.

## Request budget and retries

The agent API budgets each key: at most 60 requests per minute, and at most
20 per hour across `export-drill-records`, `export-event-summary`, and
`create-activation-preview`, which render a document or persist a row on every
call. Past the budget the API answers `429 RATE_LIMITED` with a `Retry-After`
header; the MCP server surfaces that as a retryable tool error and never
retries on its own. The budget is counted in memory on each server instance,
so a deployment running several instances allows up to that many times the
stated figures; it is a bound, not a guarantee.

Mutation calls (`prepare-activation` and the create/update calls behind
`draft-message-template-revision`) send an `Idempotency-Key` derived from a
SHA-256 of the capability ID and the canonical JSON of the validated
arguments. A model that retries the same tool call therefore gets the stored
result back instead of creating a second prepared activation or draft; a
changed argument is a new request. Idempotency records do not expire, so an
identical call keeps returning its first result for as long as the record
exists; change an argument to make a new one.
