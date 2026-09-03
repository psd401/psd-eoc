ALTER TABLE "event_types" ADD COLUMN "requires_detail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "threat_id" uuid;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "threat_name" varchar(160);--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "threat_detail" varchar(200);--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "response_detail" varchar(200);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "threat_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "threat_name" varchar(160);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "threat_detail" varchar(200);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "response_detail" varchar(200);--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_threat_id_threats_id_fk" FOREIGN KEY ("threat_id") REFERENCES "public"."threats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_threat_id_threats_id_fk" FOREIGN KEY ("threat_id") REFERENCES "public"."threats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_threat_pair" CHECK (("activation_previews"."threat_id" is null) = ("activation_previews"."threat_name" is null)
        and ("activation_previews"."threat_detail" is null or "activation_previews"."threat_id" is not null));--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_detail_nonempty" CHECK (("activation_previews"."threat_detail" is null or length(btrim("activation_previews"."threat_detail")) > 0)
        and ("activation_previews"."response_detail" is null or length(btrim("activation_previews"."response_detail")) > 0));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_threat_pair" CHECK (("events"."threat_id" is null) = ("events"."threat_name" is null)
        and ("events"."threat_detail" is null or "events"."threat_id" is not null));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_detail_nonempty" CHECK (("events"."threat_detail" is null or length(btrim("events"."threat_detail")) > 0)
        and ("events"."response_detail" is null or length(btrim("events"."response_detail")) > 0));