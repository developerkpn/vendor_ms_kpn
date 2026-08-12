const assert = require("node:assert/strict");
const test = require("node:test");
const materialService = require("../services/materialService");
const db = require("../config/connection");

// Request comment history (migration 20260812_mat_request_comment.sql).
//
// Nothing here opens a connection: pg is replaced by a db.connect stub that
// matches on SQL and records what it was asked, which is enough to pin both
// halves — that the write is parameterised and savepointed, and that a database
// without the table degrades to an empty thread instead of a failed action.

const {
    REQUEST_COMMENT_KINDS,
    REQUEST_COMMENT_EVENTS,
    buildRequestCommentRow,
    isMissingRequestCommentTableError,
    insertRequestComment,
} = materialService;

const missingTableError = () =>
    Object.assign(
        new Error('relation "mat_request_comment" does not exist'),
        { code: "42P01" }
    );

// Records every statement, and optionally fails the INSERT the way a database
// that has not run the migration would.
const commentClientStub = ({ insertError = null, rows = [] } = {}) => {
    const state = { queries: [] };

    state.client = {
        query: async (queryText, params = []) => {
            state.queries.push({ queryText, params });

            if (/INSERT INTO mat_request_comment/.test(queryText)) {
                if (insertError) {
                    throw insertError;
                }
                return { rowCount: 1 };
            }

            if (/FROM mat_request_comment c/.test(queryText)) {
                return { rows };
            }

            return { rows: [], rowCount: 0 };
        },
        release: () => {},
    };

    state.connect = async () => state.client;

    return state;
};

const statementsOf = stub => stub.queries.map(entry => entry.queryText.trim());

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

test("buildRequestCommentRow stores an empty comment as NULL", () => {
    const blank = buildRequestCommentRow({
        requestKind: REQUEST_COMMENT_KINDS.SINGLE,
        requestId: "810",
        eventType: REQUEST_COMMENT_EVENTS.SUBMIT,
    });

    assert.equal(blank.comment, null);
    // The id is stored as a number, whatever the caller was holding.
    assert.equal(blank.request_id, 810);
    assert.equal(blank.stage, null);
    assert.equal(blank.actor_user_id, null);

    const whitespaceOnly = buildRequestCommentRow({
        requestKind: REQUEST_COMMENT_KINDS.SINGLE,
        requestId: 810,
        eventType: REQUEST_COMMENT_EVENTS.APPROVE,
        comment: "   \n  ",
    });

    assert.equal(whitespaceOnly.comment, null);
});

