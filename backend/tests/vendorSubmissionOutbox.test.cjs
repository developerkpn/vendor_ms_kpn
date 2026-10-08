const assert = require("node:assert/strict");
const test = require("node:test");
const {
    enqueueVendorSubmissionJob,
    processPendingVendorSubmissions,
    retryDelaySeconds,
    MAX_ATTEMPTS,
} = require("../services/vendorSubmissionOutboxService");
const db = require("../config/connection");
const ApprovalTracker = require("../class/ApprovalTrackerClass");
const ApprovalModel = require("../models/ApprovalModel");
const Vendor = require("../models/VendorModel");
const Emailer = require("../models/EmailModel");
const EmailModel = require("../models/EmailModelv2");

const logger = { error() {} };

function workerPool(job) {
    const queries = [];
    let claimed = false;
    return {
        queries,
        async query(sql, params) {
            queries.push({ sql, params });
            if (sql.includes("RETURNING jobs.*") && !claimed) {
                claimed = true;
                return { rows: [job], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
}

test("a failed notification remains retryable; a later delivery completes the same job", async () => {
    const job = { id: "7", job_type: "TAX_EMAIL", attempts: 1, payload: {} };
    const pool = workerPool(job);
    const result = await processPendingVendorSubmissions({
        pool,
        logger,
        executeJob: async () => {
            throw Object.assign(new Error("SMTP unavailable"), {
                code: "ETIMEDOUT",
            });
        },
    });
    assert.deepEqual(result, { succeeded: 0, retried: 1, failed: 0 });
    const retry = pool.queries.find(q => q.sql.includes("SET status = $1"));
    assert.deepEqual(retry.params.slice(0, 4), [
        "PENDING",
        60,
        "ETIMEDOUT SMTP unavailable",
        "7",
    ]);
    assert.match(retry.sql, /claim_token = \$5/);
    assert.ok(
        pool.queries.every(q => !/UPDATE\s+(ticket|vendor)\s/i.test(q.sql))
    );

    const retryPool = workerPool({ ...job, attempts: 2 });
    const delivered = [];
    const success = await processPendingVendorSubmissions({
        pool: retryPool,
        logger,
        executeJob: async value => delivered.push(value.id),
    });
    assert.deepEqual(delivered, ["7"]);
    assert.equal(success.succeeded, 1);
    assert.ok(
        retryPool.queries.some(q => q.sql.includes("SET status = 'DONE'"))
    );
});

test("exhausted jobs record FAILED instead of retrying forever", async () => {
    const pool = workerPool({
        id: "8",
        job_type: "SAP_UPLOAD",
        attempts: MAX_ATTEMPTS,
    });
    const result = await processPendingVendorSubmissions({
        pool,
        logger,
        executeJob: async () => {
            throw new Error("Oracle unavailable");
        },
    });
    assert.equal(result.failed, 1);
    assert.equal(
        pool.queries.find(q => q.sql.includes("SET status = $1")).params[0],
        "FAILED"
    );
    assert.equal(retryDelaySeconds(2), 120);
    assert.equal(retryDelaySeconds(MAX_ATTEMPTS), 3600);
});

test("queue insertion uses the caller's transaction and a stable ticket/job key", async () => {
    const queries = [];
    await enqueueVendorSubmissionJob(
        { query: async (sql, params) => queries.push({ sql, params }) },
        {
            ticketToken: "ticket-token",
            venId: "vendor-id",
            jobType: "TAX_EMAIL",
            dependsOnType: "SAP_UPLOAD",
            payload: { detail: { ven_id: "vendor-id" } },
        }
    );
    assert.equal(queries.length, 1);
    assert.match(
        queries[0].sql,
        /ON CONFLICT \(ticket_token, job_type\) DO NOTHING/
    );
    assert.equal(queries[0].params[0], "ticket-token");
    assert.equal(queries[0].params[4], "SAP_UPLOAD");
});

test("MDM completion commits approval and queues external work without sending mail or uploading Oracle", async () => {
    const originals = [];
    const replace = (obj, key, value) => {
        originals.push(() => {
            obj[key] = value;
        });
        obj[key] = value;
    };
    const jobs = [];
    const detail = {
        ven_id: "vendor-id",
        ven_code: "LN13400319",
        name_1: "DANI",
        title: "PERSON",
        local_ovs: "LOCAL",
        bu_id: "UPS",
        ticket_num: "PRC-26104324",
    };
    let completed = false;
    let committed = false;
    const client = {
        async query(sql, params) {
            if (sql === "COMMIT") {
                committed = true;
                return { rows: [] };
            }
            if (/UPDATE ticket/.test(sql)) {
                completed = true;
                return { rows: [{ ticket_id: detail.ticket_num }] };
            }
            if (/INSERT INTO vendor_submission_outbox/.test(sql)) {
                assert.equal(committed, false);
                jobs.push({
                    type: params[2],
                    payload: JSON.parse(params[3]),
                    dependency: params[4],
                });
                return { rows: [] };
            }
            if (/select hostname/.test(sql))
                return { rows: [{ hostname: "https://vms.example" }] };
            if (/select title/.test(sql)) return { rows: [detail] };
            if (/string_agg\(email/.test(sql))
                return { rows: [{ email: "verify@example.com" }] };
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
    try {
        replace(db, "connect", async () => {
            throw new Error("Approval must use the supplied transaction");
        });
        replace(ApprovalTracker.prototype, "init", async function () {
            this.current_step = { cc_email: "mdm@example.com" };
        });
        replace(ApprovalTracker.prototype, "getApprovalStep", () => ({
            email: "requester@example.com",
            emp_role_id: "STAFF",
        }));
        replace(ApprovalTracker.prototype, "getEmailLastSteps", () => [
            null,
            "manager@example.com",
        ]);
        for (const [obj, key] of [
            [Vendor, "UploadStaging"],
            [Emailer, "RequestVerificator"],
            [Emailer, "NotifPajak"],
            [EmailModel, "EndTicket"],
        ]) {
            replace(obj, key, async () => {
                throw new Error("External effects must wait for commit");
            });
        }
        const result = await ApprovalModel.EndApproval(
            client,
            "ticket-token",
            "mdm-user"
        );
        await client.query("COMMIT");
        assert.equal(completed, true);
        assert.equal(committed, true);
        assert.match(result.message, /is Done/);
        assert.deepEqual(
            jobs.map(job => job.type),
            [
                "SAP_UPLOAD",
                "VERIFICATION_EMAIL",
                "TAX_EMAIL",
                "COMPLETION_EMAIL",
            ]
        );
        assert.ok(jobs.slice(1).every(job => job.dependency === "SAP_UPLOAD"));
        assert.equal(
            jobs[3].payload.config.cc,
            "manager@example.com,mdm@example.com"
        );
    } finally {
        originals.reverse().forEach(restore => restore());
    }
});
