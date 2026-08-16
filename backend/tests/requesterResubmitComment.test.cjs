const assert = require("node:assert/strict");
const test = require("node:test");
const materialService = require("../services/materialService");
const db = require("../config/connection");

// Requester comments on submit and resubmit (IBE-032).
//
// On a new submission the comment is optional. On a resubmission after a
// rework it is required — the same assertRequiredActionReason gate every
// rework/reject path already uses, applied to the three resubmit surfaces:
// single Create (a full page), Change/Extend (a dialog), and mass (a dialog).
// Whitespace-only input is rejected the same way, so a client-side check
// alone can't be defeated by a space.

// ---------------------------------------------------------------------------
// Single request resubmit — saveSingleRequestRework. Same backend function
// serves both the single-Create full page and the Change/Extend dialog; the
// ticket type only changes which fields are editable.
// ---------------------------------------------------------------------------

const singleReworkSteps = () => [
    {
        id: 9101,
        request_id: 810,
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-01",
        status: "WAITING",
        acted_at: null,
        remark: null,
    },
    {
        id: 9102,
        request_id: 810,
        level: 2,
        kind: "MDM",
        approver_user_id: null,
        status: "WAITING",
        acted_at: null,
        remark: null,
    },
];

const connectSingleReworkStub = ({
    snapshot,
    steps = singleReworkSteps(),
    commentInserts = [],
} = {}) =>
    async () => ({
        query: async (queryText, params = []) => {
            if (
                ["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText) ||
                /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(
                    queryText
                )
            ) {
                return { rows: [], rowCount: null };
            }

            if (/FOR UPDATE OF r/.test(queryText)) {
                return { rows: [snapshot] };
            }

            if (/FOR UPDATE OF s/.test(queryText)) {
                return { rows: steps };
            }

            if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            if (/UPDATE mat_single_request\b/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            if (/INSERT INTO mat_request_comment/.test(queryText)) {
                commentInserts.push({ queryText, params });
                return { rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
        release: () => {},
    });

const baseSingleSnapshot = (overrides = {}) => ({
    request_id: 810,
    request_no: "1000000810",
    created_by: "REQ-01",
    requester_user_id: "REQ-01",
    created_at: new Date("2026-08-01T00:00:00.000Z"),
    status: "Rework",
    rework_stage: "Approval 1",
    ticket_type: "CREATE",
    material_group_code: "CHEM",
    material_group_id: 12,
    material_sub_group_id: 110,
    plant_code: "P1",
    sloc_code: "S1",
    material_description: "Existing desc",
    base_uom: "EA",
    template_payload: { requestFields: {}, templateValues: {} },
    ...overrides,
});

test("saveSingleRequestRework (single Create) rejects a resubmit with no comment", async () => {
    const originalConnect = db.connect;
    db.connect = connectSingleReworkStub({ snapshot: baseSingleSnapshot() });

    try {
        await assert.rejects(
            () =>
                materialService.saveSingleRequestRework({
                    requestId: 810,
                    actorUserId: "REQ-01",
                    actorUsername: "requester.user",
                    editedRequest: {},
                }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "RESUBMIT_REASON_REQUIRED");
                // The key has to name an input that exists on the resubmit
                // surfaces, or the client has nothing to attach the message to.
                assert.deepEqual(
                    error.errors.map(e => e.fieldKey),
                    ["comment"]
                );
                return true;
            }
        );
    } finally {
        db.connect = originalConnect;
    }
});

test("saveSingleRequestRework (single Create) rejects whitespace-only comment", async () => {
    const originalConnect = db.connect;
    db.connect = connectSingleReworkStub({ snapshot: baseSingleSnapshot() });

    try {
        await assert.rejects(
            () =>
                materialService.saveSingleRequestRework({
                    requestId: 810,
                    actorUserId: "REQ-01",
                    actorUsername: "requester.user",
                    editedRequest: {},
                    comment: "   \n  ",
                }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "RESUBMIT_REASON_REQUIRED");
                // The key has to name an input that exists on the resubmit
                // surfaces, or the client has nothing to attach the message to.
                assert.deepEqual(
                    error.errors.map(e => e.fieldKey),
                    ["comment"]
                );
                return true;
            }
        );
    } finally {
        db.connect = originalConnect;
    }
});

test("saveSingleRequestRework (single Create) accepts a comment and writes one resubmit event carrying it", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    db.connect = connectSingleReworkStub({
        snapshot: baseSingleSnapshot(),
        commentInserts,
    });

    try {
        const result = await materialService.saveSingleRequestRework({
            requestId: 810,
            actorUserId: "REQ-01",
            actorUsername: "requester.user",
            editedRequest: {},
            comment: "Sudah saya tambahkan spesifikasi yang diminta",
        });

        assert.equal(result.status, "Submit");
        assert.equal(commentInserts.length, 1);
        assert.deepEqual(commentInserts[0].params, [
            "SINGLE",
            810,
            "RESUBMIT",
            null,
            "REQ-01",
            "Sudah saya tambahkan spesifikasi yang diminta",
        ]);
    } finally {
        db.connect = originalConnect;
    }
});

test("saveSingleRequestRework (Change/Extend dialog) requires its own comment, independent of the reason field", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    // The reason field is untouched (matches the snapshot exactly), which
    // under the existing rule keeps it out of editablePatch entirely — the
    // new required comment must still be gated and recorded regardless.
    db.connect = connectSingleReworkStub({
        snapshot: baseSingleSnapshot({
            ticket_type: "Extend",
            change_extend_reason: "Need a new storage location",
        }),
        commentInserts,
    });

    try {
        await assert.rejects(
            () =>
                materialService.saveSingleRequestRework({
                    requestId: 810,
                    actorUserId: "REQ-01",
                    actorUsername: "requester.user",
                    editedRequest: {},
                }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "RESUBMIT_REASON_REQUIRED");
                // The key has to name an input that exists on the resubmit
                // surfaces, or the client has nothing to attach the message to.
                assert.deepEqual(
                    error.errors.map(e => e.fieldKey),
                    ["comment"]
                );
                return true;
            }
        );

        const result = await materialService.saveSingleRequestRework({
            requestId: 810,
            actorUserId: "REQ-01",
            actorUsername: "requester.user",
            editedRequest: {},
            comment: "Storage location sudah saya perbaiki",
        });

        assert.equal(result.status, "Submit");
        assert.equal(commentInserts.length, 1);
        assert.deepEqual(commentInserts[0].params, [
            "SINGLE",
            810,
            "RESUBMIT",
            null,
            "REQ-01",
            "Storage location sudah saya perbaiki",
        ]);
    } finally {
        db.connect = originalConnect;
    }
});

