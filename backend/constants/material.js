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
const MAX_MATERIAL_DESCRIPTION_LENGTH = 40;

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

module.exports = {
    STEP_KINDS,
    STEP_STATUS,
    STEP_INITIAL_STATUS,
    MDM_MATERIAL_GROUP_NAME,
    ADMIN_APPROVER_USERNAME,
    SQL_NOW_EXPRESSION,
    SINGLE_REQUEST_TICKET_TYPES,
    MAX_MATERIAL_DESCRIPTION_LENGTH,
    SECTION_TITLES,
    SECTION_ORDER,
    MATERIAL_SAP_STAGING_TABLE,
    SINGLE_REQUEST_MATERIAL_CODE_SQL,
};
