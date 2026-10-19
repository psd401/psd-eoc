-- A reviewer can now withdraw an unpublished draft. The discard is one more
-- completed idempotency record, keyed by this capability, whose result
-- reference names the exact draft revision that was withdrawn; the draft row,
-- its templates, and its revision ledger stay as written. Nothing else in the
-- schema changes.
ALTER TYPE "public"."mutation_capability" ADD VALUE 'discard-event-type-draft';
