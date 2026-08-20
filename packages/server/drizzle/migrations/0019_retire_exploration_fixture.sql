-- Retire the synthetic access fixture.
--
-- The bootstrap seeded an invented access group,
-- `exploration-smoke-access@example.invalid`, and an invented user to go with
-- it, so a brand new stack had one person who could sign in. On this
-- deployment they are still active, and they are why a real member of
-- tsd-engineering@psd401.net could not sign in: the old rule required
-- membership in every active access group, and nobody real is in an invented
-- one.
--
-- They also block the access sync. It reads every active access group from
-- Google, and a group that exists only in a fixture cannot be read, so the sync
-- fails before it can publish anyone's membership.
--
-- Deactivated rather than deleted. Several of these tables refuse DELETE by
-- database rule — records are retained deliberately — and sessions, audit
-- entries, and membership rows still reference both. Deactivating the group
-- stops it granting access immediately, which is the whole of its effect, and
-- disabling the user stops it being signed in with. What remains is inert
-- history rather than live configuration.

UPDATE public."group_sources"
SET "active" = false
WHERE "id" = '00000000-0000-4000-8000-000000000163'
	AND "purpose" = 'access';

UPDATE public."users"
SET "disabled_at" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000164'
	AND "disabled_at" IS NULL;
