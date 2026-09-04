ALTER TYPE "public"."agent_capability_grant" ADD VALUE 'list-threats' BEFORE 'get-facility';--> statement-breakpoint
CREATE TABLE "threats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(160) NOT NULL,
	"sort_order" integer NOT NULL,
	"requires_detail" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threats_key_format" CHECK ("threats"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "threats_name_nonempty" CHECK (length(btrim("threats"."name")) > 0),
	CONSTRAINT "threats_sort_order_nonnegative" CHECK ("threats"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "threats_key_uq" ON "threats" USING btree ("key");--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public."threats"
FROM "psd_eoc_app";--> statement-breakpoint
GRANT SELECT ON TABLE public."threats"
TO "psd_eoc_app";
