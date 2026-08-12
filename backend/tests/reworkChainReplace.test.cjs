const assert = require("node:assert/strict");
const test = require("node:test");
const materialService = require("../services/materialService");
const MaterialController = require("../controllers/MaterialController");
const db = require("../config/connection");
const {
    buildReworkApproverEmailTemplate,
    notifyReworkApproversViaEmailPlaceholder,
} = require("../helper/reworkEmailPlaceholder");
const reworkEmailSender = require("../helper/reworkEmailSender");

// --- Chain replacement: Master Data swaps the whole MANUAL chain -----------
// Chain used throughout: Approval 1 + Approval 2 APPROVED, Master Data
// (level 3) active and grabbed by MDM-01. Requester is REQ-01.
const chainSteps = () => [
    {
        id: 8101,
        request_id: 810,
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-01",
        status: "APPROVED",
        acted_at: new Date("2026-08-01T02:00:00.000Z"),
        remark: "ok",
    },
    {
        id: 8102,
        request_id: 810,
        level: 2,
        kind: "MANUAL",
        approver_user_id: "APP-02",
        status: "APPROVED",
        acted_at: new Date("2026-08-02T02:00:00.000Z"),
        remark: "ok too",
    },
    {
        id: 8103,
        request_id: 810,
        level: 3,
        kind: "MDM",
        approver_user_id: "MDM-01",
        claimed_at: new Date("2026-08-03T02:00:00.000Z"),
        status: "WAITING",
        acted_at: null,
        remark: null,
    },
];

const planArgs = (overrides = {}) => {
    const steps = overrides.steps || chainSteps();

    return {
        steps,
        activeStep: steps[2],
        newApprovers: ["APP-07", "APP-08"],
        requesterUserId: "REQ-01",
        actorUserId: "MDM-01",
        reason: "Chain approval salah, ganti approver",
        codePrefix: "SINGLE_REQUEST",
        ...overrides,
    };
};

// ---------------------------------------------------------------------------
// buildStepChainReplacePlan — happy path
// ---------------------------------------------------------------------------

test("buildStepChainReplacePlan renumbers a new MANUAL chain and reopens Master Data behind it", () => {
    const plan = materialService.buildStepChainReplacePlan(planArgs());

    assert.deepEqual(plan.approverIds, ["APP-07", "APP-08"]);
    assert.deepEqual(plan.manualSteps, [
        {
            level: 1,
            kind: "MANUAL",
            approverUserId: "APP-07",
            status: "WAITING",
        },
        {
            level: 2,
            kind: "MANUAL",
            approverUserId: "APP-08",
            status: "WAITING",
        },
    ]);

    // Master Data moves to N+1 and reopens.
    assert.deepEqual(plan.mdmStep, {
        level: 3,
        status: "WAITING",
        acted_at: null,
        remark: null,
    });

    // The grab survives by omission: neither column is named in the patch.
    assert.equal(
        Object.prototype.hasOwnProperty.call(plan.mdmStep, "approver_user_id"),
        false
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(plan.mdmStep, "claimed_at"),
        false
    );
    assert.equal(plan._meta.mdmStep.id, 8103);
    assert.equal(plan._meta.mdmStep.approver_user_id, "MDM-01");
    assert.equal(plan._meta.mdmLevel, 3);

    assert.deepEqual(plan.header, {
        status: "Submit",
        assigned_to: "Approval 1",
        rework_stage: "Master Data",
        rework_by_user_id: "MDM-01",
        rework_at: { __sql: "NOW()" },
        rework_reason: "Chain approval salah, ganti approver",
    });
});

test("buildStepChainReplacePlan grows the chain past the old Master Data level", () => {
    const plan = materialService.buildStepChainReplacePlan(
        planArgs({ newApprovers: ["APP-07", "APP-08", "APP-09"] })
    );

    assert.deepEqual(
        plan.manualSteps.map(step => step.level),
        [1, 2, 3]
    );
    // Master Data must move up, otherwise the new level 3 collides with it.
    assert.equal(plan.mdmStep.level, 4);
    assert.equal(plan.header.assigned_to, "Approval 1");
});

