const {
    resolveSingleRequestApprovalStage,
    isRequestStatusVisibleInApprovalList,
    isAdminMaterialApprover,
    getApprovalStageFieldPrefix,
    assertRequiredActionReason,
    normalizeApprovalStatus,
    INITIAL_APPROVAL_STATUS,
} = require("./singleRequestApproval");

const {
    STEP_STATUS,
    resolveActiveStep,
    stepLabel,
    resolveAssignedToFromSteps,
    canActorActOnStep,
    isFinalStepActive,
    buildStepsPayload,
    findStepByLabel,
} = require("./approvalSteps");

const SQL_NOW_EXPRESSION = Object.freeze({ __sql: "NOW()" });

const matchesActorUserId = (assigneeUserId, actorUserId) =>
    assigneeUserId != null &&
    actorUserId != null &&
    String(assigneeUserId) === String(actorUserId);

/**
 * Convert a mass-request inbox row (with first_item_* fields) to the shape
 * that resolveSingleRequestApprovalStage / canActorApproveSingleRequestStage
 * expects — i.e. approval_N_user_id, approval_N_status fields directly.
 *
 * All items in a mass batch share the same approval chain, so reading from
 * the first item's fields is correct.
 *
 * LEGACY (stage-based) — kept exported for cutover safety. The new step-based
 * flow does not use this.
 */
const mapMassRowToApprovalShape = (row = {}) => {
    const approval = { ...row };
    approval.approval_1_user_id = row.first_item_approval_1_user_id;
    approval.approval_1_status = row.first_item_approval_1_status;
    approval.approval_2_user_id = row.first_item_approval_2_user_id;
    approval.approval_2_status = row.first_item_approval_2_status;
    approval.approval_3_user_id = row.first_item_approval_3_user_id;
    approval.approval_3_status = row.first_item_approval_3_status;
    approval.status = row.first_item_status;

    // Mass requests always use "Create" ticket type
    approval.ticket_type = "Create";
    approval.ticketType = "Create";

    return approval;
};

/**
 * Resolve the active approval stage for a mass request batch.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} row - Mass request inbox row with first_item_* fields.
 * @returns {string|null} "Approval 1", "Approval 2", "Approval 3", or null.
 */
const resolveMassRequestApprovalStage = (row = {}) => {
    return resolveSingleRequestApprovalStage(mapMassRowToApprovalShape(row));
};

/**
 * Check whether a mass request is eligible to appear in the approval inbox.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} row - Mass request inbox row with first_item_* fields.
 * @returns {boolean}
 */
const isMassRequestApprovalInboxEligible = (row = {}) => {
    const approval = mapMassRowToApprovalShape(row);
    return (
        Boolean(resolveSingleRequestApprovalStage(approval)) ||
        isRequestStatusVisibleInApprovalList(approval.status)
    );
};

/**
 * Filter mass request inbox rows for a given actor.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object[]} rows - Mass request inbox rows.
 * @param {object} opts
 * @param {string|null} opts.actorUserId
 * @param {string|null} opts.actorUsername
 * @returns {object[]} Filtered rows.
 */
const filterMassRequestApprovalInboxRows = (
    rows = [],
    { actorUserId, actorUsername } = {}
) => {
    const isAdmin = isAdminMaterialApprover(actorUsername);

    return rows.filter(row => {
        if (!isMassRequestApprovalInboxEligible(row)) {
            return false;
        }

        if (isAdmin) {
            return true;
        }

        const approval = mapMassRowToApprovalShape(row);
        const stage = resolveSingleRequestApprovalStage(approval);

        if (stage === "Approval 1") {
            return matchesActorUserId(
                approval.approval_1_user_id,
                actorUserId
            );
        }

        if (stage === "Approval 2") {
            return matchesActorUserId(
                approval.approval_2_user_id,
                actorUserId
            );
        }

        if (stage === "Approval 3") {
            return matchesActorUserId(
                approval.approval_3_user_id,
                actorUserId
            );
        }

        // Show rejected rows where this actor was the rejecting approver
        if (
            [1, 2, 3].some(step => {
                const statusField = `first_item_approval_${step}_status`;
                const userIdField = `first_item_approval_${step}_user_id`;
                return (
                    String(row[statusField] || "").trim().toUpperCase() ===
                        "REJECTED" &&
                    matchesActorUserId(row[userIdField], actorUserId)
                );
            })
        ) {
            return true;
        }

        // Show terminal-status rows to all involved approval assignees
        const status = normalizeApprovalStatus(row.first_item_status);
        if (["REWORK", "DONE", "CANCEL", "REJECTED"].includes(status)) {
            return [1, 2, 3].some(step =>
                matchesActorUserId(
                    row[`first_item_approval_${step}_user_id`],
                    actorUserId
                )
            );
        }

        return false;
    });
};

