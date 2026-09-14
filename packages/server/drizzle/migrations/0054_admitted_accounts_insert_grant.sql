-- Custom SQL migration file, put your code below! --

-- Completes the application role's INSERT privilege on "admitted_accounts".
-- Migration 0053 granted INSERT on the columns the capability sets, but the
-- query builder names every column of the table and writes DEFAULT for the
-- ones the caller omits, and PostgreSQL requires INSERT privilege on every
-- column NAMED in a statement (the rule migrations 0042 and 0048 record).
-- Production refused the first admission with 42501. A row is only ever
-- inserted unrevoked, so naming the revocation columns here changes nothing
-- about what an admission means; UPDATE stays scoped to those two columns
-- and no DELETE is granted.
GRANT INSERT ("revoked_at", "revoked_by_user_id")
ON TABLE public."admitted_accounts" TO "psd_eoc_app";