// ---------------------------------------------------------------------------
// buildStepChainReplacePlan — rejections
// ---------------------------------------------------------------------------

test("buildStepChainReplacePlan refuses a rework target and a new chain together", () => {
    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({ reworkToLevel: 2 })
            ),
        error => {
            assert.equal(error.statusCode, 400);
            assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_CONFLICT");
            assert.equal(error.errors[0].fieldKey, "reworkToLevel");
            return true;
        }
    );
});

test("buildStepChainReplacePlan refuses a chain replacement raised from a MANUAL stage", () => {
    const steps = chainSteps();
    const manualActive = { ...steps[1], status: "WAITING" };

    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({
                    steps,
                    activeStep: manualActive,
                    actorUserId: "APP-02",
                })
            ),
        error => {
            assert.equal(error.statusCode, 403);
            assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_FORBIDDEN");
            return true;
        }
    );
});

test("buildStepChainReplacePlan rejects duplicate approver ids", () => {
    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({ newApprovers: ["APP-07", "APP-07"] })
            ),
        error => {
            assert.equal(error.statusCode, 400);
            assert.equal(error.code, "SINGLE_REQUEST_REWORK_APPROVER_INVALID");
            assert.match(error.message, /distinct/i);
            return true;
        }
    );
});

test("buildStepChainReplacePlan rejects the requester as his own approver", () => {
    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({ newApprovers: ["APP-07", "REQ-01"] })
            ),
        error => {
            assert.equal(error.statusCode, 400);
            assert.equal(error.code, "SINGLE_REQUEST_REWORK_APPROVER_INVALID");
            assert.match(error.message, /requester/i);
            return true;
        }
    );
});

test("buildStepChainReplacePlan rejects the Master Data claimer inside his own chain", () => {
    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({ newApprovers: ["MDM-01", "APP-08"] })
            ),
        error => {
            assert.equal(error.statusCode, 400);
            assert.equal(error.code, "SINGLE_REQUEST_REWORK_APPROVER_INVALID");
            assert.match(error.message, /master data/i);
            return true;
        }
    );
});

test("buildStepChainReplacePlan rejects empty, blank and non-array approver lists", () => {
    for (const newApprovers of [[], ["APP-07", "  "], ["APP-07", null], "APP-07", {}]) {
        assert.throws(
            () =>
                materialService.buildStepChainReplacePlan(
                    planArgs({ newApprovers })
                ),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "SINGLE_REQUEST_REWORK_APPROVER_INVALID"
                );
                return true;
            },
            `expected ${JSON.stringify(newApprovers)} to be rejected`
        );
    }
});

test("buildStepChainReplacePlan still requires a reason", () => {
    assert.throws(
        () => materialService.buildStepChainReplacePlan(planArgs({ reason: "   " })),
        /rework reason is required/i
    );
});

test("buildStepChainReplacePlan scopes its error codes to the mass prefix", () => {
    assert.throws(
        () =>
            materialService.buildStepChainReplacePlan(
                planArgs({
                    codePrefix: "MASS_REQUEST",
                    newApprovers: ["APP-07", "APP-07"],
                })
            ),
        error => {
            assert.equal(error.code, "MASS_REQUEST_REWORK_APPROVER_INVALID");
            return true;
        }
    );
});

// ---------------------------------------------------------------------------
// Mode detection + notification channel
// ---------------------------------------------------------------------------

test("isChainReplaceRequested treats absent, null and empty lists as no chain", () => {
    for (const absent of [undefined, null, []]) {
        assert.equal(materialService.isChainReplaceRequested(absent), false);
    }
    for (const present of [["APP-07"], "APP-07", {}]) {
        assert.equal(materialService.isChainReplaceRequested(present), true);
    }
});

