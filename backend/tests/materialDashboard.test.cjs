const assert = require("node:assert/strict");
const test = require("node:test");
const pool = require("../config/connection");
const materialService = require("../services/materialService");
const dashboardService = require("../services/materialDashboardService");
const controller = require("../controllers/MaterialDashboardController");

const { normalizeDashboardFilters, getMaterialDashboard, DASHBOARD_QUERY } =
    dashboardService;

test("dashboard accepts all-time filters and inclusive calendar dates", () => {
    assert.deepEqual(normalizeDashboardFilters(), {
        dateFrom: null,
        dateTo: null,
        requestKind: "all",
    });
    assert.deepEqual(
        normalizeDashboardFilters({
            dateFrom: "2024-02-29",
            dateTo: "2026-10-09",
            requestKind: "mass",
        }),
        {
            dateFrom: "2024-02-29",
            dateTo: "2026-10-09",
            requestKind: "mass",
        }
    );
});

test("dashboard rejects impossible dates, reversed ranges, and structured query values", () => {
    for (const query of [
        { dateFrom: "2026-02-29" },
        { dateTo: "2026-04-31" },
        { dateFrom: "2026-13-01" },
        { dateTo: "09/10/2026" },
        { dateFrom: "2026-10-10", dateTo: "2026-10-09" },
        { dateFrom: ["2026-10-09"] },
        { dateTo: {} },
        { requestKind: ["mass"] },
        { requestKind: "unsupported" },
    ]) {
        assert.throws(
            () => normalizeDashboardFilters(query),
            error => error.statusCode === 400
        );
    }
});

async function withAccessStubs(
    { isAdmin = false, isMdm = false, isApprover = false } = {},
    run
) {
    const originals = {
        query: pool.query,
        refresh: materialService.refreshMaterialAdminUsernames,
        admin: materialService.isAdminMaterialApprover,
        mdm: materialService.isActorMdmMaterialUser,
        menuAccess: materialService.resolveMaterialMenuAccess,
    };
    const calls = [];
    let mdmChecks = 0;
    materialService.refreshMaterialAdminUsernames = async () => {};
    materialService.isAdminMaterialApprover = username =>
        isAdmin && username === "test-admin";
    materialService.isActorMdmMaterialUser = async (client, userId) => {
        assert.equal(client, pool);
        assert.equal(userId, "user-1");
        mdmChecks++;
        return isMdm;
    };
    materialService.resolveMaterialMenuAccess = async ({ userId }) => {
        assert.equal(userId, "user-1");
        return { isAdmin, canApprove: isApprover };
    };
    pool.query = async (sql, params) => {
        calls.push({ sql, params });
        return {
            rows: [
                {
                    dashboard: {
                        totals: {
                            submissions: 2,
                            singleRequests: 1,
                            massBatches: 1,
                            materialItems: 21,
                            massItems: 20,
                        },
                    },
                },
            ],
        };
    };
    try {
        await run(calls, () => mdmChecks);
    } finally {
        pool.query = originals.query;
        materialService.refreshMaterialAdminUsernames = originals.refresh;
        materialService.isAdminMaterialApprover = originals.admin;
        materialService.isActorMdmMaterialUser = originals.mdm;
        materialService.resolveMaterialMenuAccess = originals.menuAccess;
    }
}

test("ordinary users cannot broaden dashboard access through query parameters", async () => {
    await withAccessStubs({}, async calls => {
        const result = await getMaterialDashboard({
            actorUserId: "user-1",
            actorUsername: "staff",
            query: {
                actorUserId: "other-user",
                isAdmin: true,
                isMdm: true,
                isApprover: true,
                approvalRole: "approver",
                scope: "all",
                requestKind: "mass",
            },
        });
        assert.equal(result.scope, "own-and-approvals");
        assert.equal(result.approvalRole, "requester");
        assert.equal(calls[0].sql, DASHBOARD_QUERY);
        assert.deepEqual(calls[0].params, [
            "user-1",
            false,
            false,
            null,
            null,
            "mass",
            false,
        ]);
        assert.equal(result.totals.massBatches, 1);
        assert.equal(result.totals.materialItems, 21);
    });
});

test("manual approver KPI scope comes from the signed-in user's material access", async () => {
    await withAccessStubs({ isApprover: true }, async calls => {
        const result = await getMaterialDashboard({
            actorUserId: "user-1",
            actorUsername: "approver",
            query: { approvalRole: "administrator" },
        });
        assert.equal(result.approvalRole, "approver");
        assert.equal(calls[0].params[6], true);
    });
});

test("MDM visibility is enabled only after checking the signed-in user's membership", async () => {
    await withAccessStubs({ isMdm: true }, async (calls, mdmChecks) => {
        const result = await getMaterialDashboard({
            actorUserId: "user-1",
            actorUsername: "mdm",
        });
        assert.equal(result.scope, "own-and-approvals");
        assert.equal(result.approvalRole, "masterData");
        assert.equal(mdmChecks(), 1);
        assert.deepEqual(calls[0].params.slice(0, 3), ["user-1", false, true]);
    });
});

test("material administrators receive all-request aggregates", async () => {
    await withAccessStubs({ isAdmin: true }, async (calls, mdmChecks) => {
        const result = await getMaterialDashboard({
            actorUserId: "user-1",
            actorUsername: "test-admin",
        });
        assert.equal(result.scope, "all");
        assert.equal(result.approvalRole, "administrator");
        assert.equal(mdmChecks(), 0);
        assert.deepEqual(calls[0].params.slice(0, 3), ["user-1", true, false]);
    });
});

test("missing identity and invalid filters never run the dashboard query", async () => {
    await withAccessStubs({}, async calls => {
        await assert.rejects(
            getMaterialDashboard({ actorUsername: "test-admin" }),
            error => error.statusCode === 401
        );
        await assert.rejects(
            getMaterialDashboard({
                actorUserId: "user-1",
                query: { dateTo: "invalid" },
            }),
            error => error.statusCode === 400
        );
        assert.equal(calls.length, 0);
    });
});

test("dashboard endpoint authenticates before loading aggregates", () => {
    const router = require("../routes/MaterialRoute");
    const AuthToken = require("../middleware/tokenmanager");
    const route = router.stack.find(
        layer => layer.route?.path === "/dashboard"
    ).route;
    assert.equal(route.methods.get, true);
    assert.equal(route.stack[0].handle, AuthToken.authSession);
    assert.equal(route.stack[1].handle, controller.getDashboard);
});
