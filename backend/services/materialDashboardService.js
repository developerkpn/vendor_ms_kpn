const pool = require("../config/connection");
const materialService = require("./materialService");
const { MASS_ITEM_GROUP_CODE_LATERAL_SQL } = require("../constants/material");

const invalidFilter = message =>
    Object.assign(new Error(message), { statusCode: 400 });

function normalizeDashboardFilters(query = {}) {
    const readDate = (value, label) => {
        if (value === undefined || value === "") return null;
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw invalidFilter(`${label} must be a valid date (YYYY-MM-DD).`);
        }
        const parsed = new Date(`${value}T00:00:00Z`);
        if (
            !Number.isFinite(parsed.getTime()) ||
            parsed.toISOString().slice(0, 10) !== value ||
            value < "1900-01-01"
        ) {
            throw invalidFilter(`${label} must be a valid date (YYYY-MM-DD).`);
        }
        return value;
    };
    const dateFrom = readDate(query.dateFrom, "Period From");
    const dateTo = readDate(query.dateTo, "Period To");
    if (dateFrom && dateTo && dateFrom > dateTo) {
        throw invalidFilter("Period From must be on or before Period To.");
    }
    const requestKind = query.requestKind ?? "all";
    if (!["all", "single", "mass"].includes(requestKind)) {
        throw invalidFilter("Request kind must be all, single, or mass.");
    }
    return { dateFrom, dateTo, requestKind };
}

