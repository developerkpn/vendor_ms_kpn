const assert = require("node:assert/strict");
const test = require("node:test");
const db = require("../config/connection");
const oracle = require("../config/oracleconnection");

// VendorModel captures getConnection at import time. Keep a per-test provider
// so these tests never open a real Oracle connection.
let connectionProvider;
const originalGetConnection = oracle.getConnection;
oracle.getConnection = async () => connectionProvider();
const Vendor = require("../models/VendorModel");
oracle.getConnection = originalGetConnection;

function stagingStub({
    staged = [],
    failInsert = false,
    failCommit = false,
} = {}) {
    const state = {
        queries: [],
        executions: [],
        commits: 0,
        rolledBack: false,
        closed: false,
        released: false,
    };
    state.pg = {
        async query(sql, params) {
            state.queries.push({ sql, params });
            if (/from\s+vendor v/i.test(sql))
                return {
                    rows: [
                        {
                            ven_code: "LN13400319",
                            name_1: "DANI",
                            title: "PERSON",
                            local_ovs: "LOCAL",
                            ven_acc: "TRADE",
                            phone_pref: "62",
                            telf1: "800",
                        },
                    ],
                };
            if (/from\s+ven_bank/i.test(sql))
                return {
                    rows: [
                        { bank_name: "Bank", bank_key: "001", bank_acc: "123" },
                    ],
                };
            if (/from ven_file_atth/.test(sql))
                return { rows: [{ file_code: "A005", file_name: "tax.jpg" }] };
            return { rows: [] };
        },
        release(error) {
            state.released = true;
            state.releaseError = error;
        },
    };
    state.oracle = {
        async execute(sql) {
            state.executions.push(sql);
            if (/SELECT VEN_CODE/.test(sql)) return { rows: staged };
            if (failInsert && /INSERT INTO VMS_FILEATTACHMENT/.test(sql))
                throw new Error("File insert failed");
            return { rows: [] };
        },
        async commit() {
            await new Promise(resolve => setImmediate(resolve));
            if (failCommit) throw new Error("Oracle commit failed");
            state.commits++;
        },
        async rollback() {
            await new Promise(resolve => setImmediate(resolve));
            state.rolledBack = true;
        },
        async close() {
            state.closed = true;
        },
    };
    return state;
}

async function withStaging(stub, run) {
    const originalConnect = db.connect;
    db.connect = async () => stub.pg;
    connectionProvider = () => stub.oracle;
    try {
        return await run();
    } finally {
        db.connect = originalConnect;
    }
}

test("retry after an Oracle commit preserves the existing header and children", async () => {
    const stub = stagingStub({ staged: [["LN13400319"]] });
    await withStaging(stub, async () => {
        const result = await Vendor.UploadStaging("vendor-id");
        assert.equal(result.already_staged, true);
    });
    assert.ok(!stub.executions.some(sql => /INSERT/.test(sql)));
    assert.equal(stub.commits, 0);
    assert.equal(stub.closed, true);
    assert.equal(stub.released, true);
    assert.match(stub.queries[0].sql, /pg_advisory_lock/);
    assert.match(stub.queries.at(-1).sql, /pg_advisory_unlock/);
});

test("a conflicting staged vendor code fails instead of overwriting SAP data", async () => {
    const stub = stagingStub({ staged: [["OTHER-CODE"]] });
    await withStaging(stub, () =>
        assert.rejects(() => Vendor.UploadStaging("vendor-id"), /conflicts/)
    );
    assert.ok(!stub.executions.some(sql => /INSERT/.test(sql)));
    assert.equal(stub.rolledBack, true);
    assert.equal(stub.closed, true);
});

test("a new upload awaits the Oracle commit before reporting success", async () => {
    const stub = stagingStub();
    await withStaging(stub, async () => {
        await Vendor.UploadStaging("vendor-id");
        assert.equal(stub.commits, 1);
    });
    assert.equal(stub.executions.filter(sql => /INSERT/.test(sql)).length, 3);
    assert.equal(stub.closed, true);
});

test("an Oracle commit failure is propagated so the outbox retries it", async () => {
    const stub = stagingStub({ failCommit: true });
    await withStaging(stub, () =>
        assert.rejects(
            () => Vendor.UploadStaging("vendor-id"),
            /Oracle commit failed/
        )
    );
    assert.equal(stub.rolledBack, true);
    assert.equal(stub.closed, true);
    assert.equal(stub.released, true);
});

test("a child insert failure rolls back before releasing connections", async () => {
    const stub = stagingStub({ failInsert: true });
    await withStaging(stub, () =>
        assert.rejects(
            () => Vendor.UploadStaging("vendor-id"),
            /File insert failed/
        )
    );
    assert.equal(stub.commits, 0);
    assert.equal(stub.rolledBack, true);
    assert.equal(stub.closed, true);
    assert.equal(stub.released, true);
});

test("Oracle connection failures still release the advisory lock and PostgreSQL client", async () => {
    const stub = stagingStub();
    await withStaging(stub, async () => {
        connectionProvider = () => {
            throw new Error("Oracle unreachable");
        };
        await assert.rejects(
            () => Vendor.UploadStaging("vendor-id"),
            /Oracle unreachable/
        );
    });
    assert.equal(stub.released, true);
    assert.match(stub.queries.at(-1).sql, /pg_advisory_unlock/);
});
