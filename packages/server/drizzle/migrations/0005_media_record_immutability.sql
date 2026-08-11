CREATE TRIGGER "media_records_immutable_guard"
BEFORE UPDATE OR DELETE ON public."media_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

REVOKE UPDATE, DELETE ON TABLE public."media_records" FROM "psd_eoc_app";
