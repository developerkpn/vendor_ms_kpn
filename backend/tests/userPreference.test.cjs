const assert = require("node:assert/strict");
const test = require("node:test");
const materialService = require("../services/materialService");
const MaterialController = require("../controllers/MaterialController");
const db = require("../config/connection");

// Per-user preference store (migration 20260814_mst_user_preference.sql).
//
// Same offline approach as requestComments.test.cjs: pg is replaced by a
// db.connect stub that matches on SQL and records what it was asked. The
// controller tests below stub materialService itself, to pin the one thing
// that actually matters for this table — that the row touched is always the
// one named by the session, never by anything the client sent.

const {
    isMissingUserPreferenceTableError,
    getUserPreference,
    setUserPreference,
} = materialService;

const missingTableError = () =>
    Object.assign(
        new Error('relation "mst_user_preference" does not exist'),
        { code: "42P01" }
    );

const preferenceClientStub = ({ readError = null, rows = [] } = {}) => {
    const state = { queries: [] };

    state.client = {
        query: async (queryText, params = []) => {
            state.queries.push({ queryText, params });

            if (/INSERT INTO mst_user_preference/.test(queryText)) {
                return { rowCount: 1 };
            }

            if (/FROM mst_user_preference/.test(queryText)) {
                if (readError) {
                    throw readError;
                }
                return { rows };
            }

            return { rows: [], rowCount: 0 };
        },
        release: () => {},
    };

    state.connect = async () => state.client;

    return state;
};

const withStubbedConnect = async (stub, run) => {
    const originalConnect = db.connect;
    db.connect = stub.connect;
    try {
        await run();
    } finally {
        db.connect = originalConnect;
    }
};

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

test("getUserPreference returns null when no row is stored", async () => {
    const stub = preferenceClientStub({ rows: [] });

    await withStubbedConnect(stub, async () => {
        const value = await getUserPreference({ userId: "REQ-01", key: "my_approval.status_filter" });
        assert.equal(value, null);
    });
});

test("getUserPreference returns the stored value, scoped to this user and key", async () => {
    const stub = preferenceClientStub({ rows: [{ pref_value: "Rework" }] });

    await withStubbedConnect(stub, async () => {
        const value = await getUserPreference({ userId: "REQ-01", key: "my_approval.status_filter" });
        assert.equal(value, "Rework");

        const read = stub.queries.find(entry => /FROM mst_user_preference/.test(entry.queryText));
        assert.deepEqual(read.params, ["REQ-01", "my_approval.status_filter"]);
    });
});

test("getUserPreference reads null when the table is missing", async () => {
    const stub = preferenceClientStub({ readError: missingTableError() });

    await withStubbedConnect(stub, async () => {
        const value = await getUserPreference({ userId: "REQ-01", key: "my_approval.status_filter" });
        assert.equal(value, null);
    });
});

test("getUserPreference rethrows a read failure that is not a missing table", async () => {
    const readError = Object.assign(new Error("connection terminated"), { code: "57P01" });
    const stub = preferenceClientStub({ readError });

    await withStubbedConnect(stub, () =>
        assert.rejects(
            () => getUserPreference({ userId: "REQ-01", key: "my_approval.status_filter" }),
            /connection terminated/
        )
    );
});

