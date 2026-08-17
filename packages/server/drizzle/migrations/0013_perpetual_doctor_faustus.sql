CREATE TABLE "access_membership_evaluated_members" (
	"snapshot_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	CONSTRAINT "access_membership_evaluated_members_snapshot_id_email_group_source_id_pk" PRIMARY KEY("snapshot_id","email","group_source_id"),
	CONSTRAINT "access_membership_evaluated_members_access_only" CHECK ("access_membership_evaluated_members"."group_source_kind" = 'google-group'
        and "access_membership_evaluated_members"."group_purpose" = 'access'),
	CONSTRAINT "access_membership_evaluated_members_normalized_email" CHECK ("access_membership_evaluated_members"."email" = lower("access_membership_evaluated_members"."email")
        and "access_membership_evaluated_members"."email" = btrim("access_membership_evaluated_members"."email")
        and length("access_membership_evaluated_members"."email") between 3 and 320
        and "access_membership_evaluated_members"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$')
);
--> statement-breakpoint
ALTER TABLE "access_membership_evaluated_members" ADD CONSTRAINT "access_membership_evaluated_members_snapshot_id_access_membership_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."access_membership_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_evaluated_members" ADD CONSTRAINT "access_membership_evaluated_members_access_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_membership_evaluated_members_email_idx" ON "access_membership_evaluated_members" USING btree ("email");--> statement-breakpoint

-- Preserve every already-published bound identity as evaluated email
-- evidence. This derives email only from the existing local OIDC binding and
-- copies the exact snapshotted access-group provenance; it never uses a
-- provider user resource name as a Google subject.
INSERT INTO public."access_membership_evaluated_members" (
	"snapshot_id",
	"email",
	"group_source_id",
	"group_source_kind",
	"group_purpose"
)
SELECT
	member."snapshot_id",
	pg_catalog.lower("user"."email"),
	member_group."group_source_id",
	member_group."group_source_kind",
	member_group."group_purpose"
FROM public."access_membership_members" AS member
INNER JOIN public."users" AS "user"
	ON "user"."id" = member."user_id"
	AND "user"."google_subject" = member."google_subject"
INNER JOIN public."access_membership_member_groups" AS member_group
	ON member_group."snapshot_id" = member."snapshot_id"
	AND member_group."user_id" = member."user_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Evaluated email evidence is part of the same immutable snapshot graph as
-- bound OIDC subjects. Construct it only with a parent created in the current
-- transaction; an exact retry is harmless, while later augmentation fails.
CREATE FUNCTION public."psd_eoc_guard_access_evaluated_member_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	existing_row jsonb;
	parent_created_in_current_transaction boolean := false;
BEGIN
	IF TG_RELID <> 'public.access_membership_evaluated_members'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'access_membership_evaluated_members'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected evaluated access-member construction trigger context'
			USING ERRCODE = '55000';
	END IF;

	SELECT pg_catalog.to_jsonb(existing)
	INTO existing_row
	FROM public."access_membership_evaluated_members" AS existing
	WHERE existing."snapshot_id" = NEW."snapshot_id"
		AND existing."email" = NEW."email"
		AND existing."group_source_id" = NEW."group_source_id";

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM pg_catalog.to_jsonb(NEW) THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Evaluated access-member retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	SELECT parent.xmin =
		pg_catalog.pg_current_xact_id()::pg_catalog.xid
	INTO parent_created_in_current_transaction
	FROM public."access_membership_snapshots" AS parent
	WHERE parent."id" = NEW."snapshot_id";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published access snapshot cannot accept evaluated member rows'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE FUNCTION public."psd_eoc_reject_access_evaluated_member_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.access_membership_evaluated_members'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'access_membership_evaluated_members'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'UPDATE'
	THEN
		RAISE EXCEPTION 'Unexpected evaluated access-member update trigger context'
			USING ERRCODE = '55000';
	END IF;

	RAISE EXCEPTION 'Evaluated access-member evidence is immutable'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "access_membership_evaluated_members_construction_guard"
BEFORE INSERT ON public."access_membership_evaluated_members"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_access_evaluated_member_insert"();--> statement-breakpoint

CREATE TRIGGER "access_membership_evaluated_members_immutable_guard"
BEFORE UPDATE ON public."access_membership_evaluated_members"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_access_evaluated_member_update"();--> statement-breakpoint

CREATE TRIGGER "access_membership_evaluated_members_retain_guard"
BEFORE DELETE ON public."access_membership_evaluated_members"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint

REVOKE ALL ON FUNCTION public."psd_eoc_guard_access_evaluated_member_insert"()
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_reject_access_evaluated_member_update"()
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE
	public."access_membership_evaluated_members"
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
	public."access_membership_evaluated_members"
TO "psd_eoc_app";
