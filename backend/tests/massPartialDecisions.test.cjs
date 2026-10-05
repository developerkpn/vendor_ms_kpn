// Mass requests decided per item at Master Data: each item of a batch gets its
// own decision (approve / rework / reject) and follows that decision's flow on
// its own, while the rest of the batch stays where it is.
//
// The flows run against a small stateful fake of the two batch tables
// (mat_mass_request_item + its step rows), so each test asserts the state the
// batch ends up in rather than the SQL that was sent.

const assert = require("node:assert/strict");
const test = require("node:test");
const db = require("../config/connection");
const materialService = require("../services/materialService");
const materialSapStagingService = require("../services/materialSapStagingService");
const reworkEmailSender = require("../helper/reworkEmailSender");
const MaterialController = require("../controllers/MaterialController");
const { buildMassReworkEmailTemplate } = require("../helper/reworkEmailTemplate");

const MASS_REQUEST_ID = 5;

const GROUP_CODES = {
    11: { material_group_code: "901", material_sub_group_code: "031" },
    12: { material_group_code: "901", material_sub_group_code: "031" },
    13: { material_group_code: "902", material_sub_group_code: "007" },
};

const item = (id, itemNo, overrides = {}) => ({
    id,
    item_no: itemNo,
    request_no: String(3000000000 + id),
    created_by: "REQ-01",
    status: "Submit",
    assigned_to: "Master Data",
    sap_push_status: null,
    sap_error_msg: null,
    final_code: null,
    material_description: `Item ${itemNo}`,
    ...overrides,
});

const step = (id, itemId, level, kind, approverUserId, status, overrides = {}) => ({
    id,
    item_id: itemId,
    level,
    kind,
    approver_user_id: approverUserId,
    status,
    claimed_at: kind === "MDM" && approverUserId ? new Date("2026-10-01T02:00:00Z") : null,
    acted_at: status === "APPROVED" ? new Date("2026-09-30T02:00:00Z") : null,
    remark: null,
    ...overrides,
});

// Three items past Approval 1 (APP-01), all waiting at Master Data, grabbed by
// MDM-01.
const batchAtMasterData = () => ({
    items: [item(11, 1), item(12, 2), item(13, 3)],
    steps: [11, 12, 13].flatMap((itemId, index) => [
        step(100 + index * 10, itemId, 1, "MANUAL", "APP-01", "APPROVED"),
        step(101 + index * 10, itemId, 2, "MDM", "MDM-01", "WAITING"),
    ]),
});

