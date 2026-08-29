-- Grants the application role the privileges it needs on
-- "channel_attempt_executions". Without them this system has never delivered a
-- notification.
--
-- Migration 0026 created this table. The blanket application-role grant ran
-- before it, and PostgreSQL does not apply an earlier GRANT ... ON ALL TABLES
-- to a table created later -- the same defect 0036 corrected for the provider
-- runtime tables and 0040 corrected for "notification_intents". The table was
-- left with a null ACL: reachable by its owner and by nobody else. It is the
-- only table in the database in that state.
--
-- Every channel worker claims an execution lease here before it calls a
-- provider, so the refusal landed on the first step of every send. Both the
-- email and push workers reported it as ATTEMPT_FAILED, and no attempt was
-- ever recorded: "channel_attempts" is empty. A staff drill or a real incident
-- could be confirmed by a human, queue its batches, and reach nobody.
--
-- Column-scoped, matching the least-privilege shape 0036 established.
--
-- DELETE is included and is deliberate. Releasing an unfinished lease deletes
-- the row so a worker that could not send does not strand the attempt; the
-- store restricts that delete to rows whose completion is still null, so a
-- completed execution cannot be removed and re-sent.
GRANT SELECT ON TABLE public."channel_attempt_executions" TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT ("attempt_id", "fingerprint", "lease_token", "lease_expires_at")
ON TABLE public."channel_attempt_executions"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT UPDATE ("lease_token", "lease_expires_at", "completion", "completed_at")
ON TABLE public."channel_attempt_executions"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT DELETE ON TABLE public."channel_attempt_executions" TO "psd_eoc_app";
