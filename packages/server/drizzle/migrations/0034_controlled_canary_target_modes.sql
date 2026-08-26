CREATE OR REPLACE FUNCTION public."psd_eoc_validate_delivery_test_target_set"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	endpoint_count integer;
	push_count integer;
	email_count integer;
BEGIN
	IF TG_RELID <> 'public.delivery_test_target_set_versions'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_target_set_versions'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test target-set validation context'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		pg_catalog.count(*)::pg_catalog.int4,
		pg_catalog.count(*) FILTER (WHERE endpoint."channel" = 'push')::pg_catalog.int4,
		pg_catalog.count(*) FILTER (WHERE endpoint."channel" = 'email')::pg_catalog.int4
	INTO endpoint_count, push_count, email_count
	FROM public."delivery_test_target_endpoints" AS endpoint
	WHERE endpoint."target_set_version_id" = NEW."id"
		AND endpoint."target_set_version" = NEW."version";

	IF NOT (
		endpoint_count = 1
		OR (endpoint_count BETWEEN 2 AND 12000 AND push_count >= 1 AND email_count >= 1)
	) THEN
		RAISE EXCEPTION 'Delivery-test target set requires one controlled canary endpoint, or 2-12000 endpoints including push and email'
			USING ERRCODE = '55000';
	END IF;

	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_report_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	latest_report_id uuid;
	latest_sequence integer;
	latest_generated_at timestamp with time zone;
	channel_row jsonb;
	state_row jsonb;
	channel_name text;
	state_name text;
	endpoint_count numeric;
	latency_is_null boolean;
	completed_is_null boolean;
	state_count numeric;
	counted_endpoints numeric;
	submitted_channels jsonb := '{}'::jsonb;
	submitted_state_counts jsonb;
	expected_channels jsonb;
	expected_status text;
	expected_reason_code text;
	completed_at_value timestamp with time zone;
	latency_value numeric;
	seen_channels text[] := ARRAY[]::text[];
	seen_states text[];
	unknown_count numeric := 0;
	failed_or_expired_count numeric := 0;
	has_non_success_state boolean;
	object_key_count integer;
	pinned_channel_count integer;
	pinned_channel_total integer;