const createMassBatchFake = ({ items, steps, mdmUsers = ["MDM-01"] }) => {
    const state = {
        items: items.map(row => ({ ...row })),
        steps: steps.map(row => ({ ...row })),
        comments: [],
        log: [],
        nextStepId: 9000,
    };
    const sortedItems = () =>
        [...state.items].sort((a, b) => a.item_no - b.item_no);
    const itemById = id => state.items.find(row => String(row.id) === String(id));
    const inIds = (ids, id) => (ids || []).map(String).includes(String(id));
    const done = (rowCount, rows = []) => ({ rows, rowCount });

    // "a = $2, b = NOW(), c = $3" -> { a: params[1], b: Date, c: params[2] }
    const parseAssignments = (setClause, params) =>
        Object.fromEntries(
            setClause.split(/,\s*/).map(assignment => {
                const [field, value] = assignment.split(/\s*=\s*/);
                const param = value.match(/^\$(\d+)$/);
                return [
                    field.trim(),
                    param ? params[Number(param[1]) - 1] : new Date(),
                ];
            })
        );

    const query = async (text, params = []) => {
        const sql = text.trim();
        state.log.push(sql);

        if (
            ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
            /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)
        ) {
            return done(null);
        }

        if (/FOR UPDATE OF i/.test(sql)) {
            const first = sortedItems()[0];
            return first
                ? done(1, [{ id: first.id, request_no: first.request_no, created_by: first.created_by }])
                : done(0);
        }

        if (/^SELECT i\.id, i\.item_no, i\.request_no, i\.status, i\.assigned_to, i\.sap_push_status/.test(sql)) {
            const rows = sortedItems().map(row => ({ ...row }));
            return done(rows.length, rows);
        }

        if (/FROM mat_mass_request_item_approval_step s\s+JOIN mat_mass_request_item i ON i\.id = s\.item_id/.test(sql)) {
            const rows = state.steps
                .map(row => ({ ...row, approver_name: row.approver_user_id }))
                .sort(
                    (a, b) =>
                        itemById(a.item_id).item_no - itemById(b.item_id).item_no ||
                        a.level - b.level
                );
            return done(rows.length, rows);
        }

        if (/JOIN mst_page_access mpa/.test(sql)) {
            return mdmUsers.includes(params[0]) ? done(1, [{}]) : done(0);
        }

        if (/^SELECT mu\.user_id, mu\.email/.test(sql)) {
            const rows = params[0].map(id => ({
                user_id: id,
                email: `${String(id).toLowerCase()}@kpn-corp.com`,
            }));
            return done(rows.length, rows);
        }

        if (/mig\.code AS material_group_code/.test(sql)) {
            const rows = sortedItems()
                .filter(row => inIds(params[1], row.id))
                .map(row => ({
                    item_id: row.id,
                    item_no: row.item_no,
                    request_no: row.request_no,
                    ...GROUP_CODES[row.id],
                }));
            return done(rows.length, rows);
        }

        if (/FROM mat_sap_data WHERE code = ANY/.test(sql) || /FROM mat_single_request\s+WHERE final_code = ANY/.test(sql)) {
            return done(0);
        }

        if (/FROM mat_mass_request_item\s+WHERE final_code = ANY/.test(sql)) {
            const rows = state.items.filter(
                row =>
                    params[0].includes(row.final_code) &&
                    !inIds(params[1], row.id) &&
                    String(row.status).toUpperCase() !== "CANCEL"
            );
            return done(rows.length, rows);
        }

        if (/SET approver_user_id = COALESCE\(s\.approver_user_id, \$2\)/.test(sql)) {
            const rows = state.steps.filter(row => inIds(params[0], row.id));
            rows.forEach(row => {
                row.approver_user_id = row.approver_user_id ?? params[1];
            });
            return done(rows.length);
        }

        let match = sql.match(
            /^UPDATE mat_mass_request_item_approval_step s\s+SET ([\s\S]*?),\s*updated_at = NOW\(\)\s+WHERE s\.id = ANY\(\$1::bigint\[\]\)$/
        );
        if (match) {
            const patch = parseAssignments(match[1], params);
            const rows = state.steps.filter(row => inIds(params[0], row.id));
            rows.forEach(row => Object.assign(row, patch));
            return done(rows.length);
        }

        if (/SET approver_user_id = \$2,\s+claimed_at = NOW\(\)/.test(sql)) {
            const rows = state.steps.filter(
                row => row.kind === "MDM" && row.approver_user_id == null
            );
            rows.forEach(row => {
                row.approver_user_id = params[1];
                row.claimed_at = new Date();
            });
            return done(rows.length);
        }

        match = sql.match(
            /^UPDATE mat_mass_request_item\s+SET status = \$2,\s+assigned_to = \$3,(\s+sap_push_status = 'PENDING',)?\s+updated_at = NOW\(\)\s+WHERE mass_request_id = \$1\s+AND id = ANY\(\$4::bigint\[\]\)/
        );
        if (match) {
            const rows = state.items.filter(row => inIds(params[3], row.id));
            rows.forEach(row => {
                row.status = params[1];
                row.assigned_to = params[2];
                if (match[1]) row.sap_push_status = "PENDING";
            });
            return done(rows.length, rows.map(row => ({ id: row.id })));
        }

        if (/^UPDATE mat_mass_request_item\s+SET status = 'Submit',\s+assigned_to = \$2,\s+sap_push_status = NULL/.test(sql)) {
            const rows = state.items.filter(row => inIds(params[2], row.id));
            rows.forEach(row => {
                row.status = "Submit";
                row.assigned_to = params[1];
                row.sap_push_status = null;
                row.sap_error_msg = null;
            });
            return done(rows.length, rows.map(row => ({ id: row.id })));
        }

        match = sql.match(
            /^UPDATE mat_mass_request_item\s+SET ([\s\S]*?),\s*updated_at = NOW\(\)\s+WHERE id = \$1 AND mass_request_id = \$2$/
        );
        if (match) {
            const row = itemById(params[0]);
            if (row) Object.assign(row, parseAssignments(match[1], params));
            return done(row ? 1 : 0);
        }

        if (/^DELETE FROM mat_mass_request_item_approval_step s\s+WHERE s\.item_id = ANY\(\$1::bigint\[\]\)\s+AND s\.kind = \$2$/.test(sql)) {
            const before = state.steps.length;
            state.steps = state.steps.filter(
                row => !(inIds(params[0], row.item_id) && row.kind === params[1])
            );
            return done(before - state.steps.length);
        }

        if (/^INSERT INTO mat_mass_request_item_approval_step/.test(sql)) {
            const [itemId, level, kind, approverUserId, status] = params;
            state.nextStepId += 1;
            state.steps.push(
                step(state.nextStepId, itemId, level, kind, approverUserId, status)
            );
            return done(1);
        }

        if (/^INSERT INTO mat_request_comment/.test(sql)) {
            const [requestKind, requestId, eventType, stage, actorUserId, comment] = params;
            state.comments.push({ requestKind, requestId, eventType, stage, actorUserId, comment });
            return done(1);
        }

        if (/COUNT\(\*\) AS error_count/.test(sql)) {
            const count = state.items.filter(
                row => String(row.sap_push_status || "").toUpperCase() === "ERROR"
            ).length;
            return done(1, [{ error_count: String(count) }]);
        }

        throw new Error(`Unexpected query: ${sql}`);
    };

    return {
        state,
        itemById,
        stepsOf: itemId =>
            state.steps
                .filter(row => String(row.item_id) === String(itemId))
                .sort((a, b) => a.level - b.level),
        connect: async () => ({ query, release: () => {} }),
    };
};

