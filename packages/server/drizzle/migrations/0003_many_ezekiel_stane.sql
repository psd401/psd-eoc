CREATE TABLE "security_audit_chain_anchors" (
	"sequence" integer PRIMARY KEY NOT NULL,
	"entry_hash" varchar(64) NOT NULL,
	CONSTRAINT "security_audit_chain_anchors_hash_uq" UNIQUE("entry_hash"),
	CONSTRAINT "security_audit_chain_anchors_sequence_positive" CHECK ("security_audit_chain_anchors"."sequence" > 0),
	CONSTRAINT "security_audit_chain_anchors_hash_format" CHECK ("security_audit_chain_anchors"."entry_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint

-- Establish one trusted baseline while all audit writers are serialized.
SELECT pg_advisory_xact_lock(
	hashtextextended('psd-eoc-security-audit', 0)
);--> statement-breakpoint
LOCK TABLE public."security_audit_entries" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				"sequence",
				"previous_hash",
				lag("sequence") OVER (ORDER BY "sequence") AS prior_sequence,
				lag("entry_hash") OVER (ORDER BY "sequence") AS prior_hash
			FROM public."security_audit_entries"
		) AS ordered_entries
		WHERE (
			"sequence" = 1
			AND "previous_hash" IS NOT NULL
		) OR (
			"sequence" <> 1
			AND (
				prior_sequence IS NULL
				OR "sequence" <> prior_sequence + 1
				OR "previous_hash" IS DISTINCT FROM prior_hash
			)
		)
	) THEN
		RAISE EXCEPTION 'Cannot anchor an invalid existing security audit chain'
			USING ERRCODE = '55000';
	END IF;
END;
$$;--> statement-breakpoint

INSERT INTO public."security_audit_chain_anchors" ("sequence", "entry_hash")
SELECT "sequence", "entry_hash"
FROM public."security_audit_entries"
ORDER BY "sequence";--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_security_audit_entry_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	prior_sequence integer;
	prior_hash varchar(64);
BEGIN
	IF TG_RELID <> 'public.security_audit_entries'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'security_audit_entries'
		OR TG_OP <> 'INSERT'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW' THEN
		RAISE EXCEPTION 'Security audit guard invoked outside its trusted trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('psd-eoc-security-audit', 0)
	);

	SELECT "sequence", "entry_hash"
	INTO prior_sequence, prior_hash
	FROM public."security_audit_chain_anchors"
	ORDER BY "sequence" DESC
	LIMIT 1;

	IF prior_sequence IS NULL THEN
		IF NEW."sequence" <> 1 OR NEW."previous_hash" IS NOT NULL THEN
			RAISE EXCEPTION 'Security audit append does not create the anchored genesis entry'
				USING ERRCODE = '55000';
		END IF;
	ELSIF NEW."sequence" <> prior_sequence + 1
		OR NEW."previous_hash" IS DISTINCT FROM prior_hash THEN
		RAISE EXCEPTION 'Security audit append does not advance the durable chain anchor'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public."psd_eoc_guard_security_audit_entry_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_security_audit_entry_insert"() FROM "psd_eoc_app";--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_anchor_security_audit_entry"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
	prior_sequence integer;
	prior_hash varchar(64);
BEGIN
	IF TG_RELID <> 'public.security_audit_entries'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'security_audit_entries'
		OR TG_OP <> 'INSERT'
		OR TG_WHEN <> 'AFTER'
		OR TG_LEVEL <> 'ROW' THEN
		RAISE EXCEPTION 'Security audit anchor invoked outside its trusted trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('psd-eoc-security-audit', 0)
	);

	SELECT "sequence", "entry_hash"
	INTO prior_sequence, prior_hash
	FROM public."security_audit_chain_anchors"
	ORDER BY "sequence" DESC
	LIMIT 1;

	IF prior_sequence IS NULL THEN
		IF NEW."sequence" <> 1 OR NEW."previous_hash" IS NOT NULL THEN
			RAISE EXCEPTION 'Security audit append does not create the anchored genesis entry'
				USING ERRCODE = '55000';
		END IF;
	ELSIF NEW."sequence" <> prior_sequence + 1
		OR NEW."previous_hash" IS DISTINCT FROM prior_hash THEN
		RAISE EXCEPTION 'Security audit append does not advance the durable chain anchor'
			USING ERRCODE = '55000';
	END IF;

	INSERT INTO public."security_audit_chain_anchors" (
		"sequence",
		"entry_hash"
	) VALUES (
		NEW."sequence",
		NEW."entry_hash"
	);

	RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public."psd_eoc_anchor_security_audit_entry"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_anchor_security_audit_entry"() FROM "psd_eoc_app";--> statement-breakpoint

CREATE TRIGGER "security_audit_entries_anchor_guard"
BEFORE INSERT ON public."security_audit_entries"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_security_audit_entry_insert"();--> statement-breakpoint

CREATE TRIGGER "security_audit_entries_anchor_commit"
AFTER INSERT ON public."security_audit_entries"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_anchor_security_audit_entry"();--> statement-breakpoint

CREATE TRIGGER "security_audit_chain_anchors_immutable_guard"
BEFORE UPDATE OR DELETE ON public."security_audit_chain_anchors"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE public."security_audit_chain_anchors" FROM "psd_eoc_app";--> statement-breakpoint
GRANT SELECT ON TABLE public."security_audit_chain_anchors" TO "psd_eoc_app";
