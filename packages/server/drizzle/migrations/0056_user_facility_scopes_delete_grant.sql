-- Custom SQL migration file, put your code below! --

-- Lets the application role rewrite a person's facility limit.
-- Migration 0000 revoked DELETE on every table from psd_eoc_app, which is
-- right for evidence and never for this table: user_facility_scopes is the
-- current set of facilities a person is limited to, and narrowing or lifting
-- the limit (set-user-facility-scope, added in #494) deletes the rows that no
-- longer apply before inserting the ones that do. Production refused the
-- first limit with 42501. No other table gains DELETE.
GRANT DELETE ON TABLE public."user_facility_scopes" TO "psd_eoc_app";
