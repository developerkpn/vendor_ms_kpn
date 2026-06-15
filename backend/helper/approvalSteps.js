// Shared step-engine for dynamic approvers (single + mass).
// Per-request approval state is one row per stage in mat_*_approval_step:
//   kind = 'MANUAL' (assigned approver) or 'MDM' (Master Data, the final stage,
//   a claimable queue). "Current stage = lowest-level step not yet APPROVED."

const STEP_KINDS = Object.freeze({ MANUAL: "MANUAL", MDM: "MDM" });
const STEP_STATUS = Object.freeze({
    WAITING: "WAITING",
    APPROVED: "APPROVED",
    REWORK: "REWORK",
    REJECTED: "REJECTED",
});
const MDM_MATERIAL_GROUP_NAME = "MDM_MATERIAL";
const STEP_INITIAL_STATUS = STEP_STATUS.WAITING;

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
// chain = [{ approverUserId }] (or snake-case), already ordered.
// CREATE = all N manual + MDM; CHANGE = first manual + MDM; EXTEND = MDM only.
function buildApprovalStepPlan({ ticketType, chain = [] } = {}) {
    const tt = normalizeTicketType(ticketType);
    const manual = (Array.isArray(chain) ? chain : [])
        .map(entry => ({
            approverUserId:
                entry?.approverUserId ?? entry?.approver_user_id ?? null,
        }))
        .filter(entry => entry.approverUserId);

    const requireManual = () => {
        if (manual.length < 1) {
            const error = new Error(
                "Requester has no approver chain configured."
            );
            error.statusCode = 409;
            error.code = "NO_APPROVER_CHAIN";
            throw error;
        }
    };

    if (tt === "EXTEND") {
        return [
            { level: 1, kind: STEP_KINDS.MDM, approverUserId: null, status: STEP_INITIAL_STATUS },
        ];
    }

    if (tt === "CHANGE") {
        requireManual();
        return [
            { level: 1, kind: STEP_KINDS.MANUAL, approverUserId: manual[0].approverUserId, status: STEP_INITIAL_STATUS },
            { level: 2, kind: STEP_KINDS.MDM, approverUserId: null, status: STEP_INITIAL_STATUS },
        ];
    }

    // CREATE (default): full manual chain + MDM.
    requireManual();
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
//   actor = { actorUserId, actorUsername, actorIsMdmMaterial }
//   ADMIN  => always; MANUAL => assigned approver; MDM => an MDM_MATERIAL user
//   while unclaimed (approver NULL) or the claimer.
function canActorActOnStep(step, actor = {}) {
    if (!step) return false;
    const { actorUserId, actorUsername, actorIsMdmMaterial } = actor;
    try {
        // Lazy require avoids a circular dependency with singleRequestApproval.js.
        const { isAdminMaterialApprover } = require("./singleRequestApproval");
        if (typeof isAdminMaterialApprover === "function" && isAdminMaterialApprover(actorUsername)) {
            return true;
        }
    } catch (error) {
        /* isAdminMaterialApprover unavailable — fall through to per-kind checks */
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

module.exports = {
    STEP_KINDS,
    STEP_STATUS,
    MDM_MATERIAL_GROUP_NAME,
    STEP_INITIAL_STATUS,
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
};
