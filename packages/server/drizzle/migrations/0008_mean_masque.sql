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
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_fanout_intent_authorization_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_record record;
  intent_created_in_current_transaction boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('psd-eoc:fanout-control:v1', 0));
  SELECT "id", "mode", "enable_epoch_id", "changed_at"
  INTO current_record
  FROM public."fanout_control_records"
  ORDER BY "revision" DESC
  LIMIT 1;

  IF NOT FOUND
    OR current_record."mode" <> 'enabled'
    OR current_record."id" IS DISTINCT FROM NEW."control_record_id"
    OR current_record."enable_epoch_id" IS DISTINCT FROM NEW."enable_epoch_id"
  THEN
    RAISE EXCEPTION 'notification intent is not authorized by the current enabled fanout epoch'
      USING ERRCODE = '55000';
  END IF;

  SELECT intent.xmin = pg_current_xact_id()::xid
  INTO intent_created_in_current_transaction
  FROM public."notification_intents" AS intent
  WHERE intent."id" = NEW."intent_id";

  IF intent_created_in_current_transaction IS NOT TRUE THEN
    RAISE EXCEPTION 'fanout authorization must be persisted with a newly created notification intent'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."authorized_at" < current_record."changed_at"
    OR NEW."authorized_at" > clock_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'fanout intent authorization time is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fanout_control_records_insert_guard"
BEFORE INSERT ON public."fanout_control_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_fanout_control_insert"();--> statement-breakpoint
CREATE TRIGGER "fanout_intent_authorizations_insert_guard"
BEFORE INSERT ON public."fanout_intent_authorizations"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_fanout_intent_authorization_insert"();--> statement-breakpoint
CREATE TRIGGER "fanout_control_records_immutable_guard"
BEFORE UPDATE OR DELETE ON public."fanout_control_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "fanout_intent_authorizations_immutable_guard"
BEFORE UPDATE OR DELETE ON public."fanout_intent_authorizations"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  public."fanout_control_records",
  public."fanout_intent_authorizations"
TO "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
  public."fanout_control_records",
  public."fanout_intent_authorizations"
FROM "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION
  public."psd_eoc_guard_fanout_control_insert"(),
  public."psd_eoc_guard_fanout_intent_authorization_insert"()
FROM PUBLIC, "psd_eoc_app";
