-- Removes the fan-out control gate.
--
-- Every notification intent had to be bound, at insert, to a "control record"
-- carrying an enable epoch. Absent that record the insert refused with
-- CONTROL_STATE_MISSING, so a deployment that had never been switched on could
-- not send anything and gave no hint why. The mode it gated had two values,
-- 'enabled' and 'emergency-disabled', and the product owner's decision is that
-- there is never a reason to turn notifications off: this is an emergency
-- notification system, and a switch that silently stops it is a liability
-- rather than a safety control.
--
-- What still governs a fan-out is unchanged and lives elsewhere: an activation
-- requires an authenticated human and a fresh consequence preview, drills never
-- render as real, and the human-only capability registry refuses an agent.
DROP FUNCTION IF EXISTS public."psd_eoc_insert_authorized_notification_intent"(
  uuid, uuid, event_kind, template_mode, notification_purpose, uuid, uuid,
  roster_population, uuid, integer, jsonb, invocation_source, uuid, jsonb,
  uuid, integer, varchar, timestamptz
);
--> statement-breakpoint
DROP TABLE IF EXISTS public."fanout_intent_authorizations";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "fanout_control_records_insert_guard"
  ON public."fanout_control_records";
--> statement-breakpoint
DROP TABLE IF EXISTS public."fanout_control_records";
--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_fanout_control_insert"();
--> statement-breakpoint
DROP TYPE IF EXISTS public."fanout_control_mode";
