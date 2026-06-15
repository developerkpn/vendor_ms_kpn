const db = require("../config/connection.js");
const Crud = require("../helper/crudquery.js");
const fs = require("fs");
const path = require("path");
const DBClientWrapper = require("../helper/DBClientWrapper.js");
const getMimeType = require("../helper/mimetype.js");
const xlsx = require("xlsx");
const axios = require("axios");
const pool = require("../config/connection");
const saveToDatabase = require("../helper/sap_seeding");
const Emailer = require("../models/EmailModel.js");
const MaterialTemplate = require("../models/MaterialTemplateModel");
const TRANS = require("../config/transaction.js");
const {
    INITIAL_APPROVAL_STATUS,
    MDM_MATERIAL_GROUP_NAME,
    SINGLE_REQUEST_TICKET_TYPES,
    buildSingleRequestRejectPatch,
    buildSingleRequestRevisedPatch,
    buildSingleRequestReworkPatch,
    buildAdministratorAssignmentDecision,
    buildAutoAssignedApproval3,
    buildRequesterApprovalMaster,
    buildSingleRequestFinalCode,
    buildSingleRequestApprovalSnapshot,
    canActorApproveSingleRequestStage,
    canActorReviseSingleRequest,
    canEditApprovalAssignee,
    filterSingleRequestApprovalInboxRows,
    getApprovalStageFieldPrefix,
    isAdminMaterialApprover,
    isSingleRequestApprovalInboxEligible,
    normalizeSingleRequestTicketType,
    resolveSingleRequestApprovalStage,
    // Step-based action patch builders (new dynamic-approver flow).
    buildStepApprovePatch,
    buildStepReworkPatch,
    buildStepRejectPatch,
    buildStepRevisedPatch,
} = require("../helper/singleRequestApproval.js");
const {
    resolveMassRequestApprovalStage,
    isMassRequestApprovalInboxEligible,
    filterMassRequestApprovalInboxRows,
    canActorApproveMassRequestStage,
    buildMassRequestApprovePatch,
    buildMassRequestReworkPatch,
    buildMassRequestRejectPatch,
    syncMassRequestItemApprovalSnapshot,
    // New step-based mass flow (mat_mass_request_item_approval_step).
    buildMassStepApprovePatch,
    buildMassStepReworkPatch,
    buildMassStepRejectPatch,
    buildMassStepRevisedPatch,
    mapMassStepRowsToPayload,
} = require("../helper/massRequestApproval");
const {
    STEP_KINDS,
    normalizeStepStatus,
    buildApprovalStepPlan,
    resolveActiveStep,
    stepLabel,
    resolveAssignedToFromSteps,
    canActorActOnStep,
    isFinalStepActive,
    buildStepsPayload,
    findStepByLabel,
} = require("../helper/approvalSteps.js");
const {
    buildMaterialDescriptionAndLongText,
} = require("../helper/materialTemplateHelper");

const buildSingleRequestApprovalError = (message, statusCode, code) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const SINGLE_REQUEST_EDITABLE_FIELDS = [
    "material_sub_group_id",
    "plant_code",
    "sloc_code",
    "material_description",
    "base_uom",
    "long_text_1",
    "long_text_2",
    "long_text_3",
    "template_payload",
];

const SINGLE_REQUEST_CHANGE_EDITABLE_FIELDS = [
    "material_description",
    "base_uom",
    "template_payload",
    "change_extend_reason",
];

const SINGLE_REQUEST_EXTEND_EDITABLE_FIELDS = [
    "plant_code",
    "sloc_code",
    "change_extend_reason",
];

const SINGLE_REQUEST_LONG_TEXT_FIELD_KEYS = [
    "long_text_1",
    "long_text_2",
    "long_text_3",
];

const SINGLE_REQUEST_NON_FORM_FIELD_KEYS = new Set([
    "profit_center",
    "sales_organization",
    "distribution_channel",
    "valuation_class",
    "valuation_class_project_stock",
]);

const SINGLE_REQUEST_APPROVAL_EDIT_REQUEST_FIELD_KEYS = new Set([
    "material_description",
    "base_uom",
    "base_unit_of_measure",
    "plant",
    "storage_location",
    "long_text_1",
    "long_text_2",
    "long_text_3",
]);

const SINGLE_REQUEST_APPROVAL_EDIT_CHANGE_FIELD_KEYS = new Set([
    "material_number",
    "material_type",
    "material_group",
    "material_description",
    "base_uom",
    "base_unit_of_measure",
    "long_text_1",
    "long_text_2",
    "long_text_3",
]);

const SINGLE_REQUEST_APPROVAL_EDIT_EXTEND_FIELD_KEYS = new Set([
    "material_description",
    "base_uom",
    "base_unit_of_measure",
    "plant",
    "storage_location",
    "long_text_1",
    "long_text_2",
    "long_text_3",
]);

const SINGLE_REQUEST_REQUEST_FIELD_ALIASES = {
    base_uom: "base_unit_of_measure",
    storageLocation: "storage_location",
    longText1: "long_text_1",
    longText2: "long_text_2",
    longText3: "long_text_3",
};

const SINGLE_REQUEST_EDITED_REQUEST_ALIASES = {
    ticketType: "ticket_type",
    materialCode: "material_code",
    changeExtendReason: "change_extend_reason",
    materialGroupId: "material_group_id",
    materialSubGroupId: "material_sub_group_id",
    plantCode: "plant_code",
    slocCode: "sloc_code",
    materialDescription: "material_description",
    baseUom: "base_uom",
    templatePayload: "template_payload",
    longText1: "long_text_1",
    longText2: "long_text_2",
    longText3: "long_text_3",
};

const normalizeSingleRequestEditableValue = (field, value) => {
    if (field === "template_payload") {
        return value == null ? null : JSON.stringify(value);
    }

    return value ?? null;
};

const resolveSingleRequestEditableFields = ({
    ticketType,
    allowMaterialGroupChange = false,
} = {}) => {
    const normalizedTicketType = normalizeSingleRequestTicketType(ticketType);

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.CHANGE) {
        return SINGLE_REQUEST_CHANGE_EDITABLE_FIELDS;
    }

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
        return SINGLE_REQUEST_EXTEND_EDITABLE_FIELDS;
    }

    return allowMaterialGroupChange
        ? [...SINGLE_REQUEST_EDITABLE_FIELDS, "material_group_id"]
        : SINGLE_REQUEST_EDITABLE_FIELDS;
};

const normalizeSingleRequestRequestFields = payload => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }

    const normalized = { ...payload };

    for (const [legacyKey, canonicalKey] of Object.entries(
        SINGLE_REQUEST_REQUEST_FIELD_ALIASES
    )) {
        if (
            normalized[canonicalKey] === undefined &&
            normalized[legacyKey] !== undefined
        ) {
            normalized[canonicalKey] = normalized[legacyKey];
        }
    }

    return normalized;
};

const normalizeSingleRequestEditedRequest = payload => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }

    const normalized = { ...payload };

    for (const [legacyKey, canonicalKey] of Object.entries(
        SINGLE_REQUEST_EDITED_REQUEST_ALIASES
    )) {
        if (
            normalized[canonicalKey] === undefined &&
            normalized[legacyKey] !== undefined
        ) {
            normalized[canonicalKey] = normalized[legacyKey];
        }

        if (legacyKey !== canonicalKey) {
            delete normalized[legacyKey];
        }
    }

    return normalized;
};

const isSingleRequestApprovalEditValidationErrorVisible = (
    error = {},
    validation = {},
    ticketType
) => {
    const fieldKey = error.fieldKey ?? error.field_key;

    if (!fieldKey || SINGLE_REQUEST_NON_FORM_FIELD_KEYS.has(fieldKey)) {
        return false;
    }

    const normalizedTicketType = normalizeSingleRequestTicketType(ticketType);

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.CHANGE) {
        const matchingTemplateField = Array.isArray(validation.template?.fields)
            ? validation.template.fields.find(
                  field => (field?.fieldKey ?? field?.field_key) === fieldKey
              )
            : null;
        const templateValues = validation.templateValues || validation.normalizedTemplateValues || {};
        const templateValue = templateValues[fieldKey];
        const hasTemplateValue =
            templateValue !== undefined &&
            templateValue !== null &&
            !(
                typeof templateValue === "string" &&
                templateValue.trim() === ""
            );
        const isMissingTemplateValueError =
            Boolean(matchingTemplateField?.isMandatory) &&
            !hasTemplateValue &&
            /wajib diisi/i.test(String(error.message || ""));

        if (isMissingTemplateValueError) {
            return false;
        }

        const isRequestRuleError = (validation.requestFieldRules || []).some(
            rule => (rule?.fieldKey ?? rule?.field_key) === fieldKey
        );

        if (
            isRequestRuleError &&
            !SINGLE_REQUEST_APPROVAL_EDIT_CHANGE_FIELD_KEYS.has(fieldKey)
        ) {
            return false;
        }

        return true;
    }

    const isRequestRuleError = (validation.requestFieldRules || []).some(
        rule => (rule?.fieldKey ?? rule?.field_key) === fieldKey
    );

    const applicableFieldKeys =
        normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND
            ? SINGLE_REQUEST_APPROVAL_EDIT_EXTEND_FIELD_KEYS
            : SINGLE_REQUEST_APPROVAL_EDIT_REQUEST_FIELD_KEYS;

    if (
        isRequestRuleError &&
        !applicableFieldKeys.has(fieldKey)
    ) {
        return false;
    }

    return true;
};

const buildNormalizedApprovalEditRequestFields = ({
    requestFields = {},
    validation = {},
}) => {
    const normalizedRequestFields = validation.normalizedRequestFields || {};
    const normalized = {
        ...normalizedRequestFields,
        material_description:
            requestFields.material_description ||
            validation.materialDescription ||
            normalizedRequestFields.material_description,
        storage_location:
            requestFields.storage_location ||
            requestFields.storageLocation ||
            null,
        plant: requestFields.plant || null,
    };

    for (const fieldKey of SINGLE_REQUEST_LONG_TEXT_FIELD_KEYS) {
        if (
            requestFields[fieldKey] !== undefined &&
            requestFields[fieldKey] !== null
        ) {
            normalized[fieldKey] = requestFields[fieldKey];
        }
    }

    if (
        requestFields.base_unit_of_measure !== undefined &&
        requestFields.base_unit_of_measure !== null
    ) {
        normalized.base_unit_of_measure = requestFields.base_unit_of_measure;
    }

    if (
        requestFields.base_uom !== undefined &&
        requestFields.base_uom !== null &&
        normalized.base_unit_of_measure === undefined
    ) {
        normalized.base_unit_of_measure = requestFields.base_uom;
    }

    return normalized;
};

const normalizeSingleRequestTemplatePayload = payload => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }

    const normalized = { ...payload };

    if (
        normalized.requestFields &&
        typeof normalized.requestFields === "object" &&
        !Array.isArray(normalized.requestFields)
    ) {
        normalized.requestFields = normalizeSingleRequestRequestFields(
            normalized.requestFields
        );
    }

    if (
        normalized.templateValues &&
        typeof normalized.templateValues === "object" &&
        !Array.isArray(normalized.templateValues)
    ) {
        normalized.templateValues = {
            ...normalized.templateValues,
        };
    }

    return normalized;
};

const readSingleRequestTemplateRequestFields = payload => {
    const normalizedPayload = normalizeSingleRequestTemplatePayload(payload);
    return normalizeSingleRequestRequestFields(
        normalizedPayload.requestFields || {}
    );
};

const resolveSingleRequestMaterialCode = source => {
    if (!source || typeof source !== "object") {
        return null;
    }

    const directMaterialCode = String(
        source.material_code ?? source.materialCode ?? ""
    ).trim();

    if (directMaterialCode) {
        return directMaterialCode;
    }

    const requestFields = readSingleRequestTemplateRequestFields(
        source.template_payload ?? source.templatePayload ?? source
    );
    const payloadMaterialCode = String(
        requestFields.material_number ??
            requestFields.material_code ??
            requestFields.materialCode ??
            ""
    ).trim();

    return payloadMaterialCode || null;
};

const SINGLE_REQUEST_MAX_ATTACHMENTS = 3;
const SINGLE_REQUEST_PUBLIC_DIRECTORY = path.join(
    path.resolve(),
    "backend",
    "public"
);
const SINGLE_REQUEST_ATTACHMENT_ROOT = path.posix.join(
    "attachments",
    "single-request"
);
const MASS_REQUEST_PUBLIC_DIRECTORY = path.join(
    path.resolve(),
    "backend",
    "public"
);
const MASS_REQUEST_ATTACHMENT_ROOT = path.posix.join(
    "attachments",
    "mass-request"
);
const LEGACY_SINGLE_REQUEST_ATTACHMENT_ROOT = "single-request-attachments";
const LEGACY_MASS_REQUEST_ATTACHMENT_ROOT = "mass-request-attachments";
const formatAttachmentDateSegment = (date = new Date()) => {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
};
const buildSingleRequestRelativePath = ({
    requestNo,
    requestId,
    newName,
    createdAt = new Date(),
}) =>
    path.posix.join(
        SINGLE_REQUEST_ATTACHMENT_ROOT,
        formatAttachmentDateSegment(createdAt),
        String(requestNo ?? requestId),
        String(newName)
    );
const buildMassRequestRelativePath = ({
    requestNo,
    requestId,
    itemId,
    newName,
    createdAt = new Date(),
}) =>
    requestNo
        ? path.posix.join(
              MASS_REQUEST_ATTACHMENT_ROOT,
              formatAttachmentDateSegment(createdAt),
              String(requestNo),
              String(newName)
          )
        : path.posix.join(
              MASS_REQUEST_ATTACHMENT_ROOT,
              formatAttachmentDateSegment(createdAt),
              String(requestId),
              String(itemId),
              String(newName)
          );
const SINGLE_REQUEST_SQL_NOW_EXPRESSION = Object.freeze({ __sql: "NOW()" });
const SINGLE_REQUEST_MATERIAL_CODE_SQL = `NULLIF(COALESCE(
            r.template_payload #>> '{requestFields,material_number}',
            r.template_payload #>> '{requestFields,material_code}',
            r.template_payload #>> '{requestFields,materialCode}',
            ''
        ), '')`;
const isRawSqlExpression = value =>
    Boolean(
        value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.__sql === "NOW()"
    );
const normalizeSingleRequestAttachmentRelativePath = relativePath => {
    const normalized = path.posix
        .normalize(
            `/${String(relativePath || "")
                .replace(/\\/g, "/")
                .replace(/^\/+/, "")}`
        )
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");

    const isLegacy = normalized.startsWith(
        `${LEGACY_SINGLE_REQUEST_ATTACHMENT_ROOT}/`
    );
    const isNew = normalized.startsWith(`${SINGLE_REQUEST_ATTACHMENT_ROOT}/`);
    if ((!isLegacy && !isNew) || normalized.includes("../")) {
        throw buildSingleRequestApprovalError(
            "Invalid single request attachment path",
            400,
            "SINGLE_REQUEST_ATTACHMENT_INVALID_PATH"
        );
    }

    return normalized;
};
const normalizeMassRequestAttachmentRelativePath = relativePath => {
    const normalized = path.posix
        .normalize(
            `/${String(relativePath || "")
                .replace(/\\/g, "/")
                .replace(/^\/+/, "")}`
        )
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");

    const isLegacy = normalized.startsWith(
        `${LEGACY_MASS_REQUEST_ATTACHMENT_ROOT}/`
    );
    const isNew = normalized.startsWith(`${MASS_REQUEST_ATTACHMENT_ROOT}/`);
    if ((!isLegacy && !isNew) || normalized.includes("../")) {
        throw buildSingleRequestApprovalError(
            "Invalid mass request attachment path",
            400,
            "MASS_REQUEST_ATTACHMENT_INVALID_PATH"
        );
    }

    return normalized;
};

const assertSingleRequestAttachmentUpload = attachment => {
    const tempPath = String(attachment?.tempPath || "").trim();
    const fileName =
        attachment?.file_name ??
        attachment?.originalName ??
        attachment?.name ??
        null;
    const fileType =
        attachment?.file_type ??
        attachment?.mimeType ??
        attachment?.type ??
        null;
    const relativePath = normalizeSingleRequestAttachmentRelativePath(
        attachment?.file_path ??
            attachment?.relativePath ??
            attachment?.path ??
            null
    );
    if (!tempPath) {
        throw buildSingleRequestApprovalError(
            "Invalid single request attachment upload",
            400,
            "SINGLE_REQUEST_ATTACHMENT_INVALID_UPLOAD"
        );
    }

    return {
        tempPath,
        fileName,
        fileType,
        relativePath,
    };
};

const LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY = `SELECT
            r.id AS request_id,
            r.request_no,
            r.assigned_to,
            r.created_by,
            r.created_at,
            r.status,
            r.ticket_type,
            ${SINGLE_REQUEST_MATERIAL_CODE_SQL} AS material_code,
            r.final_code,
            r.change_extend_reason,
            mig.code AS material_group_code,
            mis.code AS material_sub_group_code,
            r.created_by AS requester_user_id,
            r.approval_1_user_id,
            r.approval_1_at,
            r.approval_1_status,
            r.approval_1_remark,
            r.approval_2_user_id,
            r.approval_2_at,
            r.approval_2_status,
            r.approval_2_remark,
            r.approval_3_user_id,
            r.approval_3_at,
            r.approval_3_status,
            r.approval_3_remark,
            r.rework_stage,
            r.rework_by_user_id,
            r.rework_at,
            r.rework_reason,
            r.material_group_id,
            r.material_sub_group_id,
            r.plant_code,
            r.sloc_code,
            r.material_description,
            r.base_uom,
            r.long_text_1,
            r.long_text_2,
            r.long_text_3,
            r.template_payload
        FROM mat_single_request r
        LEFT JOIN mat_item_group mig ON mig.id = r.material_group_id
        LEFT JOIN mat_item_sub_group mis ON mis.id = r.material_sub_group_id
        WHERE r.id = $1
        FOR UPDATE OF r`;

const isSubmittedSingleRequestStatus = status =>
    String(status || "").trim().toUpperCase() === "SUBMIT";

const assertSingleRequestAssignableStatus = snapshot => {
    if (isSubmittedSingleRequestStatus(snapshot?.status)) {
        return;
    }

    throw buildSingleRequestApprovalError(
        "Single request approvers can only be assigned while status is Submit",
        409,
        "SINGLE_REQUEST_APPROVER_ASSIGNMENT_STATUS_CONFLICT"
    );
};

const resolveCreateSingleRequestAssignedTo = ticketType => {
    const normalizedTicketType = normalizeSingleRequestTicketType(ticketType);

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
        return "Approval 3";
    }

    return "Approval 1";
};

const getSingleRequestAllowedApprovalStages = ticketType => {
    const normalizedTicketType = normalizeSingleRequestTicketType(ticketType);

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.CHANGE) {
        return ["Approval 1", "Approval 3"];
    }

    if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
        return ["Approval 3"];
    }

    return ["Approval 1", "Approval 2", "Approval 3"];
};

const shouldPersistSingleRequestEditHistory = ticketType =>
    normalizeSingleRequestTicketType(ticketType) ===
    SINGLE_REQUEST_TICKET_TYPES.CREATE;

const buildSingleRequestFinalApprovalPatch = ({
    stage,
    actorUserId,
    remark,
    finalCode = null,
} = {}) => {
    const fieldPrefix =
        stage === "Approval 1"
            ? "approval_1"
            : stage === "Approval 2"
              ? "approval_2"
              : "approval_3";

    const patch = {
        status: "DONE",
        assigned_to: "Completed",
        [`${fieldPrefix}_user_id`]: actorUserId ?? null,
        [`${fieldPrefix}_at`]: SINGLE_REQUEST_SQL_NOW_EXPRESSION,
        [`${fieldPrefix}_status`]: "APPROVED",
        [`${fieldPrefix}_remark`]: remark ?? null,
    };

    if (finalCode) {
        patch.final_code = finalCode;
    }

    return patch;
};

const buildSingleRequestApproverAssignmentPatch = (payload = {}) => {
    const patch = {};

    if (Object.prototype.hasOwnProperty.call(payload, "approval1UserId")) {
        patch.approval_1_user_id = payload.approval1UserId;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "approval2UserId")) {
        patch.approval_2_user_id = payload.approval2UserId;
    }

    return patch;
};

const getLockedSingleRequestApprovalSnapshot = async (
    client,
    requestId,
    { beforeBackfill } = {}
) => {
    const result = await client.query(
        LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
        [requestId]
    );

    if (result.rows.length === 0) {
        throw buildSingleRequestApprovalError(
            "Single request not found",
            404,
            "SINGLE_REQUEST_NOT_FOUND"
        );
    }

    if (beforeBackfill) {
        beforeBackfill(result.rows[0]);
    }

    return result.rows[0];
};

const updateSingleRequestAssignment = async (client, requestId, assignedTo) => {
    await client.query(
        `UPDATE mat_single_request
        SET assigned_to = $2,
            updated_at = NOW()
        WHERE id = $1`,
        [requestId, assignedTo]
    );
};

const syncSingleRequestApprovalSnapshot = async (
    client,
    requestId,
    approval = {},
    assignedTo
) => {
    await client.query(
        `UPDATE mat_single_request
        SET assigned_to = $2,
            approval_1_user_id = $3,
            approval_1_status = $4,
            approval_1_at = $5,
            approval_1_remark = $6,
            approval_2_user_id = $7,
            approval_2_status = $8,
            approval_2_at = $9,
            approval_2_remark = $10,
            approval_3_user_id = $11,
            approval_3_status = $12,
            approval_3_at = $13,
            approval_3_remark = $14,
            updated_at = NOW()
        WHERE id = $1`,
        [
            requestId,
            assignedTo ?? null,
            approval.approval_1_user_id ?? null,
            approval.approval_1_status ?? null,
            approval.approval_1_at ?? null,
            approval.approval_1_remark ?? null,
            approval.approval_2_user_id ?? null,
            approval.approval_2_status ?? null,
            approval.approval_2_at ?? null,
            approval.approval_2_remark ?? null,
            approval.approval_3_user_id ?? null,
            approval.approval_3_status ?? null,
            approval.approval_3_at ?? null,
            approval.approval_3_remark ?? null,
        ]
        );
};

const updateSingleRequestColumns = async (client, requestId, patch = {}) => {
    const patchFields = Object.keys(patch);

    if (patchFields.length === 0) {
        return;
    }

    const assignments = [];
    const params = [requestId];
    let paramIndex = 2;

    for (const field of patchFields) {
        const value = patch[field];

        if (isRawSqlExpression(value)) {
            assignments.push(`${field} = ${value.__sql}`);
            continue;
        }

        assignments.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex += 1;
    }

    await client.query(
        `UPDATE mat_single_request
        SET ${assignments.join(", ")},
            updated_at = NOW()
        WHERE id = $1`,
        params
    );
};

// =====================================================================
// Dynamic-approver step engine — DB helpers (mat_*_approval_step tables).
// The new approval flow routes EXCLUSIVELY through these step rows; the
// legacy approval_1/2/3_* columns are no longer read or written here.
// =====================================================================

const loadRequesterChain = async (client, requesterUserId) => {
    const result = await client.query(
        `SELECT level, approver_user_id
           FROM mat_approvers_matrix_level
          WHERE requester_user_id = $1
          ORDER BY level`,
        [requesterUserId]
    );

    return result.rows.map(row => ({
        level: row.level,
        approverUserId: row.approver_user_id,
    }));
};