/**
 * Check whether the actor can approve the current stage of a mass request.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} opts
 * @param {object} opts.row - Mass request inbox row with first_item_* fields.
 * @param {string|null} opts.actorUserId
 * @param {string|null} opts.actorUsername
 * @returns {boolean}
 */
const canActorApproveMassRequestStage = ({
    row = {},
    actorUserId,
    actorUsername,
} = {}) => {
    if (isAdminMaterialApprover(actorUsername)) {
        return true;
    }

    const approval = mapMassRowToApprovalShape(row);
    const stage = resolveSingleRequestApprovalStage(approval);

    if (stage === "Approval 1") {
        return matchesActorUserId(approval.approval_1_user_id, actorUserId);
    }

    if (stage === "Approval 2") {
        return matchesActorUserId(approval.approval_2_user_id, actorUserId);
    }

    if (stage === "Approval 3") {
        return matchesActorUserId(approval.approval_3_user_id, actorUserId);
    }

    return false;
};

/**
 * Build a patch object to apply to ALL items in a mass batch after approval.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} opts
 * @param {string} opts.activeStage - "Approval 1" or "Approval 2".
 * @param {string|null} opts.actorUserId
 * @param {string|null} opts.actorUsername
 * @param {string|null} opts.remark
 * @returns {object} Patch with fields to apply to each item row.
 */
const buildMassRequestApprovePatch = ({
    activeStage,
    actorUserId,
    actorUsername,
    remark,
} = {}) => {
    const safeRemark = assertRequiredActionReason(remark, "approve");
    const fieldPrefix = getApprovalStageFieldPrefix(activeStage);

    let nextStatus;
    let nextAssignment;

    if (activeStage === "Approval 1") {
        nextStatus = "Submit";
        nextAssignment = "Approval 2";
    } else if (activeStage === "Approval 2") {
        nextStatus = "Submit";
        nextAssignment = "Approval 3";
    } else if (activeStage === "Approval 3") {
        nextStatus = "DONE";
        nextAssignment = "Completed";
    } else {
        throw new Error(`Unsupported approval stage: ${activeStage}`);
    }

    const patch = {
        [`${fieldPrefix}_status`]: "APPROVED",
        [`${fieldPrefix}_at`]: SQL_NOW_EXPRESSION,
        [`${fieldPrefix}_remark`]: safeRemark,
        status: nextStatus,
        assigned_to: nextAssignment,
    };

    // When transitioning from Approval 2 → 3, set Approval 3 status to WAITING
    // so it appears in the Approval 3 inbox.
    if (activeStage === "Approval 2") {
        patch.approval_3_status = INITIAL_APPROVAL_STATUS;
    }

    return patch;
};

/**
 * Build a patch object to apply to ALL items in a mass batch for rework request.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} opts
 * @param {string} opts.activeStage - The stage requesting rework.
 * @param {string|null} opts.actorUserId
 * @param {string|null} opts.reason - Required for rework.
 * @returns {object}
 */
const buildMassRequestReworkPatch = ({
    activeStage,
    actorUserId,
    reason,
} = {}) => {
    const safeReason = assertRequiredActionReason(reason, "rework");
    const fieldPrefix = getApprovalStageFieldPrefix(activeStage);

    return {
        status: "Rework",
        assigned_to: "Requester",
        [`${fieldPrefix}_status`]: "REWORK",
        [`${fieldPrefix}_remark`]: safeReason,
        [`${fieldPrefix}_at`]: SQL_NOW_EXPRESSION,
    };
};

