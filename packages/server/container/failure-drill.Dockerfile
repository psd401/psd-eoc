FROM oven/bun:1.2.23-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS manifests

COPY package.json bun.lock tsconfig.base.json ./
COPY patches ./patches
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY scripts/ops/package.json scripts/ops/tsconfig.json scripts/ops/
COPY workers/package.json workers/tsconfig.json workers/

RUN bun -e 'const path = "/app/package.json"; const manifest = await Bun.file(path).json(); manifest.workspaces = ["packages/contracts", "packages/server", "scripts/ops", "workers"]; await Bun.write(path, `${JSON.stringify(manifest)}\n`);'
RUN bun install --lockfile-only

FROM manifests AS build

ARG SOURCE_SHA

RUN printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$'
RUN bun install --frozen-lockfile

COPY packages/contracts/src packages/contracts/src
COPY packages/server packages/server
COPY workers/email/aws-arn.ts workers/email/ses-events.ts workers/email/sns-signature.ts workers/email/
COPY scripts/ops/failure-drills/drill-session-route.ts packages/server/app/api/failure-drills/session/route.ts
COPY scripts/ops/failure-drills/drill-callback-route.ts packages/server/app/api/failure-drills/callback/route.ts
COPY scripts/ops/failure-drills/drill-callback-boundary.ts packages/server/app/api/failure-drills/callback/drill-callback-boundary.ts

RUN bun run --cwd packages/server build

FROM manifests AS runtime-dependencies

RUN bun install --frozen-lockfile --production

FROM base AS runtime

ARG SOURCE_REPOSITORY_URL
ARG SOURCE_SHA

RUN printf '%s' "$SOURCE_REPOSITORY_URL" | grep -Eq '^https://[^[:space:]/]+/[^[:space:]]+$'

LABEL org.opencontainers.image.source="$SOURCE_REPOSITORY_URL" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.title="PSD EOC synthetic failure drill" \
      org.psd-eoc.environment="failure-drill" \
      org.psd-eoc.data-classification="synthetic-only" \
      org.psd-eoc.provider-mode="mocked"

ENV HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000

COPY --from=runtime-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=runtime-dependencies --chown=bun:bun /app/package.json ./package.json
COPY --from=runtime-dependencies --chown=bun:bun /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=runtime-dependencies --chown=bun:bun /app/packages/server/package.json ./packages/server/package.json
COPY --from=runtime-dependencies --chown=bun:bun /app/scripts/ops/package.json ./scripts/ops/package.json
COPY --from=runtime-dependencies --chown=bun:bun /app/workers/package.json ./workers/package.json
COPY --from=build --chown=bun:bun /app/packages/contracts/src ./packages/contracts/src
COPY --from=build --chown=bun:bun /app/packages/server ./packages/server
COPY --chown=bun:bun scripts/ops/failure-drills ./scripts/ops/failure-drills
COPY --chown=bun:bun workers ./workers

USER bun

EXPOSE 3000

CMD ["bun", "--cwd", "packages/server", "start"]
