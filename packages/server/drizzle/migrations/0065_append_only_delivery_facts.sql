-- Attempts and endpoint lifecycle facts are appended and never changed. Their
-- immutable-truth triggers already refuse an UPDATE, but the application role
-- still held the table-level UPDATE that 0000 granted on every table:
-- 0000 revoked it from channel_attempts, and endpoint_status_records kept it.
-- No application path updates either table (partner delivery, #597, only
-- appends), so the privilege is revoked rather than narrowed to columns. The
-- channel_attempts revoke restates 0000 so that both tables visibly match;
-- REVOKE of a privilege not held is a no-op.
REVOKE UPDATE ON TABLE public."channel_attempts", public."endpoint_status_records" FROM "psd_eoc_app";