/**
 * Build a patch object to apply to ALL items in a mass batch for rejection.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
 *
 * @param {object} opts
 * @param {string} opts.activeStage - The stage rejecting the request.
 * @param {string|null} opts.reason - Required for reject.
 * @returns {object}
 */
const buildMassRequestRejectPatch = ({
    activeStage,
    reason,
} = {}) => {
    const safeReason = assertRequiredActionReason(reason, "reject");
    const fieldPrefix = getApprovalStageFieldPrefix(activeStage);

    return {
        status: "CANCEL",
        assigned_to: "Cancelled",
        [`${fieldPrefix}_status`]: "REJECTED",
        [`${fieldPrefix}_at`]: SQL_NOW_EXPRESSION,
        [`${fieldPrefix}_remark`]: safeReason,
    };
};

/**
 * Update approval_1_user_id, approval_2_user_id, and/or approval_3_user_id
 * on a single in-flight mass-request item when the administrator retargets the
 * approver master.  Unlike the single-request path this does NOT touch status
 * or assigned_to — the mass approve flow manages its own stage progression.
 *
 * LEGACY (stage-based) — kept exported for cutover safety.
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

/* =========================================================================
 * NEW STEP-BASED FLOW (mat_mass_request_item_approval_step)
 *
 * Mass requests are always CREATE. All items in a batch share the same step
 * plan, so routing reads the FIRST item's step rows (consistent with the
 * existing first_item_* pattern). Header status/assigned_to and the matching
 * step-status update are then applied to EVERY item in the batch by the
 * MaterialModel caller.
 *
 * These delegate to the shared step-engine in ./approvalSteps.js so single
 * and mass stay in lockstep.
 * ========================================================================= */

/**
 * Resolve the active step for a mass batch from the FIRST item's step rows.
 *
 * @param {object[]} firstItemSteps - Rows from mat_mass_request_item_approval_step
 *   for the first item, ordered by level. Each row: {level, kind,
 *   approver_user_id, status, ...}.
 * @returns {object|null} The active step row (lowest level whose normalized
 *   status !== 'APPROVED'), or null when all steps are APPROVED.
 */
const resolveMassActiveStepFromFirstItem = (firstItemSteps = []) =>
    resolveActiveStep(firstItemSteps);

/**
 * Eligibility / visibility for a single actor against ONE active mass step.
 *
 * Delegates to the shared canActorActOnStep:
 * - ADMIN (isAdminMaterialApprover) => true.
 * - MANUAL => approver_user_id === actorUserId.
 * - MDM    => actorIsMdmMaterial && (approver_user_id IS NULL OR === actorUserId).
 *
 * @param {object} step - The active step row.
 * @param {object} actor - { actorUserId, actorUsername, actorIsMdmMaterial }.
 * @returns {boolean}
 */
const canActorActOnMassStep = (step, actor) =>
    canActorActOnStep(step, actor);

/**
 * Build the approve patch for a mass batch step action.
 *
 * Same shape as the single-request buildStepApprovePatch: the `step` block is
 * applied to the matching step row of EVERY item; there is no header change on
 * approve here — the MaterialModel caller recomputes header status/assigned_to
 * from the advanced step plan (Submit + next-step label, or DONE + 'Completed').
 *
 * @param {object} opts
 * @param {string|null} opts.remark
 * @returns {{ step: { status, acted_at, remark } }}
 */
const buildMassStepApprovePatch = ({ remark } = {}) => ({
    step: {
        status: STEP_STATUS.APPROVED,
        acted_at: SQL_NOW_EXPRESSION,
        remark: remark ?? null,
    },
});