test("normalizeReworkNotifyVia defaults to APP and uppercases known channels", () => {
    for (const absent of [undefined, null, "", "   "]) {
        assert.equal(materialService.normalizeReworkNotifyVia(absent), "APP");
    }
    assert.equal(materialService.normalizeReworkNotifyVia("app"), "APP");
    assert.equal(materialService.normalizeReworkNotifyVia(" Email "), "EMAIL");
});

test("normalizeReworkNotifyVia rejects unknown channels per request prefix", () => {
    for (const junk of ["sms", "whatsapp", 1, true, ["EMAIL"], {}]) {
        assert.throws(
            () => materialService.normalizeReworkNotifyVia(junk),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "SINGLE_REQUEST_REWORK_NOTIFY_INVALID");
                assert.equal(error.errors[0].fieldKey, "notifyVia");
                return true;
            },
            `expected ${JSON.stringify(junk)} to be rejected`
        );
    }

    assert.throws(
        () => materialService.normalizeReworkNotifyVia("sms", "MASS_REQUEST"),
        error => {
            assert.equal(error.code, "MASS_REQUEST_REWORK_NOTIFY_INVALID");
            return true;
        }
    );
});

test("buildReworkNotifyResult sends nothing on either channel", () => {
    assert.deepEqual(materialService.buildReworkNotifyResult("APP"), {
        via: "APP",
        sent: false,
        placeholder: false,
    });
    assert.deepEqual(materialService.buildReworkNotifyResult("EMAIL"), {
        via: "EMAIL",
        sent: false,
        placeholder: true,
    });
});

test("email placeholder never sends and returns TODO template strings", () => {
    assert.deepEqual(notifyReworkApproversViaEmailPlaceholder({ requestId: 810 }), {
        sent: false,
        placeholder: true,
    });

    const template = buildReworkApproverEmailTemplate({ requestId: 810 });
    assert.match(template.subject, /TODO/);
    assert.match(template.body, /TODO/);
});

