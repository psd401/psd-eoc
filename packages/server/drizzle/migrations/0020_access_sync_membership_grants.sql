-- The access sync replaces membership, so it needs to write it.
--
-- Migration 0017 granted the application role SELECT on access_group_members,
-- which is what sign-in needs. The access sync runs as the same role and
-- replaces each configured group's membership wholesale, so it also needs
-- INSERT and DELETE here, and UPDATE on group_sources to stamp when the group
-- was last read.
--
-- DELETE is deliberate on this table and only this table. Membership is a
-- current fact, not a record: a person who has left a group must stop being in
-- it, and retaining the row would mean retaining their access. The append-only
-- rules that protect the journal, the audit chain, and the role ledger are
-- unaffected.
--
-- Found by the first production sync after the cutover, which failed closed on
-- "permission denied" rather than writing a partial membership.

GRANT INSERT, DELETE ON TABLE public."access_group_members" TO "psd_eoc_app";

GRANT UPDATE ON TABLE public."group_sources" TO "psd_eoc_app";
