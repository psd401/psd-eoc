ALTER TABLE "roster_recipient_group_sources" DROP CONSTRAINT "roster_recipient_group_sources_population_source";--> statement-breakpoint
ALTER TABLE "roster_snapshot_sources" DROP CONSTRAINT "roster_snapshot_sources_population_source";--> statement-breakpoint
ALTER TABLE "roster_source_configuration_groups" DROP CONSTRAINT "roster_source_configuration_groups_population_source";--> statement-breakpoint
ALTER TABLE "roster_sync_result_sources" DROP CONSTRAINT "roster_sync_result_sources_population_source";--> statement-breakpoint
ALTER TABLE "roster_recipient_group_sources" ADD CONSTRAINT "roster_recipient_group_sources_population_source" CHECK ((
        "roster_recipient_group_sources"."population" = 'staff'
        and "roster_recipient_group_sources"."group_source_kind"::text in ('google-group', 'manual')
      ) or (
        "roster_recipient_group_sources"."population" = 'synthetic' and "roster_recipient_group_sources"."group_source_kind" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "roster_snapshot_sources" ADD CONSTRAINT "roster_snapshot_sources_population_source" CHECK ((
        "roster_snapshot_sources"."population" = 'staff'
        and "roster_snapshot_sources"."group_source_kind"::text in ('google-group', 'manual')
      ) or (
        "roster_snapshot_sources"."population" = 'synthetic' and "roster_snapshot_sources"."group_source_kind" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "roster_source_configuration_groups" ADD CONSTRAINT "roster_source_configuration_groups_population_source" CHECK ((
        "roster_source_configuration_groups"."population" = 'staff'
        and "roster_source_configuration_groups"."group_source_kind"::text in ('google-group', 'manual')
      ) or (
        "roster_source_configuration_groups"."population" = 'synthetic' and "roster_source_configuration_groups"."group_source_kind" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "roster_sync_result_sources" ADD CONSTRAINT "roster_sync_result_sources_population_source" CHECK ((
        "roster_sync_result_sources"."population" = 'staff'
        and "roster_sync_result_sources"."group_source_kind"::text in ('google-group', 'manual')
      ) or (
        "roster_sync_result_sources"."population" = 'synthetic' and "roster_sync_result_sources"."group_source_kind" = 'synthetic'
      ));