const insertSingleRequestApprovalSteps = async (client, requestId, plan = []) => {
    for (const step of plan) {
        await client.query(
            `INSERT INTO mat_single_request_approval_step (
                request_id,
                level,
                kind,
                approver_user_id,
                status,
                created_at,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [
                requestId,
                step.level,
                step.kind,
                step.approverUserId ?? null,
                step.status ?? "WAITING",
            ]
        );
    }
};

const loadSingleRequestSteps = async (
    client,
    requestId,
    { forUpdate = false } = {}
) => {
    const result = await client.query(
        `SELECT
            s.id,
            s.request_id,
            s.level,
            s.kind,
            s.approver_user_id,
            s.claimed_at,
            s.status,
            s.acted_at,
            s.remark,
            COALESCE(au.fullname, au.username, s.approver_user_id) AS approver_name
         FROM mat_single_request_approval_step s
         LEFT JOIN mst_user au ON au.user_id = s.approver_user_id
         WHERE s.request_id = $1
         ORDER BY s.level${forUpdate ? "\n         FOR UPDATE OF s" : ""}`,
        [requestId]
    );

    return result.rows;
};

const updateSingleRequestStepRow = async (client, stepId, patch = {}) => {
    const assignments = [];
    const params = [stepId];
    let paramIndex = 2;

    for (const field of Object.keys(patch)) {
        const value = patch[field];

        if (isRawSqlExpression(value)) {
            assignments.push(`${field} = ${value.__sql}`);
            continue;
        }

        assignments.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex += 1;
    }

    if (assignments.length === 0) {
        return;
    }

    await client.query(
        `UPDATE mat_single_request_approval_step
         SET ${assignments.join(", ")},
             updated_at = NOW()
         WHERE id = $1`,
        params
    );
};

// Atomic single-winner grab of the open MDM step. Returns true iff this actor
// won the claim (i.e. the step was still unclaimed and got assigned to them).
const claimMdmSingleRequestStep = async (client, stepId, actorUserId) => {
    const result = await client.query(
        `UPDATE mat_single_request_approval_step
         SET approver_user_id = $2,
             claimed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND kind = 'MDM'
           AND approver_user_id IS NULL
         RETURNING id`,
        [stepId, actorUserId]
    );

    return result.rowCount === 1;
};

// --- Mass-item step helpers (mat_mass_request_item_approval_step) ---------

const insertMassItemApprovalSteps = async (client, itemId, plan = []) => {
    for (const step of plan) {
        await client.query(
            `INSERT INTO mat_mass_request_item_approval_step (
                item_id,
                level,
                kind,
                approver_user_id,
                status,
                created_at,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [
                itemId,
                step.level,
                step.kind,
                step.approverUserId ?? null,
                step.status ?? "WAITING",
            ]
        );
    }
};

// Load the step rows for the FIRST item of a batch (all items share the plan).
const loadMassItemSteps = async (
    client,
    massRequestId,
    { forUpdate = false } = {}
) => {
    const result = await client.query(
        `SELECT
            s.id,
            s.item_id,
            s.level,
            s.kind,
            s.approver_user_id,
            s.claimed_at,
            s.status,
            s.acted_at,
            s.remark,
            COALESCE(au.fullname, au.username, s.approver_user_id) AS approver_name
         FROM mat_mass_request_item_approval_step s
         JOIN mat_mass_request_item i ON i.id = s.item_id
         LEFT JOIN mst_user au ON au.user_id = s.approver_user_id
         WHERE i.mass_request_id = $1
           AND i.item_no = (
               SELECT MIN(ii.item_no)
               FROM mat_mass_request_item ii
               WHERE ii.mass_request_id = $1
           )
         ORDER BY s.level${forUpdate ? "\n         FOR UPDATE OF s" : ""}`,
        [massRequestId]
    );

    return result.rows;
};

// Apply a step-status patch to the matching LEVEL step row of EVERY item in a
// batch. Patch values may include raw-SQL sentinels (e.g. NOW()).
const updateMassItemStepRowsByLevel = async (
    client,
    massRequestId,
    level,
    patch = {}
) => {
    const assignments = [];
    const params = [massRequestId, level];
    let paramIndex = 3;

    for (const field of Object.keys(patch)) {
        const value = patch[field];

        if (isRawSqlExpression(value)) {
            assignments.push(`${field} = ${value.__sql}`);
            continue;
        }

        assignments.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex += 1;
    }

    if (assignments.length === 0) {
        return;
    }

    await client.query(
        `UPDATE mat_mass_request_item_approval_step s
         SET ${assignments.join(", ")},
             updated_at = NOW()
         FROM mat_mass_request_item i
         WHERE s.item_id = i.id
           AND i.mass_request_id = $1
           AND s.level = $2`,
        params
    );
};

// Atomic single-winner grab of the open MDM step across ALL items of a batch.
// Only succeeds when none of the batch's MDM steps have been claimed yet.
const claimMdmMassItemStep = async (client, massRequestId, level, actorUserId) => {
    const result = await client.query(
        `UPDATE mat_mass_request_item_approval_step s
         SET approver_user_id = $3,
             claimed_at = NOW(),
             updated_at = NOW()
         FROM mat_mass_request_item i
         WHERE s.item_id = i.id
           AND i.mass_request_id = $1
           AND s.level = $2
           AND s.kind = 'MDM'
           AND s.approver_user_id IS NULL
         RETURNING s.id`,
        [massRequestId, level, actorUserId]
    );

    return result.rowCount > 0;
};

const getSingleRequestAttachments = async (client, requestId) => {
    const result = await client.query(
        `SELECT id, file_name, file_path, file_type
         FROM mat_single_request_attachment
         WHERE request_id = $1
         ORDER BY id`,
        [requestId]
    );

    return result.rows;
};

const insertSingleRequestAttachment = async (
    client,
    requestId,
    requestNo,
    attachment,
    createdAt = new Date()
) => {
    const newName =
        attachment.new_name ??
        attachment.newName ??
        (() => {
            throw buildSingleRequestApprovalError(
                "Invalid single request attachment upload",
                400,
                "SINGLE_REQUEST_ATTACHMENT_INVALID_UPLOAD"
            );
        })();
    const safeRelativePath = buildSingleRequestRelativePath({
        requestNo,
        requestId,
        newName,
        createdAt,
    });
    await client.query(
        `INSERT INTO mat_single_request_attachment (
            request_id,
            file_name,
            file_path,
            file_type,
            created_at
        ) VALUES ($1, $2, $3, $4, NOW())`,
        [
            requestId,
            attachment.file_name ??
                attachment.originalName ??
                attachment.name ??
                null,
            safeRelativePath,
            attachment.file_type ??
                attachment.mimeType ??
                attachment.type ??
            null,
        ]
    );
};

const persistSingleRequestAttachmentFiles = (
    requestId,
    requestNo,
    attachments,
    createdAt = new Date()
) => {
    const savedFiles = [];

    for (const attachment of attachments) {
        const newName = attachment.new_name ?? attachment.newName;
        if (!newName) {
            throw buildSingleRequestApprovalError(
                "Invalid single request attachment upload",
                400,
                "SINGLE_REQUEST_ATTACHMENT_INVALID_UPLOAD"
            );
        }
        const safeRelativePath = normalizeSingleRequestAttachmentRelativePath(
            buildSingleRequestRelativePath({
                requestNo,
                requestId,
                newName,
                createdAt,
            })
        );
        const finalPath = path.join(
            SINGLE_REQUEST_PUBLIC_DIRECTORY,
            safeRelativePath
        );
        const finalDir = path.dirname(finalPath);

        if (!fs.existsSync(finalDir)) {
            fs.mkdirSync(finalDir, { recursive: true });
        }

        const rawData = fs.readFileSync(attachment.tempPath);
        fs.writeFileSync(finalPath, rawData);
        savedFiles.push(finalPath);
    }
    return savedFiles;
};

const deleteSingleRequestStoredFiles = filepaths => {
    for (const filepath of filepaths) {
        if (!filepath) {
            continue;
        }

        const absolutePath = path.join(
            SINGLE_REQUEST_PUBLIC_DIRECTORY,
            normalizeSingleRequestAttachmentRelativePath(filepath)
        );

        try {
            if (fs.existsSync(absolutePath)) {
                fs.unlinkSync(absolutePath);
            }
        } catch (error) {
            console.error(
                `Failed to delete single request attachment file ${filepath}:`,
                error
            );
        }
    }
};

const prepareSingleRequestApprovalEditPatch = async ({
    snapshot = {},
    editedRequest = {},
    allowMaterialGroupChange = false,
    getSubGroupById,
    validateMaterialRequestTemplate,
} = {}) => {
    editedRequest = normalizeSingleRequestEditedRequest(editedRequest);
    const ticketType = normalizeSingleRequestTicketType(snapshot.ticket_type);
    const lockedMaterialCode = resolveSingleRequestMaterialCode(snapshot);
    const lockedChangeExtendReason = snapshot.change_extend_reason ?? null;
    const editableFields = resolveSingleRequestEditableFields({
        ticketType,
        allowMaterialGroupChange,
    });
    const editablePatch = editableFields.reduce(
        (patch, field) => {
            if (
                !editedRequest ||
                typeof editedRequest !== "object" ||
                !Object.prototype.hasOwnProperty.call(editedRequest, field)
            ) {
                return patch;
            }

            const nextValue = editedRequest[field] ?? null;
            const currentValue = snapshot[field] ?? null;

            if (
                normalizeSingleRequestEditableValue(field, currentValue) !==
                normalizeSingleRequestEditableValue(field, nextValue)
            ) {
                patch[field] = nextValue;
            }

            return patch;
        },
        {}
    );

    let selectedMaterialGroupId = snapshot.material_group_id;
    let selectedMaterialGroupCode = snapshot.material_group_code;

    if (
        allowMaterialGroupChange &&
        Object.prototype.hasOwnProperty.call(editablePatch, "material_group_id")
    ) {
        const materialGroupId = Number.parseInt(
            editablePatch.material_group_id,
            10
        );

        if (!Number.isInteger(materialGroupId)) {
            throw buildSingleRequestApprovalError(
                "Material group is required",
                400,
                "SINGLE_REQUEST_EDIT_INVALID_GROUP"
            );
        }

        selectedMaterialGroupId = materialGroupId;

        if (materialGroupId === Number(snapshot.material_group_id)) {
            selectedMaterialGroupCode = snapshot.material_group_code;
        } else {
            selectedMaterialGroupCode =
                String(editedRequest.material_group_code || "").trim() || null;
        }

        if (!selectedMaterialGroupCode) {
            throw buildSingleRequestApprovalError(
                "Material group is required",
                400,
                "SINGLE_REQUEST_EDIT_GROUP_CODE_MISSING"
            );
        }

        editablePatch.material_group_id = materialGroupId;
    }

    if (Object.keys(editablePatch).length === 0) {
        return {};
    }

    if (ticketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
        if (
            lockedChangeExtendReason != null &&
            !Object.prototype.hasOwnProperty.call(
                editablePatch,
                "change_extend_reason"
            )
        ) {
            editablePatch.change_extend_reason = lockedChangeExtendReason;
            delete editablePatch.change_extend_reason;
        }
        if (
            lockedMaterialCode &&
            Object.prototype.hasOwnProperty.call(editedRequest, "material_code")
        ) {
            editablePatch.material_code = lockedMaterialCode;
            delete editablePatch.material_code;
        }
        return editablePatch;
    }

    if (
        Object.prototype.hasOwnProperty.call(
            editablePatch,
            "material_sub_group_id"
        )
    ) {
        const materialSubGroupId = Number.parseInt(
            editablePatch.material_sub_group_id,
            10
        );

        if (!Number.isInteger(materialSubGroupId)) {
            throw buildSingleRequestApprovalError(
                "Sub material group is required",
                400,
                "SINGLE_REQUEST_EDIT_INVALID_SUBGROUP"
            );
        }

        const subgroup = await getSubGroupById(materialSubGroupId);

        if (!subgroup || subgroup.deleted_at) {
            throw buildSingleRequestApprovalError(
                "Sub material group not found",
                404,
                "SINGLE_REQUEST_EDIT_SUBGROUP_NOT_FOUND"
            );
        }

        if (Number(subgroup.item_group_id) !== Number(selectedMaterialGroupId)) {
            throw buildSingleRequestApprovalError(
                "Sub material group does not belong to the selected material group",
                400,
                "SINGLE_REQUEST_EDIT_SUBGROUP_GROUP_MISMATCH"
            );
        }

        editablePatch.material_sub_group_id = materialSubGroupId;
    }

    const needsTemplateValidation = [
        "material_description",
        "base_uom",
        "template_payload",
        ...(ticketType === SINGLE_REQUEST_TICKET_TYPES.CREATE
            ? ["plant_code", "sloc_code"]
            : []),
        "long_text_1",
        "long_text_2",
        "long_text_3",
        "material_group_id",
    ].some(field => Object.prototype.hasOwnProperty.call(editablePatch, field));

    if (!needsTemplateValidation) {
        return editablePatch;
    }

    const currentTemplatePayload = normalizeSingleRequestTemplatePayload(
        snapshot.template_payload
    );
    const currentRequestFields = readSingleRequestTemplateRequestFields(
        currentTemplatePayload
    );
    const mergedTemplatePayload = Object.prototype.hasOwnProperty.call(
        editablePatch,
        "template_payload"
    )
        ? normalizeSingleRequestTemplatePayload(editablePatch.template_payload)
        : currentTemplatePayload;
    const requestFields = normalizeSingleRequestRequestFields({
        ...currentRequestFields,
        material_number:
            currentRequestFields.material_number ?? lockedMaterialCode,
        material_group:
            currentRequestFields.material_group ?? selectedMaterialGroupCode,
        material_description:
            editablePatch.material_description ?? snapshot.material_description,
        base_uom: editablePatch.base_uom ?? snapshot.base_uom,
        base_unit_of_measure: editablePatch.base_uom ?? snapshot.base_uom,
        long_text_1: editablePatch.long_text_1 ?? snapshot.long_text_1,
        long_text_2: editablePatch.long_text_2 ?? snapshot.long_text_2,
        long_text_3: editablePatch.long_text_3 ?? snapshot.long_text_3,
        plant: editablePatch.plant_code ?? snapshot.plant_code,
        storage_location: editablePatch.sloc_code ?? snapshot.sloc_code,
    });
    const validation = await validateMaterialRequestTemplate({
        materialGroupCode: selectedMaterialGroupCode,
        requestFields,
        templateValues: mergedTemplatePayload.templateValues || {},
    });
    const validationErrors = (validation.errors || []).filter(
        error => isSingleRequestApprovalEditValidationErrorVisible(error, validation, ticketType)
    );

    if (validationErrors.length > 0) {
        const error = buildSingleRequestApprovalError(
            "Material request validation failed",
            400,
            "SINGLE_REQUEST_EDIT_VALIDATION_FAILED"
        );
        error.errors = validationErrors;
        throw error;
    }

    const normalizedRequestFields = buildNormalizedApprovalEditRequestFields({
        requestFields,
        validation,
    });
    const normalizedBaseUom =
        normalizedRequestFields.base_unit_of_measure ??
        normalizedRequestFields.base_uom;

    if (
        !normalizedRequestFields.material_description ||
        !normalizedBaseUom
    ) {
        throw buildSingleRequestApprovalError(
            "Material description and Base UoM are required",
            400,
            "SINGLE_REQUEST_EDIT_REQUIRED_FIELDS_MISSING"
        );
    }

    editablePatch.material_description =
        normalizedRequestFields.material_description;
    editablePatch.base_uom = normalizedBaseUom;

    if (Object.prototype.hasOwnProperty.call(editablePatch, "template_payload")) {
        editablePatch.template_payload = {
            ...mergedTemplatePayload,
            requestFields: normalizedRequestFields,
            templateValues:
                validation.normalizedTemplateValues ||
                mergedTemplatePayload.templateValues ||
                {},
        };
    }

    return Object.entries(editablePatch).reduce((patch, [field, value]) => {
        if (
            normalizeSingleRequestEditableValue(field, snapshot[field] ?? null) !==
            normalizeSingleRequestEditableValue(field, value)
        ) {
            patch[field] = value;
        }

        return patch;
    }, {});
};

const queryUsersWithPageAccessByIds = async (client, userIds) => {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    if (uniqueUserIds.length === 0) {
        return {};
    }

    const result = await client.query(
        `SELECT
            mu.user_id,
            mu.fullname,
            mu.username,
            mu.email,
            mu.is_active,
            MIN(mpa.user_group_name) AS user_group_name,
            ARRAY_AGG(DISTINCT mpa.user_group_name)
                FILTER (WHERE mpa.user_group_name IS NOT NULL) AS group_names
        FROM mst_user mu
        LEFT JOIN mst_page_access mpa
            ON mpa.user_group_id = mu.user_group
        WHERE mu.user_id = ANY($1)
        GROUP BY
            mu.user_id,
            mu.fullname,
            mu.username,
            mu.email,
            mu.is_active`,
        [uniqueUserIds]
    );

    return result.rows.reduce((usersById, user) => {
        usersById[user.user_id] = user;
        return usersById;
    }, {});
};

const queryActiveMdmMaterialUsers = async client => {
    const result = await client.query(
        `SELECT
            mu.user_id,
            mu.fullname,
            mu.username,
            mu.email,
            mu.is_active,
            mpa.user_group_name,
            ARRAY[$1] AS group_names
        FROM mst_user mu
        JOIN mst_page_access mpa
            ON mpa.user_group_id = mu.user_group
        WHERE mpa.user_group_name = $1
            AND mu.is_active = true
        ORDER BY mu.user_id`,
        [MDM_MATERIAL_GROUP_NAME]
    );

    return result.rows;
};

const getRandomMdmMaterialUser = async client => {
    const result = await client.query(
        `SELECT
            mu.user_id,
            mu.fullname,
            mu.username,
            mu.email
        FROM mst_user mu
        JOIN mst_page_access mpa
            ON mpa.user_group_id = mu.user_group
        WHERE mpa.user_group_name = $1
            AND mu.is_active = true
        ORDER BY random()
        LIMIT 1`,
        [MDM_MATERIAL_GROUP_NAME]
    );

    return result.rows[0] || null;
};

const isActorMdmMaterialUser = async (client, actorUserId) => {
    if (!actorUserId) {
        return false;
    }
    const result = await client.query(
        `SELECT 1
         FROM mst_user mu
         JOIN mst_page_access mpa
           ON mpa.user_group_id = mu.user_group
         WHERE mu.user_id = $1
           AND mpa.user_group_name = $2
           AND mu.is_active = true`,
        [actorUserId, MDM_MATERIAL_GROUP_NAME]
    );
    return result.rowCount > 0;
};

// =====================================================================
// Dynamic-approver step engine — shared SQL fragments.
// Each request/item exposes its step rows as a `approval_steps` jsonb
// array (ordered by level, snake-cased to match buildStepsPayload), and
// `active_step` jsonb (lowest-level row not yet APPROVED). JS layers map
// these through the approvalSteps helpers for payloads + visibility.
// =====================================================================

// LATERAL block (single request): aggregate this request's step rows.
// `<alias>` is the table alias for mat_single_request (e.g. `r`).
const buildSingleRequestStepLateral = (alias = "r") => `LEFT JOIN LATERAL (
                        SELECT
                            COALESCE(
                                jsonb_agg(
                                    jsonb_build_object(
                                        'level', s.level,
                                        'kind', s.kind,
                                        'approver_user_id', s.approver_user_id,
                                        'approver_name', COALESCE(sau.fullname, sau.username, s.approver_user_id),
                                        'status', s.status,
                                        'claimed_at', s.claimed_at,
                                        'acted_at', s.acted_at,
                                        'remark', s.remark
                                    )
                                    ORDER BY s.level
                                ) FILTER (WHERE s.id IS NOT NULL),
                                '[]'::jsonb
                            ) AS approval_steps,
                            (
                                SELECT to_jsonb(active.*)
                                FROM (
                                    SELECT
                                        a.level,
                                        a.kind,
                                        a.approver_user_id,
                                        a.status
                                    FROM mat_single_request_approval_step a
                                    WHERE a.request_id = ${alias}.id
                                      AND UPPER(COALESCE(a.status, 'WAITING')) <> 'APPROVED'
                                    ORDER BY a.level
                                    LIMIT 1
                                ) active
                            ) AS active_step
                        FROM mat_single_request_approval_step s
                        LEFT JOIN mst_user sau ON sau.user_id = s.approver_user_id
                        WHERE s.request_id = ${alias}.id
                    ) step_rows ON TRUE`;

const SINGLE_REQUEST_STEP_SELECT_FIELDS = `COALESCE(step_rows.approval_steps, '[]'::jsonb) AS approval_steps,
                        step_rows.active_step`;

const SINGLE_REQUEST_REWORK_SELECT_FIELDS = `r.rework_stage,
                        r.rework_by_user_id,
                        TO_CHAR(r.rework_at, 'YYYY-MM-DD HH24:MI') AS rework_at,
                        rework_by.username AS rework_by_username,
                        r.rework_reason`;

const SINGLE_REQUEST_LEGACY_REWORK_SELECT_FIELDS = `NULL::varchar AS rework_stage,
                        NULL::varchar AS rework_by_user_id,
                        NULL::text AS rework_at,
                        NULL::varchar AS rework_by_username,
                        NULL::text AS rework_reason`;

const buildSingleRequestSelectFields = ({
    includeReworkFields = true,
} = {}) => `r.id,
                          r.request_no AS ticket_number,
                          r.ticket_type,
                          ${SINGLE_REQUEST_MATERIAL_CODE_SQL} AS material_code,
                          r.final_code,
                          r.change_extend_reason,
                          r.material_group_id,
                          mig.code AS material_group_code,
                          mig.name AS material_group_name,
                          r.material_sub_group_id,
                        mis.code AS material_sub_group_code,
                        mis.name AS material_sub_group_name,
                        r.plant_code,
                        r.sloc_code,
                        r.material_description,
                        r.base_uom AS uom,
                        r.long_text_1,
                        r.long_text_2,
                        r.long_text_3,
                        r.template_payload,
                        r.status,
                        r.created_by AS requester_user_id,
                        ${SINGLE_REQUEST_STEP_SELECT_FIELDS},
                          ${
                              includeReworkFields
                                  ? SINGLE_REQUEST_REWORK_SELECT_FIELDS
                                  : SINGLE_REQUEST_LEGACY_REWORK_SELECT_FIELDS
                          },
                          COALESCE(u.username, r.created_by) AS created_by,
                          TO_CHAR(r.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
                          r.assigned_to,
                        COALESCE(
                            jsonb_agg(
                                jsonb_build_object(
                                    'id', att.id,
                                    'file_name', att.file_name,
                                    'file_path', att.file_path,
                                    'file_type', att.file_type
                                )
                                ORDER BY att.id
                            ) FILTER (WHERE att.id IS NOT NULL),
                            '[]'::jsonb
                        ) AS attachments`;

const SINGLE_REQUEST_GROUP_BY = `r.id,
                          mig.code,
                          mig.name,
                          mis.code,
                          mis.name,
                          u.username,
                          step_rows.approval_steps,
                          step_rows.active_step`;

const buildSingleRequestListQuery = (
    whereClause,
    { includeReworkFields = true } = {}
) => `SELECT
                        ${buildSingleRequestSelectFields({ includeReworkFields })}
                      FROM mat_single_request r
                      LEFT JOIN mst_user u ON u.user_id = r.created_by
                      ${buildSingleRequestStepLateral("r")}
                      ${
                          includeReworkFields
                              ? "LEFT JOIN mst_user rework_by ON rework_by.user_id = r.rework_by_user_id"
                              : ""
                      }
                      LEFT JOIN mat_item_group mig ON mig.id = r.material_group_id
                      LEFT JOIN mat_item_sub_group mis ON mis.id = r.material_sub_group_id
                      LEFT JOIN mat_single_request_attachment att ON att.request_id = r.id
                    WHERE ${whereClause}
                    GROUP BY
                        ${SINGLE_REQUEST_GROUP_BY}
                        ${includeReworkFields ? ",\n                          rework_by.username" : ""}
                    ORDER BY r.created_at DESC, r.id DESC`;

const buildSingleRequestApprovalInboxQuery = ({
    includeEditHistory = true,
    includeReworkFields = true,
} = {}) => `SELECT
                        r.id,
                        r.request_no AS ticket_number,
                        r.ticket_type,
                        ${SINGLE_REQUEST_MATERIAL_CODE_SQL} AS material_code,
                        r.final_code,
                        r.change_extend_reason,
                        r.material_group_id,
                        mig.code AS material_group_code,
                        mig.name AS material_group_name,
                        r.material_sub_group_id,
                        mis.code AS material_sub_group_code,
                        mis.name AS material_sub_group_name,
                        r.plant_code,
                        r.sloc_code,
                        r.material_description,
                        r.base_uom AS uom,
                        r.long_text_1,
                        r.long_text_2,
                        r.long_text_3,
                        r.template_payload,
                        r.status,
                        r.created_by AS requester_user_id,
                        COALESCE(u.username, r.created_by) AS created_by,
                        TO_CHAR(r.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
                        r.assigned_to,
                        ${SINGLE_REQUEST_STEP_SELECT_FIELDS},
                          ${
                              includeReworkFields
                                  ? SINGLE_REQUEST_REWORK_SELECT_FIELDS
                                  : SINGLE_REQUEST_LEGACY_REWORK_SELECT_FIELDS
                          },
                          ${
                              includeEditHistory
                                  ? "COALESCE(edit_history_rows.edit_history, '[]'::jsonb) AS edit_history"
                                : "'[]'::jsonb AS edit_history"
                          },
                          COALESCE(attachment_rows.attachments, '[]'::jsonb) AS attachments
                      FROM mat_single_request r
                      LEFT JOIN mat_item_group mig ON mig.id = r.material_group_id
                      LEFT JOIN mat_item_sub_group mis ON mis.id = r.material_sub_group_id
                      LEFT JOIN mst_user u ON u.user_id = r.created_by
                      ${buildSingleRequestStepLateral("r")}
                      ${
                          includeReworkFields
                              ? "LEFT JOIN mst_user rework_by ON rework_by.user_id = r.rework_by_user_id"
                              : ""
                      }
                      ${
                        includeEditHistory
                            ? `LEFT JOIN LATERAL (
                        SELECT
                            jsonb_agg(
                                jsonb_build_object(
                                    'id', eh.id,
                                    'request_id', eh.request_id,
                                    'request_no', eh.request_no,
                                    'approval_stage', eh.approval_stage,
                                    'approved_by_user_id', eh.approved_by_user_id,
                                    'approved_by_username', COALESCE(au.username, eh.approved_by_user_id),
                                    'approve_remark', eh.approve_remark,
                                    'approved_at', eh.approved_at,
                                    'material_group_id', eh.material_group_id,
                                    'material_sub_group_id', eh.material_sub_group_id,
                                    'plant_code', eh.plant_code,
                                    'sloc_code', eh.sloc_code,
                                    'material_description', eh.material_description,
                                    'base_uom', eh.base_uom,
                                    'long_text_1', eh.long_text_1,
                                    'long_text_2', eh.long_text_2,
                                    'long_text_3', eh.long_text_3,
                                    'template_payload', eh.template_payload,
                                    'created_by', eh.created_by,
                                    'created_at', eh.created_at
                                )
                                ORDER BY eh.approved_at DESC
                            ) AS edit_history
                        FROM mat_single_request_edit_history eh
                        LEFT JOIN mst_user au ON au.user_id = eh.approved_by_user_id
                        WHERE eh.request_id = r.id
                    ) edit_history_rows ON TRUE`
                            : ""
                    }
                    LEFT JOIN LATERAL (
                        SELECT
                            COALESCE(
                                jsonb_agg(
                                    jsonb_build_object(
                                        'id', att.id,
                                        'file_name', att.file_name,
                                        'file_path', att.file_path,
                                        'file_type', att.file_type
                                    )
                                    ORDER BY att.id
                                ) FILTER (WHERE att.id IS NOT NULL),
                                '[]'::jsonb
                            ) AS attachments
                        FROM mat_single_request_attachment att
                        WHERE att.request_id = r.id
                    ) attachment_rows ON TRUE
                    WHERE (
                        step_rows.active_step IS NOT NULL
                        OR UPPER(COALESCE(r.status, '')) IN ('DONE', 'REWORK', 'REJECT', 'REJECTED', 'CANCEL')
                    )
                    ORDER BY r.created_at DESC, r.id DESC`;

const GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY =
    buildSingleRequestApprovalInboxQuery();
const GET_SINGLE_REQUEST_APPROVAL_INBOX_LEGACY_QUERY =
    buildSingleRequestApprovalInboxQuery({ includeEditHistory: false });
const GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY = buildSingleRequestListQuery(
    "r.created_by = $1",
    { includeReworkFields: false }
);
const GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY =
    buildSingleRequestApprovalInboxQuery({ includeReworkFields: false });
const GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_LEGACY_QUERY =
    buildSingleRequestApprovalInboxQuery({
        includeEditHistory: false,
        includeReworkFields: false,
    });
// LATERAL block (mass request): aggregate the FIRST item's step rows (all
// items of a batch share the same plan) into `approval_steps` jsonb plus the
// `active_step` jsonb (lowest-level row not yet APPROVED). `m` is the alias for
// mat_mass_request. Exposes `first_item.id`/status/assigned_to alongside.
const MASS_REQUEST_FIRST_ITEM_STEP_LATERAL = `LEFT JOIN LATERAL (
    SELECT
        i.id AS first_item_id,
        i.material_description AS first_item_material_description,
        i.base_uom AS first_item_uom,
        i.status AS first_item_status,
        i.assigned_to AS first_item_assigned_to,
        COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'level', s.level,
                        'kind', s.kind,
                        'approver_user_id', s.approver_user_id,
                        'approver_name', COALESCE(sau.fullname, sau.username, s.approver_user_id),
                        'status', s.status,
                        'claimed_at', s.claimed_at,
                        'acted_at', s.acted_at,
                        'remark', s.remark
                    )
                    ORDER BY s.level
                )
                FROM mat_mass_request_item_approval_step s
                LEFT JOIN mst_user sau ON sau.user_id = s.approver_user_id
                WHERE s.item_id = i.id
            ),
            '[]'::jsonb
        ) AS approval_steps,
        (
            SELECT to_jsonb(active.*)
            FROM (
                SELECT a.level, a.kind, a.approver_user_id, a.status
                FROM mat_mass_request_item_approval_step a
                WHERE a.item_id = i.id
                  AND UPPER(COALESCE(a.status, 'WAITING')) <> 'APPROVED'
                ORDER BY a.level
                LIMIT 1
            ) active
        ) AS active_step
    FROM mat_mass_request_item i
    WHERE i.mass_request_id = m.id
    ORDER BY i.item_no ASC
    LIMIT 1
) first_item ON TRUE`;

const GET_MASS_REQUESTS_BY_USER_QUERY = `SELECT
    m.id,
    m.mass_request_no,
    m.item_count,
    m.mass_request_reason,
    m.created_by,
    m.created_by_username,
    TO_CHAR(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
    first_item.first_item_material_description,
    first_item.first_item_uom AS first_item_uom,
    first_item.first_item_status,
    first_item.first_item_assigned_to,
    COALESCE(first_item.approval_steps, '[]'::jsonb) AS approval_steps,
    first_item.active_step
FROM mat_mass_request m
${MASS_REQUEST_FIRST_ITEM_STEP_LATERAL}
WHERE m.created_by = $1
ORDER BY m.created_at DESC, m.id DESC`;

const GET_MASS_REQUEST_APPROVAL_INBOX_QUERY = `SELECT
    m.id,
    m.mass_request_no,
    m.item_count,
    m.mass_request_reason,
    m.created_by,
    m.created_by_username,
    TO_CHAR(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
    first_item.first_item_status,
    first_item.first_item_assigned_to,
    COALESCE(first_item.approval_steps, '[]'::jsonb) AS approval_steps,
    first_item.active_step
FROM mat_mass_request m
${MASS_REQUEST_FIRST_ITEM_STEP_LATERAL}
WHERE (
    first_item.active_step IS NOT NULL
    OR UPPER(COALESCE(first_item.first_item_status, '')) IN ('DONE', 'REWORK', 'REJECT', 'REJECTED', 'CANCEL')
)
ORDER BY m.created_at DESC, m.id DESC`;

const isMissingSingleRequestEditHistoryTableError = error =>
    error?.code === "42P01" &&
    /mat_single_request_edit_history/i.test(String(error?.message || ""));

const isMissingSingleRequestReworkColumnsError = error =>
    error?.code === "42703" &&
    /rework_(stage|by_user_id|at|reason)/i.test(String(error?.message || ""));

const runSingleRequestListQuery = async (client, whereClause, params = []) => {
    let includeReworkFields = true;

    while (true) {
        try {
            return await client.query(
                buildSingleRequestListQuery(whereClause, {
                    includeReworkFields,
                }),
                params
            );
        } catch (error) {
            if (
                includeReworkFields &&
                isMissingSingleRequestReworkColumnsError(error)
            ) {
                includeReworkFields = false;
                continue;
            }

            throw error;
        }
    }
};

const runSingleRequestApprovalInboxQuery = async client => {
    let includeEditHistory = true;
    let includeReworkFields = true;

    while (true) {
        try {
            return await client.query(
                buildSingleRequestApprovalInboxQuery({
                    includeEditHistory,
                    includeReworkFields,
                })
            );
        } catch (error) {
            if (
                includeEditHistory &&
                isMissingSingleRequestEditHistoryTableError(error)
            ) {
                includeEditHistory = false;
                continue;
            }

            if (
                includeReworkFields &&
                isMissingSingleRequestReworkColumnsError(error)
            ) {
                includeReworkFields = false;
                continue;
            }

            throw error;
        }
    }
};

// =====================================================================
// Dynamic-approver step engine — request-object payload + visibility (JS).
// SQL returns each request/item's raw step rows as `approval_steps` jsonb
// (and `active_step` jsonb). These helpers spread the public step payload
// onto each row and apply non-admin inbox visibility through the shared
// approvalSteps helpers, so single + mass stay in lockstep.
// =====================================================================

// Normalize the jsonb-aggregated steps (already snake-cased) into the row
// shape buildStepsPayload/resolveActiveStep expect.
const normalizeRowApprovalSteps = row => {
    const raw = row && row.approval_steps;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }
    return [];
};

