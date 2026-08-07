-- Per-item final code + SAP Oracle-staging push tracking for MASS material
-- requests.
-- Created: 2026-08-06
-- Purpose:
-- 1. Give every batch item its own final material code, composed at the Master
--    Data (MDM) approval exactly like mat_single_request.final_code — item k of
--    the batch (ordered by item_no) takes the entered running number + (k-1).
-- 2. Mirror the mat_single_request SAP push columns per ITEM: a mass request
--    stages ONE VMS_MATERIALDATA row per item (keyed by the item's request_no),
--    so the push status has to live on the item, not on the batch header.
--
-- Column definitions mirror mat_single_request 1:1 (see
-- 20260506_create_mat_single_request_tables.sql for final_code and
-- 20260618_add_mat_single_request_sap_push.sql for the sap_* trio); neither
-- carries a CHECK constraint there, so none is added here.
--
-- sap_push_status lifecycle (identical to the single-request one):
--   NULL     -> never flagged (pre-feature rows / batch not completed yet)
--   PENDING  -> item completed, awaiting push to Oracle
--   PUSHED   -> inserted into VMS_MATERIALDATA, awaiting SAP pull/post
--   SYNCED   -> SAP confirmed the material was created (FLAG='S')
--   ERROR    -> push or SAP post failed (see sap_error_msg)

ALTER TABLE mat_mass_request_item
    ADD COLUMN IF NOT EXISTS final_code       varchar(11) NULL,
    ADD COLUMN IF NOT EXISTS sap_push_status  varchar(20) NULL,
    ADD COLUMN IF NOT EXISTS sap_pushed_at    timestamptz NULL,
    ADD COLUMN IF NOT EXISTS sap_error_msg    text NULL;

-- The push/sync lookups filter on sap_push_status; keep them index-assisted.
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_sap_push_status
    ON mat_mass_request_item (sap_push_status)
    WHERE sap_push_status IS NOT NULL;

-- Uniqueness of a composed code is enforced in the approval transaction (vs
-- mat_sap_data, mat_single_request and the other batches), mirroring single —
-- no unique index here, because a cancelled row must be able to release its
-- code back to the pool.
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_final_code
    ON mat_mass_request_item (final_code)
    WHERE final_code IS NOT NULL;

COMMENT ON COLUMN public.mat_mass_request_item.final_code IS
    'Final material code composed at the Master Data step from mat_item_group.code, mat_item_sub_group.code, and the entered running number incremented per item_no.';
COMMENT ON COLUMN public.mat_mass_request_item.sap_push_status IS
    'Oracle staging push status of this item: NULL / PENDING / PUSHED / SYNCED / ERROR.';
COMMENT ON COLUMN public.mat_mass_request_item.sap_pushed_at IS
    'Timestamp the item row was inserted into the Oracle staging table VMS_MATERIALDATA.';
COMMENT ON COLUMN public.mat_mass_request_item.sap_error_msg IS
    'Last push or SAP write-back error message for this item (truncated to 500 chars).';
