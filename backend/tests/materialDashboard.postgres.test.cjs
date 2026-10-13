const assert = require("node:assert/strict");
const test = require("node:test");
const pool = require("../config/connection");
const { DASHBOARD_QUERY } = require("../services/materialDashboardService");

// Opt in with MATERIAL_DASHBOARD_DB_TEST=1 and a configured development DB.
// Every fixture lives in this connection's temporary schema. No application
// tables are read or written, and the transaction is rolled back at the end.
test(
    "dashboard SQL includes own requests, approval history, and the Master Data pickup queue",
    {
        skip: process.env.MATERIAL_DASHBOARD_DB_TEST !== "1",
    },
    async t => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SET LOCAL search_path = pg_temp, pg_catalog");
            await client.query("SET LOCAL statement_timeout = 10000");
            await client.query(`
            CREATE TEMP TABLE mat_item_group (
                id integer, code text, name text, deleted_at timestamptz
            );
            CREATE TEMP TABLE mat_single_request (
                id bigint, created_by text, created_at timestamptz,
                ticket_type text, status text, sap_push_status text,
                assigned_to text, material_group_id integer
            );
            CREATE TEMP TABLE mat_single_request_approval_step (
                request_id bigint, level integer, kind text,
                approver_user_id text, status text
            );
            CREATE TEMP TABLE mat_mass_request (
                id bigint, created_by text, created_at timestamptz
            );
            CREATE TEMP TABLE mat_mass_request_item (
                id bigint, mass_request_id bigint, ticket_type text,
                status text, sap_push_status text, assigned_to text,
                material_group text
            );
            CREATE TEMP TABLE mat_mass_request_item_approval_step (
                item_id bigint, level integer, kind text,
                approver_user_id text, status text
            );

            INSERT INTO mat_item_group VALUES (1, '901', 'BEARING', NULL);
            INSERT INTO mat_single_request VALUES
                (101, 'ACTOR', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Approval 1', 1),
                (102, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Approval 1', 1),
                (103, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Master Data', 1),
                (104, 'OTHER', '2026-10-09 10:00+07', 'Extend', 'Submit', NULL, 'Master Data', 1),
                (105, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Master Data', 1),
                (106, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Master Data', 1),
                (107, 'ACTOR', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Master Data', 1),
                (108, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Rework', NULL, 'Master Data', 1),
                (109, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Cancel', NULL, 'Master Data', 1),
                (110, 'OTHER', '2026-10-09 10:00+07', 'Create', 'DONE', 'PENDING', 'Completed', 1),
                (111, 'OTHER', '2026-10-09 10:00+07', 'Create', 'DONE', 'SYNCED', 'Completed', 1),
                (113, 'MDM_ACTOR', '2026-10-09 10:00+07', 'Change', 'Submit', NULL, 'Approval 1', 1),
                (114, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Approval 1', 1),
                (115, 'OTHER', '2026-10-09 10:00+07', 'Create', 'Submit', NULL, 'Approval 1', 1);

            INSERT INTO mat_single_request_approval_step VALUES
                (101, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (101, 2, 'MDM', NULL, 'WAITING'),
                (102, 1, 'MANUAL', 'ACTOR', 'WAITING'),
                (102, 2, 'MANUAL', 'ACTOR', 'WAITING'),
                (102, 3, 'MDM', NULL, 'WAITING'),
                (103, 1, 'MANUAL', 'ACTOR', 'APPROVED'),
                (103, 2, 'MDM', NULL, 'WAITING'),
                (104, 1, 'MDM', NULL, 'WAITING'),
                (105, 1, 'MDM', 'MDM_ACTOR', 'WAITING'),
                (106, 1, 'MDM', 'OTHER_MDM', 'WAITING'),
                (107, 1, 'MANUAL', 'ACTOR', 'APPROVED'),
                (107, 2, 'MDM', 'OTHER_MDM', 'WAITING'),
                (108, 1, 'MDM', NULL, 'REWORK'),
                (109, 1, 'MDM', NULL, 'WAITING'),
                (110, 1, 'MDM', 'MDM_ACTOR', 'APPROVED'),
                (111, 1, 'MDM', 'OTHER_MDM', 'APPROVED'),
                (113, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (113, 2, 'MDM', NULL, 'WAITING'),
                (114, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (114, 2, 'MANUAL', 'ACTOR', 'WAITING'),
                (114, 3, 'MDM', NULL, 'WAITING'),
                (115, 1, 'MANUAL', 'ACTOR', 'WAITING'),
                (115, 2, 'MDM', 'MDM_ACTOR', 'REWORK');

            INSERT INTO mat_mass_request VALUES
                (201, 'OTHER', '2026-10-09 10:00+07'),
                (202, 'ACTOR', '2026-10-09 10:00+07'),
                (203, 'OTHER', '2026-10-09 10:00+07'),
                (204, 'ACTOR', '2026-10-09 10:00+07'),
                (205, 'MDM_ACTOR', '2026-10-09 10:00+07');
            INSERT INTO mat_mass_request_item VALUES
                (301, 201, 'Create', 'Submit', NULL, 'Approval 1', '901'),
                (302, 201, 'Create', 'Submit', NULL, 'Approval 1', 'BEARING'),
                (303, 202, 'Create', 'Submit', NULL, 'Approval 1', '901 - BEARING'),
                (304, 202, 'Create', 'Submit', NULL, 'Master Data', '901'),
                (305, 203, 'Create', 'Submit', NULL, 'Master Data', '901'),
                (306, 203, 'Create', 'Submit', NULL, 'Master Data', '901'),
                (307, 204, 'Create', 'Submit', NULL, 'Approval 1', '901'),
                (308, 205, 'Create', 'Submit', NULL, 'Approval 1', '901'),
                (309, 201, 'Create', 'Submit', NULL, 'Approval 1', '901'),
                (310, 203, 'Create', 'Submit', NULL, 'Approval 1', '901');
            INSERT INTO mat_mass_request_item_approval_step VALUES
                (301, 1, 'MANUAL', 'ACTOR', 'WAITING'),
                (301, 2, 'MDM', NULL, 'WAITING'),
                (302, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (302, 2, 'MDM', NULL, 'WAITING'),
                (303, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (303, 2, 'MDM', NULL, 'WAITING'),
                (304, 1, 'MDM', NULL, 'WAITING'),
                (305, 1, 'MANUAL', 'ACTOR', 'APPROVED'),
                (305, 2, 'MDM', NULL, 'WAITING'),
                (306, 1, 'MDM', 'MDM_ACTOR', 'WAITING'),
                (307, 1, 'MANUAL', 'ACTOR', 'WAITING'),
                (307, 2, 'MDM', NULL, 'WAITING'),
                (308, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (308, 2, 'MDM', NULL, 'WAITING'),
                (309, 1, 'MANUAL', 'OTHER', 'WAITING'),
                (309, 2, 'MANUAL', 'ACTOR', 'WAITING'),
                (309, 3, 'MDM', NULL, 'WAITING'),
                (310, 1, 'MANUAL', 'ACTOR', 'WAITING'),
                (310, 2, 'MDM', 'MDM_ACTOR', 'REWORK');

            ALTER TABLE mat_single_request ADD COLUMN rework_at timestamptz;
            ALTER TABLE mat_mass_request_item ADD COLUMN rework_at timestamptz;
            UPDATE mat_single_request SET rework_at = '2026-10-09 11:00+07' WHERE id = 115;
            UPDATE mat_mass_request_item SET rework_at = '2026-10-09 11:00+07' WHERE id = 310;
        `);

            const dashboard = async (
                actor,
                isMdm = false,
                kind = "all",
                dateFrom = null,
                dateTo = null,
                isAdmin = false,
                isApprover = false
            ) => {
                const { rows } = await client.query(DASHBOARD_QUERY, [
                    actor,
                    isAdmin,
                    isMdm,
                    dateFrom,
                    dateTo,
                    kind,
                    isApprover,
                ]);
                return rows[0].dashboard;
            };

            await t.test(
                "approvers count only their current waiting steps, retaining own requests, future assignments, and history separately",
                async () => {
                    const data = await dashboard(
                        "ACTOR",
                        false,
                        "all",
                        null,
                        null,
                        false,
                        true
                    );
                    assert.deepEqual(data.totals, {
                        submissions: 10,
                        singleRequests: 6,
                        massBatches: 4,
                        materialItems: 13,
                        massItems: 7,
                    });
                    assert.deepEqual(data.statuses, {
                        awaitingApproval: 3,
                        waitingOtherApproval: 4,
                        waitingPickup: 3,
                        rework: 2,
                        masterData: 1,
                    });
                    assert.deepEqual(data.materialGroups, [
                        { label: "901 - BEARING", count: 13 },
                    ]);
                    assert.deepEqual(data.requestTypes, [
                        { label: "Create", count: 13 },
                    ]);
                }
            );

            await t.test(
                "Master Data includes the pickup queue and own requests, while excluding other users' claimed requests",
                async () => {
                    const data = await dashboard("MDM_ACTOR", true);
                    assert.deepEqual(data.totals, {
                        submissions: 11,
                        singleRequests: 8,
                        massBatches: 3,
                        materialItems: 13,
                        massItems: 5,
                    });
                    assert.deepEqual(data.statuses, {
                        awaitingApproval: 4,
                        waitingOtherApproval: 2,
                        masterData: 2,
                        rework: 3,
                        cancelled: 1,
                        waitingSap: 1,
                    });
                }
            );

            await t.test(
                "Master Data pickup counts exclude own items still with manual approvers in both request modes",
                async () => {
                    const single = await dashboard("MDM_ACTOR", true, "single");
                    const mass = await dashboard("MDM_ACTOR", true, "mass");
                    assert.equal(single.statuses.awaitingApproval, 2);
                    assert.equal(single.statuses.waitingOtherApproval, 1);
                    assert.equal(single.statuses.masterData, 1);
                    assert.equal(mass.statuses.awaitingApproval, 2);
                    assert.equal(mass.statuses.waitingOtherApproval, 1);
                    assert.equal(mass.statuses.masterData, 1);
                    assert.equal(mass.totals.massBatches, 3);
                    assert.equal(mass.totals.materialItems, 5);
                    assert.equal(
                        Object.values(single.statuses).reduce(
                            (sum, count) => sum + count,
                            0
                        ),
                        single.totals.materialItems
                    );
                    assert.equal(
                        Object.values(mass.statuses).reduce(
                            (sum, count) => sum + count,
                            0
                        ),
                        mass.totals.materialItems
                    );
                }
            );

            await t.test(
                "ordinary users never inherit the Master Data pickup queue",
                async () => {
                    const data = await dashboard("NO_REQUESTS_OR_APPROVALS");
                    assert.equal(data.totals.materialItems, 0);
                    assert.deepEqual(data.statuses, {});
                }
            );

            await t.test(
                "date filters apply to both submitted requests and accessible approvals",
                async () => {
                    const included = await dashboard(
                        "ACTOR",
                        false,
                        "all",
                        "2026-10-09",
                        "2026-10-09"
                    );
                    const excluded = await dashboard(
                        "ACTOR",
                        false,
                        "all",
                        "2026-10-10",
                        "2026-10-10"
                    );
                    assert.equal(included.totals.materialItems, 13);
                    assert.equal(excluded.totals.materialItems, 0);
                }
            );

            await t.test(
                "administrators see every item and status counts sum to the item total",
                async () => {
                    const data = await dashboard(
                        "ADMIN",
                        false,
                        "all",
                        null,
                        null,
                        true
                    );
                    assert.equal(data.totals.materialItems, 24);
                    assert.equal(data.totals.singleRequests, 14);
                    assert.equal(data.totals.massBatches, 5);
                    assert.equal(
                        Object.values(data.statuses).reduce(
                            (sum, count) => sum + count,
                            0
                        ),
                        24
                    );
                    assert.equal(data.statuses.waitingOtherApproval, undefined);
                    assert.equal(data.statuses.waitingPickup, undefined);
                    assert.equal(data.statuses.rework, 3);
                    assert.equal(data.statuses.done, 1);
                    assert.equal(data.statuses.waitingSap, 1);
                }
            );
        } finally {
            try {
                await client.query("ROLLBACK");
            } finally {
                client.release();
                await pool.end();
            }
        }
    }
);