BEGIN
	IF TG_RELID <> 'public.delivery_test_reports'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_reports'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test report trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'psd-eoc-delivery-test-report-' || NEW."run_id"::pg_catalog.text,
			0
		)
	);

	SELECT report."id", report."sequence", report."generated_at"
	INTO latest_report_id, latest_sequence, latest_generated_at
	FROM public."delivery_test_reports" AS report
	WHERE report."run_id" = NEW."run_id"
	ORDER BY report."sequence" DESC
	LIMIT 1;

	IF latest_sequence IS NULL THEN
		IF NEW."sequence" <> 1 OR NEW."supersedes_report_id" IS NOT NULL THEN
			RAISE EXCEPTION 'First delivery-test report must be sequence one without a predecessor'
				USING ERRCODE = '55000';
		END IF;
	ELSIF NEW."sequence" <> latest_sequence + 1
		OR NEW."supersedes_report_id" IS DISTINCT FROM latest_report_id
		OR NEW."generated_at" < latest_generated_at
	THEN
		RAISE EXCEPTION 'Delivery-test report must supersede the latest report with the next sequence'
			USING ERRCODE = '55000';
	END IF;

	IF pg_catalog.jsonb_typeof(NEW."finalized_by") IS DISTINCT FROM 'object'
		OR NEW."finalized_by" ->> 'kind' IS DISTINCT FROM 'system'
		OR coalesce(NEW."finalized_by" ->> 'serviceId', '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
		OR NEW."source" IS DISTINCT FROM 'worker'
	THEN
		RAISE EXCEPTION 'Delivery-test report finalizer must be an explicit worker service'
			USING ERRCODE = '55000';
	END IF;
	SELECT pg_catalog.count(*)::pg_catalog.int4
	INTO object_key_count
	FROM pg_catalog.jsonb_object_keys(NEW."finalized_by");
	IF object_key_count <> 2 THEN
		RAISE EXCEPTION 'Delivery-test report finalizer contains unexpected fields'
			USING ERRCODE = '55000';
	END IF;

	-- Recompute the destination-free projection from immutable targets and the
	-- exact latest attempt/evidence rows. This is intentionally independent of
	-- application assembly so direct app-role INSERT cannot fabricate success,
	-- counts, completion timestamps, or provider-accept latency.
	WITH run_context AS MATERIALIZED (
		SELECT
			run."notification_intent_id",
			run."target_set_version_id",
			run."target_set_version",
			run."started_at"
		FROM public."delivery_test_runs" AS run
		WHERE run."id" = NEW."run_id"
	), target_endpoints AS MATERIALIZED (
		SELECT
			endpoint."recipient_id",
			endpoint."endpoint_id",
			endpoint."channel"::pg_catalog.text AS channel,
			run."notification_intent_id",
			run."started_at"
		FROM run_context AS run
		JOIN public."delivery_test_target_endpoints" AS endpoint
			ON endpoint."target_set_version_id" = run."target_set_version_id"
			AND endpoint."target_set_version" = run."target_set_version"
	), latest_attempts AS MATERIALIZED (
		SELECT DISTINCT ON (
			target.channel, target."recipient_id", target."endpoint_id"
		)
			target.channel,
			target."recipient_id",
			target."endpoint_id",
			target."started_at",
			attempt."id" AS attempt_id
		FROM target_endpoints AS target
		LEFT JOIN public."channel_attempts" AS attempt
			ON attempt."intent_id" = target."notification_intent_id"
			AND attempt."recipient_id" = target."recipient_id"
			AND attempt."endpoint_id" = target."endpoint_id"
			AND attempt."channel"::pg_catalog.text = target.channel
		ORDER BY
			target.channel,
			target."recipient_id",
			target."endpoint_id",
			attempt."attempt_number" DESC NULLS LAST,
			attempt."attempted_at" DESC NULLS LAST,
			attempt."id" DESC NULLS LAST
	), endpoint_truth AS MATERIALIZED (
		SELECT
			attempt.channel,
			attempt."started_at",
			CASE
				WHEN latest_evidence.state IS NULL
					OR latest_evidence.state = 'attempted'
				THEN 'unknown'
				ELSE latest_evidence.state
			END AS state,
			accepted_evidence."recorded_at" AS accepted_at
		FROM latest_attempts AS attempt
		LEFT JOIN LATERAL (
			SELECT evidence."state"::pg_catalog.text AS state
			FROM public."delivery_evidence" AS evidence
			WHERE evidence."subject_kind" = 'attempt'
				AND evidence."attempt_id" = attempt.attempt_id
			ORDER BY evidence."sequence" DESC
			LIMIT 1
		) AS latest_evidence ON true
		LEFT JOIN LATERAL (
			SELECT evidence."recorded_at"
			FROM public."delivery_evidence" AS evidence
			WHERE evidence."subject_kind" = 'attempt'
				AND evidence."attempt_id" = attempt.attempt_id
				AND evidence."state" IN ('provider-accepted', 'delivered')
			ORDER BY evidence."sequence"
			LIMIT 1
		) AS accepted_evidence ON true
	), state_truth AS MATERIALIZED (
		SELECT truth.channel, truth.state, pg_catalog.count(*)::pg_catalog.int8 AS state_count
		FROM endpoint_truth AS truth
		GROUP BY truth.channel, truth.state
	), channel_truth AS MATERIALIZED (
		SELECT
			truth.channel,
			pg_catalog.count(*)::pg_catalog.int8 AS endpoint_count,
			pg_catalog.count(truth.accepted_at)::pg_catalog.int8 AS accepted_count,
			pg_catalog.max(truth.accepted_at) AS completed_at,
			pg_catalog.max(truth."started_at") AS started_at
		FROM endpoint_truth AS truth
		GROUP BY truth.channel
	), channel_projection AS MATERIALIZED (
		SELECT
			channel.channel,
			channel.endpoint_count,
			CASE
				WHEN channel.accepted_count = channel.endpoint_count
			THEN pg_catalog.trunc(
					pg_catalog.date_part('epoch', channel.completed_at - channel.started_at) * 1000
				)::pg_catalog.int8
				ELSE NULL
			END AS latency_ms,
			CASE
				WHEN channel.accepted_count = channel.endpoint_count
				THEN channel.completed_at
				ELSE NULL
			END AS completed_at,
			(
				SELECT pg_catalog.jsonb_object_agg(state.state, state.state_count)
				FROM state_truth AS state
				WHERE state.channel = channel.channel
			) AS state_counts
		FROM channel_truth AS channel
	), overall_truth AS MATERIALIZED (
		SELECT
			coalesce(
				pg_catalog.bool_or(truth.state IN ('failed', 'expired')),
				false
			) AS failed,
			coalesce(
				pg_catalog.bool_or(truth.state = 'unknown'),
				false
			) AS uncertain
		FROM endpoint_truth AS truth
	)
	SELECT
		coalesce(
			(
				SELECT pg_catalog.jsonb_object_agg(
					channel.channel,
					pg_catalog.jsonb_build_object(
						'endpointCount', channel.endpoint_count,
						'activationToProviderAcceptMs', channel.latency_ms,
						'latestStateCounts', channel.state_counts,
						'completedAtEpochMs', CASE
							WHEN channel.completed_at IS NULL THEN NULL
							ELSE pg_catalog.trunc(
								pg_catalog.date_part('epoch', channel.completed_at) * 1000
							)::pg_catalog.int8
						END
					)
				)
				FROM channel_projection AS channel
			),
			'{}'::jsonb
		),
		CASE
			WHEN truth.failed THEN 'failed'
			WHEN truth.uncertain THEN 'incomplete'
			ELSE 'succeeded'
		END
	INTO expected_channels, expected_status
	FROM overall_truth AS truth;
	expected_reason_code := CASE expected_status
		WHEN 'failed' THEN 'DELIVERY_TEST_PROVIDER_FAILURE'
		WHEN 'incomplete' THEN 'PROVIDER_TRUTH_PENDING'
		ELSE NULL
	END;

	IF pg_catalog.jsonb_typeof(NEW."channels") IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(NEW."channels") NOT BETWEEN 1 AND 3
	THEN
		RAISE EXCEPTION 'Delivery-test report requires one controlled canary channel, or push and email channels'
			USING ERRCODE = '55000';
	END IF;

	FOR channel_row IN
		SELECT value FROM pg_catalog.jsonb_array_elements(NEW."channels")
	LOOP
		IF pg_catalog.jsonb_typeof(channel_row) IS DISTINCT FROM 'object' THEN
			RAISE EXCEPTION 'Delivery-test channel report must be an object'
				USING ERRCODE = '55000';
		END IF;
		SELECT pg_catalog.count(*)::pg_catalog.int4
		INTO object_key_count
		FROM pg_catalog.jsonb_object_keys(channel_row);
		IF object_key_count <> 5
			OR NOT channel_row ?& ARRAY[
				'channel', 'endpointCount', 'activationToProviderAcceptMs',
				'latestStateCounts', 'completedAt'
			]
		THEN
			RAISE EXCEPTION 'Delivery-test channel report fields must match the contract exactly'
				USING ERRCODE = '55000';
		END IF;

		channel_name := channel_row ->> 'channel';
		IF channel_name NOT IN ('push', 'email', 'sms')
			OR channel_name = ANY(seen_channels)
		THEN
			RAISE EXCEPTION 'Delivery-test report channels must be valid and unique'
				USING ERRCODE = '55000';
		END IF;
		seen_channels := pg_catalog.array_append(seen_channels, channel_name);

		IF pg_catalog.jsonb_typeof(channel_row -> 'endpointCount') IS DISTINCT FROM 'number'
			OR channel_row ->> 'endpointCount' !~ '^(0|[1-9][0-9]*)$'
		THEN
			RAISE EXCEPTION 'Delivery-test endpoint count must be a nonnegative integer'
				USING ERRCODE = '55000';
		END IF;
		endpoint_count := (channel_row ->> 'endpointCount')::pg_catalog.numeric;
		IF endpoint_count NOT BETWEEN 1 AND 12000 THEN
			RAISE EXCEPTION 'Delivery-test endpoint count must be positive and within its safe bound'
				USING ERRCODE = '54000';
		END IF;
		SELECT pg_catalog.count(*)::pg_catalog.int4
		INTO pinned_channel_count
		FROM public."delivery_test_runs" AS run
		JOIN public."delivery_test_target_endpoints" AS endpoint
			ON endpoint."target_set_version_id" = run."target_set_version_id"
			AND endpoint."target_set_version" = run."target_set_version"
		WHERE run."id" = NEW."run_id"
			AND endpoint."channel"::pg_catalog.text = channel_name;
		IF pinned_channel_count = 0 OR endpoint_count <> pinned_channel_count THEN
			RAISE EXCEPTION 'Delivery-test report endpoint count must equal the pinned target channel count'
				USING ERRCODE = '55000';
		END IF;

		latency_is_null :=
			pg_catalog.jsonb_typeof(channel_row -> 'activationToProviderAcceptMs') = 'null';
		IF NOT latency_is_null AND (
			pg_catalog.jsonb_typeof(channel_row -> 'activationToProviderAcceptMs') IS DISTINCT FROM 'number'
			OR channel_row ->> 'activationToProviderAcceptMs' !~ '^(0|[1-9][0-9]*)$'
		) THEN
			RAISE EXCEPTION 'Delivery-test provider-accept latency must be null or a nonnegative integer'
				USING ERRCODE = '55000';
		END IF;
		latency_value := CASE
			WHEN latency_is_null THEN NULL
			ELSE (channel_row ->> 'activationToProviderAcceptMs')::pg_catalog.numeric
		END;

		completed_is_null :=
			pg_catalog.jsonb_typeof(channel_row -> 'completedAt') = 'null';
		IF latency_is_null IS DISTINCT FROM completed_is_null THEN
			RAISE EXCEPTION 'Delivery-test latency and completion time must appear together'
				USING ERRCODE = '55000';
		END IF;
		IF NOT completed_is_null THEN
			IF pg_catalog.jsonb_typeof(channel_row -> 'completedAt') IS DISTINCT FROM 'string'
				OR (channel_row ->> 'completedAt')::pg_catalog.timestamptz > NEW."generated_at"
			THEN
				RAISE EXCEPTION 'Delivery-test channel completion must be a timestamp no later than report generation'
					USING ERRCODE = '55000';
			END IF;
		END IF;
		completed_at_value := CASE
			WHEN completed_is_null THEN NULL
			ELSE (channel_row ->> 'completedAt')::pg_catalog.timestamptz
		END;

		IF pg_catalog.jsonb_typeof(channel_row -> 'latestStateCounts') IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(channel_row -> 'latestStateCounts') > 6
		THEN
			RAISE EXCEPTION 'Delivery-test latest-state counts must be a bounded array'
				USING ERRCODE = '55000';
		END IF;

		counted_endpoints := 0;
		seen_states := ARRAY[]::text[];
		submitted_state_counts := '{}'::jsonb;
		has_non_success_state := false;
		FOR state_row IN
			SELECT value
			FROM pg_catalog.jsonb_array_elements(channel_row -> 'latestStateCounts')
		LOOP
			IF pg_catalog.jsonb_typeof(state_row) IS DISTINCT FROM 'object' THEN
				RAISE EXCEPTION 'Delivery-test latest-state row must be an object'
					USING ERRCODE = '55000';
			END IF;
			SELECT pg_catalog.count(*)::pg_catalog.int4
			INTO object_key_count
			FROM pg_catalog.jsonb_object_keys(state_row);
			IF object_key_count <> 2 OR NOT state_row ?& ARRAY['state', 'count'] THEN
				RAISE EXCEPTION 'Delivery-test latest-state fields must match the contract exactly'
					USING ERRCODE = '55000';
			END IF;

			state_name := state_row ->> 'state';
			IF state_name NOT IN (
				'attempted', 'provider-accepted', 'delivered',
				'failed', 'expired', 'unknown'
			) OR state_name = ANY(seen_states) THEN
				RAISE EXCEPTION 'Delivery-test latest-state rows must be valid and unique'
					USING ERRCODE = '55000';
			END IF;
			seen_states := pg_catalog.array_append(seen_states, state_name);

			IF pg_catalog.jsonb_typeof(state_row -> 'count') IS DISTINCT FROM 'number'
				OR state_row ->> 'count' !~ '^(0|[1-9][0-9]*)$'
			THEN
				RAISE EXCEPTION 'Delivery-test latest-state count must be a nonnegative integer'
					USING ERRCODE = '55000';
			END IF;
			state_count := (state_row ->> 'count')::pg_catalog.numeric;
			IF state_count > 12000 THEN
				RAISE EXCEPTION 'Delivery-test latest-state count exceeds its safe bound'
					USING ERRCODE = '54000';
			END IF;
			submitted_state_counts := submitted_state_counts
				|| pg_catalog.jsonb_build_object(state_name, state_count);
			counted_endpoints := counted_endpoints + state_count;
			IF state_name = 'unknown' THEN
				unknown_count := unknown_count + state_count;
			END IF;
			IF state_name IN ('failed', 'expired') THEN
				failed_or_expired_count := failed_or_expired_count + state_count;
			END IF;
			IF state_count > 0
				AND state_name NOT IN ('provider-accepted', 'delivered')
			THEN
				has_non_success_state := true;
			END IF;
		END LOOP;

		IF counted_endpoints <> endpoint_count THEN
			RAISE EXCEPTION 'Delivery-test latest-state counts must equal endpoint count'
				USING ERRCODE = '55000';
		END IF;
		IF NEW."status" = 'succeeded' AND (
			latency_is_null
			OR counted_endpoints <> endpoint_count
			OR has_non_success_state
		) THEN
			RAISE EXCEPTION 'Succeeded delivery-test reports require complete accepted or delivered truth'
				USING ERRCODE = '55000';
		END IF;
		submitted_channels := submitted_channels
			|| pg_catalog.jsonb_build_object(
				channel_name,
				pg_catalog.jsonb_build_object(
					'endpointCount', endpoint_count,
					'activationToProviderAcceptMs', latency_value,
					'latestStateCounts', submitted_state_counts,
					'completedAtEpochMs', CASE
						WHEN completed_at_value IS NULL THEN NULL
						ELSE pg_catalog.trunc(
							pg_catalog.date_part('epoch', completed_at_value) * 1000
						)::pg_catalog.int8
					END
				)
			);
	END LOOP;

	IF NOT (
		('push' = ANY(seen_channels) AND 'email' = ANY(seen_channels))
		OR coalesce(pg_catalog.array_length(seen_channels, 1), 0) = 1
	) THEN
		RAISE EXCEPTION 'Delivery-test report requires one controlled canary channel, or push and email channels'
			USING ERRCODE = '55000';
	END IF;
	SELECT pg_catalog.count(DISTINCT endpoint."channel")::pg_catalog.int4
	INTO pinned_channel_total
	FROM public."delivery_test_runs" AS run
	JOIN public."delivery_test_target_endpoints" AS endpoint
		ON endpoint."target_set_version_id" = run."target_set_version_id"
		AND endpoint."target_set_version" = run."target_set_version"
	WHERE run."id" = NEW."run_id";
	IF pinned_channel_total IS NULL
		OR pinned_channel_total <> coalesce(pg_catalog.array_length(seen_channels, 1), 0)
	THEN
		RAISE EXCEPTION 'Delivery-test report must include every pinned target channel exactly once'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."status" = 'incomplete' AND unknown_count = 0 THEN
		RAISE EXCEPTION 'Incomplete delivery-test report must retain explicit unknown truth'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."status" = 'failed' AND failed_or_expired_count = 0 THEN
		RAISE EXCEPTION 'Failed delivery-test report must retain failed or expired truth'
			USING ERRCODE = '55000';
	END IF;
	IF submitted_channels IS DISTINCT FROM expected_channels
		OR NEW."status"::pg_catalog.text IS DISTINCT FROM expected_status
		OR NEW."reason_code" IS DISTINCT FROM expected_reason_code
	THEN
		RAISE EXCEPTION 'Delivery-test report must exactly match persisted attempt and evidence truth'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

ALTER TABLE "outbox" DROP CONSTRAINT "outbox_channel_plan_shape";
--> statement-breakpoint
-- Keep the replacement lock brief: retained history is not scanned, while
-- every new or changed row is checked immediately.
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_channel_plan_shape" CHECK (case
	when jsonb_typeof("outbox"."channels") = 'array' then
		(
			(
				jsonb_array_length("outbox"."channels") between 2 and 3
				and jsonb_array_length(jsonb_path_query_array(
					"outbox"."channels", '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && @.integrationStatus.integrationId == "expo-push")'
				)) = 1
				and jsonb_array_length(jsonb_path_query_array(
					"outbox"."channels", '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationStatus.integrationId == "ses-email")'
				)) = 1
				and jsonb_array_length(jsonb_path_query_array(
					"outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
				)) <= 1
			) or (
				"outbox"."event_kind" = 'drill'
				and "outbox"."template_mode" = 'drill'
				and "outbox"."purpose" = 'activation'
				and "outbox"."roster_population" = 'staff'
				and jsonb_typeof("outbox"."message" -> 'deliveryTest') is not distinct from 'object'
				and jsonb_array_length("outbox"."channels") = 1
				and (
					jsonb_array_length(jsonb_path_query_array(
						"outbox"."channels", '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && @.integrationStatus.integrationId == "expo-push")'
					))
					+ jsonb_array_length(jsonb_path_query_array(
						"outbox"."channels", '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationStatus.integrationId == "ses-email")'
					))
					+ jsonb_array_length(jsonb_path_query_array(
						"outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
					))
				) = 1
			)
		) and jsonb_array_length(jsonb_path_query_array(
			"outbox"."channels", '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
		)) = jsonb_array_length("outbox"."channels")
	else false
end) NOT VALID;
--> statement-breakpoint
ALTER TABLE "delivery_test_reports" DROP CONSTRAINT "delivery_test_reports_channels_shape";
--> statement-breakpoint
ALTER TABLE "delivery_test_reports" ADD CONSTRAINT "delivery_test_reports_channels_shape" CHECK (
	jsonb_typeof("delivery_test_reports"."channels") is not distinct from 'array'
	and (
		jsonb_array_length("delivery_test_reports"."channels") between 2 and 3
		or (
			jsonb_array_length("delivery_test_reports"."channels") = 1
			and jsonb_array_length(jsonb_path_query_array(
				"delivery_test_reports"."channels", '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
			)) = 1
		)
	)
) NOT VALID;