test("isMissingUserPreferenceTableError only matches this table", () => {
    assert.equal(isMissingUserPreferenceTableError(missingTableError()), true);
    assert.equal(
        isMissingUserPreferenceTableError(
            Object.assign(new Error('relation "mat_request_comment" does not exist'), {
                code: "42P01",
            })
        ),
        false
    );
    assert.equal(
        isMissingUserPreferenceTableError(
            Object.assign(new Error("mst_user_preference"), { code: "23502" })
        ),
        false
    );
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

test("setUserPreference writes one parameterised upsert, keyed on (user_id, pref_key)", async () => {
    const stub = preferenceClientStub();

    await withStubbedConnect(stub, () =>
        setUserPreference({ userId: "REQ-01", key: "my_approval.status_filter", value: "Rework" })
    );

    const writes = stub.queries.filter(entry => /INSERT INTO mst_user_preference/.test(entry.queryText));
    // One statement handles both create and overwrite — never a separate
    // UPDATE, so there is no second row to leave behind.
    assert.equal(writes.length, 1);
    assert.match(writes[0].queryText, /ON CONFLICT \(user_id, pref_key\)\s+DO UPDATE/);
    assert.deepEqual(writes[0].params, ["REQ-01", "my_approval.status_filter", "Rework"]);
});

// ---------------------------------------------------------------------------
// Controller: the owner is the session, never the request
// ---------------------------------------------------------------------------

const fakeRes = () => {
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    return res;
};

test("getUserPreference controller reads the user from the session, not a param", async () => {
    const originalGet = materialService.getUserPreference;
    let calledWith = null;
    materialService.getUserPreference = async args => {
        calledWith = args;
        return "Rework";
    };

    try {
        const req = {
            cookies: { user_id: "REAL-USER" },
            params: { key: "my_approval.status_filter" },
        };
        const res = fakeRes();

        await MaterialController.getUserPreference(req, res);

        assert.deepEqual(calledWith, { userId: "REAL-USER", key: "my_approval.status_filter" });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.data, { key: "my_approval.status_filter", value: "Rework" });
    } finally {
        materialService.getUserPreference = originalGet;
    }
});

test("getUserPreference controller rejects an unauthenticated request without touching the service", async () => {
    const originalGet = materialService.getUserPreference;
    let called = false;
    materialService.getUserPreference = async () => {
        called = true;
    };

    try {
        const req = { cookies: {}, params: { key: "my_approval.status_filter" } };
        const res = fakeRes();

        await MaterialController.getUserPreference(req, res);

        assert.equal(called, false);
        assert.equal(res.statusCode, 401);
    } finally {
        materialService.getUserPreference = originalGet;
    }
});

test("setUserPreference controller writes under the session's user, ignoring a client-supplied userId", async () => {
    const originalSet = materialService.setUserPreference;
    let calledWith = null;
    materialService.setUserPreference = async args => {
        calledWith = args;
    };

    try {
        const req = {
            cookies: { user_id: "REAL-USER" },
            params: { key: "my_approval.status_filter" },
            // A client editing the request body cannot redirect the write to
            // someone else's row: the controller has no code path that reads
            // this field.
            body: { value: "Rework", userId: "ATTACKER-SUPPLIED" },
        };
        const res = fakeRes();

        await MaterialController.setUserPreference(req, res);

        assert.deepEqual(calledWith, {
            userId: "REAL-USER",
            key: "my_approval.status_filter",
            value: "Rework",
        });
        assert.equal(res.statusCode, 200);
    } finally {
        materialService.setUserPreference = originalSet;
    }
});

test("setUserPreference controller rejects a malformed key before it reaches the service", async () => {
    const originalSet = materialService.setUserPreference;
    let called = false;
    materialService.setUserPreference = async () => {
        called = true;
    };

    try {
        const req = {
            cookies: { user_id: "REAL-USER" },
            params: { key: "../etc/passwd" },
            body: { value: "Rework" },
        };
        const res = fakeRes();

        await MaterialController.setUserPreference(req, res);

        assert.equal(called, false);
        assert.equal(res.statusCode, 400);
    } finally {
        materialService.setUserPreference = originalSet;
    }
});

test("setUserPreference controller rejects a missing or oversized value", async () => {
    const originalSet = materialService.setUserPreference;
    let called = false;
    materialService.setUserPreference = async () => {
        called = true;
    };

    try {
        const req = {
            cookies: { user_id: "REAL-USER" },
            params: { key: "my_approval.status_filter" },
            body: { value: "x".repeat(256) },
        };
        const res = fakeRes();

        await MaterialController.setUserPreference(req, res);

        assert.equal(called, false);
        assert.equal(res.statusCode, 400);
    } finally {
        materialService.setUserPreference = originalSet;
    }
});