test("email placeholder module pulls in no mail, network or env dependency", () => {
    const source = require("fs").readFileSync(
        require("path").join(__dirname, "../helper/reworkEmailPlaceholder.js"),
        "utf8"
    );
    assert.doesNotMatch(source, /require\(/);
    assert.doesNotMatch(source, /nodemailer|smtp|fetch\(|axios|process\.env/i);
});

// ---------------------------------------------------------------------------
// Service seam: db.connect replaced by a fake client that matches on SQL.
// ---------------------------------------------------------------------------
const connectChainStub = (
    steps,
    {
        queryLog,
        paramLog,
        stepUpdates,
        stepInserts,
        stepDeletes,
        headerUpdates,
        activeUserIds,
    }
) => async () => ({
    query: async (queryText, params = []) => {
        queryLog.push(queryText);
        paramLog.push(params);

        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
            return { rows: [], rowCount: null };
        }

        if (/FOR UPDATE OF r/.test(queryText)) {
            return {
                rows: [
                    {
                        request_id: 810,
                        request_no: "1000000810",
                        status: "Submit",
                        // The request is parked on the Master Data stage; the
                        // EMAIL path must hand this value straight back.
                        assigned_to: "Master Data",
                        ticket_type: "CREATE",
                        created_by: "REQ-01",
                        requester_user_id: "REQ-01",
                    },
                ],
            };
        }

        if (/FOR UPDATE OF s/.test(queryText)) {
            return { rows: steps };
        }

        if (/mst_page_access/i.test(queryText)) {
            return { rows: [{ exists: 1 }], rowCount: 1 };
        }

        if (/FROM mst_user mu\s+WHERE mu\.user_id = ANY/.test(queryText)) {
            const requested = params[0] || [];
            const rows = requested
                .filter(id => activeUserIds.includes(id))
                .map(id => ({
                    user_id: id,
                    email: `${String(id).toLowerCase()}@kpn-corp.com`,
                }));
            return { rows, rowCount: rows.length };
        }

        if (/DELETE FROM mat_single_request_approval_step/.test(queryText)) {
            stepDeletes.push({ queryText, params });
            return { rows: [], rowCount: 2 };
        }

        if (/INSERT INTO mat_single_request_approval_step/.test(queryText)) {
            stepInserts.push({ queryText, params });
            return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
            stepUpdates.push({ queryText, params });
            return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_single_request\b/.test(queryText)) {
            headerUpdates.push({ queryText, params });
            return { rows: [], rowCount: 1 };
        }

        // Every request action also appends to the request comment history; the
        // stub answers that write the way the database would.
        if (/mat_request_comment/.test(queryText)) {
            return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
});

const newChainRecorder = (activeUserIds = ["APP-07", "APP-08"]) => ({
    queryLog: [],
    paramLog: [],
    stepUpdates: [],
    stepInserts: [],
    stepDeletes: [],
    headerUpdates: [],
    activeUserIds,
});

test("requestSingleRequestRework replaces the chain and keeps the Master Data grab", async () => {
    const originalConnect = db.connect;
    const recorder = newChainRecorder();
    db.connect = connectChainStub(chainSteps(), recorder);

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Approver chain salah",
            newApprovers: ["APP-07", "APP-08"],
        });

        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Approval 1");
        assert.equal(result.stage, "Master Data");
        assert.deepEqual(result.notify, {
            via: "APP",
            sent: false,
            placeholder: false,
        });

        // MANUAL rows are dropped before anything is renumbered.
        assert.equal(recorder.stepDeletes.length, 1);
        assert.deepEqual(recorder.stepDeletes[0].params, [810, "MANUAL"]);

        // Exactly one step UPDATE: the Master Data row moving to level 3.
        assert.equal(recorder.stepUpdates.length, 1);
        assert.equal(recorder.stepUpdates[0].params[0], 8103);
        assert.ok(recorder.stepUpdates[0].params.includes(3));
        assert.ok(recorder.stepUpdates[0].params.includes("WAITING"));
        // The grab is never named, so it survives.
        assert.doesNotMatch(
            recorder.stepUpdates[0].queryText,
            /approver_user_id|claimed_at/
        );

        // Then the new chain is inserted, ordered 1..N.
        assert.equal(recorder.stepInserts.length, 2);
        assert.deepEqual(recorder.stepInserts[0].params, [
            810,
            1,
            "MANUAL",
            "APP-07",
            "WAITING",
        ]);
        assert.deepEqual(recorder.stepInserts[1].params, [
            810,
            2,
            "MANUAL",
            "APP-08",
            "WAITING",
        ]);

        // Delete -> Master Data renumber -> insert; any other order collides
        // with UNIQUE (request_id, level).
        const deleteAt = recorder.queryLog.findIndex(sql =>
            /DELETE FROM mat_single_request_approval_step/.test(sql)
        );
        const updateAt = recorder.queryLog.findIndex(sql =>
            /UPDATE mat_single_request_approval_step/.test(sql)
        );
        const insertAt = recorder.queryLog.findIndex(sql =>
            /INSERT INTO mat_single_request_approval_step/.test(sql)
        );
        assert.ok(deleteAt < updateAt && updateAt < insertAt);

        assert.equal(recorder.headerUpdates.length, 1);
        assert.ok(recorder.headerUpdates[0].params.includes("Submit"));
        assert.ok(recorder.headerUpdates[0].params.includes("Approval 1"));
        assert.ok(recorder.headerUpdates[0].params.includes("Master Data"));
        assert.equal(
            recorder.headerUpdates[0].params.includes("Requester"),
            false
        );
        assert.ok(recorder.queryLog.includes("COMMIT"));
    } finally {
        db.connect = originalConnect;
    }
});

