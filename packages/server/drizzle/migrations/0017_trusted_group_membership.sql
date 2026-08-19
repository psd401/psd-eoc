-- Who is in a trusted group, and when we last looked.
--
-- Replaces the access-membership generation model. That model asked sign-in to
-- validate a versioned snapshot: the latest complete snapshot's group set had
-- to equal the active access group set exactly, every member carried expected
-- and completed marker rows, and a person's evaluated groups were compared
-- against a designated set. It produced three failures this deployment hit in
-- one day. Adding a group made the snapshot disagree with the configuration and
-- denied everyone. Removing one did the same and could not be published,
-- because publication required the agreement that only publication could
-- restore. And a person who was plainly a current member of a trusted group was
-- refused, because they were not a member of every group.
--
-- None of that complexity bought anything. What sign-in needs to know is
-- whether this person is currently in a group the deployment trusts, and what
-- role that group grants. That is one row per person per group.
--
-- Freshness lives on the group, not on a snapshot version. `members_captured_at`
-- records when that group's membership was last read from the provider, so
-- sign-in can refuse to trust membership that has gone stale without needing a
-- global generation number that every group has to agree on.

CREATE TABLE IF NOT EXISTS public."access_group_members" (
	"group_source_id" uuid NOT NULL REFERENCES public."group_sources"("id") ON DELETE CASCADE,
	"email" varchar(320) NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_group_members_pk" PRIMARY KEY ("group_source_id", "email")
);

CREATE INDEX IF NOT EXISTS "access_group_members_email_idx"
	ON public."access_group_members" ("email");

ALTER TABLE public."group_sources"
	ADD COLUMN IF NOT EXISTS "members_captured_at" timestamp with time zone;

-- The application role reads membership on every sign-in and every session
-- refresh, so it needs SELECT here. It never writes: membership is replaced by
-- the access sync running as the administrator role.
--
-- The grant is explicit because GRANT ... ON ALL TABLES applies only to tables
-- that existed when it ran. A table added later is invisible to the application
-- role until it is named, and the failure that produces is a bare
-- "permission denied" at sign-in rather than anything that points here.
REVOKE ALL PRIVILEGES ON TABLE public."access_group_members"
	FROM PUBLIC, "psd_eoc_app";

GRANT SELECT ON TABLE public."access_group_members" TO "psd_eoc_app";