// Swap the DB, the SAP push and the mail sender for the duration of `run`.
const withMassBatch = async (batch, run) => {
    const fake = createMassBatchFake(batch);
    const originalConnect = db.connect;
    const originalPush = materialSapStagingService.pushPendingMaterialsToSapStaging;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const pushCalls = [];
    const sendCalls = [];

    db.connect = fake.connect;
    materialSapStagingService.pushPendingMaterialsToSapStaging = async args => {
        pushCalls.push(args);
        return { pushed: [], errors: [] };
    };
    reworkEmailSender.sendReworkApproverEmail = async (client, ctx) => {
        sendCalls.push({ ctx, committed: fake.state.log.includes("COMMIT") });
        return { via: "EMAIL", sent: true };
    };

    try {
        return await run({ ...fake, pushCalls, sendCalls });
    } finally {
        db.connect = originalConnect;
        materialSapStagingService.pushPendingMaterialsToSapStaging = originalPush;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
};

const decide = (overrides = {}) =>
    materialService.decideMassRequest({
        massRequestId: MASS_REQUEST_ID,
        actorUserId: "MDM-01",
        actorUsername: "master.data.one",
        ...overrides,
    });

const captureReject = async fn => {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    throw new Error("expected the call to reject");
};

// ---------------------------------------------------------------------------
// decideMassRequest
// ---------------------------------------------------------------------------

test("decideMassRequest gives each item its own outcome in one transaction", async () => {
    await withMassBatch(batchAtMasterData(), async ({ state, itemById, stepsOf, pushCalls }) => {
        const result = await decide({
            decisions: [
                { itemId: 11, action: "APPROVE" },
                { itemId: 12, action: "REWORK" },
                { itemId: 13, action: "REJECT" },
            ],
            remark: "Sesuai",
            finalCodeSuffixes: { 11: "005" },
            reworkReason: "Lengkapi spesifikasi",
            rejectReason: "Duplikat material",
        });

        // Approved: final code composed, done, flagged for the SAP push.
        assert.equal(itemById(11).final_code, "901.031.005");
        assert.equal(itemById(11).status, "DONE");
        assert.equal(itemById(11).assigned_to, "Completed");
        assert.equal(itemById(11).sap_push_status, "PENDING");
        assert.equal(stepsOf(11)[1].status, "APPROVED");

        // Reworked: back with the requester, no code.
        assert.equal(itemById(12).status, "Rework");
        assert.equal(itemById(12).assigned_to, "Requester");
        assert.equal(itemById(12).final_code, null);
        assert.equal(itemById(12).sap_push_status, null);
        assert.equal(stepsOf(12)[1].status, "REWORK");
        assert.equal(stepsOf(12)[1].remark, "Lengkapi spesifikasi");

        // Rejected: cancelled.
        assert.equal(itemById(13).status, "CANCEL");
        assert.equal(itemById(13).assigned_to, "Cancelled");
        assert.equal(stepsOf(13)[1].status, "REJECTED");
        assert.equal(stepsOf(13)[1].remark, "Duplikat material");

        // Only the approved item is pushed.
        assert.equal(pushCalls.length, 1);
        assert.equal(pushCalls[0].massRequestId, MASS_REQUEST_ID);
        assert.equal(pushCalls[0].limit, 1);

        assert.deepEqual(result.final_codes, [
            { item_no: 1, request_no: "3000000011", final_code: "901.031.005" },
        ]);
        assert.deepEqual(result.approved.item_ids, [11]);
        assert.deepEqual(result.reworked.item_ids, [12]);
        assert.deepEqual(result.rejected.item_ids, [13]);

        // Each decision lands in the batch history, naming its item.
        assert.deepEqual(
            state.comments.map(row => [row.eventType, row.comment]),
            [
                ["REJECT", "Item 3: Duplikat material"],
                ["REWORK", "Item 2: Lengkapi spesifikasi"],
                ["APPROVE", "Item 1: Sesuai"],
            ]
        );
        assert.equal(state.log.filter(sql => sql === "COMMIT").length, 1);
    });
});

test("decideMassRequest with one action for every item reads like the whole-batch action", async () => {
    await withMassBatch(batchAtMasterData(), async ({ state, itemById, pushCalls }) => {
        await decide({
            decisions: [11, 12, 13].map(itemId => ({ itemId, action: "APPROVE" })),
            remark: "Semua sesuai",
            finalCodeSuffixes: { 11: "005", 12: "006", 13: "007" },
        });

        assert.deepEqual(
            [11, 12, 13].map(id => itemById(id).final_code),
            ["901.031.005", "901.031.006", "902.007.007"]
        );
        assert.ok([11, 12, 13].every(id => itemById(id).status === "DONE"));
        assert.equal(pushCalls[0].limit, 3);
        // No "Item ..." scope when the action covered the whole batch.
        assert.deepEqual(state.comments.map(row => row.comment), ["Semua sesuai"]);
    });
});

test("decideMassRequest refuses to leave an item waiting at Master Data undecided", async () => {
    await withMassBatch(batchAtMasterData(), async ({ state, itemById }) => {
        const error = await captureReject(() =>
            decide({
                decisions: [
                    { itemId: 11, action: "APPROVE" },
                    { itemId: 12, action: "REJECT" },
                ],
                finalCodeSuffixes: { 11: "005" },
                rejectReason: "Duplikat",
            })
        );

        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "MASS_REQUEST_DECISIONS_INCOMPLETE");
        assert.match(error.message, /item 3/);
        assert.ok(state.log.includes("ROLLBACK"));
        assert.equal(itemById(11).status, "Submit");
        assert.equal(itemById(12).status, "Submit");
    });
});

