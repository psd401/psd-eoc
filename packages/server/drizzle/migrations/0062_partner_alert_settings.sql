ALTER TYPE "public"."mutation_capability" ADD VALUE 'set-partner-alert-settings';--> statement-breakpoint
CREATE TABLE "partner_alert_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"response_family_keys" varchar(100)[] NOT NULL,
	"excluded_threat_keys" varchar(100)[] NOT NULL,
	"supersedes_version_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_alert_settings_version_positive" CHECK ("partner_alert_settings"."version" > 0),
	CONSTRAINT "partner_alert_settings_first_replaces_nothing" CHECK (("partner_alert_settings"."version" = 1) = ("partner_alert_settings"."supersedes_version_id" is null)),
	CONSTRAINT "partner_alert_settings_not_self_superseding" CHECK ("partner_alert_settings"."supersedes_version_id" is null or "partner_alert_settings"."supersedes_version_id" <> "partner_alert_settings"."id"),
	CONSTRAINT "partner_alert_settings_response_keys_bounded" CHECK (coalesce(array_ndims("partner_alert_settings"."response_family_keys"), 1) = 1
        and cardinality("partner_alert_settings"."response_family_keys") <= 100
        and array_position("partner_alert_settings"."response_family_keys", null) is null),
	CONSTRAINT "partner_alert_settings_threat_keys_bounded" CHECK (coalesce(array_ndims("partner_alert_settings"."excluded_threat_keys"), 1) = 1
        and cardinality("partner_alert_settings"."excluded_threat_keys") <= 200
        and array_position("partner_alert_settings"."excluded_threat_keys", null) is null)
);
--> statement-breakpoint
ALTER TABLE "partner_alert_settings" ADD CONSTRAINT "partner_alert_settings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_alert_settings" ADD CONSTRAINT "partner_alert_settings_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."partner_alert_settings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_alert_settings_version_uq" ON "partner_alert_settings" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_alert_settings_supersedes_uq" ON "partner_alert_settings" USING btree ("supersedes_version_id");--> statement-breakpoint
-- A saved version is a record of an administrator's decision and is never
-- changed: a new decision is a new version. It reuses the partner-admission
-- append-only guard from 0059, as 0060 and 0061 do.
CREATE TRIGGER "partner_alert_settings_append_only"
BEFORE UPDATE OR DELETE ON public."partner_alert_settings"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
-- The application role reads and appends, naming every column the query
-- builder writes (see 0042 and 0054); no UPDATE or DELETE is granted.
GRANT SELECT ON TABLE public."partner_alert_settings" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "version", "response_family_keys", "excluded_threat_keys",
  "supersedes_version_id", "created_by_user_id", "created_at"
) ON TABLE public."partner_alert_settings" TO "psd_eoc_app";