// Spread the public step payload (approvalSteps, currentStage*, isFinalStage,
// totalStages, assignedTo) onto a request/item row. assigned_to follows the
// active step label, falling back to the header value when terminal.
const attachStepPayloadToRow = row => {
    if (!row || typeof row !== "object") return row;
    const steps = normalizeRowApprovalSteps(row);
    const payload = buildStepsPayload(steps);
    row.approvalSteps = payload.approvalSteps;
    row.currentStageLevel = payload.currentStageLevel;
    row.currentStageLabel = payload.currentStageLabel;
    row.currentStageKind = payload.currentStageKind;
    row.isFinalStage = payload.isFinalStage;
    row.totalStages = payload.totalStages;
    row.assignedTo = payload.assignedTo ?? row.assigned_to ?? null;
    return row;
};

const stepRowApproverId = step =>
    step == null ? null : step.approver_user_id ?? step.approverUserId ?? null;

const actorMatchesStep = (step, actorUserId) => {
    const approverUserId = stepRowApproverId(step);
    return (
        approverUserId != null &&
        actorUserId != null &&
        String(approverUserId) === String(actorUserId)
    );
};

// Non-admin inbox visibility over step rows:
//   in-flight (active step exists) => canActorActOnStep on the active step;
//   terminal status                => visible if the actor acted on (was the
//                                     approver of) any step.
const isStepRowVisibleForActor = (
    steps,
    { actorUserId, actorUsername, actorIsMdmMaterial }
) => {
    if (isAdminMaterialApprover(actorUsername)) {
        return true;
    }

    const activeStep = resolveActiveStep(steps);

    if (activeStep) {
        return canActorActOnStep(activeStep, {
            actorUserId,
            actorUsername,
            actorIsMdmMaterial,
        });
    }

    return (Array.isArray(steps) ? steps : []).some(step =>
        actorMatchesStep(step, actorUserId)
    );
};

// Spread the step payload onto every row and (for non-admins) filter by
// per-step visibility. Always returns the payload-enriched rows.
const applyStepInboxVisibility = (
    rows = [],
    { actorUserId, actorUsername, actorIsMdmMaterial } = {}
) => {
    const isAdmin = isAdminMaterialApprover(actorUsername);

    return rows
        .map(row => {
            const steps = normalizeRowApprovalSteps(row);
            attachStepPayloadToRow(row);
            return { row, steps };
        })
        .filter(
            ({ steps }) =>
                isAdmin ||
                isStepRowVisibleForActor(steps, {
                    actorUserId,
                    actorUsername,
                    actorIsMdmMaterial,
                })
        )
        .map(({ row }) => row);
};

// Dynamic-approver masters: one row per requester with their ordered MANUAL
// approver chain (mat_approvers_matrix_level) aggregated as manual_approvers.
// The MDM (Master Data) stage is appended at runtime and never stored here.
const GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY = `SELECT
        u.user_id AS requester_user_id,
        u.username AS requester_username,
        u.fullname AS requester_fullname,
        u.email AS requester_email,
        COALESCE(levels.manual_approvers, '[]'::jsonb) AS manual_approvers
    FROM mst_user u
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'level', l.level,
                'approver_user_id', l.approver_user_id,
                'approver_name', COALESCE(au.fullname, au.username, l.approver_user_id),
                'approver_username', au.username,
                'approver_email', au.email
            )
            ORDER BY l.level
        ) AS manual_approvers
        FROM mat_approvers_matrix_level l
        LEFT JOIN mst_user au ON au.user_id = l.approver_user_id
        WHERE l.requester_user_id = u.user_id
    ) levels ON TRUE`;

function parseWildcardSearch(term) {
    if (!term || !term.includes('*')) return null;
    const segments = term.split('*').map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length === 0) return null;
    return { isWildcard: true, segments };
}