// One row per material item throughout. Only the submission totals collapse
// mass items to distinct batches; a partial batch retains each item's outcome.
// Visibility matches My Request + the default My Approval step rules. In
// particular, MDM membership alone never reveals another user's claimed work.
// For MDM viewers, awaitingApproval is their unclaimed active MDM queue. Own
// items still at a manual step remain visible under waitingOtherApproval.
// Manual approvers count only their current actionable step in awaitingApproval;
// history and future assignments retain their actual stage in the status chart.
const DASHBOARD_QUERY = `WITH visible_items AS (
    SELECT 'single' AS request_kind, r.id AS item_id, NULL::bigint AS batch_id,
           r.created_at, r.ticket_type, r.status, r.sap_push_status, r.assigned_to,
           active.kind AS active_kind, active.approver_user_id AS active_approver_user_id,
           active.step_status AS active_step_status,
           COALESCE((TO_JSONB(r)->>'rework_at') IS NOT NULL AND active.level < (
               SELECT MAX(s.level) FROM mat_single_request_approval_step s
               WHERE s.request_id = r.id AND s.kind = 'MDM'
           ), FALSE) AS is_rewound,
           COALESCE(g.code || ' - ' || g.name, 'Unspecified') AS material_group
    FROM mat_single_request r
    LEFT JOIN mat_item_group g ON g.id = r.material_group_id
    LEFT JOIN LATERAL (
        SELECT s.kind, s.approver_user_id, s.level,
               UPPER(BTRIM(COALESCE(s.status, 'WAITING'))) AS step_status
        FROM mat_single_request_approval_step s
        WHERE s.request_id = r.id
          AND UPPER(COALESCE(s.status, 'WAITING')) <> 'APPROVED'
        ORDER BY s.level LIMIT 1
    ) active ON TRUE
    WHERE ($6 = 'all' OR $6 = 'single')
      AND ($4::date IS NULL OR r.created_at >= ($4::date::timestamp AT TIME ZONE 'Asia/Jakarta'))
      AND ($5::date IS NULL OR r.created_at < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
      AND ($2::boolean OR r.created_by = $1
           OR EXISTS (SELECT 1 FROM mat_single_request_approval_step s
                      WHERE s.request_id = r.id AND s.approver_user_id = $1)
           OR ($3::boolean AND active.kind = 'MDM' AND active.approver_user_id IS NULL))

    UNION ALL

    SELECT 'mass', i.id, i.mass_request_id,
           m.created_at, i.ticket_type, i.status, i.sap_push_status, i.assigned_to,
           active.kind, active.approver_user_id,
           active.step_status,
           COALESCE((TO_JSONB(i)->>'rework_at') IS NOT NULL AND active.level < (
               SELECT MAX(s.level) FROM mat_mass_request_item_approval_step s
               WHERE s.item_id = i.id AND s.kind = 'MDM'
           ), FALSE),
           COALESCE(g.code || ' - ' || g.name, NULLIF(BTRIM(i.material_group), ''), 'Unspecified')
    FROM mat_mass_request_item i
    JOIN mat_mass_request m ON m.id = i.mass_request_id
    ${MASS_ITEM_GROUP_CODE_LATERAL_SQL}
    LEFT JOIN mat_item_group g ON g.id = mig.id
    LEFT JOIN LATERAL (
        SELECT s.kind, s.approver_user_id, s.level,
               UPPER(BTRIM(COALESCE(s.status, 'WAITING'))) AS step_status
        FROM mat_mass_request_item_approval_step s
        WHERE s.item_id = i.id
          AND UPPER(COALESCE(s.status, 'WAITING')) <> 'APPROVED'
        ORDER BY s.level LIMIT 1
    ) active ON TRUE
    WHERE ($6 = 'all' OR $6 = 'mass')
      AND ($4::date IS NULL OR m.created_at >= ($4::date::timestamp AT TIME ZONE 'Asia/Jakarta'))
      AND ($5::date IS NULL OR m.created_at < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
      AND ($2::boolean OR m.created_by = $1
           OR EXISTS (SELECT 1 FROM mat_mass_request_item_approval_step s
                      WHERE s.item_id = i.id AND s.approver_user_id = $1)
           OR ($3::boolean AND active.kind = 'MDM' AND active.approver_user_id IS NULL))
), classified AS (
    SELECT *,
        CASE
            WHEN UPPER(BTRIM(status)) IN ('CANCEL', 'CANCELLED') THEN 'cancelled'
            WHEN UPPER(BTRIM(status)) IN ('REJECT', 'REJECTED') THEN 'rejected'
            WHEN UPPER(BTRIM(status)) = 'REWORK' THEN 'rework'
            WHEN UPPER(BTRIM(sap_push_status)) = 'ERROR' THEN 'sapError'
            WHEN UPPER(BTRIM(sap_push_status)) IN ('PENDING', 'PUSHED') THEN 'waitingSap'
            WHEN UPPER(BTRIM(sap_push_status)) = 'SYNCED' OR UPPER(BTRIM(status)) = 'DONE' THEN 'done'
            WHEN is_rewound THEN 'rework'
            WHEN $7::boolean AND active_kind = 'MANUAL' AND active_approver_user_id = $1
                AND active_step_status = 'WAITING' AND UPPER(BTRIM(status)) = 'SUBMIT'
                THEN 'awaitingApproval'
            WHEN active_kind = 'MDM' AND active_approver_user_id IS NULL
                THEN CASE WHEN $7::boolean THEN 'waitingPickup' ELSE 'awaitingApproval' END
            WHEN active_kind = 'MDM' OR UPPER(BTRIM(assigned_to)) = 'MASTER DATA' THEN 'masterData'
            WHEN active_kind = 'MANUAL' OR UPPER(BTRIM(status)) IN ('SUBMIT', 'WAITING')
                THEN CASE WHEN $3::boolean OR $7::boolean THEN 'waitingOtherApproval' ELSE 'awaitingApproval' END
            WHEN UPPER(BTRIM(status)) IN ('APPROVE', 'APPROVED') THEN 'approved'
            ELSE 'other'
        END AS workflow_status,
        CASE UPPER(BTRIM(ticket_type))
            WHEN 'CHANGE' THEN 'Change'
            WHEN 'EXTEND' THEN 'Extend'
            WHEN 'CREATE' THEN 'Create'
            ELSE 'Other'
        END AS request_type
    FROM visible_items
), monthly_counts AS (
    SELECT DATE_TRUNC('month', created_at AT TIME ZONE 'Asia/Jakarta')::date AS month,
           COUNT(*) FILTER (WHERE request_kind = 'single') AS single_items,
           COUNT(*) FILTER (WHERE request_kind = 'mass') AS mass_items,
           COUNT(DISTINCT batch_id) AS mass_batches
    FROM classified
    GROUP BY 1
), month_window AS (
    SELECT DATE_TRUNC('month', COALESCE($5::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date))::date AS last_month
), months AS (
    SELECT GENERATE_SERIES(
        GREATEST(last_month - INTERVAL '11 months', COALESCE(DATE_TRUNC('month', $4::date::timestamp), last_month - INTERVAL '11 months')),
        last_month, INTERVAL '1 month'
    )::date AS month FROM month_window
)
SELECT JSONB_BUILD_OBJECT(
    'totals', (SELECT JSONB_BUILD_OBJECT(
        'submissions', COUNT(*) FILTER (WHERE request_kind = 'single') + COUNT(DISTINCT batch_id),
        'singleRequests', COUNT(*) FILTER (WHERE request_kind = 'single'),
        'massBatches', COUNT(DISTINCT batch_id),
        'materialItems', COUNT(*),
        'massItems', COUNT(*) FILTER (WHERE request_kind = 'mass')
    ) FROM classified),
    'statuses', COALESCE((SELECT JSONB_OBJECT_AGG(workflow_status, count) FROM (
        SELECT workflow_status, COUNT(*) AS count FROM classified GROUP BY workflow_status
    ) counts), '{}'::jsonb),
    'materialGroups', COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('label', material_group, 'count', count) ORDER BY count DESC, material_group) FROM (
        SELECT material_group, COUNT(*) AS count FROM classified GROUP BY material_group
    ) counts), '[]'::jsonb),
    'requestTypes', COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('label', request_type, 'count', count) ORDER BY request_type) FROM (
        SELECT request_type, COUNT(*) AS count FROM classified GROUP BY request_type
    ) counts), '[]'::jsonb),
    'monthlySubmissions', (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'month', TO_CHAR(months.month, 'YYYY-MM'),
        'singleItems', COALESCE(c.single_items, 0),
        'massItems', COALESCE(c.mass_items, 0),
        'massBatches', COALESCE(c.mass_batches, 0)
    ) ORDER BY months.month) FROM months LEFT JOIN monthly_counts c USING (month))
) AS dashboard`;

