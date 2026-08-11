ALTER TABLE public."events"
ADD CONSTRAINT "events_identity_facility_uq" UNIQUE("id", "facility_id");--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD COLUMN "facility_id" uuid;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD COLUMN "budget_principal_digest" varchar(64);--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD COLUMN "budget_principal_attributed" boolean;--> statement-breakpoint

-- Existing intents have an authoritative event/facility relationship, but
-- their stable principal cannot be reconstructed from session/API-key-bound
-- idempotency digests. Preserve that truth explicitly with a reserved digest;
-- admission fails closed while one of these rows remains in the rolling window.
UPDATE public."media_upload_intents" AS intent
SET
  "facility_id" = event."facility_id",
  "budget_principal_digest" = repeat('0', 64),
  "budget_principal_attributed" = false
FROM public."events" AS event
WHERE event."id" = intent."event_id";--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ALTER COLUMN "budget_principal_digest" SET NOT NULL;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ALTER COLUMN "budget_principal_attributed" SET DEFAULT true;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ALTER COLUMN "budget_principal_attributed" SET NOT NULL;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD CONSTRAINT "media_upload_intents_event_facility_fk"
FOREIGN KEY ("event_id", "facility_id")
REFERENCES public."events"("id", "facility_id")
ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD CONSTRAINT "media_upload_intents_budget_principal_digest_format"
CHECK ("budget_principal_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint

ALTER TABLE public."media_upload_intents"
ADD CONSTRAINT "media_upload_intents_budget_principal_attribution"
CHECK (
  (
    "budget_principal_attributed" = false
    AND "budget_principal_digest" = repeat('0', 64)
  ) OR (
    "budget_principal_attributed" = true
    AND "budget_principal_digest" <> repeat('0', 64)
  )
);--> statement-breakpoint

CREATE INDEX "media_upload_intents_budget_principal_created_idx"
ON public."media_upload_intents" USING btree
("budget_principal_digest", "created_at");--> statement-breakpoint

CREATE INDEX "media_upload_intents_unattributed_created_idx"
ON public."media_upload_intents" USING btree
("budget_principal_attributed", "created_at");--> statement-breakpoint

CREATE INDEX "media_upload_intents_event_active_idx"
ON public."media_upload_intents" USING btree
("event_id", "status", "expires_at");--> statement-breakpoint

CREATE INDEX "media_upload_intents_event_created_idx"
ON public."media_upload_intents" USING btree
("event_id", "created_at");--> statement-breakpoint

CREATE INDEX "media_upload_intents_facility_active_idx"
ON public."media_upload_intents" USING btree
("facility_id", "status", "expires_at");--> statement-breakpoint

CREATE INDEX "media_upload_intents_facility_created_idx"
ON public."media_upload_intents" USING btree
("facility_id", "created_at");--> statement-breakpoint

CREATE INDEX "journal_entries_event_media_idx"
ON public."journal_entries" USING btree
("event_id", "media_id", "id", "sequence")
WHERE "kind" = 'photo';--> statement-breakpoint

CREATE INDEX "journal_entries_event_redaction_target_idx"
ON public."journal_entries" USING btree
("event_id", "supersedes_entry_id", "supersedes_entry_sequence")
WHERE "supersession_kind" = 'redaction';--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_media_upload_intent_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."budget_principal_attributed" IS DISTINCT FROM true
      OR NEW."budget_principal_digest" = repeat('0', 64)
    THEN
      RAISE EXCEPTION 'new media upload intents require an attributed budget principal'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
    OR NEW."budget_principal_digest" IS DISTINCT FROM OLD."budget_principal_digest"
    OR NEW."budget_principal_attributed" IS DISTINCT FROM OLD."budget_principal_attributed"
    OR NEW."byte_length" IS DISTINCT FROM OLD."byte_length"
    OR NEW."content_sha256" IS DISTINCT FROM OLD."content_sha256"
    OR NEW."declared_content_type" IS DISTINCT FROM OLD."declared_content_type"
    OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
  THEN
    RAISE EXCEPTION 'media upload intent identity and allocation evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      OLD."status" = 'pending-upload'
      AND NEW."status" IN ('completed', 'rejected', 'expired')
    )
  THEN
    RAISE EXCEPTION 'media upload intent status cannot roll back or change terminal state'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "media_upload_intents_integrity_guard"
BEFORE INSERT OR UPDATE ON public."media_upload_intents"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_media_upload_intent_mutation"();--> statement-breakpoint

CREATE TRIGGER "media_records_immutable_guard"
BEFORE UPDATE OR DELETE ON public."media_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

REVOKE UPDATE, DELETE ON TABLE public."media_records" FROM "psd_eoc_app";
