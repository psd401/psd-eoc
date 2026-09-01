ALTER TABLE "group_sources" DROP CONSTRAINT "group_sources_valid_variant";--> statement-breakpoint
ALTER TABLE "group_sources" ADD CONSTRAINT "group_sources_valid_variant" CHECK ((
        "group_sources"."kind" = 'google-group'
        and "group_sources"."google_group_id" is not null
        and "group_sources"."email" is not null
        and "group_sources"."fixture_key" is null
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" in ('access', 'others') and "group_sources"."facility_id" is null)
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
