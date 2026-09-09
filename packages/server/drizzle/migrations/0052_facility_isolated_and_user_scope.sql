ALTER TYPE "public"."agent_capability_grant" ADD VALUE 'set-user-facility-scope';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'set-user-facility-scope';--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "isolated" boolean DEFAULT false NOT NULL;