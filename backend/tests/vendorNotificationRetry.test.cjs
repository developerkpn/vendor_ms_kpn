const assert = require("node:assert/strict");
const test = require("node:test");
const mailer = require("nodemailer");

let smtpError = null;
const sent = [];
const originalCreateTransport = mailer.createTransport;
mailer.createTransport = () => ({
    async sendMail(message) {
        if (smtpError) throw smtpError;
        sent.push(message.subject);
        return { accepted: [message.to] };
    },
});
const {
    executeVendorSubmissionJob,
    processPendingVendorSubmissions,
} = require("../services/vendorSubmissionOutboxService");
const Emailer = require("../models/EmailModel");
require("../models/EmailModelv2");
mailer.createTransport = originalCreateTransport;

test("verification SMTP errors reach the retry worker instead of being swallowed", async () => {
    const job = {
        id: "1",
        job_type: "VERIFICATION_EMAIL",
        attempts: 1,
        payload: {
            detail: { title: "PERSON", local_ovs: "LOCAL", ven_name: "DANI" },
            link: "https://vms.example/dashboard/vendorverif",
            to: "verify@example.com",
        },
    };
    smtpError = new Error("SMTP temporarily unavailable");
    const updates = [];
    let claimed = false;
    const pool = {
        async query(sql, params) {
            if (sql.includes("RETURNING jobs.*") && !claimed) {
                claimed = true;
                return { rows: [job] };
            }
            updates.push({ sql, params });
            return { rows: [] };
        },
    };
    const originalLog = console.error;
    console.error = () => {};
    try {
        const result = await processPendingVendorSubmissions({
            pool,
            logger: { error() {} },
        });
        assert.equal(result.retried, 1);
        assert.equal(
            updates.find(update => update.sql.includes("SET status = $1"))
                .params[0],
            "PENDING"
        );
        assert.equal(sent.length, 0);
        smtpError = null;
        await executeVendorSubmissionJob(job);
        assert.equal(sent.length, 1);
    } finally {
        smtpError = null;
        console.error = originalLog;
    }
});

test("completion SMTP failures propagate without changing approval data", async () => {
    smtpError = new Error("SMTP temporarily unavailable");
    try {
        await assert.rejects(
            () =>
                executeVendorSubmissionJob({
                    job_type: "COMPLETION_EMAIL",
                    payload: {
                        vendorName: "DANI",
                        vendorCode: "LN13400319",
                        config: { to: "requester@example.com" },
                    },
                }),
            /SMTP temporarily unavailable/
        );
    } finally {
        smtpError = null;
    }
});
