# PSD EOC channel-worker rules

Channel workers are an at-least-once boundary for already authorized
notifications. They may record delivery attempts and hand rendered copy to one
channel provider. They may never start, reactivate, all-clear, close, or
otherwise mutate an event.

## Required processing flow

1. Parse the SQS body with `parseWorkerBatchMessage`. The body is the raw,
   canonical `DispatchBatchSchema` value, not a worker-defined wrapper. It is
   destination-free and repeats real/drill classification across the queue
   boundary.
2. Resolve active endpoints only from the batch's pinned immutable roster
   snapshot. Never use a current roster, accept a destination from SQS, or log
   a token, email address, or phone number.
3. Reserve or load the immutable `ChannelAttempt` using the durable uniqueness
   anchor `(batchId, endpointId, attemptNumber)`. A redelivery recovers the same
   `attempt.id`; it never mints another ID for the same attempt. The internal
   delivery-state route strictly composes the existing `ChannelAttempt` and
   `RecordDeliveryEvidenceInput` contracts so it can persist the attempt and
   append evidence without exposing an event mutation.
4. Validate `{ batch, attempt, endpoint }` with
   `parseWorkerAttemptWorkItem`. It proves channel, event ID, event kind,
   template mode, purpose, event-type version, roster snapshot, population,
   endpoint, and attempt identities agree. Synthetic endpoints must remain
   provably unroutable.
5. Process with `WorkerAttemptProcessor` and a durable
   `AttemptExecutionStore`. A Lambda-local map is not a production store. The
   store binds `ChannelAttempt.id` to the PII-safe work fingerprint, rejects
   conflicting reuse, and persists the provider outcome or retry schedule
   before returning.
6. Delete or acknowledge the queue delivery only after the returned decision
   has been durably handled. `retry` schedules a new immutable attempt at the
   returned bounded delay. `dlq` invokes the queue redrive path; the DLQ alarm
   is wired by the monitoring issue.

## Idempotency and crash truth

Standard SQS is at-least-once. A durable claim prevents completed and
concurrent duplicates from invoking the adapter again, but it cannot make an
arbitrary external provider exactly-once across every process crash. Therefore
every adapter must declare and actually implement attempt-ID idempotency:

- Pass `attempt.id` unchanged to a provider idempotency facility, or place a
  durable provider-send ledger in front of the provider.
- If neither is possible, the adapter stays blocked. Do not claim exactly-once
  delivery from a local cache.
- A crash after the provider side effect but before local completion may cause
  the adapter to be invoked again after lease recovery. The repeated
  `attempt.id` must resolve to the original logical send, never a second send.
- A provider exception is ambiguous unless the adapter can prove it is safe to
  retry or a terminal failure. Ambiguous work appends `unknown`, is retained in
  the DLQ/reconciliation path, and is never blindly resent.

## Retry and evidence rules

- Use the shared capped exponential policy. No channel may add an unbounded
  loop or silently reset attempt numbers.
- A provider failure proven safe to retry completes the current attempt with
  truthful `failed` evidence. The scheduled retry uses the next attempt number
  and a new attempt ID. Persist the retry schedule with the completion so a
  crash cannot lose it.
- `provider-accepted` is not `delivered`. Record `delivered` only with the
  contract's provider delivery proof. `unknown` is an ordinary visible truth
  state, not missing data.
- External errors are untrusted. Map them to bounded uppercase reason codes and
  an optional SHA-256 diagnostic digest. Never persist or log a raw provider
  response.
- Append through `DeliveryStateWritebackClient`. Its credential is valid only
  for `POST /api/internal/delivery-state`; never give a worker an interactive,
  agent, general API, or event-lifecycle credential.

## Classification and integration safety

- Use the exact rendered message in the batch. Do not re-render it, remove its
  `[INCIDENT]` or `[DRILL]` marker, or infer classification from editable text.
- Adapter channel, integration ID, and truth label must exactly match the
  batch. Synthetic work uses `mocked` adapters and unroutable fixtures.
- A `live-verified` adapter is disabled unless its worker supplies an explicit
  runtime authorization gate. `configured-unverified` and `blocked`
  integrations never send.
- Shared worker code contains no provider SDK and performs no live send. Dev
  and CI adapters are mocks that fail closed.

## Minimum channel-worker tests

- Raw `DispatchBatchSchema` parsing rejects wrappers and real/drill drift.
- Completed and concurrent duplicate deliveries produce one logical send.
- Crash after provider completion but before writeback replays only writeback.
- Crash after a provider side effect uses the same attempt ID and the adapter's
  idempotency guarantee to prevent a duplicate logical send.
- Safe retries stop at the configured maximum, append failure evidence for
  each attempt, and end in DLQ redrive.
- Ambiguous outcomes append `unknown` and do not auto-resend.
- Real and drill copy retains its distinct contract marker through the adapter
  request.
