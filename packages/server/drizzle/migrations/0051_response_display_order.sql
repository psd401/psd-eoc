ALTER TABLE "event_types" ADD COLUMN "display_order" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
-- A response type's identity (key, family, mode, whether it needs a detail)
-- stays immutable. Its place in the list an operator chooses from is
-- presentation, so the guard from 0000 is replaced on this one table by a
-- guard that lets display_order change and nothing else.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_event_type_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (pg_catalog.to_jsonb(NEW) - 'display_order')
		IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'display_order') THEN
		RAISE EXCEPTION 'PSD EOC immutable truth cannot be changed on %; only display_order may change', TG_TABLE_NAME
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "event_types_immutable_guard" ON "event_types";--> statement-breakpoint
CREATE TRIGGER "event_types_immutable_guard"
BEFORE UPDATE ON "event_types"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_event_type_mutation"();--> statement-breakpoint
-- The district reads its responses in a fixed order: Investigation, Modified
-- Lockdown, Lockdown, Evacuation, No Evacuation, Shelter in Place, Other. The
-- real and drill variants of a family share its position. A response added
-- on the Responses page keeps the default and lists after these, by key.
UPDATE "event_types" SET "display_order" = 10 WHERE "family_key" = 'investigation';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 20 WHERE "family_key" = 'modified-lockdown';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 30 WHERE "family_key" = 'lockdown';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 40 WHERE "family_key" = 'evacuation';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 50 WHERE "family_key" = 'no-evacuation';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 60 WHERE "family_key" = 'shelter-in-place';--> statement-breakpoint
UPDATE "event_types" SET "display_order" = 70 WHERE "family_key" = 'other';
