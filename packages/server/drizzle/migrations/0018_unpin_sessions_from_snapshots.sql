-- Sessions stop being pinned to an access-membership generation.
--
-- Every session referenced one snapshot by two foreign keys, so staying signed
-- in meant continuing to agree with a versioned generation. That is the same
-- coupling that denied everyone when the configuration changed: a session
-- issued under one generation had nothing to validate against once the
-- configuration moved, whether or not its holder was still in a trusted group.
--
-- The question a session needs to answer is the same one sign-in answers — is
-- this person still in a group the deployment trusts. That is asked directly
-- now, so the pin is unnecessary.
--
-- The column is made nullable rather than dropped. Sessions issued before this
-- deploy still carry a snapshot id, and leaving it in place lets old and new
-- sessions coexist through the cutover instead of forcing every signed-in
-- person out. It can be dropped once the snapshot tables go.

ALTER TABLE public."sessions"
	DROP CONSTRAINT IF EXISTS "sessions_membership_user_fk";

ALTER TABLE public."sessions"
	DROP CONSTRAINT IF EXISTS "sessions_membership_snapshot_id_access_membership_snapshots_id_fk";

ALTER TABLE public."sessions"
	ALTER COLUMN "membership_snapshot_id" DROP NOT NULL;
