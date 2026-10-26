-- The partner audience of a live incident (#597). An activation preview now
-- counts the admitted partners it reaches beside its staff recipients, and
-- records who they are in activation_preview_partners when it is written.
-- The event a human confirms from that preview reaches exactly that set, and
-- its all-clear and reactivation previews copy the same count and reach the
-- same set again. A drill, test, or synthetic preview reaches no partner: the
-- count CHECKs and the member table's CHECK and composite foreign key refuse
-- it. Existing previews read as reaching none (default 0).
CREATE TABLE "activation_preview_partners" (
	"activation_preview_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"partner_admission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_preview_partners_pk" PRIMARY KEY("activation_preview_id","partner_admission_id"),
	CONSTRAINT "activation_preview_partners_live_incident" CHECK ("activation_preview_partners"."kind" = 'incident' and "activation_preview_partners"."template_mode" = 'real'
        and "activation_preview_partners"."roster_population" = 'staff')
);
--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "partner_recipient_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD COLUMN "partner_recipient_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The member table binds its preview through this anchor, so a member row
-- can name only a live-incident preview.
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_partner_anchor_uq" UNIQUE("id","kind","template_mode","roster_population");--> statement-breakpoint
ALTER TABLE "activation_preview_partners" ADD CONSTRAINT "activation_preview_partners_admission_fk" FOREIGN KEY ("partner_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_preview_partners" ADD CONSTRAINT "activation_preview_partners_preview_fk" FOREIGN KEY ("activation_preview_id","kind","template_mode","roster_population") REFERENCES "public"."activation_previews"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activation_preview_partners_admission_idx" ON "activation_preview_partners" USING btree ("partner_admission_id");--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_partner_count" CHECK ("activation_previews"."partner_recipient_count" between 0 and 1200
        and ("activation_previews"."partner_recipient_count" = 0 or (
          "activation_previews"."kind" = 'incident' and "activation_previews"."template_mode" = 'real'
          and "activation_previews"."roster_population" = 'staff'
        )));--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_partner_count" CHECK ("lifecycle_consequence_previews"."partner_recipient_count" between 0 and 1200
        and ("lifecycle_consequence_previews"."partner_recipient_count" = 0 or (
          "lifecycle_consequence_previews"."kind" = 'incident' and "lifecycle_consequence_previews"."template_mode" = 'real'
          and "lifecycle_consequence_previews"."roster_population" = 'staff'
        )));--> statement-breakpoint
-- The resolved set is a fact about one preview and is never changed. Reuses
-- the partner append-only guard from 0059, as 0060 to 0063 do.
CREATE TRIGGER "activation_preview_partners_append_only"
BEFORE UPDATE OR DELETE ON public."activation_preview_partners"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
-- PostgreSQL does not apply an earlier GRANT ... ON ALL TABLES to a table
-- created later. The application role reads and appends, naming every column
-- the query builder writes (see 0042 and 0054); no UPDATE or DELETE. The new
-- preview columns are covered by the table-level grants from 0000.
GRANT SELECT ON TABLE public."activation_preview_partners" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "activation_preview_id", "kind", "template_mode", "roster_population",
  "partner_admission_id", "created_at"
) ON TABLE public."activation_preview_partners" TO "psd_eoc_app";