test("buildRequestCommentRow keeps a real comment, trimmed", () => {
    const row = buildRequestCommentRow({
        requestKind: REQUEST_COMMENT_KINDS.MASS,
        requestId: 42,
        eventType: REQUEST_COMMENT_EVENTS.REWORK,
        stage: "Approval 1",
        actorUserId: "APP-07",
        comment: "  Deskripsi material kurang lengkap  ",
    });

    assert.deepEqual(row, {
        request_kind: "MASS",
        request_id: 42,
        event_type: "REWORK",
        stage: "Approval 1",
        actor_user_id: "APP-07",
        comment: "Deskripsi material kurang lengkap",
    });
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

test("insertRequestComment writes the row inside its own savepoint", async () => {
    const stub = commentClientStub();

    await insertRequestComment(stub.client, {
        requestKind: REQUEST_COMMENT_KINDS.SINGLE,
        requestId: 810,
        eventType: REQUEST_COMMENT_EVENTS.REJECT,
        stage: "Master Data",
        actorUserId: "MDM-02",
        comment: "Material sudah ada di SAP",
    });

    assert.deepEqual(statementsOf(stub).filter(sql => /SAVEPOINT/.test(sql)), [
        "SAVEPOINT mat_request_comment_insert",
        "RELEASE SAVEPOINT mat_request_comment_insert",
    ]);

    const insert = stub.queries.find(entry =>
        /INSERT INTO mat_request_comment/.test(entry.queryText)
    );

    // Every value is bound, none interpolated.
    assert.match(insert.queryText, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, NOW\(\)\)/);
    assert.deepEqual(insert.params, [
        "SINGLE",
        810,
        "REJECT",
        "Master Data",
        "MDM-02",
        "Material sudah ada di SAP",
    ]);
});

test("insertRequestComment lets the action through when the table is missing", async () => {
    const stub = commentClientStub({ insertError: missingTableError() });

    await insertRequestComment(stub.client, {
        requestKind: REQUEST_COMMENT_KINDS.SINGLE,
        requestId: 810,
        eventType: REQUEST_COMMENT_EVENTS.APPROVE,
        stage: "Approval 1",
        actorUserId: "APP-07",
    });

    // Rolled back to the savepoint, so the surrounding transaction is still
    // usable — without that, the approval's own COMMIT would fail.
    assert.ok(
        statementsOf(stub).includes(
            "ROLLBACK TO SAVEPOINT mat_request_comment_insert"
        )
    );
    assert.ok(
        !statementsOf(stub).includes("RELEASE SAVEPOINT mat_request_comment_insert")
    );
});

test("insertRequestComment rethrows a write failure that is not a missing table", async () => {
    const insertError = Object.assign(new Error("null value in column"), {
        code: "23502",
    });
    const stub = commentClientStub({ insertError });

    await assert.rejects(
        () =>
            insertRequestComment(stub.client, {
                requestKind: REQUEST_COMMENT_KINDS.SINGLE,
                requestId: 810,
                eventType: REQUEST_COMMENT_EVENTS.APPROVE,
            }),
        /null value in column/
    );

    assert.ok(
        statementsOf(stub).includes(
            "ROLLBACK TO SAVEPOINT mat_request_comment_insert"
        )
    );
});

test("isMissingRequestCommentTableError only matches this table", () => {
    assert.equal(isMissingRequestCommentTableError(missingTableError()), true);
    assert.equal(
        isMissingRequestCommentTableError(
            Object.assign(new Error('relation "mat_rework_email" does not exist'), {
                code: "42P01",
            })
        ),
        false
    );
    assert.equal(
        isMissingRequestCommentTableError(
            Object.assign(new Error("mat_request_comment"), { code: "23502" })
        ),
        false
    );
});

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

test("getRequestComments returns the thread oldest first", async () => {
    const originalConnect = db.connect;
    const stub = commentClientStub({
        rows: [
            {
                id: "1",
                event_type: "SUBMIT",
                stage: null,
                actor_user_id: "REQ-01",
                actor_name: "Siti Rahayu",
                comment: null,
                created_at: "2026-08-10T02:00:00.000Z",
            },
            {
                id: "2",
                event_type: "REWORK",
                stage: "Approval 1",
                actor_user_id: "APP-07",
                actor_name: "Budi Santoso",
                comment: "Deskripsi kurang lengkap",
                created_at: "2026-08-10T03:00:00.000Z",
            },
        ],
    });
    db.connect = stub.connect;

    try {
        const thread = await materialService.getRequestComments({
            requestKind: "SINGLE",
            requestId: 810,
        });

        assert.deepEqual(thread, [
            {
                id: 1,
                eventType: "SUBMIT",
                stage: null,
                actorUserId: "REQ-01",
                actorName: "Siti Rahayu",
                comment: null,
                createdAt: "2026-08-10T02:00:00.000Z",
            },
            {
                id: 2,
                eventType: "REWORK",
                stage: "Approval 1",
                actorUserId: "APP-07",
                actorName: "Budi Santoso",
                comment: "Deskripsi kurang lengkap",
                createdAt: "2026-08-10T03:00:00.000Z",
            },
        ]);

        const read = stub.queries.find(entry =>
            /FROM mat_request_comment c/.test(entry.queryText)
        );

        assert.deepEqual(read.params, ["SINGLE", 810]);
        // The thread is only readable in the order it was said in.
        assert.match(read.queryText, /ORDER BY c\.created_at ASC, c\.id ASC/);
    } finally {
        db.connect = originalConnect;
    }
});

test("getRequestComments reads an empty thread when the table is missing", async () => {
    const originalConnect = db.connect;
    db.connect = async () => ({
        query: async () => {
            throw missingTableError();
        },
        release: () => {},
    });

    try {
        const thread = await materialService.getRequestComments({
            requestKind: "MASS",
            requestId: 42,
        });

        assert.deepEqual(thread, []);
    } finally {
        db.connect = originalConnect;
    }
});