test("decideMassRequest validates the body before opening a transaction", async () => {
    await withMassBatch(batchAtMasterData(), async ({ state }) => {
        const duplicate = await captureReject(() =>
            decide({
                decisions: [
                    { itemId: 11, action: "APPROVE" },
                    { itemId: 11, action: "REJECT" },
                ],
            })
        );
        assert.equal(duplicate.code, "MASS_REQUEST_DECISION_DUPLICATE");

        const unknownAction = await captureReject(() =>
            decide({ decisions: [{ itemId: 11, action: "HOLD" }] })
        );
        assert.equal(unknownAction.code, "MASS_REQUEST_DECISION_INVALID");

        const noRejectReason = await captureReject(() =>
            decide({ decisions: [{ itemId: 11, action: "REJECT" }] })
        );
        assert.equal(noRejectReason.code, "REJECT_REASON_REQUIRED");

        assert.equal(state.log.length, 0);
    });
});

test("decideMassRequest only takes items still waiting at Master Data", async () => {
    const batch = batchAtMasterData();
    batch.items[0] = item(11, 1, { status: "DONE", assigned_to: "Completed" });
    batch.steps[1] = { ...batch.steps[1], status: "APPROVED" };

    await withMassBatch(batch, async () => {
        const error = await captureReject(() =>
            decide({
                decisions: [11, 12, 13].map(itemId => ({ itemId, action: "APPROVE" })),
                finalCodeSuffixes: { 11: "005", 12: "006", 13: "007" },
            })
        );

        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MASS_REQUEST_ITEM_NOT_PENDING");
        assert.match(error.message, /Item 1/);
    });
});

