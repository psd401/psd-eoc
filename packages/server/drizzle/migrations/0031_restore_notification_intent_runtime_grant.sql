-- 0010 moved notification-intent insertion behind a fan-out control function
-- and revoked the application's direct INSERT privilege. 0023 later removed
-- that control and the capability returned to a plain insert, but the revoked
-- table privilege was never restored. The runtime could therefore preview an
-- activation yet every start-event transaction failed at notification intent
-- persistence. Restore only the INSERT operation the canonical capability
-- performs; append-only UPDATE/DELETE restrictions remain unchanged.
GRANT INSERT ON TABLE public."notification_intents" TO "psd_eoc_app";
