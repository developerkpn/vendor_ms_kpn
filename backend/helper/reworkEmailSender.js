// Rework -> new-approver notification: the REAL EMAIL channel.
//
// Replaces reworkEmailPlaceholder on the runtime path (that module stays: it is
// still what buildReworkNotifyResult returns for callers that ask for EMAIL
// without content, and tests pin its inertness).
//
// Contract with the caller — requestSingleRequestRework /
// requestMassRequestRework call this AFTER their COMMIT:
//   * it never throws. A dead SMTP server must not un-approve an approver chain
//     that is already durable, so every failure comes back as data
//     ({sent:false, error}) and is persisted as a FAILED mat_rework_email row.
//   * the row it writes is the thread anchor: reworkEmailInboundService matches
//     incoming replies against its message_id (and, as a fallback, the
//     [VMS#<request_no>] token inside its subject).
//
// Transport mirrors backend/config/emailer.js exactly (SMTP_HOST, implicit TLS
// on 465, SSLv3 ciphers, rejectUnauthorized false, SMTP_USERNAME/SMTP_PASSWORD)
// — the mail host is the same one, and diverging on TLS options here would make
// this the one mail in VMS that mysteriously does not go out.

const mailer = require("nodemailer");
const { ensureSubjectToken } = require("./reworkEmailTemplate");

const REWORK_EMAIL_REQUEST_KINDS = Object.freeze({
    SINGLE: "SINGLE",
    MASS: "MASS",
});

const REWORK_EMAIL_SEND_STATUS = Object.freeze({
    SENT: "SENT",
    FAILED: "FAILED",
});

// mat_rework_email.send_error is text, but a full SMTP stack trace in a UI chip
// helps nobody; the log keeps the whole thing.
const SEND_ERROR_MAX_LENGTH = 500;

// Built on first send, not at require time: the module is pulled in by
// materialService (and therefore by every test that touches it), and creating a
// transport at import would make an env-less test process carry SMTP state it
// never uses.
let cachedTransport = null;

/**
 * The nodemailer transport used for rework mails.
 *
 * @returns {object} nodemailer transport, cached for the process
 */
const getReworkEmailTransport = () => {
    if (!cachedTransport) {
        cachedTransport = mailer.createTransport({
            host: process.env.SMTP_HOST,
            secure: true,
            port: 465,
            tls: {
                ciphers: "SSLv3",
                rejectUnauthorized: false,
            },
            auth: {
                user: `${process.env.SMTP_USERNAME}`,
                pass: `${process.env.SMTP_PASSWORD}`,
            },
        });
    }

    return cachedTransport;
};

/**
 * The address rework mails are sent from — the VMS mailbox the inbound poller
 * then reads the replies out of. One constant for both halves, so a reply can
 * never land in a mailbox nothing polls.
 *
 * @returns {string} SMTP_USERNAME, or "" when unconfigured
 */
const getReworkEmailSenderAddress = () => String(process.env.SMTP_USERNAME ?? "");

const truncateError = message =>
    String(message ?? "")
        .trim()
        .slice(0, SEND_ERROR_MAX_LENGTH) || "Unknown send error";

/**
 * Persist one outbound rework mail (sent or failed).
 *
 * @param {object} client pg client (the rework transaction's client, already
 *                        committed — this INSERT is its own implicit tx)
 * @param {object} row    column values; see mat_rework_email
 * @returns {Promise<number|null>} inserted id
 */