test("decideMassRequest is the Master Data stage's action only", async () => {
    const batch = batchAtMasterData();
    batch.items = batch.items.map(row => ({ ...row, assigned_to: "Approval 1" }));
    batch.steps = batch.steps.map(row =>
        row.kind === "MANUAL"
            ? { ...row, status: "WAITING", acted_at: null }
            : { ...row, approver_user_id: null, claimed_at: null }
    );

    await withMassBatch(batch, async () => {
        const error = await captureReject(() =>
            decide({
                actorUserId: "APP-01",
                actorUsername: "approver.one",
                decisions: [11, 12, 13].map(itemId => ({ itemId, action: "APPROVE" })),
            })
        );

        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MASS_REQUEST_DECIDE_NOT_MASTER_DATA");
    });
});

test("decideMassRequest rework via email mails only the reworked items and moves nothing for them", async () => {
    await withMassBatch(batchAtMasterData(), async ({ itemById, stepsOf, sendCalls }) => {
        const result = await decide({
            decisions: [
                { itemId: 11, action: "APPROVE" },
                { itemId: 12, action: "REWORK" },
                { itemId: 13, action: "APPROVE" },
            ],
            finalCodeSuffixes: { 11: "005", 13: "007" },
            // The dialog derives it from the mail subject on this channel.
            reworkReason: "Review Request Material Massal 3000000011",
            newApprovers: ["APP-07"],
            notifyVia: "EMAIL",
            emailSubject: "Review Request Material Massal 3000000011",
            emailBody: "Mohon cek item 2.",
        });

        assert.equal(itemById(11).status, "DONE");
        assert.equal(itemById(13).status, "DONE");
        // Correspondence only: item 2 stays claimed at Master Data.
        assert.equal(itemById(12).status, "Submit");
        assert.equal(itemById(12).assigned_to, "Master Data");
        assert.equal(stepsOf(12)[1].status, "WAITING");

        assert.equal(result.emailOnly, true);
        assert.deepEqual(result.notify, { via: "EMAIL", sent: true });
        assert.equal(sendCalls.length, 1);
        assert.equal(sendCalls[0].committed, true);
        assert.equal(sendCalls[0].ctx.requestNo, "3000000011");
        assert.equal(sendCalls[0].ctx.toUserId, "APP-07");
        assert.equal(sendCalls[0].ctx.toEmail, "app-07@kpn-corp.com");
    });
});

test("a per-item chain rework sends only those items through the new approver, then back to Master Data", async () => {
    await withMassBatch(batchAtMasterData(), async ({ itemById, stepsOf }) => {
        await decide({
            decisions: [
                { itemId: 11, action: "APPROVE" },
                { itemId: 12, action: "REWORK" },
                { itemId: 13, action: "REWORK" },
            ],
            finalCodeSuffixes: { 11: "005" },
            reworkReason: "Perlu review Approver lain",
            newApprovers: ["APP-07"],
            notifyVia: "APP",
        });

        assert.equal(itemById(11).status, "DONE");
        for (const id of [12, 13]) {
            assert.equal(itemById(id).status, "Submit");
            assert.equal(itemById(id).assigned_to, "Approval 1");
            assert.deepEqual(
                stepsOf(id).map(row => [row.level, row.kind, row.approver_user_id, row.status]),
                [
                    [1, "MANUAL", "APP-07", "WAITING"],
                    // The Master Data grab survives the rewrite.
                    [2, "MDM", "MDM-01", "WAITING"],
                ]
            );
        }

        // The new approver acts on the batch: only the two items are theirs.
        const approval = await materialService.approveMassRequest({
            massRequestId: MASS_REQUEST_ID,
            actorUserId: "APP-07",
            actorUsername: "approver.seven",
            remark: "OK dari saya",
        });

        assert.deepEqual(approval.item_ids, [12, 13]);
        assert.equal(approval.status, "Submit");
        assert.equal(approval.assigned_to, "Master Data");
        assert.equal(itemById(12).assigned_to, "Master Data");
        assert.equal(itemById(13).assigned_to, "Master Data");
        assert.equal(itemById(11).status, "DONE");

        // Back at Master Data, the same grabber decides the two remaining items.
        await decide({
            decisions: [
                { itemId: 12, action: "APPROVE" },
                { itemId: 13, action: "REJECT" },
            ],
            finalCodeSuffixes: { 12: "006" },
            rejectReason: "Tidak diperlukan",
        });

        assert.equal(itemById(12).status, "DONE");
        assert.equal(itemById(12).final_code, "901.031.006");
        assert.equal(itemById(13).status, "CANCEL");
    });
});