test("saveSingleRequestRework records a rewritten Change/Extend reason alongside the comment", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    db.connect = connectSingleReworkStub({
        snapshot: baseSingleSnapshot({
            ticket_type: "Extend",
            change_extend_reason: "Need a new storage location",
        }),
        commentInserts,
    });

    try {
        const result = await materialService.saveSingleRequestRework({
            requestId: 810,
            actorUserId: "REQ-01",
            actorUsername: "requester.user",
            editedRequest: {
                change_extend_reason: "Need two storage locations, not one",
            },
            comment: "Storage location sudah saya perbaiki",
        });

        assert.equal(result.status, "Submit");
        assert.equal(commentInserts.length, 1);
        // Both are kept: the comment says what was fixed, the reason says why
        // the change is wanted. One resubmit event carries the pair.
        assert.deepEqual(commentInserts[0].params, [
            "SINGLE",
            810,
            "RESUBMIT",
            null,
            "REQ-01",
            "Storage location sudah saya perbaiki\nNeed two storage locations, not one",
        ]);
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Mass request resubmit — saveMassRequestRework (the mass rework dialog).
// ---------------------------------------------------------------------------

const connectMassReworkStub = ({ commentInserts = [] } = {}) =>
    async () => ({
        query: async (queryText, params = []) => {
            if (
                ["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText) ||
                /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(
                    queryText
                )
            ) {
                return { rows: [], rowCount: null };
            }

            if (/FOR UPDATE OF i/.test(queryText)) {
                return { rows: [{ id: 501, status: "REWORK", assigned_to: "Requester" }] };
            }

            if (/FOR UPDATE OF s/.test(queryText)) {
                return {
                    rows: [
                        {
                            id: 6001,
                            item_id: 501,
                            level: 1,
                            kind: "MANUAL",
                            approver_user_id: "APP-01",
                            status: "REWORK",
                            acted_at: null,
                            remark: "Deskripsi kurang lengkap",
                        },
                    ],
                };
            }

            if (/UPDATE mat_mass_request_item_approval_step/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            if (/UPDATE mat_mass_request_item\b/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            if (/INSERT INTO mat_request_comment/.test(queryText)) {
                commentInserts.push({ queryText, params });
                return { rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
        release: () => {},
    });

test("saveMassRequestRework rejects a resubmit with no comment", async () => {
    const originalConnect = db.connect;
    db.connect = connectMassReworkStub();

    try {
        await assert.rejects(
            () =>
                materialService.saveMassRequestRework({
                    massRequestId: 501,
                    actorUserId: "REQ-01",
                    items: null,
                }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "RESUBMIT_REASON_REQUIRED");
                // The key has to name an input that exists on the resubmit
                // surfaces, or the client has nothing to attach the message to.
                assert.deepEqual(
                    error.errors.map(e => e.fieldKey),
                    ["comment"]
                );
                return true;
            }
        );
    } finally {
        db.connect = originalConnect;
    }
});

test("saveMassRequestRework rejects whitespace-only comment", async () => {
    const originalConnect = db.connect;
    db.connect = connectMassReworkStub();

    try {
        await assert.rejects(
            () =>
                materialService.saveMassRequestRework({
                    massRequestId: 501,
                    actorUserId: "REQ-01",
                    items: null,
                    comment: "   ",
                }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "RESUBMIT_REASON_REQUIRED");
                // The key has to name an input that exists on the resubmit
                // surfaces, or the client has nothing to attach the message to.
                assert.deepEqual(
                    error.errors.map(e => e.fieldKey),
                    ["comment"]
                );
                return true;
            }
        );
    } finally {
        db.connect = originalConnect;
    }
});

test("saveMassRequestRework (mass dialog) accepts a comment and writes one resubmit event carrying it", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    db.connect = connectMassReworkStub({ commentInserts });

    try {
        const result = await materialService.saveMassRequestRework({
            massRequestId: 501,
            actorUserId: "REQ-01",
            items: null,
            comment: "Semua item sudah saya lengkapi speknya",
        });

        assert.equal(result.status, "Submit");
        assert.equal(commentInserts.length, 1);
        assert.deepEqual(commentInserts[0].params, [
            "MASS",
            501,
            "RESUBMIT",
            null,
            "REQ-01",
            "Semua item sudah saya lengkapi speknya",
        ]);
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Submit — createSingleRequest. Optional: a Create submission with no reason
// field of its own falls back to the new submit dialog's comment; Change and
// Extend keep using their existing reason field (unchanged).
// ---------------------------------------------------------------------------

const connectCreateSubmitStub = ({ commentInserts = [] } = {}) =>
    async () => ({
        query: async (queryText, params = []) => {
            if (
                ["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText) ||
                /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(
                    queryText
                )
            ) {
                return { rows: [], rowCount: null };
            }

            if (/nextval\(pg_get_serial_sequence\('mat_single_request', 'id'\)\)/i.test(queryText)) {
                return { rows: [{ next_id: 900 }], rowCount: 1 };
            }

            if (/FROM mat_approvers_matrix_level/i.test(queryText)) {
                return { rows: [], rowCount: 0 };
            }

            if (/INSERT INTO mat_single_request\s*\(/i.test(queryText)) {
                return {
                    rows: [
                        {
                            id: 900,
                            request_no: "1000000900",
                            ticket_type: "Create",
                            status: "Submit",
                            assigned_to: "Master Data",
                            created_by: "REQ-01",
                            created_at: new Date("2026-08-10T00:00:00.000Z"),
                        },
                    ],
                    rowCount: 1,
                };
            }

            if (/INSERT INTO mat_single_request_approval_step/i.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            if (/INSERT INTO mat_request_comment/.test(queryText)) {
                commentInserts.push({ queryText, params });
                return { rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
        release: () => {},
    });

test("createSingleRequest (Create) submits with no comment and writes a submit event with nothing said", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    db.connect = connectCreateSubmitStub({ commentInserts });

    try {
        const result = await materialService.createSingleRequest({
            ticketType: "Create",
            materialGroupId: 12,
            materialSubGroupId: 110,
            requestFields: {},
            templateValues: {},
            attachments: [],
            createdBy: "REQ-01",
            createdByUsername: "requester.user",
        });

        assert.equal(result.id, 900);
        assert.equal(commentInserts.length, 1);
        assert.deepEqual(commentInserts[0].params, [
            "SINGLE",
            900,
            "SUBMIT",
            null,
            "REQ-01",
            null,
        ]);
    } finally {
        db.connect = originalConnect;
    }
});

test("createSingleRequest (Create) submits with a comment and records it", async () => {
    const originalConnect = db.connect;
    const commentInserts = [];
    db.connect = connectCreateSubmitStub({ commentInserts });

    try {
        await materialService.createSingleRequest({
            ticketType: "Create",
            comment: "Ini untuk stok pengganti yang rusak",
            materialGroupId: 12,
            materialSubGroupId: 110,
            requestFields: {},
            templateValues: {},
            attachments: [],
            createdBy: "REQ-01",
            createdByUsername: "requester.user",
        });

        assert.equal(commentInserts.length, 1);
        assert.deepEqual(commentInserts[0].params, [
            "SINGLE",
            900,
            "SUBMIT",
            null,
            "REQ-01",
            "Ini untuk stok pengganti yang rusak",
        ]);
    } finally {
        db.connect = originalConnect;
    }
});