/**
 * Build the rework patch for a mass batch step action.
 *
 * The `step` block is applied to the matching step row of EVERY item; the
 * `header` block (status/assigned_to + rework_* metadata) is applied to EVERY
 * mat_mass_request_item row.
 *
 * @param {object} opts
 * @param {object} opts.activeStep - The active step row being reworked.
 * @param {string|null} opts.actorUserId
 * @param {string|null} opts.reason - Required.
 * @returns {{ step, header }}
 */
const buildMassStepReworkPatch = ({
    activeStep,
    actorUserId,
    reason,
} = {}) => {
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

/**
 * Build the reject patch for a mass batch step action.
 *
 * @param {object} opts
 * @param {object} opts.activeStep - The active step row being rejected.
 * @param {string|null} opts.reason - Required.
 * @returns {{ step, header }}
 */
const buildMassStepRejectPatch = ({
    activeStep,
    reason,
} = {}) => {
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

/**
 * On rework SAVE (requester re-submits a mass batch): reset the reworked step
 * back to WAITING. The reworked step is recovered by matching the stored
 * rework_stage label back to a step row (findStepByLabel).
 *
 * The `step` block is applied to the matching step row of EVERY item; the
 * `header` block is applied to EVERY mat_mass_request_item row.
 *
 * @param {object} opts
 * @param {object[]} opts.firstItemSteps - First item's step rows.
 * @param {string} opts.reworkStageLabel - Stored header rework_stage label.
 * @returns {{ step, header, reworkStep }}
 */
const buildMassStepRevisedPatch = ({
    firstItemSteps = [],
    reworkStageLabel,
} = {}) => {
    const reworkStep = findStepByLabel(firstItemSteps, reworkStageLabel);

    if (!reworkStep) {
        const error = new Error(
            `Unable to locate reworked step for label: ${reworkStageLabel}`
        );
        error.statusCode = 409;
        error.code = "MASS_REQUEST_REWORK_STEP_NOT_FOUND";
        throw error;
    }

    return {
        reworkStep,
        step: {
            status: STEP_STATUS.WAITING,
            acted_at: null,
            remark: null,
        },
        header: {
            status: "Submit",
            assigned_to: stepLabel(reworkStep),
        },
    };
};

/**
 * Build the public FE payload block for a mass batch from the FIRST item's
 * step rows. Delegates to the shared buildStepsPayload.
 *
 * @param {object[]} firstItemSteps - First item's step rows (ordered by level).
 * @returns {object} {
 *   approvalSteps, currentStageLevel, currentStageLabel, currentStageKind,
 *   isFinalStage, totalStages, assignedTo
 * }
 */
const mapMassStepRowsToPayload = (firstItemSteps = []) =>
    buildStepsPayload(firstItemSteps);

/**
 * True when the active step of a mass batch is the MDM (final) step.
 *
 * @param {object[]} firstItemSteps - First item's step rows.
 * @returns {boolean}
 */
const isMassFinalStepActive = (firstItemSteps = []) =>
    isFinalStepActive(firstItemSteps);

/**
 * Resolve the header assigned_to value for a mass batch from its first item's
 * step rows (active step label, 'Completed' when all APPROVED, else null).
 *
 * @param {object[]} firstItemSteps - First item's step rows.
 * @returns {string|null}
 */
const resolveMassAssignedToFromSteps = (firstItemSteps = []) =>
    resolveAssignedToFromSteps(firstItemSteps);

module.exports = {
    // legacy stage-based (kept for cutover safety)
    resolveMassRequestApprovalStage,
    isMassRequestApprovalInboxEligible,
    filterMassRequestApprovalInboxRows,
    canActorApproveMassRequestStage,
    buildMassRequestApprovePatch,
    buildMassRequestReworkPatch,
    buildMassRequestRejectPatch,
    mapMassRowToApprovalShape,
    syncMassRequestItemApprovalSnapshot,
    // new step-based flow
    resolveMassActiveStepFromFirstItem,
    canActorActOnMassStep,
    buildMassStepApprovePatch,
    buildMassStepReworkPatch,
    buildMassStepRejectPatch,
    buildMassStepRevisedPatch,
    mapMassStepRowsToPayload,
    isMassFinalStepActive,
    resolveMassAssignedToFromSteps,
};