// "Via email" is CORRESPONDENCE ONLY (product decision 2026-08-07): the person
// the dialog picks is the RECIPIENT of a mail, not a replacement approver. The
// request is not reassigned at all — it comes out of the call exactly as it went
// in, still Submit and still claimed at Master Data.
test("requestSingleRequestRework on the EMAIL channel only mails — it never reassigns", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const recorder = newChainRecorder();
    const sendCalls = [];

    db.connect = connectChainStub(chainSteps(), recorder);
    reworkEmailSender.sendReworkApproverEmail = async (client, ctx) => {
        sendCalls.push({
            ctx,
            committed: recorder.queryLog.includes("COMMIT"),
        });
        return { via: "EMAIL", sent: true };
    };

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Minta klarifikasi lewat email",
            newApprovers: ["APP-07", "APP-08"],
            notifyVia: "EMAIL",
            emailSubject: "Review Request Material 1000000810",
            emailBody: "Mohon direview.",
        });

        // The response mirrors the request AS IT STILL STANDS.
        assert.equal(result.emailOnly, true);
        assert.equal(result.stage, "Master Data");
        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Master Data");
        assert.deepEqual(result.notify, { via: "EMAIL", sent: true });

        // Zero mutations — on the recorders and on the raw query log.
        assert.equal(recorder.stepDeletes.length, 0);
        assert.equal(recorder.stepInserts.length, 0);
        assert.equal(recorder.stepUpdates.length, 0);
        assert.equal(recorder.headerUpdates.length, 0);
        for (const sql of recorder.queryLog) {
            assert.doesNotMatch(
                sql,
                /^\s*(INSERT|UPDATE|DELETE)\b/i,
                `no statement may write on this path, got: ${sql}`
            );
        }
        // The reason is accepted and dropped: it reaches no statement, not even
        // as a bound parameter.
        assert.equal(
            recorder.paramLog
                .flat()
                .includes("Minta klarifikasi lewat email"),
            false
        );

        // The mail is the only effect, and it leaves after the (read-only)
        // transaction closes.
        assert.equal(sendCalls.length, 1);
        assert.equal(sendCalls[0].committed, true);
        assert.equal(sendCalls[0].ctx.requestKind, "SINGLE");
        assert.equal(sendCalls[0].ctx.requestId, 810);
        assert.equal(sendCalls[0].ctx.toUserId, "APP-07");
        assert.equal(sendCalls[0].ctx.toEmail, "app-07@kpn-corp.com");
        assert.equal(
            sendCalls[0].ctx.subject,
            "Review Request Material 1000000810"
        );
        assert.equal(sendCalls[0].ctx.body, "Mohon direview.");
        assert.ok(recorder.queryLog.includes("COMMIT"));
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// Correspondence-only does NOT mean unvalidated: the recipient still has to be
// a real ACTIVE account, and the check runs before anything is sent.
test("requestSingleRequestRework still rejects an inactive EMAIL recipient, and mails nobody", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    // APP-08 is missing from mst_user (or disabled).
    const recorder = newChainRecorder(["APP-07"]);
    let sendCalls = 0;

    db.connect = connectChainStub(chainSteps(), recorder);
    reworkEmailSender.sendReworkApproverEmail = async () => {
        sendCalls += 1;
        return { via: "EMAIL", sent: true };
    };

    try {
        await assert.rejects(
            materialService.requestSingleRequestRework({
                requestId: 810,
                actorUserId: "MDM-01",
                actorUsername: "master.data.one",
                reason: "Minta klarifikasi lewat email",
                newApprovers: ["APP-07", "APP-08"],
                notifyVia: "EMAIL",
                emailSubject: "Review Request Material 1000000810",
                emailBody: "Mohon direview.",
            }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "SINGLE_REQUEST_REWORK_APPROVER_INVALID"
                );
                assert.match(error.message, /APP-08/);
                return true;
            }
        );

        assert.equal(sendCalls, 0);
        assert.equal(recorder.stepDeletes.length, 0);
        assert.equal(recorder.stepInserts.length, 0);
        assert.equal(recorder.stepUpdates.length, 0);
        assert.equal(recorder.headerUpdates.length, 0);
        assert.ok(recorder.queryLog.includes("ROLLBACK"));
        assert.equal(recorder.queryLog.includes("COMMIT"), false);
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// Superseded by 20260807_rework_email_thread: the EMAIL channel is a real send
// now, so it needs the (editable) subject + body and no longer reports the
// inert placeholder. Refused before the transaction opens — see
// reworkEmailThread.test.cjs for the send path itself.
test("requestSingleRequestRework refuses the EMAIL channel without mail content", async () => {
    const originalConnect = db.connect;
    const recorder = newChainRecorder();
    db.connect = connectChainStub(chainSteps(), recorder);

    try {
        await assert.rejects(
            materialService.requestSingleRequestRework({
                requestId: 810,
                actorUserId: "MDM-01",
                actorUsername: "master.data.one",
                reason: "Approver chain salah",
                newApprovers: ["APP-07", "APP-08"],
                notifyVia: "email",
            }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "SINGLE_REQUEST_REWORK_EMAIL_CONTENT_REQUIRED"
                );
                return true;
            }
        );

        assert.equal(recorder.queryLog.length, 0);
    } finally {
        db.connect = originalConnect;
    }
});