test("a code taken by a sibling approved earlier in the same batch is refused", async () => {
    const batch = batchAtMasterData();
    batch.items[0] = item(11, 1, {
        status: "DONE",
        assigned_to: "Completed",
        final_code: "901.031.005",
        sap_push_status: "SYNCED",
    });
    batch.steps[1] = { ...batch.steps[1], status: "APPROVED" };

    await withMassBatch(batch, async ({ itemById }) => {
        const error = await captureReject(() =>
            decide({
                decisions: [
                    { itemId: 12, action: "APPROVE" },
                    { itemId: 13, action: "APPROVE" },
                ],
                finalCodeSuffixes: { 12: "005", 13: "007" },
            })
        );

        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS");
        assert.match(error.message, /3000000011/);
        assert.equal(itemById(12).status, "Submit");
    });
});

test("decideMassRequest refuses an edit on an item it is not approving", async () => {
    await withMassBatch(batchAtMasterData(), async ({ itemById }) => {
        const error = await captureReject(() =>
            decide({
                decisions: [
                    { itemId: 11, action: "APPROVE" },
                    { itemId: 12, action: "REWORK" },
                    { itemId: 13, action: "REWORK" },
                ],
                finalCodeSuffixes: { 11: "005" },
                reworkReason: "Lengkapi spesifikasi",
                items: [{ id: 12, material_description: "Diubah MDM" }],
            })
        );

        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MASS_REQUEST_ITEM_NOT_EDITABLE");
        assert.equal(itemById(12).material_description, "Item 2");
    });
});

// ---------------------------------------------------------------------------
// Requester resubmit and SAP-error resubmit, per item
// ---------------------------------------------------------------------------

const batchAfterDecisions = () => {
    const batch = batchAtMasterData();
    batch.items = [
        item(11, 1, { status: "DONE", assigned_to: "Completed", final_code: "901.031.005", sap_push_status: "SYNCED" }),
        item(12, 2, { status: "Rework", assigned_to: "Requester" }),
        item(13, 3, { status: "CANCEL", assigned_to: "Cancelled" }),
    ];
    batch.steps[1] = { ...batch.steps[1], status: "APPROVED" };
    batch.steps[3] = { ...batch.steps[3], status: "REWORK", remark: "Lengkapi spesifikasi" };
    batch.steps[5] = { ...batch.steps[5], status: "REJECTED", remark: "Duplikat" };
    return batch;
};

test("saveMassRequestRework resubmits only the items in Rework", async () => {
    await withMassBatch(batchAfterDecisions(), async ({ state, itemById, stepsOf }) => {
        const result = await materialService.saveMassRequestRework({
            massRequestId: MASS_REQUEST_ID,
            actorUserId: "REQ-01",
            items: [{ id: 12, material_description: "Item 2 lengkap" }],
            comment: "Spesifikasi sudah dilengkapi",
        });

        assert.deepEqual(result.item_ids, [12]);
        assert.equal(result.assigned_to, "Master Data");
        assert.equal(itemById(12).status, "Submit");
        assert.equal(itemById(12).assigned_to, "Master Data");
        assert.equal(itemById(12).material_description, "Item 2 lengkap");
        assert.equal(stepsOf(12)[1].status, "WAITING");
        assert.equal(stepsOf(12)[1].approver_user_id, "MDM-01");

        assert.equal(itemById(11).status, "DONE");
        assert.equal(itemById(13).status, "CANCEL");
        assert.deepEqual(state.comments.map(row => row.comment), [
            "Item 2: Spesifikasi sudah dilengkapi",
        ]);
    });
});

test("saveMassRequestRework refuses an edit on an item that is not in Rework", async () => {
    await withMassBatch(batchAfterDecisions(), async ({ itemById }) => {
        const error = await captureReject(() =>
            materialService.saveMassRequestRework({
                massRequestId: MASS_REQUEST_ID,
                actorUserId: "REQ-01",
                items: [{ id: 11, material_description: "Ubah item selesai" }],
                comment: "Ubah",
            })
        );

        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MASS_REQUEST_ITEM_NOT_EDITABLE");
        assert.equal(itemById(11).material_description, "Item 1");
    });
});

