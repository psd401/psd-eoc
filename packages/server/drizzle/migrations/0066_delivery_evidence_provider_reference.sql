-- An SMS delivery receipt names only the provider's message id, and the
-- lookup by (provider, provider_reference) had no index: every receipt read
-- the whole append-only delivery_evidence table. Most rows carry no provider
-- reference, so the index is partial.
CREATE INDEX "delivery_evidence_provider_reference_idx" ON "delivery_evidence" USING btree ("provider","provider_reference") WHERE "delivery_evidence"."provider_reference" is not null;--> statement-breakpoint
-- Per-query statistics. The cluster already preloads pg_stat_statements; the
-- extension was never created in this database, so production had no record
-- of which statements cost the most. It changes no data and grants nothing to
-- the application role.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
