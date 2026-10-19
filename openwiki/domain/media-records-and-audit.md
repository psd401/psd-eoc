---
type: Domain Concept
title: Media, records exports, and the security audit chain
description: Untrusted photo upload and sanitization, short-lived private read and export grants, drill and event-summary records (CSV and PDF), and the hash-chained append-only security audit with anchors and verification.
tags: [media, records, exports, audit, hash-chain, s3, guardduty, append-only]
openwiki:
  roles: [domain, architecture]
  change_kinds: [media, exports, audit, security]
  source_paths:
    - packages/server/lib/media
    - packages/server/lib/capabilities/records.ts
    - packages/server/lib/capabilities/records
    - packages/server/lib/audit
    - packages/server/db/schema/audit.ts
    - packages/server/app/api/media
    - packages/server/app/(app)/records
  symbols: [sanitizeUploadedImage, sniffImageContentType, createMediaProcessingGate, MAX_MEDIA_OBJECT_BYTES, RECORDS_EXPORT_GRANT_SECONDS, createRecordsArtifactStore, SecurityAuditService, SecurityAuditChainVerifier, canonicalSecurityAuditJson, runSecurityAuditVerificationJob]
  test_paths:
    - packages/server/lib/media/image.test.ts
    - packages/server/lib/media/object-store.test.ts
    - packages/server/lib/media/processing-gate.test.ts
    - packages/server/lib/media/read-authorization.integration.test.ts
    - packages/server/lib/capabilities/records.test.ts
    - packages/server/lib/capabilities/records/pdf.test.ts
    - packages/server/lib/audit/hash-chain.test.ts
    - packages/server/lib/audit/service.test.ts
    - packages/server/lib/audit/checkpoint.integration.test.ts
  invariants:
    - Uploaded bytes are untrusted; type is decided by content sniffing and metadata (EXIF) is stripped before a photo is readable.
    - Read and export download grants are short-lived (5 minutes max) bearer URLs to private objects.
    - Security audit entries are hash-chained and append-only; corrections never rewrite history.
    - Exports carry no recipient contact data and are records evidence, not compliance determinations.
  validation_commands:
    - bun test packages/server/lib/media/image.test.ts
    - bun test packages/server/lib/audit/hash-chain.test.ts
---

# Media, records exports, and the security audit chain

Three server subsystems that handle evidence. Each is reached only through capabilities ([engine](../architecture/capability-engine.md)); persistence is in the shared schema ([data model](data-model.md)).

## Event media (photos)

Capabilities: `create-media-upload-intent`, `complete-media-upload`, `get-media-read-grant`; HTTP: `app/api/media/upload-intents`, `.../[uploadIntentId]/complete`, `.../events/[eventId]/[mediaId]/read-grant`. Code: `packages/server/lib/media`.

1. An upload intent is allocated against per-resource budgets (`repository.ts`: `mediaUploadBudgetViolation`, bounded statement/lock timeouts) and returns a presigned upload grant (`object-store.ts`, `MAX_MEDIA_UPLOAD_GRANT_SECONDS` 15 min max, 5 min default; `MAX_MEDIA_OBJECT_BYTES` 25 MiB).
2. The client uploads into a quarantine key (`quarantineStorageKey`, prefix `quarantine/<event>/<intent>`). GuardDuty Malware Protection for S3 scans and tags the object; the code checks object tags (`GetObjectTagging`) and fails closed. The infra plan is conditional (CDK) and is `configured-unverified` in the readiness register.
3. `complete-media-upload` reads the object, sniffs the true content type (`sniffImageContentType`, never the client claim), and `sanitizeUploadedImage` (sharp) re-encodes within limits (`MAX_IMAGE_PIXELS` 40 M, single page, 10 s, HEIC only when decode is available) which strips EXIF/location. The sanitized object and checksum become the `media_records` row referenced by a journal photo entry.
4. Concurrency is capped by fail-fast gates (`processing-gate.ts`: 1 per facility, 2 per instance) so untrusted media never queues in memory or inside a DB transaction; saturation maps to a retryable capacity error.
5. Viewing uses `get-media-read-grant`: authorization re-checked per request, presigned GET with `MAX_MEDIA_READ_GRANT_SECONDS` ≤ 5 minutes.

The mobile photo draft/upload path is described in the [mobile app](../integrations/mobile-app.md); the event room that shows photos is in [lifecycle](event-lifecycle-and-activation.md).

## Records and exports

`packages/server/lib/capabilities/records.ts` registers `list-drill-records`, `list-event-records`, `export-drill-records` (CSV, `records/csv.ts`) and `export-event-summary` (PDF, `records/pdf.ts` using the embedded Noto Sans asset checked against a SHA-256). Artifacts are immutable, content-addressed objects written by `records/artifact-store.ts` (`createRecordsArtifactStore`, `MAX_RECORDS_EXPORT_BYTES` 25 MiB) and returned as private download grants valid `RECORDS_EXPORT_GRANT_SECONDS` = 5 minutes. A server test keeps the `packages/mcp/README.md` sentence in step with that constant. Event summaries include journal provenance, photo checksum references and exact delivery truth states (never conflating provider acceptance with receipt) but no recipient contact data. Browser download routes: `app/(app)/records/export/{drills,events/[id]}/route.ts`; page: `app/(app)/records/page.tsx` (defaults to every authorized site; filters live in one tested module).

Production gotcha recorded in `docs/INTEGRATIONS.md` (status `blocked`): PDF rendering depends on bundled font assets that unit tests cannot detect missing; a bundle-level check does not exist, and PDF tests need Poppler `pdftotext` (skipped when absent). Agents are rate limited on export capabilities ([agent API](../integrations/agent-api-and-mcp.md)).

## Security audit chain

- Facts (`lib/audit/model.ts`, `parseSecurityAuditFact`) are appended through a minimal `SecurityAuditWriter` seam used by auth, capability and admin call sites. `SecurityAuditService` (`service.ts`) enforces scope and exposes `query-security-audit` and `verify-security-audit-chain`.
- Each entry hash covers a canonical JSON of all other fields (`canonical.ts` `canonicalSecurityAuditJson`, byte-compatible with the earlier sign-in audit writer, so changing it breaks verification of old rows). `SecurityAuditChainVerifier` (`verification.ts`) walks pages of 200, checks sequence continuity and persisted anchors (`security_audit_chain_anchors`, per-facility anchors in `configuration.ts`).
- `human-only.ts` formats the `human-only-rejection` / agent-denial facts for the four protected actions ([engine](../architecture/capability-engine.md#human-only-actions-and-confirmation)).
- `verification-job.ts` `runConfiguredSecurityAuditVerificationJob` runs the district-wide verifier as a scheduled system actor; `app/(admin)/audit/page.tsx` is the admin view.
- The engine appends audit in the same transaction as the domain write for mutations, and for every outcome (including denials and replays) as catalog `auditPolicy` requires.

## Change guidance

- Image limits or accepted types: change `image.ts` and the contract `MediaContentTypeSchema` together; keep EXIF stripping and content sniffing; tests in `image.test.ts`.
- New export: add the capability in contracts first, register in `records.ts`, keep grants private/short-lived, add to the agent rate-limit costly list only if it renders or persists per call, and update MCP README text if the TTL changes.
- Audit fact shape: update `model.ts` and the contracts `audit.ts` together; never alter canonical hashing for existing facts; add a hash-chain test.
- Narrow checks: `bun test packages/server/lib/media` and `bun test packages/server/lib/audit`; files named `*.integration.test.ts` need the synthetic database ([verification](../testing/verification-and-testing.md)). Production S3/GuardDuty behavior is not testable offline.
