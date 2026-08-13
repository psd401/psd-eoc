-- Retain every version 1 outbox message byte-for-byte. Only replace the
-- admission checks so new canonical version 2 messages can carry facility
-- identity without rewriting append-only history.
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_message_version";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_message_truth";--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_message_version" CHECK ("outbox"."message_version" in (1, 2));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_message_truth" CHECK (jsonb_typeof("outbox"."message") is not distinct from 'object'
        and "outbox"."message" ->> 'outboxId' is not distinct from "outbox"."id"::text
        and "outbox"."message" ->> 'intentId' is not distinct from "outbox"."intent_id"::text
        and "outbox"."message" ->> 'eventId' is not distinct from "outbox"."event_id"::text
        and "outbox"."message" ->> 'eventKind' is not distinct from "outbox"."event_kind"::text
        and "outbox"."message" ->> 'templateMode' is not distinct from "outbox"."template_mode"::text
        and "outbox"."message" ->> 'purpose' is not distinct from "outbox"."purpose"::text
        and "outbox"."message" -> 'eventTypeVersion' ->> 'id' is not distinct from "outbox"."event_type_version_id"::text
        and "outbox"."message" -> 'eventTypeVersion' ->> 'templateMode' is not distinct from "outbox"."template_mode"::text
        and "outbox"."message" ->> 'rosterSnapshotId' is not distinct from "outbox"."roster_snapshot_id"::text
        and "outbox"."message" ->> 'rosterPopulation' is not distinct from "outbox"."roster_population"::text
        and "outbox"."message" -> 'audienceConfig' ->> 'id' is not distinct from "outbox"."audience_config_id"::text
        and ("outbox"."message" -> 'audienceConfig' ->> 'version')::integer is not distinct from "outbox"."audience_config_version"
        and "outbox"."message" ->> 'requestId' is not distinct from "outbox"."request_id"::text
        and ("outbox"."message" ->> 'version')::integer is not distinct from "outbox"."message_version"
        and (
          (
            "outbox"."message_version" = 1
            and not ("outbox"."message" ? 'facilityId')
          ) or (
            "outbox"."message_version" = 2
            and jsonb_typeof("outbox"."message" -> 'facilityId') is not distinct from 'string'
            and "outbox"."message" ->> 'facilityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )
        and ("outbox"."message" ->> 'createdAt')::timestamptz is not distinct from "outbox"."created_at"
        and "outbox"."message" -> 'authorization' is not distinct from "outbox"."authorization"
        and "outbox"."message" -> 'channels' is not distinct from "outbox"."channels");--> statement-breakpoint

-- Close the retained-data gap from before push revocation was wired into the
-- session lifecycle. Lock the parent before the child evidence tables so a
-- concurrent session or token write cannot land between this bounded backfill
-- and the append-only guards below.
LOCK TABLE public."sessions" IN SHARE MODE;--> statement-breakpoint
LOCK TABLE
	public."session_revocations",
	public."device_push_token_registrations",
	public."device_push_token_unregistrations"
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- A revocation affects registrations that already existed for the same
-- enrolled device. Select only the first qualifying revocation for each
-- retained registration, leave later registrations active, and never replace
-- an existing unregistration fact.
INSERT INTO public."device_push_token_unregistrations" (
	"id",
	"registration_id",
	"device_enrollment_id",
	"unregistered_at"
)
SELECT
	pg_catalog.gen_random_uuid(),
	registration."id",
	registration."device_enrollment_id",
	first_revocation."revoked_at"
FROM public."device_push_token_registrations" AS registration
CROSS JOIN LATERAL (
	SELECT revocation."revoked_at"
	FROM public."sessions" AS device_session
	JOIN public."session_revocations" AS revocation
		ON revocation."session_id" = device_session."id"
	WHERE device_session."device_enrollment_id" = registration."device_enrollment_id"
		AND revocation."revoked_at" >= registration."registered_at"
	ORDER BY revocation."revoked_at", revocation."id"
	LIMIT 1
) AS first_revocation
WHERE NOT EXISTS (
	SELECT 1
	FROM public."device_push_token_unregistrations" AS existing_unregistration
	WHERE existing_unregistration."registration_id" = registration."id"
)
ON CONFLICT ("registration_id") DO NOTHING;--> statement-breakpoint

CREATE TRIGGER "session_revocations_immutable_guard"
BEFORE UPDATE ON public."session_revocations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "device_push_token_registrations_immutable_guard"
BEFORE UPDATE ON public."device_push_token_registrations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "device_push_token_unregistrations_immutable_guard"
BEFORE UPDATE ON public."device_push_token_unregistrations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE
	public."session_revocations",
	public."device_push_token_registrations",
	public."device_push_token_unregistrations"
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE
	public."session_revocations",
	public."device_push_token_registrations",
	public."device_push_token_unregistrations"
TO "psd_eoc_app";--> statement-breakpoint

-- Roster synchronization takes a FOR UPDATE lock on retained registrations
-- while it verifies a captured push endpoint. PostgreSQL requires UPDATE on at
-- least one column for that locking read; expose only the immutable identity
-- column, whose unconditional trigger still rejects every UPDATE statement.
GRANT UPDATE ("id") ON TABLE
	public."device_push_token_registrations"
TO "psd_eoc_app";
