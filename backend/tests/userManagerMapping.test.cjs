const assert = require("node:assert/strict");
const test = require("node:test");

// Load routes first because the legacy user model imports UserRoute.
require("../routes/UserRoute");
const User = require("../models/UserModel");
const UserController = require("../controllers/UserController");
const db = require("../config/connection");

process.env.TOKEN_KEY = "user-manager-mapping-test-only";

const userParams = overrides => ({
    user_id: "requester-1", mgr_id: "manager-1", username: "requester1",
    fullname: "Requester One", email: "requester1@example.test", role: "PROC",
    usergroup: "requesters", bu_id: "DWS", dept_id: "COMMERCIAL-DWS",
    emp_role_id: "STAFF", createddate: "2025-01-01", expireddate: "2027-01-01",
    ...overrides,
});

const managerParams = overrides => ({
    ...userParams(), user_id: "manager-1", mgr_id: "", role: "MGR",
    username: "manager1", fullname: "Manager One", email: "manager1@example.test",
    emp_role_id: "DEPT_HEAD", ...overrides,
});

function databaseStub() {
    const state = {
        queries: [], releases: 0,
        tables: {
            mst_user: [
                { user_id: "requester-1", mgr_id: "manager-1", username: "requester1" },
                { user_id: "requester-2", mgr_id: "manager-1", username: "requester2" },
            ],
            mst_mgr: [
                { mgr_id: "manager-1", fullname: "Manager One", username: "manager1", role: "MGR", is_active: true },
                { mgr_id: "manager-2", fullname: "Manager Two", username: "manager2", role: "MGR", is_active: true },
                { mgr_id: "inactive-manager", fullname: "Inactive Manager", is_active: false },
            ],
            a_uservendor: [],
        },
    };
    const client = {
        release() { state.releases++; },
        async query(text, params = []) {
            state.queries.push({ text, params });
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
            if (text.includes("AS account_type")) {
                const rows = [];
                for (const [table, column, type] of [
                    ["mst_user", "user_id", "USER"], ["mst_mgr", "mgr_id", "MGR"],
                    ["a_uservendor", "user_id", "VENDOR"],
                ]) {
                    for (const row of state.tables[table]) {
                        if (row[column] === params[0]) rows.push({ account_type: type });
                    }
                }
                return { rows, rowCount: rows.length };
            }
            if (text.includes("FROM mst_mgr WHERE mgr_id = $1")) {
                const rows = state.tables.mst_mgr.filter(row => row.mgr_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (text.includes("SELECT mgr_id FROM mst_user")) {
                const rows = state.tables.mst_user.filter(row => row.user_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (text.includes("FROM mst_mgr ORDER BY")) {
                const rows = state.tables.mst_mgr;
                return { rows, rowCount: rows.length };
            }
            const update = text.match(/^UPDATE (mst_user|mst_mgr) SET (.+) WHERE (user_id|mgr_id) = '([^']*)'/);
            if (update) {
                const row = state.tables[update[1]].find(row => row[update[3]] === update[4]);
                if (!row) return { rows: [], rowCount: 0 };
                for (const match of update[2].matchAll(/(\w+) = \$(\d+)/g)) {
                    row[match[1]] = params[Number(match[2]) - 1];
                }
                return { rows: [{ username: row.username }], rowCount: 1 };
            }
            const insert = text.match(/^INSERT INTO (mst_user|mst_mgr)\(([^)]+)\)/);
            if (insert) {
                const row = Object.fromEntries(insert[2].split(", ").map((col, i) => [col, params[i]]));
                state.tables[insert[1]].push(row);
                return { rows: [{ username: row.username }], rowCount: 1 };
            }
            throw new Error(`Unexpected offline query: ${text}`);
        },
    };
    state.connect = async () => client;
    return state;
}

async function withDatabase(state, run) {
    const originalConnect = db.connect;
    db.connect = state.connect;
    try { return await run(); } finally { db.connect = originalConnect; }
}

test("editing a manager preserves their ID and every requester's manager reference", async () => {
    const state = databaseStub();
    await withDatabase(state, () => User.createManager(managerParams({ fullname: "Updated Name" })));
    const updated = state.tables.mst_mgr.find(row => row.mgr_id === "manager-1");
    assert.equal(updated.fullname, "Updated Name");
    for (const requester of state.tables.mst_user) {
        assert.equal(requester.mgr_id, updated.mgr_id);
        assert.ok(state.tables.mst_mgr.some(manager => manager.mgr_id === requester.mgr_id));
    }
    assert.equal(state.tables.mst_mgr.length, 3);
});

test("creating a manager gives only the new record a new ID", async () => {
    const state = databaseStub();
    await withDatabase(state, () => User.createManager(managerParams({ user_id: "", username: "newmanager" })));
    const created = state.tables.mst_mgr.find(row => row.username === "newmanager");
    assert.match(created.mgr_id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(created.mgr_id, "manager-1");
    assert.equal(state.tables.mst_user[0].mgr_id, "manager-1");
});

test("concurrent create and password update keep their own insert/update mode", async () => {
    const state = databaseStub();
    await withDatabase(state, () => Promise.all([
        User.createManager(managerParams({ fullname: "Updated Name", password: "fixture-password" })),
        User.createManager(managerParams({ user_id: "", username: "newmanager" })),
    ]));
    assert.equal(state.tables.mst_mgr.find(row => row.mgr_id === "manager-1").fullname, "Updated Name");
    assert.equal(state.tables.mst_mgr.filter(row => row.username === "newmanager").length, 1);
    assert.equal(state.tables.mst_mgr.length, 4);
});

test("repairing one user changes only that user's manager assignment", async () => {
    const state = databaseStub();
    state.tables.mst_user[0].mgr_id = "deleted-manager";
    await withDatabase(state, () => User.createUser(userParams({ mgr_id: "manager-2" })));
    assert.equal(state.tables.mst_user[0].mgr_id, "manager-2");
    assert.equal(state.tables.mst_user[1].mgr_id, "manager-1");
});

for (const managerId of ["deleted-manager", "inactive-manager"]) {
    test(`a newly selected ${managerId} is rejected without updating the user`, async () => {
        const state = databaseStub();
        await withDatabase(state, () => assert.rejects(
            User.createUser(userParams({ mgr_id: managerId })),
            error => error.statusCode === 400 && /active manager/.test(error.message)
        ));
        assert.equal(state.tables.mst_user[0].mgr_id, "manager-1");
        assert.ok(state.queries.some(query => /ROLLBACK/.test(query.text)));
        assert.ok(!state.queries.some(query => /^UPDATE/.test(query.text)));
    });
}

test("a profile edit can preserve an unchanged legacy missing manager", async () => {
    const state = databaseStub();
    state.tables.mst_user[0].mgr_id = "deleted-manager";
    await withDatabase(state, () => User.createUser(userParams({ mgr_id: "deleted-manager", fullname: "Updated Requester" })));
    assert.equal(state.tables.mst_user[0].fullname, "Updated Requester");
    assert.equal(state.tables.mst_user[0].mgr_id, "deleted-manager");
});

test("clearing a manager keeps the user and stores no manager assignment", async () => {
    const state = databaseStub();
    await withDatabase(state, () => User.createUser(userParams({ mgr_id: "" })));
    assert.equal(state.tables.mst_user[0].mgr_id, null);
    assert.equal(state.tables.mst_user[1].mgr_id, "manager-1");
    assert.equal(state.tables.mst_mgr.length, 3);
});

test("account lookup distinguishes a manager's table even with a PROC access role", async () => {
    const state = databaseStub();
    state.tables.mst_mgr[0].role = "PROC";
    await withDatabase(state, async () => {
        assert.equal(await User.getAccountType("manager-1"), "MGR");
        assert.equal(await User.getAccountType("requester-1"), "USER");
        assert.equal(await User.getAccountType("missing-user"), null);
    });
});

test("ambiguous account IDs are rejected", async () => {
    const state = databaseStub();
    state.tables.mst_mgr.push({ mgr_id: "requester-1" });
    await withDatabase(state, () => assert.rejects(User.getAccountType("requester-1"), error => error.statusCode === 409));
});

const responseStub = () => ({
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
});

test("submitting a staff user with no manager keeps it a staff account", async () => {
    const state = databaseStub(), res = responseStub();
    await withDatabase(state, () => UserController.createNewUser({ body: userParams({ mgr_id: "" }) }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(state.tables.mst_user[0].mgr_id, null);
    assert.equal(state.tables.mst_mgr.length, 3);
});

test("submitting a legacy PROC manager updates the manager and preserves their ID", async () => {
    const state = databaseStub(), res = responseStub();
    state.tables.mst_mgr[0].role = "PROC";
    await withDatabase(state, () => UserController.createNewUser({ body: managerParams({ role: "PROC", fullname: "Updated Legacy Manager" }) }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(state.tables.mst_mgr[0].mgr_id, "manager-1");
    assert.equal(state.tables.mst_mgr[0].fullname, "Updated Legacy Manager");
    assert.equal(state.tables.mst_user.length, 2);
});

test("invalid manager submissions return a readable validation error", async () => {
    const state = databaseStub(), res = responseStub();
    const originalError = console.error;
    console.error = () => {};
    try {
        await withDatabase(state, () => UserController.createNewUser({ body: userParams({ mgr_id: "deleted-manager" }) }, res));
    } finally { console.error = originalError; }
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /active manager/);
    assert.equal(state.tables.mst_user[0].mgr_id, "manager-1");
});
