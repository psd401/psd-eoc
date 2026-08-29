-- Grants the application role INSERT on every column of the tables the channel
-- workers write. Column-scoped INSERT cannot work here, and this is why.
--
-- PostgreSQL requires INSERT privilege on every column NAMED in a statement,
-- whether or not the statement supplies a value for it. The query builder names
-- every column of the table and writes DEFAULT for the ones the caller left
-- out:
--
--   insert into "channel_attempt_executions"
--     ("attempt_id", "fingerprint", "lease_token", "lease_expires_at",
--      "completion", "completed_at", "created_at")
--   values ($1, $2, gen_random_uuid(), clock_timestamp() + ..., default,
--           default, default)
--
-- A grant naming only the four columns the caller sets therefore refuses that
-- insert, even though the other three receive their defaults and no value from
-- the application ever reaches them. Migration 0036 granted exactly those
-- narrow column lists for the provider runtime tables, and 0041 repeated the
-- mistake for the execution lease.
--
-- The effect was total: a worker claims an execution lease before it calls a
-- provider, so the first insert of every send was refused, on every channel.
-- Both workers reported it as IDEMPOTENCY_STORE_FAILED. No attempt, no
-- provider I/O record, and no delivery evidence has ever been written.
--
-- UPDATE stays column-scoped and is untouched. An UPDATE names only the columns
-- it sets, so those grants work as written and still confine the application to
-- completing a lease rather than rewriting one. The append-only triggers 0036
-- installed on the provider I/O tables remain the real guarantee that recorded
-- truth is never rewritten; they enforce it in the database regardless of which
-- columns an INSERT happens to name.
GRANT INSERT ON TABLE
	public."channel_attempt_executions",
	public."expo_push_provider_io",
	public."expo_push_receipt_polls",
	public."expo_push_retry_schedules",
	public."sms_provider_io",
	public."sms_retry_schedules"
TO "psd_eoc_app";
