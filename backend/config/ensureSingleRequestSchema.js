const CHANGE_EXTEND_REASON_SQL = `
ALTER TABLE mat_single_request
ADD COLUMN IF NOT EXISTS change_extend_reason TEXT NULL;
`;

// The SAP-error resubmit flow sends a request back to the Master Data (MDM)
// stage as a rework, so rework_stage can now legitimately hold 'Master Data'.
// Widen the existing CHECK so DBs created before this accept it on startup.
const REWORK_STAGE_ALLOW_MDM_SQL = `
ALTER TABLE mat_single_request
    DROP CONSTRAINT IF EXISTS chk_mat_single_request_rework_stage;
ALTER TABLE mat_single_request
    ADD CONSTRAINT chk_mat_single_request_rework_stage
    CHECK (rework_stage IS NULL OR rework_stage IN ('Approval 1', 'Approval 2', 'Approval 3', 'Master Data'));
`;

// sap_synced_matnr is redundant — MATERIAL_NUMBER in Oracle is the code we push,
// not a value SAP returns — so drop it from DBs created before this change.
const DROP_SAP_SYNCED_MATNR_SQL = `
ALTER TABLE mat_single_request
    DROP COLUMN IF EXISTS sap_synced_matnr;
`;

async function ensureSingleRequestSchema(db) {
    await db.query(CHANGE_EXTEND_REASON_SQL);
    await db.query(REWORK_STAGE_ALLOW_MDM_SQL);
    await db.query(DROP_SAP_SYNCED_MATNR_SQL);
}

module.exports = {
    CHANGE_EXTEND_REASON_SQL,
    REWORK_STAGE_ALLOW_MDM_SQL,
    DROP_SAP_SYNCED_MATNR_SQL,
    ensureSingleRequestSchema,
};
