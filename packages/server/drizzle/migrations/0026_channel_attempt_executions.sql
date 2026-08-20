-- The lease and outcome for one channel attempt's provider call.
--
-- channel_attempts records that an attempt exists and never changes. This
-- records who currently holds permission to call the provider for it, and what
-- that call returned. Both are mutable by nature: a lease expires, a worker
-- that dies mid-send has to become reclaimable, and a retry decision
-- supersedes an earlier one.
--
-- Deliberately no foreign key to channel_attempts. A worker claims execution
-- before it writes attempted evidence, so the attempt row is not guaranteed to
-- exist yet at claim time, and a foreign key would reject the very claim that
-- makes the send safe.
--
-- The partial index covers the only scan this table has: find the leases that
-- have expired without completing, so a crashed worker's attempt can be taken
-- over instead of being stranded.

CREATE TABLE "channel_attempt_executions" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" varchar(200) NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"completion" jsonb,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_attempt_executions_completion_pairing" CHECK (("channel_attempt_executions"."completion" is null) = ("channel_attempt_executions"."completed_at" is null)),
	CONSTRAINT "channel_attempt_executions_fingerprint_nonempty" CHECK ("channel_attempt_executions"."fingerprint" = btrim("channel_attempt_executions"."fingerprint")
        and length("channel_attempt_executions"."fingerprint") > 0)
);
--> statement-breakpoint
CREATE INDEX "channel_attempt_executions_reclaimable_idx" ON "channel_attempt_executions" USING btree ("lease_expires_at") WHERE "channel_attempt_executions"."completion" is null;