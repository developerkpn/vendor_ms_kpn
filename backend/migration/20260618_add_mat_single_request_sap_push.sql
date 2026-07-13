-- SAP Oracle-staging push tracking for single-material requests.
-- A request is flagged PENDING when it reaches DONE; a cron job inserts it into
-- the Oracle staging table VMS_MATERIALDATA and advances the status:
--   NULL     -> never flagged (mass requests / pre-feature rows)
--   PENDING  -> completed, awaiting push to Oracle
--   PUSHED   -> inserted into VMS_MATERIALDATA, awaiting SAP pull/post
--   SYNCED   -> SAP confirmed the material was created (FLAG='S')
--   ERROR    -> push or SAP post failed (see sap_error_msg)
ALTER TABLE mat_single_request
    ADD COLUMN IF NOT EXISTS sap_push_status  varchar(20) NULL,
    ADD COLUMN IF NOT EXISTS sap_pushed_at    timestamptz NULL,
    ADD COLUMN IF NOT EXISTS sap_error_msg    text NULL;

-- Cron lookups filter on sap_push_status; keep them index-assisted.
CREATE INDEX IF NOT EXISTS idx_mat_single_request_sap_push_status
    ON mat_single_request (sap_push_status)
    WHERE sap_push_status IS NOT NULL;
