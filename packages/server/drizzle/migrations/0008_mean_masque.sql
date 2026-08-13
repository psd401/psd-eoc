CREATE TYPE "public"."fanout_control_mode" AS ENUM('enabled', 'emergency-disabled');--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'set-fanout-control' BEFORE 'issue-agent-api-key';--> statement-breakpoint
CREATE TABLE "fanout_control_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer NOT NULL,
	"previous_record_id" uuid,
	"mode" "fanout_control_mode" NOT NULL,
	"enable_epoch_id" uuid,
	"reason" varchar(500) NOT NULL,
	"product_owner_approval_reference" varchar(255),
	"changed_by_user_id" uuid NOT NULL,
	"changed_with_session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanout_control_records_enabled_anchor_uq" UNIQUE("id","enable_epoch_id","mode"),
	CONSTRAINT "fanout_control_records_revision_positive" CHECK ("fanout_control_records"."revision" > 0),
	CONSTRAINT "fanout_control_records_root_revision" CHECK (("fanout_control_records"."revision" = 1) = ("fanout_control_records"."previous_record_id" is null)),
	CONSTRAINT "fanout_control_records_reason_nonempty" CHECK ("fanout_control_records"."reason" = btrim("fanout_control_records"."reason") and length("fanout_control_records"."reason") > 0),
	CONSTRAINT "fanout_control_records_mode_evidence" CHECK ((
        "fanout_control_records"."mode" = 'enabled'
        and "fanout_control_records"."enable_epoch_id" is not null
        and "fanout_control_records"."product_owner_approval_reference" is not null
        and "fanout_control_records"."product_owner_approval_reference" = btrim("fanout_control_records"."product_owner_approval_reference")
        and length("fanout_control_records"."product_owner_approval_reference") > 0
      ) or (
        "fanout_control_records"."mode" = 'emergency-disabled'
        and "fanout_control_records"."enable_epoch_id" is null
        and "fanout_control_records"."product_owner_approval_reference" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "fanout_intent_authorizations" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"control_record_id" uuid NOT NULL,
	"enable_epoch_id" uuid NOT NULL,
	"control_mode" "fanout_control_mode" DEFAULT 'enabled' NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanout_intent_authorizations_enabled_only" CHECK ("fanout_intent_authorizations"."control_mode" = 'enabled')
);
--> statement-breakpoint
ALTER TABLE "fanout_control_records" ADD CONSTRAINT "fanout_control_records_previous_fk" FOREIGN KEY ("previous_record_id") REFERENCES "public"."fanout_control_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanout_control_records" ADD CONSTRAINT "fanout_control_records_changer_session_fk" FOREIGN KEY ("changed_with_session_id","changed_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanout_intent_authorizations" ADD CONSTRAINT "fanout_intent_authorizations_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanout_intent_authorizations" ADD CONSTRAINT "fanout_intent_authorizations_enabled_control_fk" FOREIGN KEY ("control_record_id","enable_epoch_id","control_mode") REFERENCES "public"."fanout_control_records"("id","enable_epoch_id","mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanout_control_records_revision_uq" ON "fanout_control_records" USING btree ("revision");--> statement-breakpoint
CREATE UNIQUE INDEX "fanout_control_records_previous_uq" ON "fanout_control_records" USING btree ("previous_record_id") WHERE "fanout_control_records"."previous_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "fanout_control_records_enable_epoch_uq" ON "fanout_control_records" USING btree ("enable_epoch_id") WHERE "fanout_control_records"."enable_epoch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "fanout_control_records_request_uq" ON "fanout_control_records" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "fanout_control_records_latest_idx" ON "fanout_control_records" USING btree ("revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fanout_intent_authorizations_epoch_idx" ON "fanout_intent_authorizations" USING btree ("enable_epoch_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_fanout_control_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_record record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('psd-eoc:fanout-control:v1', 0));
  SELECT "id", "revision"
  INTO current_record
  FROM public."fanout_control_records"
  ORDER BY "revision" DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW."revision" <> 1 OR NEW."previous_record_id" IS NOT NULL THEN
      RAISE EXCEPTION 'initial fanout control record must be revision one'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."revision" <> current_record."revision" + 1
    OR NEW."previous_record_id" IS DISTINCT FROM current_record."id"
  THEN
    RAISE EXCEPTION 'fanout control record must append to the current revision'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."psd_eoc_insert_authorized_notification_intent"(
  p_id uuid,
  p_event_id uuid,
  p_event_kind public.event_kind,
  p_template_mode public.template_mode,
  p_purpose public.notification_purpose,
  p_event_type_version_id uuid,
  p_roster_snapshot_id uuid,
  p_roster_population public.roster_population,
  p_audience_config_id uuid,
  p_audience_config_version integer,
  p_created_by jsonb,
  p_source public.invocation_source,
  p_request_id uuid,
  p_authorization jsonb,
  p_created_at timestamp with time zone,
  p_preview_created_at timestamp with time zone
)
RETURNS TABLE (control_record_id uuid, enable_epoch_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_record record;
  canonical_preview_created_at timestamp with time zone;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('psd-eoc:fanout-control:v1', 0)
  );
  SELECT
    control."id",
    control."mode",
    control."enable_epoch_id",
    control."changed_at"
  INTO current_record
  FROM public."fanout_control_records" AS control
  ORDER BY control."revision" DESC
  LIMIT 1;

  IF NOT FOUND
    OR current_record."mode" <> 'enabled'
    OR current_record."enable_epoch_id" IS NULL
  THEN
    RAISE EXCEPTION 'notification intent is not authorized by the current enabled fanout epoch'
      USING ERRCODE = '55000';
  END IF;

  IF p_purpose = 'activation' THEN
    SELECT preview."created_at"
    INTO canonical_preview_created_at
    FROM public."activation_previews" AS preview
    JOIN public."events" AS event
      ON event."id" = p_event_id
      AND event."facility_id" = preview."facility_id"
      AND event."status" = 'active'
      AND event."activation_authorization" = p_authorization
    JOIN public."event_transitions" AS transition
      ON transition."event_id" = event."id"
      AND transition."transition" = 'activate'
      AND transition."activation_authorization" = p_authorization
      AND transition."request_id" = p_request_id
      AND transition."occurred_at" = p_created_at
      AND transition."actor" = p_created_by
      AND transition."source" = p_source
    JOIN public."audience_configurations" AS audience
      ON audience."id" = preview."audience_config_id"
      AND audience."version" = preview."audience_config_version"
      AND audience."facility_id" = preview."facility_id"
    WHERE preview."id" = NULLIF(p_authorization ->> 'activationPreviewId', '')::uuid
      AND preview."kind" = p_event_kind
      AND preview."template_mode" = p_template_mode
      AND preview."event_type_version_id" = p_event_type_version_id
      AND preview."roster_snapshot_id" = p_roster_snapshot_id
      AND preview."roster_population" = p_roster_population
      AND preview."audience_config_id" = p_audience_config_id
      AND preview."audience_config_version" = p_audience_config_version
      AND preview."consequence_digest" = p_authorization ->> 'consequenceDigest'
      AND preview."send_readiness" = 'ready'
      AND preview."expires_at" >= p_created_at
      AND preview."expires_at" >= pg_catalog.clock_timestamp();
  ELSE
    SELECT preview."created_at"
    INTO canonical_preview_created_at
    FROM public."lifecycle_consequence_previews" AS preview
    JOIN public."events" AS event
      ON event."id" = preview."event_id"
      AND (
        (p_purpose = 'all-clear' AND event."status" = 'all-clear')
        OR (p_purpose = 'reactivation' AND event."status" = 'active')
      )
    JOIN public."event_transitions" AS transition
      ON transition."id" = NULLIF(p_authorization ->> 'transitionId', '')::uuid
      AND transition."event_id" = event."id"
      AND transition."transition"::text = CASE p_purpose::text
        WHEN 'all-clear' THEN 'all-clear'
        WHEN 'reactivation' THEN 'reactivate'
      END
      AND transition."notification_authorization" = p_authorization
      AND transition."request_id" = p_request_id
      AND transition."occurred_at" = p_created_at
      AND transition."actor" = p_created_by
      AND transition."source" = p_source
    JOIN public."audience_configurations" AS audience
      ON audience."id" = preview."audience_config_id"
      AND audience."version" = preview."audience_config_version"
      AND audience."facility_id" = event."facility_id"
    WHERE preview."id" = NULLIF(p_authorization ->> 'lifecyclePreviewId', '')::uuid
      AND preview."event_id" = p_event_id
      AND preview."purpose" = p_purpose
      AND preview."kind" = p_event_kind
      AND preview."template_mode" = p_template_mode
      AND preview."event_type_version_id" = p_event_type_version_id
      AND preview."roster_snapshot_id" = p_roster_snapshot_id
      AND preview."roster_population" = p_roster_population
      AND preview."audience_config_id" = p_audience_config_id
      AND preview."audience_config_version" = p_audience_config_version
      AND preview."consequence_digest" = p_authorization ->> 'consequenceDigest'
      AND preview."send_readiness" = 'ready'
      AND preview."expires_at" >= p_created_at
      AND preview."expires_at" >= pg_catalog.clock_timestamp();
  END IF;

  IF canonical_preview_created_at IS NULL
    OR canonical_preview_created_at IS DISTINCT FROM p_preview_created_at
    OR canonical_preview_created_at <= current_record."changed_at"
  THEN
    RAISE EXCEPTION 'notification intent requires a fresh canonical preview from the current fanout epoch'
      USING ERRCODE = '55000';
  END IF;

  IF p_created_at < canonical_preview_created_at
    OR p_created_at < current_record."changed_at"
    OR p_created_at > pg_catalog.clock_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'fanout intent authorization time is invalid'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public."notification_intents" (
    "id", "event_id", "event_kind", "template_mode", "purpose",
    "event_type_version_id", "roster_snapshot_id", "roster_population",
    "audience_config_id", "audience_config_version", "created_by", "source",
    "request_id", "authorization", "created_at"
  ) VALUES (
    p_id, p_event_id, p_event_kind, p_template_mode, p_purpose,
    p_event_type_version_id, p_roster_snapshot_id, p_roster_population,
    p_audience_config_id, p_audience_config_version, p_created_by, p_source,
    p_request_id, p_authorization, p_created_at
  );

  INSERT INTO public."fanout_intent_authorizations" (
    "intent_id", "control_record_id", "enable_epoch_id", "control_mode",
    "authorized_at"
  ) VALUES (
    p_id, current_record."id", current_record."enable_epoch_id", 'enabled',
    p_created_at
  );

  RETURN QUERY SELECT
    current_record."id"::uuid,
    current_record."enable_epoch_id"::uuid;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fanout_control_records_insert_guard"
BEFORE INSERT ON public."fanout_control_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_fanout_control_insert"();--> statement-breakpoint
CREATE TRIGGER "fanout_control_records_immutable_guard"
BEFORE UPDATE OR DELETE ON public."fanout_control_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "fanout_intent_authorizations_immutable_guard"
BEFORE UPDATE OR DELETE ON public."fanout_intent_authorizations"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public."fanout_control_records"
TO "psd_eoc_app";--> statement-breakpoint
GRANT SELECT ON TABLE public."fanout_intent_authorizations"
TO "psd_eoc_app";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public."notification_intents",
  public."fanout_intent_authorizations"
FROM "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
  public."fanout_control_records",
  public."fanout_intent_authorizations"
FROM "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public."psd_eoc_guard_fanout_control_insert"()
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public."psd_eoc_insert_authorized_notification_intent"(
    uuid, uuid, public.event_kind, public.template_mode,
    public.notification_purpose, uuid, uuid, public.roster_population,
    uuid, integer, jsonb, public.invocation_source, uuid, jsonb,
    timestamp with time zone, timestamp with time zone
  )
FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public."psd_eoc_insert_authorized_notification_intent"(
    uuid, uuid, public.event_kind, public.template_mode,
    public.notification_purpose, uuid, uuid, public.roster_population,
    uuid, integer, jsonb, public.invocation_source, uuid, jsonb,
    timestamp with time zone, timestamp with time zone
  )
TO "psd_eoc_app";
