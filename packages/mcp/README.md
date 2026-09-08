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
recipient contact data. Both return private download grants that expire within
15 minutes. Export artifacts remain records evidence, not a legal or
district-policy compliance determination.

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
purpose, and all untouched wording from the canonical source.

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
