-- A Google building source may now be registered before Google holds its
-- group: the address is known, the Google Group ID is not. Such a source is
-- "waiting": it names nobody until the scheduled sync resolves the address,
-- records the ID, and reads the group like any other. Access and others
-- sources still require a resolved ID at registration.
--
-- The predicate below is the one migration 0043 introduced, with one change:
-- the `google_group_id is not null` clause moves from the shared google-group
-- head into the access/others branch, so a building source may carry null.
-- Hand-completed after generation: drizzle-kit truncates the predicate at the
-- comment lines inside the manual branch.
ALTER TABLE "group_sources" DROP CONSTRAINT "group_sources_valid_variant";--> statement-breakpoint
ALTER TABLE "group_sources" ADD CONSTRAINT "group_sources_valid_variant" CHECK ((
        "group_sources"."kind" = 'google-group'
        and "group_sources"."email" is not null
        and "group_sources"."fixture_key" is null
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" in ('access', 'others') and "group_sources"."facility_id" is null and "group_sources"."google_group_id" is not null)
        )
      ) or (
        "group_sources"."kind" = 'synthetic'
        and "group_sources"."google_group_id" is null
        and "group_sources"."email" is null
        and "group_sources"."fixture_key" is not null
        and "group_sources"."purpose" in ('building', 'others')
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" = 'others' and "group_sources"."facility_id" is null)
        )
      ) or (
        -- Kept as a text comparison so this predicate stays byte-identical to
        -- the one migration 0037 introduced with 'manual'; the cast is a no-op
        -- now that the enum value is long committed, but the parity is not.
        "group_sources"."kind"::text = 'manual'
        and "group_sources"."google_group_id" is null
        and "group_sources"."email" is null
        and "group_sources"."fixture_key" is null
        and "group_sources"."purpose" in ('building', 'others')
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" = 'others' and "group_sources"."facility_id" is null)
        )
      ));
--> statement-breakpoint
-- The identity guard from migration 0028, redefined in full so that a waiting
-- Google building or others source may have its Google Group ID recorded once,
-- from null to a value, when Google first holds the group. Every other change
-- to a roster source stays refused, and a recorded ID can never change again.
-- 0028's body is kept verbatim apart from the one allowance below; rebuilding
-- from an older body would drop the trigger-context assertion and the
-- access-group locator guard, which 0028's own comment warns about.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_group_source_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.group_sources'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'group_sources'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'UPDATE'
	THEN
		RAISE EXCEPTION 'Unexpected group-source identity trigger context'
			USING ERRCODE = '55000';
	END IF;

	-- A waiting Google source (registered before Google held its group) may
	-- have its Google Group ID recorded exactly once. Nothing else about a
	-- roster source may change, and an ID once recorded is immutable.
	IF OLD."purpose" IN ('building', 'others')
		AND (pg_catalog.to_jsonb(NEW) - 'members_captured_at' - 'google_group_id')
			IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'members_captured_at' - 'google_group_id')
	THEN
		RAISE EXCEPTION 'Group-source identity, provider locator, status, and presentation are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD."purpose" IN ('building', 'others')
		AND NEW."google_group_id" IS DISTINCT FROM OLD."google_group_id"
		AND NOT (
			OLD."kind" = 'google-group'
			AND OLD."google_group_id" IS NULL
			AND NEW."google_group_id" IS NOT NULL
		)
	THEN
		RAISE EXCEPTION 'A recorded Google Group ID is immutable; only a waiting source may have its ID recorded, once'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."kind" IS DISTINCT FROM OLD."kind"
		OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
		OR NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'Group-source identity, purpose, facility binding, and creation time are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD."purpose" = 'access'
		AND (
			NEW."google_group_id" IS DISTINCT FROM OLD."google_group_id"
			OR NEW."email" IS DISTINCT FROM OLD."email"
		)
	THEN
		RAISE EXCEPTION 'Access group provider locators are immutable; create a replacement identity'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;
