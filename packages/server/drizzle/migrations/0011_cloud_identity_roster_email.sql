ALTER TABLE "roster_recipients" DROP CONSTRAINT "roster_recipients_population_subject";--> statement-breakpoint
ALTER TABLE "roster_recipients" ADD COLUMN "staff_email" varchar(320);--> statement-breakpoint
CREATE UNIQUE INDEX "roster_recipients_snapshot_staff_email_uq" ON "roster_recipients" USING btree ("roster_snapshot_id",lower("staff_email")) WHERE "roster_recipients"."staff_email" is not null;--> statement-breakpoint
ALTER TABLE "roster_recipients" ADD CONSTRAINT "roster_recipients_population_identity" CHECK ((
        "roster_recipients"."population" = 'staff'
        and ("roster_recipients"."google_subject" is not null or "roster_recipients"."staff_email" is not null)
      ) or (
        "roster_recipients"."population" = 'synthetic'
        and "roster_recipients"."google_subject" is null
        and "roster_recipients"."staff_email" is null
      ));--> statement-breakpoint
ALTER TABLE "roster_recipients" ADD CONSTRAINT "roster_recipients_staff_email_canonical" CHECK ("roster_recipients"."staff_email" is null or (
        "roster_recipients"."staff_email" = lower("roster_recipients"."staff_email")
        and "roster_recipients"."staff_email" ~ '^[^@[:space:]]+@psd401[.]net$'
      ));