const Material = {
    // Create a new material group
    createMaterialGroup: async groupData => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name } = groupData;

                // Check if code already exists
                const existingCode = await client.query(
                    "SELECT id FROM mat_item_group WHERE code = $1",
                    [code]
                );

                if (existingCode.rows.length > 0) {
                    throw new Error("Group code already exists");
                }

                const now = new Date();
                const result = await client.query(
                    `INSERT INTO mat_item_group (code, name, created_at, updated_at)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id, code, name`,
                    [code, name, now, now]
                );

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error creating material group:", error);
            throw error;
        }
    },

    // Update material group
    updateMaterialGroup: async (groupId, groupData) => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name } = groupData;

                // Check if code already exists for another group
                if (code) {
                    const existingCode = await client.query(
                        "SELECT id FROM mat_item_group WHERE code = $1 AND id != $2",
                        [code, groupId]
                    );

                    if (existingCode.rows.length > 0) {
                        throw new Error("Group code already exists");
                    }
                }

                const now = new Date();
                let query = "UPDATE mat_item_group SET updated_at = $1";
                const params = [now];
                let paramIndex = 2;

                if (code) {
                    query += `, code = $${paramIndex}`;
                    params.push(code);
                    paramIndex++;
                }

                if (name) {
                    query += `, name = $${paramIndex}`;
                    params.push(name);
                    paramIndex++;
                }

                query += ` WHERE id = $${paramIndex} RETURNING id, code, name`;
                params.push(groupId);

                const result = await client.query(query, params);

                if (result.rows.length === 0) {
                    throw new Error("Group not found");
                }

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error updating material group:", error);
            throw error;
        }
    },

    // Delete material group (soft delete with cascade, no validation)
    deleteMaterialGroup: async (groupId, deletedBy) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");
                const now = new Date();
                // 1. Soft delete the group
                await client.query(
                    "UPDATE mat_item_group SET deleted_at = $1, deleted_by = $2 WHERE id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, groupId]
                );
                // 2. Soft delete all subgroups under this group
                await client.query(
                    "UPDATE mat_item_sub_group SET deleted_at = $1, deleted_by = $2 WHERE item_group_id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, groupId]
                );
                // 3. Get all subgroups under this group (including already soft deleted)
                const subgroupsRes = await client.query(
                    "SELECT id FROM mat_item_sub_group WHERE item_group_id = $1",
                    [groupId]
                );
                const subGroupIds = subgroupsRes.rows.map(row => row.id);
                if (subGroupIds.length > 0) {
                    // 4. Soft delete all materials under these subgroups
                    await client.query(
                        `UPDATE mat_sap_data SET dffromclient = true WHERE material_sub_group_id = ANY($1) AND (dffromclient IS NULL OR dffromclient = false)`,
                        [subGroupIds]
                    );
                }
                await client.query("COMMIT");
                return { id: groupId, deleted: true };
            });
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.error("Error soft deleting material group:", error);
            throw error;
        }
    },

    // Get all material groups
    getMaterialGroups: async (
        page,
        pageSize,
        searchQuery = "",
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const searchPattern = searchQuery ? `%${searchQuery}%` : null;

                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "mig.code",
                    name: "mig.name",
                    id: "mig.id",
                    created_at: "mig.created_at",
                    updated_at: "mig.updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "mig.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                // Only non-deleted groups
                const countQuery = searchPattern
                    ? await client.query(
                          `SELECT COUNT(*) as total FROM mat_item_group WHERE deleted_at IS NULL AND (code ILIKE $1 OR name ILIKE $1)`,
                          [searchPattern]
                      )
                    : await client.query(
                          `SELECT COUNT(*) as total FROM mat_item_group WHERE deleted_at IS NULL`
                      );
                const totalCount = parseInt(countQuery.rows[0].total);
                const queryText = searchPattern
                    ? `
                        SELECT
                            mig.id,
                            mig.code,
                            mig.name,
                            (SELECT COUNT(*) FROM mat_item_sub_group WHERE item_group_id = mig.id AND deleted_at IS NULL) as subgroups_count,
                            (
                                SELECT COUNT(*)
                                FROM mat_sap_data m
                                JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                                WHERE mis.item_group_id = mig.id AND mis.deleted_at IS NULL AND (m.dffromclient IS NULL OR m.dffromclient = false)
                            ) as materials_count
                        FROM mat_item_group mig
                        WHERE mig.deleted_at IS NULL AND (mig.code ILIKE $3 OR mig.name ILIKE $3)
                        ORDER BY ${sortClause}
                        LIMIT $1 OFFSET $2
                    `
                    : `
                        SELECT
                            mig.id,
                            mig.code,
                            mig.name,
                            (SELECT COUNT(*) FROM mat_item_sub_group WHERE item_group_id = mig.id AND deleted_at IS NULL) as subgroups_count,
                            (
                                SELECT COUNT(*)
                                FROM mat_sap_data m
                                JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                                WHERE mis.item_group_id = mig.id AND mis.deleted_at IS NULL AND (m.dffromclient IS NULL OR m.dffromclient = false)
                            ) as materials_count
                        FROM mat_item_group mig
                        WHERE mig.deleted_at IS NULL
                        ORDER BY ${sortClause}
                        LIMIT $1 OFFSET $2
                    `;
                const queryParams = searchPattern
                    ? [pageSize, offset, searchPattern]
                    : [pageSize, offset];
                const result = await client.query(queryText, queryParams);
                return {
                    data: result.rows,
                    pagination: {
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get all material groups for dropdown (no pagination)
    getAllMaterialGroups: async (sort = "code", order = "asc") => {
        try {
            return await DBClientWrapper(async client => {
                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "code",
                    name: "name",
                    id: "id",
                    created_at: "created_at",
                    updated_at: "updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";

                const result = await client.query(`
                    SELECT
                        id,
                        code,
                        name
                    FROM mat_item_group
                    WHERE deleted_at IS NULL
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                `);
                return result.rows;
            });
        } catch (error) {
            console.error("Error getting all material groups:", error);
            throw error;
        }
    },

    // Get all subgroups for a group for dropdown (no pagination)
    getAllSubgroupsByGroup: async (groupId, sort = "code", order = "asc") => {
        try {
            return await DBClientWrapper(async client => {
                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "code",
                    name: "name",
                    id: "id",
                    created_at: "created_at",
                    updated_at: "updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const result = await client.query(
                    `
                    SELECT
                        id,
                        code,
                        name,
                        item_group_id
                    FROM mat_item_sub_group
                    WHERE item_group_id = $1 AND deleted_at IS NULL
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                `,
                    [groupId]
                );
                return result.rows;
            });
        } catch (error) {
            console.error("Error getting all subgroups for group:", error);
            throw error;
        }
    },

    // Create a new material subgroup
    createMaterialSubGroup: async subGroupData => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name, item_group_id } = subGroupData;

                // Check if group exists
                const groupCheck = await client.query(
                    "SELECT id FROM mat_item_group WHERE id = $1",
                    [item_group_id]
                );

                if (groupCheck.rows.length === 0) {
                    throw new Error("Parent group not found");
                }

                // Check if code already exists within this group
                const existingCode = await client.query(
                    "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2",
                    [code, item_group_id]
                );

                if (existingCode.rows.length > 0) {
                    throw new Error(
                        "Subgroup code already exists within this group"
                    );
                }

                const now = new Date();
                const result = await client.query(
                    `INSERT INTO mat_item_sub_group (code, name, item_group_id, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id, code, name, item_group_id`,
                    [code, name, item_group_id, now, now]
                );

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error creating material subgroup:", error);
            throw error;
        }
    },

    // Update material subgroup
    updateMaterialSubGroup: async (subGroupId, subGroupData) => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name, item_group_id } = subGroupData;

                // If changing group, check if new group exists
                if (item_group_id) {
                    const groupCheck = await client.query(
                        "SELECT id FROM mat_item_group WHERE id = $1",
                        [item_group_id]
                    );

                    if (groupCheck.rows.length === 0) {
                        throw new Error("Parent group not found");
                    }
                }

                // Get current subgroup data
                const currentSubgroup = await client.query(
                    "SELECT item_group_id FROM mat_item_sub_group WHERE id = $1",
                    [subGroupId]
                );

                if (currentSubgroup.rows.length === 0) {
                    throw new Error("Subgroup not found");
                }

                const currentGroupId =
                    item_group_id || currentSubgroup.rows[0].item_group_id;

                // Check if code already exists within the group for another subgroup
                if (code) {
                    const existingCode = await client.query(
                        "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2 AND id != $3",
                        [code, currentGroupId, subGroupId]
                    );

                    if (existingCode.rows.length > 0) {
                        throw new Error(
                            "Subgroup code already exists within this group"
                        );
                    }
                }

                const now = new Date();
                let query = "UPDATE mat_item_sub_group SET updated_at = $1";
                const params = [now];
                let paramIndex = 2;

                if (code) {
                    query += `, code = $${paramIndex}`;
                    params.push(code);
                    paramIndex++;
                }

                if (name) {
                    query += `, name = $${paramIndex}`;
                    params.push(name);
                    paramIndex++;
                }

                if (item_group_id) {
                    query += `, item_group_id = $${paramIndex}`;
                    params.push(item_group_id);
                    paramIndex++;
                }

                query += ` WHERE id = $${paramIndex} RETURNING id, code, name, item_group_id`;
                params.push(subGroupId);

                const result = await client.query(query, params);

                if (result.rows.length === 0) {
                    throw new Error("Subgroup not found");
                }

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error updating material subgroup:", error);
            throw error;
        }
    },

    // Delete material subgroup (soft delete with cascade, no validation)
    deleteMaterialSubGroup: async (subGroupId, deletedBy) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");
                const now = new Date();
                // 1. Soft delete the subgroup
                await client.query(
                    "UPDATE mat_item_sub_group SET deleted_at = $1, deleted_by = $2 WHERE id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, subGroupId]
                );
                // 2. Soft delete all materials under this subgroup
                await client.query(
                    `UPDATE mat_sap_data SET dffromclient = true WHERE material_sub_group_id = $1 AND (dffromclient IS NULL OR dffromclient = false)`,
                    [subGroupId]
                );
                await client.query("COMMIT");
                return { id: subGroupId, deleted: true };
            });
        } catch (error) {
            console.error("Error soft deleting material subgroup:", error);
            throw error;
        }
    },

    // Get subgroups by group ID
    getMaterialSubGroups: async (
        groupId,
        page = 1,
        pageSize = 10,
        searchQuery = "",
        sortField = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const searchPattern = searchQuery ? `%${searchQuery}%` : null;

                // Build the where clause based on whether we have a search query
                let whereClause = "mis.item_group_id = $1";
                let countWhereClause = "mis.item_group_id = $1";
                let params = [groupId];
                let countParams = [groupId];

                if (searchPattern) {
                    whereClause +=
                        " AND (mis.code ILIKE $4 OR mis.name ILIKE $4)";
                    countWhereClause +=
                        " AND (mis.code ILIKE $2 OR mis.name ILIKE $2)";
                    params.push(pageSize, offset, searchPattern);
                    countParams.push(searchPattern);
                } else {
                    params.push(pageSize, offset);
                }

                // First get the total count with search filter if provided
                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_item_sub_group mis
                    WHERE ${countWhereClause}
                    `,
                    countParams
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Determine safe sorting column and order (whitelist)
                const _allowedSortCols = {
                    code: "mis.code",
                    name: "mis.name",
                    id: "mis.id",
                    created_at: "mis.created_at",
                    updated_at: "mis.updated_at",
                };
                const _sortKey = String(sortField || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "mis.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";

                // Get the subgroups with pagination and search filter if provided
                const result = await client.query(
                    `
                    SELECT
                        mis.id,
                        mis.code,
                        mis.name,
                        mis.item_group_id,
                        mig.code as groupCode,
                        mig.name as groupName,
                        (SELECT COUNT(*) FROM mat_sap_data WHERE material_sub_group_id = mis.id) as materials_count
                    FROM mat_item_sub_group mis
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE ${whereClause}
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                    LIMIT $2 OFFSET $3
                `,
                    params
                );

                return {
                    data: result.rows,
                    pagination: {
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get materials by group ID
    getMaterialsByGroup: async (
        groupId,
        page = 1,
        pageSize = 10,
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;

                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "m.code",
                    name: "m.name",
                    description: "m.description",
                    created_at: "m.created_at",
                    updated_at: "m.updated_at",
                    uom: "m.unit_of_measurement",
                    group_code: "mig.code",
                    subgroup_code: "mis.code",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "m.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                // First get the total count
                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE mig.id = $1
                    `,
                    [groupId]
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Get group info
                const groupQuery = await client.query(
                    `SELECT id, code, name FROM mat_item_group WHERE id = $1`,
                    [groupId]
                );
                const groupDetails = groupQuery.rows[0] || null;

                // Get materials without attachments first
                const materialsQuery = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.created_by,
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE mig.id = $1
                    ORDER BY ${sortClause}
                    LIMIT $2 OFFSET $3
                    `,
                    [groupId, pageSize, offset]
                );

                // Get all material IDs to fetch attachments
                const materialIds = materialsQuery.rows.map(m => m.id);

                // Get attachments for these materials in a separate query
                const attachmentsQuery = await client.query(
                    `SELECT material_id, id, attachment, type
                     FROM mat_attachment
                     WHERE material_id = ANY($1)`,
                    [materialIds]
                );

                // Create a map of attachments by material_id
                const attachmentsByMaterialId = {};
                attachmentsQuery.rows.forEach(attachment => {
                    if (!attachmentsByMaterialId[attachment.material_id]) {
                        attachmentsByMaterialId[attachment.material_id] = [];
                    }
                    attachmentsByMaterialId[attachment.material_id].push({
                        id: attachment.id,
                        attachment: attachment.attachment,
                        type: attachment.type,
                    });
                });

                // Add attachments to each material
                const materialsWithAttachments = materialsQuery.rows.map(
                    material => ({
                        ...material,
                        attachments: attachmentsByMaterialId[material.id] || [],
                    })
                );

                return {
                    materials: materialsWithAttachments,
                    group: groupDetails,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get materials by subgroup ID
    getMaterialsBySubGroup: async (
        subGroupId,
        page = 1,
        pageSize = 10,
        searchQuery = "",
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const wildcard = parseWildcardSearch(searchQuery);

                const _allowedSortCols = {
                    code: "m.code",
                    name: "m.name",
                    description: "m.description",
                    created_at: "m.created_at",
                    updated_at: "m.updated_at",
                    uom: "m.unit_of_measurement",
                    group_code: "mig.code",
                    subgroup_code: "mis.code",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "m.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let countWhereClause = "m.material_sub_group_id = $1";
                let materialWhereClause = "m.material_sub_group_id = $1";
                let countParams = [subGroupId];
                let materialParams = [subGroupId, pageSize, offset];

                if (wildcard) {
                    const wildcardValues = [...wildcard.segments];

                    const countIlike = wildcard.segments.map(
                        (_, i) => `'%' || $${countParams.length + 1 + i} || '%'`
                    );
                    countWhereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${countIlike.join(", ")}])`;
                    countParams.push(...wildcardValues);

                    const matIlike = wildcard.segments.map(
                        (_, i) => `'%' || $${materialParams.length + 1 + i} || '%'`
                    );
                    materialWhereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${matIlike.join(", ")}])`;
                    materialParams.push(...wildcardValues);
                } else if (searchQuery) {
                    const searchPattern = `%${searchQuery}%`;
                    const fieldClause = searchableFields.map(f => `${f} ILIKE $2`).join(" OR ");
                    countWhereClause += ` AND (${fieldClause})`;
                    countParams.push(searchPattern);

                    const matFieldClause = searchableFields.map(f => `${f} ILIKE $4`).join(" OR ");
                    materialWhereClause += ` AND (${matFieldClause})`;
                    materialParams.push(searchPattern);
                }

                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_sap_data m
                    WHERE ${countWhereClause}
                    `,
                    countParams
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Get subgroup and group info
                const groupInfoQuery = await client.query(
                    `
                    SELECT
                        mis.id,
                        mis.code as subgroup_code,
                        mis.name as subgroup_name,
                        mis.item_group_id,
                        mig.id as group_id,
                        mig.code as group_code,
                        mig.name as group_name
                    FROM mat_item_sub_group mis
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE mis.id = $1
                    `,
                    [subGroupId]
                );

                // Build group and subgroup objects
                const groupInfo = groupInfoQuery.rows[0] || null;

                let group = null;
                let subgroup = null;

                if (groupInfo) {
                    group = {
                        id: groupInfo.group_id,
                        code: groupInfo.group_code,
                        name: groupInfo.group_name,
                    };

                    subgroup = {
                        id: groupInfo.id,
                        code: groupInfo.subgroup_code,
                        name: groupInfo.subgroup_name,
                        item_group_id: groupInfo.item_group_id,
                    };
                }

                // Get materials with search and pagination
                const materialsQuery = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.long_text,
                        m.unit_of_measurement,
                        CASE
                            WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                            WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                            WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                            ELSE NULL
                        END as combined_description,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient,
                        m.created_by,
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE ${materialWhereClause}
                    ORDER BY ${sortClause}
                    LIMIT $2 OFFSET $3
                    `,
                    materialParams
                );

                // Get all material IDs to fetch attachments
                const materialIds = materialsQuery.rows.map(m => m.id);

                // Skip attachment query if no materials
                if (materialIds.length === 0) {
                    return {
                        materials: [],
                        group,
                        subgroup,
                        pagination: {
                            page,
                            pageSize,
                            totalCount,
                            totalPages,
                        },
                    };
                }

                // Get attachments for these materials in a separate query
                const attachmentsQuery = await client.query(
                    `SELECT material_id, id, attachment, type
                     FROM mat_attachment
                     WHERE material_id = ANY($1)`,
                    [materialIds]
                );

                // Create a map of attachments by material_id
                const attachmentsByMaterialId = {};
                attachmentsQuery.rows.forEach(attachment => {
                    if (!attachmentsByMaterialId[attachment.material_id]) {
                        attachmentsByMaterialId[attachment.material_id] = [];
                    }
                    attachmentsByMaterialId[attachment.material_id].push({
                        id: attachment.id,
                        attachment: attachment.attachment,
                        type: attachment.type,
                    });
                });

                // Add attachments to each material
                const materialsWithAttachments = materialsQuery.rows.map(
                    material => ({
                        ...material,
                        attachments: attachmentsByMaterialId[material.id] || [],
                    })
                );

                return {
                    materials: materialsWithAttachments,
                    group,
                    subgroup,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Search all materials (including deleted)
    searchAllMaterials: async (
        searchTerm,
        page = 1,
        pageSize = 10,
        sorting_state
    ) => {
        try {
            return await DBClientWrapper(async client => {
                let sorting_q = "";
                if (sorting_state) {
                    const colMap = {
                        CODE: "m.code",
                        NAME: "m.name",
                        CREATED_BY: "m.created_by",
                        CREATED_AT: "m.created_at",
                        GROUPNAME: "mig.name",
                        UPDATED_AT: "m.updated_at",
                        STATUS: "m.dffromclient",
                        UNIT_OF_MEASUREMENT: "m.unit_of_measurement",
                        FULLCODE: "m.code",
                        GROUPCODE: "mig.code",
                        SUBGROUPCODE: "mis.code",
                    };
                    sorting_q = sorting_state.reduce((result, item) => {
                        const col = String(item.col || "").toUpperCase();
                        const state = String(item.state || "").toUpperCase();
                        const mapped = colMap[col];
                        if (!mapped) return result;
                        const dir = state === "DESC" ? "DESC" : "ASC";
                        return result + `${mapped} ${dir},`;
                    }, "");
                }
                console.log(sorting_q);
                const offset = (page - 1) * pageSize;
                const safeSearchTerm = String(searchTerm || "").trim();
                const wildcard = parseWildcardSearch(safeSearchTerm);
                const isSearch = safeSearchTerm.length > 0;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let totalCount = 0;
                let materialsQueryResult = [];
                if (isSearch) {
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        const wildcardParams = [...wildcard.segments];

                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            WHERE CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])`,
                            wildcardParams
                        );
                        totalCount = parseInt(countRes.rows[0].total);

                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ORDER BY ${sorting_q}m.code ASC, m.name ASC
                            LIMIT $${wildcardParams.length + 1} OFFSET $${wildcardParams.length + 2}`,
                            [...wildcardParams, pageSize, offset]
                        );
                        materialsQueryResult = result.rows;
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        const ilikeExact = safeSearchTerm;
                        const ilikePartial = `%${safeSearchTerm}%`;
                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            WHERE (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )`,
                            [tsQuery, safeSearchTerm]
                        );
                        totalCount = parseInt(countRes.rows[0].total);
                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName",
                                ts_rank_cd(
                                    setweight(to_tsvector(COALESCE(m.name, '')), 'A') ||
                                    setweight(to_tsvector(COALESCE(m.description, '')), 'B') ||
                                    setweight(to_tsvector(COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '')), 'C') ||
                                    setweight(to_tsvector(COALESCE(m.alias1, '')), 'D'),
                                    to_tsquery('english', $1)
                                ) AS rank,
                                CASE
                                    WHEN m.code ILIKE $2 THEN 1
                                    WHEN m.code ILIKE $4 THEN 2
                                    ELSE 3
                                END AS code_match_rank
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($3, ' ')) AS word
                                )
                            ) ORDER BY ${sorting_q}code_match_rank, rank DESC, m.name ASC
                            LIMIT $5 OFFSET $6`,
                            [tsQuery, ilikeExact, safeSearchTerm, ilikePartial, pageSize, offset]
                        );
                        materialsQueryResult = result.rows;
                    }
                } else {
                    const countRes = await client.query(
                        `SELECT COUNT(*) AS total FROM mat_sap_data`
                    );
                    totalCount = parseInt(countRes.rows[0].total);
                    const result = await client.query(
                        `SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description,
                            CASE
                                WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                ELSE 'Active'
                            END AS status,
                            u.fullname AS "user_fullname",
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.filter_code_1,
                            m.filter_code_2,
                            m.material_sub_group_id,
                            m.created_at,
                            m.updated_at,
                            m.dfFromClient,
                            m.created_by,
                            mis.id AS "subGroupId",
                            mis.code AS "subGroupCode",
                            mis.name AS "subGroupName",
                            mig.id AS "groupId",
                            mig.code AS "groupCode",
                            mig.name AS "groupName"
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                        ORDER BY ${sorting_q}m.code ASC, m.name ASC
                        LIMIT $1 OFFSET $2`,
                        [pageSize, offset]
                    );
                    materialsQueryResult = result.rows;
                }
                const materialIds = materialsQueryResult.map(m => m.id);
                const attachmentsMap =
                    await Material.getAttachmentsByMaterialIds(
                        client,
                        materialIds
                    );
                const finalMaterials = materialsQueryResult.map(material => ({
                    ...material,
                    attachments: attachmentsMap[material.id] || [],
                }));
                return {
                    materials: finalMaterials,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error("Search all error:", error);
            throw error;
        }
    },

    // Update searchMaterials to only return non-deleted materials
    searchMaterials: async (
        searchTerm,
        page = 1,
        pageSize = 10,
        sorting_state,
        groupId = null
    ) => {
        try {
            return await DBClientWrapper(async client => {
                let sorting_q = "";
                if (sorting_state) {
                    const colMap = {
                        CODE: "m.code",
                        NAME: "m.name",
                        CREATED_AT: "m.created_at",
                        UPDATED_AT: "m.updated_at",
                        FULLCODE: "m.code",
                        GROUPCODE: "mig.code",
                        SUBGROUPCODE: "mis.code",
                    };
                    sorting_q = sorting_state.reduce((result, item) => {
                        const col = String(item.col || "").toUpperCase();
                        const state = String(item.state || "").toUpperCase();
                        const mapped = colMap[col];
                        if (!mapped) return result;
                        const dir = state === "DESC" ? "DESC" : "ASC";
                        return result + `${mapped} ${dir},`;
                    }, "");
                }
                const offset = (page - 1) * pageSize;
                const safeSearchTerm = String(searchTerm || "").trim();
                const wildcard = parseWildcardSearch(safeSearchTerm);
                const isSearch = safeSearchTerm.length > 0;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let totalCount = 0;
                let materialsQueryResult = [];
                if (isSearch) {
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        const wildcardParams = [...wildcard.segments];
                        const groupParamIdx = wildcardParams.length + 1;

                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ${groupId ? ` AND mig.id = $${groupParamIdx}` : ""}`,
                            groupId ? [...wildcardParams, groupId] : wildcardParams
                        );
                        totalCount = parseInt(countRes.rows[0].total);

                        const limitIdx = groupId ? groupParamIdx + 1 : wildcardParams.length + 1;
                        const offsetIdx = limitIdx + 1;
                        const groupWhereIdx = groupId ? groupParamIdx : null;

                        let selectParams = [...wildcardParams];
                        let limitParamIdx = wildcardParams.length + 1;
                        if (groupId) {
                            selectParams.push(groupId);
                            limitParamIdx++;
                        }
                        selectParams.push(pageSize, offset);

                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                m.plant_code,
                                m.sloc_code,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ${groupId ? ` AND mig.id = $${wildcardParams.length + 1}` : ""}
                            ORDER BY ${sorting_q}m.code ASC, m.name ASC
                            LIMIT $${limitParamIdx} OFFSET $${limitParamIdx + 1}`,
                            selectParams
                        );
                        materialsQueryResult = result.rows;
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        const ilikeExact = safeSearchTerm;
                        const ilikePartial = `%${safeSearchTerm}%`;
                        const searchTermForTrgm = safeSearchTerm;
                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )
                            ${groupId ? " AND mig.id = $3" : ""}`,
                            groupId
                                ? [tsQuery, searchTermForTrgm, groupId]
                                : [tsQuery, searchTermForTrgm]
                        );
                        totalCount = parseInt(countRes.rows[0].total);
                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                m.plant_code,
                                m.sloc_code,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName",
                                ts_rank_cd(
                                    setweight(to_tsvector(COALESCE(m.name, '')), 'A') ||
                                    setweight(to_tsvector(COALESCE(m.description, '')), 'B') ||
                                    setweight(to_tsvector(COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '')), 'C') ||
                                    setweight(to_tsvector(COALESCE(m.alias1, '')), 'D'),
                                    to_tsquery('english', $1)
                                ) AS rank,
                                CASE
                                    WHEN m.code ILIKE $2 THEN 1
                                    WHEN m.code ILIKE $4 THEN 2
                                    ELSE 3
                                END AS code_match_rank
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($3, ' ')) AS word
                                )
                            )
                            ${groupId ? " AND mig.id = $7" : ""}
                            ORDER BY ${sorting_q}code_match_rank, rank DESC, m.name ASC
                            LIMIT $5 OFFSET $6`,
                            groupId
                                ? [
                                      tsQuery,
                                      ilikeExact,
                                      searchTermForTrgm,
                                      ilikePartial,
                                      pageSize,
                                      offset,
                                      groupId,
                                  ]
                                : [
                                      tsQuery,
                                      ilikeExact,
                                      searchTermForTrgm,
                                      ilikePartial,
                                      pageSize,
                                      offset,
                                  ]
                        );
                        materialsQueryResult = result.rows;
                    }
                } else {
                    const countRes = await client.query(
                        `SELECT COUNT(*) AS total 
                         FROM mat_sap_data m
                         JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                         JOIN mat_item_group mig ON mis.item_group_id = mig.id
                         WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                         ${groupId ? " AND mig.id = $1" : ""}`,
                        groupId ? [groupId] : []
                    );
                    totalCount = parseInt(countRes.rows[0].total);
                    const result = await client.query(
                        `SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            m.plant_code,
                            m.sloc_code,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description,
                            CASE
                                WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                ELSE 'Active'
                            END AS status,
                            u.fullname AS "user_fullname",
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.filter_code_1,
                            m.filter_code_2,
                            m.material_sub_group_id,
                            m.created_at,
                            m.updated_at,
                            m.dfFromClient,
                            m.created_by,
                            mis.id AS "subGroupId",
                            mis.code AS "subGroupCode",
                            mis.name AS "subGroupName",
                            mig.id AS "groupId",
                            mig.code AS "groupCode",
                            mig.name AS "groupName"
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                        WHERE (m.dffromclient IS NULL OR dffromclient = false) 
                        ${groupId ? " AND mig.id = $3" : ""}
                        ORDER BY ${sorting_q}m.code ASC, m.name ASC
                        LIMIT $1 OFFSET $2`,
                        groupId
                            ? [pageSize, offset, groupId]
                            : [pageSize, offset]
                    );
                    materialsQueryResult = result.rows;
                }
                const materialIds = materialsQueryResult.map(m => m.id);
                const attachmentsMap =
                    await Material.getAttachmentsByMaterialIds(
                        client,
                        materialIds
                    );
                const finalMaterials = materialsQueryResult.map(material => ({
                    ...material,
                    attachments: attachmentsMap[material.id] || [],
                }));
                return {
                    materials: finalMaterials,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error("Search error:", error);
            throw error;
        }
    },

    // Search suggestions for materials
    getSearchSuggestions: async ({
        query,
        materialGroupCode = null,
        limit = 10,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                const safeSearchTerm = String(query || "").trim();
                if (safeSearchTerm.length < 2) return [];

                const safeLimit = Math.min(Number(limit) || 10, 25);

                const wildcard = parseWildcardSearch(safeSearchTerm);

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let whereClause =
                    "(m.dffromclient IS NULL OR m.dffromclient = false)";
                const params = [];

                if (wildcard) {
                    const ilikePatterns = wildcard.segments.map(
                        (_, i) => `'%' || $${i + 1} || '%'`
                    );
                    params.push(...wildcard.segments);
                    whereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])`;

                    if (materialGroupCode) {
                        whereClause += ` AND mig.code = $${params.length + 1}`;
                        params.push(materialGroupCode);
                    }

                    const queryText = `
                        SELECT 
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description
                        FROM mat_sap_data m
                        LEFT JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        LEFT JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        WHERE ${whereClause}
                        ORDER BY m.code ASC
                        LIMIT $${params.length + 1}
                    `;

                    params.push(safeLimit);
                    const result = await client.query(queryText, params);
                    return result.rows;
                } else {
                    params.push(safeSearchTerm);

                    const wordMatchClause = `(
                        m.code ILIKE '%' || word || '%'
                        OR m.name ILIKE '%' || word || '%'
                        OR m.description ILIKE '%' || word || '%'
                        OR m.long_text ILIKE '%' || word || '%'
                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                        OR m.alias1 ILIKE '%' || word || '%'
                        OR m.alias2 ILIKE '%' || word || '%'
                        OR m.alias3 ILIKE '%' || word || '%'
                    )`;

                    whereClause += ` AND (
                        EXISTS (
                            SELECT 1 FROM unnest(string_to_array($1, ' ')) AS word
                            WHERE ${wordMatchClause}
                        )
                    )`;

                    if (materialGroupCode) {
                        whereClause += ` AND mig.code = $2`;
                        params.push(materialGroupCode);
                    }

                    const queryText = `
                        SELECT 
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description
                        FROM mat_sap_data m
                        LEFT JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        LEFT JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        WHERE ${whereClause}
                        ORDER BY
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.code ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.name ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.description ILIKE '%' || word || '%') DESC,
                            m.code ASC
                        LIMIT $${params.length + 1}
                    `;

                    params.push(safeLimit);
                    const result = await client.query(queryText, params);
                    return result.rows;
                }

                const result = await client.query(queryText, params);
                return result.rows;
            });
        } catch (error) {
            console.error("Error fetching search suggestions:", error);
            throw error;
        }
    },

    // Utility: Fetch and group attachments
    getAttachmentsByMaterialIds: async (client, ids) => {
        if (!ids.length) return {};
        const res = await client.query(
            `SELECT material_id, id, attachment, type FROM mat_attachment WHERE material_id = ANY($1)`,
            [ids]
        );
        const map = {};
        res.rows.forEach(({ material_id, ...rest }) => {
            if (!map[material_id]) map[material_id] = [];
            map[material_id].push(rest);
        });
        return map;
    },

    // Get material by ID with full details
    getMaterialById: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient,
                        CASE 
                            WHEN m.dfFromClient THEN 'Inactive' 
                            ELSE 'Active' 
                        END AS status,
                        u.fullname AS "user_fullname",
                        mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE m.id = $1
                `,
                    [materialId]
                );
                return result.rows[0];
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    getMaterialByCode: async materialCode => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.type,
                        m.unit_of_measurement,
                        m.plant_code,
                        m.sloc_code,
                        mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE m.code = $1
                `,
                    [materialCode]
                );
                return result.rows[0] || null;
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    getMaterialAttachments: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT id, attachment, type, material_id
                    FROM mat_attachment
                    WHERE material_id = $1
                    ORDER BY id`,
                    [materialId]
                );
                return result.rows;
            });
        } catch (error) {
            console.error("Error fetching material attachments:", error);
            throw error;
        }
    },

    addAttachment: async (
        materialId,
        fileInfoArray,
        updatedBy,
        userRole,
        userName
    ) => {
        const uploadedFiles = [];
        const cleanupFiles = [];

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Check current attachment count
                    const attachmentCountQuery = await client.query(
                        "SELECT COUNT(*) as count FROM mat_attachment WHERE material_id = $1",
                        [materialId]
                    );

                    const currentAttachmentCount = parseInt(
                        attachmentCountQuery.rows[0].count
                    );
                    const MAX_ATTACHMENTS = 3;

                    if (currentAttachmentCount >= MAX_ATTACHMENTS) {
                        throw new Error(
                            `Maximum number of attachments (${MAX_ATTACHMENTS}) reached for this material`
                        );
                    }

                    // Calculate how many more attachments we can add
                    const availableSlots =
                        MAX_ATTACHMENTS - currentAttachmentCount;

                    if (fileInfoArray.length > availableSlots) {
                        throw new Error(
                            `Can only add ${availableSlots} more attachment(s). Maximum of ${MAX_ATTACHMENTS} attachments allowed per material.`
                        );
                    }

                    // 1. Add attachments to database
                    for (const file of fileInfoArray) {
                        // Determine MIME type from extension
                        const mimeType = getMimeType(file.extension);

                        // Use Crud helper to generate insert query
                        const insertData = {
                            material_id: materialId,
                            attachment: file.newName,
                            type: mimeType,
                            created_at: "NOW()",
                            updated_at: "NOW()",
                        };

                        const [query, values] = Crud.insertItem(
                            "mat_attachment",
                            insertData,
                            "id"
                        );

                        const result = await client.query(query, values);

                        uploadedFiles.push({
                            id: result.rows[0].id,
                            originalName: file.originalName,
                            savedAs: file.newName,
                            type: mimeType,
                        });
                    }

                    // Get material details for mat_reqedit logging
                    const materialDetailQuery = await client.query(
                        "SELECT code, name FROM mat_sap_data WHERE id = $1",
                        [materialId]
                    );

                    const materialDetail = materialDetailQuery.rows[0];

                    if (userRole !== "MDM_MATERIAL") {
                        for (const file of fileInfoArray) {
                            const reqEditInsert = {
                                material_code: materialDetail.code,
                                material_name: materialDetail.name,
                                attachment_path: file.newName,
                                processed: false,
                                created_at: "NOW()",
                                edited_by: userName,
                            };

                            const [reqEditQuery, reqEditValues] =
                                Crud.insertItem("mat_reqedit", reqEditInsert);

                            await client.query(reqEditQuery, reqEditValues);
                        }
                    }

                    const updateData = {
                        updated_at: "NOW()",
                        updated_by: updatedBy || null,
                    };

                    const whereCondition = {
                        id: materialId,
                    };

                    const [query, values] = Crud.updateItem(
                        "mat_sap_data",
                        updateData,
                        whereCondition
                    );

                    await client.query(query, values);

                    // Commit transaction
                    await client.query("COMMIT");

                    // 3. After successful database operations, save files to disk
                    for (const file of fileInfoArray) {
                        const publicDir = path.join(
                            path.resolve(),
                            "./backend/public"
                        );

                        // Ensure public directory exists
                        if (!fs.existsSync(publicDir)) {
                            fs.mkdirSync(publicDir, { recursive: true });
                        }

                        const finalPath = path.join(publicDir, file.newName);
                        cleanupFiles.push(finalPath);

                        // Read from temp location and write to final location
                        const rawData = fs.readFileSync(file.tempPath);
                        fs.writeFileSync(finalPath, rawData);
                    }

                    return {
                        success: true,
                        files: uploadedFiles,
                    };
                } catch (error) {
                    // Rollback transaction on error
                    await client.query("ROLLBACK");

                    for (const filePath of cleanupFiles) {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                    }

                    throw error;
                }
            });
        } catch (error) {
            console.error("Error processing attachment upload:", error);
            throw error;
        }
    },

    updateMaterialTimestamp: async (materialId, updatedBy) => {
        try {
            return await DBClientWrapper(async client => {
                // Create data object for update
                const updateData = {
                    updated_at: "NOW()",
                    updated_by: updatedBy || null,
                };

                // Create where condition
                const whereCondition = {
                    id: materialId,
                };

                // Use Crud helper to generate query
                const [query, values] = Crud.updateItem(
                    "mat_sap_data",
                    updateData,
                    whereCondition
                );

                const result = await client.query(query, values);

                if (result.rowCount === 0) {
                    throw new Error("Material not found or no changes made");
                }

                return {
                    materialId,
                    updatedBy: updatedBy || null,
                    updated: true,
                };
            });
        } catch (error) {
            console.error("Error updating material timestamp:", error);
            throw error;
        }
    },

    updateAliasesOnly: async (
        materialId,
        alias1,
        alias2,
        alias3,
        userRole,
        userName
    ) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Get current material details for comparison and tracking
                    const materialDetailQuery = await client.query(
                        "SELECT code, name, alias1, alias2, alias3 FROM mat_sap_data WHERE id = $1",
                        [materialId]
                    );

                    if (materialDetailQuery.rows.length === 0) {
                        throw new Error("Material not found");
                    }

                    const materialDetail = materialDetailQuery.rows[0];

                    // Create data object for update
                    const updateData = {
                        alias1: alias1 || null,
                        alias2: alias2 || null,
                        alias3: alias3 || null,
                    };

                    // Create where condition
                    const whereCondition = {
                        id: materialId,
                    };

                    // Use Crud helper to generate query
                    const [query, values] = Crud.updateItem(
                        "mat_sap_data",
                        updateData,
                        whereCondition
                    );

                    const result = await client.query(query, values);

                    if (result.rowCount === 0) {
                        throw new Error(
                            "Material not found or no changes made"
                        );
                    }

                    // Track alias changes for non-MDM_MATERIAL users
                    if (userRole !== "MDM_MATERIAL") {
                        const aliasChanges = [];

                        if (materialDetail.alias1 !== (alias1 || null)) {
                            aliasChanges.push(
                                `Alias1: "${materialDetail.alias1 || ""}" → "${
                                    alias1 || ""
                                }"`
                            );
                        }
                        if (materialDetail.alias2 !== (alias2 || null)) {
                            aliasChanges.push(
                                `Alias2: "${materialDetail.alias2 || ""}" → "${
                                    alias2 || ""
                                }"`
                            );
                        }
                        if (materialDetail.alias3 !== (alias3 || null)) {
                            aliasChanges.push(
                                `Alias3: "${materialDetail.alias3 || ""}" → "${
                                    alias3 || ""
                                }"`
                            );
                        }

                        if (aliasChanges.length > 0) {
                            const reqEditInsert = {
                                material_code: materialDetail.code,
                                material_name: materialDetail.name,
                                attachment_path: null,
                                edited_alias: aliasChanges.join("; "),
                                processed: false,
                                created_at: "NOW()",
                                edited_by: userName,
                            };

                            const [reqEditQuery, reqEditValues] =
                                Crud.insertItem("mat_reqedit", reqEditInsert);

                            await client.query(reqEditQuery, reqEditValues);
                        }
                    }

                    await client.query("COMMIT");

                    return {
                        materialId,
                        alias1: alias1 || null,
                        alias2: alias2 || null,
                        alias3: alias3 || null,
                        updated: true,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error updating aliases:", error);
            throw error;
        }
    },

    deleteAttachment: async (attachmentId, updatedBy) => {
        try {
            return await DBClientWrapper(async client => {
                // Begin transaction
                await client.query("BEGIN");

                try {
                    // Get attachment details to get the file path
                    const attachmentQuery = await client.query(
                        "SELECT id, material_id, attachment FROM mat_attachment WHERE id = $1",
                        [attachmentId]
                    );

                    if (attachmentQuery.rows.length === 0) {
                        throw new Error("Attachment not found");
                    }

                    const attachment = attachmentQuery.rows[0];
                    const materialId = attachment.material_id;
                    const filename = attachment.attachment;

                    // Delete the attachment from the database
                    await client.query(
                        "DELETE FROM mat_attachment WHERE id = $1",
                        [attachmentId]
                    );

                    // Update the material's updated_at timestamp
                    await client.query(
                        "UPDATE mat_sap_data SET updated_at = NOW(), updated_by = $1 WHERE id = $2",
                        [updatedBy || null, materialId]
                    );

                    // Commit transaction
                    await client.query("COMMIT");

                    // Try to delete the file from disk (but don't fail if this fails)
                    try {
                        const publicDir = path.join(
                            path.resolve(),
                            "./backend/public"
                        );
                        const filePath = path.join(publicDir, filename);

                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    } catch (fileError) {
                        console.error(
                            "Error deleting attachment file:",
                            fileError
                        );
                        // Don't throw here, we've already committed the DB changes
                    }

                    return {
                        success: true,
                        materialId,
                        attachmentId,
                    };
                } catch (error) {
                    // Rollback transaction on error
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error deleting attachment:", error);
            throw error;
        }
    },

    // Export only groups to Excel
    exportOnlyGroupsToExcel: async () => {
        try {
            return await DBClientWrapper(async client => {
                // Query to get all groups
                const groupsResult = await client.query(`
                    SELECT
                        id,
                        code as group_code,
                        name as group_name
                    FROM mat_item_group
                    ORDER BY code
                `);

                // Create the export data for the "Groups" sheet
                const groupsData = groupsResult.rows.map(group => ({
                    "Group Code": group.group_code,
                    "Group Name": group.group_name,
                }));

                // Create a new workbook
                const workbook = xlsx.utils.book_new();

                // Add Groups worksheet
                const groupsWorksheet = xlsx.utils.json_to_sheet(groupsData);
                xlsx.utils.book_append_sheet(
                    workbook,
                    groupsWorksheet,
                    "Groups"
                );

                // Create buffer
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });

                return buffer;
            });
        } catch (error) {
            console.error("Error exporting groups to Excel:", error);
            throw error;
        }
    },

    // Export only subgroups to Excel
    exportOnlySubgroupsToExcel: async (groupId = null) => {
        try {
            return await DBClientWrapper(async client => {
                // Build the query based on whether we have a group ID
                let queryText;
                let queryParams = [];

                if (groupId) {
                    queryText = `
                        SELECT
                            s.id,
                            s.code as subgroup_code,
                            s.name as subgroup_name,
                            s.item_group_id,
                            g.code as group_code,
                            g.name as group_name
                        FROM mat_item_sub_group s
                        JOIN mat_item_group g ON s.item_group_id = g.id
                        WHERE s.item_group_id = $1
                        ORDER BY s.code
                    `;
                    queryParams.push(groupId);
                } else {
                    queryText = `
                        SELECT
                            s.id,
                            s.code as subgroup_code,
                            s.name as subgroup_name,
                            s.item_group_id,
                            g.code as group_code,
                            g.name as group_name
                        FROM mat_item_sub_group s
                        JOIN mat_item_group g ON s.item_group_id = g.id
                        ORDER BY g.code, s.code
                    `;
                }

                const subgroupsResult = await client.query(
                    queryText,
                    queryParams
                );

                // Create the export data for the "Subgroups" sheet
                const subgroupsData = subgroupsResult.rows.map(subgroup => ({
                    "Subgroup Code": subgroup.subgroup_code,
                    "Subgroup Name": subgroup.subgroup_name,
                    "Group Code": subgroup.group_code,
                    "Group Name": subgroup.group_name,
                }));

                // Create a new workbook
                const workbook = xlsx.utils.book_new();

                // Add Subgroups worksheet
                const subgroupsWorksheet =
                    xlsx.utils.json_to_sheet(subgroupsData);
                xlsx.utils.book_append_sheet(
                    workbook,
                    subgroupsWorksheet,
                    "Subgroups"
                );

                // Create buffer
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });

                return buffer;
            });
        } catch (error) {
            console.error("Error exporting subgroups to Excel:", error);
            throw error;
        }
    },

    // Import only groups from Excel
    importOnlyGroupsFromExcel: async (fileBuffer, userId) => {
        let client;
        try {
            // Get a client from the pool directly instead of using DBClientWrapper
            client = await db.connect();

            // Begin transaction
            await client.query("BEGIN");

            try {
                // Parse Excel file
                const workbook = xlsx.read(fileBuffer, { type: "buffer" });

                // Check if Groups sheet exists
                if (!workbook.SheetNames.includes("Groups")) {
                    throw new Error("Excel file must contain a 'Groups' sheet");
                }

                // Get Groups sheet data
                const groupsSheet = workbook.Sheets["Groups"];
                const groupsData = xlsx.utils.sheet_to_json(groupsSheet);

                // Statistics for operation
                const stats = {
                    total: groupsData.length,
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: [],
                };

                // Process each group in a try-catch block to prevent one error from failing the entire transaction
                for (const group of groupsData) {
                    try {
                        // Try multiple possible column naming formats since Excel exports can be inconsistent
                        // Check if column name is different than expected
                        const code = String(
                            group["Group Code"] ||
                                group["group_code"] ||
                                group["GroupCode"] ||
                                group["groupCode"] ||
                                group["group code"] ||
                                group["code"] ||
                                ""
                        ).trim();

                        const name = String(
                            group["Group Name"] ||
                                group["group_name"] ||
                                group["GroupName"] ||
                                group["groupName"] ||
                                group["group name"] ||
                                group["name"] ||
                                ""
                        ).trim();

                        // Skip empty rows
                        if (!code && !name) {
                            stats.skipped++;
                            continue;
                        }

                        // Validate required fields
                        if (!code || !name) {
                            throw new Error(
                                `Missing required fields. Group Code: ${code}, Group Name: ${name}`
                            );
                        }

                        // Check if group already exists
                        const existingGroup = await client.query(
                            "SELECT id FROM mat_item_group WHERE code = $1",
                            [code]
                        );

                        const now = new Date();

                        if (existingGroup.rows.length > 0) {
                            // Update existing group
                            const groupId = existingGroup.rows[0].id;
                            await client.query(
                                `UPDATE mat_item_group
                                SET name = $1, updated_at = $2, updated_by = $3
                                WHERE id = $4`,
                                [name, now, userId, groupId]
                            );
                            stats.updated++;
                        } else {
                            await client.query(
                                `INSERT INTO mat_item_group (code, name, created_at, updated_at, created_by, updated_by)
                                VALUES ($1, $2, $3, $4, $5, $6)
                                RETURNING id`,
                                [code, name, now, now, userId, userId]
                            );
                            stats.created++;
                        }
                    } catch (error) {
                        // Log the error but continue processing other groups
                        stats.errors.push({
                            row: JSON.stringify(group),
                            error: error.message,
                        });
                    }
                }

                // Commit transaction only if there were no errors or if some records were successful
                if (
                    stats.errors.length === 0 ||
                    stats.created > 0 ||
                    stats.updated > 0
                ) {
                    await client.query("COMMIT");
                } else {
                    // Rollback if nothing was processed successfully
                    await client.query("ROLLBACK");
                }

                return stats;
            } catch (error) {
                // Ensure rollback happens on any error
                if (client) {
                    await client.query("ROLLBACK");
                }
                throw error;
            }
        } catch (error) {
            throw error;
        } finally {
            // Always release the client back to the pool
            if (client) {
                client.release();
            }
        }
    },

    // Import only subgroups from Excel
    importOnlySubgroupsFromExcel: async (fileBuffer, userId) => {
        let client;
        try {
            // Get a client from the pool directly instead of using DBClientWrapper
            client = await db.connect();

            // Begin transaction
            await client.query("BEGIN");

            try {
                // Parse Excel file
                const workbook = xlsx.read(fileBuffer, { type: "buffer" });

                // Check if Subgroups sheet exists
                if (!workbook.SheetNames.includes("Subgroups")) {
                    throw new Error(
                        "Excel file must contain a 'Subgroups' sheet"
                    );
                }

                // Get Subgroups sheet data
                const subgroupsSheet = workbook.Sheets["Subgroups"];
                const subgroupsData = xlsx.utils.sheet_to_json(subgroupsSheet);

                // Statistics for operation
                const stats = {
                    total: subgroupsData.length,
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: [],
                };

                // Get all existing groups for validation
                const groupsResult = await client.query(
                    "SELECT id, code FROM mat_item_group"
                );
                const groupCodeToIdMap = new Map();
                groupsResult.rows.forEach(group => {
                    groupCodeToIdMap.set(group.code, group.id);
                });

                // Process each subgroup in a try-catch block to prevent one error from failing the entire transaction
                for (const subgroup of subgroupsData) {
                    try {
                        // Extract and validate data
                        const code = String(
                            subgroup["Subgroup Code"] || ""
                        ).trim();
                        const name = String(
                            subgroup["Subgroup Name"] || ""
                        ).trim();
                        const groupCode = String(
                            subgroup["Group Code"] || ""
                        ).trim();

                        // Skip empty rows
                        if (!code && !name) {
                            stats.skipped++;
                            continue;
                        }

                        // Validate required fields
                        if (!code || !name || !groupCode) {
                            throw new Error(
                                `Missing required fields. Subgroup Code: ${code}, Subgroup Name: ${name}, Group Code: ${groupCode}`
                            );
                        }

                        // Find the group ID from the map
                        if (!groupCodeToIdMap.has(groupCode)) {
                            throw new Error(
                                `Group with code ${groupCode} not found. Make sure it exists in the database before importing subgroups.`
                            );
                        }

                        const groupId = groupCodeToIdMap.get(groupCode);

                        // Check if subgroup already exists in this group
                        const existingSubgroup = await client.query(
                            "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2",
                            [code, groupId]
                        );

                        const now = new Date();

                        if (existingSubgroup.rows.length > 0) {
                            // Update existing subgroup
                            const subgroupId = existingSubgroup.rows[0].id;
                            await client.query(
                                `UPDATE mat_item_sub_group
                                SET name = $1, updated_at = $2, updated_by = $3
                                WHERE id = $4`,
                                [name, now, userId, subgroupId]
                            );
                            stats.updated++;
                        } else {
                            // Create new subgroup
                            await client.query(
                                `INSERT INTO mat_item_sub_group (code, name, item_group_id, created_at, updated_at, created_by, updated_by)
                                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [code, name, groupId, now, now, userId, userId]
                            );
                            stats.created++;
                        }
                    } catch (error) {
                        // Log the error but continue processing other subgroups
                        stats.errors.push({
                            row: JSON.stringify(subgroup),
                            error: error.message,
                        });
                    }
                }

                // Commit transaction only if there were no errors or if some records were successful
                if (
                    stats.errors.length === 0 ||
                    stats.created > 0 ||
                    stats.updated > 0
                ) {
                    await client.query("COMMIT");
                } else {
                    // Rollback if nothing was processed successfully
                    await client.query("ROLLBACK");
                }

                return stats;
            } catch (error) {
                // Ensure rollback happens on any error
                if (client) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        console.error("Error during rollback:", rollbackError);
                    }
                }
                throw error;
            }
        } catch (error) {
            console.error("Error importing subgroups from Excel:", error);
            throw error;
        } finally {
            // Always release the client back to the pool
            if (client) {
                client.release();
            }
        }
    },

    // Get full material details and attachments for materials by array of codes
    getAttachmentsByCodes: async codes => {
        try {
            return await DBClientWrapper(async client => {
                if (!Array.isArray(codes) || codes.length === 0) return [];
                // Fetch materials by codes
                const materialRes = await client.query(
                    `                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.long_text,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient, CASE WHEN m.dfFromClient THEN 'Inactive' ELSE 'Active' END AS status, u.fullname AS "user_fullname", mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE m.code = ANY($1)`,
                    [codes]
                );
                const idToMaterial = {};
                materialRes.rows.forEach(row => {
                    idToMaterial[row.id] = { ...row, attachments: [] };
                });
                const ids = materialRes.rows.map(row => row.id);
                if (ids.length === 0) return [];
                // Fetch attachments for these materials
                const attachRes = await client.query(
                    `SELECT material_id, id, attachment, type FROM mat_attachment WHERE material_id = ANY($1)`,
                    [ids]
                );
                attachRes.rows.forEach(att => {
                    if (idToMaterial[att.material_id]) {
                        idToMaterial[att.material_id].attachments.push({
                            id: att.id,
                            attachment: att.attachment,
                            type: att.type,
                        });
                    }
                });
                // Return as array of material objects (with attachments)
                return Object.values(idToMaterial);
            });
        } catch (error) {
            console.error("Error fetching material details by codes:", error);
            throw error;
        }
    },

    // Export materials to Excel (filtered by group/subgroup or search query)
    exportMaterialsToExcel: async (groupId, subGroupId, searchTerm) => {
        try {
            return await DBClientWrapper(async client => {
                let materialsQueryResult = [];
                let groupCode = null;
                let subGroupCode = null;
                if (searchTerm && searchTerm.trim() !== "") {
                    const safeSearchTerm = String(searchTerm || "").trim();
                    const wildcard = parseWildcardSearch(safeSearchTerm);

                    const searchableFields = [
                        "m.code",
                        "m.name",
                        "COALESCE(m.description, '')",
                        "COALESCE(m.long_text, '')",
                        "COALESCE(m.unit_of_measurement, '')",
                        "COALESCE(m.alias1, '')",
                        "COALESCE(m.alias2, '')",
                        "COALESCE(m.alias3, '')",
                    ];

                    let result;
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ORDER BY m.code ASC, m.name ASC`,
                            [...wildcard.segments]
                        );
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )
                            ORDER BY m.code ASC, m.name ASC`,
                            [tsQuery, safeSearchTerm]
                        );
                    }
                    materialsQueryResult = result.rows;
                } else {
                    let query = `
                        SELECT
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            mig.code as group_code,
                            mig.name as group_name,
                            mis.code as subgroup_code,
                            mis.name as subgroup_name,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.created_at,
                            m.updated_at
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    `;
                    const params = [];
                    let where = [];
                    if (subGroupId) {
                        where.push("mis.id = $" + (params.length + 1));
                        params.push(subGroupId);
                        // Fetch subgroup code and its parent group code
                        const subRes = await client.query(
                            "SELECT code, item_group_id FROM mat_item_sub_group WHERE id = $1",
                            [subGroupId]
                        );
                        if (subRes.rows.length > 0) {
                            subGroupCode = subRes.rows[0].code;
                            const groupIdFromSub = subRes.rows[0].item_group_id;
                            if (groupIdFromSub) {
                                const groupRes = await client.query(
                                    "SELECT code FROM mat_item_group WHERE id = $1",
                                    [groupIdFromSub]
                                );
                                if (groupRes.rows.length > 0)
                                    groupCode = groupRes.rows[0].code;
                            }
                        }
                    } else if (groupId) {
                        where.push("mig.id = $" + (params.length + 1));
                        params.push(groupId);
                        // Fetch group code
                        const groupRes = await client.query(
                            "SELECT code FROM mat_item_group WHERE id = $1",
                            [groupId]
                        );
                        if (groupRes.rows.length > 0)
                            groupCode = groupRes.rows[0].code;
                    }
                    if (where.length > 0) {
                        query += " WHERE " + where.join(" AND ");
                    }
                    query += " ORDER BY m.code ASC, m.name ASC";
                    const result = await client.query(query, params);
                    materialsQueryResult = result.rows;
                }
                // Prepare data for Excel
                const materialsData = materialsQueryResult.map(row => {
                    let desc =
                        row.description && row.long_text
                            ? `${row.description} - ${row.long_text}`
                            : row.description || row.long_text || "";
                    // Remove carriage returns and newlines
                    desc = desc.replace(/\r\n|\r|\n/g, " ");
                    return {
                        Code: row.code,
                        Description: desc,
                        UOM: row.unit_of_measurement || "",
                        "Group Code": row.group_code || row.groupCode,
                        "Group Name": row.group_name || row.groupName,
                        "Subgroup Code": row.subgroup_code || row.subGroupCode,
                        "Subgroup Name": row.subgroup_name || row.subGroupName,
                        "Alias 1": row.alias1,
                        "Alias 2": row.alias2,
                        "Alias 3": row.alias3,
                        "Created At": row.created_at
                            ? row.created_at
                                  .toISOString()
                                  .slice(0, 19)
                                  .replace("T", " ")
                            : "",
                        "Updated At": row.updated_at
                            ? row.updated_at
                                  .toISOString()
                                  .slice(0, 19)
                                  .replace("T", " ")
                            : "",
                    };
                });
                const workbook = xlsx.utils.book_new();
                const worksheet = xlsx.utils.json_to_sheet(materialsData);
                const wscols = [
                    { wch: 20 }, // Code
                    { wch: 35 }, // Name
                    { wch: 60 }, // Description
                    { wch: 10 }, // UOM
                    { wch: 15 }, // Group Code
                    { wch: 25 }, // Group Name
                    { wch: 15 }, // Subgroup Code
                    { wch: 25 }, // Subgroup Name
                    { wch: 20 }, // Alias 1
                    { wch: 20 }, // Alias 2
                    { wch: 20 }, // Alias 3
                    { wch: 22 }, // Created At
                    { wch: 22 }, // Updated At
                ];
                worksheet["!cols"] = wscols;
                const rowCount = materialsData.length + 1; // +1 for header
                worksheet["!rows"] = Array.from({ length: rowCount }, () => ({
                    hpt: 22,
                }));
                xlsx.utils.book_append_sheet(workbook, worksheet, "Materials");
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });
                return { buffer, groupCode, subGroupCode };
            });
        } catch (error) {
            console.error("Error exporting materials to Excel:", error);
            throw error;
        }
    },

    // SAP Data Synchronization job (for cron/manual use)
    syncSAPDataJob: async ({ startDate, endDate, fieldName = "LAEDA" }) => {
        try {
            // Validate required parameters
            if (!startDate || !endDate) {
                throw new Error(
                    "startDate and endDate are required (format: YYYYMMDD)"
                );
            }
            if (!["ERSDA", "LAEDA"].includes(fieldName)) {
                throw new Error("fieldName must be either 'ERSDA' or 'LAEDA'");
            }
            const dateRegex = /^\d{8}$/;
            if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
                throw new Error("Dates must be in YYYYMMDD format");
            }
            console.log(
                `[SAP Sync] Starting: ${fieldName} from ${startDate} to ${endDate}`
            );
            // Configure axios instance with correct credentials
            const sapClient = axios.create({
                headers: {
                    Authorization: `Basic ${Buffer.from(
                        `${process.env.SAP_API_CREDENTIALS}`
                    ).toString("base64")}`,
                    "Content-Type": "application/json",
                },
                timeout: 30000,
            });
            // Fetch data from SAP
            // const SAP_URL = `http://erpdev-gm.gamasap.com:8000/sap/opu/odata/sap/ZMM_MATERIAL_MASTER_SRV/MATERIALSet?$filter=(${fieldName} gt '${startDate}')and(${fieldName} lt '${endDate}')&$format=json`;

            const SAP_URL = `${process.env.ODATADOM}:${process.env.ODATAPORT}/sap/opu/odata/sap/ZMM_MATERIAL_MASTER_SRV/MATERIALSet?$filter=(${fieldName} gt '${startDate}')and(${fieldName} lt '${endDate}')&$format=json`;

            const response = await sapClient.get(SAP_URL);
            const results = response.data.d.results;
            console.log(
                `[SAP Sync] Retrieved ${results.length} records from SAP`
            );
            // Filter valid items (starting with 9)
            const validItems = [];
            let skippedNotStartsWith9 = 0;
            for (const item of results) {
                if (!item.MATNR.startsWith("9")) {
                    skippedNotStartsWith9++;
                    continue;
                }
                validItems.push(item);
            }
            console.log(
                `[SAP Sync] Valid items: ${validItems.length}, Skipped: ${skippedNotStartsWith9}`
            );
            // Process database operations
            const dbStats = {
                inserted: 0,
                updated: 0,
                failed: 0,
                total: validItems.length,
            };
            for (const item of validItems) {
                const result = await saveToDatabase(item, pool);
                if (result.success) {
                    if (result.action === "inserted") {
                        dbStats.inserted++;
                    } else {
                        dbStats.updated++;
                    }
                } else {
                    dbStats.failed++;
                    console.error(
                        `[SAP Sync] Failed: ${result.materialId} - ${result.error}`
                    );
                }
            }
            const successRate = (
                ((dbStats.inserted + dbStats.updated) / (dbStats.total || 1)) *
                100
            ).toFixed(2);
            const summary = {
                sapRecords: results.length,
                validRecords: validItems.length,
                skippedNotStartsWith9,
                database: {
                    inserted: dbStats.inserted,
                    updated: dbStats.updated,
                    failed: dbStats.failed,
                    successRate: `${successRate}%`,
                },
                parameters: {
                    fieldName,
                    startDate,
                    endDate,
                },
            };
            console.log("[SAP Sync] Summary:", summary);
            return {
                success: true,
                message: "SAP data synchronization completed",
                data: summary,
            };
        } catch (error) {
            console.error("[SAP Sync] Error:", error);
            return { success: false, message: error.message, error };
        }
    },

    getMaterialGroupByCode: async materialGroupCode => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT id, code, name
                     FROM mat_item_group
                     WHERE code = $1
                       AND deleted_at IS NULL`,
                    [materialGroupCode]
                );

                return result.rows[0] || null;
            });
        } catch (error) {
            console.error("Error fetching material group by code:", error);
            throw error;
        }
    },

    // Get group by ID (for validation)
    getGroupById: async groupId => {
        try {
            return await DBClientWrapper(async client => {
                const res = await client.query(
                    "SELECT id, code, name, deleted_at FROM mat_item_group WHERE id = $1",
                    [groupId]
                );
                return res.rows[0] || null;
            });
        } catch (error) {
            console.error("Error fetching group by ID:", error);
            throw error;
        }
    },

    // Get subgroup by ID (for validation)
    getSubGroupById: async subGroupId => {
        try {
            return await DBClientWrapper(async client => {
                const res = await client.query(
                    `SELECT
                        mis.id,
                        mis.code AS subgroup_code,
                        mis.deleted_at,
                        mis.item_group_id,
                        mig.code AS group_code
                    FROM mat_item_sub_group mis
                    JOIN mat_item_group mig ON mig.id = mis.item_group_id
                    WHERE mis.id = $1`,
                    [subGroupId]
                );
                return res.rows[0] || null;
            });
        } catch (error) {
            console.error("Error fetching subgroup by ID:", error);
            throw error;
        }
    },

    // Soft delete a material (set dffromclient = true)
    deleteMaterial: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                await client.query(
                    "UPDATE mat_sap_data SET dffromclient = true WHERE id = $1 AND (dffromclient IS NULL OR dffromclient = false)",
                    [materialId]
                );
                return { id: materialId, deleted: true };
            });
        } catch (error) {
            s;
            console.error("Error soft deleting material:", error);
            throw error;
        }
    },

    EmailNotificationEditMaterial: async target_clock => {
        return DBClientWrapper(async client => {
            try {
                await client.query(TRANS.BEGIN);
                console.log(
                    `[CRON] Running material edit notification for ${target_clock} PM batch`
                );
                // Get all unprocessed material edits
                const result = await client.query(
                    `SELECT id, material_code, material_name, attachment_path, edited_alias, edited_by, created_at
                                 FROM mat_reqedit
                                 WHERE processed = false
                                 ORDER BY created_at DESC`
                );

                const { rows: getHostname } = await client.query(
                    "SELECT hostname from hostname where mode_env = $1",
                    [process.env.NODE_ENV]
                );

                const hostname = getHostname[0].hostname;

                const userData = await client.query(
                    `SELECT STRING_AGG(DISTINCT mu.email, ',') as emails
                                 FROM mst_user mu
                                 JOIN mst_page_access mpa ON mpa.user_group_id = mu.user_group
                                 WHERE mpa.user_group_name = 'MDM_MATERIAL'`
                );

                if (result.rows.length > 0) {
                    // Send email notification
                    await Emailer.materialEditNotification(
                        result.rows,
                        `${target_clock} PM Batch`,
                        hostname,
                        userData.rows[0]?.emails
                    );

                    // Mark records as processed
                    const materialIds = result.rows.map(row => row.id);
                    await client.query(
                        `UPDATE mat_reqedit
                                         SET processed = true, processed_at = $2
                                         WHERE id = ANY($1)`,
                        [
                            materialIds,
                            moment()
                                .tz("Asia/Jakarta")
                                .format("YYYY-MM-DD HH:mm:ss+0700"),
                        ]
                    );

                    console.log(
                        `[CRON] ${target_clock} PM batch: Sent email for ${result.rows.length} material edits`
                    );
                } else {
                    console.log(
                        `[CRON] ${target_clock} PM batch: No material edits to process`
                    );
                }
                await client.query(TRANS.COMMIT);
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            }
        });
    },

    getLocationAndPlant: async () => {
        try {
            // Plant & storage-location options come from MDM master data
            // (mst_plant / mst_storage_location), which carry the descriptions.
            // plant_code + storage_location are what the UI binds to; plant_id /
            // warehouse_id are kept for backward compatibility with the response shape.
            const query = `
            SELECT
                sl.id          AS warehouse_id,
                sl.sloc_code   AS storage_location,
                p.id           AS plant_id,
                p.plant_code   AS plant_code,
                p.description  AS plant_description,
                sl.description AS sloc_description
            FROM public.mst_plant p
            LEFT JOIN public.mst_storage_location sl ON sl.plant_code = p.plant_code
            ORDER BY p.plant_code, sl.sloc_code
        `;
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error("Error in MaterialModel:", error);
            throw error;
        }
    },

    getMaterialTypes: async () => {
        try {
            // Mengambil Material Type dari item group
            const query = `SELECT id, code, name FROM mat_item_group WHERE deleted_at IS NULL`;
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error("Error fetching material types:", error);
            throw error;
        }
    },

    getUomMaster: async () => {
        try {
            const query = `SELECT uom_code, description FROM public.mst_uom ORDER BY uom_code`;
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error("Error in MaterialModel.getUomMaster:", error);
            throw error;
        }
    },

    getPlantMaster: async () => {
        try {
            const query = `SELECT plant_code, description, name2, city FROM public.mst_plant ORDER BY plant_code`;
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error("Error in MaterialModel.getPlantMaster:", error);
            throw error;
        }
    },

    getStorageLocationMaster: async () => {
        try {
            const query = `SELECT company_code, plant_code, sloc_code, description FROM public.mst_storage_location ORDER BY plant_code, sloc_code`;
            const result = await pool.query(query);
            return result.rows;
        } catch (error) {
            console.error("Error in MaterialModel.getStorageLocationMaster:", error);
            throw error;
        }
    },

    getRandomMdmMaterialUser: async () => {
        try {
            return await DBClientWrapper(async client => {
                return getRandomMdmMaterialUser(client);
            });
        } catch (error) {
            console.error("Error fetching random MDM material user:", error);
            throw error;
        }
    },

    assignSingleRequestApproval3FromMdm: async ({ requestId }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );
                    const activeStage =
                        resolveSingleRequestApprovalStage(snapshot);

                    if (activeStage !== "Approval 3") {
                        throw buildSingleRequestApprovalError(
                            "Approval 3 can only be assigned while the request is actively waiting for Approval 3",
                            409,
                            "SINGLE_REQUEST_APPROVAL_CONFLICT"
                        );
                    }

                    const mdmUser = await getRandomMdmMaterialUser(client);

                    if (!mdmUser) {
                        throw buildSingleRequestApprovalError(
                            "No active MDM_MATERIAL user found",
                            404,
                            "SINGLE_REQUEST_APPROVAL_NO_MDM_USER"
                        );
                    }

                    const autoAssignedApproval3 = buildAutoAssignedApproval3({
                        approval3UserId: mdmUser.user_id,
                    });

                    const approvalResult = await client.query(
                        `UPDATE mat_single_request
                        SET approval_3_user_id = $2,
                            approval_3_status = $3,
                            updated_at = NOW()
                        WHERE id = $1
                            AND approval_1_status = 'APPROVED'
                            AND approval_2_status = 'APPROVED'
                            AND (approval_3_status IS NULL OR approval_3_status = 'WAITING')
                        RETURNING
                            id AS request_id,
                            created_by AS requester_user_id,
                            approval_1_user_id,
                            approval_1_status,
                            approval_1_at,
                            approval_1_remark,
                            approval_2_user_id,
                            approval_2_status,
                            approval_2_at,
                            approval_2_remark,
                            approval_3_user_id,
                            approval_3_status,
                            approval_3_at,
                            approval_3_remark`,
                        [
                            requestId,
                            autoAssignedApproval3.approval_3_user_id,
                            autoAssignedApproval3.approval_3_status,
                        ]
                    );

                    if (approvalResult.rows.length === 0) {
                        throw buildSingleRequestApprovalError(
                            "Approval 3 can only be assigned while the request is actively waiting for Approval 3",
                            409,
                            "SINGLE_REQUEST_APPROVAL_CONFLICT"
                        );
                    }

                    await syncSingleRequestApprovalSnapshot(
                        client,
                        requestId,
                        approvalResult.rows[0],
                        autoAssignedApproval3.assigned_to
                    );

                    await client.query("COMMIT");

                    return {
                        ...approvalResult.rows[0],
                        mdm_user: mdmUser,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error(
                "Error assigning approval 3 from MDM material:",
                error
            );
            throw error;
        }
    },

    // Per-request approver retarget (ADMIN). In the step model the approver for
    // each MANUAL stage lives on that stage's step row, so this best-effort
    // updates the matching manual step's approver_user_id while it is still
    // WAITING. approval1UserId -> manual level 1, approval2UserId -> level 2.
    assignSingleRequestApproversByAdmin: async (payload = {}) => {
        const { requestId, actorUsername } = payload;

        try {
            if (!isAdminMaterialApprover(actorUsername)) {
                throw buildSingleRequestApprovalError(
                    "Forbidden: single request approver assignment is only available for ADMIN",
                    403,
                    "SINGLE_REQUEST_APPROVER_ASSIGNMENT_FORBIDDEN"
                );
            }

            // Map the controller payload to manual step levels (best-effort).
            const levelAssignments = [];
            if (
                Object.prototype.hasOwnProperty.call(payload, "approval1UserId")
            ) {
                levelAssignments.push({
                    level: 1,
                    approverUserId: payload.approval1UserId ?? null,
                });
            }
            if (
                Object.prototype.hasOwnProperty.call(payload, "approval2UserId")
            ) {
                levelAssignments.push({
                    level: 2,
                    approverUserId: payload.approval2UserId ?? null,
                });
            }

            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId,
                            {
                                beforeBackfill:
                                    assertSingleRequestAssignableStatus,
                            }
                        );
                    assertSingleRequestAssignableStatus(snapshot);

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );

                    for (const { level, approverUserId } of levelAssignments) {
                        const step = steps.find(
                            candidate =>
                                Number(candidate.level) === Number(level) &&
                                candidate.kind === STEP_KINDS.MANUAL
                        );

                        // Only retarget a manual stage that has not yet acted.
                        if (
                            !step ||
                            normalizeStepStatus(step.status) !== "WAITING"
                        ) {
                            continue;
                        }

                        await updateSingleRequestStepRow(client, step.id, {
                            approver_user_id: approverUserId,
                        });
                    }

                    const refreshedSteps = await loadSingleRequestSteps(
                        client,
                        requestId
                    );

                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        ...buildStepsPayload(refreshedSteps),
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error(
                "Error assigning single request approvers by admin:",
                error
            );
            throw error;
        }
    },

    // MDM grab (single request): an active MDM_MATERIAL user atomically claims
    // the open Master Data step. Single-winner via approver_user_id IS NULL.
    claimSingleRequestMdmStepByUser: async ({
        requestId,
        actorUserId,
        actorUsername,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const actorIsMdmMaterial = await isActorMdmMaterialUser(
                        client,
                        actorUserId
                    );

                    if (!actorIsMdmMaterial) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only an active MDM_MATERIAL user can claim the Master Data step",
                            403,
                            "SINGLE_REQUEST_MDM_CLAIM_FORBIDDEN"
                        );
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep || activeStep.kind !== STEP_KINDS.MDM) {
                        throw buildSingleRequestApprovalError(
                            "Master Data step is not currently open for this request",
                            409,
                            "SINGLE_REQUEST_MDM_STEP_NOT_ACTIVE"
                        );
                    }

                    const won = await claimMdmSingleRequestStep(
                        client,
                        activeStep.id,
                        actorUserId
                    );

                    if (!won) {
                        throw buildSingleRequestApprovalError(
                            "Master Data step has already been claimed",
                            409,
                            "ALREADY_CLAIMED"
                        );
                    }

                    const refreshedSteps = await loadSingleRequestSteps(
                        client,
                        requestId
                    );

                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        ...buildStepsPayload(refreshedSteps),
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error(
                "Error claiming single request Master Data step:",
                error
            );
            throw error;
        }
    },

    // MDM grab (mass request): claims the open Master Data step across ALL items
    // of the batch in one UPDATE (single winner via approver_user_id IS NULL).
    claimMassRequestMdmStepByUser: async ({
        massRequestId,
        actorUserId,
        actorUsername,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const actorIsMdmMaterial = await isActorMdmMaterialUser(
                        client,
                        actorUserId
                    );

                    if (!actorIsMdmMaterial) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only an active MDM_MATERIAL user can claim the Master Data step",
                            403,
                            "MASS_REQUEST_MDM_CLAIM_FORBIDDEN"
                        );
                    }

                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );

                    if (firstItemSteps.length === 0) {
                        throw buildSingleRequestApprovalError(
                            "Mass request not found",
                            404,
                            "MASS_REQUEST_NOT_FOUND"
                        );
                    }

                    const activeStep = resolveActiveStep(firstItemSteps);

                    if (!activeStep || activeStep.kind !== STEP_KINDS.MDM) {
                        throw buildSingleRequestApprovalError(
                            "Master Data step is not currently open for this mass request",
                            409,
                            "MASS_REQUEST_MDM_STEP_NOT_ACTIVE"
                        );
                    }

                    const won = await claimMdmMassItemStep(
                        client,
                        massRequestId,
                        activeStep.level,
                        actorUserId
                    );

                    if (!won) {
                        throw buildSingleRequestApprovalError(
                            "Master Data step has already been claimed",
                            409,
                            "ALREADY_CLAIMED"
                        );
                    }

                    const refreshedSteps = await loadMassItemSteps(
                        client,
                        massRequestId
                    );

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        ...mapMassStepRowsToPayload(refreshedSteps),
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error(
                "Error claiming mass request Master Data step:",
                error
            );
            throw error;
        }
    },

    approveSingleRequestByAdmin: async ({
        requestId,
        actorUserId,
        actorUsername,
        remark,
        editedRequest,
        finalCodeSuffix,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // --- Step-based routing (dynamic approver flow) ---
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );
                    const normalizedTicketType =
                        normalizeSingleRequestTicketType(snapshot.ticket_type);
                    const safeRemark = remark ?? null;
                    const currentChangeExtendReason =
                        snapshot.change_extend_reason ?? null;
                    const editablePatch =
                        await prepareSingleRequestApprovalEditPatch({
                            snapshot,
                            editedRequest,
                            getSubGroupById: Material.getSubGroupById,
                            validateMaterialRequestTemplate:
                                MaterialTemplate.validateMaterialRequestTemplate,
                        });

                    const steps = await loadSingleRequestSteps(client, requestId, {
                        forUpdate: true,
                    });
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw buildSingleRequestApprovalError(
                            "Single request is already processed or not waiting for approval",
                            409,
                            "SINGLE_REQUEST_APPROVAL_CONFLICT"
                        );
                    }

                    const activeStepLabel = stepLabel(activeStep);
                    const isMdmStep = activeStep.kind === STEP_KINDS.MDM;
                    const actorIsMdmMaterial = isMdmStep
                        ? await isActorMdmMaterialUser(client, actorUserId)
                        : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only the assigned approver or ADMIN can approve this request",
                            403,
                            "SINGLE_REQUEST_APPROVAL_FORBIDDEN"
                        );
                    }

                    if (
                        shouldPersistSingleRequestEditHistory(
                            normalizedTicketType
                        ) &&
                        Object.keys(editablePatch).length > 0
                    ) {
                        try {
                            await client.query(
                                `INSERT INTO mat_single_request_edit_history (
                                    request_id,
                                    request_no,
                                    approval_stage,
                                    approved_by_user_id,
                                    approve_remark,
                                    approved_at,
                                    material_group_id,
                                    material_sub_group_id,
                                    plant_code,
                                    sloc_code,
                                    material_description,
                                    base_uom,
                                    long_text_1,
                                    long_text_2,
                                    long_text_3,
                                    template_payload,
                                    created_by,
                                    created_at
                                ) VALUES (
                                    $1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
                                )`,
                                [
                                    snapshot.request_id,
                                    snapshot.request_no,
                                    activeStepLabel,
                                    actorUserId ?? null,
                                    safeRemark,
                                    snapshot.material_group_id ?? null,
                                    snapshot.material_sub_group_id ?? null,
                                    snapshot.plant_code ?? null,
                                    snapshot.sloc_code ?? null,
                                    snapshot.material_description ?? null,
                                    snapshot.base_uom ?? null,
                                    snapshot.long_text_1 ?? null,
                                    snapshot.long_text_2 ?? null,
                                    snapshot.long_text_3 ?? null,
                                    snapshot.template_payload ?? null,
                                    snapshot.created_by ?? null,
                                    snapshot.created_at ?? null,
                                ]
                            );
                        } catch (historyError) {
                            if (
                                isMissingSingleRequestEditHistoryTableError(
                                    historyError
                                )
                            ) {
                                console.warn(
                                    `mat_single_request_edit_history is missing; skipping edit history insert for request ${requestId}`
                                );
                            } else {
                                throw historyError;
                            }
                        }
                    }

                    if (Object.keys(editablePatch).length > 0) {
                        const editablePatchFields = Object.keys(editablePatch);
                        const assignments = editablePatchFields.map(
                            (field, index) => `${field} = $${index + 2}`
                        );

                        await client.query(
                            `UPDATE mat_single_request
                            SET ${assignments.join(", ")},
                                updated_at = NOW()
                            WHERE id = $1`,
                            [
                                requestId,
                                ...editablePatchFields.map(
                                    field => editablePatch[field]
                                ),
                            ]
                        );
                    }

                    const nextSnapshot = {
                        ...snapshot,
                        ...editablePatch,
                        change_extend_reason:
                            editablePatch.change_extend_reason ??
                            currentChangeExtendReason,
                    };
                    const materialCode =
                        resolveSingleRequestMaterialCode(nextSnapshot);

                    // Change/Extend SAP-update only fires on the final (MDM) step.
                    if (
                        isMdmStep &&
                        normalizedTicketType ===
                            SINGLE_REQUEST_TICKET_TYPES.CHANGE
                    ) {
                        if (!materialCode) {
                            throw buildSingleRequestApprovalError(
                                "Material code is required for Change requests",
                                400,
                                "SINGLE_REQUEST_CHANGE_MATERIAL_CODE_REQUIRED"
                            );
                        }

                        const sapUpdateQuery = `UPDATE mat_sap_data
                             SET name = $1,
                                 unit_of_measurement = $2,
                                 updated_at = NOW(),
                                 updated_by = $3
                             WHERE code = $4
                               AND (dffromclient IS NULL OR dffromclient = false)`;

                        const sapFilteredUpdateResult = await client.query(
                            sapUpdateQuery,
                            [
                                nextSnapshot.material_description ?? null,
                                nextSnapshot.base_uom ?? null,
                                actorUserId ?? null,
                                materialCode,
                            ]
                        );

                        if (sapFilteredUpdateResult.rowCount !== 1) {
                            throw buildSingleRequestApprovalError(
                                "Change request material code must match exactly one material",
                                409,
                                "SINGLE_REQUEST_CHANGE_MATERIAL_CODE_CONFLICT"
                            );
                        }
                    }

                    if (
                        isMdmStep &&
                        normalizedTicketType ===
                            SINGLE_REQUEST_TICKET_TYPES.EXTEND
                    ) {
                        if (!materialCode) {
                            throw buildSingleRequestApprovalError(
                                "Material code is required for Extend requests",
                                400,
                                "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_REQUIRED"
                            );
                        }

                        const materialExistsResult = await client.query(
                            `SELECT 1
                             FROM mat_sap_data
                             WHERE code = $1`,
                            [materialCode]
                        );

                        if (materialExistsResult.rowCount !== 1) {
                            throw buildSingleRequestApprovalError(
                                "Extend request material code was not found",
                                404,
                                "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_NOT_FOUND"
                            );
                        }

                        const selectedPlantCode = String(
                            nextSnapshot.plant_code || ""
                        ).trim();
                        const selectedStorageLocation = String(
                            nextSnapshot.sloc_code || ""
                        ).trim();

                        if (!selectedPlantCode || !selectedStorageLocation) {
                            throw buildSingleRequestApprovalError(
                                "Plant and storage location are required",
                                400,
                                "SINGLE_REQUEST_EXTEND_LOCATION_REQUIRED"
                            );
                        }

                        const locations = await Material.getLocationAndPlant();
                        const hasMatchingLocation = locations.some(
                            location =>
                                String(location.plant_code || "").trim() ===
                                    selectedPlantCode &&
                                String(
                                    location.storage_location || ""
                                ).trim() === selectedStorageLocation
                        );

                        if (!hasMatchingLocation) {
                            throw buildSingleRequestApprovalError(
                                "Selected plant and storage location were not found",
                                400,
                                "SINGLE_REQUEST_EXTEND_LOCATION_NOT_FOUND"
                            );
                        }

                        const sapExtendUpdateResult = await client.query(
                            `UPDATE mat_sap_data
                             SET plant_code = $1,
                                 sloc_code = $2,
                                 updated_at = NOW(),
                                 updated_by = $3
                             WHERE code = $4
                               AND (dffromclient IS NULL OR dffromclient = false)`,
                            [
                                selectedPlantCode,
                                selectedStorageLocation,
                                actorUserId ?? null,
                                materialCode,
                            ]
                        );

                        if (sapExtendUpdateResult.rowCount !== 1) {
                            throw buildSingleRequestApprovalError(
                                "Extend request material code must match exactly one material",
                                409,
                                "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_CONFLICT"
                            );
                        }
                    }

                    // Final-code generation: only when the active step is MDM
                    // (last) AND this is a Create ticket.
                    const finalCode =
                        isMdmStep && normalizedTicketType === "Create"
                            ? buildSingleRequestFinalCode({
                                  materialGroupCode:
                                      nextSnapshot.material_group_code,
                                  materialSubGroupCode:
                                      nextSnapshot.material_sub_group_code,
                                  finalCodeSuffix,
                              })
                            : null;

                    // Advance: mark the active step APPROVED. For MANUAL the
                    // approver is already fixed; for MDM, set the approver to the
                    // claimer (COALESCE keeps the existing claim if present).
                    const approvePatch = buildStepApprovePatch({
                        remark: safeRemark,
                    });
                    await updateSingleRequestStepRow(client, activeStep.id, {
                        ...approvePatch.step,
                        approver_user_id:
                            activeStep.approver_user_id ?? actorUserId ?? null,
                    });

                    // Recompute the next active step from the post-approval state.
                    const nextSteps = steps.map(step =>
                        step.id === activeStep.id
                            ? { ...step, status: "APPROVED" }
                            : step
                    );
                    const nextActive = resolveActiveStep(nextSteps);
                    // When the just-approved step was MANUAL and the next active
                    // step is MDM, no auto-assignment is needed — the MDM row
                    // already exists unclaimed (approver_user_id NULL) and becomes
                    // visible to the open queue automatically.

                    const headerPatch = {
                        assigned_to: nextActive
                            ? stepLabel(nextActive)
                            : "Completed",
                        status: nextActive ? "Submit" : "DONE",
                    };
                    if (finalCode) {
                        headerPatch.final_code = finalCode;
                    }

                    await updateSingleRequestColumns(
                        client,
                        requestId,
                        headerPatch
                    );
                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        stage: activeStepLabel,
                        status: headerPatch.status,
                        assigned_to: headerPatch.assigned_to,
                        final_code: finalCode,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error approving single request by admin:", error);
            throw error;
        }
    },

    createSingleRequest: async ({
        ticketType,
        materialCode = null,
        changeExtendReason = null,
        materialGroupId,
        materialSubGroupId,
        requestFields = {},
        templateValues = {},
        templateConfig = null,
        attachments = [],
        createdBy,
        createdByUsername = null,
    }) => {
        const savedFiles = [];

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const {
                        rows: [{ next_id: nextId }],
                    } = await client.query(
                        "SELECT nextval(pg_get_serial_sequence('mat_single_request', 'id')) AS next_id"
                    );

                    const normalizedPersistedRequestFields =
                        normalizeSingleRequestRequestFields(requestFields);
                    const storedMaterialCode = String(
                        materialCode ??
                            normalizedPersistedRequestFields.material_number ??
                            normalizedPersistedRequestFields.material_code ??
                            ""
                    ).trim() || null;

                    if (
                        storedMaterialCode &&
                        !normalizedPersistedRequestFields.material_number
                    ) {
                        normalizedPersistedRequestFields.material_number =
                            storedMaterialCode;
                    }

                    if (templateConfig && Object.keys(templateValues).length > 0) {
                        const generated = buildMaterialDescriptionAndLongText(
                            templateValues,
                            templateConfig
                        );
                        normalizedPersistedRequestFields.material_description =
                            generated.material_description ||
                            normalizedPersistedRequestFields.material_description;
                        normalizedPersistedRequestFields.long_text_1 =
                            generated.long_text_1 ||
                            normalizedPersistedRequestFields.long_text_1;
                        normalizedPersistedRequestFields.long_text_2 =
                            generated.long_text_2 ||
                            normalizedPersistedRequestFields.long_text_2;
                        normalizedPersistedRequestFields.long_text_3 =
                            generated.long_text_3 ||
                            normalizedPersistedRequestFields.long_text_3;
                    }

                    const requestNo = String(1000000000 + Number(nextId));
                    const payload = JSON.stringify({
                        requestFields: normalizedPersistedRequestFields,
                        templateValues,
                    });
                    const normalizedTicketType =
                        normalizeSingleRequestTicketType(ticketType);
                    // New dynamic-approver flow: freeze the manual approver chain
                    // from mat_approvers_matrix_level and build the ordered step
                    // plan (1..N manual + MDM last, with skips by ticket type).
                    const chain = await loadRequesterChain(client, createdBy);
                    const plan = buildApprovalStepPlan({
                        ticketType: normalizedTicketType,
                        chain,
                    });

                    const insertResult = await client.query(
                        `INSERT INTO mat_single_request (
                            id,
                            request_no,
                            ticket_type,
                            change_extend_reason,
                            material_group_id,
                            material_sub_group_id,
                            plant_code,
                            sloc_code,
                            material_description,
                            base_uom,
                            long_text_1,
                            long_text_2,
                            long_text_3,
                            template_payload,
                            status,
                            assigned_to,
                            created_by,
                            created_at,
                            updated_at
                        ) VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Submit', $15, $16, NOW(), NOW()
                        )
                        RETURNING id, request_no, ticket_type, change_extend_reason, material_description, base_uom, status, assigned_to, created_by, created_at`,
                        [
                            nextId,
                            requestNo,
                            normalizedTicketType,
                            String(changeExtendReason || "").trim() || null,
                            materialGroupId,
                            materialSubGroupId || null,
                            normalizedPersistedRequestFields.plant || null,
                            normalizedPersistedRequestFields.storage_location ||
                                null,
                            normalizedPersistedRequestFields.material_description,
                            normalizedPersistedRequestFields.base_unit_of_measure ||
                                normalizedPersistedRequestFields.base_uom,
                            normalizedPersistedRequestFields.long_text_1 || null,
                            normalizedPersistedRequestFields.long_text_2 || null,
                            normalizedPersistedRequestFields.long_text_3 || null,
                            payload,
                            stepLabel(plan[0]),
                            createdBy,
                        ]
                    );

                    await insertSingleRequestApprovalSteps(
                        client,
                        nextId,
                        plan
                    );

                    const createdAt =
                        insertResult.rows[0]?.created_at ?? new Date();
                    const resolvedAttachments = attachments.map(file => ({
                        tempPath: file.tempPath,
                        file_name: file.originalName,
                        file_path: buildSingleRequestRelativePath({
                            requestNo,
                            requestId: nextId,
                            newName: file.newName,
                            createdAt,
                        }),
                        file_type: file.mimeType,
                    }));
                    const persistedAttachments = resolvedAttachments.map(
                        ({ file_name, file_path, file_type }) => ({
                            file_name,
                            file_path,
                            file_type,
                        })
                    );
                    for (const attachment of resolvedAttachments) {
                        await client.query(
                            `INSERT INTO mat_single_request_attachment (
                                request_id,
                                file_name,
                                file_path,
                                file_type,
                                created_at
                            ) VALUES ($1, $2, $3, $4, NOW())`,
                            [
                                nextId,
                                attachment.file_name,
                                attachment.file_path,
                                attachment.file_type,
                            ]
                        );
                    }

                    const publicDir = SINGLE_REQUEST_PUBLIC_DIRECTORY;

                    for (const attachment of resolvedAttachments) {
                        const finalPath = path.join(
                            publicDir,
                            attachment.file_path
                        );
                        const finalDir = path.dirname(finalPath);

                        if (!fs.existsSync(finalDir)) {
                            fs.mkdirSync(finalDir, { recursive: true });
                        }

                        const rawData = fs.readFileSync(attachment.tempPath);
                        fs.writeFileSync(finalPath, rawData);
                        savedFiles.push(finalPath);
                    }

                    await client.query("COMMIT");

                    return {
                        ...insertResult.rows[0],
                        material_code: storedMaterialCode,
                        attachments: persistedAttachments,
                        approvalSteps: plan,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            for (const savedFile of savedFiles) {
                if (fs.existsSync(savedFile)) {
                    fs.unlinkSync(savedFile);
                }
            }

            console.error("Error creating single material request:", error);
            throw error;
        }
    },
    createMassRequest: async ({
        rows = [],
        attachmentsByRow = [],
        createdBy,
        createdByUsername = null,
        massRequestReason = null,
    }) => {
        const savedFiles = [];

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const {
                        rows: [{ next_id: nextMassId }],
                    } = await client.query(
                        "SELECT nextval(pg_get_serial_sequence('mat_mass_request', 'id')) AS next_id"
                    );
                    const massRequestNo = String(
                        2000000000 + Number(nextMassId)
                    );

                    // Mass requests are always CREATE — freeze the manual chain
                    // once and reuse the same plan for every item.
                    const massChain = await loadRequesterChain(
                        client,
                        createdBy
                    );
                    const massPlan = buildApprovalStepPlan({
                        ticketType: "Create",
                        chain: massChain,
                    });
                    const massFirstStepLabel = stepLabel(massPlan[0]);

                    const massHeaderResult = await client.query(
                        `INSERT INTO mat_mass_request (
                            id,
                            mass_request_no,
                            item_count,
                            mass_request_reason,
                            created_by,
                            created_by_username,
                            created_at,
                            updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                        RETURNING id, mass_request_no, item_count, mass_request_reason, created_by, created_by_username, created_at`,
                        [
                            nextMassId,
                            massRequestNo,
                            rows.length,
                            String(massRequestReason || "").trim() || null,
                            createdBy,
                            createdByUsername,
                        ]
                    );
                    const insertedItems = [];

                    for (
                        let itemIndex = 0;
                        itemIndex < rows.length;
                        itemIndex += 1
                    ) {
                        const row = rows[itemIndex];
                        const {
                            rows: [{ next_id: nextItemId }],
                        } = await client.query(
                            "SELECT nextval(pg_get_serial_sequence('mat_mass_request_item', 'id')) AS next_id"
                        );
                        const itemRequestNo = String(
                            3000000000 + Number(nextItemId)
                        );
                        const itemNo = itemIndex + 1;

                        const itemResult = await client.query(
                            `INSERT INTO mat_mass_request_item (
                                id,
                                mass_request_id,
                                item_no,
                                request_no,
                                ticket_type,
                                plant_code,
                                sloc_code,
                                material_group,
                                material_sub_group,
                                material_description,
                                po_text,
                                base_uom,
                                spesifikasi_tambahan,
                                status,
                                assigned_to,
                                created_by,
                                created_at,
                                updated_at
                            ) VALUES (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                                'Submit', $14, $15, NOW(), NOW()
                            )
                            RETURNING id, item_no, request_no, ticket_type, status, assigned_to, created_by, created_at`,
                            [
                                nextItemId,
                                nextMassId,
                                itemNo,
                                itemRequestNo,
                                "Create",
                                String(row.plant || "").trim() || null,
                                String(row.sloc || "").trim() || null,
                                String(row.materialGroup || "").trim() ||
                                    null,
                                String(row.materialSubGroup || "").trim() ||
                                    null,
                                String(row.description || "").trim(),
                                String(row.poText || "").trim() || null,
                                String(row.uom || "").trim(),
                                String(row.spesifikasiTambahan || "").trim() ||
                                    null,
                                massFirstStepLabel,
                                createdBy,
                            ]
                        );

                        await insertMassItemApprovalSteps(
                            client,
                            nextItemId,
                            massPlan
                        );

                        const itemRow = itemResult.rows[0];
                        const rowAttachments =
                            attachmentsByRow[itemIndex] || [];
                        const attachmentCreatedAt =
                            itemRow?.created_at ??
                            massHeaderResult.rows[0]?.created_at ??
                            new Date();
                        const resolvedAttachments = rowAttachments.map(file => ({
                            tempPath: file.tempPath,
                            file_name: file.originalName,
                            file_path: buildMassRequestRelativePath({
                                requestNo: itemRow?.request_no ?? itemRequestNo,
                                requestId: nextMassId,
                                itemId: nextItemId,
                                newName: file.newName,
                                createdAt: attachmentCreatedAt,
                            }),
                            file_type: file.mimeType,
                        }));
                        const persistedAttachments = [];

                        for (const attachment of resolvedAttachments) {
                            const attachmentResult = await client.query(
                                `INSERT INTO mat_mass_request_attachment (
                                    item_id,
                                    file_name,
                                    file_path,
                                    file_type,
                                    created_at
                                ) VALUES ($1, $2, $3, $4, NOW())
                                RETURNING id, file_name, file_path, file_type, created_at`,
                                [
                                    nextItemId,
                                    attachment.file_name,
                                    attachment.file_path,
                                    attachment.file_type,
                                ]
                            );
                            persistedAttachments.push(
                                attachmentResult.rows[0]
                            );
                        }

                        const publicDir = MASS_REQUEST_PUBLIC_DIRECTORY;
                        for (const attachment of resolvedAttachments) {
                            const finalPath = path.join(
                                publicDir,
                                attachment.file_path
                            );
                            const finalDir = path.dirname(finalPath);
                            if (!fs.existsSync(finalDir)) {
                                fs.mkdirSync(finalDir, { recursive: true });
                            }
                            const rawData = fs.readFileSync(attachment.tempPath);
                            fs.writeFileSync(finalPath, rawData);
                            savedFiles.push(finalPath);
                        }
                        insertedItems.push({
                            ...itemRow,
                            attachments: persistedAttachments,
                        });
                    }

                    await client.query("COMMIT");

                    return {
                        ...massHeaderResult.rows[0],
                        items: insertedItems,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            for (const savedFile of savedFiles) {
                if (fs.existsSync(savedFile)) {
                    fs.unlinkSync(savedFile);
                }
            }

            console.error("Error creating mass material request:", error);
            throw error;
        }
    },

    getMassRequestsByUser: async createdBy => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    GET_MASS_REQUESTS_BY_USER_QUERY,
                    [createdBy]
                );

                return result.rows.map(attachStepPayloadToRow);
            });
        } catch (error) {
            console.error("Error fetching mass requests by user:", error);
            throw error;
        }
    },

    hasActiveSingleRequest: async ({ materialCode, ticketType }) => {
        const normalizedTicketType = normalizeSingleRequestTicketType(ticketType);

        if (normalizedTicketType === SINGLE_REQUEST_TICKET_TYPES.CREATE) {
            return false;
        }

        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT 1
                     FROM mat_single_request r
                     WHERE r.ticket_type = $1
                       AND ${SINGLE_REQUEST_MATERIAL_CODE_SQL} = $2
                       AND r.assigned_to NOT IN ('Completed', 'Cancelled')
                     LIMIT 1`,
                    [normalizedTicketType, materialCode]
                );
                return result.rows.length > 0;
            });
        } catch (error) {
            console.error("Error checking active single request:", error);
            throw error;
        }
    },

    getSingleRequestsByUser: async createdBy => {
        try {
            return await DBClientWrapper(async client => {
                const result = await runSingleRequestListQuery(
                    client,
                    "r.created_by = $1",
                    [createdBy]
                );

                return result.rows.map(attachStepPayloadToRow);
            });
        } catch (error) {
            console.error("Error fetching single requests by user:", error);
            throw error;
        }
    },

    getSingleRequestById: async ({ requestId, actorUserId, actorUsername }) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await runSingleRequestListQuery(
                    client,
                    "r.id = $1",
                    [requestId]
                );
                const row = result.rows[0]
                    ? attachStepPayloadToRow(result.rows[0])
                    : undefined;

                if (!row) {
                    throw buildSingleRequestApprovalError(
                        "Single request not found",
                        404,
                        "SINGLE_REQUEST_NOT_FOUND"
                    );
                }

                if (
                    !isAdminMaterialApprover(actorUsername) &&
                    String(row.requester_user_id || "") !==
                        String(actorUserId || "")
                ) {
                    throw buildSingleRequestApprovalError(
                        "Forbidden: only requester or ADMIN can view this request",
                        403,
                        "SINGLE_REQUEST_VIEW_FORBIDDEN"
                    );
                }

                return row;
            });
        } catch (error) {
            console.error("Error fetching single request by id:", error);
            throw error;
        }
    },

    getSingleRequestApprovalInbox: async (actorUserId, actorUsername) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await runSingleRequestApprovalInboxQuery(client);
                const actorIsMdmMaterial = await isActorMdmMaterialUser(
                    client,
                    actorUserId
                );

                return applyStepInboxVisibility(result.rows, {
                    actorUserId,
                    actorUsername,
                    actorIsMdmMaterial,
                });
            });
        } catch (error) {
            console.error(
                "Error fetching single request approval inbox:",
                error
            );
            throw error;
        }
    },

    requestSingleRequestRework: async ({
        requestId,
        actorUserId,
        actorUsername,
        reason,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (!isSubmittedSingleRequestStatus(snapshot.status)) {
                        throw buildSingleRequestApprovalError(
                            "Single request rework can only be requested while status is Submit",
                            409,
                            "SINGLE_REQUEST_REWORK_STATUS_CONFLICT"
                        );
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw buildSingleRequestApprovalError(
                            "Single request is already processed or not waiting for approval",
                            409,
                            "SINGLE_REQUEST_REWORK_CONFLICT"
                        );
                    }

                    const actorIsMdmMaterial =
                        activeStep.kind === STEP_KINDS.MDM
                            ? await isActorMdmMaterialUser(client, actorUserId)
                            : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only the assigned approver or ADMIN can request rework",
                            403,
                            "SINGLE_REQUEST_REWORK_FORBIDDEN"
                        );
                    }

                    const reworkPatch = buildStepReworkPatch({
                        activeStep,
                        reason,
                    });

                    await updateSingleRequestStepRow(client, activeStep.id, {
                        ...reworkPatch.step,
                        approver_user_id:
                            activeStep.approver_user_id ?? actorUserId ?? null,
                    });
                    await updateSingleRequestColumns(client, requestId, {
                        ...reworkPatch.header,
                        rework_by_user_id: actorUserId ?? null,
                    });
                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        stage: stepLabel(activeStep),
                        status: reworkPatch.header.status,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error requesting single request rework:", error);
            throw error;
        }
    },

    rejectSingleRequestByAdmin: async ({
        requestId,
        actorUserId,
        actorUsername,
        reason,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (!isSubmittedSingleRequestStatus(snapshot.status)) {
                        throw buildSingleRequestApprovalError(
                            "Single request reject can only be processed while status is Submit",
                            409,
                            "SINGLE_REQUEST_REJECT_STATUS_CONFLICT"
                        );
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw buildSingleRequestApprovalError(
                            "Single request is already processed or not waiting for approval",
                            409,
                            "SINGLE_REQUEST_REJECT_CONFLICT"
                        );
                    }

                    const actorIsMdmMaterial =
                        activeStep.kind === STEP_KINDS.MDM
                            ? await isActorMdmMaterialUser(client, actorUserId)
                            : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only the assigned approver or ADMIN can reject this request",
                            403,
                            "SINGLE_REQUEST_REJECT_FORBIDDEN"
                        );
                    }

                    const rejectPatch = buildStepRejectPatch({
                        activeStep,
                        reason,
                    });

                    await updateSingleRequestStepRow(client, activeStep.id, {
                        ...rejectPatch.step,
                        approver_user_id:
                            activeStep.approver_user_id ?? actorUserId ?? null,
                    });
                    await updateSingleRequestColumns(
                        client,
                        requestId,
                        rejectPatch.header
                    );
                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        stage: stepLabel(activeStep),
                        status: rejectPatch.header.status,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error rejecting single request by admin:", error);
            throw error;
        }
    },

    saveSingleRequestRework: async ({
        requestId,
        actorUserId,
        actorUsername,
        editedRequest,
        attachments = null,
    }) => {
        const savedFiles = [];
        const removedFilePaths = [];
        const normalizedEditedRequest =
            normalizeSingleRequestEditedRequest(editedRequest);

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (String(snapshot.status || "").trim().toUpperCase() !== "REWORK") {
                        throw buildSingleRequestApprovalError(
                            "Single request rework can only be saved while status is Rework",
                            409,
                            "SINGLE_REQUEST_REWORK_SAVE_CONFLICT"
                        );
                    }

                    if (!snapshot.rework_stage) {
                        throw buildSingleRequestApprovalError(
                            "Single request rework stage is missing",
                            409,
                            "SINGLE_REQUEST_REWORK_STAGE_MISSING"
                        );
                    }

                    if (
                        !canActorReviseSingleRequest({
                            request: snapshot,
                            actorUserId,
                            actorUsername,
                        })
                    ) {
                        throw buildSingleRequestApprovalError(
                            "Forbidden: only requester or ADMIN can revise this request",
                            403,
                            "SINGLE_REQUEST_REVISE_FORBIDDEN"
                        );
                    }

                    const editablePatch =
                        await prepareSingleRequestApprovalEditPatch({
                            snapshot,
                            editedRequest: normalizedEditedRequest,
                            allowMaterialGroupChange: true,
                            getSubGroupById: Material.getSubGroupById,
                            validateMaterialRequestTemplate:
                                MaterialTemplate.validateMaterialRequestTemplate,
                        });
                    // Step model: resolve the reworked step by its stored label
                    // and reset it to WAITING so the same stage re-opens.
                    const reworkSteps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const reworkStep = findStepByLabel(
                        reworkSteps,
                        snapshot.rework_stage
                    );

                    if (!reworkStep) {
                        throw buildSingleRequestApprovalError(
                            "Single request rework stage is missing",
                            409,
                            "SINGLE_REQUEST_REWORK_STAGE_MISSING"
                        );
                    }

                    const revisedPatch = {
                        status: "Submit",
                        assigned_to: stepLabel(reworkStep),
                    };
                    const attachmentInstructions = Array.isArray(attachments)
                        ? { newAttachments: attachments }
                        : attachments &&
                            typeof attachments === "object" &&
                            !Array.isArray(attachments)
                          ? attachments
                          : null;
                    const ticketType = normalizeSingleRequestTicketType(
                        snapshot.ticket_type
                    );

                    if (
                        ticketType !== SINGLE_REQUEST_TICKET_TYPES.CREATE &&
                        attachmentInstructions
                    ) {
                        const keepAttachmentIds = Array.isArray(
                            attachmentInstructions.keepAttachmentIds
                        )
                            ? attachmentInstructions.keepAttachmentIds
                            : [];
                        const newAttachments = Array.isArray(
                            attachmentInstructions.newAttachments
                        )
                            ? attachmentInstructions.newAttachments
                            : [];

                        if (
                            keepAttachmentIds.length > 0 ||
                            newAttachments.length > 0
                        ) {
                            throw buildSingleRequestApprovalError(
                                `${ticketType} requests do not support attachments`,
                                400,
                                "SINGLE_REQUEST_ATTACHMENT_UNSUPPORTED"
                            );
                        }
                    }

                    if (ticketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
                        const nextPlantCode = String(
                            editablePatch.plant_code ??
                                snapshot.plant_code ??
                                ""
                        ).trim();
                        const nextSlocCode = String(
                            editablePatch.sloc_code ??
                                snapshot.sloc_code ??
                                ""
                        ).trim();
                        const nextReason = String(
                            editablePatch.change_extend_reason ??
                                snapshot.change_extend_reason ??
                                ""
                        ).trim();

                        if (!nextPlantCode || !nextSlocCode || !nextReason) {
                            throw buildSingleRequestApprovalError(
                                "Plant, storage location, and change or extend reason are required",
                                400,
                                "SINGLE_REQUEST_EXTEND_REWORK_REQUIRED_FIELDS_MISSING"
                            );
                        }
                    }

                    if (
                        shouldPersistSingleRequestEditHistory(ticketType) &&
                        Object.keys(editablePatch).length > 0
                    ) {
                        try {
                            await client.query(
                                `INSERT INTO mat_single_request_edit_history (
                                    request_id,
                                    request_no,
                                    approval_stage,
                                    approved_by_user_id,
                                    approve_remark,
                                    approved_at,
                                    material_group_id,
                                    material_sub_group_id,
                                    plant_code,
                                    sloc_code,
                                    material_description,
                                    base_uom,
                                    long_text_1,
                                    long_text_2,
                                    long_text_3,
                                    template_payload,
                                    created_by,
                                    created_at
                                ) VALUES (
                                    $1, $2, 'Requestor', $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                                )`,
                                [
                                    snapshot.request_id,
                                    snapshot.request_no,
                                    actorUserId ?? null,
                                    null,
                                    snapshot.material_group_id ?? null,
                                    snapshot.material_sub_group_id ?? null,
                                    snapshot.plant_code ?? null,
                                    snapshot.sloc_code ?? null,
                                    snapshot.material_description ?? null,
                                    snapshot.base_uom ?? null,
                                    snapshot.long_text_1 ?? null,
                                    snapshot.long_text_2 ?? null,
                                    snapshot.long_text_3 ?? null,
                                    snapshot.template_payload ?? null,
                                    snapshot.created_by ?? null,
                                    snapshot.created_at ?? null,
                                ]
                            );
                        } catch (historyError) {
                            if (
                                isMissingSingleRequestEditHistoryTableError(
                                    historyError
                                )
                            ) {
                                console.warn(
                                    `mat_single_request_edit_history is missing; skipping edit history insert for request ${requestId}`
                                );
                            } else {
                                throw historyError;
                            }
                        }
                    }

                    // Reopen the reworked step (WAITING) and clear its action.
                    await updateSingleRequestStepRow(client, reworkStep.id, {
                        status: "WAITING",
                        acted_at: null,
                        remark: null,
                    });

                    await updateSingleRequestColumns(client, requestId, {
                        ...editablePatch,
                        ...revisedPatch,
                        rework_stage: snapshot.rework_stage,
                        rework_by_user_id: snapshot.rework_by_user_id ?? null,
                        rework_reason: snapshot.rework_reason ?? null,
                    });

                    if (attachmentInstructions) {
                        const existingAttachments =
                            await getSingleRequestAttachments(client, requestId);
                        const keepAttachmentIds = Array.isArray(
                            attachmentInstructions.keepAttachmentIds
                        )
                            ? new Set(
                                  attachmentInstructions.keepAttachmentIds.map(id =>
                                      String(id)
                                  )
                              )
                            : null;
                        const newAttachments = Array.isArray(
                            attachmentInstructions.newAttachments
                        )
                            ? attachmentInstructions.newAttachments
                            : [];
                        const keptAttachments = keepAttachmentIds
                            ? existingAttachments.filter(attachment =>
                                  keepAttachmentIds.has(String(attachment.id))
                              )
                            : existingAttachments;
                        const removedAttachments = keepAttachmentIds
                            ? existingAttachments.filter(
                                  attachment =>
                                      !keepAttachmentIds.has(
                                          String(attachment.id)
                                      )
                              )
                            : [];

                        if (
                            keptAttachments.length + newAttachments.length >
                            SINGLE_REQUEST_MAX_ATTACHMENTS
                        ) {
                            throw buildSingleRequestApprovalError(
                                `Maximum ${SINGLE_REQUEST_MAX_ATTACHMENTS} attachments are allowed`,
                                400,
                                "SINGLE_REQUEST_ATTACHMENT_LIMIT_EXCEEDED"
                            );
                        }

                        if (removedAttachments.length > 0) {
                            const removedAttachmentIds = removedAttachments.map(
                                attachment => attachment.id
                            );

                            await client.query(
                                `DELETE FROM mat_single_request_attachment
                                 WHERE request_id = $1 AND id = ANY($2)`,
                                [requestId, removedAttachmentIds]
                            );
                            removedFilePaths.push(
                                ...removedAttachments.map(
                                    attachment => attachment.file_path
                                )
                            );
                        }
                        const attachmentCreatedAt = snapshot.created_at
                            ? new Date(snapshot.created_at)
                            : new Date();
                        for (const attachment of newAttachments) {
                            await insertSingleRequestAttachment(
                                client,
                                requestId,
                                snapshot.request_no,
                                attachment,
                                attachmentCreatedAt
                            );
                        }

                        savedFiles.push(
                            ...persistSingleRequestAttachmentFiles(
                                requestId,
                                snapshot.request_no,
                                newAttachments,
                                attachmentCreatedAt
                            )
                        );
                    }

                    await client.query("COMMIT");
                    deleteSingleRequestStoredFiles(removedFilePaths);

                    return {
                        request_id: Number(requestId),
                        stage: snapshot.rework_stage,
                        status: revisedPatch.status,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
                });
        } catch (error) {
            for (const savedFile of savedFiles) {
                if (fs.existsSync(savedFile)) {
                    fs.unlinkSync(savedFile);
                }
            }

            console.error("Error saving single request rework:", error);
            throw error;
        }
    },

    getAdministratorApproverMasters: async ({ page, limit, search } = {}) => {
        return DBClientWrapper(async client => {
            const result = await client.query(GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY);
            let rows = result.rows.map(row => {
                const rawManualApprovers = Array.isArray(row.manual_approvers)
                    ? row.manual_approvers
                    : typeof row.manual_approvers === "string"
                      ? JSON.parse(row.manual_approvers || "[]")
                      : [];

                return {
                    requester_user_id: row.requester_user_id,
                    requester_username: row.requester_username,
                    requester_fullname: row.requester_fullname,
                    requester_email: row.requester_email,
                    manualApprovers: rawManualApprovers.map(entry => ({
                        level: entry.level,
                        approverUserId: entry.approver_user_id,
                        approverName: entry.approver_name,
                        approverUsername: entry.approver_username,
                        approverEmail: entry.approver_email,
                    })),
                    is_locked: false,
                };
            });

            // Optional backend search across requester name / username / email.
            const term = typeof search === "string" ? search.trim().toLowerCase() : "";
            if (term) {
                rows = rows.filter(r =>
                    [r.requester_username, r.requester_fullname, r.requester_email].some(
                        value => String(value ?? "").toLowerCase().includes(term)
                    )
                );
            }

            const total = rows.length;

            // Optional pagination — applied only when both page & limit are valid
            // positives; otherwise the full (filtered) list is returned so existing
            // callers that pass no params are unaffected.
            const pageNum = Number.parseInt(page, 10);
            const limitNum = Number.parseInt(limit, 10);
            const paginate =
                Number.isInteger(pageNum) &&
                pageNum > 0 &&
                Number.isInteger(limitNum) &&
                limitNum > 0;

            const data = paginate
                ? rows.slice((pageNum - 1) * limitNum, (pageNum - 1) * limitNum + limitNum)
                : rows;

            return {
                count: total,
                data,
                ...(paginate
                    ? { page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) }
                    : {}),
            };
        });
    },

    // --- Dynamic approver chain (mat_approvers_matrix_level) ---
    // Ordered MANUAL approver levels per requester. The Master Data (MDM) stage is
    // appended at runtime as the final stage and never stored here.
    getRequesterApproverChain: async requesterUserId =>
        DBClientWrapper(async client => {
            const result = await client.query(
                `SELECT l.level,
                        l.approver_user_id,
                        COALESCE(au.fullname, au.username, l.approver_user_id) AS approver_name,
                        au.username AS approver_username,
                        au.email AS approver_email
                   FROM mat_approvers_matrix_level l
                   LEFT JOIN mst_user au ON au.user_id = l.approver_user_id
                  WHERE l.requester_user_id = $1
                  ORDER BY l.level`,
                [requesterUserId]
            );
            return result.rows.map(row => ({
                level: row.level,
                approverUserId: row.approver_user_id,
                approverName: row.approver_name,
                approverUsername: row.approver_username,
                approverEmail: row.approver_email,
            }));
        }),

    // Whole-list save of a requester's ordered manual chain (levels renumbered 1..N).
    saveRequesterApproverChain: async ({
        requesterUserId,
        manualApproverIds = [],
        actorUsername = null,
    }) => {
        const ids = (Array.isArray(manualApproverIds) ? manualApproverIds : [])
            .map(value => (value == null ? "" : String(value).trim()))
            .filter(Boolean);
        if (!requesterUserId) {
            const error = new Error("requesterUserId is required.");
            error.statusCode = 400;
            throw error;
        }
        if (ids.length < 1) {
            const error = new Error("At least one manual approver is required.");
            error.statusCode = 400;
            throw error;
        }
        if (new Set(ids).size !== ids.length) {
            const error = new Error("Approvers must be distinct.");
            error.statusCode = 400;
            throw error;
        }
        return DBClientWrapper(async client => {
            try {
                await client.query("BEGIN");
                await client.query(
                    `DELETE FROM mat_approvers_matrix_level WHERE requester_user_id = $1`,
                    [requesterUserId]
                );
                for (let index = 0; index < ids.length; index += 1) {
                    await client.query(
                        `INSERT INTO mat_approvers_matrix_level
                             (requester_user_id, level, approver_user_id, created_by, updated_by)
                         VALUES ($1, $2, $3, $4, $4)`,
                        [requesterUserId, index + 1, ids[index], actorUsername]
                    );
                }
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
            return Material.getRequesterApproverChain(requesterUserId);
        });
    },

    updateAdministratorApproverMaster: async payload => {
        const {
            requesterUserId,
            approval1UserId,
            approval2UserId,
            actorUsername,
        } = payload || {};

        return DBClientWrapper(async client => {
            const hasApproval1Patch = Object.prototype.hasOwnProperty.call(
                payload || {},
                "approval1UserId"
            );
            const hasApproval2Patch = Object.prototype.hasOwnProperty.call(
                payload || {},
                "approval2UserId"
            );

            const existingMasterResult = await client.query(
                `SELECT approval_1_user_id, approval_2_user_id, approval_3_user_id, approval_3_type, approval_3_group
                 FROM mat_approvers_matrix
                 WHERE requester_user_id = $1`,
                [requesterUserId]
            );
            const existingMaster = existingMasterResult.rows[0] || {};

            const nextApproval1UserId = hasApproval1Patch
                ? approval1UserId
                : existingMaster.approval_1_user_id ?? null;
            const nextApproval2UserId = hasApproval2Patch
                ? approval2UserId
                : existingMaster.approval_2_user_id ?? null;

            let nextApproval3UserId = existingMaster.approval_3_user_id ?? null;

            if (!nextApproval3UserId) {
                const approval3Users = await queryActiveMdmMaterialUsers(client);
                if (approval3Users.length > 0) {
                    const excludedIds = new Set(
                        [nextApproval1UserId, nextApproval2UserId].filter(Boolean)
                    );
                    const candidates = approval3Users.filter(
                        u => !excludedIds.has(u.user_id)
                    );
                    if (candidates.length > 0) {
                        const randomIndex = Math.floor(
                            Math.random() * candidates.length
                        );
                        nextApproval3UserId = candidates[randomIndex].user_id;
                    }
                }
            }

            const master = buildRequesterApprovalMaster({
                requesterUserId,
                approval1UserId: nextApproval1UserId,
                approval2UserId: nextApproval2UserId,
                approval3UserId: nextApproval3UserId,
            });

            const result = await client.query(
                `INSERT INTO mat_approvers_matrix (
                     requester_user_id,
                     approval_1_user_id,
                     approval_2_user_id,
                     approval_3_user_id,
                     approval_3_type,
                     approval_3_group,
                     created_at,
                     created_by,
                     updated_at,
                     updated_by
                 ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW(), $7)
                 ON CONFLICT (requester_user_id) DO UPDATE SET
                     approval_1_user_id = EXCLUDED.approval_1_user_id,
                     approval_2_user_id = EXCLUDED.approval_2_user_id,
                     approval_3_user_id = EXCLUDED.approval_3_user_id,
                     updated_at = NOW(),
                     updated_by = EXCLUDED.updated_by
                 RETURNING *`,
                [
                    master.requester_user_id,
                    master.approval_1_user_id,
                    master.approval_2_user_id,
                    master.approval_3_user_id,
                    master.approval_3_type,
                    master.approval_3_group,
                    actorUsername,
                ]
            );

            const activeRequestResult = await client.query(
                `SELECT
                     id AS request_id,
                     assigned_to,
                     created_by,
                     status,
                     created_by AS requester_user_id,
                     approval_1_user_id,
                     approval_1_at,
                     approval_1_status,
                     approval_1_remark,
                     approval_2_user_id,
                     approval_2_at,
                     approval_2_status,
                     approval_2_remark,
                     approval_3_user_id,
                     approval_3_at,
                     approval_3_status,
                     approval_3_remark
                 FROM mat_single_request
                 WHERE created_by = $1
                   AND NOT (
                       UPPER(COALESCE(approval_3_status, '')) = 'APPROVED'
                       OR UPPER(COALESCE(status, '')) IN ('REJECT', 'REJECTED', 'CANCEL')
                   )
                 ORDER BY created_at DESC, id DESC
                 FOR UPDATE`,
                [requesterUserId]
            );

            if (activeRequestResult.rows.length > 0) {
                const activeSnapshots = activeRequestResult.rows;
                const manualUsersById = await queryUsersWithPageAccessByIds(
                    client,
                    [
                        master.approval_1_user_id,
                        master.approval_2_user_id,
                        ...activeSnapshots.flatMap(snapshot => [
                            snapshot.approval_1_user_id,
                            snapshot.approval_2_user_id,
                        ]),
                    ]
                );
                const approval3Users = await queryActiveMdmMaterialUsers(client);
                const usersById = approval3Users.reduce(
                    (allUsersById, user) => {
                        allUsersById[user.user_id] = user;
                        return allUsersById;
                    },
                    { ...manualUsersById }
                );

                for (const snapshot of activeSnapshots) {
                    const patch = {};

                    if (
                        hasApproval1Patch &&
                        canEditApprovalAssignee(snapshot.approval_1_status)
                    ) {
                        patch.approval_1_user_id = master.approval_1_user_id;
                    }

                    if (
                        hasApproval2Patch &&
                        canEditApprovalAssignee(snapshot.approval_2_status)
                    ) {
                        patch.approval_2_user_id = master.approval_2_user_id;
                    }

                    if (
                        master.approval_3_user_id &&
                        canEditApprovalAssignee(snapshot.approval_3_status)
                    ) {
                        patch.approval_3_user_id = master.approval_3_user_id;
                    }

                    if (Object.keys(patch).length === 0) {
                        continue;
                    }

                    let decision;

                    try {
                        decision = buildAdministratorAssignmentDecision({
                            snapshot,
                            patch,
                            usersById,
                            approval3Candidates: approval3Users.map(
                                user => user.user_id
                            ),
                            randomIndex: approval3Users.length
                                ? Math.floor(
                                      Math.random() * approval3Users.length
                                  )
                                : 0,
                            masterApproval3UserId: master.approval_3_user_id || null,
                        });
                    } catch (error) {
                        throw buildSingleRequestApprovalError(
                            error.message,
                            409,
                            "REQUESTER_APPROVER_MASTER_ACTIVE_REQUEST_CONFLICT"
                        );
                    }

                    const approval3Status = decision.approval_3_user_id
                        ? snapshot.approval_3_status || INITIAL_APPROVAL_STATUS
                        : snapshot.approval_3_status;

                    const nextApprovalSnapshot = {
                        ...snapshot,
                        requester_user_id:
                            snapshot.requester_user_id ?? snapshot.created_by,
                        approval_1_user_id: decision.approval_1_user_id,
                        approval_2_user_id: decision.approval_2_user_id,
                        approval_3_user_id: decision.approval_3_user_id,
                        approval_3_status: approval3Status,
                    };

                    const nextAssignedTo =
                        decision.assigned_to && decision.assigned_to !== snapshot.assigned_to
                            ? decision.assigned_to
                            : snapshot.assigned_to;

                    await syncSingleRequestApprovalSnapshot(
                        client,
                        snapshot.request_id,
                        nextApprovalSnapshot,
                        nextAssignedTo
                    );
                }
            }

            // Cascade to in-flight mass-request items for the same requester.
            const massItemResult = await client.query(
                `SELECT i.id, i.approval_1_status, i.approval_2_status
                 FROM mat_mass_request_item i
                 JOIN mat_mass_request m ON m.id = i.mass_request_id
                 WHERE m.created_by = $1
                   AND i.approval_3_status IS DISTINCT FROM 'APPROVED'
                   AND UPPER(COALESCE(i.status, '')) NOT IN ('REJECT','REJECTED','CANCEL')
                 FOR UPDATE OF i`,
                [requesterUserId]
            );

            let massUpdated = 0;

            for (const item of massItemResult.rows) {
                const massPatch = {};

                if (
                    hasApproval1Patch &&
                    canEditApprovalAssignee(item.approval_1_status)
                ) {
                    massPatch.approval_1_user_id =
                        master.approval_1_user_id;
                }

                if (
                    hasApproval2Patch &&
                    canEditApprovalAssignee(item.approval_2_status)
                ) {
                    massPatch.approval_2_user_id =
                        master.approval_2_user_id;
                }

                if (
                    master.approval_3_user_id &&
                    canEditApprovalAssignee(item.approval_3_status)
                ) {
                    massPatch.approval_3_user_id =
                        master.approval_3_user_id;
                }

                if (Object.keys(massPatch).length === 0) {
                    continue;
                }

                await syncMassRequestItemApprovalSnapshot(
                    client,
                    item.id,
                    massPatch
                );
                massUpdated++;
            }

            return {
                ...result.rows[0],
                is_locked: false,
                mass_updated: massUpdated,
            };
        });
    },

    getMassRequestApprovalInbox: async (actorUserId, actorUsername) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    GET_MASS_REQUEST_APPROVAL_INBOX_QUERY
                );
                const actorIsMdmMaterial = await isActorMdmMaterialUser(
                    client,
                    actorUserId
                );

                return applyStepInboxVisibility(result.rows, {
                    actorUserId,
                    actorUsername,
                    actorIsMdmMaterial,
                });
            });
        } catch (error) {
            console.error(
                "Error fetching mass request approval inbox:",
                error
            );
            throw error;
        }
    },

    approveMassRequest: async ({
        massRequestId,
        actorUserId,
        actorUsername,
        remark,
        items,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Lock and read the first item of the batch to validate status.
                    const lockResult = await client.query(
                        `SELECT i.id, i.status
                         FROM mat_mass_request_item i
                         WHERE i.mass_request_id = $1
                         ORDER BY i.item_no ASC
                         LIMIT 1
                         FOR UPDATE OF i`,
                        [massRequestId]
                    );

                    if (lockResult.rows.length === 0) {
                        throw Object.assign(
                            new Error("Mass request not found"),
                            { statusCode: 404, code: "MASS_REQUEST_NOT_FOUND" }
                        );
                    }

                    const firstItem = lockResult.rows[0];

                    if (
                        String(firstItem.status || "")
                            .trim()
                            .toUpperCase() !== "SUBMIT"
                    ) {
                        throw Object.assign(
                            new Error(
                                "Mass request can only be approved while status is Submit"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_APPROVAL_STATUS_CONFLICT",
                            }
                        );
                    }

                    // Step model: all items share the plan, so route off the
                    // first item's steps and apply the change to every item.
                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(firstItemSteps);

                    if (!activeStep) {
                        throw Object.assign(
                            new Error(
                                "Mass request is already processed or not waiting for approval"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_APPROVAL_CONFLICT",
                            }
                        );
                    }

                    const activeStepLabel = stepLabel(activeStep);
                    const actorIsMdmMaterial =
                        activeStep.kind === STEP_KINDS.MDM
                            ? await isActorMdmMaterialUser(client, actorUserId)
                            : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw Object.assign(
                            new Error(
                                "Forbidden: only the assigned approver or ADMIN can approve this mass request"
                            ),
                            {
                                statusCode: 403,
                                code: "MASS_REQUEST_APPROVAL_FORBIDDEN",
                            }
                        );
                    }

                    // If item edits are provided, update editable fields per item
                    if (Array.isArray(items) && items.length > 0) {
                        const ALLOWED_ITEM_FIELDS = [
                            "material_description",
                            "base_uom",
                            "plant_code",
                            "sloc_code",
                            "material_group",
                            "material_sub_group",
                            "po_text",
                            "spesifikasi_tambahan",
                        ];

                        for (const item of items) {
                            if (!item.id) continue;

                            const edits = {};
                            for (const field of ALLOWED_ITEM_FIELDS) {
                                if (item[field] !== undefined) {
                                    edits[field] = item[field];
                                }
                            }
                            // Handle uom -> base_uom mapping
                            if (item.uom !== undefined && edits.base_uom === undefined) {
                                edits.base_uom = item.uom;
                            }

                            if (Object.keys(edits).length === 0) continue;
                            const editEntries = Object.entries(edits);
                            const itemSetClauses = editEntries.map(
                                ([field], i) => `${field} = $${i + 3}`
                            );
                            itemSetClauses.push("updated_at = NOW()");

                            await client.query(
                                `UPDATE mat_mass_request_item
                                 SET ${itemSetClauses.join(", ")}
                                 WHERE id = $1 AND mass_request_id = $2`,
                                [item.id, massRequestId, ...editEntries.map(([_, v]) => v)]
                            );
                        }
                    }

                    // Mark this stage APPROVED on the matching step row of EVERY
                    // item. For MDM, record the approver (claimer or this actor).
                    const approvePatch = buildMassStepApprovePatch({ remark });
                    await updateMassItemStepRowsByLevel(
                        client,
                        massRequestId,
                        activeStep.level,
                        approvePatch.step
                    );
                    if (activeStep.kind === STEP_KINDS.MDM) {
                        await client.query(
                            `UPDATE mat_mass_request_item_approval_step s
                             SET approver_user_id = COALESCE(s.approver_user_id, $3),
                                 updated_at = NOW()
                             FROM mat_mass_request_item i
                             WHERE s.item_id = i.id
                               AND i.mass_request_id = $1
                               AND s.level = $2`,
                            [massRequestId, activeStep.level, actorUserId ?? null]
                        );
                    }

                    // Recompute the next active step from the post-approval state.
                    const nextSteps = firstItemSteps.map(step =>
                        step.id === activeStep.id
                            ? { ...step, status: "APPROVED" }
                            : step
                    );
                    const nextActive = resolveActiveStep(nextSteps);
                    const headerStatus = nextActive ? "Submit" : "DONE";
                    const headerAssignedTo = nextActive
                        ? stepLabel(nextActive)
                        : "Completed";

                    const updateResult = await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = $2,
                             assigned_to = $3,
                             updated_at = NOW()
                         WHERE mass_request_id = $1
                         RETURNING id`,
                        [massRequestId, headerStatus, headerAssignedTo]
                    );

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        stage: activeStepLabel,
                        status: headerStatus,
                        assigned_to: headerAssignedTo,
                        updated_count: updateResult.rowCount,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error approving mass request:", error);
            throw error;
        }
    },

    requestMassRequestRework: async ({
        massRequestId,
        actorUserId,
        actorUsername,
        reason,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const lockResult = await client.query(
                        `SELECT i.id, i.status
                         FROM mat_mass_request_item i
                         WHERE i.mass_request_id = $1
                         ORDER BY i.item_no ASC
                         LIMIT 1
                         FOR UPDATE OF i`,
                        [massRequestId]
                    );

                    if (lockResult.rows.length === 0) {
                        throw Object.assign(
                            new Error("Mass request not found"),
                            { statusCode: 404, code: "MASS_REQUEST_NOT_FOUND" }
                        );
                    }

                    const firstItem = lockResult.rows[0];

                    if (
                        String(firstItem.status || "")
                            .trim()
                            .toUpperCase() !== "SUBMIT"
                    ) {
                        throw Object.assign(
                            new Error(
                                "Mass request rework can only be requested while status is Submit"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REWORK_STATUS_CONFLICT",
                            }
                        );
                    }

                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(firstItemSteps);

                    if (!activeStep) {
                        throw Object.assign(
                            new Error(
                                "Mass request is already processed or not waiting for approval"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REWORK_CONFLICT",
                            }
                        );
                    }

                    const actorIsMdmMaterial =
                        activeStep.kind === STEP_KINDS.MDM
                            ? await isActorMdmMaterialUser(client, actorUserId)
                            : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw Object.assign(
                            new Error(
                                "Forbidden: only the assigned approver or ADMIN can request rework on this mass request"
                            ),
                            {
                                statusCode: 403,
                                code: "MASS_REQUEST_REWORK_FORBIDDEN",
                            }
                        );
                    }

                    const reworkPatch = buildMassStepReworkPatch({
                        activeStep,
                        actorUserId,
                        reason,
                    });

                    // Mark the active step REWORK on every item, then push the
                    // header (status/assigned_to + rework_* metadata) to all items.
                    await updateMassItemStepRowsByLevel(
                        client,
                        massRequestId,
                        activeStep.level,
                        reworkPatch.step
                    );
                    const updateResult = await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = $2,
                             assigned_to = $3,
                             updated_at = NOW()
                         WHERE mass_request_id = $1
                         RETURNING id`,
                        [
                            massRequestId,
                            reworkPatch.header.status,
                            reworkPatch.header.assigned_to,
                        ]
                    );

                    if (updateResult.rowCount === 0) {
                        throw Object.assign(
                            new Error(
                                "Mass request is already processed or not waiting for rework"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REWORK_CONFLICT",
                            }
                        );
                    }

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        stage: stepLabel(activeStep),
                        status: reworkPatch.header.status,
                        assigned_to: reworkPatch.header.assigned_to,
                        updated_count: updateResult.rowCount,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error requesting mass request rework:", error);
            throw error;
        }
    },

    rejectMassRequestByAdmin: async ({
        massRequestId,
        actorUserId,
        actorUsername,
        reason,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const lockResult = await client.query(
                        `SELECT i.id, i.status
                         FROM mat_mass_request_item i
                         WHERE i.mass_request_id = $1
                         ORDER BY i.item_no ASC
                         LIMIT 1
                         FOR UPDATE OF i`,
                        [massRequestId]
                    );

                    if (lockResult.rows.length === 0) {
                        throw Object.assign(
                            new Error("Mass request not found"),
                            { statusCode: 404, code: "MASS_REQUEST_NOT_FOUND" }
                        );
                    }

                    const firstItem = lockResult.rows[0];

                    if (
                        String(firstItem.status || "")
                            .trim()
                            .toUpperCase() !== "SUBMIT"
                    ) {
                        throw Object.assign(
                            new Error(
                                "Mass request can only be rejected while status is Submit"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REJECT_STATUS_CONFLICT",
                            }
                        );
                    }

                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(firstItemSteps);

                    if (!activeStep) {
                        throw Object.assign(
                            new Error(
                                "Mass request is already processed or not waiting for approval"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REJECT_CONFLICT",
                            }
                        );
                    }

                    const actorIsMdmMaterial =
                        activeStep.kind === STEP_KINDS.MDM
                            ? await isActorMdmMaterialUser(client, actorUserId)
                            : false;

                    if (
                        !canActorActOnStep(activeStep, {
                            actorUserId,
                            actorUsername,
                            actorIsMdmMaterial,
                        })
                    ) {
                        throw Object.assign(
                            new Error(
                                "Forbidden: only the assigned approver or ADMIN can reject this mass request"
                            ),
                            {
                                statusCode: 403,
                                code: "MASS_REQUEST_REJECT_FORBIDDEN",
                            }
                        );
                    }

                    const rejectPatch = buildMassStepRejectPatch({
                        activeStep,
                        reason,
                    });

                    // Mark the active step REJECTED on every item, then push the
                    // header (CANCEL/Cancelled) to all items.
                    await updateMassItemStepRowsByLevel(
                        client,
                        massRequestId,
                        activeStep.level,
                        rejectPatch.step
                    );
                    const updateResult = await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = $2,
                             assigned_to = $3,
                             updated_at = NOW()
                         WHERE mass_request_id = $1
                         RETURNING id`,
                        [
                            massRequestId,
                            rejectPatch.header.status,
                            rejectPatch.header.assigned_to,
                        ]
                    );

                    if (updateResult.rowCount === 0) {
                        throw Object.assign(
                            new Error(
                                "Mass request is already processed or not waiting for rejection"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_REJECT_CONFLICT",
                            }
                        );
                    }

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        stage: stepLabel(activeStep),
                        status: rejectPatch.header.status,
                        assigned_to: rejectPatch.header.assigned_to,
                        updated_count: updateResult.rowCount,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error rejecting mass request:", error);
            throw error;
        }
    },

    getMassRequestItems: async massRequestId => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT
                        i.id,
                        i.item_no,
                        i.request_no,
                        i.ticket_type,
                        i.material_group,
                        i.material_sub_group,
                        i.material_description,
                        i.base_uom AS uom,
                        i.plant_code,
                        i.sloc_code,
                        i.po_text,
                        i.spesifikasi_tambahan,
                        i.status,
                        i.assigned_to,
                        COALESCE(item_steps.approval_steps, '[]'::jsonb) AS approval_steps,
                        item_steps.active_step
                    FROM mat_mass_request_item i
                    LEFT JOIN LATERAL (
                        SELECT
                            COALESCE(
                                jsonb_agg(
                                    jsonb_build_object(
                                        'level', s.level,
                                        'kind', s.kind,
                                        'approver_user_id', s.approver_user_id,
                                        'approver_name', COALESCE(sau.fullname, sau.username, s.approver_user_id),
                                        'status', s.status,
                                        'claimed_at', s.claimed_at,
                                        'acted_at', s.acted_at,
                                        'remark', s.remark
                                    )
                                    ORDER BY s.level
                                ) FILTER (WHERE s.id IS NOT NULL),
                                '[]'::jsonb
                            ) AS approval_steps,
                            (
                                SELECT to_jsonb(active.*)
                                FROM (
                                    SELECT a.level, a.kind, a.approver_user_id, a.status
                                    FROM mat_mass_request_item_approval_step a
                                    WHERE a.item_id = i.id
                                      AND UPPER(COALESCE(a.status, 'WAITING')) <> 'APPROVED'
                                    ORDER BY a.level
                                    LIMIT 1
                                ) active
                            ) AS active_step
                        FROM mat_mass_request_item_approval_step s
                        LEFT JOIN mst_user sau ON sau.user_id = s.approver_user_id
                        WHERE s.item_id = i.id
                    ) item_steps ON TRUE
                    WHERE i.mass_request_id = $1
                    ORDER BY i.item_no ASC`,
                    [massRequestId]
                );
                return result.rows.map(attachStepPayloadToRow);
            });
        } catch (error) {
            console.error("Error fetching mass request items:", error);
            throw error;
        }
    },

    /**
     * Save revised items after a mass request has been reworked by an approver.
     * Updates item fields, resets the reworked approval stage to WAITING,
     * and sets status back to Submit for the approver to review again.
     */
    saveMassRequestRework: async ({
        massRequestId,
        actorUserId,
        items,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const lockResult = await client.query(
                        `SELECT i.id, i.status, i.assigned_to
                         FROM mat_mass_request_item i
                         WHERE i.mass_request_id = $1
                         ORDER BY i.item_no ASC
                         LIMIT 1
                         FOR UPDATE OF i`,
                        [massRequestId]
                    );

                    if (lockResult.rows.length === 0) {
                        throw Object.assign(
                            new Error("Mass request not found"),
                            { statusCode: 404, code: "MASS_REQUEST_NOT_FOUND" }
                        );
                    }

                    const firstItem = lockResult.rows[0];
                    const status = String(firstItem.status || "").trim().toUpperCase();

                    if (status !== "REWORK") {
                        throw Object.assign(
                            new Error("Mass request rework can only be saved while status is Rework"),
                            { statusCode: 409, code: "MASS_REQUEST_REWORK_SAVE_CONFLICT" }
                        );
                    }

                    // Step model: the reworked stage is the step currently in
                    // REWORK status (the header assigned_to was 'Requester').
                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );
                    const reworkStep = firstItemSteps.find(
                        step =>
                            normalizeStepStatus(step.status) === "REWORK"
                    );

                    if (!reworkStep) {
                        throw Object.assign(
                            new Error("Mass request rework stage is missing"),
                            { statusCode: 409, code: "MASS_REQUEST_REWORK_STAGE_MISSING" }
                        );
                    }

                    const reworkStepLabel = stepLabel(reworkStep);

                    // Update each item's editable fields if items are provided
                    if (Array.isArray(items) && items.length > 0) {
                        const ALLOWED_FIELDS = [
                            "material_description",
                            "base_uom",
                            "plant_code",
                            "sloc_code",
                            "material_group",
                            "material_sub_group",
                            "po_text",
                            "spesifikasi_tambahan",
                        ];

                        for (const item of items) {
                            if (!item.id) continue;

                            const edits = {};
                            for (const field of ALLOWED_FIELDS) {
                                if (item[field] !== undefined) {
                                    edits[field] = item[field];
                                }
                            }
                            // Handle uom -> base_uom mapping
                            if (item.uom !== undefined && edits.base_uom === undefined) {
                                edits.base_uom = item.uom;
                            }

                            if (Object.keys(edits).length === 0) continue;

                            const editEntries = Object.entries(edits);
                            const setClauses = editEntries.map(
                                ([field], i) => `${field} = $${i + 3}`
                            );
                            setClauses.push("updated_at = NOW()");

                            await client.query(
                                `UPDATE mat_mass_request_item
                                 SET ${setClauses.join(", ")}
                                 WHERE id = $1 AND mass_request_id = $2`,
                                [item.id, massRequestId, ...editEntries.map(([_, v]) => v)]
                            );
                        }
                    }

                    // Reopen the reworked step (WAITING) on every item, then push
                    // the header (Submit + reworked-step label) to all items.
                    await updateMassItemStepRowsByLevel(
                        client,
                        massRequestId,
                        reworkStep.level,
                        { status: "WAITING", acted_at: null, remark: null }
                    );

                    await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = 'Submit',
                             assigned_to = $2,
                             updated_at = NOW()
                         WHERE mass_request_id = $1`,
                        [massRequestId, reworkStepLabel]
                    );

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        rework_stage: reworkStepLabel,
                        status: "Submit",
                        assigned_to: reworkStepLabel,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error saving mass request rework:", error);
            throw error;
        }
    },
};

Material.__private = {
    CREATE_SINGLE_REQUEST_INSERT_QUERY: `INSERT INTO mat_single_request (
                            id,
                            request_no,
                            ticket_type,
                            change_extend_reason,
                            material_group_id,
                            material_sub_group_id,
                            plant_code,
                            sloc_code,
                            material_description,
                            base_uom,
                            long_text_1,
                            long_text_2,
                            long_text_3,
                            template_payload,
                            status,
                            assigned_to,
                            created_by,
                            created_at,
                            updated_at,
                            approval_1_user_id,
                            approval_1_status,
                            approval_2_user_id,
                            approval_2_status,
                            approval_3_user_id,
                            approval_3_status
                        )`,
    GET_SINGLE_REQUEST_LIST_QUERY: buildSingleRequestListQuery("r.created_by = $1"),
    GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY,
    GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_LEGACY_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_LEGACY_QUERY,
    assertSingleRequestAssignableStatus,
    getSingleRequestAllowedApprovalStages,
    updateSingleRequestColumns,
    normalizeSingleRequestAttachmentRelativePath,
    normalizeMassRequestAttachmentRelativePath,
    buildSingleRequestRelativePath,
    buildMassRequestRelativePath,
    formatAttachmentDateSegment,
    prepareSingleRequestApprovalEditPatch,
    buildSingleRequestRejectPatch,
    LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    isMissingSingleRequestEditHistoryTableError,
    isMissingSingleRequestReworkColumnsError,
    GET_MASS_REQUESTS_BY_USER_QUERY,
    GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    SINGLE_REQUEST_ATTACHMENT_ROOT,
    MASS_REQUEST_ATTACHMENT_ROOT,
    LEGACY_SINGLE_REQUEST_ATTACHMENT_ROOT,
    LEGACY_MASS_REQUEST_ATTACHMENT_ROOT,
};

module.exports = Material;
