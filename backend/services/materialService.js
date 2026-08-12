// Material request service (in-scope: single + mass material requests, dynamic
// step-based approvers, MDM stage, template/form schema). warehouse_be-style
// service layer: business logic lives here. The DB methods (SQL-in-service) are
// appended in a later migration step; this file currently holds the pure domain
// logic folded from the former helper/* modules.
//
// Folding approvalSteps + singleRequestApproval + massRequestApproval into one
// module dissolves the lazy circular require they used to need.

const fs = require("fs");
const path = require("path");
const pool = require("../config/connection");
const DBClientWrapper = require("../helper/DBClientWrapper.js");
const {
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
    SINGLE_REQUEST_MATERIAL_CODE_SQL,
    MASS_ITEM_GROUP_CODE_LATERAL_SQL,
    MASS_ITEM_SUB_GROUP_CODE_LATERAL_SQL,
} = require("../constants/material");
const { normalizeWhitespace } = require("../utils/material");
const {
    notifyReworkApproversViaEmailPlaceholder,
} = require("../helper/reworkEmailPlaceholder");
const {
    buildSingleReworkEmailTemplate,
    buildMassReworkEmailTemplate,
} = require("../helper/reworkEmailTemplate");
// Required as a module object, not destructured: the rework flows call through
// the object so a test can swap sendReworkApproverEmail for a fake and no test
// process ever opens an SMTP socket (same seam as db.connect).
const reworkEmailSender = require("../helper/reworkEmailSender");
const materialSapStagingService = require("./materialSapStagingService");

// ===========================================================================
// Step engine (mat_*_approval_step) — shared by single + mass.
// "Current stage = lowest-level step not yet APPROVED."
// ===========================================================================

function normalizeStepStatus(value) {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (normalized === "") return STEP_STATUS.WAITING;
    if (normalized === "REJECT") return STEP_STATUS.REJECTED;
    return normalized;
}

function normalizeTicketType(ticketType) {
    return String(ticketType ?? "Create").trim().toUpperCase();
}

// Build the ordered step plan from a frozen manual chain + ticket type.
// CREATE = all N manual + MDM; CHANGE = first manual + MDM; EXTEND = MDM only.
// Requester with an empty manual chain falls through to MDM-only.
function buildApprovalStepPlan({ ticketType, chain = [] } = {}) {
    const tt = normalizeTicketType(ticketType);
    const manual = (Array.isArray(chain) ? chain : [])
        .map(entry => ({
            approverUserId:
                entry?.approverUserId ?? entry?.approver_user_id ?? null,
        }))
        .filter(entry => entry.approverUserId);

    if (tt === "EXTEND" || manual.length < 1) {
        return [
            { level: 1, kind: STEP_KINDS.MDM, approverUserId: null, status: STEP_INITIAL_STATUS },
        ];
    }

    if (tt === "CHANGE") {
        return [
            { level: 1, kind: STEP_KINDS.MANUAL, approverUserId: manual[0].approverUserId, status: STEP_INITIAL_STATUS },
            { level: 2, kind: STEP_KINDS.MDM, approverUserId: null, status: STEP_INITIAL_STATUS },
        ];
    }

    // CREATE (default): full manual chain + MDM.
    const plan = manual.map((entry, index) => ({
        level: index + 1,
        kind: STEP_KINDS.MANUAL,
        approverUserId: entry.approverUserId,
        status: STEP_INITIAL_STATUS,
    }));
    plan.push({
        level: manual.length + 1,
        kind: STEP_KINDS.MDM,
        approverUserId: null,
        status: STEP_INITIAL_STATUS,
    });
    return plan;
}

function sortSteps(steps) {
    return [...(Array.isArray(steps) ? steps : [])].sort(
        (a, b) => Number(a.level) - Number(b.level)
    );
}

function stepKindOf(step) {
    return String(step?.kind ?? "").trim().toUpperCase() === STEP_KINDS.MDM
        ? STEP_KINDS.MDM
        : STEP_KINDS.MANUAL;
}

function stepApproverUserId(step) {
    return step?.approver_user_id ?? step?.approverUserId ?? null;
}

// Lowest-level step whose status is not APPROVED (NULL reads as WAITING).
function resolveActiveStep(steps) {
    for (const step of sortSteps(steps)) {
        if (normalizeStepStatus(step.status) !== STEP_STATUS.APPROVED) {
            return step;
        }
    }
    return null;
}

function stepLabelByKindLevel(kind, level) {
    return String(kind).trim().toUpperCase() === STEP_KINDS.MDM
        ? "Master Data"
        : `Approval ${level}`;
}

function stepLabel(step) {
    if (!step) return null;
    return stepLabelByKindLevel(stepKindOf(step), step.level);
}

function resolveAssignedToFromSteps(steps) {
    const active = resolveActiveStep(steps);
    if (active) return stepLabel(active);
    return Array.isArray(steps) && steps.length ? "Completed" : null;
}

function isFinalStepActive(steps) {
    const active = resolveActiveStep(steps);
    return Boolean(active) && stepKindOf(active) === STEP_KINDS.MDM;
}

function findStepByLabel(steps, label) {
    const target = String(label ?? "").trim();
    return sortSteps(steps).find(step => stepLabel(step) === target) || null;
}

// Can an actor act on a given (active) step?
//   ADMIN  => always; MANUAL => assigned approver; MDM => an MDM_MATERIAL user
//   while unclaimed (approver NULL) or the claimer.
// isAdminMaterialApprover is co-located below, so the old lazy require is gone.
function canActorActOnStep(step, actor = {}) {
    if (!step) return false;
    const { actorUserId, actorUsername, actorIsMdmMaterial } = actor;
    if (
        typeof isAdminMaterialApprover === "function" &&
        isAdminMaterialApprover(actorUsername)
    ) {
        return true;
    }
    const approverUserId = stepApproverUserId(step);
    if (stepKindOf(step) === STEP_KINDS.MDM) {
        return (
            Boolean(actorIsMdmMaterial) &&
            (approverUserId == null || String(approverUserId) === String(actorUserId))
        );
    }
    return approverUserId != null && String(approverUserId) === String(actorUserId);
}

// Public payload block for a request/item from its step rows.
function buildStepsPayload(steps) {
    const sorted = sortSteps(steps);
    const active = resolveActiveStep(sorted);
    return {
        approvalSteps: sorted.map(step => ({
            level: step.level,
            kind: stepKindOf(step),
            label: stepLabel(step),
            approverUserId: stepApproverUserId(step),
            approverName: step.approver_name ?? step.approverName ?? null,
            approverEmail: step.approver_email ?? step.approverEmail ?? null,
            status: normalizeStepStatus(step.status),
            claimedAt: step.claimed_at ?? step.claimedAt ?? null,
            actedAt: step.acted_at ?? step.actedAt ?? null,
            remark: step.remark ?? null,
        })),
        currentStageLevel: active ? active.level : null,
        currentStageLabel: active ? stepLabel(active) : null,
        currentStageKind: active ? stepKindOf(active) : null,
        isFinalStage: isFinalStepActive(sorted),
        totalStages: sorted.length,
        assignedTo: resolveAssignedToFromSteps(sorted),
    };
}

// ===========================================================================
// Single-request approval rules + patch builders.
// ===========================================================================

const normalizeUsername = value => String(value || "").trim().toUpperCase();

const normalizeSingleRequestTicketType = value => {
    const normalized = normalizeUsername(value);

    if (normalized === "CHANGE") {
        return SINGLE_REQUEST_TICKET_TYPES.CHANGE;
    }

    if (normalized === "EXTEND") {
        return SINGLE_REQUEST_TICKET_TYPES.EXTEND;
    }

    return SINGLE_REQUEST_TICKET_TYPES.CREATE;
};

// Temporary material-approval fallback: normalized username ADMIN, not a generic admin-role check.
const isAdminMaterialApprover = username =>
    normalizeUsername(username) === ADMIN_APPROVER_USERNAME;

const matchesActorUserId = (assigneeUserId, actorUserId) =>
    assigneeUserId != null &&
    actorUserId != null &&
    String(assigneeUserId) === String(actorUserId);

// Separation of duties on the Master Data grab: whoever already acted as an
// approver on an earlier step of the same request must not also claim its MDM
// step, even when they are (or their group doubles as) MDM_MATERIAL.
const hasActorApprovedEarlierStep = (steps = [], activeStep, actorUserId) =>
    steps.some(
        step =>
            Number(step.level) < Number(activeStep?.level) &&
            matchesActorUserId(step.approver_user_id, actorUserId)
    );

const assertRequiredActionReason = (reason, actionLabel = "action") => {
    if (!String(reason || "").trim()) {
        const error = new Error(`${actionLabel} reason is required`);
        error.statusCode = 400;
        error.code = `${String(actionLabel || "action")
            .trim()
            .toUpperCase()}_REASON_REQUIRED`;
        error.errors = [
            {
                fieldKey: "reason",
                message: `${actionLabel} reason is required`,
            },
        ];
        throw error;
    }

    return String(reason).trim();
};

const buildFinalCodeValidationError = (message, code, fieldKey) => {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = code;
    error.errors = [
        {
            fieldKey,
            message,
        },
    ];
    return error;
};

const normalizeCodeSegment = value => String(value || "").trim();

const buildSingleRequestFinalCode = ({
    materialGroupCode,
    materialSubGroupCode,
    finalCodeSuffix,
} = {}) => {
    const groupCode = normalizeCodeSegment(materialGroupCode);
    const subGroupCode = normalizeCodeSegment(materialSubGroupCode);
    const suffix = normalizeCodeSegment(finalCodeSuffix).toUpperCase();

    if (!/^\d{3}$/.test(groupCode)) {
        throw buildFinalCodeValidationError(
            "Material group code must be exactly 3 digits",
            "SINGLE_REQUEST_FINAL_CODE_GROUP_INVALID",
            "materialGroupCode"
        );
    }

    if (!/^\d{3}$/.test(subGroupCode)) {
        throw buildFinalCodeValidationError(
            "Sub material group code must be exactly 3 digits",
            "SINGLE_REQUEST_FINAL_CODE_SUB_GROUP_INVALID",
            "materialSubGroupCode"
        );
    }

    // Running number may be letters and/or digits (e.g. "A01"), still 3 chars.
    if (!/^[A-Z0-9]{3}$/.test(suffix)) {
        throw buildFinalCodeValidationError(
            "Final code suffix must be exactly 3 letters or digits",
            "SINGLE_REQUEST_FINAL_CODE_SUFFIX_INVALID",
            "finalCodeSuffix"
        );
    }

    return `${groupCode}.${subGroupCode}.${suffix}`;
};

// ===========================================================================
// Mass-request final codes — one running number entered per item at the
// Master Data step, typed in one by one (no batch-wide auto-increment).
//
// A mass batch stages ONE VMS_MATERIALDATA row per item, each keyed by that
// item's own request_no and carrying its own material code, so the MDM
// approver hands out N codes in one action, one per item. The composition
// itself still goes through buildSingleRequestFinalCode, so a mass code and a
// single code are the same artifact (GGG.SSS.NNN) built by the same rules.
// ===========================================================================

// Mass batches are Create-only by product decision: the grid never offers
// Change/Extend (both need an existing SAP material code, which the batch grid
// has no column for) and everything below — per-item final code generation, the
// staging push keyed on that code — assumes a freshly generated code. This is
// the server-side backstop for the UI-only restriction.
const assertMassRequestRowsAreCreateOnly = (rows = []) => {
    const offending = [];

    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        // A blank/absent field reads as Create — the grid simply omits it.
        const raw = String(row?.ticketType ?? row?.ticket_type ?? "").trim();

        if (raw === "" || raw.toUpperCase() === "CREATE") {
            return;
        }

        offending.push({
            rowIndex: index,
            fieldKey: "ticketType",
            message: `Row ${index + 1}: mass material requests only support ticket type Create (got "${raw}").`,
        });
    });

    if (offending.length > 0) {
        throw Object.assign(
            new Error(
                "Mass material requests only support ticket type Create"
            ),
            {
                statusCode: 400,
                code: "MASS_REQUEST_CREATE_ONLY",
                errors: offending,
            }
        );
    }

    return true;
};

// Each item's running number must be strictly NUMERIC, matching the fixed
// 3-char suffix segment buildSingleRequestFinalCode composes into GGG.SSS.NNN.
const MASS_FINAL_CODE_SUFFIX_PATTERN = /^\d{3}$/;

const buildMassFinalCodeError = (message, code, statusCode = 409) =>
    Object.assign(new Error(message), {
        statusCode,
        code,
        errors: [{ fieldKey: "finalCodeSuffix", message }],
    });

// Resolve every item's own entered running number. `finalCodeSuffixes` is a
// map keyed by item_id (string) -> suffix, one entry per item, typed in by
// Master Data one at a time — no arithmetic, no batch-wide increment. Missing
// or malformed entries fail loudly and name the offending item.
const resolveMassItemFinalCodeSuffixes = ({
    finalCodeSuffixes,
    items = [],
} = {}) => {
    const suffixByItemId =
        finalCodeSuffixes && typeof finalCodeSuffixes === "object"
            ? finalCodeSuffixes
            : {};

    return items.map((item, index) => {
        const itemNo = item?.item_no ?? index + 1;
        const suffix = normalizeCodeSegment(
            suffixByItemId[String(item?.item_id ?? item?.id ?? "")]
        );

        if (!MASS_FINAL_CODE_SUFFIX_PATTERN.test(suffix)) {
            throw buildMassFinalCodeError(
                `Item ${itemNo}: running number is required and must be exactly 3 digits.`,
                "MASS_REQUEST_FINAL_CODE_SUFFIX_INVALID",
                400
            );
        }

        return suffix;
    });
};

// Belt-and-braces. Two siblings cannot collide by construction (every item gets
// a distinct suffix), but the composed codes are what actually gets written, so
// assert the invariant instead of trusting it — a later change to the increment
// rule (per-group running numbers, say) would otherwise silently stage two
// items onto one SAP material code.
const assertMassFinalCodesAreDistinct = (plan = []) => {
    const itemNoByCode = new Map();

    for (const entry of Array.isArray(plan) ? plan : []) {
        const code = normalizeCodeSegment(entry?.final_code);

        if (!code) {
            continue;
        }

        if (itemNoByCode.has(code)) {
            throw buildMassFinalCodeError(
                `Item ${entry?.item_no}: material code ${code} is already taken by item ${itemNoByCode.get(code)} in this same batch. Use a different running number.`,
                "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS"
            );
        }

        itemNoByCode.set(code, entry?.item_no);
    }

    return true;
};

/**
 * Compose one final code per batch item from that item's own entered running
 * number.
 *
 * @param {object} opts
 * @param {Record<string, string>} opts.finalCodeSuffixes  running number per
 *                                       item, keyed by item_id, entered one by
 *                                       one at the MDM step
 * @param {Array}  opts.items            batch items, each carrying item_id /
 *                                       item_no / request_no plus the RESOLVED
 *                                       material group + sub group CODES (the
 *                                       item table stores free text — see
 *                                       MASS_ITEM_*_CODE_LATERAL_SQL). Sorted
 *                                       by item_no here for a stable order.
 * @returns {Array<{item_id, item_no, request_no, final_code}>}
 */
const buildMassRequestFinalCodePlan = ({
    finalCodeSuffixes,
    items = [],
} = {}) => {
    const orderedItems = [...(Array.isArray(items) ? items : [])].sort(
        (a, b) => Number(a?.item_no) - Number(b?.item_no)
    );
    const suffixes = resolveMassItemFinalCodeSuffixes({
        finalCodeSuffixes,
        items: orderedItems,
    });

    const plan = orderedItems.map((item, index) => {
        const itemNo = item?.item_no ?? index + 1;
        const groupCode = normalizeCodeSegment(item?.material_group_code);
        const subGroupCode = normalizeCodeSegment(
            item?.material_sub_group_code
        );

        // The item's group/sub group are free text; when neither the code nor
        // the display name matches a master row there is nothing to compose a
        // code from, and guessing would mint a wrong SAP material number.
        if (!groupCode || !subGroupCode) {
            throw buildMassFinalCodeError(
                `Item ${itemNo}: material group / sub material group could not be resolved to a master code, so no final code can be composed. Fix that item's group values and approve again.`,
                "MASS_REQUEST_FINAL_CODE_GROUP_UNRESOLVED"
            );
        }

        return {
            item_id: item?.item_id ?? item?.id ?? null,
            item_no: itemNo,
            request_no: item?.request_no ?? null,
            final_code: buildSingleRequestFinalCode({
                materialGroupCode: groupCode,
                materialSubGroupCode: subGroupCode,
                finalCodeSuffix: suffixes[index],
            }),
        };
    });

    assertMassFinalCodesAreDistinct(plan);

    return plan;
};

