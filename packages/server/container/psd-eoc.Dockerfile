FROM oven/bun:1.2.23-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a AS base

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS manifests

COPY package.json bun.lock tsconfig.base.json ./
COPY patches ./patches
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY workers/package.json workers/tsconfig.json workers/

# The immutable image also runs the separately permissioned channel tasks. The
# ECS roles and commands remain distinct from App Runner even though the bytes
# match.
RUN bun -e 'const path = "/app/package.json"; const manifest = await Bun.file(path).json(); manifest.workspaces = ["packages/contracts", "packages/server", "workers"]; await Bun.write(path, `${JSON.stringify(manifest)}\n`);'
RUN bun install --lockfile-only

FROM manifests AS build

ARG SOURCE_SHA

RUN printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$'
RUN bun install --frozen-lockfile

COPY packages/contracts/src packages/contracts/src
COPY packages/server packages/server
# Copy only the transitive source closure of the channel worker entry points. This
# keeps test fixtures and unrelated channel workers out of the production image.
COPY workers/shared/attempt.ts workers/shared/attempt.ts
COPY workers/shared/attempt-execution-client.ts workers/shared/attempt-execution-client.ts
COPY workers/shared/batch-message.ts workers/shared/batch-message.ts
COPY workers/shared/delivery-state-client.ts workers/shared/delivery-state-client.ts
COPY workers/shared/processor.ts workers/shared/processor.ts
COPY workers/shared/retry.ts workers/shared/retry.ts
COPY workers/shared/index.ts workers/shared/index.ts
COPY workers/email/aws-arn.ts workers/email/aws-arn.ts
COPY workers/email/aws-client.ts workers/email/aws-client.ts
COPY workers/email/callback-service.ts workers/email/callback-service.ts
COPY workers/email/email-message.ts workers/email/email-message.ts
COPY workers/email/queue-runtime.ts workers/email/queue-runtime.ts
COPY workers/email/runtime.ts workers/email/runtime.ts
COPY workers/email/ses-adapter.ts workers/email/ses-adapter.ts
COPY workers/email/ses-events.ts workers/email/ses-events.ts
COPY workers/email/service.ts workers/email/service.ts
COPY workers/email/sns-signature.ts workers/email/sns-signature.ts
COPY workers/email/state-client.ts workers/email/state-client.ts
COPY workers/push/adapter.ts workers/push/adapter.ts
COPY workers/push/eligibility.ts workers/push/eligibility.ts
COPY workers/push/invalidation.ts workers/push/invalidation.ts
COPY workers/push/protocol.ts workers/push/protocol.ts
COPY workers/push/receipt-lifecycle.ts workers/push/receipt-lifecycle.ts
COPY workers/push/runtime.ts workers/push/runtime.ts
COPY workers/push/service.ts workers/push/service.ts
COPY workers/push/state-client.ts workers/push/state-client.ts
COPY workers/push/transport.ts workers/push/transport.ts
COPY workers/push/worker.ts workers/push/worker.ts
COPY workers/sms/aws-eum-adapter.ts workers/sms/aws-eum-adapter.ts
COPY workers/sms/aws-eum-client.ts workers/sms/aws-eum-client.ts
COPY workers/sms/delivery-events.ts workers/sms/delivery-events.ts
COPY workers/sms/opt-out.ts workers/sms/opt-out.ts
COPY workers/sms/runtime.ts workers/sms/runtime.ts
COPY workers/sms/service.ts workers/sms/service.ts
COPY workers/sms/state-client.ts workers/sms/state-client.ts
COPY workers/sms/worker.ts workers/sms/worker.ts

RUN bun run --cwd packages/server build

FROM manifests AS production-dependencies

RUN bun install --frozen-lockfile --production

FROM base AS runtime

ARG SOURCE_REPOSITORY_URL
ARG SOURCE_SHA

RUN printf '%s' "$SOURCE_REPOSITORY_URL" | grep -Eq '^https://[^[:space:]/]+/[^[:space:]]+$'

LABEL org.opencontainers.image.source="$SOURCE_REPOSITORY_URL" \
      org.opencontainers.image.revision="$SOURCE_SHA" \
      org.opencontainers.image.title="PSD EOC live pilot" \
      org.psd-eoc.environment="live-pilot" \
      org.psd-eoc.data-classification="staff-minimized"

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
COPY --from=build --chown=bun:bun /app/workers ./workers

USER bun

EXPOSE 3000

CMD ["bun", "--cwd", "packages/server", "start"]
