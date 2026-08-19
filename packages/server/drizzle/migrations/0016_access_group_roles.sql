-- Access groups carry the role they grant.
--
-- Access was previously decided by one Google group hardcoded at compile time
-- as `DESIGNATED_ACCESS_GROUP_EMAIL`, with roles handed out by a synthetic
-- bootstrap fixture. That has three consequences this column begins to undo:
-- no deployment other than Peninsula's can grant anyone access, the allowed
-- group cannot be changed after the first snapshot is published, and there is
-- no supported way to make anybody an administrator.
--
-- An access group now names the role its members receive. Membership in any
-- active access group grants access and that group's role, so a district
-- configures "this group administers, that group is staff" as data instead of
-- redeploying. It also removes the need for a synthetic fixture to create the
-- first administrator: point an access group at a real Google group whose
-- members should administer, and they are administrators.
--
-- Only access-purpose sources carry a role. Building and roster sources
-- describe who is notified, not who may sign in, so the column stays null for
-- them and a check constraint keeps the two kinds from drifting together.
--
-- Existing rows: every current access group is granted 'admin'. On this stack
-- that is the exploration fixture and tsd-engineering, and the people in
-- tsd-engineering are the district technology team who administer the system.
-- Backfilling 'staff' would leave the deployment with no reachable
-- administrator at all, which the sync's final-admin guard would then refuse to
-- let anyone repair.

ALTER TABLE public."group_sources"
	ADD COLUMN IF NOT EXISTS "granted_role" "role";

UPDATE public."group_sources"
SET "granted_role" = 'admin'
WHERE "purpose" = 'access'
	AND "granted_role" IS NULL;

ALTER TABLE public."group_sources"
	DROP CONSTRAINT IF EXISTS "group_sources_access_role_present";

ALTER TABLE public."group_sources"
	ADD CONSTRAINT "group_sources_access_role_present" CHECK (
		("purpose" = 'access' AND "granted_role" IS NOT NULL)
		OR ("purpose" <> 'access' AND "granted_role" IS NULL)
	);