test("requestSingleRequestRework rejects an unknown notify channel before touching the DB", async () => {
    const originalConnect = db.connect;
    const recorder = newChainRecorder();
    db.connect = connectChainStub(chainSteps(), recorder);

    try {
        await assert.rejects(
            materialService.requestSingleRequestRework({
                requestId: 810,
                actorUserId: "MDM-01",
                actorUsername: "master.data.one",
                reason: "Approver chain salah",
                newApprovers: ["APP-07", "APP-08"],
                notifyVia: "SMS",
            }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(error.code, "SINGLE_REQUEST_REWORK_NOTIFY_INVALID");
                return true;
            }
        );

        assert.equal(recorder.queryLog.length, 0);
    } finally {
        db.connect = originalConnect;
    }
});

test("requestSingleRequestRework rolls back an inactive replacement approver", async () => {
    const originalConnect = db.connect;
    // APP-08 is missing from mst_user (or disabled).
    const recorder = newChainRecorder(["APP-07"]);
    db.connect = connectChainStub(chainSteps(), recorder);

    try {
        await assert.rejects(
            materialService.requestSingleRequestRework({
                requestId: 810,
                actorUserId: "MDM-01",
                actorUsername: "master.data.one",
                reason: "Approver chain salah",
                newApprovers: ["APP-07", "APP-08"],
            }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "SINGLE_REQUEST_REWORK_APPROVER_INVALID"
                );
                assert.match(error.message, /APP-08/);
                return true;
            }
        );

        assert.equal(recorder.stepDeletes.length, 0);
        assert.equal(recorder.stepInserts.length, 0);
        assert.equal(recorder.stepUpdates.length, 0);
        assert.equal(recorder.headerUpdates.length, 0);
        assert.ok(recorder.queryLog.includes("ROLLBACK"));
        assert.equal(recorder.queryLog.includes("COMMIT"), false);
    } finally {
        db.connect = originalConnect;
    }
});

test("requestSingleRequestRework without a chain still returns an APP notify block", async () => {
    const originalConnect = db.connect;
    const recorder = newChainRecorder();
    db.connect = connectChainStub(chainSteps(), recorder);

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Requester salah isi",
        });

        // Unchanged rework-to-requester behaviour.
        assert.equal(result.status, "Rework");
        assert.equal(result.assigned_to, "Requester");
        assert.deepEqual(result.notify, {
            via: "APP",
            sent: false,
            placeholder: false,
        });
        assert.equal(recorder.stepDeletes.length, 0);
        assert.equal(recorder.stepInserts.length, 0);
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Mass request: same replacement, fanned out over every item.
// ---------------------------------------------------------------------------