async function getMaterialDashboard({
    actorUserId,
    actorUsername,
    query,
} = {}) {
    if (!actorUserId) {
        throw Object.assign(
            new Error("A signed-in material user is required."),
            { statusCode: 401 }
        );
    }
    const filters = normalizeDashboardFilters(query);
    await materialService.refreshMaterialAdminUsernames({ minAgeMs: 10000 });
    const isAdmin = materialService.isAdminMaterialApprover(actorUsername);
    const isMdm =
        !isAdmin &&
        (await materialService.isActorMdmMaterialUser(pool, actorUserId));
    const isApprover =
        !isAdmin &&
        !isMdm &&
        (
            await materialService.resolveMaterialMenuAccess({
                userId: actorUserId,
                username: actorUsername,
            })
        ).canApprove === true;
    const { rows } = await pool.query(DASHBOARD_QUERY, [
        String(actorUserId),
        isAdmin,
        isMdm,
        filters.dateFrom,
        filters.dateTo,
        filters.requestKind,
        isApprover,
    ]);
    return {
        ...rows[0].dashboard,
        filters,
        scope: isAdmin ? "all" : "own-and-approvals",
        approvalRole: isAdmin
            ? "administrator"
            : isMdm
            ? "masterData"
            : isApprover
            ? "approver"
            : "requester",
    };
}

module.exports = {
    getMaterialDashboard,
    normalizeDashboardFilters,
    DASHBOARD_QUERY,
};
