ALTER TABLE "lifecycle_consequence_previews" DROP CONSTRAINT "lifecycle_consequence_previews_event_targeting_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_event_targeting_fk";
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_notification_anchor_uq" UNIQUE("id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population");--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_event_truth_fk" FOREIGN KEY ("event_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") REFERENCES "public"."events"("id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_truth_fk" FOREIGN KEY ("event_id","event_kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") REFERENCES "public"."events"("id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") ON DELETE restrict ON UPDATE no action;