const connectMassChainStub = ({
    queryLog,
    stepDeletes,
    stepInserts,
    stepUpdates,
    headerUpdates,
}) => {
    const massSteps = chainSteps().map(step => ({
        ...step,
        item_id: 9001,
        request_id: undefined,
    }));

    return async () => ({
        query: async (queryText, params = []) => {
            queryLog.push(queryText);

            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
                return { rows: [], rowCount: null };
            }

            if (/FOR UPDATE OF i/.test(queryText)) {
                return {
                    rows: [
                        {
                            id: 9001,
                            status: "Submit",
                            created_by: "REQ-01",
                            request_no: "3000000012",
                            // Parked on Master Data; the EMAIL path hands this
                            // value straight back.
                            assigned_to: "Master Data",
                        },
                    ],
                };
            }

            if (/FOR UPDATE OF s/.test(queryText)) {
                return { rows: massSteps };
            }

            if (/mst_page_access/i.test(queryText)) {
                return { rows: [{ exists: 1 }], rowCount: 1 };
            }

            if (/FROM mst_user mu\s+WHERE mu\.user_id = ANY/.test(queryText)) {
                const rows = (params[0] || []).map(id => ({
                    user_id: id,
                    email: `${String(id).toLowerCase()}@kpn-corp.com`,
                }));
                return { rows, rowCount: rows.length };
            }

            if (/SELECT i\.id\s+FROM mat_mass_request_item i/.test(queryText)) {
                return {
                    rows: [{ id: 9001 }, { id: 9002 }],
                    rowCount: 2,
                };
            }

            if (
                /DELETE FROM mat_mass_request_item_approval_step/.test(queryText)
            ) {
                stepDeletes.push({ queryText, params });
                return { rows: [], rowCount: 4 };
            }

            if (
                /INSERT INTO mat_mass_request_item_approval_step/.test(queryText)
            ) {
                stepInserts.push({ queryText, params });
                return { rows: [], rowCount: 1 };
            }

            if (
                /UPDATE mat_mass_request_item_approval_step/.test(queryText)
            ) {
                stepUpdates.push({ queryText, params });
                return { rows: [], rowCount: 2 };
            }

            if (/UPDATE mat_mass_request_item\b/.test(queryText)) {
                headerUpdates.push({ queryText, params });
                return { rows: [{ id: 9001 }, { id: 9002 }], rowCount: 2 };
            }

            // Every request action also appends to the request comment history; the
            // stub answers that write the way the database would.
            if (/mat_request_comment/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
        release: () => {},
    });
};

const newMassChainRecorder = () => ({
    queryLog: [],
    stepDeletes: [],
    stepInserts: [],
    stepUpdates: [],
    headerUpdates: [],
});

test("requestMassRequestRework replaces the chain on every item of the batch", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const recorder = newMassChainRecorder();
    let sendCalls = 0;

    db.connect = connectMassChainStub(recorder);
    // No test process may open an SMTP socket, and reassignment must not mail.
    reworkEmailSender.sendReworkApproverEmail = async () => {
        sendCalls += 1;
        return { via: "EMAIL", sent: true };
    };

    try {
        // "Via aplikasi": the reassigning channel, unchanged.
        const result = await materialService.requestMassRequestRework({
            massRequestId: 900,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Batch salah approver",
            newApprovers: ["APP-07", "APP-08"],
            notifyVia: "APP",
        });

        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Approval 1");
        assert.equal(result.updated_count, 2);
        assert.deepEqual(result.notify, {
            via: "APP",
            sent: false,
            placeholder: false,
        });
        assert.equal(result.emailOnly, undefined);
        assert.equal(sendCalls, 0);

        // One batch-wide DELETE, one batch-wide Master Data renumber, then the
        // new chain inserted per item (2 items x 2 levels).
        assert.equal(recorder.stepDeletes.length, 1);
        assert.deepEqual(recorder.stepDeletes[0].params, [900, "MANUAL"]);
        assert.equal(recorder.stepUpdates.length, 1);
        assert.deepEqual(recorder.stepUpdates[0].params.slice(0, 2), [900, 3]);
        assert.doesNotMatch(
            recorder.stepUpdates[0].queryText,
            /approver_user_id|claimed_at/
        );
        assert.equal(recorder.stepInserts.length, 4);
        assert.deepEqual(
            recorder.stepInserts.map(insert => insert.params.slice(0, 2)),
            [
                [9001, 1],
                [9001, 2],
                [9002, 1],
                [9002, 2],
            ]
        );

        assert.equal(recorder.headerUpdates.length, 1);
        assert.ok(recorder.headerUpdates[0].params.includes("Submit"));
        assert.ok(recorder.headerUpdates[0].params.includes("Approval 1"));
        assert.ok(recorder.queryLog.includes("COMMIT"));
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// Same correspondence-only contract as the single request, fanned out over
// nothing: the batch is not touched at all.
test("requestMassRequestRework on the EMAIL channel only mails — it never reassigns", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const recorder = newMassChainRecorder();
    const sendCalls = [];

    db.connect = connectMassChainStub(recorder);
    reworkEmailSender.sendReworkApproverEmail = async (client, ctx) => {
        sendCalls.push({
            ctx,
            committed: recorder.queryLog.includes("COMMIT"),
        });
        return { via: "EMAIL", sent: true };
    };

    try {
        const result = await materialService.requestMassRequestRework({
            massRequestId: 900,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Minta klarifikasi lewat email",
            newApprovers: ["APP-07", "APP-08"],
            notifyVia: "EMAIL",
            emailSubject: "Review Request Material Massal 3000000012",
            emailBody: "Mohon direview.",
        });

        assert.equal(result.emailOnly, true);
        assert.equal(result.stage, "Master Data");
        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Master Data");
        // Nothing was written, so nothing was updated.
        assert.equal(result.updated_count, 0);
        assert.deepEqual(result.notify, { via: "EMAIL", sent: true });

        assert.equal(recorder.stepDeletes.length, 0);
        assert.equal(recorder.stepInserts.length, 0);
        assert.equal(recorder.stepUpdates.length, 0);
        assert.equal(recorder.headerUpdates.length, 0);
        for (const sql of recorder.queryLog) {
            assert.doesNotMatch(
                sql,
                /^\s*(INSERT|UPDATE|DELETE)\b/i,
                `no statement may write on this path, got: ${sql}`
            );
        }

        assert.equal(sendCalls.length, 1);
        assert.equal(sendCalls[0].committed, true);
        assert.equal(sendCalls[0].ctx.requestKind, "MASS");
        assert.equal(sendCalls[0].ctx.requestId, 900);
        assert.equal(sendCalls[0].ctx.requestNo, "3000000012");
        assert.equal(sendCalls[0].ctx.toUserId, "APP-07");
        assert.equal(sendCalls[0].ctx.toEmail, "app-07@kpn-corp.com");
        assert.ok(recorder.queryLog.includes("COMMIT"));
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// ---------------------------------------------------------------------------
// Controller wiring
// ---------------------------------------------------------------------------

test("rework controllers forward the new chain, its alias and the notify channel", () => {
    for (const source of [
        MaterialController.requestSingleRequestRework.toString(),
        MaterialController.requestMassRequestRework.toString(),
    ]) {
        assert.match(
            source,
            /req\.body\?\.newApprovers\s*\?\?\s*req\.body\?\.newApproverIds\s*\?\?\s*null/
        );
        assert.match(source, /req\.body\?\.notifyVia\s*\?\?\s*null/);
        assert.match(source, /code: error\.code/);
        assert.match(source, /payload\.errors = error\.errors/);
    }
});