test("requestMassSapErrorRework reopens only the items SAP rejected", async () => {
    const batch = batchAtMasterData();
    batch.items = [
        item(11, 1, { status: "DONE", assigned_to: "Completed", final_code: "901.031.005", sap_push_status: "SYNCED" }),
        item(12, 2, { status: "DONE", assigned_to: "Completed", final_code: "901.031.006", sap_push_status: "ERROR", sap_error_msg: "Material exists" }),
        item(13, 3, { status: "DONE", assigned_to: "Completed", final_code: "902.007.007", sap_push_status: "SYNCED" }),
    ];
    batch.steps = batch.steps.map(row => ({ ...row, status: "APPROVED" }));

    await withMassBatch(batch, async ({ itemById, stepsOf }) => {
        const result = await materialService.requestMassSapErrorRework({
            massRequestId: MASS_REQUEST_ID,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
        });

        assert.deepEqual(result.item_ids, [12]);
        assert.equal(itemById(12).status, "Submit");
        assert.equal(itemById(12).assigned_to, "Master Data");
        assert.equal(itemById(12).sap_push_status, null);
        assert.equal(stepsOf(12)[1].status, "WAITING");

        for (const id of [11, 13]) {
            assert.equal(itemById(id).status, "DONE");
            assert.equal(itemById(id).sap_push_status, "SYNCED");
            assert.equal(stepsOf(id)[1].status, "APPROVED");
        }
    });
});

test("claimMassRequestMdmStepByUser grabs the Master Data step of every item at once", async () => {
    const batch = batchAtMasterData();
    batch.steps = batch.steps.map(row =>
        row.kind === "MDM" ? { ...row, approver_user_id: null, claimed_at: null } : row
    );

    await withMassBatch(batch, async ({ stepsOf }) => {
        const result = await materialService.claimMassRequestMdmStepByUser({
            massRequestId: MASS_REQUEST_ID,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
        });

        assert.equal(result.currentStageKind, "MDM");
        for (const id of [11, 12, 13]) {
            assert.equal(stepsOf(id)[1].approver_user_id, "MDM-01");
        }

        const again = await captureReject(() =>
            materialService.claimMassRequestMdmStepByUser({
                massRequestId: MASS_REQUEST_ID,
                actorUserId: "MDM-02",
                actorUsername: "master.data.two",
            })
        );
        assert.equal(again.code, "MASS_REQUEST_MDM_CLAIM_FORBIDDEN");
    });
});

// ---------------------------------------------------------------------------
// Inbox / list rows of a diverged batch
// ---------------------------------------------------------------------------

const itemState = (itemId, itemNo, status, assignedTo, steps) => ({
    item_id: itemId,
    item_no: itemNo,
    status,
    assigned_to: assignedTo,
    approval_steps: steps,
});

// Item 1 done; item 2 re-climbing a chain Master Data replaced (APP-07).
const divergedBatchRow = () => ({
    id: MASS_REQUEST_ID,
    mass_request_no: "M-0005",
    first_item_status: "DONE",
    first_item_assigned_to: "Completed",
    approval_steps: [],
    active_step: null,
    items_state: [
        itemState(11, 1, "DONE", "Completed", [
            { level: 1, kind: "MANUAL", approver_user_id: "APP-01", status: "APPROVED" },
            { level: 2, kind: "MDM", approver_user_id: "MDM-01", status: "APPROVED" },
        ]),
        itemState(12, 2, "Submit", "Approval 1", [
            { level: 1, kind: "MANUAL", approver_user_id: "APP-07", status: "WAITING" },
            { level: 2, kind: "MDM", approver_user_id: "MDM-01", status: "WAITING" },
        ]),
    ],
});

test("the approval inbox shows a diverged batch as Partial, through the item that is the actor's turn", () => {
    const [row] = materialService.applyMassStepInboxVisibility([divergedBatchRow()], {
        actorUserId: "APP-07",
        actorUsername: "approver.seven",
        actorIsMdmMaterial: false,
    });

    assert.ok(row, "APP-07 must see the batch: one of its items is their turn");
    assert.equal(row.batch_status, "Partial");
    assert.deepEqual(row.item_status_counts, { DONE: 1, SUBMIT: 1 });
    assert.equal(row.first_item_status, "Submit");
    assert.equal(row.currentStageLabel, "Approval 1");
    assert.equal(row.active_step.approver_user_id, "APP-07");
    assert.equal(row.items_state, undefined);

    // Someone with no step on any item does not see it.
    assert.deepEqual(
        materialService.applyMassStepInboxVisibility([divergedBatchRow()], {
            actorUserId: "APP-99",
            actorUsername: "someone.else",
            actorIsMdmMaterial: false,
        }),
        []
    );
});