const canActorReviseSingleRequest = ({
    request = {},
    actorUserId,
    actorUsername,
} = {}) =>
    isAdminMaterialApprover(actorUsername) ||
    matchesActorUserId(
        request.requester_user_id ?? request.created_by,
        actorUserId
    );

const getUniqueGroupNames = rows => {
    const names = rows
        .map(row => row.user_group_name)
        .filter(Boolean)
        .map(name => String(name).trim())
        .filter(Boolean);

    return [...new Set(names)];
};

const buildLoginUserGroupInfo = (pageAccessRows = [], userGroupId = null) => {
    const groupNames = getUniqueGroupNames(pageAccessRows);

    return {
        group_name: groupNames[0] || null,
        group_names: groupNames,
        user_group: {
            id: userGroupId,
            names: groupNames,
            is_mdm_material: groupNames.includes(MDM_MATERIAL_GROUP_NAME),
        },
    };
};

// --- Step-based action patch builders (single) -----------------------------
// Each returns `step` (SET fields for the step row) and optionally `header`
// (SET fields for the mat_single_request header row). stepLabel is co-located
// above, so the former lazy require is gone.

const buildStepApprovePatch = ({ remark = null } = {}) => ({
    step: {
        status: "APPROVED",
        acted_at: SQL_NOW_EXPRESSION,
        remark: remark ?? null,
    },
});

const buildStepReworkPatch = ({ activeStep, actorUserId, reason } = {}) => {
    const safeReason = assertRequiredActionReason(reason, "rework");

    return {
        step: {
            status: "REWORK",
            acted_at: SQL_NOW_EXPRESSION,
            remark: safeReason,
        },
        header: {
            status: "Rework",
            assigned_to: "Requester",
            rework_stage: stepLabel(activeStep),
            rework_by_user_id: actorUserId ?? null,
            rework_at: SQL_NOW_EXPRESSION,
            rework_reason: safeReason,
        },
    };
};

const buildReworkTargetError = (message, code, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    error.errors = [{ fieldKey: "reworkToLevel", message }];
    return error;
};

/**
 * Normalize the optional `reworkToLevel` request-body field.
 *
 * @param {number|string|null} [value] step level chosen by the client
 * @returns {number|null} the level, or null meaning "no target" — rework goes to
 *                        the requester, exactly as before this field existed
 * @throws 400 when present but not a positive integer. Junk is rejected rather
 *         than coerced, so a bad value can never read as "no target".
 */
const normalizeReworkToLevel = value => {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const level =
        typeof value === "number" || typeof value === "string"
            ? Number(value)
            : NaN;

    if (!Number.isInteger(level) || level < 1) {
        throw buildReworkTargetError(
            "Rework target level must be a step level number",
            "SINGLE_REQUEST_REWORK_TARGET_INVALID"
        );
    }

    return level;
};

/**
 * Rewind: send a request back to an earlier MANUAL step instead of back to the
 * requester. Sibling of buildStepReworkPatch, not a flag on it — headers differ.
 *
 * The header goes to Submit / "Approval N", never Rework / "Requester": Rework
 * means the requester must edit, Submit means somebody must approve, and a
 * rewound request is not the requester's to edit. rework_* still records who
 * sent it back, when, and why.
 *
 * Needs no step-engine change — the active step is the lowest level not
 * APPROVED, so reopening the target row makes it active again while the levels
 * above stay APPROVED, and approving it returns the request straight to Master
 * Data instead of replaying the chain.
 *
 * @param {object} opts
 * @param {Array}  opts.steps          locked step rows of THIS request; the
 *                                     target is resolved inside them, so a
 *                                     client-supplied level is never trusted
 * @param {object} opts.activeStep     the request's active step, which must be
 *                                     the Master Data (MDM) step
 * @param {number} opts.reworkToLevel  level of the MANUAL step to reopen
 * @param {string} [opts.actorUserId]  recorded as rework_by_user_id
 * @param {string} opts.reason         required; recorded as rework_reason
 * @returns {object} `{ step, targetStep, header, _meta }` — `step` patches the
 *                   active Master Data row, `targetStep` the reopened row
 *                   (`_meta.targetStep` carries its id for the caller), `header`
 *                   the mat_single_request row
 * @throws 403 when the active step is not Master Data; 400 when the level is not
 *         a MANUAL step of this request
 */
const buildStepRewindPatch = ({
    steps = [],
    activeStep,
    reworkToLevel,
    actorUserId,
    reason,
} = {}) => {
    const safeReason = assertRequiredActionReason(reason, "rework");
    const targetLevel = normalizeReworkToLevel(reworkToLevel);

    if (targetLevel === null) {
        throw buildReworkTargetError(
            "Rework target level is required",
            "SINGLE_REQUEST_REWORK_TARGET_INVALID"
        );
    }

    // Gated on the stage, not the actor. ADMIN passes canActorActOnStep
    // unconditionally, so this is the only place that can hold the line.
    if (stepKindOf(activeStep) !== STEP_KINDS.MDM) {
        throw buildReworkTargetError(
            "Only the Master Data stage can send a request back to an earlier approver",
            "SINGLE_REQUEST_REWORK_TARGET_FORBIDDEN",
            403
        );
    }

    const targetStep =
        sortSteps(steps).find(step => Number(step.level) === targetLevel) || null;

    if (!targetStep || stepKindOf(targetStep) !== STEP_KINDS.MANUAL) {
        throw buildReworkTargetError(
            "Rework target must be an approval step of this request",
            "SINGLE_REQUEST_REWORK_TARGET_INVALID"
        );
    }

    // No status check needed: Master Data is always the highest level and the
    // active step is the lowest non-APPROVED one, so with Master Data active
    // every MANUAL step below it is already APPROVED.
    const reopenStep = {
        status: STEP_STATUS.WAITING,
        acted_at: null,
        remark: null,
    };

    return {
        // Master Data reopens too, same shape the SAP resubmit flow uses. The
        // grab survives by omission — approver_user_id is never named here, so
        // the request comes back to the same Master Data user.
        step: reopenStep,
        targetStep: { ...reopenStep },
        header: {
            status: "Submit",
            assigned_to: stepLabel(targetStep),
            rework_stage: stepLabel(activeStep),
            rework_by_user_id: actorUserId ?? null,
            rework_at: SQL_NOW_EXPRESSION,
            rework_reason: safeReason,
        },
        // Surfaced so the caller can apply `targetStep` to the second row.
        _meta: { targetStep },
    };
};

// --- Chain replacement (Master Data rewrites the manual approver chain) -----
// Third rework mode, alongside "back to the requester" (buildStepReworkPatch)
// and "back to one earlier approver" (buildStepRewindPatch). Here Master Data
// throws the whole frozen MANUAL chain away and installs a new one, because the
// request was routed to the wrong approvers in the first place — rewinding to a
// wrong approver would just repeat the mistake.

const REWORK_NOTIFY_CHANNELS = Object.freeze({ APP: "APP", EMAIL: "EMAIL" });

const buildChainReplaceError = (
    message,
    code,
    { statusCode = 400, fieldKey = "newApprovers", errors = null } = {}
) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    error.errors = errors ?? [{ fieldKey, message }];
    return error;
};

/**
 * Normalize the optional `notifyVia` request-body field.
 *
 * @param {string|null} [value] channel chosen by the client, case-insensitive
 * @param {string} [codePrefix] SINGLE_REQUEST | MASS_REQUEST — error-code scope
 * @returns {'APP'|'EMAIL'} APP when absent/blank, so an old client that never
 *                          sends the field keeps the in-app-only behaviour
 * @throws 400 `<PREFIX>_REWORK_NOTIFY_INVALID` on anything else. Junk is
 *         rejected rather than coerced to APP: silently downgrading a requested
 *         EMAIL to APP would look like a delivery that simply never arrived.
 */
const normalizeReworkNotifyVia = (value, codePrefix = "SINGLE_REQUEST") => {
    if (value === undefined || value === null) {
        return REWORK_NOTIFY_CHANNELS.APP;
    }

    const channel =
        typeof value === "string" ? value.trim().toUpperCase() : null;

    if (channel === "") {
        return REWORK_NOTIFY_CHANNELS.APP;
    }

    if (
        channel !== REWORK_NOTIFY_CHANNELS.APP &&
        channel !== REWORK_NOTIFY_CHANNELS.EMAIL
    ) {
        throw buildChainReplaceError(
            "Rework notification channel must be APP or EMAIL",
            `${codePrefix}_REWORK_NOTIFY_INVALID`,
            { fieldKey: "notifyVia" }
        );
    }

    return channel;
};

/**
 * Normalize + require the mail content that goes with `notifyVia: 'EMAIL'`.
 *
 * Both fields are optional on the wire (an APP rework carries neither) but
 * mandatory once EMAIL is chosen: Master Data edits a generated draft in the
 * dialog, so a blank subject or body means the draft never loaded or the editor
 * was cleared. Sending an empty mail to an approver is worse than refusing —
 * he would get a blank message and no way to know what to review.
 *
 * @param {'APP'|'EMAIL'} notifyVia normalized channel
 * @param {object} [body] the request body's `emailSubject` / `emailBody`
 * @param {string} [codePrefix] SINGLE_REQUEST | MASS_REQUEST — error-code scope
 * @returns {{emailSubject: string, emailBody: string}|null} null on the APP
 *          channel, where there is nothing to send
 * @throws 400 `<PREFIX>_REWORK_EMAIL_CONTENT_REQUIRED` when either is blank
 */
const assertReworkEmailContent = (
    notifyVia,
    { emailSubject = null, emailBody = null } = {},
    codePrefix = "SINGLE_REQUEST"
) => {
    if (notifyVia !== REWORK_NOTIFY_CHANNELS.EMAIL) {
        return null;
    }

    const subject = typeof emailSubject === "string" ? emailSubject.trim() : "";
    const body = typeof emailBody === "string" ? emailBody.trim() : "";
    const errors = [];

    if (subject === "") {
        errors.push({
            fieldKey: "emailSubject",
            message: "Email subject is required to notify by email",
        });
    }

    if (body === "") {
        errors.push({
            fieldKey: "emailBody",
            message: "Email body is required to notify by email",
        });
    }

    if (errors.length > 0) {
        throw buildChainReplaceError(
            "Email subject and body are required to notify by email",
            `${codePrefix}_REWORK_EMAIL_CONTENT_REQUIRED`,
            { errors }
        );
    }

    // The body keeps the editor's own leading/trailing layout; only the subject
    // is trimmed, because a subject is a single line by definition.
    return { emailSubject: subject, emailBody: String(emailBody) };
};

/**
 * Does this body ask for chain replacement at all?
 *
 * Absent, null and `[]` all read as "no" so the plain rework-to-requester and
 * rewind paths stay byte-for-byte what they were; anything else (including a
 * non-array) reads as "yes" and is then rejected loudly by the plan builder,
 * never silently ignored.
 *
 * @param {*} newApprovers raw request-body value
 * @returns {boolean}
 */
const isChainReplaceRequested = newApprovers =>
    newApprovers !== undefined &&
    newApprovers !== null &&
    !(Array.isArray(newApprovers) && newApprovers.length === 0);

const normalizeNewApproverIds = (newApprovers, codePrefix) => {
    if (!Array.isArray(newApprovers) || newApprovers.length === 0) {
        throw buildChainReplaceError(
            "New approvers must be a non-empty ordered list of user ids",
            `${codePrefix}_REWORK_APPROVER_INVALID`
        );
    }

    const ids = newApprovers.map(value =>
        value === undefined || value === null ? "" : String(value).trim()
    );

    if (ids.some(id => id === "")) {
        throw buildChainReplaceError(
            "New approvers must all be user ids",
            `${codePrefix}_REWORK_APPROVER_INVALID`
        );
    }

    return ids;
};

/**
 * Chain replacement: Master Data replaces this request's whole MANUAL chain
 * with `newApprovers` (ordered, index 0 = Approval 1) and re-queues itself
 * behind them. Sibling of buildStepRewindPatch — pure logic only, so the SQL
 * stays in the service methods and this stays unit-testable.
 *
 * Why Master Data only: it is the one stage that sees every request and can
 * tell that the routing itself was wrong. A MANUAL approver rewriting the chain
 * could approve-by-substitution — swap the approvers above him for nobody, or
 * for himself. Gated on the stage, not the actor, because ADMIN passes
 * canActorActOnStep unconditionally and this is the only place that can hold
 * the line.
 *
 * Why the MDM row is patched, not recreated: its approver_user_id/claimed_at
 * carry the grab. Deleting and re-inserting it would silently return the
 * request to the open MDM pool, so the row is moved to level N+1 and reopened
 * while both grab columns go unnamed (untouched by omission).
 *
 * Levels are contiguous 1..N+1 and (request_id, level) is UNIQUE, so the caller
 * must apply the plan in this order: DELETE the MANUAL rows, THEN move the MDM
 * row to `mdmStep.level`, THEN insert `manualSteps`. Any other order can collide
 * with the MDM row's old level (e.g. 2 approvers replacing 2 approvers).
 *
 * @param {object} opts
 * @param {Array}  [opts.steps]        locked step rows of THIS request (unused
 *                                     for routing — the plan is derived from the
 *                                     new list — kept for signature symmetry
 *                                     with the sibling builders)
 * @param {object} opts.activeStep     the request's active step, which must be
 *                                     the Master Data (MDM) step; it is also the
 *                                     row that gets moved to level N+1
 * @param {Array}  opts.newApprovers   ordered mst_user user_ids, index 0 = Approval 1
 * @param {number|string|null} [opts.reworkToLevel] rewind target, if the body
 *                                     also carried one — mutually exclusive
 * @param {string} [opts.requesterUserId] request owner; may not approve his own request
 * @param {string} [opts.actorUserId]  recorded as rework_by_user_id
 * @param {string} opts.reason         required; recorded as rework_reason
 * @param {string} [opts.codePrefix]   SINGLE_REQUEST | MASS_REQUEST
 * @returns {object} `{ approverIds, manualSteps, mdmStep, header, _meta }` —
 *                   `manualSteps` are INSERT specs (insertSingleRequestApprovalSteps /
 *                   insertMassItemApprovalSteps shape), `mdmStep` is the SET
 *                   patch for the existing MDM row, `header` the request/item
 *                   header patch, `_meta.mdmStep` the MDM row itself
 * @throws 400 `<PREFIX>_REWORK_TARGET_CONFLICT` when a rewind target came too;
 *         403 `<PREFIX>_REWORK_TARGET_FORBIDDEN` when the active step is not
 *         Master Data; 400 `<PREFIX>_REWORK_APPROVER_INVALID` when the list is
 *         empty, blank, duplicated, contains the requester, or contains the
 *         Master Data claimer. Existence/active-ness of the ids needs the DB and
 *         is asserted by the caller (assertActiveApproverUsersExist).
 */
const buildStepChainReplacePlan = ({
    steps = [],
    activeStep,
    newApprovers,
    reworkToLevel = null,
    requesterUserId = null,
    actorUserId = null,
    reason,
    codePrefix = "SINGLE_REQUEST",
} = {}) => {
    void steps;
    const safeReason = assertRequiredActionReason(reason, "rework");

    // Mode conflict first: a body carrying both targets is ambiguous about what
    // the approver meant, and guessing either way rewrites the chain wrongly.
    const hasRewindTarget =
        reworkToLevel !== undefined &&
        reworkToLevel !== null &&
        reworkToLevel !== "";

    if (
        Array.isArray(newApprovers) &&
        newApprovers.length > 0 &&
        hasRewindTarget
    ) {
        throw buildChainReplaceError(
            "Choose either a rework target level or a new approver chain, not both",
            `${codePrefix}_REWORK_TARGET_CONFLICT`,
            { fieldKey: "reworkToLevel" }
        );
    }

    // Stage gate before field validation: a non-Master-Data approver must get
    // the same 403 whether or not his payload happens to be well formed.
    if (stepKindOf(activeStep) !== STEP_KINDS.MDM) {
        throw buildChainReplaceError(
            "Only the Master Data stage can replace the approver chain",
            `${codePrefix}_REWORK_TARGET_FORBIDDEN`,
            { statusCode: 403 }
        );
    }

    const ids = normalizeNewApproverIds(newApprovers, codePrefix);

    // A repeated id would make the same person approve twice, which the step
    // engine reads as two independent stages nobody can distinguish.
    if (new Set(ids).size !== ids.length) {
        throw buildChainReplaceError(
            "New approvers must be distinct",
            `${codePrefix}_REWORK_APPROVER_INVALID`
        );
    }

    if (
        requesterUserId != null &&
        ids.some(id => String(id) === String(requesterUserId))
    ) {
        throw buildChainReplaceError(
            "The requester cannot approve their own request",
            `${codePrefix}_REWORK_APPROVER_INVALID`
        );
    }

    // Separation of duties on the grab: whoever holds Master Data must not also
    // sit in the manual chain he just wrote — he would approve into himself.
    const mdmApproverUserId = stepApproverUserId(activeStep);

    if (
        mdmApproverUserId != null &&
        ids.some(id => String(id) === String(mdmApproverUserId))
    ) {
        throw buildChainReplaceError(
            "The Master Data approver cannot be part of the new approver chain",
            `${codePrefix}_REWORK_APPROVER_INVALID`
        );
    }

    const mdmLevel = ids.length + 1;

    return {
        approverIds: ids,
        // INSERT specs, not patches: these rows do not exist yet.
        manualSteps: ids.map((approverUserId, index) => ({
            level: index + 1,
            kind: STEP_KINDS.MANUAL,
            approverUserId,
            status: STEP_INITIAL_STATUS,
        })),
        // SET patch for the surviving MDM row. approver_user_id and claimed_at
        // are absent on purpose — the grab survives by omission.
        mdmStep: {
            level: mdmLevel,
            status: STEP_STATUS.WAITING,
            acted_at: null,
            remark: null,
        },
        header: {
            // Submit, never Rework: the request is not the requester's to edit,
            // it is waiting on the brand-new Approval 1.
            status: "Submit",
            assigned_to: stepLabelByKindLevel(STEP_KINDS.MANUAL, 1),
            rework_stage: stepLabel(activeStep),
            rework_by_user_id: actorUserId ?? null,
            rework_at: SQL_NOW_EXPRESSION,
            rework_reason: safeReason,
        },
        _meta: { mdmStep: activeStep, mdmLevel, reason: safeReason },
    };
};

