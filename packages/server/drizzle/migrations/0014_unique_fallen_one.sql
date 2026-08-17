ALTER TYPE "public"."mutation_capability" ADD VALUE 'sync-access-membership' BEFORE 'record-delivery-test-canary-eligibility';--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_psd_email";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_normalized_email" CHECK ("users"."email" = lower("users"."email")
        and "users"."email" = btrim("users"."email")
        and length("users"."email") between 3 and 320
        and "users"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$');