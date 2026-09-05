const assert = require("node:assert/strict");
const test = require("node:test");
const materialService = require("../services/materialService");
const db = require("../config/connection");
const {
    buildReworkEmailGreeting,
    buildSingleReworkEmailTemplate,
    buildMassReworkEmailTemplate,
    ensureSubjectToken,
    extractReworkEmailToken,
} = require("../helper/reworkEmailTemplate");
const reworkEmailSender = require("../helper/reworkEmailSender");
const reworkEmailInboundService = require("../services/reworkEmailInboundService");

// Rework e-mail thread (migration 20260807_rework_email_thread.sql).
//
// NOTHING here touches a network. nodemailer is replaced by an injected fake
// transport, pg by a db.connect stub that matches on SQL, and the IMAP half is
// exercised only through its pure helpers — the poller's own socket work is not
// something a test may open.

const singleRequestRow = () => ({
    id: 810,
    ticket_number: "1000000810",
    ticket_type: "Create",
    material_description: "BOLT HEX M10",
    plant_code: "EU73",
    sloc_code: "ST01",
    uom: "PC",
    long_text_1: "BOLT HEX M10 X 30MM ",
    long_text_2: "GALVANIZED DIN933 ",
    long_text_3: "GRADE 8.8",
});

const massItemRows = () => [
    {
        id: 9001,
        item_no: 1,
        request_no: "3000000012",
        ticket_type: "Create",
        material_description: "BOLT HEX M10",
        uom: "PC",
        plant_code: "EU73",
        sloc_code: "ST01",
        po_text: "BOLT HEX M10 X 30MM",
        spesifikasi_tambahan: "GALVANIZED",
    },
    {
        id: 9002,
        item_no: 2,
        request_no: "3000000013",
        ticket_type: "Create",
        material_description: "NUT HEX M10",
        uom: "PC",
        plant_code: "EU73",
        sloc_code: "ST01",
        po_text: "NUT HEX M10",
        spesifikasi_tambahan: null,
    },
];

// ---------------------------------------------------------------------------
// Template composer
// ---------------------------------------------------------------------------

