// Material feature constants (in-scope: single + mass material requests, dynamic
// step-based approvers, the MDM/Master-Data stage, and the Oracle SAP staging
// push). Single source of truth — the legacy helper/model/controller modules
// re-export these during the warehouse_be-style layering migration.

// --- Dynamic approval step engine ------------------------------------------
const STEP_KINDS = Object.freeze({ MANUAL: "MANUAL", MDM: "MDM" });
const STEP_STATUS = Object.freeze({
    WAITING: "WAITING",
    APPROVED: "APPROVED",
    REWORK: "REWORK",
    REJECTED: "REJECTED",
});
const STEP_INITIAL_STATUS = STEP_STATUS.WAITING;
const MDM_MATERIAL_GROUP_NAME = "MDM_MATERIAL";

// Temporary material-approval fallback: normalized username ADMIN.
const ADMIN_APPROVER_USERNAME = "ADMIN";

// Raw-SQL sentinel: patch values shaped like this are inlined verbatim (NOW())
// by the model writer instead of being bound as a string literal.
const SQL_NOW_EXPRESSION = Object.freeze({ __sql: "NOW()" });

const SINGLE_REQUEST_TICKET_TYPES = Object.freeze({
    CREATE: "Create",
    CHANGE: "Change",
    EXTEND: "Extend",
});

// --- Template / form schema ------------------------------------------------
// SAP MAKTX is hard-capped at 40; the 3 long-text continuation columns go to
// SAP via SAVE_TEXT (TDLINE, 132/line) so they can be wider. Combined PO text
// max = 40 + 3*70 = 250.
const MAX_MATERIAL_DESCRIPTION_LENGTH = 40;
const MAX_LONG_TEXT_COLUMN_LENGTH = 70;

const SECTION_TITLES = {
    basic_info: "Basic Info",
    plant_data: "Plant Data",
    sales_data: "Sales Data",
    accounting_data: "Accounting Data",
    specification: "Specification",
};
const SECTION_ORDER = [
    "basic_info",
    "plant_data",
    "sales_data",
    "accounting_data",
    "specification",
];

// --- SAP Oracle staging ----------------------------------------------------
const MATERIAL_SAP_STAGING_TABLE = "VMS_MATERIALDATA";

// SQL fragment: resolve a single request's material code from its template
// payload (material_number → material_code → materialCode). Interpolated into
// list/inbox/push queries; value MUST stay byte-identical (pinned by tests).
const SINGLE_REQUEST_MATERIAL_CODE_SQL = `NULLIF(COALESCE(
            r.template_payload #>> '{requestFields,material_number}',
            r.template_payload #>> '{requestFields,material_code}',
            r.template_payload #>> '{requestFields,materialCode}',
            ''
        ), '')`;

// SQL fragments: resolve a MASS item's material group / sub group CODES.
// mat_mass_request_item stores the two fields as free text (varchar(100)) —
// the grid UI writes whatever the dropdown bound to, which is the display name
// on some builds and the code on others — while the final-code composer and
// the SAP staging push both need the bare 3-digit CODE. One LATERAL per field
// resolves it from the master tables, accepting all three shapes the UI can
// have written ("901", "BEARING", "901 - BEARING") case/whitespace-insensitively
// and preferring an exact code hit when a name happens to collide with a code.
// LIMIT 1 keeps the join from multiplying the item row; the sub group is scoped
// to the resolved group because sub-group codes are only unique within a group.
// Both fragments assume the item table is aliased `i`; the group fragment must
// come first (the sub-group one reads mig.id).
const MASS_ITEM_GROUP_CODE_LATERAL_SQL = `LEFT JOIN LATERAL (
                SELECT g.id, g.code
                FROM mat_item_group g
                WHERE g.deleted_at IS NULL
                  AND BTRIM(COALESCE(i.material_group, '')) <> ''
                  AND (
                      UPPER(BTRIM(g.code)) IN (
                          UPPER(BTRIM(i.material_group)),
                          UPPER(BTRIM(SPLIT_PART(i.material_group, ' - ', 1)))
                      )
                      OR UPPER(BTRIM(g.name)) IN (
                          UPPER(BTRIM(i.material_group)),
                          UPPER(BTRIM(SPLIT_PART(i.material_group, ' - ', 1)))
                      )
                      OR UPPER(BTRIM(g.code) || ' - ' || BTRIM(g.name)) =
                         UPPER(BTRIM(i.material_group))
                  )
                ORDER BY
                    (UPPER(BTRIM(g.code)) = UPPER(BTRIM(i.material_group))) DESC,
                    g.id ASC
                LIMIT 1
            ) mig ON TRUE`;

const MASS_ITEM_SUB_GROUP_CODE_LATERAL_SQL = `LEFT JOIN LATERAL (
                SELECT s.id, s.code
                FROM mat_item_sub_group s
                WHERE s.deleted_at IS NULL
                  AND s.item_group_id = mig.id
                  AND BTRIM(COALESCE(i.material_sub_group, '')) <> ''
                  AND (
                      UPPER(BTRIM(s.code)) IN (
                          UPPER(BTRIM(i.material_sub_group)),
                          UPPER(BTRIM(SPLIT_PART(i.material_sub_group, ' - ', 1)))
                      )
                      OR UPPER(BTRIM(s.name)) IN (
                          UPPER(BTRIM(i.material_sub_group)),
                          UPPER(BTRIM(SPLIT_PART(i.material_sub_group, ' - ', 1)))
                      )
                      OR UPPER(BTRIM(s.code) || ' - ' || BTRIM(s.name)) =
                         UPPER(BTRIM(i.material_sub_group))
                  )
                ORDER BY
                    (UPPER(BTRIM(s.code)) = UPPER(BTRIM(i.material_sub_group))) DESC,
                    s.id ASC
                LIMIT 1
            ) mis ON TRUE`;

module.exports = {
    STEP_KINDS,
    STEP_STATUS,
    STEP_INITIAL_STATUS,
    MDM_MATERIAL_GROUP_NAME,
    ADMIN_APPROVER_USERNAME,
    SQL_NOW_EXPRESSION,
    SINGLE_REQUEST_TICKET_TYPES,
    MAX_MATERIAL_DESCRIPTION_LENGTH,
    MAX_LONG_TEXT_COLUMN_LENGTH,
    SECTION_TITLES,
    SECTION_ORDER,
    MATERIAL_SAP_STAGING_TABLE,
    SINGLE_REQUEST_MATERIAL_CODE_SQL,
    MASS_ITEM_GROUP_CODE_LATERAL_SQL,
    MASS_ITEM_SUB_GROUP_CODE_LATERAL_SQL,
};