const insertReworkEmailRow = async (client, row = {}) => {
    const result = await client.query(
        `INSERT INTO mat_rework_email (
             request_kind,
             request_id,
             message_id,
             subject,
             body,
             to_email,
             to_user_id,
             sent_by_user_id,
             send_status,
             send_error
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
            row.requestKind,
            row.requestId,
            row.messageId ?? null,
            row.subject,
            row.body,
            row.toEmail,
            row.toUserId ?? null,
            row.sentByUserId ?? null,
            row.sendStatus,
            row.sendError ?? null,
        ]
    );

    return result?.rows?.[0]?.id ?? null;
};

/**
 * Send the rework notification to the hand-picked new approver and record it.
 *
 * NEVER THROWS — see the module header. The three outcomes:
 *   no address   -> {sent:false, error}, and NO row: mat_rework_email.to_email
 *                   is NOT NULL and a thread with no address can never receive
 *                   a reply, so there is no thread to anchor.
 *   send failed  -> {sent:false, error} + a FAILED row (message_id NULL).
 *   sent         -> {sent:true} + a SENT row carrying the Message-ID replies
 *                   will thread on.
 *
 * @param {object} client pg client, used after the caller's COMMIT
 * @param {object} ctx
 * @param {'SINGLE'|'MASS'} ctx.requestKind which request table requestId is in
 * @param {number|string} ctx.requestId     mat_single_request.id / mat_mass_request.id
 * @param {string} ctx.requestNo            request_no the thread token names
 * @param {string} ctx.subject              subject as edited by Master Data
 * @param {string} ctx.body                 plain-text body as edited by Master Data
 * @param {string} [ctx.toEmail]            picked approver's mst_user.email
 * @param {string} [ctx.toUserId]           picked approver's mst_user.user_id
 * @param {string} [ctx.sentByUserId]       Master Data actor who reworked
 * @param {object} [deps]                   test seam
 * @param {object} [deps.transport]         nodemailer-shaped {sendMail}
 * @returns {Promise<{via:'EMAIL', sent:boolean, error?:string}>} the `notify`
 *          block the rework response carries
 */
const sendReworkApproverEmail = async (client, ctx = {}, deps = {}) => {
    const subject = ensureSubjectToken(ctx.subject, ctx.requestNo);
    const body = String(ctx.body ?? "");
    const toEmail = String(ctx.toEmail ?? "").trim();

    if (toEmail === "") {
        const error = `Approver ${ctx.toUserId ?? "(unknown)"} has no email address`;
        console.error(`[rework-email] ${error}`);
        return { via: "EMAIL", sent: false, error };
    }

    const baseRow = {
        requestKind: ctx.requestKind,
        requestId: ctx.requestId,
        subject,
        body,
        toEmail,
        toUserId: ctx.toUserId ?? null,
        sentByUserId: ctx.sentByUserId ?? null,
    };

    let messageId = null;

    try {
        const transport = deps.transport ?? getReworkEmailTransport();
        const info = await transport.sendMail({
            from: getReworkEmailSenderAddress(),
            to: toEmail,
            subject,
            text: body,
        });
        messageId = info?.messageId ?? null;
    } catch (sendError) {
        const error = truncateError(sendError?.message ?? sendError);
        console.error("[rework-email] send failed:", sendError);

        // Best-effort audit trail. A failed INSERT here must not turn a
        // survivable send failure into a thrown error the committed rework
        // would report as a crash.
        try {
            await insertReworkEmailRow(client, {
                ...baseRow,
                messageId: null,
                sendStatus: REWORK_EMAIL_SEND_STATUS.FAILED,
                sendError: error,
            });
        } catch (persistError) {
            console.error(
                "[rework-email] could not record the failed send:",
                persistError
            );
        }

        return { via: "EMAIL", sent: false, error };
    }

    try {
        await insertReworkEmailRow(client, {
            ...baseRow,
            messageId,
            sendStatus: REWORK_EMAIL_SEND_STATUS.SENT,
            sendError: null,
        });
    } catch (persistError) {
        // The mail IS out. Reporting sent:false here would tell Master Data to
        // send it again; the honest failure is the missing thread row, which is
        // a log-and-continue.
        console.error(
            "[rework-email] sent but could not record the thread row:",
            persistError
        );
    }

    return { via: "EMAIL", sent: true };
};

module.exports = {
    REWORK_EMAIL_REQUEST_KINDS,
    REWORK_EMAIL_SEND_STATUS,
    getReworkEmailTransport,
    getReworkEmailSenderAddress,
    insertReworkEmailRow,
    sendReworkApproverEmail,
};
