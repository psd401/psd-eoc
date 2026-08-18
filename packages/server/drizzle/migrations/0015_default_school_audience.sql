-- Every school notifies its own staff by default.
--
-- Recipient resolution requires an audience configuration for the facility. A
-- district that has entered its schools and its staff still could not start a
-- drill, because no configuration existed and none is created automatically:
-- the consequence preview failed with "The configured notification audience is
-- unavailable", and the confirm control is gated on a successful preview. The
-- live stack had twenty schools and zero configurations.
--
-- A school's default audience is not a decision anyone needs to make. It is the
-- staff of that school. This backfills exactly that for every facility that has
-- no configuration yet, as version 1 with a single `building` target pointing
-- at the facility itself.
--
-- Facilities that already have a configuration are left untouched, so any
-- deliberate audience an administrator has built is preserved. Re-running is
-- safe: the insert is guarded by NOT EXISTS.
--
-- This does not remove the audience concept. Events and notification messages
-- record the audience configuration and version that produced them, so removing
-- it is a change to the event journal and the notification identity model,
-- tracked separately in #292. What this removes is the requirement that a human
-- create one before the product can do anything.

WITH missing_configuration AS (
	SELECT
		f."id" AS facility_id,
		gen_random_uuid() AS configuration_id
	FROM public."facilities" AS f
	WHERE NOT EXISTS (
		SELECT 1
		FROM public."audience_configurations" AS a
		WHERE a."facility_id" = f."id"
	)
),
inserted_configuration AS (
	INSERT INTO public."audience_configurations" ("id", "facility_id", "version")
	SELECT configuration_id, facility_id, 1
	FROM missing_configuration
	RETURNING "id", "facility_id"
)
INSERT INTO public."audience_targets" (
	"audience_config_id",
	"audience_config_version",
	"ordinal",
	"target_kind",
	"target_facility_id"
)
SELECT "id", 1, 1, 'building', "facility_id"
FROM inserted_configuration;