/**
 * Build the `notify` block a rework response carries.
 *
 * MUST be called after the transaction commits: the EMAIL branch is a real (if
 * currently inert) side effect, and a side effect fired inside the transaction
 * would survive a rollback that undid the chain it announced.
 *
 * `sent` is always false today — the EMAIL template is not written yet — and
 * `placeholder` tells the client which of the two false-s it is looking at:
 * true "we owe you a mail", false "APP needs no mail at all".
 *
 * @param {'APP'|'EMAIL'} notifyVia normalized channel
 * @param {object} [ctx] context handed to the placeholder sender
 * @returns {{via: string, sent: boolean, placeholder: boolean}}
 */
const buildReworkNotifyResult = (notifyVia, ctx = {}) => {
    if (notifyVia !== REWORK_NOTIFY_CHANNELS.EMAIL) {
        return {
            via: REWORK_NOTIFY_CHANNELS.APP,
            sent: false,
            placeholder: false,
        };
    }

    return {
        via: REWORK_NOTIFY_CHANNELS.EMAIL,
        ...notifyReworkApproversViaEmailPlaceholder(ctx),
    };
};

/**
 * The `notify` block the EMAIL rework channel carries — the live send.
 *
 * Same post-commit rule as buildReworkNotifyResult, and the same reason: this
 * one really does put a mail on the wire, so it must not be able to run inside
 * a transaction that can still roll back.
 *
 * Only reached when the dialog picked somebody, because the mail is addressed to
 * that person (index 0 of the list). A rework with no picked recipient has
 * nobody to write to and keeps the inert buildReworkNotifyResult.
 *
 * Since the 2026-08-07 product decision this is the WHOLE of the EMAIL path:
 * the pick is a recipient, not an approver, so the request is not reassigned and
 * `approverUserId` names the addressee only (see requestSingleRequestRework).
 *
 * Never rejects: sendReworkApproverEmail turns every failure into
 * `{sent:false, error}` so a dead SMTP server cannot make a committed rework
 * look like it failed.
 *
 * @param {object} client pg client, used after COMMIT
 * @param {object} opts
 * @param {{emailSubject: string, emailBody: string}} opts.mailContent validated content
 * @param {'SINGLE'|'MASS'} opts.requestKind mat_rework_email.request_kind
 * @param {number} opts.requestId    mat_single_request.id / mat_mass_request.id
 * @param {string} opts.requestNo    request_no the [VMS#...] thread token names
 * @param {string} opts.approverUserId the picked new Approval 1
 * @param {string|null} opts.approverEmail his mst_user.email, already resolved
 *                                         by assertActiveApproverUsersExist
 * @param {string} [opts.actorUserId] the Master Data actor
 * @returns {Promise<{via:'EMAIL', sent:boolean, error?:string}>}
 */
const sendReworkChainReplaceEmail = async (
    client,
    {
        mailContent,
        requestKind,
        requestId,
        requestNo,
        approverUserId,
        approverEmail,
        actorUserId = null,
    } = {}
) =>
    await reworkEmailSender.sendReworkApproverEmail(client, {
        requestKind,
        requestId,
        requestNo,
        subject: mailContent.emailSubject,
        body: mailContent.emailBody,
        toEmail: approverEmail,
        toUserId: approverUserId,
        sentByUserId: actorUserId,
    });

const buildStepRejectPatch = ({ activeStep, reason } = {}) => {
    const safeReason = assertRequiredActionReason(reason, "reject");

    return {
        step: {
            status: "REJECTED",
            acted_at: SQL_NOW_EXPRESSION,
            remark: safeReason,
        },
        header: {
            status: "CANCEL",
            assigned_to: "Cancelled",
        },
        // Surfaced for callers that want to record the rejecting actor on the
        // step row without re-deriving it here.
        _meta: { rejectStep: activeStep || null },
    };
};

// ===========================================================================
// Mass-request approval (mat_mass_request_item / *_approval_step).
// ===========================================================================

/**
 * Update approval_1/2/3_user_id on a single in-flight mass-request item when the
 * administrator retargets the approver master. Unlike the single-request path
 * this does NOT touch status or assigned_to — the mass approve flow manages its
 * own stage progression. Takes a passed-in pg client (DB helper).
 */
const syncMassRequestItemApprovalSnapshot = async (
    client,
    itemId,
    patch = {}
) => {
    const setClauses = [];
    const params = [itemId];
    let paramIdx = 2;

    if (Object.prototype.hasOwnProperty.call(patch, "approval_1_user_id")) {
        setClauses.push(`approval_1_user_id = $${paramIdx}`);
        params.push(patch.approval_1_user_id ?? null);
        paramIdx++;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "approval_2_user_id")) {
        setClauses.push(`approval_2_user_id = $${paramIdx}`);
        params.push(patch.approval_2_user_id ?? null);
        paramIdx++;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "approval_3_user_id")) {
        setClauses.push(`approval_3_user_id = $${paramIdx}`);
        params.push(patch.approval_3_user_id ?? null);
        paramIdx++;
    }

    if (setClauses.length === 0) {
        return;
    }

    setClauses.push("updated_at = NOW()");

    await client.query(
        `UPDATE mat_mass_request_item
         SET ${setClauses.join(", ")}
         WHERE id = $1`,
        params
    );
};

// Mass requests are always CREATE; all items share one step plan. The `step`
// block is applied to the matching step row of EVERY item; the `header` block
// to EVERY mat_mass_request_item row by the caller.

const buildMassStepApprovePatch = ({ remark } = {}) => ({
    step: {
        status: STEP_STATUS.APPROVED,
        acted_at: SQL_NOW_EXPRESSION,
        remark: remark ?? null,
    },
});

const buildMassStepReworkPatch = ({ activeStep, actorUserId, reason } = {}) => {
    const safeReason = assertRequiredActionReason(reason, "rework");

    return {
        step: {
            status: STEP_STATUS.REWORK,
            acted_at: SQL_NOW_EXPRESSION,
            remark: safeReason,
        },
        header: {
            status: "Rework",
            assigned_to: "Requester",
            rework_stage: stepLabel(activeStep),
            rework_by_user_id: actorUserId ?? null,
            rework_at: SQL_NOW_EXPRESSION,
            rework_reason: safeReason,
        },
    };
};

const buildMassStepRejectPatch = ({ reason } = {}) => {
    const safeReason = assertRequiredActionReason(reason, "reject");

    return {
        step: {
            status: STEP_STATUS.REJECTED,
            acted_at: SQL_NOW_EXPRESSION,
            remark: safeReason,
        },
        header: {
            status: "CANCEL",
            assigned_to: "Cancelled",
        },
    };
};

// ===========================================================================
// Material template: description / long-text + value validation.
// ===========================================================================

const normalizeTemplateValue = value =>
    normalizeWhitespace(value).toUpperCase();

const hasValue = value =>
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && normalizeWhitespace(value) === "");

// Partition a full description into the four SAP columns (material description,
// 40 chars = SAP MAKTX cap, + 3 long-text continuation columns of 70 each →
// 250 total) by fixed position. This is a plain positional slice — NOT
// word-aware — so concatenating the columns back reproduces the source exactly.
// The UI's splitMaterialDescription (ui_vms/src/helper/materialDescription.js)
// uses the same positional partition; it differs only in that this create path
// collapses internal whitespace runs up-front (normalizeWhitespace) while an
// approver edit is preserved verbatim.
const MAX_COMBINED_DESCRIPTION_LENGTH =
    MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH * 3; // 250
const partitionIntoColumns = text => {
    const capped = normalizeWhitespace(text).slice(
        0,
        MAX_COMBINED_DESCRIPTION_LENGTH
    );
    return {
        material_description: capped.slice(0, MAX_MATERIAL_DESCRIPTION_LENGTH),
        long_text_1: capped.slice(
            MAX_MATERIAL_DESCRIPTION_LENGTH,
            MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH
        ),
        long_text_2: capped.slice(
            MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH,
            MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH * 2
        ),
        long_text_3: capped.slice(
            MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH * 2,
            MAX_MATERIAL_DESCRIPTION_LENGTH + MAX_LONG_TEXT_COLUMN_LENGTH * 3
        ),
    };
};

const buildMaterialDescriptionAndLongText = (templateValues = {}, templateConfig = {}) => {
    const fields = Array.isArray(templateConfig?.fields) ? templateConfig.fields : [];
    const sortedFields = [...fields].sort((a, b) => {
        const orderA = Number(a.fieldOrder ?? Number.MAX_SAFE_INTEGER);
        const orderB = Number(b.fieldOrder ?? Number.MAX_SAFE_INTEGER);
        return orderA - orderB;
    });

    const descriptionParts = [];
    for (const field of sortedFields) {
        const value = normalizeTemplateValue(templateValues[field.fieldKey]);
        if (value) {
            descriptionParts.push(value);
        }
    }

    const fullDescription = normalizeWhitespace(descriptionParts.join(" "));
    return partitionIntoColumns(fullDescription);
};

const TEMPLATE_VALIDATORS = {
    PREFIX: (value, rule) => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };

        const prefixes = normalizeTemplateValue(rule.prefix_value || "")
            .split("|")
            .map(item => item.trim())
            .filter(Boolean);
        const normalizedValue = normalizeTemplateValue(value);
        if (prefixes.length === 0) return { valid: true, normalizedValue };

        const matchedPrefix = prefixes.find(prefix =>
            normalizedValue.startsWith(prefix)
        );

        if (matchedPrefix) {
            return { valid: true, normalizedValue };
        }

        return {
            valid: false,
            normalizedValue,
        };
    },
    // Special characters are allowed in every spec input; the CAPITAL_* rules
    // only reject lowercase letters (normalizeTemplateValue uppercases anyway)
    // and NUMERIC_ONLY only rejects letters.
    CAPITAL_ONLY: value => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };
        const normalizedValue = normalizeTemplateValue(value);
        return {
            valid: /^[^a-z]+$/.test(normalizedValue),
            normalizedValue,
        };
    },
    CAPITAL_NO_SPECIAL_CHARS: value => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };
        const normalizedValue = normalizeTemplateValue(value);
        return {
            valid: /^[^a-z]+$/.test(normalizedValue),
            normalizedValue,
        };
    },
    ALPHANUMERIC_CAPITAL: value => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };
        const normalizedValue = normalizeTemplateValue(value);
        return {
            valid: /^[^a-z]+$/.test(normalizedValue),
            normalizedValue,
        };
    },
    MIXED_ALPHA_NUM_UNIT: value => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };
        const normalizedValue = normalizeTemplateValue(value);
        return {
            valid: true,
            normalizedValue,
        };
    },
    NUMERIC_ONLY: value => {
        if (!hasValue(value)) return { valid: true, normalizedValue: "" };
        const normalizedValue = normalizeTemplateValue(value).replace(
            /,/g,
            "."
        );
        return {
            valid: /^[^A-Za-z]+$/.test(normalizedValue),
            normalizedValue,
        };
    },
    NONE: value => ({
        valid: true,
        normalizedValue: hasValue(value) ? normalizeTemplateValue(value) : "",
    }),
};

const mapTemplateConfigRows = rows => {
    if (!rows.length) return null;

    const firstRow = rows[0];
    const fieldRules = rows.map(row => ({
        templateRuleId: row.template_rule_id,
        fieldId: row.field_id,
        fieldCode: row.field_code,
        fieldKey: row.field_key,
        fieldNameId: row.field_name_id,
        dataType: row.data_type,
        fieldOrder: row.field_order,
        isMandatory: row.is_mandatory,
        validationRuleType: row.validation_rule_type,
        prefixValue: row.prefix_value,
        ruleDetail: row.rule_detail,
        maxLength: row.max_length,
    }));

    return {
        templateId: firstRow.template_id,
        templateCode: firstRow.template_code,
        templateName: firstRow.template_name,
        materialGroupCode: firstRow.material_group_code,
        fields: fieldRules,
    };
};

const validateTemplateValues = (templateConfig, rawValues = {}) => {
    const errors = [];
    const normalizedValues = {};
    const descriptionParts = [];

    for (const fieldRule of templateConfig.fields) {
        const rawValue = rawValues[fieldRule.fieldKey];
        const validator =
            TEMPLATE_VALIDATORS[fieldRule.validationRuleType] ||
            TEMPLATE_VALIDATORS.NONE;
        const result = validator(rawValue, {
            prefix_value: fieldRule.prefixValue,
        });
        const normalizedValue = result.normalizedValue || "";

        if (fieldRule.isMandatory && !normalizedValue) {
            errors.push({
                fieldKey: fieldRule.fieldKey,
                fieldLabel: fieldRule.fieldNameId,
                message: `${fieldRule.fieldNameId} wajib diisi`,
            });
        }

        if (normalizedValue && !result.valid) {
            errors.push({
                fieldKey: fieldRule.fieldKey,
                fieldLabel: fieldRule.fieldNameId,
                message: `${fieldRule.fieldNameId} tidak sesuai rule ${fieldRule.validationRuleType}`,
            });
        }

        if (
            normalizedValue &&
            fieldRule.maxLength &&
            normalizedValue.length > fieldRule.maxLength
        ) {
            errors.push({
                fieldKey: fieldRule.fieldKey,
                fieldLabel: fieldRule.fieldNameId,
                message: `${fieldRule.fieldNameId} melebihi ${fieldRule.maxLength} karakter`,
            });
        }

        normalizedValues[fieldRule.fieldKey] = normalizedValue;
        if (normalizedValue) {
            descriptionParts.push(normalizedValue);
        }
    }

    const fullDescription = normalizeWhitespace(descriptionParts.join(" "));

    return {
        errors,
        normalizedValues,
        fullDescription,
        materialDescription: fullDescription,
    };
};

// ===========================================================================
// Material request form schema (one "Specification" section from template).
// ===========================================================================

const resolveSectionTitle = sectionKey =>
    SECTION_TITLES[sectionKey] ||
    String(sectionKey || "")
        .split("_")
        .filter(Boolean)
        .map(token => token.charAt(0).toUpperCase() + token.slice(1))
        .join(" ");

const ensureSection = (sections, sectionKey) => {
    if (!sections.has(sectionKey)) {
        sections.set(sectionKey, {
            key: sectionKey,
            title: resolveSectionTitle(sectionKey),
            fields: [],
        });
    }

    return sections.get(sectionKey);
};

const pushTemplateField = (sections, templateFieldRule) => {
    const section = ensureSection(sections, "specification");

    section.fields.push({
        kind: "template_field",
        fieldKey: templateFieldRule.fieldKey,
        fieldCode: templateFieldRule.fieldCode ?? null,
        fieldId: templateFieldRule.fieldId ?? null,
        label: templateFieldRule.fieldNameId,
        helperText: templateFieldRule.ruleDetail || null,
        placeholder: null,
        dataType: templateFieldRule.dataType || "TEXT",
        sectionKey: "specification",
        displayOrder: templateFieldRule.fieldOrder ?? 0,
        isRequired: Boolean(templateFieldRule.isMandatory),
        validationRuleType: templateFieldRule.validationRuleType ?? null,
        prefixValue: templateFieldRule.prefixValue ?? null,
        maxLength: templateFieldRule.maxLength ?? null,
        ruleDetail: templateFieldRule.ruleDetail ?? null,
    });
};

