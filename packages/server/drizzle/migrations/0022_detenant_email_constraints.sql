-- Removes one district's email domain from the schema.
--
-- `users_psd_email` required every address to end in a single hardcoded
-- domain, and the roster recipient check required the same of every staff
-- email. Together they meant no other district could insert a user or a
-- recipient at all — the sharpest of the tenant locks in this repository, and
-- the one a check constraint cannot fix on its own, because a constraint
-- cannot read the deployment's configuration.
--
-- What is invariant stays in the database: an address is lowercase, bounded,
-- and shaped like an address. Which domain counts as this district's staff is
-- configuration, enforced where configuration lives — `staffRosterEmail()` in
-- `lib/config/staff-email.ts`, applied at every point an address is admitted
-- from a provider, and by the Google OIDC hosted-domain pin at sign-in.
-- `users_normalized_email` already requires a lowercase, trimmed, bounded
-- address, so dropping the domain rule leaves the shape rule in place.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_psd_email";
--> statement-breakpoint
ALTER TABLE "roster_recipients"
  DROP CONSTRAINT IF EXISTS "roster_recipients_staff_email_canonical";
--> statement-breakpoint
ALTER TABLE "roster_recipients"
  ADD CONSTRAINT "roster_recipients_staff_email_canonical" CHECK (
    "roster_recipients"."staff_email" is null or (
      "roster_recipients"."staff_email" = lower("roster_recipients"."staff_email")
      and "roster_recipients"."staff_email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    )
  );