test("buildSingleReworkEmailTemplate composes the request into a tokenised draft", () => {
    const { subject, body, requestNo } = buildSingleReworkEmailTemplate(
        singleRequestRow()
    );

    assert.equal(requestNo, "1000000810");
    assert.match(subject, /\[VMS#1000000810\]/);

    // Every field the approver needs to know what he is being asked about.
    assert.match(body, /^Kepada Yth\. Approver,/);
    assert.match(body, /No\. Request\s+: 1000000810/);
    assert.match(body, /Jenis Ticket\s+: Create/);
    assert.match(body, /Deskripsi Material\s+: BOLT HEX M10/);
    assert.match(body, /Plant \/ Sloc\s+: EU73 \/ ST01/);
    assert.match(body, /Base UOM\s+: PC/);
    // long_text_1..3 concatenate separator-less, like the SAP staging payload.
    assert.match(
        body,
        /PO Text \/ Spesifikasi\s+: BOLT HEX M10 X 30MM GALVANIZED DIN933 GRADE 8\.8/
    );

    // The closing reply instruction (the Catatan editing note was dropped by
    // product decision 2026-08-07).
    assert.match(body, /Mohon membalas email ini/);
    assert.doesNotMatch(body, /dapat disunting oleh Master Data/);
});

test("buildSingleReworkEmailTemplate degrades to dashes on an empty request", () => {
    const { body } = buildSingleReworkEmailTemplate({
        ticket_number: "1000000999",
    });

    assert.match(body, /Deskripsi Material\s+: -/);
    assert.match(body, /Plant \/ Sloc\s+: -/);
    assert.match(body, /PO Text \/ Spesifikasi\s+: -/);
});

test("buildMassReworkEmailTemplate lists every item and threads on the first one", () => {
    const { subject, body, requestNo } = buildMassReworkEmailTemplate(
        massItemRows()
    );

    // Thread identity is the FIRST item's request_no — the row mass rework
    // locks FOR UPDATE and gates the whole batch on.
    assert.equal(requestNo, "3000000012");
    assert.match(subject, /\[VMS#3000000012\]/);
    assert.doesNotMatch(subject, /3000000013/);

    assert.match(body, /Jumlah Item\s+: 2/);
    // Uniform batch -> one plant line, no per-item repetition.
    assert.match(body, /Plant \/ Sloc\s+: EU73 \/ ST01/);

    // item_no, description and uom on the numbered line, per the spec.
    assert.match(body, /^1\. BOLT HEX M10 \(UOM: PC\)$/m);
    assert.match(body, /^2\. NUT HEX M10 \(UOM: PC\)$/m);
    assert.match(body, /No\. Item\s+: 3000000012/);
    assert.match(body, /No\. Item\s+: 3000000013/);
    assert.match(body, /PO Text \/ Spesifikasi: BOLT HEX M10 X 30MM - GALVANIZED/);
});

test("buildMassReworkEmailTemplate moves plant onto the items when the batch is mixed", () => {
    const items = massItemRows();
    items[1].plant_code = "EU74";

    const { body } = buildMassReworkEmailTemplate(items);

    assert.match(body, /Plant \/ Sloc\s+: \(berbeda per item\)/);
    assert.match(body, /^ {3}Plant \/ Sloc\s+: EU73 \/ ST01$/m);
    assert.match(body, /^ {3}Plant \/ Sloc\s+: EU74 \/ ST01$/m);
});

// ---------------------------------------------------------------------------
// Greeting: the picked approver by name, whenever there is one
// ---------------------------------------------------------------------------

test("buildReworkEmailGreeting names the approver, or falls back to the generic line", () => {
    assert.equal(
        buildReworkEmailGreeting("Budi Santoso"),
        "Kepada Yth. Budi Santoso,"
    );
    // Trimmed, so a padded fullname column never lands as "Kepada Yth.  Budi ,".
    assert.equal(
        buildReworkEmailGreeting("  Budi Santoso  "),
        "Kepada Yth. Budi Santoso,"
    );

    // Every way of having no name means the same thing to the composer.
    for (const empty of ["", "   ", null, undefined]) {
        assert.equal(
            buildReworkEmailGreeting(empty),
            "Kepada Yth. Approver,",
            `expected ${JSON.stringify(empty)} to keep the generic greeting`
        );
    }
});

test("both composers greet by name and change nothing else", () => {
    const single = buildSingleReworkEmailTemplate(singleRequestRow(), {
        approverName: "  Budi Santoso  ",
    });
    const mass = buildMassReworkEmailTemplate(massItemRows(), {
        approverName: "Budi Santoso",
    });

    assert.match(single.body, /^Kepada Yth\. Budi Santoso,/);
    assert.match(mass.body, /^Kepada Yth\. Budi Santoso,/);

    // Name injection is the ONLY difference: the field block, the item list and
    // the closing are byte-for-byte what they were without a name.
    assert.equal(
        single.body.replace(/^Kepada Yth\. Budi Santoso,/, "Kepada Yth. Approver,"),
        buildSingleReworkEmailTemplate(singleRequestRow()).body
    );
    assert.equal(
        mass.body.replace(/^Kepada Yth\. Budi Santoso,/, "Kepada Yth. Approver,"),
        buildMassReworkEmailTemplate(massItemRows()).body
    );

    // A blank name is not a name.
    assert.match(
        buildSingleReworkEmailTemplate(singleRequestRow(), { approverName: "   " })
            .body,
        /^Kepada Yth\. Approver,/
    );
    assert.match(
        buildMassReworkEmailTemplate(massItemRows(), { approverName: null }).body,
        /^Kepada Yth\. Approver,/
    );
});

// The two draft reads, against a pg stub that matches on SQL: the request read
// itself, and the optional mst_user lookup the approverUserId query param adds.
const templateConnectStub = ({ fullname } = {}) => {
    const state = { queries: [] };

    state.connect = async () => ({
        query: async (queryText, params = []) => {
            state.queries.push({ queryText, params });

            if (/FROM mat_single_request r/.test(queryText)) {
                return { rows: [singleRequestRow()] };
            }

            if (/FROM mat_mass_request_item i/.test(queryText)) {
                return {
                    rows: massItemRows().map(item => ({
                        ...item,
                        approval_steps: [],
                    })),
                };
            }

            if (/FROM mst_user mu\s+WHERE mu\.user_id = \$1/.test(queryText)) {
                // fullname undefined => the id names no ACTIVE row at all.
                return fullname === undefined
                    ? { rows: [], rowCount: 0 }
                    : { rows: [{ fullname }], rowCount: 1 };
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

    return state;
};

const approverLookups = state =>
    state.queries.filter(({ queryText }) =>
        /FROM mst_user mu\s+WHERE mu\.user_id = \$1/.test(queryText)
    );

test("getSingleRequestReworkEmailTemplate greets the approver the dialog picked", async () => {
    const originalConnect = db.connect;
    const stub = templateConnectStub({ fullname: "Budi Santoso" });
    db.connect = stub.connect;

    try {
        const { subject, body } =
            await materialService.getSingleRequestReworkEmailTemplate({
                requestId: 810,
                approverUserId: "APP-07",
            });

        assert.match(body, /^Kepada Yth\. Budi Santoso,/);
        // The rest of the draft is untouched by the name.
        assert.match(subject, /\[VMS#1000000810\]/);
        assert.match(body, /No\. Request\s+: 1000000810/);

        assert.equal(approverLookups(stub).length, 1);
        assert.deepEqual(approverLookups(stub)[0].params, ["APP-07"]);
        // ACTIVE only, exactly like the submit-time approver check.
        assert.match(approverLookups(stub)[0].queryText, /mu\.is_active = true/);
    } finally {
        db.connect = originalConnect;
    }
});

test("getSingleRequestReworkEmailTemplate asks nothing when no approver was picked", async () => {
    const originalConnect = db.connect;
    const stub = templateConnectStub({ fullname: "Budi Santoso" });
    db.connect = stub.connect;

    try {
        const { body } =
            await materialService.getSingleRequestReworkEmailTemplate({
                requestId: 810,
            });

        assert.match(body, /^Kepada Yth\. Approver,/);
        // No id to resolve => no round trip at all.
        assert.equal(approverLookups(stub).length, 0);
    } finally {
        db.connect = originalConnect;
    }
});

test("getSingleRequestReworkEmailTemplate keeps the generic greeting on an unusable id", async () => {
    const originalConnect = db.connect;

    // No active row, then an account with a blank fullname: both are "no name".
    for (const options of [{}, { fullname: "   " }, { fullname: null }]) {
        const stub = templateConnectStub(options);
        db.connect = stub.connect;

        try {
            const { body } =
                await materialService.getSingleRequestReworkEmailTemplate({
                    requestId: 810,
                    approverUserId: "APP-99",
                });

            assert.match(
                body,
                /^Kepada Yth\. Approver,/,
                `expected ${JSON.stringify(options)} to fall back`
            );
        } finally {
            db.connect = originalConnect;
        }
    }
});

test("getMassRequestReworkEmailTemplate greets the approver the dialog picked", async () => {
    const originalConnect = db.connect;
    const stub = templateConnectStub({ fullname: "Budi Santoso" });
    db.connect = stub.connect;

    try {
        const { subject, body } =
            await materialService.getMassRequestReworkEmailTemplate({
                massRequestId: 900,
                approverUserId: "APP-07",
            });

        assert.match(body, /^Kepada Yth\. Budi Santoso,/);
        assert.match(subject, /\[VMS#3000000012\]/);
        assert.match(body, /Jumlah Item\s+: 2/);

        assert.equal(approverLookups(stub).length, 1);
        assert.deepEqual(approverLookups(stub)[0].params, ["APP-07"]);
    } finally {
        db.connect = originalConnect;
    }
});

test("getMassRequestReworkEmailTemplate asks nothing when no approver was picked", async () => {
    const originalConnect = db.connect;
    const stub = templateConnectStub({ fullname: "Budi Santoso" });
    db.connect = stub.connect;

    try {
        const { body } = await materialService.getMassRequestReworkEmailTemplate(
            { massRequestId: 900, approverUserId: "   " }
        );

        assert.match(body, /^Kepada Yth\. Approver,/);
        assert.equal(approverLookups(stub).length, 0);
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Thread token
// ---------------------------------------------------------------------------

test("ensureSubjectToken appends the token only when it is missing", () => {
    assert.equal(
        ensureSubjectToken("Review request", "1000000810"),
        "Review request [VMS#1000000810]"
    );

    // Already tokenised -> untouched, even mid-subject, so a hand-corrected
    // subject never ends up carrying two tokens.
    assert.equal(
        ensureSubjectToken("Re: [VMS#1000000810] review", "1000000810"),
        "Re: [VMS#1000000810] review"
    );

    // A subject carrying SOME token is left alone: re-tokenising would fork the
    // thread rather than fix it.
    assert.equal(
        ensureSubjectToken("Review [VMS#1000000999]", "1000000810"),
        "Review [VMS#1000000999]"
    );

    assert.equal(ensureSubjectToken("   ", "1000000810"), "[VMS#1000000810]");
    assert.equal(ensureSubjectToken(null, "1000000810"), "[VMS#1000000810]");
});

test("extractReworkEmailToken reads the token back out of a reply subject", () => {
    assert.equal(
        extractReworkEmailToken("Re: Review Request Material [VMS#1000000810]"),
        "1000000810"
    );
    assert.equal(
        extractReworkEmailToken("RE: FW: [VMS#3000000012] mohon dicek"),
        "3000000012"
    );
    assert.equal(extractReworkEmailToken("Re: rapat mingguan"), null);
    assert.equal(extractReworkEmailToken(""), null);
    assert.equal(extractReworkEmailToken(undefined), null);
});

// ---------------------------------------------------------------------------
// emailSubject / emailBody validation
// ---------------------------------------------------------------------------

test("assertReworkEmailContent requires both fields on the EMAIL channel", () => {
    const blanks = [
        { emailSubject: null, emailBody: null },
        { emailSubject: "Review", emailBody: "   " },
        { emailSubject: "  ", emailBody: "Mohon direview" },
        { emailSubject: 12, emailBody: "Mohon direview" },
    ];

    for (const body of blanks) {
        assert.throws(
            () =>
                materialService.assertReworkEmailContent(
                    "EMAIL",
                    body,
                    "SINGLE_REQUEST"
                ),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "SINGLE_REQUEST_REWORK_EMAIL_CONTENT_REQUIRED"
                );
                assert.ok(error.errors.length > 0);
                return true;
            },
            `expected ${JSON.stringify(body)} to be rejected`
        );
    }

    assert.throws(
        () =>
            materialService.assertReworkEmailContent(
                "EMAIL",
                {},
                "MASS_REQUEST"
            ),
        error => {
            assert.equal(
                error.code,
                "MASS_REQUEST_REWORK_EMAIL_CONTENT_REQUIRED"
            );
            return true;
        }
    );
});

test("assertReworkEmailContent trims the subject, keeps the body, ignores APP", () => {
    assert.deepEqual(
        materialService.assertReworkEmailContent("EMAIL", {
            emailSubject: "  Review request [VMS#1000000810]  ",
            emailBody: "Kepada Yth. Approver,\n\nMohon direview.\n",
        }),
        {
            emailSubject: "Review request [VMS#1000000810]",
            // The body keeps the editor's own layout — a trailing newline is
            // formatting, not whitespace to eat.
            emailBody: "Kepada Yth. Approver,\n\nMohon direview.\n",
        }
    );

    // APP has nothing to send, so it never demands content.
    assert.equal(materialService.assertReworkEmailContent("APP", {}), null);
    assert.equal(
        materialService.assertReworkEmailContent("APP", {
            emailSubject: "x",
            emailBody: "y",
        }),
        null
    );
});

test("requestMassRequestRework refuses the EMAIL channel before opening a transaction", async () => {
    const originalConnect = db.connect;
    let connected = false;
    db.connect = async () => {
        connected = true;
        throw new Error("the DB must not be touched");
    };

    try {
        await assert.rejects(
            materialService.requestMassRequestRework({
                massRequestId: 900,
                actorUserId: "MDM-01",
                actorUsername: "master.data.one",
                reason: "Batch salah approver",
                newApprovers: ["APP-07"],
                notifyVia: "EMAIL",
                emailSubject: "Review",
                emailBody: "   ",
            }),
            error => {
                assert.equal(error.statusCode, 400);
                assert.equal(
                    error.code,
                    "MASS_REQUEST_REWORK_EMAIL_CONTENT_REQUIRED"
                );
                return true;
            }
        );

        assert.equal(connected, false);
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Sender: fake transport + fake pg client, so nothing leaves the process.
// ---------------------------------------------------------------------------

const fakePgClient = () => {
    const inserts = [];
    return {
        inserts,
        query: async (queryText, params = []) => {
            if (/INSERT INTO mat_rework_email\b/.test(queryText)) {
                inserts.push(params);
                return { rows: [{ id: 501 }], rowCount: 1 };
            }
            // Every request action also appends to the request comment history; the
            // stub answers that write the way the database would.
            if (/mat_request_comment/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
    };
};

test("sendReworkApproverEmail records a SENT row and reports sent:true", async () => {
    const client = fakePgClient();
    const sent = [];
    const transport = {
        sendMail: async message => {
            sent.push(message);
            return { messageId: "<vms-1@kpndomain.com>" };
        },
    };

    const notify = await reworkEmailSender.sendReworkApproverEmail(
        client,
        {
            requestKind: "SINGLE",
            requestId: 810,
            requestNo: "1000000810",
            subject: "Review request",
            body: "Mohon direview.",
            toEmail: "approver@kpn-corp.com",
            toUserId: "APP-07",
            sentByUserId: "MDM-01",
        },
        { transport }
    );

    assert.deepEqual(notify, { via: "EMAIL", sent: true });

    // The token is re-applied on the way out, so a subject the editor stripped
    // still threads.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "Review request [VMS#1000000810]");
    assert.equal(sent[0].to, "approver@kpn-corp.com");
    assert.equal(sent[0].text, "Mohon direview.");
    assert.equal(sent[0].html, undefined);

    assert.equal(client.inserts.length, 1);
    assert.deepEqual(client.inserts[0], [
        "SINGLE",
        810,
        "<vms-1@kpndomain.com>",
        "Review request [VMS#1000000810]",
        "Mohon direview.",
        "approver@kpn-corp.com",
        "APP-07",
        "MDM-01",
        "SENT",
        null,
    ]);
});

test("sendReworkApproverEmail records a FAILED row and never throws", async () => {
    const client = fakePgClient();
    const transport = {
        sendMail: async () => {
            throw new Error("ECONNREFUSED mail.kpndomain.com:465");
        },
    };

    const notify = await reworkEmailSender.sendReworkApproverEmail(
        client,
        {
            requestKind: "MASS",
            requestId: 900,
            requestNo: "3000000012",
            subject: "Review batch [VMS#3000000012]",
            body: "Mohon direview.",
            toEmail: "approver@kpn-corp.com",
            toUserId: "APP-07",
            sentByUserId: "MDM-01",
        },
        { transport }
    );

    assert.equal(notify.via, "EMAIL");
    assert.equal(notify.sent, false);
    assert.match(notify.error, /ECONNREFUSED/);

    assert.equal(client.inserts.length, 1);
    // message_id NULL, status FAILED, error recorded.
    assert.equal(client.inserts[0][2], null);
    assert.equal(client.inserts[0][8], "FAILED");
    assert.match(client.inserts[0][9], /ECONNREFUSED/);
});

test("sendReworkApproverEmail writes no thread row when the approver has no address", async () => {
    const client = fakePgClient();
    let sendCalls = 0;
    const transport = {
        sendMail: async () => {
            sendCalls += 1;
            return { messageId: "<never@kpndomain.com>" };
        },
    };

    const notify = await reworkEmailSender.sendReworkApproverEmail(
        client,
        {
            requestKind: "SINGLE",
            requestId: 810,
            requestNo: "1000000810",
            subject: "Review request",
            body: "Mohon direview.",
            toEmail: "   ",
            toUserId: "APP-07",
        },
        { transport }
    );

    assert.equal(notify.sent, false);
    assert.match(notify.error, /APP-07/);
    assert.equal(sendCalls, 0);
    // to_email is NOT NULL and a thread with no address can never get a reply.
    assert.equal(client.inserts.length, 0);
});

test("sendReworkApproverEmail keeps sent:true when only the thread row fails", async () => {
    const client = {
        query: async () => {
            throw new Error("relation mat_rework_email does not exist");
        },
    };

    const notify = await reworkEmailSender.sendReworkApproverEmail(
        client,
        {
            requestKind: "SINGLE",
            requestId: 810,
            requestNo: "1000000810",
            subject: "Review request",
            body: "Mohon direview.",
            toEmail: "approver@kpn-corp.com",
            toUserId: "APP-07",
        },
        { transport: { sendMail: async () => ({ messageId: "<x@y>" }) } }
    );

    // The mail IS out; sent:false would tell Master Data to send it twice.
    assert.deepEqual(notify, { via: "EMAIL", sent: true });
});

test("the rework email sender never builds a transport at require time", () => {
    const source = require("fs").readFileSync(
        require("path").join(__dirname, "../helper/reworkEmailSender.js"),
        "utf8"
    );

    // createTransport must sit inside a function, never at module scope.
    assert.doesNotMatch(source, /^const \w+ = mailer\.createTransport/m);
    assert.match(source, /let cachedTransport = null/);
});

// ---------------------------------------------------------------------------
// Service seam: the chain-replacement rework really mails the picked approver.
// ---------------------------------------------------------------------------

const connectSingleChainStub = queryLog => async () => ({
    query: async (queryText, params = []) => {
        queryLog.push(queryText);

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
                        // Parked on Master Data — the correspondence-only EMAIL
                        // path must hand this back untouched.
                        assigned_to: "Master Data",
                        ticket_type: "Create",
                        created_by: "REQ-01",
                        requester_user_id: "REQ-01",
                    },
                ],
            };
        }

        if (/FOR UPDATE OF s/.test(queryText)) {
            return {
                rows: [
                    {
                        id: 8101,
                        request_id: 810,
                        level: 1,
                        kind: "MANUAL",
                        approver_user_id: "APP-01",
                        status: "APPROVED",
                    },
                    {
                        id: 8102,
                        request_id: 810,
                        level: 2,
                        kind: "MDM",
                        approver_user_id: "MDM-01",
                        status: "WAITING",
                        claimed_at: new Date("2026-08-06T02:00:00.000Z"),
                    },
                ],
            };
        }

        if (/mst_page_access/i.test(queryText)) {
            return { rows: [{ exists: 1 }], rowCount: 1 };
        }

        // The validation query now also carries the address the mail needs.
        if (/FROM mst_user mu\s+WHERE mu\.user_id = ANY/.test(queryText)) {
            const rows = (params[0] || []).map(id => ({
                user_id: id,
                email: `${String(id).toLowerCase()}@kpn-corp.com`,
            }));
            return { rows, rowCount: rows.length };
        }

        if (/DELETE FROM mat_single_request_approval_step/.test(queryText)) {
            return { rows: [], rowCount: 1 };
        }

        if (/INSERT INTO mat_single_request_approval_step/.test(queryText)) {
            return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
            return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_single_request\b/.test(queryText)) {
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

test("requestSingleRequestRework mails the picked recipient and changes nothing else", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const queryLog = [];
    const sendCalls = [];

    db.connect = connectSingleChainStub(queryLog);
    reworkEmailSender.sendReworkApproverEmail = async (client, ctx) => {
        sendCalls.push({ ctx, committed: queryLog.includes("COMMIT") });
        return { via: "EMAIL", sent: true };
    };

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Minta klarifikasi lewat email",
            newApprovers: ["APP-07"],
            notifyVia: "EMAIL",
            emailSubject: "Review Request Material 1000000810",
            emailBody: "Kepada Yth. Approver,\n\nMohon direview.",
        });

        assert.deepEqual(result.notify, { via: "EMAIL", sent: true });
        assert.equal(sendCalls.length, 1);

        // Correspondence only (product decision 2026-08-07): the mail is the
        // WHOLE effect. The request keeps its stage, status and assignment.
        assert.equal(result.emailOnly, true);
        assert.equal(result.stage, "Master Data");
        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Master Data");
        for (const sql of queryLog) {
            assert.doesNotMatch(
                sql,
                /^\s*(INSERT|UPDATE|DELETE)\b/i,
                `no statement may write on this path, got: ${sql}`
            );
        }

        // Post-commit, exactly like the placeholder was: a send must never be
        // able to run inside a transaction that can still roll back.
        assert.equal(sendCalls[0].committed, true);

        assert.deepEqual(sendCalls[0].ctx, {
            requestKind: "SINGLE",
            requestId: 810,
            requestNo: "1000000810",
            subject: "Review Request Material 1000000810",
            body: "Kepada Yth. Approver,\n\nMohon direview.",
            // Resolved from the validation query, not a second round trip.
            toEmail: "app-07@kpn-corp.com",
            toUserId: "APP-07",
            sentByUserId: "MDM-01",
        });
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// The reassigning channel: "Via aplikasi" still rewrites the chain, and it does
// so without mailing anybody.
test("requestSingleRequestRework on the APP channel reassigns and sends no mail", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const queryLog = [];
    let sendCalls = 0;

    db.connect = connectSingleChainStub(queryLog);
    reworkEmailSender.sendReworkApproverEmail = async () => {
        sendCalls += 1;
        return { via: "EMAIL", sent: true };
    };

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Approver chain salah",
            newApprovers: ["APP-07"],
            notifyVia: "APP",
        });

        assert.equal(sendCalls, 0);
        assert.equal(result.emailOnly, undefined);
        assert.equal(result.status, "Submit");
        assert.equal(result.assigned_to, "Approval 1");
        assert.deepEqual(result.notify, {
            via: "APP",
            sent: false,
            placeholder: false,
        });

        // The chain really was rewritten.
        assert.ok(
            queryLog.some(sql =>
                /DELETE FROM mat_single_request_approval_step/.test(sql)
            )
        );
        assert.ok(
            queryLog.some(sql =>
                /INSERT INTO mat_single_request_approval_step/.test(sql)
            )
        );
        assert.ok(queryLog.some(sql => /UPDATE mat_single_request\b/.test(sql)));
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

test("a rework with no new chain sends nothing even on the EMAIL channel", async () => {
    const originalConnect = db.connect;
    const originalSend = reworkEmailSender.sendReworkApproverEmail;
    const queryLog = [];
    let sendCalls = 0;

    db.connect = connectSingleChainStub(queryLog);
    reworkEmailSender.sendReworkApproverEmail = async () => {
        sendCalls += 1;
        return { via: "EMAIL", sent: true };
    };

    try {
        const result = await materialService.requestSingleRequestRework({
            requestId: 810,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            reason: "Data kurang",
            notifyVia: "EMAIL",
            emailSubject: "Review Request Material 1000000810",
            emailBody: "Mohon direview.",
        });

        // Rework-to-requester picks nobody, so there is no address to write to.
        assert.equal(sendCalls, 0);
        assert.deepEqual(result.notify, {
            via: "EMAIL",
            sent: false,
            placeholder: true,
        });
    } finally {
        db.connect = originalConnect;
        reworkEmailSender.sendReworkApproverEmail = originalSend;
    }
});

// ---------------------------------------------------------------------------
// stripQuotedReply
// ---------------------------------------------------------------------------

const { stripQuotedReply } = reworkEmailInboundService;

test("stripQuotedReply cuts a gmail 'On ... wrote:' tail", () => {
    const text = [
        "Sudah saya cek, deskripsi kurang panjang.",
        "Mohon ditambah ukuran drat.",
        "",
        "On Thu, 7 Aug 2026 at 09:12, VMS <vms.kpn@kpndomain.com> wrote:",
        "> Kepada Yth. Approver,",
        "> No. Request : 1000000810",
    ].join("\n");

    assert.equal(
        stripQuotedReply(text),
        "Sudah saya cek, deskripsi kurang panjang.\nMohon ditambah ukuran drat."
    );
});

test("stripQuotedReply cuts an Indonesian 'Pada ... menulis:' tail", () => {
    const text = [
        "Setuju, lanjutkan.",
        "",
        "Pada Kam, 7 Agu 2026 09.12, VMS <vms.kpn@kpndomain.com> menulis:",
        "Kepada Yth. Approver,",
    ].join("\n");

    assert.equal(stripQuotedReply(text), "Setuju, lanjutkan.");
});

test("stripQuotedReply cuts an outlook 'From:' header block", () => {
    const text = [
        "Approved dari sisi saya.",
        "",
        "From: VMS <vms.kpn@kpndomain.com>",
        "Sent: Thursday, 7 August 2026 09:12",
        "To: Approver <approver@kpn-corp.com>",
        "Subject: Review Request Material [VMS#1000000810]",
        "",
        "Kepada Yth. Approver,",
    ].join("\n");

    assert.equal(stripQuotedReply(text), "Approved dari sisi saya.");
});

test("stripQuotedReply cuts an '-----Original Message-----' block", () => {
    const text = [
        "Tolong dicek lagi plant-nya.",
        "",
        "-----Original Message-----",
        "From: VMS",
    ].join("\n");

    assert.equal(stripQuotedReply(text), "Tolong dicek lagi plant-nya.");
});

test("stripQuotedReply cuts a bare '>' quote block", () => {
    const text = [
        "Ok noted.",
        "",
        "> Kepada Yth. Approver,",
        ">",
        "> No. Request : 1000000810",
    ].join("\n");

    assert.equal(stripQuotedReply(text), "Ok noted.");
});

test("stripQuotedReply passes an unquoted reply through untouched", () => {
    const text =
        "Sudah oke.\nSaya approve setelah deskripsi diperbaiki.\nTerima kasih.";

    assert.equal(stripQuotedReply(text), text);
});

test("stripQuotedReply returns empty when the reply is nothing but quote", () => {
    // A bottom-posted reply with no new text — the caller falls back to the
    // full body rather than showing a blank card.
    assert.equal(stripQuotedReply("> Kepada Yth. Approver,\n> ..."), "");
    assert.equal(stripQuotedReply(""), "");
    assert.equal(stripQuotedReply(null), "");
});

// ---------------------------------------------------------------------------
// Inbound matching
// ---------------------------------------------------------------------------

const { extractReferencedMessageIds, findReworkEmailForReply, resolveCursorStart } =
    reworkEmailInboundService;

test("extractReferencedMessageIds reads In-Reply-To and References, normalised", () => {
    const ids = extractReferencedMessageIds({
        envelope: { inReplyTo: "<VMS-1@KPNDOMAIN.COM>" },
        headers: Buffer.from(
            "In-Reply-To: <vms-1@kpndomain.com>\r\n" +
                "References: <root@kpndomain.com> <vms-1@kpndomain.com>\r\n"
        ),
    });

    // Angle brackets off, lower-cased, de-duplicated, order preserved.
    assert.deepEqual(ids, [
        "vms-1@kpndomain.com",
        "root@kpndomain.com",
    ]);

    assert.deepEqual(extractReferencedMessageIds({}), []);
    assert.deepEqual(extractReferencedMessageIds(), []);
});

const inboundLookupClient = rows => {
    const queries = [];
    return {
        queries,
        query: async (queryText, params = []) => {
            queries.push({ queryText, params });

            if (/lower\(btrim\(message_id/.test(queryText)) {
                const wanted = params[0] || [];
                return {
                    rows: rows.byMessageId && wanted.includes(rows.byMessageId)
                        ? [{ id: 501, to_email: "approver@kpn-corp.com" }]
                        : [],
                };
            }

            if (/position\(\$1::text in subject\)/.test(queryText)) {
                return {
                    rows:
                        rows.bySubjectToken === params[0]
                            ? [{ id: 502, to_email: "approver@kpn-corp.com" }]
                            : [],
                };
            }

            // Every request action also appends to the request comment history; the
            // stub answers that write the way the database would.
            if (/mat_request_comment/.test(queryText)) {
                return { rows: [], rowCount: 1 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
    };
};

test("findReworkEmailForReply matches on In-Reply-To before anything else", async () => {
    const client = inboundLookupClient({
        byMessageId: "vms-1@kpndomain.com",
        bySubjectToken: "[VMS#1000000810]",
    });

    const match = await findReworkEmailForReply(client, {
        referencedIds: ["vms-1@kpndomain.com"],
        subject: "Re: Review Request Material [VMS#1000000810]",
    });

    assert.deepEqual(match, { id: 501, to_email: "approver@kpn-corp.com" });
    // The subject fallback is never even reached.
    assert.equal(client.queries.length, 1);
});

test("findReworkEmailForReply falls back to the [VMS#...] subject token", async () => {
    const client = inboundLookupClient({
        byMessageId: null,
        bySubjectToken: "[VMS#1000000810]",
    });

    const match = await findReworkEmailForReply(client, {
        // A client that dropped In-Reply-To and References entirely.
        referencedIds: [],
        subject: "RE: Review Request Material [VMS#1000000810]",
    });

    assert.deepEqual(match, { id: 502, to_email: "approver@kpn-corp.com" });
    assert.equal(client.queries.length, 1);
    // The token goes in as a parameter, never spliced into a LIKE pattern.
    assert.deepEqual(client.queries[0].params, ["[VMS#1000000810]"]);
});

test("findReworkEmailForReply gives up on ordinary mail", async () => {
    const client = inboundLookupClient({
        byMessageId: "vms-1@kpndomain.com",
        bySubjectToken: "[VMS#1000000810]",
    });

    assert.equal(
        await findReworkEmailForReply(client, {
            referencedIds: ["someone-else@example.com"],
            subject: "Undangan rapat mingguan",
        }),
        null
    );

    // Only the message-id probe ran: no token, no second query.
    assert.equal(client.queries.length, 1);
});

// ---------------------------------------------------------------------------
// Poll cursor
// ---------------------------------------------------------------------------

test("resolveCursorStart seeds the first run at uidNext-1 and scans no history", () => {
    const start = resolveCursorStart({
        cursor: null,
        uidNext: 14322,
        uidValidity: 7,
    });

    assert.deepEqual(start, {
        lastUid: 14321,
        uidValidity: 7,
        reason: "INIT",
    });
});

test("resolveCursorStart floors the seed on an empty mailbox", () => {
    assert.equal(
        resolveCursorStart({ cursor: null, uidNext: 1, uidValidity: 7 })
            .lastUid,
        0
    );
    assert.equal(
        resolveCursorStart({ cursor: null, uidNext: undefined, uidValidity: 7 })
            .lastUid,
        0
    );
});

test("resolveCursorStart re-seeds when the server changed UIDVALIDITY", () => {
    const start = resolveCursorStart({
        cursor: { uidvalidity: "7", last_uid: "120" },
        uidNext: 14322,
        uidValidity: 9,
    });

    // Every stored UID is meaningless under the new numbering.
    assert.deepEqual(start, {
        lastUid: 14321,
        uidValidity: 9,
        reason: "UIDVALIDITY_RESET",
    });
});

test("resolveCursorStart resumes from the stored uid", () => {
    // uidvalidity comes back from pg as a string (bigint); the comparison must
    // survive that.
    assert.deepEqual(
        resolveCursorStart({
            cursor: { uidvalidity: "7", last_uid: "120" },
            uidNext: 14322,
            uidValidity: 7,
        }),
        { lastUid: 120, uidValidity: 7, reason: "RESUME" }
    );
});

// ---------------------------------------------------------------------------
// Poller orchestration, against a fake ImapFlow — still zero sockets.
// ---------------------------------------------------------------------------

const fakeImapClient = ({
    uidNext,
    uidValidity,
    exists,
    messages = [],
    sources = {},
}) => {
    const calls = { fetches: [], downloads: [], loggedOut: false };

    return {
        calls,
        mailbox: null,
        connect: async function connect() {
            this.mailbox = {
                uidNext,
                // imapflow hands UIDVALIDITY back as a BigInt.
                uidValidity: BigInt(uidValidity),
                exists,
            };
        },
        getMailboxLock: async () => ({ release: () => {} }),
        fetch: (range, query, options) => {
            calls.fetches.push({ range, query, options });
            return (async function* iterate() {
                for (const message of messages) {
                    yield message;
                }
            })();
        },
        download: async uid => {
            calls.downloads.push(uid);
            return { content: sources[uid] };
        },
        logout: async () => {
            calls.loggedOut = true;
        },
    };
};

const pollerPgStub = ({ cursor = null, matchId = null }) => {
    const state = { cursorWrites: [], replyInserts: [] };

    state.connect = async () => ({
        query: async (queryText, params = []) => {
            if (/FROM mat_email_poll_cursor/.test(queryText)) {
                return { rows: cursor ? [cursor] : [] };
            }
            if (/INSERT INTO mat_email_poll_cursor/.test(queryText)) {
                state.cursorWrites.push(params);
                return { rows: [], rowCount: 1 };
            }
            if (/lower\(btrim\(message_id/.test(queryText)) {
                const wanted = params[0] || [];
                return {
                    rows:
                        matchId && wanted.includes(matchId)
                            ? [{ id: 501, to_email: "approver@kpn-corp.com" }]
                            : [],
                };
            }
            if (/position\(\$1::text in subject\)/.test(queryText)) {
                return { rows: [] };
            }
            if (/INSERT INTO mat_rework_email_reply/.test(queryText)) {
                state.replyInserts.push(params);
                return { rows: [{ id: 900 }], rowCount: 1 };
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

    return state;
};

test("the first poll seeds the cursor at uidNext-1 and reads no history", async () => {
    const originalConnect = db.connect;
    const pg = pollerPgStub({ cursor: null });
    const imap = fakeImapClient({
        uidNext: 14322,
        uidValidity: 7,
        exists: 14321,
    });

    db.connect = pg.connect;

    try {
        const summary =
            await reworkEmailInboundService.pollReworkEmailReplies(
                {},
                { createClient: () => imap }
            );

        assert.equal(summary.reason, "INIT");
        assert.equal(summary.scanned, 0);
        // The 14k+ of history is never even asked for.
        assert.equal(imap.calls.fetches.length, 0);
        assert.equal(imap.calls.downloads.length, 0);
        assert.deepEqual(pg.cursorWrites, [["INBOX", 7, 14321]]);
        assert.equal(imap.calls.loggedOut, true);
    } finally {
        db.connect = originalConnect;
    }
});

test("a poll files a matching reply and advances past the unrelated mail", async () => {
    const originalConnect = db.connect;
    const pg = pollerPgStub({
        cursor: { mailbox: "INBOX", uidvalidity: "7", last_uid: "120" },
        matchId: "vms-1@kpndomain.com",
    });
    const imap = fakeImapClient({
        uidNext: 123,
        uidValidity: 7,
        exists: 122,
        messages: [
            {
                uid: 121,
                envelope: {
                    subject: "Re: Review Request Material [VMS#1000000810]",
                    inReplyTo: "<vms-1@kpndomain.com>",
                },
                headers: Buffer.from(
                    "In-Reply-To: <vms-1@kpndomain.com>\r\n"
                ),
            },
            {
                uid: 122,
                envelope: { subject: "Undangan rapat mingguan" },
                headers: Buffer.from("References: <rapat@example.com>\r\n"),
            },
        ],
        sources: {
            121: [
                "From: Approver <APPROVER@kpn-corp.com>",
                "To: VMS <vms.kpn@kpndomain.com>",
                "Subject: Re: Review Request Material [VMS#1000000810]",
                "Message-ID: <reply-1@kpn-corp.com>",
                "In-Reply-To: <vms-1@kpndomain.com>",
                "Date: Thu, 7 Aug 2026 09:30:00 +0700",
                "Content-Type: text/plain; charset=utf-8",
                "",
                "Deskripsi kurang panjang, mohon ditambah.",
                "",
                "On Thu, 7 Aug 2026 at 09:12, VMS <vms.kpn@kpndomain.com> wrote:",
                "> Kepada Yth. Approver,",
                "",
            ].join("\r\n"),
        },
    });

    db.connect = pg.connect;

    try {
        const summary =
            await reworkEmailInboundService.pollReworkEmailReplies(
                {},
                { createClient: () => imap }
            );

        assert.equal(summary.reason, "RESUME");
        assert.equal(summary.scanned, 2);
        assert.equal(summary.matched, 1);
        assert.equal(summary.inserted, 1);

        // Resumes at last_uid+1, open-ended.
        assert.equal(imap.calls.fetches[0].range, "121:*");
        // Headers/envelope only on the first pass.
        assert.equal(imap.calls.fetches[0].query.source, undefined);
        // Body downloaded for the match alone.
        assert.deepEqual(imap.calls.downloads, ["121"]);

        const [reply] = pg.replyInserts;
        assert.equal(reply[0], 501);
        assert.equal(reply[1], "approver@kpn-corp.com");
        // Case-insensitive address compare against mat_rework_email.to_email.
        assert.equal(reply[2], true);
        assert.equal(reply[3], "<reply-1@kpn-corp.com>");
        assert.equal(reply[5], "Deskripsi kurang panjang, mohon ditambah.");
        assert.match(reply[6], /On Thu, 7 Aug 2026 at 09:12/);

        // Cursor advanced past the UNRELATED mail too, so it is never re-read.
        assert.deepEqual(pg.cursorWrites, [["INBOX", 7, 122]]);
    } finally {
        db.connect = originalConnect;
    }
});

test("the inbound poller never mutates the mailbox", () => {
    const source = require("fs").readFileSync(
        require("path").join(
            __dirname,
            "../services/reworkEmailInboundService.js"
        ),
        "utf8"
    );

    // No delete, no move, no flag change — the box is shared with humans, and
    // imapflow's fetches are BODY.PEEK so reading cannot set \Seen either.
    assert.doesNotMatch(
        source,
        /messageDelete|messageMove|messageCopy|messageFlagsAdd|messageFlagsSet|messageFlagsRemove|\\\\Seen/
    );
});

// ---------------------------------------------------------------------------
// Thread read
// ---------------------------------------------------------------------------

test("getReworkEmailThread shapes mails newest-first with their replies", async () => {
    const originalConnect = db.connect;
    const captured = [];

    db.connect = async () => ({
        query: async (queryText, params = []) => {
            captured.push({ queryText, params });
            return {
                rows: [
                    {
                        id: "502",
                        subject: "Review lagi [VMS#1000000810]",
                        body: "Mohon direview ulang.",
                        to_email: "approver@kpn-corp.com",
                        send_status: "SENT",
                        send_error: null,
                        sent_at: new Date("2026-08-07T04:00:00.000Z"),
                        replies: [],
                    },
                    {
                        id: "501",
                        subject: "Review [VMS#1000000810]",
                        body: "Mohon direview.",
                        to_email: "approver@kpn-corp.com",
                        send_status: "FAILED",
                        send_error: "ECONNREFUSED",
                        sent_at: new Date("2026-08-06T04:00:00.000Z"),
                        replies: [
                            {
                                fromEmail: "someone@else.com",
                                senderMatches: false,
                                receivedAt: "2026-08-06T05:00:00.000Z",
                                bodyText: "Diteruskan ke saya.",
                            },
                        ],
                    },
                ],
            };
        },
        release: () => {},
    });

    try {
        const rows = await materialService.getReworkEmailThread({
            requestKind: "SINGLE",
            requestId: 810,
        });

        assert.deepEqual(captured[0].params, ["SINGLE", 810]);
        assert.match(captured[0].queryText, /ORDER BY e\.sent_at DESC/);

        assert.equal(rows.length, 2);
        assert.equal(rows[0].id, 502);
        assert.equal(rows[0].toEmail, "approver@kpn-corp.com");
        assert.equal(rows[0].sendStatus, "SENT");
        assert.deepEqual(rows[0].replies, []);

        assert.equal(rows[1].sendStatus, "FAILED");
        assert.equal(rows[1].sendError, "ECONNREFUSED");
        assert.equal(rows[1].replies[0].senderMatches, false);
        assert.equal(rows[1].replies[0].fromEmail, "someone@else.com");
    } finally {
        db.connect = originalConnect;
    }
});

test("getReworkEmailThread hides itself until the migration is applied", async () => {
    const originalConnect = db.connect;

    db.connect = async () => ({
        query: async () => {
            throw Object.assign(
                new Error('relation "mat_rework_email" does not exist'),
                { code: "42P01" }
            );
        },
        release: () => {},
    });

    try {
        assert.deepEqual(
            await materialService.getReworkEmailThread({
                requestKind: "MASS",
                requestId: 900,
            }),
            []
        );
    } finally {
        db.connect = originalConnect;
    }
});

// ---------------------------------------------------------------------------
// Approval indicator: email_sent_count + email_reply_count on the list /
// approval-inbox rows. The Status cell says whether the mailed approver has
// answered without opening the detail, so both counts have to ride along on
// the four read queries that already feed it. Two and not one: zero replies
// means both "no mail was ever sent" and "sent, still waiting".
// ---------------------------------------------------------------------------

// The scalars as each query composes them: subqueries, joined only inside
// themselves.
const emailReplyCountScalarPattern = (kind, idExpr) =>
    new RegExp(
        String.raw`\(\s*SELECT COUNT\(rp\.id\)\s*` +
            String.raw`FROM mat_rework_email e\s*` +
            String.raw`JOIN mat_rework_email_reply rp ON rp\.rework_email_id = e\.id\s*` +
            String.raw`WHERE e\.request_kind = '${kind}'\s*` +
            String.raw`AND e\.request_id = ${idExpr.replace(".", "\\.")}\s*` +
            String.raw`\)::int AS email_reply_count`,
        "i"
    );

const emailUnansweredCountScalarPattern = (kind, idExpr) =>
    new RegExp(
        String.raw`\(\s*SELECT COUNT\(e\.id\)\s*` +
            String.raw`FROM mat_rework_email e\s*` +
            String.raw`WHERE e\.request_kind = '${kind}'\s*` +
            String.raw`AND e\.request_id = ${idExpr.replace(".", "\\.")}\s*` +
            String.raw`AND UPPER\(COALESCE\(e\.send_status, ''\)\) = 'SENT'\s*` +
            String.raw`AND NOT EXISTS \(\s*` +
            String.raw`SELECT 1\s*` +
            String.raw`FROM mat_rework_email_reply rp\s*` +
            String.raw`WHERE rp\.rework_email_id = e\.id\s*\)\s*` +
            String.raw`\)::int AS email_unanswered_count`,
        "i"
    );

const emailSentCountScalarPattern = (kind, idExpr) =>
    new RegExp(
        String.raw`\(\s*SELECT COUNT\(e\.id\)\s*` +
            String.raw`FROM mat_rework_email e\s*` +
            String.raw`WHERE e\.request_kind = '${kind}'\s*` +
            String.raw`AND e\.request_id = ${idExpr.replace(".", "\\.")}\s*` +
            String.raw`AND UPPER\(COALESCE\(e\.send_status, ''\)\) = 'SENT'\s*` +
            String.raw`\)::int AS email_sent_count`,
        "i"
    );

test("single request list and inbox queries expose both e-mail counts", () => {
    for (const query of [
        materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    ]) {
        assert.match(query, emailReplyCountScalarPattern("SINGLE", "r.id"));
        assert.match(query, emailSentCountScalarPattern("SINGLE", "r.id"));
        assert.match(query, emailUnansweredCountScalarPattern("SINGLE", "r.id"));
    }
});

test("mass request list and inbox queries count across the batch thread", () => {
    // MASS rows are filed under mat_mass_request.id (reworkEmailSender), so one
    // pair of counts covers the whole batch's thread rather than a single item.
    for (const query of [
        materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY,
        materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    ]) {
        assert.match(query, emailReplyCountScalarPattern("MASS", "m.id"));
        assert.match(query, emailSentCountScalarPattern("MASS", "m.id"));
        assert.match(query, emailUnansweredCountScalarPattern("MASS", "m.id"));
    }
});

test("outstanding mails are counted per mail, never by totalling replies", () => {
    // A request can be reworked by mail more than once, and each mail is
    // answered on its own. EXISTS asks each mail its own question, so a mail
    // with three replies weighs the same as one with a single reply, and a mail
    // with none stays outstanding however many its siblings collected.
    // Comparing the sent and reply totals instead would call a request with one
    // answered and one ignored mail fully answered.
    for (const query of [
        materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
        materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY,
        materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    ]) {
        assert.match(
            query,
            /NOT EXISTS \(\s*SELECT 1\s*FROM mat_rework_email_reply rp\s*WHERE rp\.rework_email_id = e\.id\s*\)/
        );
        assert.equal(query.match(/AS email_unanswered_count/gi).length, 1);
    }
});

test("the sent count ignores a mail that never left the mailbox", () => {
    // A FAILED send is reported by the thread section. Counting it here would
    // park a request on "waiting for the approver" forever, because no reply
    // can ever arrive to a mail that was not delivered.
    for (const query of [
        materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
        materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY,
        materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    ]) {
        assert.match(query, /AND UPPER\(COALESCE\(e\.send_status, ''\)\) = 'SENT'/);
    }
});

test("both counts are additive — neither can multiply a request row", () => {
    // Cutting the scalar subqueries out must leave no reference to either
    // e-mail table behind: anything left over would be a join in the FROM
    // chain, and a request with three replies would render as three rows.
    // One lazy pattern for all three: each match ends at the nearest
    // ")::int AS email_<name>_count", so they strip individually whatever order
    // the SELECT lists them in.
    const emailScalarSubquery =
        /\(\s*SELECT COUNT\([a-z]+\.id\)[\s\S]*?\)::int AS email_[a-z_]*count/g;

    for (const query of [
        materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
        materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY,
        materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY,
    ]) {
        assert.equal(query.match(/AS email_reply_count/gi).length, 1);
        assert.equal(query.match(/AS email_sent_count/gi).length, 1);
        assert.equal(query.match(/AS email_unanswered_count/gi).length, 1);
        assert.doesNotMatch(query.replace(emailScalarSubquery, ""), /mat_rework_email/i);
    }
});

test("every read query keeps both e-mail counts when the migration is missing", () => {
    // 20260807_rework_email_thread.sql is applied by hand, and Postgres rejects
    // the whole statement at parse time when the tables are absent — so the
    // fallback drops the subquery for a constant instead of dropping the field.
    const legacyQueries = [
        materialService.buildSingleRequestListQuery("r.created_by = $1", {
            includeEmailReplyCount: false,
        }),
        materialService.buildSingleRequestApprovalInboxQuery({
            includeEmailReplyCount: false,
        }),
        materialService.buildMassRequestsByUserQuery({
            includeEmailReplyCount: false,
        }),
        materialService.buildMassRequestApprovalInboxQuery({
            includeEmailReplyCount: false,
        }),
    ];

    for (const query of legacyQueries) {
        assert.match(query, /0::int AS email_reply_count/i);
        assert.match(query, /0::int AS email_sent_count/i);
        assert.match(query, /0::int AS email_unanswered_count/i);
        assert.doesNotMatch(query, /mat_rework_email/i);
    }
});

// Fake pg client that rejects any statement touching the e-mail tables the way
// Postgres does before the migration lands, and records what was attempted.
const makePreMigrationClient = () => {
    const attempts = [];

    return {
        attempts,
        query: async queryText => {
            attempts.push(queryText);

            if (/mat_rework_email/i.test(queryText)) {
                throw Object.assign(
                    new Error('relation "mat_rework_email" does not exist'),
                    { code: "42P01" }
                );
            }

            return { rows: [] };
        },
    };
};

test("the single-request runners retry without the e-mail scalars before the migration", async () => {
    const listClient = makePreMigrationClient();
    await materialService.runSingleRequestListQuery(
        listClient,
        "r.created_by = $1",
        ["req.user"]
    );

    assert.equal(listClient.attempts.length, 2);
    assert.match(listClient.attempts[0], /mat_rework_email_reply/i);
    assert.match(listClient.attempts[1], /0::int AS email_reply_count/i);

    const inboxClient = makePreMigrationClient();
    await materialService.runSingleRequestApprovalInboxQuery(inboxClient);

    assert.equal(inboxClient.attempts.length, 2);
    assert.match(inboxClient.attempts[1], /0::int AS email_reply_count/i);
});

test("the mass-request runners retry without the e-mail scalars before the migration", async () => {
    const listClient = makePreMigrationClient();
    await materialService.runMassRequestsByUserQuery(listClient, "req.user");

    assert.equal(listClient.attempts.length, 2);
    assert.match(listClient.attempts[0], /mat_rework_email_reply/i);
    assert.match(listClient.attempts[1], /0::int AS email_reply_count/i);

    const inboxClient = makePreMigrationClient();
    await materialService.runMassRequestApprovalInboxQuery(inboxClient);

    assert.equal(inboxClient.attempts.length, 2);
    assert.match(inboxClient.attempts[1], /0::int AS email_reply_count/i);
});