const sortSections = sections =>
    Array.from(sections.values())
        .map(section => ({
            ...section,
            fields: [...section.fields].sort((left, right) => {
                if (left.displayOrder !== right.displayOrder) {
                    return left.displayOrder - right.displayOrder;
                }

                return left.fieldKey.localeCompare(right.fieldKey);
            }),
        }))
        .sort((left, right) => {
            const leftIndex = SECTION_ORDER.indexOf(left.key);
            const rightIndex = SECTION_ORDER.indexOf(right.key);

            if (leftIndex !== -1 || rightIndex !== -1) {
                const safeLeftIndex =
                    leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
                const safeRightIndex =
                    rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

                if (safeLeftIndex !== safeRightIndex) {
                    return safeLeftIndex - safeRightIndex;
                }
            }

            return left.title.localeCompare(right.title);
        });

const buildMaterialFormSchema = ({
    materialGroup = null,
    subgroups = [],
    template = null,
}) => {
    const sections = new Map();

    const templateFields = Array.isArray(template?.fields)
        ? template.fields
        : [];
    for (const templateFieldRule of templateFields) {
        pushTemplateField(sections, templateFieldRule);
    }

    return {
        materialGroup,
        template,
        subgroups,
        sections: sortSections(sections),
    };
};


// ===========================================================================
// IN-SCOPE FOUNDATION (moved verbatim from models/MaterialModel.js, M4).
// SQL builders, step row helpers, attachment helpers, query constants, and the
// approval-edit patch builder used by the in-scope single/mass request methods.
// ===========================================================================

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

    const requestFields = {
        ...((source.template_payload ?? source.templatePayload ?? source)
            .requestFields || {}),
    };
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
const formatAttachmentDateSegment = (date = new Date()) => {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
};
const isRawSqlExpression = value =>
    Boolean(
        value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.__sql === "NOW()"
    );

const LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY = `SELECT
            r.id AS request_id,
            r.request_no,
            r.assigned_to,
            r.created_by,
            r.created_at,
            r.status,
            r.sap_push_status,
            r.sap_error_msg,
            r.ticket_type,
            ${SINGLE_REQUEST_MATERIAL_CODE_SQL} AS material_code,
            r.final_code,
            r.change_extend_reason,
            mig.code AS material_group_code,
            mis.code AS material_sub_group_code,
            r.created_by AS requester_user_id,
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

const getLockedSingleRequestApprovalSnapshot = async (client, requestId) => {
    const result = await client.query(
        LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
        [requestId]
    );

    if (result.rows.length === 0) {
        throw Object.assign(new Error("Single request not found"), { statusCode: 404, code: "SINGLE_REQUEST_NOT_FOUND" });
    }

    return result.rows[0];
};

// Group and sub-group codes are joined from the master tables, never stored on
// the request row, so a snapshot taken before an edit still carries the old
// codes. Re-reads them for whatever ids the request currently holds.
const loadSingleRequestGroupCodes = async (client, requestId) => {
    const result = await client.query(
        `SELECT
            mig.code AS material_group_code,
            mis.code AS material_sub_group_code
        FROM mat_single_request r
        LEFT JOIN mat_item_group mig ON mig.id = r.material_group_id
        LEFT JOIN mat_item_sub_group mis ON mis.id = r.material_sub_group_id
        WHERE r.id = $1`,
        [requestId]
    );

    return result.rows[0] || {};
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
            COALESCE(au.fullname, au.username, s.approver_user_id) AS approver_name,
            au.email AS approver_email
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
            COALESCE(au.fullname, au.username, s.approver_user_id) AS approver_name,
            au.email AS approver_email
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

// --- Mass-item final code helpers (DB side) --------------------------------

// Resolve every item's material group / sub group CODE in ONE query. The item
// table stores those two as free text (the grid writes a display name on some
// builds, a code on others), while the final-code composer needs the bare
// 3-digit codes — the two LATERAL fragments accept every shape the UI can have
// written. A NULL code means "unresolvable"; the composer turns that into a 409
// naming the item.
const loadMassItemGroupCodes = async (client, massRequestId) => {
    const result = await client.query(
        `SELECT
            i.id AS item_id,
            i.item_no,
            i.request_no,
            mig.code AS material_group_code,
            mis.code AS material_sub_group_code
         FROM mat_mass_request_item i
         ${MASS_ITEM_GROUP_CODE_LATERAL_SQL}
         ${MASS_ITEM_SUB_GROUP_CODE_LATERAL_SQL}
         WHERE i.mass_request_id = $1
         ORDER BY i.item_no ASC`,
        [massRequestId]
    );

    return result.rows;
};

// Uniqueness guard for a composed batch, mirroring the single-request one
// (approveSingleRequestByAdmin): a code must not collide with an existing SAP
// material, nor with a final_code already taken by another request still on its
// way to SAP. A CANCELled request/item releases its code — it is terminal, so
// it can never reach SAP and claim the code back. Batched with = ANY(...) so a
// 10-item batch costs 3 round-trips instead of 30; the offending item_no is
// recovered from the plan for the message.
const assertMassFinalCodePlanIsAvailable = async (
    client,
    { massRequestId, plan = [] } = {}
) => {
    const codes = plan.map(entry => entry.final_code).filter(Boolean);

    if (codes.length === 0) {
        return;
    }

    const itemNoByCode = new Map(
        plan.map(entry => [entry.final_code, entry.item_no])
    );
    const conflict = (code, detail) => {
        throw buildMassFinalCodeError(
            `Item ${itemNoByCode.get(code)}: ${detail}`,
            "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS"
        );
    };

    const sapDuplicate = await client.query(
        `SELECT code FROM mat_sap_data WHERE code = ANY($1::text[]) LIMIT 1`,
        [codes]
    );
    if (sapDuplicate.rowCount > 0) {
        const code = sapDuplicate.rows[0].code;
        conflict(
            code,
            `material code ${code} already exists in SAP master data. Use a different running number.`
        );
    }

    const singleDuplicate = await client.query(
        `SELECT request_no, final_code
         FROM mat_single_request
         WHERE final_code = ANY($1::text[])
           AND UPPER(COALESCE(status, '')) <> 'CANCEL'
         LIMIT 1`,
        [codes]
    );
    if (singleDuplicate.rowCount > 0) {
        const row = singleDuplicate.rows[0];
        conflict(
            row.final_code,
            `material code ${row.final_code} is already used by request ${row.request_no}. Use a different running number.`
        );
    }

    // Scoped to OTHER batches: this batch's own items are the rows being
    // rewritten right now (a SAP-error resubmit re-approval still carries the
    // previous codes), so they must not collide with themselves.
    const massDuplicate = await client.query(
        `SELECT request_no, item_no, final_code
         FROM mat_mass_request_item
         WHERE final_code = ANY($1::text[])
           AND mass_request_id <> $2
           AND UPPER(COALESCE(status, '')) <> 'CANCEL'
         LIMIT 1`,
        [codes, massRequestId]
    );
    if (massDuplicate.rowCount > 0) {
        const row = massDuplicate.rows[0];
        conflict(
            row.final_code,
            `material code ${row.final_code} is already used by mass request item ${row.request_no}. Use a different running number.`
        );
    }
};

const applyMassItemFinalCodes = async (client, { massRequestId, plan = [] }) => {
    for (const entry of plan) {
        await client.query(
            `UPDATE mat_mass_request_item
             SET final_code = $3,
                 updated_at = NOW()
             WHERE id = $1 AND mass_request_id = $2`,
            [entry.item_id, massRequestId, entry.final_code]
        );
    }
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
            throw Object.assign(new Error("Invalid single request attachment upload"), { statusCode: 400, code: "SINGLE_REQUEST_ATTACHMENT_INVALID_UPLOAD" });
        })();
    const safeRelativePath = path.posix.join(
        SINGLE_REQUEST_ATTACHMENT_ROOT,
        formatAttachmentDateSegment(createdAt),
        String(requestNo ?? requestId),
        path.basename(String(newName))
    );
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
            throw Object.assign(new Error("Invalid single request attachment upload"), { statusCode: 400, code: "SINGLE_REQUEST_ATTACHMENT_INVALID_UPLOAD" });
        }
        const safeRelativePath = path.posix.join(
            SINGLE_REQUEST_ATTACHMENT_ROOT,
            formatAttachmentDateSegment(createdAt),
            String(requestNo ?? requestId),
            path.basename(String(newName))
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

        const absolutePath = path.join(SINGLE_REQUEST_PUBLIC_DIRECTORY, filepath);

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
    editedRequest = { ...editedRequest };
    const ticketType = normalizeSingleRequestTicketType(snapshot.ticket_type);
    const lockedMaterialCode = resolveSingleRequestMaterialCode(snapshot);
    const lockedChangeExtendReason = snapshot.change_extend_reason ?? null;
    let editableFields;
    if (ticketType === SINGLE_REQUEST_TICKET_TYPES.CHANGE) {
        editableFields = [
            "material_description",
            "base_uom",
            "template_payload",
            "change_extend_reason",
        ];
    } else if (ticketType === SINGLE_REQUEST_TICKET_TYPES.EXTEND) {
        editableFields = ["plant_code", "sloc_code", "change_extend_reason"];
    } else {
        editableFields = [
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
        if (allowMaterialGroupChange) {
            editableFields.push("material_group_id");
        }
    }
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

            const valueChanged =
                field === "template_payload"
                    ? JSON.stringify(currentValue) !== JSON.stringify(nextValue)
                    : currentValue !== nextValue;
            if (valueChanged) {
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
            throw Object.assign(new Error("Material group is required"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_INVALID_GROUP" });
        }

        selectedMaterialGroupId = materialGroupId;

        if (materialGroupId === Number(snapshot.material_group_id)) {
            selectedMaterialGroupCode = snapshot.material_group_code;
        } else {
            selectedMaterialGroupCode =
                String(editedRequest.material_group_code || "").trim() || null;
        }

        if (!selectedMaterialGroupCode) {
            throw Object.assign(new Error("Material group is required"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_GROUP_CODE_MISSING" });
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
            throw Object.assign(new Error("Sub material group is required"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_INVALID_SUBGROUP" });
        }

        const subgroup = await getSubGroupById(materialSubGroupId);

        if (!subgroup || subgroup.deleted_at) {
            throw Object.assign(new Error("Sub material group not found"), { statusCode: 404, code: "SINGLE_REQUEST_EDIT_SUBGROUP_NOT_FOUND" });
        }

        if (Number(subgroup.item_group_id) !== Number(selectedMaterialGroupId)) {
            throw Object.assign(new Error("Sub material group does not belong to the selected material group"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_SUBGROUP_GROUP_MISMATCH" });
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

    const currentTemplatePayload = snapshot.template_payload || {};
    const currentRequestFields = {
        ...(currentTemplatePayload.requestFields || {}),
    };
    const mergedTemplatePayload = Object.prototype.hasOwnProperty.call(
        editablePatch,
        "template_payload"
    )
        ? editablePatch.template_payload || {}
        : currentTemplatePayload;
    const requestFields = {
        ...currentRequestFields,
        material_number:
            currentRequestFields.material_number ?? lockedMaterialCode,
        material_group:
            currentRequestFields.material_group ?? selectedMaterialGroupCode,
        material_description:
            editablePatch.material_description ?? snapshot.material_description,
        base_uom: editablePatch.base_uom ?? snapshot.base_uom,
        base_unit_of_measure: editablePatch.base_uom ?? snapshot.base_uom,
        moving_avg_price:
            (mergedTemplatePayload.requestFields || {}).moving_avg_price ??
            currentRequestFields.moving_avg_price,
        long_text_1: editablePatch.long_text_1 ?? snapshot.long_text_1,
        long_text_2: editablePatch.long_text_2 ?? snapshot.long_text_2,
        long_text_3: editablePatch.long_text_3 ?? snapshot.long_text_3,
        plant: editablePatch.plant_code ?? snapshot.plant_code,
        storage_location: editablePatch.sloc_code ?? snapshot.sloc_code,
    };
    const validation = await validateMaterialRequestTemplate({
        materialGroupCode: selectedMaterialGroupCode,
        requestFields,
        templateValues: mergedTemplatePayload.templateValues || {},
    });
    // For CHANGE tickets, suppress the false-positive "wajib diisi" error on a
    // mandatory template field that already has a value.
    const validationErrors = (validation.errors || []).filter(error => {
        const fieldKey = error.fieldKey ?? error.field_key;
        if (!fieldKey) {
            return false;
        }

        if (ticketType === SINGLE_REQUEST_TICKET_TYPES.CHANGE) {
            const matchingTemplateField = Array.isArray(
                validation.template?.fields
            )
                ? validation.template.fields.find(
                      field => (field?.fieldKey ?? field?.field_key) === fieldKey
                  )
                : null;
            const templateValues =
                validation.templateValues ||
                validation.normalizedTemplateValues ||
                {};
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
        }

        return true;
    });

    if (validationErrors.length > 0) {
        const error = Object.assign(new Error("Material request validation failed"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_VALIDATION_FAILED" });
        error.errors = validationErrors;
        throw error;
    }

    const validationNormalizedRequestFields =
        validation.normalizedRequestFields || {};
    const normalizedRequestFields = {
        ...validationNormalizedRequestFields,
        material_description:
            requestFields.material_description ||
            validation.materialDescription ||
            validationNormalizedRequestFields.material_description,
        storage_location:
            requestFields.storage_location ||
            requestFields.storageLocation ||
            null,
        plant: requestFields.plant || null,
    };

    for (const fieldKey of ["long_text_1", "long_text_2", "long_text_3"]) {
        if (
            requestFields[fieldKey] !== undefined &&
            requestFields[fieldKey] !== null
        ) {
            normalizedRequestFields[fieldKey] = requestFields[fieldKey];
        }
    }

    if (
        requestFields.moving_avg_price !== undefined &&
        requestFields.moving_avg_price !== null
    ) {
        normalizedRequestFields.moving_avg_price =
            requestFields.moving_avg_price;
    }

    if (
        requestFields.base_unit_of_measure !== undefined &&
        requestFields.base_unit_of_measure !== null
    ) {
        normalizedRequestFields.base_unit_of_measure =
            requestFields.base_unit_of_measure;
    }

    if (
        requestFields.base_uom !== undefined &&
        requestFields.base_uom !== null &&
        normalizedRequestFields.base_unit_of_measure === undefined
    ) {
        normalizedRequestFields.base_unit_of_measure = requestFields.base_uom;
    }

    const normalizedBaseUom =
        normalizedRequestFields.base_unit_of_measure ??
        normalizedRequestFields.base_uom;

    if (
        !normalizedRequestFields.material_description ||
        !normalizedBaseUom
    ) {
        throw Object.assign(new Error("Material description and Base UoM are required"), { statusCode: 400, code: "SINGLE_REQUEST_EDIT_REQUIRED_FIELDS_MISSING" });
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

    // Defense-in-depth: the four SAP description columns are 40 chars wide and
    // the approver UI already partitions per column (40 + 3×70), but the
    // server must not trust
    // the client — clamp here so a crafted/oversized value can never be
    // persisted past the column width and pushed to Oracle VMS_MATERIALDATA.
    // Clamp both the persisted columns (editablePatch) and the template_payload
    // copies (normalizedRequestFields, shared by reference into template_payload)
    // so the two can never disagree.
    for (const [fieldKey, maxLength] of [
        ["material_description", MAX_MATERIAL_DESCRIPTION_LENGTH],
        ["long_text_1", MAX_LONG_TEXT_COLUMN_LENGTH],
        ["long_text_2", MAX_LONG_TEXT_COLUMN_LENGTH],
        ["long_text_3", MAX_LONG_TEXT_COLUMN_LENGTH],
    ]) {
        if (typeof editablePatch[fieldKey] === "string") {
            editablePatch[fieldKey] = editablePatch[fieldKey].slice(
                0,
                maxLength
            );
        }
        if (typeof normalizedRequestFields[fieldKey] === "string") {
            normalizedRequestFields[fieldKey] = normalizedRequestFields[
                fieldKey
            ].slice(0, maxLength);
        }
    }

    return Object.entries(editablePatch).reduce((patch, [field, value]) => {
        const current = snapshot[field] ?? null;
        const next = value ?? null;
        const valueChanged =
            field === "template_payload"
                ? JSON.stringify(current) !== JSON.stringify(next)
                : current !== next;
        if (valueChanged) {
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

/**
 * The one DB-backed half of chain-replacement validation: every replacement
 * approver must be a real, ACTIVE mst_user.
 *
 * saveRequesterApproverChain (the administrator's whole-list save) checks shape
 * only and never touches mst_user, so an unchecked id there merely produces a
 * dead matrix row. Here the ids go straight onto a live request's step rows, so
 * a typo or a disabled account would strand the request on an approver who can
 * never log in — hence this extra round trip.
 *
 * One query for the whole list (ANY($1)), so cost does not grow with N.
 *
 * It also hands back each approver's e-mail. The EMAIL notification channel
 * needs exactly that address and this query has already paid for the mst_user
 * round trip inside the same locked transaction — resolving it again afterwards
 * would both cost a second query and read a row that could have changed.
 *
 * @returns {Promise<Map<string, string|null>>} user_id -> email (null when the
 *          account has no address on file)
 * @throws 400 `<PREFIX>_REWORK_APPROVER_INVALID` naming every offending id
 */
const assertActiveApproverUsersExist = async (
    client,
    approverIds = [],
    codePrefix = "SINGLE_REQUEST"
) => {
    const ids = [...new Set(approverIds.map(id => String(id)))];

    if (ids.length === 0) {
        return new Map();
    }

    const result = await client.query(
        `SELECT mu.user_id, mu.email
           FROM mst_user mu
          WHERE mu.user_id = ANY($1)
            AND mu.is_active = true`,
        [ids]
    );
    const activeEmails = new Map(
        result.rows.map(row => [String(row.user_id), row.email ?? null])
    );
    const invalidIds = ids.filter(id => !activeEmails.has(id));

    if (invalidIds.length > 0) {
        throw buildChainReplaceError(
            `Approver not found or inactive: ${invalidIds.join(", ")}`,
            `${codePrefix}_REWORK_APPROVER_INVALID`,
            {
                errors: invalidIds.map(id => ({
                    fieldKey: "newApprovers",
                    message: `Approver not found or inactive: ${id}`,
                })),
            }
        );
    }

    return activeEmails;
};

/**
 * The picked approver's display name for the rework mail greeting.
 *
 * Read-only and deliberately forgiving: the draft is a convenience, so an id
 * that names nobody (or an account with no fullname on file) simply leaves the
 * composer on its generic "Kepada Yth. Approver,". The real gate on the id is
 * assertActiveApproverUsersExist, which runs when the rework is submitted.
 *
 * ACTIVE-only for the same reason that check is: a disabled account is not an
 * approver, and putting its name on the mail would say otherwise.
 *
 * @param {object} client pg client
 * @param {string|number} [approverUserId] mst_user.user_id the dialog picked
 * @returns {Promise<string>} the fullname, or "" when there is none to use
 */
const loadReworkApproverFullname = async (client, approverUserId) => {
    const userId = String(approverUserId ?? "").trim();

    if (userId === "") {
        return "";
    }

    const result = await client.query(
        `SELECT mu.fullname
           FROM mst_user mu
          WHERE mu.user_id = $1
            AND mu.is_active = true`,
        [userId]
    );

    return String(result.rows[0]?.fullname ?? "").trim();
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
                                        'approver_email', sau.email,
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

// =====================================================================
// Rework e-mail replies — list/inbox reply indicator.
// A rework sent "via email" (chain replacement, notifyVia='EMAIL') stores
// the mail in mat_rework_email and every polled answer in
// mat_rework_email_reply. The list and inbox rows carry the reply COUNT so
// the Status cell can say a reply is waiting without opening the detail.
// =====================================================================

// Scalar subquery, never a join: the count hangs off the row it belongs to
// and can therefore not multiply it (the single-request list is GROUP BY'd
// over attachments, and a joined reply row would fan both out). Counted
// through mat_rework_email, so a request that never had a mail sent — and a
// deployment whose mat_rework_email_reply is still empty — reads 0, not NULL.
//
// `kind`   the mat_rework_email.request_kind literal ('SINGLE' | 'MASS')
// `idExpr` the outer row's request id (r.id / m.id). For MASS that is
//          mat_mass_request.id, which is what reworkEmailSender stores, so the
//          count spans the whole batch's thread rather than one item.
const buildEmailReplyCountSql = (kind, idExpr) => `(
                            SELECT COUNT(rp.id)
                            FROM mat_rework_email e
                            JOIN mat_rework_email_reply rp ON rp.rework_email_id = e.id
                            WHERE e.request_kind = '${kind}'
                              AND e.request_id = ${idExpr}
                        )::int AS email_reply_count`;

// 20260807_rework_email_thread.sql is applied by hand. Until it lands the two
// tables do not exist, and Postgres rejects the whole statement at parse time —
// so the fallback drops the subquery for a constant instead, exactly as the
// pre-rework-column fallbacks below do. The payload field never disappears.
const EMAIL_REPLY_COUNT_ABSENT_SQL = `0::int AS email_reply_count`;

const buildSingleRequestSelectFields = ({
    includeReworkFields = true,
    includeEmailReplyCount = true,
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
                        r.sap_push_status,
                        r.sap_error_msg,
                        TO_CHAR(r.sap_pushed_at, 'YYYY-MM-DD HH24:MI') AS sap_pushed_at,
                        r.created_by AS requester_user_id,
                        ${SINGLE_REQUEST_STEP_SELECT_FIELDS},
                          ${
                              includeReworkFields
                                  ? SINGLE_REQUEST_REWORK_SELECT_FIELDS
                                  : SINGLE_REQUEST_LEGACY_REWORK_SELECT_FIELDS
                          },
                          COALESCE(u.username, r.created_by) AS created_by,
                          u.email AS requester_email,
                          ${
                              includeEmailReplyCount
                                  ? buildEmailReplyCountSql("SINGLE", "r.id")
                                  : EMAIL_REPLY_COUNT_ABSENT_SQL
                          },
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
                          u.email,
                          step_rows.approval_steps,
                          step_rows.active_step`;

