FROM oven/bun:1.2.23-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS manifests

COPY package.json bun.lock tsconfig.base.json ./
COPY patches ./patches
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/

# This image intentionally contains only the server and its contracts workspace.
RUN bun -e 'const path = "/app/package.json"; const manifest = await Bun.file(path).json(); manifest.workspaces = ["packages/contracts", "packages/server"]; await Bun.write(path, `${JSON.stringify(manifest)}\n`);'
RUN bun install --lockfile-only

FROM manifests AS build

ARG SOURCE_SHA

RUN printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$'
RUN bun install --frozen-lockfile

COPY packages/contracts/src packages/contracts/src
COPY packages/server packages/server
COPY workers/email/ses-events.ts workers/email/sns-signature.ts workers/email/

RUN bun run --cwd packages/server build

FROM manifests AS production-dependencies

RUN bun install --frozen-lockfile --production

FROM base AS runtime

ARG SOURCE_SHA

LABEL org.opencontainers.image.source="https://github.com/psd401/psd-eoc" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.title="PSD EOC exploration smoke" \
      net.psd401.environment="exploration-smoke" \
      net.psd401.data-classification="synthetic-only"

ENV HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=bun:bun /app/package.json ./package.json
COPY --from=production-dependencies --chown=bun:bun /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=bun:bun /app/packages/contracts/src ./packages/contracts/src
# The same immutable image serves App Runner and the protected one-off native
# PostgreSQL bootstrap task. Keep the reviewed bootstrap source, migrations,
# and pinned RDS CA bundle beside the built Next application.
COPY --from=build --chown=bun:bun /app/packages/server ./packages/server

USER bun

EXPOSE 3000

CMD ["bun", "--cwd", "packages/server", "start"]