test("a batch whose items share one status keeps that status", () => {
    const row = divergedBatchRow();
    row.items_state[1] = itemState(12, 2, "DONE", "Completed", row.items_state[0].approval_steps);

    const [result] = materialService.applyMassStepInboxVisibility([row], {
        actorUserId: "MDM-01",
        actorUsername: "master.data.one",
        actorIsMdmMaterial: true,
    });

    assert.equal(result.batch_status, "DONE");
    assert.deepEqual(result.item_status_counts, { DONE: 2 });
});

test("My Request reads a diverged batch through the item back with the requester", () => {
    const row = divergedBatchRow();
    row.items_state[1] = itemState(12, 2, "Rework", "Requester", [
        { level: 1, kind: "MANUAL", approver_user_id: "APP-01", status: "APPROVED" },
        { level: 2, kind: "MDM", approver_user_id: "MDM-01", status: "REWORK", remark: "Lengkapi" },
    ]);

    const result = materialService.applyMassRequesterView(row);

    assert.equal(result.batch_status, "Partial");
    assert.equal(result.first_item_status, "Rework");
    assert.equal(result.first_item_assigned_to, "Requester");
    assert.deepEqual(result.item_status_counts, { DONE: 1, REWORK: 1 });
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test("resolveMassActionCohort keeps an action on one stage", () => {
    const { resolveMassActionCohort, buildMassBatchState } = materialService;
    const items = buildMassBatchState(
        [
            { id: 11, item_no: 1, status: "Submit" },
            { id: 12, item_no: 2, status: "Submit" },
            { id: 13, item_no: 3, status: "Rework" },
        ],
        [
            { id: 1, item_id: 11, level: 1, kind: "MDM", approver_user_id: "MDM-01", status: "WAITING" },
            { id: 2, item_id: 12, level: 1, kind: "MANUAL", approver_user_id: "APP-07", status: "WAITING" },
            { id: 3, item_id: 12, level: 2, kind: "MDM", approver_user_id: "MDM-01", status: "WAITING" },
            { id: 4, item_id: 13, level: 1, kind: "MDM", approver_user_id: "MDM-01", status: "REWORK" },
        ]
    );
    const admin = { actorUserId: "ADM", actorUsername: "ADMIN" };

    // ADMIN may act anywhere, but one action still moves one stage: the
    // first actionable item's.
    assert.deepEqual(
        resolveMassActionCohort({ items, actor: admin }).map(row => row.id),
        [11]
    );

    const mismatch = (() => {
        try {
            resolveMassActionCohort({ items, itemIds: [11, 12], actor: admin });
        } catch (error) {
            return error;
        }
        return null;
    })();
    assert.equal(mismatch?.code, "MASS_REQUEST_ITEM_STAGE_MISMATCH");

    const notInBatch = (() => {
        try {
            resolveMassActionCohort({ items, itemIds: [99], actor: admin });
        } catch (error) {
            return error;
        }
        return null;
    })();
    assert.equal(notInBatch?.code, "MASS_REQUEST_ITEM_NOT_IN_BATCH");

    // APP-07 only ever reaches item 2.
    assert.deepEqual(
        resolveMassActionCohort({
            items,
            actor: { actorUserId: "APP-07", actorUsername: "approver.seven" },
        }).map(row => row.id),
        [12]
    );
});

test("the rework mail lists only the reworked items but threads on the batch", () => {
    const rows = [11, 12, 13].map((id, index) => ({
        id,
        item_no: index + 1,
        request_no: String(3000000000 + id),
        ticket_type: "Create",
        material_description: `Bahan ${index + 1}`,
        uom: "PC",
        plant_code: "P001",
        sloc_code: "S001",
    }));

    const { subject, body, requestNo } = buildMassReworkEmailTemplate([rows[1]], {
        anchorItem: rows[0],
    });

    assert.equal(requestNo, "3000000011");
    assert.match(subject, /3000000011/);
    assert.match(body, /Bahan 2/);
    assert.doesNotMatch(body, /Bahan 1/);
    assert.doesNotMatch(body, /Bahan 3/);
});

test("the decide endpoint is routed and forwards the decisions", () => {
    const source = MaterialController.decideMassRequest.toString();
    assert.match(source, /decideMassRequest\(\{/);
    assert.match(source, /req\.params\.id/);
    assert.match(source, /decisions: req\.body\?\.decisions \?\? null/);

    const routeSource = require("fs").readFileSync(
        require("path").join(__dirname, "../routes/MaterialRoute.js"),
        "utf8"
    );
    assert.match(
        routeSource,
        /"\/requests\/mass\/:id\/decide",\s*AuthToken\.authSession,\s*MaterialController\.decideMassRequest/
    );
});