const buildSingleRequestListQuery = (
    whereClause,
    { includeReworkFields = true, includeEmailReplyCount = true } = {}
) => `SELECT
                        ${buildSingleRequestSelectFields({ includeReworkFields, includeEmailReplyCount })}
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
    includeEmailReplyCount = true,
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
                        r.sap_push_status,
                        r.sap_error_msg,
                        TO_CHAR(r.sap_pushed_at, 'YYYY-MM-DD HH24:MI') AS sap_pushed_at,
                        r.created_by AS requester_user_id,
                        COALESCE(u.username, r.created_by) AS created_by,
                        u.email AS requester_email,
                        ${
                            includeEmailReplyCount
                                ? buildEmailReplyCountSql("SINGLE", "r.id")
                                : EMAIL_REPLY_COUNT_ABSENT_SQL
                        },
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
                        'approver_email', sau.email,
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

// Scalar block (mass request): roll the per-ITEM sap_push_status up to one
// batch-level value, so the list/inbox rows can offer the SAP-error resubmit
// action the same way the single-request rows do off r.sap_push_status.
// Precedence is worst-first — one errored item makes the batch ERROR, and only
// an all-SYNCED batch reads SYNCED. `m` is the alias for mat_mass_request.
const MASS_REQUEST_SAP_PUSH_STATUS_SQL = `(
    SELECT CASE
        WHEN COUNT(*) FILTER (WHERE UPPER(COALESCE(si.sap_push_status, '')) = 'ERROR') > 0 THEN 'ERROR'
        WHEN COUNT(*) FILTER (WHERE UPPER(COALESCE(si.sap_push_status, '')) = 'PENDING') > 0 THEN 'PENDING'
        WHEN COUNT(*) FILTER (WHERE UPPER(COALESCE(si.sap_push_status, '')) = 'PUSHED') > 0 THEN 'PUSHED'
        WHEN COUNT(*) > 0
             AND COUNT(*) FILTER (WHERE UPPER(COALESCE(si.sap_push_status, '')) = 'SYNCED') = COUNT(*)
             THEN 'SYNCED'
        ELSE NULL
    END
    FROM mat_mass_request_item si
    WHERE si.mass_request_id = m.id
) AS sap_push_status`;

// Mass counterpart of the single-request reply scalar, keyed on the batch id
// (mat_mass_request.id) the rework mail was filed under.
const buildMassEmailReplyCountSql = includeEmailReplyCount =>
    includeEmailReplyCount
        ? buildEmailReplyCountSql("MASS", "m.id")
        : EMAIL_REPLY_COUNT_ABSENT_SQL;

const buildMassRequestsByUserQuery = ({
    includeEmailReplyCount = true,
} = {}) => `SELECT
    m.id,
    m.mass_request_no,
    m.item_count,
    m.mass_request_reason,
    m.created_by,
    m.created_by_username,
    u.email AS requester_email,
    ${buildMassEmailReplyCountSql(includeEmailReplyCount)},
    TO_CHAR(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
    first_item.first_item_material_description,
    first_item.first_item_uom AS first_item_uom,
    first_item.first_item_status,
    first_item.first_item_assigned_to,
    COALESCE(first_item.approval_steps, '[]'::jsonb) AS approval_steps,
    first_item.active_step,
    ${MASS_REQUEST_SAP_PUSH_STATUS_SQL}
FROM mat_mass_request m
LEFT JOIN mst_user u ON u.user_id = m.created_by
${MASS_REQUEST_FIRST_ITEM_STEP_LATERAL}
WHERE m.created_by = $1
ORDER BY m.created_at DESC, m.id DESC`;

const buildMassRequestApprovalInboxQuery = ({
    includeEmailReplyCount = true,
} = {}) => `SELECT
    m.id,
    m.mass_request_no,
    m.item_count,
    m.mass_request_reason,
    m.created_by,
    m.created_by_username,
    u.email AS requester_email,
    ${buildMassEmailReplyCountSql(includeEmailReplyCount)},
    TO_CHAR(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
    first_item.first_item_status,
    first_item.first_item_assigned_to,
    COALESCE(first_item.approval_steps, '[]'::jsonb) AS approval_steps,
    first_item.active_step,
    ${MASS_REQUEST_SAP_PUSH_STATUS_SQL}
FROM mat_mass_request m
LEFT JOIN mst_user u ON u.user_id = m.created_by
${MASS_REQUEST_FIRST_ITEM_STEP_LATERAL}
WHERE (
    first_item.active_step IS NOT NULL
    OR UPPER(COALESCE(first_item.first_item_status, '')) IN ('DONE', 'REWORK', 'REJECT', 'REJECTED', 'CANCEL')
)
ORDER BY m.created_at DESC, m.id DESC`;

const GET_MASS_REQUESTS_BY_USER_QUERY = buildMassRequestsByUserQuery();

const GET_MASS_REQUEST_APPROVAL_INBOX_QUERY =
    buildMassRequestApprovalInboxQuery();

const isMissingSingleRequestEditHistoryTableError = error =>
    error?.code === "42P01" &&
    /mat_single_request_edit_history/i.test(String(error?.message || ""));

const isMissingSingleRequestReworkColumnsError = error =>
    error?.code === "42703" &&
    /rework_(stage|by_user_id|at|reason)/i.test(String(error?.message || ""));

// 20260807_rework_email_thread.sql is applied by hand. Until it lands, the
// thread read degrades to "no thread" instead of 500-ing the request detail.
const isMissingReworkEmailTableError = error =>
    error?.code === "42P01" &&
    /mat_rework_email/i.test(String(error?.message || ""));

const runSingleRequestListQuery = async (client, whereClause, params = []) => {
    let includeReworkFields = true;
    let includeEmailReplyCount = true;

    while (true) {
        try {
            return await client.query(
                buildSingleRequestListQuery(whereClause, {
                    includeReworkFields,
                    includeEmailReplyCount,
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

            if (includeEmailReplyCount && isMissingReworkEmailTableError(error)) {
                includeEmailReplyCount = false;
                continue;
            }

            throw error;
        }
    }
};

const runSingleRequestApprovalInboxQuery = async client => {
    let includeEditHistory = true;
    let includeReworkFields = true;
    let includeEmailReplyCount = true;

    while (true) {
        try {
            return await client.query(
                buildSingleRequestApprovalInboxQuery({
                    includeEditHistory,
                    includeReworkFields,
                    includeEmailReplyCount,
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

            if (includeEmailReplyCount && isMissingReworkEmailTableError(error)) {
                includeEmailReplyCount = false;
                continue;
            }

            throw error;
        }
    }
};

// Mass counterparts of the two runners above. Their only degradation is the
// reply scalar — everything else the mass queries read has been there since
// the batch tables themselves.
const runMassRequestQuery = async (client, buildQuery, params = []) => {
    let includeEmailReplyCount = true;

    while (true) {
        try {
            return await client.query(
                buildQuery({ includeEmailReplyCount }),
                params
            );
        } catch (error) {
            if (includeEmailReplyCount && isMissingReworkEmailTableError(error)) {
                includeEmailReplyCount = false;
                continue;
            }

            throw error;
        }
    }
};

const runMassRequestsByUserQuery = async (client, createdBy) =>
    await runMassRequestQuery(client, buildMassRequestsByUserQuery, [createdBy]);

const runMassRequestApprovalInboxQuery = async client =>
    await runMassRequestQuery(client, buildMassRequestApprovalInboxQuery);

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

const actorMatchesStep = (step, actorUserId) => {
    const approverUserId =
        step == null ? null : step.approver_user_id ?? step.approverUserId ?? null;
    return (
        approverUserId != null &&
        actorUserId != null &&
        String(approverUserId) === String(actorUserId)
    );
};

// Non-admin inbox visibility over step rows:
//   already acted on any step (any status) => always visible, so e.g.
//                                              Approval 1 doesn't lose sight
//                                              of a request just because it
//                                              moved on to Approval 2/MDM;
//   otherwise, in-flight (active step exists) => canActorActOnStep on the
//                                                 active step (it's currently
//                                                 their turn);
//   otherwise                                  => not visible.
const isStepRowVisibleForActor = (
    steps,
    { actorUserId, actorUsername, actorIsMdmMaterial }
) => {
    if (isAdminMaterialApprover(actorUsername)) {
        return true;
    }

    if (
        (Array.isArray(steps) ? steps : []).some(step =>
            actorMatchesStep(step, actorUserId)
        )
    ) {
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

    return false;
};

// Inbox scope: an opt-in widening of the visibility filter above, requested per
// call. Anything absent or unrecognized reads as DEFAULT, so a caller that sends
// nothing keeps exactly the response it has today.
const INBOX_SCOPES = {
    DEFAULT: "DEFAULT",
    MDM_ALL: "MDM_ALL",
};

// Wire value of the widened scope (`?scope=mdmAll` on the approval-inbox routes).
const INBOX_SCOPE_MDM_ALL_PARAM = "mdmAll";

const normalizeInboxScope = value =>
    String(value ?? "").trim().toLowerCase() ===
    INBOX_SCOPE_MDM_ALL_PARAM.toLowerCase()
        ? INBOX_SCOPES.MDM_ALL
        : INBOX_SCOPES.DEFAULT;

// MDM_ALL companion to isStepRowVisibleForActor: every request a Master Data
// user has ever grabbed. This is the exact generalization of the "already acted
// on any step (any status) => always visible" rule above, widened from "me" to
// "any Master Data user".
//
// Neither the step's status nor which step is currently active is consulted, on
// purpose. A grab is never released, so the Master Data user who took a request
// still holds it while the request sits in REWORK with the requester (grabber
// kept, status flipped to REWORK), after a REJECT, and after the final APPROVED
// that completes it. Keying off the active step would drop completed requests
// entirely — their MDM step is APPROVED, so resolveActiveStep returns null —
// and would keep REWORK only by accident.
//
// On an MDM step a non-null approver_user_id can only mean a grab:
// claimMdmSingleRequestStep is its only writer, and nothing auto-assigns the
// step (see the note on the approve advance step).
//
// Unioned with the normal predicate rather than replacing it, so the widened
// result is always a superset — rows the actor grabbed themselves already pass
// the normal path. MANUAL steps are excluded: the Approval 1/2 queues stay
// private. Visibility only — canActorActOnStep is deliberately untouched, so
// approve / rework / reject / claim on somebody else's grabbed row still 403s.
const hasGrabbedMdmStep = steps =>
    (Array.isArray(steps) ? steps : []).some(
        step =>
            stepKindOf(step) === STEP_KINDS.MDM &&
            stepApproverUserId(step) != null
    );

// Spread the step payload onto every row and (for non-admins) filter by
// per-step visibility. Always returns the payload-enriched rows.
const applyStepInboxVisibility = (
    rows = [],
    { actorUserId, actorUsername, actorIsMdmMaterial, scope } = {}
) => {
    const isAdmin = isAdminMaterialApprover(actorUsername);
    // Authorization for the widened scope is decided here, off the DB-backed
    // actorIsMdmMaterial flag the caller resolved — never off a client-supplied
    // one. A non-Master-Data caller asking for MDM_ALL just gets its normal list.
    const includeGrabbedMdmRows =
        normalizeInboxScope(scope) === INBOX_SCOPES.MDM_ALL &&
        Boolean(actorIsMdmMaterial);

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
                }) ||
                (includeGrabbedMdmRows && hasGrabbedMdmStep(steps))
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


// ===========================================================================
// IN-SCOPE REQUEST METHODS (moved verbatim from models/MaterialModel.js, M5).
// Single + mass material-request DB operations. Grouped in one object so the
// 4 former Material.X sibling calls resolve to module.exports.X.
// ===========================================================================

const MaterialRequests = {
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
                p.company_code AS company_code,
                so.sales_org_code        AS sales_org_code,
                so.sales_org_description AS sales_org_description,
                sl.description AS sloc_description
            FROM public.mst_plant p
            LEFT JOIN public.mst_storage_location sl ON sl.plant_code = p.plant_code
            LEFT JOIN public.mst_sales_org so ON so.company_code = p.company_code
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

    // Per-request approver retarget (ADMIN). In the step model the approver for
    // each MANUAL stage lives on that stage's step row, so this best-effort
    // updates the matching manual step's approver_user_id while it is still
    // WAITING. approval1UserId -> manual level 1, approval2UserId -> level 2.
    assignSingleRequestApproversByAdmin: async (payload = {}) => {
        const { requestId, actorUsername } = payload;

        try {
            if (!isAdminMaterialApprover(actorUsername)) {
                throw Object.assign(new Error("Forbidden: single request approver assignment is only available for ADMIN"), { statusCode: 403, code: "SINGLE_REQUEST_APPROVER_ASSIGNMENT_FORBIDDEN" });
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
                            requestId
                        );

                    if (snapshot.status !== "Submit") {
                        throw Object.assign(new Error("Single request approvers can only be assigned while status is Submit"), { statusCode: 409, code: "SINGLE_REQUEST_APPROVER_ASSIGNMENT_STATUS_CONFLICT" });
                    }

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
                        throw Object.assign(new Error("Forbidden: only an active MDM_MATERIAL user can claim the Master Data step"), { statusCode: 403, code: "SINGLE_REQUEST_MDM_CLAIM_FORBIDDEN" });
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep || activeStep.kind !== STEP_KINDS.MDM) {
                        throw Object.assign(new Error("Master Data step is not currently open for this request"), { statusCode: 409, code: "SINGLE_REQUEST_MDM_STEP_NOT_ACTIVE" });
                    }

                    if (hasActorApprovedEarlierStep(steps, activeStep, actorUserId)) {
                        throw Object.assign(new Error("Forbidden: you already acted as an approver on this request and cannot claim its Master Data step"), { statusCode: 403, code: "SINGLE_REQUEST_MDM_CLAIM_PRIOR_APPROVER" });
                    }

                    const won = await claimMdmSingleRequestStep(
                        client,
                        activeStep.id,
                        actorUserId
                    );

                    if (!won) {
                        throw Object.assign(new Error("Master Data step has already been claimed"), { statusCode: 409, code: "ALREADY_CLAIMED" });
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
                        throw Object.assign(new Error("Forbidden: only an active MDM_MATERIAL user can claim the Master Data step"), { statusCode: 403, code: "MASS_REQUEST_MDM_CLAIM_FORBIDDEN" });
                    }

                    const firstItemSteps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );

                    if (firstItemSteps.length === 0) {
                        throw Object.assign(new Error("Mass request not found"), { statusCode: 404, code: "MASS_REQUEST_NOT_FOUND" });
                    }

                    const activeStep = resolveActiveStep(firstItemSteps);

                    if (!activeStep || activeStep.kind !== STEP_KINDS.MDM) {
                        throw Object.assign(new Error("Master Data step is not currently open for this mass request"), { statusCode: 409, code: "MASS_REQUEST_MDM_STEP_NOT_ACTIVE" });
                    }

                    if (hasActorApprovedEarlierStep(firstItemSteps, activeStep, actorUserId)) {
                        throw Object.assign(new Error("Forbidden: you already acted as an approver on this request and cannot claim its Master Data step"), { statusCode: 403, code: "MASS_REQUEST_MDM_CLAIM_PRIOR_APPROVER" });
                    }

                    const won = await claimMdmMassItemStep(
                        client,
                        massRequestId,
                        activeStep.level,
                        actorUserId
                    );

                    if (!won) {
                        throw Object.assign(new Error("Master Data step has already been claimed"), { statusCode: 409, code: "ALREADY_CLAIMED" });
                    }

                    const refreshedSteps = await loadMassItemSteps(
                        client,
                        massRequestId
                    );

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        ...buildStepsPayload(refreshedSteps),
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
            const result = await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // --- Step-based routing (dynamic approver flow) ---
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    // Only a request actively awaiting approval can be approved.
                    // Guards against approving one sitting in Rework (e.g. after a
                    // SAP-error resubmit) before the requester has fixed the data
                    // — mirrors the rework/reject handlers.
                    if (snapshot.status !== "Submit") {
                        throw Object.assign(
                            new Error(
                                "Single request can only be approved while status is Submit"
                            ),
                            {
                                statusCode: 409,
                                code: "SINGLE_REQUEST_APPROVAL_STATUS_CONFLICT",
                            }
                        );
                    }

                    const normalizedTicketType =
                        normalizeSingleRequestTicketType(snapshot.ticket_type);
                    const safeRemark = remark ?? null;
                    const currentChangeExtendReason =
                        snapshot.change_extend_reason ?? null;
                    // Lazy require avoids a module-load cycle (MaterialTemplateModel
                    // re-exports template helpers from this service).
                    const MaterialTemplate = require("../models/MaterialTemplateModel");
                    const editablePatch =
                        await prepareSingleRequestApprovalEditPatch({
                            snapshot,
                            editedRequest,
                            getSubGroupById: module.exports.getSubGroupById,
                            validateMaterialRequestTemplate:
                                MaterialTemplate.validateMaterialRequestTemplate,
                        });

                    const steps = await loadSingleRequestSteps(client, requestId, {
                        forUpdate: true,
                    });
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw Object.assign(new Error("Single request is already processed or not waiting for approval"), { statusCode: 409, code: "SINGLE_REQUEST_APPROVAL_CONFLICT" });
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
                        throw Object.assign(new Error("Forbidden: only the assigned approver or ADMIN can approve this request"), { statusCode: 403, code: "SINGLE_REQUEST_APPROVAL_FORBIDDEN" });
                    }

                    if (
                        normalizedTicketType ===
                            SINGLE_REQUEST_TICKET_TYPES.CREATE &&
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

                    // Master Data can change the sub material group in the same
                    // action that assigns the running number, and the codes on
                    // the snapshot were joined before that edit was written. Re-read
                    // them so the final code is composed from the group the request
                    // ends up with, not the one it arrived at this stage with.
                    const editedGroupIds =
                        Object.prototype.hasOwnProperty.call(
                            editablePatch,
                            "material_group_id"
                        ) ||
                        Object.prototype.hasOwnProperty.call(
                            editablePatch,
                            "material_sub_group_id"
                        );
                    const refreshedGroupCodes = editedGroupIds
                        ? await loadSingleRequestGroupCodes(client, requestId)
                        : null;

                    const nextSnapshot = {
                        ...snapshot,
                        ...editablePatch,
                        ...(refreshedGroupCodes ?? {}),
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
                            throw Object.assign(new Error("Material code is required for Change requests"), { statusCode: 400, code: "SINGLE_REQUEST_CHANGE_MATERIAL_CODE_REQUIRED" });
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
                            throw Object.assign(new Error("Change request material code must match exactly one material"), { statusCode: 409, code: "SINGLE_REQUEST_CHANGE_MATERIAL_CODE_CONFLICT" });
                        }
                    }

                    if (
                        isMdmStep &&
                        normalizedTicketType ===
                            SINGLE_REQUEST_TICKET_TYPES.EXTEND
                    ) {
                        if (!materialCode) {
                            throw Object.assign(new Error("Material code is required for Extend requests"), { statusCode: 400, code: "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_REQUIRED" });
                        }

                        const materialExistsResult = await client.query(
                            `SELECT 1
                             FROM mat_sap_data
                             WHERE code = $1`,
                            [materialCode]
                        );

                        if (materialExistsResult.rowCount !== 1) {
                            throw Object.assign(new Error("Extend request material code was not found"), { statusCode: 404, code: "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_NOT_FOUND" });
                        }

                        const selectedPlantCode = String(
                            nextSnapshot.plant_code || ""
                        ).trim();
                        const selectedStorageLocation = String(
                            nextSnapshot.sloc_code || ""
                        ).trim();

                        if (!selectedPlantCode || !selectedStorageLocation) {
                            throw Object.assign(new Error("Plant and storage location are required"), { statusCode: 400, code: "SINGLE_REQUEST_EXTEND_LOCATION_REQUIRED" });
                        }

                        const locations = await module.exports.getLocationAndPlant();
                        const hasMatchingLocation = locations.some(
                            location =>
                                String(location.plant_code || "").trim() ===
                                    selectedPlantCode &&
                                String(
                                    location.storage_location || ""
                                ).trim() === selectedStorageLocation
                        );

                        if (!hasMatchingLocation) {
                            throw Object.assign(new Error("Selected plant and storage location were not found"), { statusCode: 400, code: "SINGLE_REQUEST_EXTEND_LOCATION_NOT_FOUND" });
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
                            throw Object.assign(new Error("Extend request material code must match exactly one material"), { statusCode: 409, code: "SINGLE_REQUEST_EXTEND_MATERIAL_CODE_CONFLICT" });
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

                    // Uniqueness guard: the assembled code must not collide with
                    // an existing SAP material (mat_sap_data mirror) nor with a
                    // final_code already taken by another request still on its
                    // way to SAP (DONE but not yet synced into mat_sap_data).
                    // A cancelled request releases its code: it is terminal, so
                    // it can never reach SAP and claim the code back.
                    if (finalCode) {
                        const buildDuplicateFinalCodeError = message =>
                            Object.assign(new Error(message), {
                                statusCode: 409,
                                code: "SINGLE_REQUEST_FINAL_CODE_ALREADY_EXISTS",
                                errors: [
                                    { fieldKey: "finalCodeSuffix", message },
                                ],
                            });

                        const sapDuplicate = await client.query(
                            `SELECT 1 FROM mat_sap_data WHERE code = $1 LIMIT 1`,
                            [finalCode]
                        );
                        if (sapDuplicate.rowCount > 0) {
                            throw buildDuplicateFinalCodeError(
                                `Material code ${finalCode} already exists in SAP master data. Use a different running number.`
                            );
                        }

                        const requestDuplicate = await client.query(
                            `SELECT request_no FROM mat_single_request
                             WHERE final_code = $1 AND id <> $2
                               AND UPPER(COALESCE(status, '')) <> 'CANCEL'
                             LIMIT 1`,
                            [finalCode, requestId]
                        );
                        if (requestDuplicate.rowCount > 0) {
                            throw buildDuplicateFinalCodeError(
                                `Material code ${finalCode} is already used by request ${requestDuplicate.rows[0].request_no}. Use a different running number.`
                            );
                        }
                    }

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
                    if (!nextActive) {
                        // Terminal completion: flag the request for the Oracle
                        // SAP-staging push, performed out-of-band by the cron
                        // job (pushPendingMaterialsToSapStaging).
                        headerPatch.sap_push_status = "PENDING";
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

            // Immediate SAP staging push on terminal completion (the MDM/final
            // stage was just approved). Best-effort + out-of-transaction: the
            // request is already committed DONE with sap_push_status='PENDING',
            // so a push failure here leaves it PENDING (recoverable) and must
            // NOT fail the approval response. The cron only handles SAP's
            // write-back sync now, not the outbound push.
            if (result && result.status === "DONE") {
                try {
                    await materialSapStagingService.pushPendingMaterialsToSapStaging(
                        { requestId, limit: 1 }
                    );
                } catch (pushError) {
                    console.error(
                        `Immediate SAP staging push failed for request ${requestId}:`,
                        pushError
                    );
                }
            }

            return result;
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

                    const normalizedPersistedRequestFields = {
                        ...requestFields,
                    };
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
                        file_path: path.posix.join(
                            SINGLE_REQUEST_ATTACHMENT_ROOT,
                            formatAttachmentDateSegment(createdAt),
                            String(requestNo ?? nextId),
                            path.basename(String(file.newName))
                        ),
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
            // Pure body-shape check: settle it before a transaction is opened.
            // The grid only ever offers Create; this is the server-side backstop
            // (see assertMassRequestRowsAreCreateOnly for why the rest of the
            // mass pipeline depends on it).
            assertMassRequestRowsAreCreateOnly(rows);

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
                            file_path: (itemRow?.request_no ?? itemRequestNo)
                                ? path.posix.join(
                                      MASS_REQUEST_ATTACHMENT_ROOT,
                                      formatAttachmentDateSegment(
                                          attachmentCreatedAt
                                      ),
                                      String(
                                          itemRow?.request_no ?? itemRequestNo
                                      ),
                                      path.basename(String(file.newName))
                                  )
                                : path.posix.join(
                                      MASS_REQUEST_ATTACHMENT_ROOT,
                                      formatAttachmentDateSegment(
                                          attachmentCreatedAt
                                      ),
                                      String(nextMassId),
                                      String(nextItemId),
                                      path.basename(String(file.newName))
                                  ),
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
                const result = await runMassRequestsByUserQuery(
                    client,
                    createdBy
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
                    throw Object.assign(new Error("Single request not found"), { statusCode: 404, code: "SINGLE_REQUEST_NOT_FOUND" });
                }

                if (
                    !isAdminMaterialApprover(actorUsername) &&
                    String(row.requester_user_id || "") !==
                        String(actorUserId || "")
                ) {
                    throw Object.assign(new Error("Forbidden: only requester or ADMIN can view this request"), { statusCode: 403, code: "SINGLE_REQUEST_VIEW_FORBIDDEN" });
                }

                return row;
            });
        } catch (error) {
            console.error("Error fetching single request by id:", error);
            throw error;
        }
    },

    getSingleRequestApprovalInbox: async (actorUserId, actorUsername, scope) => {
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
                    scope,
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

    // Three mutually exclusive rework modes, all reached through this one entry
    // point so the status/actor gates below cannot be bypassed by picking one:
    //   neither field  -> back to the requester (original behaviour)
    //   reworkToLevel  -> rewind to that MANUAL step
    //   newApprovers   -> Master Data replaces the whole MANUAL chain
    // `notifyVia` is orthogonal and defaults to APP; on EMAIL it also requires
    // the (editable) `emailSubject` / `emailBody` the dialog prefilled from
    // getSingleRequestReworkEmailTemplate.
    requestSingleRequestRework: async ({
        requestId,
        actorUserId,
        actorUsername,
        reason,
        reworkToLevel = null,
        newApprovers = null,
        notifyVia = null,
        emailSubject = null,
        emailBody = null,
    }) => {
        try {
            // Pure body-shape checks: settle them before a transaction is
            // opened rather than BEGIN/ROLLBACK for a malformed request.
            const notifyChannel = normalizeReworkNotifyVia(
                notifyVia,
                "SINGLE_REQUEST"
            );
            const mailContent = assertReworkEmailContent(
                notifyChannel,
                { emailSubject, emailBody },
                "SINGLE_REQUEST"
            );
            const replaceChain = isChainReplaceRequested(newApprovers);

            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (snapshot.status !== "Submit") {
                        throw Object.assign(new Error("Single request rework can only be requested while status is Submit"), { statusCode: 409, code: "SINGLE_REQUEST_REWORK_STATUS_CONFLICT" });
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw Object.assign(new Error("Single request is already processed or not waiting for approval"), { statusCode: 409, code: "SINGLE_REQUEST_REWORK_CONFLICT" });
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
                        throw Object.assign(new Error("Forbidden: only the assigned approver or ADMIN can request rework"), { statusCode: 403, code: "SINGLE_REQUEST_REWORK_FORBIDDEN" });
                    }

                    if (replaceChain) {
                        const plan = buildStepChainReplacePlan({
                            steps,
                            activeStep,
                            newApprovers,
                            reworkToLevel,
                            requesterUserId:
                                snapshot.requester_user_id ??
                                snapshot.created_by,
                            actorUserId,
                            reason,
                            codePrefix: "SINGLE_REQUEST",
                        });

                        const approverEmails =
                            await assertActiveApproverUsersExist(
                                client,
                                plan.approverIds,
                                "SINGLE_REQUEST"
                            );

                        // "Via email" is CORRESPONDENCE ONLY (product decision
                        // 2026-08-07). The picked person is the RECIPIENT of a
                        // mail, not a new approver: the request is not
                        // reassigned, so nothing here writes a step row or the
                        // header. It stays claimed at Master Data, MDM reads the
                        // replies, edits by hand and carries on in-app. `plan`
                        // is still built above because its validation is the
                        // contract on the recipient list (distinct, not the
                        // requester, not the MDM claimer) — only its patches go
                        // unused. `reason` is likewise validated (the plan
                        // builder requires it) and then deliberately dropped:
                        // there is no rework to record it against.
                        if (mailContent) {
                            // Read-only transaction: COMMIT just drops the FOR
                            // UPDATE locks. The send still happens after it, for
                            // the same reason as the reassigning path below.
                            await client.query("COMMIT");

                            const notify = await sendReworkChainReplaceEmail(
                                client,
                                {
                                    mailContent,
                                    requestKind: "SINGLE",
                                    requestId: Number(requestId),
                                    requestNo: snapshot.request_no ?? null,
                                    approverUserId: plan.approverIds[0],
                                    approverEmail:
                                        approverEmails.get(
                                            String(plan.approverIds[0])
                                        ) ?? null,
                                    actorUserId,
                                }
                            );

                            return {
                                request_id: Number(requestId),
                                stage: stepLabel(activeStep),
                                // The request's CURRENT values, unchanged — the
                                // client must not repaint the row as moved.
                                status: snapshot.status,
                                assigned_to:
                                    snapshot.assigned_to ??
                                    stepLabel(activeStep),
                                notify,
                                emailOnly: true,
                            };
                        }

                        // Order is forced by UNIQUE (request_id, level): the old
                        // MANUAL rows go first, then the surviving MDM row moves
                        // up to N+1, and only then can 1..N be inserted.
                        await client.query(
                            `DELETE FROM mat_single_request_approval_step
                              WHERE request_id = $1
                                AND kind = $2`,
                            [requestId, STEP_KINDS.MANUAL]
                        );
                        // approver_user_id / claimed_at are not in the patch, so
                        // the Master Data grab survives the rewrite.
                        await updateSingleRequestStepRow(
                            client,
                            plan._meta.mdmStep.id,
                            plan.mdmStep
                        );
                        await insertSingleRequestApprovalSteps(
                            client,
                            requestId,
                            plan.manualSteps
                        );
                        await updateSingleRequestColumns(client, requestId, {
                            ...plan.header,
                            rework_by_user_id: actorUserId ?? null,
                        });
                        await client.query("COMMIT");

                        // Post-commit on purpose (see buildReworkNotifyResult).
                        // Always the APP block: the EMAIL channel returned above
                        // without reassigning anything, so a reassignment can
                        // only have been asked for in-app.
                        const notify = buildReworkNotifyResult(notifyChannel, {
                            requestId: Number(requestId),
                            requestNo: snapshot.request_no ?? null,
                            approverUserIds: plan.approverIds,
                            reason: plan._meta.reason,
                        });

                        return {
                            request_id: Number(requestId),
                            stage: stepLabel(activeStep),
                            status: plan.header.status,
                            assigned_to: plan.header.assigned_to,
                            notify,
                        };
                    }

                    const targetLevel = normalizeReworkToLevel(reworkToLevel);
                    const reworkPatch =
                        targetLevel === null
                            ? buildStepReworkPatch({
                                  activeStep,
                                  reason,
                              })
                            : buildStepRewindPatch({
                                  steps,
                                  activeStep,
                                  reworkToLevel: targetLevel,
                                  reason,
                              });

                    await updateSingleRequestStepRow(client, activeStep.id, {
                        ...reworkPatch.step,
                        approver_user_id:
                            activeStep.approver_user_id ?? actorUserId ?? null,
                    });
                    if (reworkPatch.targetStep) {
                        await updateSingleRequestStepRow(
                            client,
                            reworkPatch._meta.targetStep.id,
                            reworkPatch.targetStep
                        );
                    }
                    await updateSingleRequestColumns(client, requestId, {
                        ...reworkPatch.header,
                        rework_by_user_id: actorUserId ?? null,
                    });
                    await client.query("COMMIT");

                    return {
                        request_id: Number(requestId),
                        stage: stepLabel(activeStep),
                        status: reworkPatch.header.status,
                        assigned_to: reworkPatch.header.assigned_to,
                        // Post-commit on purpose (see buildReworkNotifyResult).
                        // No mail even on the EMAIL channel: rework-to-requester
                        // and rewind pick nobody, so there is no address the
                        // notification could be sent to.
                        notify: buildReworkNotifyResult(notifyChannel, {
                            requestId: Number(requestId),
                            requestNo: snapshot.request_no ?? null,
                            approverUserIds: [],
                            reason,
                        }),
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

                    if (snapshot.status !== "Submit") {
                        throw Object.assign(new Error("Single request reject can only be processed while status is Submit"), { statusCode: 409, code: "SINGLE_REQUEST_REJECT_STATUS_CONFLICT" });
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const activeStep = resolveActiveStep(steps);

                    if (!activeStep) {
                        throw Object.assign(new Error("Single request is already processed or not waiting for approval"), { statusCode: 409, code: "SINGLE_REQUEST_REJECT_CONFLICT" });
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
                        throw Object.assign(new Error("Forbidden: only the assigned approver or ADMIN can reject this request"), { statusCode: 403, code: "SINGLE_REQUEST_REJECT_FORBIDDEN" });
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

    // SAP rejected the request (sap_push_status='ERROR'). Send it back to the
    // MDM stage. mode "requester" (default): reopen as a rework — the requester
    // reopens the Master Data step directly (WAITING, last grabber preserved)
    // so the MDM user edits the data in the approval dialog and re-approves.
    // Only an active MDM_MATERIAL user (or ADMIN) may do this — requesters and
    // manual approvers cannot resubmit. Re-approval sets sap_push_status back
    // to 'PENDING' and the inline push re-stages the row (idempotent
    // DELETE+INSERT -> fresh FLAG='I' with the corrected data). The manual
    // approvers are NOT re-run — only the Master Data (MDM) stage reopens.
    requestSapErrorRework: async ({ requestId, actorUserId, actorUsername }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");
                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (
                        String(snapshot.sap_push_status || "").toUpperCase() !==
                        "ERROR"
                    ) {
                        throw Object.assign(
                            new Error(
                                "Only a request rejected by SAP can be resubmitted"
                            ),
                            {
                                statusCode: 409,
                                code: "SINGLE_REQUEST_SAP_RETRY_CONFLICT",
                            }
                        );
                    }

                    const actorIsMdmMaterial = await isActorMdmMaterialUser(
                        client,
                        actorUserId
                    );
                    if (
                        !actorIsMdmMaterial &&
                        !isAdminMaterialApprover(actorUsername)
                    ) {
                        throw Object.assign(
                            new Error(
                                "Forbidden: only an active MDM_MATERIAL user or ADMIN can resubmit this request"
                            ),
                            {
                                statusCode: 403,
                                code: "SINGLE_REQUEST_SAP_RETRY_FORBIDDEN",
                            }
                        );
                    }

                    const steps = await loadSingleRequestSteps(
                        client,
                        requestId,
                        { forUpdate: true }
                    );
                    const mdmStep = steps.find(
                        step => stepKindOf(step) === STEP_KINDS.MDM
                    );
                    if (!mdmStep) {
                        throw Object.assign(
                            new Error(
                                "Master Data (MDM) stage not found for this request"
                            ),
                            {
                                statusCode: 409,
                                code: "SINGLE_REQUEST_SAP_RETRY_NO_MDM",
                            }
                        );
                    }

                    // Reopen the Master Data step in place: WAITING with the
                    // last grabber's approver_user_id untouched, request back
                    // to Submit so the MDM user can edit + re-approve. The
                    // re-approval resets the staging row to freshly-submitted
                    // state (PENDING -> push -> FLAG='I').
                    await updateSingleRequestStepRow(client, mdmStep.id, {
                        status: "WAITING",
                        acted_at: null,
                        remark: null,
                    });
                    await updateSingleRequestColumns(client, requestId, {
                        status: "Submit",
                        assigned_to: stepLabel(mdmStep),
                        sap_push_status: null,
                        sap_error_msg: null,
                    });

                    await client.query("COMMIT");
                    return {
                        request_id: Number(requestId),
                        stage: stepLabel(mdmStep),
                        status: "Submit",
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error starting SAP-error rework:", error);
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
        const normalizedEditedRequest = { ...(editedRequest || {}) };

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    const snapshot =
                        await getLockedSingleRequestApprovalSnapshot(
                            client,
                            requestId
                        );

                    if (snapshot.status !== "Rework") {
                        throw Object.assign(new Error("Single request rework can only be saved while status is Rework"), { statusCode: 409, code: "SINGLE_REQUEST_REWORK_SAVE_CONFLICT" });
                    }

                    if (!snapshot.rework_stage) {
                        throw Object.assign(new Error("Single request rework stage is missing"), { statusCode: 409, code: "SINGLE_REQUEST_REWORK_STAGE_MISSING" });
                    }

                    if (
                        !canActorReviseSingleRequest({
                            request: snapshot,
                            actorUserId,
                            actorUsername,
                        })
                    ) {
                        throw Object.assign(new Error("Forbidden: only requester or ADMIN can revise this request"), { statusCode: 403, code: "SINGLE_REQUEST_REVISE_FORBIDDEN" });
                    }

                    // Lazy require avoids a module-load cycle (MaterialTemplateModel
                    // re-exports template helpers from this service).
                    const MaterialTemplate = require("../models/MaterialTemplateModel");
                    const editablePatch =
                        await prepareSingleRequestApprovalEditPatch({
                            snapshot,
                            editedRequest: normalizedEditedRequest,
                            allowMaterialGroupChange: true,
                            getSubGroupById: module.exports.getSubGroupById,
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
                        throw Object.assign(new Error("Single request rework stage is missing"), { statusCode: 409, code: "SINGLE_REQUEST_REWORK_STAGE_MISSING" });
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
                            throw Object.assign(new Error(`${ticketType} requests do not support attachments`), { statusCode: 400, code: "SINGLE_REQUEST_ATTACHMENT_UNSUPPORTED" });
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
                            throw Object.assign(new Error("Plant, storage location, and change or extend reason are required"), { statusCode: 400, code: "SINGLE_REQUEST_EXTEND_REWORK_REQUIRED_FIELDS_MISSING" });
                        }
                    }

                    if (
                        normalizeSingleRequestTicketType(ticketType) ===
                            SINGLE_REQUEST_TICKET_TYPES.CREATE &&
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
                            throw Object.assign(new Error(`Maximum ${SINGLE_REQUEST_MAX_ATTACHMENTS} attachments are allowed`), { statusCode: 400, code: "SINGLE_REQUEST_ATTACHMENT_LIMIT_EXCEEDED" });
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
            return module.exports.getRequesterApproverChain(requesterUserId);
        });
    },

    getMassRequestApprovalInbox: async (actorUserId, actorUsername, scope) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await runMassRequestApprovalInboxQuery(client);
                const actorIsMdmMaterial = await isActorMdmMaterialUser(
                    client,
                    actorUserId
                );

                return applyStepInboxVisibility(result.rows, {
                    actorUserId,
                    actorUsername,
                    actorIsMdmMaterial,
                    scope,
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
        finalCodeSuffixes,
    }) => {
        try {
            const result = await DBClientWrapper(async client => {
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

                    // Per-item final codes: only when the active step is the
                    // Master Data one (always the last step of the plan, so a
                    // mass batch is Create-only and every item needs a code).
                    // Composed AFTER the item edits above — the MDM approver can
                    // fix an item's group/sub group in the same action that
                    // assigns the running number, and the code must follow the
                    // group the item ends up with.
                    const isMdmStep = activeStep.kind === STEP_KINDS.MDM;
                    const finalCodePlan = isMdmStep
                        ? buildMassRequestFinalCodePlan({
                              finalCodeSuffixes,
                              items: await loadMassItemGroupCodes(
                                  client,
                                  massRequestId
                              ),
                          })
                        : [];

                    if (finalCodePlan.length > 0) {
                        await assertMassFinalCodePlanIsAvailable(client, {
                            massRequestId,
                            plan: finalCodePlan,
                        });
                        await applyMassItemFinalCodes(client, {
                            massRequestId,
                            plan: finalCodePlan,
                        });
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

                    // Terminal completion: flag EVERY item for the Oracle
                    // SAP-staging push (one VMS_MATERIALDATA row per item). The
                    // inline push below picks them up right after COMMIT, same
                    // as the single flow.
                    const updateResult = await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = $2,
                             assigned_to = $3,${
                                 nextActive
                                     ? ""
                                     : "\n                             sap_push_status = 'PENDING',"
                             }
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
                        final_codes: finalCodePlan.map(entry => ({
                            item_no: entry.item_no,
                            request_no: entry.request_no,
                            final_code: entry.final_code,
                        })),
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });

            // Immediate SAP staging push on terminal completion, mirroring the
            // single flow: best-effort + out-of-transaction. The items are
            // already committed DONE with sap_push_status='PENDING', so a push
            // failure here leaves them PENDING (recoverable by the next cron
            // tick) and must NOT fail the approval response.
            if (result && result.status === "DONE") {
                try {
                    await materialSapStagingService.pushPendingMaterialsToSapStaging(
                        {
                            massRequestId,
                            limit: Math.max(result.updated_count || 0, 1),
                        }
                    );
                } catch (pushError) {
                    console.error(
                        `Immediate SAP staging push failed for mass request ${massRequestId}:`,
                        pushError
                    );
                }
            }

            return result;
        } catch (error) {
            console.error("Error approving mass request:", error);
            throw error;
        }
    },

    // Two rework modes (no `reworkToLevel` here — mass rework never gained the
    // rewind): no `newApprovers` = back to the requester, `newApprovers` =
    // Master Data replaces the MANUAL chain of EVERY item in the batch.
    // `notifyVia` defaults to APP; on EMAIL it also requires the (editable)
    // `emailSubject` / `emailBody` the dialog prefilled from
    // getMassRequestReworkEmailTemplate.
    requestMassRequestRework: async ({
        massRequestId,
        actorUserId,
        actorUsername,
        reason,
        newApprovers = null,
        notifyVia = null,
        emailSubject = null,
        emailBody = null,
    }) => {
        try {
            // Pure body-shape checks: settle them before a transaction is
            // opened rather than BEGIN/ROLLBACK for a malformed request.
            const notifyChannel = normalizeReworkNotifyVia(
                notifyVia,
                "MASS_REQUEST"
            );
            const mailContent = assertReworkEmailContent(
                notifyChannel,
                { emailSubject, emailBody },
                "MASS_REQUEST"
            );
            const replaceChain = isChainReplaceRequested(newApprovers);

            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // request_no rides along on the lock: this row IS the
                    // batch's thread identity (see the [VMS#...] token note in
                    // migration/20260807_rework_email_thread.sql).
                    const lockResult = await client.query(
                        `SELECT i.id, i.status, i.created_by, i.request_no, i.assigned_to
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

                    if (replaceChain) {
                        const plan = buildStepChainReplacePlan({
                            steps: firstItemSteps,
                            activeStep,
                            newApprovers,
                            requesterUserId: firstItem.created_by,
                            actorUserId,
                            reason,
                            codePrefix: "MASS_REQUEST",
                        });

                        const approverEmails =
                            await assertActiveApproverUsersExist(
                                client,
                                plan.approverIds,
                                "MASS_REQUEST"
                            );

                        // "Via email" is CORRESPONDENCE ONLY (product decision
                        // 2026-08-07) — see the twin branch in
                        // requestSingleRequestRework. The batch is not
                        // reassigned: no step row, no item header, nothing. The
                        // picked person is the mail's recipient, the batch stays
                        // claimed at Master Data, and `reason` is validated by
                        // the plan builder and then dropped.
                        if (mailContent) {
                            // Read-only transaction: COMMIT just drops the FOR
                            // UPDATE locks. The send still happens after it.
                            await client.query("COMMIT");

                            const notify = await sendReworkChainReplaceEmail(
                                client,
                                {
                                    mailContent,
                                    requestKind: "MASS",
                                    requestId: Number(massRequestId),
                                    requestNo: firstItem.request_no ?? null,
                                    approverUserId: plan.approverIds[0],
                                    approverEmail:
                                        approverEmails.get(
                                            String(plan.approverIds[0])
                                        ) ?? null,
                                    actorUserId,
                                }
                            );

                            return {
                                mass_request_id: Number(massRequestId),
                                stage: stepLabel(activeStep),
                                // The batch's CURRENT values, unchanged.
                                status: firstItem.status,
                                assigned_to:
                                    firstItem.assigned_to ??
                                    stepLabel(activeStep),
                                // Nothing was written, so nothing was updated.
                                updated_count: 0,
                                notify,
                                emailOnly: true,
                            };
                        }

                        // Steps are mirrored per item, so every write below fans
                        // out over the batch exactly like approveMassRequest
                        // does — join back to mat_mass_request_item on
                        // mass_request_id, never touch one item's rows alone.
                        const itemsResult = await client.query(
                            `SELECT i.id
                             FROM mat_mass_request_item i
                             WHERE i.mass_request_id = $1
                             ORDER BY i.item_no ASC`,
                            [massRequestId]
                        );

                        // Order is forced by UNIQUE (item_id, level): drop the
                        // old MANUAL rows, move the surviving MDM rows up to
                        // N+1, then insert 1..N per item.
                        await client.query(
                            `DELETE FROM mat_mass_request_item_approval_step s
                             USING mat_mass_request_item i
                             WHERE s.item_id = i.id
                               AND i.mass_request_id = $1
                               AND s.kind = $2`,
                            [massRequestId, STEP_KINDS.MANUAL]
                        );
                        // Matched by the MDM step's CURRENT level (still the old
                        // one at this point). approver_user_id / claimed_at are
                        // not in the patch, so the grab survives the rewrite.
                        await updateMassItemStepRowsByLevel(
                            client,
                            massRequestId,
                            activeStep.level,
                            plan.mdmStep
                        );
                        for (const item of itemsResult.rows) {
                            await insertMassItemApprovalSteps(
                                client,
                                item.id,
                                plan.manualSteps
                            );
                        }

                        // mat_mass_request_item carries no rework_* columns, so
                        // the header write stays status/assigned_to like every
                        // other mass action.
                        const chainUpdateResult = await client.query(
                            `UPDATE mat_mass_request_item
                             SET status = $2,
                                 assigned_to = $3,
                                 updated_at = NOW()
                             WHERE mass_request_id = $1
                             RETURNING id`,
                            [
                                massRequestId,
                                plan.header.status,
                                plan.header.assigned_to,
                            ]
                        );

                        if (chainUpdateResult.rowCount === 0) {
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

                        // Post-commit on purpose (see buildReworkNotifyResult).
                        // Always the APP block: the EMAIL channel returned above
                        // without reassigning anything.
                        const notify = buildReworkNotifyResult(notifyChannel, {
                            massRequestId: Number(massRequestId),
                            approverUserIds: plan.approverIds,
                            reason: plan._meta.reason,
                        });

                        return {
                            mass_request_id: Number(massRequestId),
                            stage: stepLabel(activeStep),
                            status: plan.header.status,
                            assigned_to: plan.header.assigned_to,
                            updated_count: chainUpdateResult.rowCount,
                            notify,
                        };
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
                        // Post-commit on purpose (see buildReworkNotifyResult).
                        // No mail even on the EMAIL channel: rework-to-requester
                        // picks nobody, so there is no address to send to.
                        notify: buildReworkNotifyResult(notifyChannel, {
                            massRequestId: Number(massRequestId),
                            approverUserIds: [],
                            reason,
                        }),
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

    // SAP rejected one or more items of the batch (item sap_push_status =
    // 'ERROR'). Mirror of the single-request requestSapErrorRework, lifted to
    // the batch: a mass action is always request-level, so ANY errored item
    // reopens the Master Data step for the WHOLE batch (the MDM approver edits
    // the offending rows in the approval dialog and re-approves; re-approval
    // recomposes the final codes, sets every item back to PENDING and the
    // inline push re-stages them — idempotent DELETE+INSERT, fresh FLAG='I').
    // Only an active MDM_MATERIAL user (or ADMIN) may do this, and the manual
    // approvers are NOT re-run.
    requestMassSapErrorRework: async ({
        massRequestId,
        actorUserId,
        actorUsername,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Lock the batch on its first item — the same anchor row
                    // approveMassRequest takes — so a concurrent approve or a
                    // second resubmit cannot interleave between this check and
                    // the reopen below. This is also the existence probe: the
                    // error-count aggregate that follows can NOT serve as one,
                    // because an ungrouped COUNT always returns exactly one row
                    // (a missing batch would read as "0 errors" -> 409 instead
                    // of 404).
                    const lockResult = await client.query(
                        `SELECT i.id
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

                    const errorCountResult = await client.query(
                        `SELECT COUNT(*) AS error_count
                         FROM mat_mass_request_item i
                         WHERE i.mass_request_id = $1
                           AND UPPER(COALESCE(i.sap_push_status, '')) = 'ERROR'`,
                        [massRequestId]
                    );

                    if (
                        Number(errorCountResult.rows[0].error_count || 0) === 0
                    ) {
                        throw Object.assign(
                            new Error(
                                "Only a mass request with items rejected by SAP can be resubmitted"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_SAP_RETRY_CONFLICT",
                            }
                        );
                    }

                    const actorIsMdmMaterial = await isActorMdmMaterialUser(
                        client,
                        actorUserId
                    );
                    if (
                        !actorIsMdmMaterial &&
                        !isAdminMaterialApprover(actorUsername)
                    ) {
                        throw Object.assign(
                            new Error(
                                "Forbidden: only an active MDM_MATERIAL user or ADMIN can resubmit this mass request"
                            ),
                            {
                                statusCode: 403,
                                code: "MASS_REQUEST_SAP_RETRY_FORBIDDEN",
                            }
                        );
                    }

                    const steps = await loadMassItemSteps(
                        client,
                        massRequestId,
                        { forUpdate: true }
                    );
                    const mdmStep = steps.find(
                        step => stepKindOf(step) === STEP_KINDS.MDM
                    );
                    if (!mdmStep) {
                        throw Object.assign(
                            new Error(
                                "Master Data (MDM) stage not found for this mass request"
                            ),
                            {
                                statusCode: 409,
                                code: "MASS_REQUEST_SAP_RETRY_NO_MDM",
                            }
                        );
                    }

                    // Reopen the Master Data step in place on every item:
                    // WAITING with the last grabber's approver_user_id
                    // untouched, items back to Submit. final_code is left as-is
                    // — the re-approval overwrites it with the newly entered
                    // running number.
                    await updateMassItemStepRowsByLevel(
                        client,
                        massRequestId,
                        mdmStep.level,
                        { status: "WAITING", acted_at: null, remark: null }
                    );
                    const updateResult = await client.query(
                        `UPDATE mat_mass_request_item
                         SET status = 'Submit',
                             assigned_to = $2,
                             sap_push_status = NULL,
                             sap_error_msg = NULL,
                             updated_at = NOW()
                         WHERE mass_request_id = $1
                         RETURNING id`,
                        [massRequestId, stepLabel(mdmStep)]
                    );

                    await client.query("COMMIT");

                    return {
                        mass_request_id: Number(massRequestId),
                        stage: stepLabel(mdmStep),
                        status: "Submit",
                        updated_count: updateResult.rowCount,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error starting mass SAP-error rework:", error);
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
                        i.final_code,
                        i.sap_push_status,
                        i.sap_pushed_at,
                        i.sap_error_msg,
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
                                        'approver_email', sau.email,
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

    // =====================================================================
    // Rework e-mail thread (chain replacement, notifyVia = EMAIL).
    // Two reads per request kind: the DRAFT the Master Data dialog prefills,
    // and the THREAD (mails sent + replies polled back off IMAP) the request
    // detail renders read-only.
    // =====================================================================

    /**
     * The rework mail draft for a SINGLE request.
     *
     * Composed from the request's own row through the existing list loader —
     * the Master Data dialog then edits it, so nothing here is final.
     *
     * @param {object} opts
     * @param {number|string} opts.requestId mat_single_request.id
     * @param {string} [opts.approverUserId] the approver the dialog picked, so
     *        the greeting can address him by name; optional, and an id that
     *        names no active user simply keeps the generic greeting
     * @returns {Promise<{subject: string, body: string}>}
     * @throws 404 SINGLE_REQUEST_NOT_FOUND
     */
    getSingleRequestReworkEmailTemplate: async ({
        requestId,
        approverUserId,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await runSingleRequestListQuery(
                    client,
                    "r.id = $1",
                    [requestId]
                );
                const row = result.rows[0];

                if (!row) {
                    throw Object.assign(new Error("Single request not found"), {
                        statusCode: 404,
                        code: "SINGLE_REQUEST_NOT_FOUND",
                    });
                }

                const approverName = await loadReworkApproverFullname(
                    client,
                    approverUserId
                );
                const { subject, body } = buildSingleReworkEmailTemplate(row, {
                    approverName,
                });

                return { subject, body };
            });
        } catch (error) {
            console.error(
                "Error building single request rework email template:",
                error
            );
            throw error;
        }
    },

    /**
     * The rework mail draft for a MASS request (the whole batch).
     *
     * Reuses getMassRequestItems: mass rework acts on every item at once, so
     * the draft has to list every item anyway and there is no lighter read.
     *
     * @param {object} opts
     * @param {number|string} opts.massRequestId mat_mass_request.id
     * @param {string} [opts.approverUserId] the approver the dialog picked, so
     *        the greeting can address him by name; optional, and an id that
     *        names no active user simply keeps the generic greeting
     * @returns {Promise<{subject: string, body: string}>}
     * @throws 404 MASS_REQUEST_NOT_FOUND
     */
    getMassRequestReworkEmailTemplate: async ({
        massRequestId,
        approverUserId,
    }) => {
        try {
            const items =
                await MaterialRequests.getMassRequestItems(massRequestId);

            if (!Array.isArray(items) || items.length === 0) {
                throw Object.assign(new Error("Mass request not found"), {
                    statusCode: 404,
                    code: "MASS_REQUEST_NOT_FOUND",
                });
            }

            // Its own client, unlike the single path: the item read above owns
            // (and has already released) the only one this method holds, and a
            // request with no picked approver never asks for one at all.
            const approverName =
                String(approverUserId ?? "").trim() === ""
                    ? ""
                    : await DBClientWrapper(client =>
                          loadReworkApproverFullname(client, approverUserId)
                      );
            const { subject, body } = buildMassReworkEmailTemplate(items, {
                approverName,
            });

            return { subject, body };
        } catch (error) {
            console.error(
                "Error building mass request rework email template:",
                error
            );
            throw error;
        }
    },

    /**
     * Every rework mail sent for one request, newest first, each with its
     * replies.
     *
     * Returns [] rather than throwing when the tables are not there yet, so a
     * deployment that has not run 20260807_rework_email_thread.sql simply shows
     * no thread section (same tolerance runSingleRequestListQuery already has
     * for the rework columns).
     *
     * @param {object} opts
     * @param {'SINGLE'|'MASS'} opts.requestKind which request table
     * @param {number|string} opts.requestId the request's id
     * @returns {Promise<Array<{id:number, subject:string, body:string, toEmail:string, sendStatus:string, sentAt:Date, replies:Array}>>}
     */
    getReworkEmailThread: async ({ requestKind, requestId }) => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT
                         e.id,
                         e.subject,
                         e.body,
                         e.to_email,
                         e.send_status,
                         e.send_error,
                         e.sent_at,
                         COALESCE(reply_rows.replies, '[]'::jsonb) AS replies
                     FROM mat_rework_email e
                     LEFT JOIN LATERAL (
                         SELECT jsonb_agg(
                                    jsonb_build_object(
                                        'fromEmail', rp.from_email,
                                        'senderMatches', rp.sender_matches,
                                        'receivedAt', COALESCE(rp.received_at, rp.created_at),
                                        'bodyText', rp.body_text
                                    )
                                    ORDER BY COALESCE(rp.received_at, rp.created_at), rp.id
                                ) AS replies
                         FROM mat_rework_email_reply rp
                         WHERE rp.rework_email_id = e.id
                     ) reply_rows ON TRUE
                     WHERE e.request_kind = $1
                       AND e.request_id = $2
                     ORDER BY e.sent_at DESC, e.id DESC`,
                    [requestKind, requestId]
                );

                return result.rows.map(row => ({
                    id: Number(row.id),
                    subject: row.subject,
                    body: row.body,
                    toEmail: row.to_email,
                    sendStatus: row.send_status,
                    sendError: row.send_error ?? null,
                    sentAt: row.sent_at,
                    replies: Array.isArray(row.replies) ? row.replies : [],
                }));
            });
        } catch (error) {
            if (isMissingReworkEmailTableError(error)) {
                return [];
            }

            console.error("Error fetching rework email thread:", error);
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

// Test-only export surface (was MaterialModel's Material.__private). The same
// SQL strings + helpers the .cjs tests assert against, now read from the service.
const __private = {
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
    updateSingleRequestColumns,
    formatAttachmentDateSegment,
    prepareSingleRequestApprovalEditPatch,
    LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    isMissingSingleRequestEditHistoryTableError,
    isMissingSingleRequestReworkColumnsError,
    isMissingReworkEmailTableError,
    GET_MASS_REQUESTS_BY_USER_QUERY,
    GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    buildMassRequestsByUserQuery,
    buildMassRequestApprovalInboxQuery,
    EMAIL_REPLY_COUNT_ABSENT_SQL,
    MASS_REQUEST_SAP_PUSH_STATUS_SQL,
    SINGLE_REQUEST_ATTACHMENT_ROOT,
    MASS_REQUEST_ATTACHMENT_ROOT,
};

module.exports = {
    // in-scope request DB methods (M4): callable directly by controllers/tests
    ...MaterialRequests,
    // test-only surface
    __private,
    // constants re-exported for back-compat with the former helper modules
    STEP_KINDS,
    STEP_STATUS,
    STEP_INITIAL_STATUS,
    MDM_MATERIAL_GROUP_NAME,
    SINGLE_REQUEST_TICKET_TYPES,
    // step engine
    normalizeStepStatus,
    buildApprovalStepPlan,
    resolveActiveStep,
    stepLabel,
    stepLabelByKindLevel,
    resolveAssignedToFromSteps,
    isFinalStepActive,
    findStepByLabel,
    canActorActOnStep,
    buildStepsPayload,
    // single approval
    normalizeUsername,
    normalizeSingleRequestTicketType,
    isAdminMaterialApprover,
    assertRequiredActionReason,
    buildSingleRequestFinalCode,
    // mass final codes (one numeric running number per item, entered one by one)
    assertMassRequestRowsAreCreateOnly,
    resolveMassItemFinalCodeSuffixes,
    assertMassFinalCodesAreDistinct,
    buildMassRequestFinalCodePlan,
    loadMassItemGroupCodes,
    assertMassFinalCodePlanIsAvailable,
    applyMassItemFinalCodes,
    canActorReviseSingleRequest,
    buildLoginUserGroupInfo,
    buildStepApprovePatch,
    buildStepReworkPatch,
    normalizeReworkToLevel,
    buildStepRewindPatch,
    // chain replacement (shared single + mass)
    REWORK_NOTIFY_CHANNELS,
    normalizeReworkNotifyVia,
    isChainReplaceRequested,
    buildStepChainReplacePlan,
    buildReworkNotifyResult,
    assertReworkEmailContent,
    sendReworkChainReplaceEmail,
    assertActiveApproverUsersExist,
    buildStepRejectPatch,
    // mass approval
    syncMassRequestItemApprovalSnapshot,
    buildMassStepApprovePatch,
    buildMassStepReworkPatch,
    buildMassStepRejectPatch,
    // template
    buildMaterialDescriptionAndLongText,
    hasValue,
    mapTemplateConfigRows,
    normalizeTemplateValue,
    validateTemplateValues,
    // form schema
    buildMaterialFormSchema,
    // ---- in-scope foundation (M4): SQL builders, step/attachment helpers, queries ----
    resolveSingleRequestMaterialCode,
    SINGLE_REQUEST_MAX_ATTACHMENTS,
    SINGLE_REQUEST_PUBLIC_DIRECTORY,
    SINGLE_REQUEST_ATTACHMENT_ROOT,
    MASS_REQUEST_PUBLIC_DIRECTORY,
    MASS_REQUEST_ATTACHMENT_ROOT,
    formatAttachmentDateSegment,
    isRawSqlExpression,
    LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    getLockedSingleRequestApprovalSnapshot,
    loadSingleRequestGroupCodes,
    updateSingleRequestColumns,
    loadRequesterChain,
    insertSingleRequestApprovalSteps,
    loadSingleRequestSteps,
    updateSingleRequestStepRow,
    claimMdmSingleRequestStep,
    insertMassItemApprovalSteps,
    loadMassItemSteps,
    updateMassItemStepRowsByLevel,
    claimMdmMassItemStep,
    getSingleRequestAttachments,
    insertSingleRequestAttachment,
    persistSingleRequestAttachmentFiles,
    deleteSingleRequestStoredFiles,
    prepareSingleRequestApprovalEditPatch,
    queryUsersWithPageAccessByIds,
    queryActiveMdmMaterialUsers,
    isActorMdmMaterialUser,
    buildSingleRequestStepLateral,
    buildSingleRequestSelectFields,
    buildSingleRequestListQuery,
    buildSingleRequestApprovalInboxQuery,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_LEGACY_QUERY,
    GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY,
    GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY,
    GET_MASS_REQUESTS_BY_USER_QUERY,
    GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    buildMassRequestsByUserQuery,
    buildMassRequestApprovalInboxQuery,
    buildEmailReplyCountSql,
    EMAIL_REPLY_COUNT_ABSENT_SQL,
    isMissingSingleRequestEditHistoryTableError,
    isMissingSingleRequestReworkColumnsError,
    isMissingReworkEmailTableError,
    runSingleRequestListQuery,
    runSingleRequestApprovalInboxQuery,
    runMassRequestQuery,
    runMassRequestsByUserQuery,
    runMassRequestApprovalInboxQuery,
    normalizeRowApprovalSteps,
    attachStepPayloadToRow,
    actorMatchesStep,
    isStepRowVisibleForActor,
    INBOX_SCOPES,
    INBOX_SCOPE_MDM_ALL_PARAM,
    normalizeInboxScope,
    hasGrabbedMdmStep,
    applyStepInboxVisibility,
    GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY,
};
