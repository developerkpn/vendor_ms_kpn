// Rework e-mail thread: the INBOUND half.
//
// The outbound half (helper/reworkEmailSender) mails a hand-picked rework
// approver and records the mail in mat_rework_email. This service polls the VMS
// mailbox over IMAPS, finds the replies to those mails, and files them under the
// mail they answer, so the approver's review ends up in the request detail
// instead of one Master Data user's inbox.
//
// Three rules the box itself imposes:
//  1. NEVER SCAN HISTORY. The mailbox holds 14k+ unrelated mails. The cursor is
//     seeded at `uidNext - 1` on first run, so the very first poll looks at
//     nothing and every later poll looks only at what arrived since.
//  2. NEVER MUTATE. No delete, no move, no flag change — the box is shared with
//     humans. Every imapflow fetch used here compiles to BODY.PEEK, so reading
//     a message does not set \Seen either.
//  3. ADVANCE ANYWAY. The cursor moves to the highest UID seen even when
//     nothing matched, so the 14k+ of ordinary mail flowing through the box is
//     examined once and never again.
//
// Matching is Message-ID first (In-Reply-To / References against
// mat_rework_email.message_id), then the `[VMS#<request_no>]` subject token as
// the fallback for clients that drop those headers.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const DBClientWrapper = require("../helper/DBClientWrapper");
const { extractReworkEmailToken } = require("../helper/reworkEmailTemplate");

/** The one mailbox polled; also the mat_email_poll_cursor primary key. */
const INBOUND_MAILBOX = "INBOX";

/** Header fields pulled in the cheap first pass (envelope carries the rest). */
const INBOUND_HEADER_FIELDS = ["in-reply-to", "references"];

// Where the approver's own words stop and the client's quoted original starts.
// Ordered by nothing in particular — the FIRST line matching ANY of them is the
// cut, because every one of them only ever appears at the top of a quoted tail.
//   gmail/en   "On Thu, 7 Aug 2026 at 09:12, VMS <vms@...> wrote:"
//   gmail/id   "Pada Kam, 7 Agu 2026 09.12, VMS <vms@...> menulis:"
//   any client "> quoted line"
//   outlook    "-----Original Message-----"
//   outlook    "From: VMS <vms@...>"   (the forwarded/replied header block)
const QUOTED_TAIL_PATTERNS = [
    /^On\s.+\bwrote:$/,
    /^Pada\s.+\bmenulis:$/,
    /^>/,
    /^-{2,}\s*Original Message/i,
    /^From:\s/,
];

/**
 * Cut a reply down to what the approver actually typed.
 *
 * Deliberately a dumb line scan, and deliberately lossy-safe: the caller stores
 * the untouched text in mat_rework_email_reply.body_full as well, so a heuristic
 * that cuts too early costs display quality, never content.
 *
 * Returns "" when the very first line is already quoted tail (a bottom-posted
 * reply with no new text, or a strip that fired too early) — the caller decides
 * what to show instead; lying with the full quote here would hide that case.
 *
 * @param {string} [text] plain-text body as mailparser produced it
 * @returns {string} the reply text with the quoted tail removed, trimmed
 */
const stripQuotedReply = text => {
    const lines = String(text ?? "").split(/\r?\n/);
    const cutIndex = lines.findIndex(line => {
        const probe = line.trimEnd();
        return QUOTED_TAIL_PATTERNS.some(pattern => pattern.test(probe));
    });

    const kept = cutIndex === -1 ? lines : lines.slice(0, cutIndex);

    return kept.join("\n").trim();
};

/**
 * Normalize a Message-ID for comparison: angle brackets off, lower-cased.
 *
 * Stored ids keep whatever the SMTP server handed back (`<abc@host>`); envelope
 * and header ids come back both ways depending on the client, so both sides are
 * normalized rather than the stored value being rewritten.
 *
 * @param {string} [value]
 * @returns {string} "" when there was nothing usable
 */
const normalizeMessageId = value =>
    String(value ?? "")
        .trim()
        .replace(/^<|>$/g, "")
        .toLowerCase();

/**
 * Every Message-ID this reply claims to answer.
 *
 * Reads BOTH the parsed envelope (In-Reply-To only) and the raw header block
 * (References, which the envelope does not carry). References is the reliable
 * one on long threads; In-Reply-To is the reliable one on the first reply.
 *
 * @param {object} [message] one imapflow fetch result
 * @param {object} [message.envelope] imapflow envelope
 * @param {Buffer|string} [message.headers] raw HEADER.FIELDS block
 * @returns {string[]} normalized ids, de-duplicated, order preserved
 */
const extractReferencedMessageIds = (message = {}) => {
    const headerText = String(message.headers ?? "");
    const found = [];

    const push = value => {
        const id = normalizeMessageId(value);
        if (id !== "" && !found.includes(id)) {
            found.push(id);
        }
    };

    push(message.envelope?.inReplyTo);

    // Angle-bracketed ids are the only shape RFC 5322 allows inside In-Reply-To
    // and References, so one sweep over the whole block is enough and no
    // header-name parsing is needed.
    const bracketed = headerText.match(/<[^<>\s]+>/g) || [];
    bracketed.forEach(push);

    return found;
};

/**
 * Where this poll starts, given the stored cursor and the mailbox's own state.
 *
 * Pure — the whole reason the 14k-mail rule is testable without a mailbox.
 *
 *   no row            -> seed at uidNext-1: the first poll must see NOTHING.
 *   uidvalidity moved -> the server renumbered everything, so every stored UID
 *                        is meaningless; re-seed at uidNext-1 rather than
 *                        re-reading the box under the new numbering.
 *   otherwise         -> resume from the stored last_uid.
 *
 * @param {object} opts
 * @param {object|null} [opts.cursor] mat_email_poll_cursor row, or null
 * @param {number|string} opts.uidNext mailbox UIDNEXT
 * @param {number|string} opts.uidValidity mailbox UIDVALIDITY
 * @returns {{lastUid: number, uidValidity: number, reason: 'INIT'|'UIDVALIDITY_RESET'|'RESUME'}}
 */
const resolveCursorStart = ({ cursor = null, uidNext, uidValidity } = {}) => {
    const nextUid = Number(uidNext);
    const validity = Number(uidValidity);
    // uidNext is 1-based and 1 means "empty mailbox", so the seed floors at 0.
    const seed = Math.max((Number.isFinite(nextUid) ? nextUid : 1) - 1, 0);

    if (!cursor) {
        return { lastUid: seed, uidValidity: validity, reason: "INIT" };
    }

    if (String(cursor.uidvalidity) !== String(uidValidity)) {
        return {
            lastUid: seed,
            uidValidity: validity,
            reason: "UIDVALIDITY_RESET",
        };
    }

    const storedUid = Number(cursor.last_uid);

    return {
        lastUid: Number.isFinite(storedUid) ? storedUid : seed,
        uidValidity: validity,
        reason: "RESUME",
    };
};

/**
 * The IMAP client for the VMS mailbox.
 *
 * Host/credentials default to the SMTP ones on purpose: replies come back to the
 * address the mail was sent FROM, so polling a different box would be polling
 * the wrong one. rejectUnauthorized:false matches config/connection.js and
 * config/emailer.js — this estate's certificates are internal.
 *
 * @returns {object} an unconnected ImapFlow instance
 */
const createInboundImapClient = () => {
    const client = new ImapFlow({
        host: process.env.IMAP_HOST || process.env.SMTP_HOST,
        port: Number(process.env.IMAP_PORT) || 993,
        secure: true,
        auth: {
            user: process.env.SMTP_USERNAME,
            pass: process.env.SMTP_PASSWORD,
        },
        tls: { rejectUnauthorized: false },
        // The library's own logging is per-command and very loud on a 60s cron.
        logger: false,
    });

    // ImapFlow is an EventEmitter, and a socket that dies between commands —
    // a dropped VPN, an idle timeout — emits 'error' out of band rather than
    // rejecting whatever the poller happens to be awaiting. An EventEmitter
    // with no 'error' listener rethrows, which no try/catch around the poll can
    // catch, so the whole API process would go down with the mailbox. The next
    // tick reconnects from the stored cursor, so logging is the whole handler.
    client.on("error", error => {
        console.error(
            "[rework-email-inbound] IMAP connection error:",
            error && error.message ? error.message : error
        );
    });

    return client;
};

const readPollCursor = async (client, mailbox) => {
    const result = await client.query(
        `SELECT mailbox, uidvalidity, last_uid
           FROM mat_email_poll_cursor
          WHERE mailbox = $1`,
        [mailbox]
    );

    return result.rows[0] ?? null;
};

const savePollCursor = async (client, { mailbox, uidValidity, lastUid }) => {
    await client.query(
        `INSERT INTO mat_email_poll_cursor (mailbox, uidvalidity, last_uid, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (mailbox) DO UPDATE
            SET uidvalidity = EXCLUDED.uidvalidity,
                last_uid    = EXCLUDED.last_uid,
                updated_at  = NOW()`,
        [mailbox, uidValidity, lastUid]
    );
};

/**
 * Find the mat_rework_email row a reply belongs to.
 *
 * Message-ID first: it is the only identifier the approver cannot edit. The
 * subject token is the fallback, and resolves to the LATEST mail carrying it,
 * because a request can be reworked by mail more than once and the newest thread
 * is the one still open.
 *
 * @returns {Promise<object|null>} `{id, to_email}` of the matched mail
 */
const findReworkEmailForReply = async (
    client,
    { referencedIds = [], subject = "" } = {}
) => {
    if (referencedIds.length > 0) {
        const byMessageId = await client.query(
            `SELECT id, to_email
               FROM mat_rework_email
              WHERE message_id IS NOT NULL
                AND lower(btrim(message_id, '<>')) = ANY($1::text[])
              ORDER BY id DESC
              LIMIT 1`,
            [referencedIds]
        );

        if (byMessageId.rows[0]) {
            return byMessageId.rows[0];
        }
    }

    const token = extractReworkEmailToken(subject);

    if (!token) {
        return null;
    }

    // position(), not LIKE: the token goes in verbatim, so a request_no can
    // never be read as a LIKE wildcard.
    const bySubject = await client.query(
        `SELECT id, to_email
           FROM mat_rework_email
          WHERE position($1::text in subject) > 0
          ORDER BY id DESC
          LIMIT 1`,
        [`[VMS#${token}]`]
    );

    return bySubject.rows[0] ?? null;
};

const insertReworkEmailReply = async (client, row = {}) => {
    const result = await client.query(
        `INSERT INTO mat_rework_email_reply (
             rework_email_id,
             from_email,
             sender_matches,
             message_id,
             received_at,
             body_text,
             body_full
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING id`,
        [
            row.reworkEmailId,
            row.fromEmail,
            row.senderMatches,
            row.messageId ?? null,
            row.receivedAt ?? null,
            row.bodyText,
            row.bodyFull ?? null,
        ]
    );

    return result.rowCount > 0;
};

/**
 * Download one message's source and run it through mailparser.
 *
 * Isolated so a single unparseable mail (bad MIME, truncated source) is skipped
 * with a log instead of aborting the whole poll — the cursor has already moved
 * past it, and retrying it forever would wedge the poller.
 *
 * @returns {Promise<object|null>} mailparser result, or null when unreadable
 */
const downloadAndParse = async (imap, uid) => {
    try {
        const { content } = await imap.download(String(uid), undefined, {
            uid: true,
        });

        return await simpleParser(content);
    } catch (error) {
        console.error(
            `[rework-email-inbound] could not read uid ${uid}:`,
            error && error.message
        );
        return null;
    }
};

/**
 * One poll of the VMS mailbox.
 *
 * A transport failure propagates (the cron logs it); it is safe to let it,
 * because the cursor is written only by a pass that reached the end, so the next
 * tick simply re-reads the same UID range. Replays cannot duplicate anything —
 * mat_rework_email_reply.message_id is UNIQUE and the insert is DO NOTHING.
 *
 * @param {object} [opts]
 * @param {string} [opts.mailbox] mailbox to poll; also the cursor key
 * @param {object} [deps] test seam
 * @param {Function} [deps.createClient] returns an ImapFlow-shaped client
 * @returns {Promise<{mailbox: string, reason: string, scanned: number, matched: number, inserted: number, lastUid: number}>}
 */
const pollReworkEmailReplies = async (
    { mailbox = INBOUND_MAILBOX } = {},
    deps = {}
) => {
    const imap = (deps.createClient ?? createInboundImapClient)();
    const summary = {
        mailbox,
        reason: "RESUME",
        scanned: 0,
        matched: 0,
        inserted: 0,
        lastUid: 0,
    };

    await imap.connect();

    try {
        const lock = await imap.getMailboxLock(mailbox);

        try {
            const box = imap.mailbox || {};

            await DBClientWrapper(async client => {
                const cursor = await readPollCursor(client, mailbox);
                const start = resolveCursorStart({
                    cursor,
                    uidNext: box.uidNext,
                    uidValidity: box.uidValidity,
                });

                summary.reason = start.reason;
                summary.lastUid = start.lastUid;

                if (start.reason !== "RESUME") {
                    console.log(
                        `[rework-email-inbound] ${start.reason} on ${mailbox}: cursor seeded at uid ${start.lastUid} (uidvalidity ${start.uidValidity}); history is not scanned`
                    );
                    await savePollCursor(client, {
                        mailbox,
                        uidValidity: start.uidValidity,
                        lastUid: start.lastUid,
                    });
                    return;
                }

                if (!box.exists) {
                    return;
                }

                // `N:*` is inclusive and the server clamps it to the highest
                // existing UID, so an already-caught-up cursor still yields the
                // newest message — hence the explicit `uid > lastUid` guard.
                const range = `${start.lastUid + 1}:*`;
                const headerPass = [];

                // Drain the fetch before doing anything else: an IMAP fetch
                // stream held open across other I/O is how these connections
                // time out mid-iteration. Headers only, so the whole pass is
                // small even on a busy tick.
                for await (const message of imap.fetch(
                    range,
                    {
                        uid: true,
                        envelope: true,
                        headers: INBOUND_HEADER_FIELDS,
                    },
                    { uid: true }
                )) {
                    const uid = Number(message.uid);

                    if (!Number.isFinite(uid) || uid <= start.lastUid) {
                        continue;
                    }

                    headerPass.push({
                        uid,
                        referencedIds: extractReferencedMessageIds(message),
                        subject: message.envelope?.subject ?? "",
                    });
                }

                const candidates = [];

                for (const message of headerPass) {
                    // Counted (and the cursor advanced) whether or not it
                    // matches: an unrelated mail must be examined exactly once.
                    summary.scanned += 1;
                    summary.lastUid = Math.max(summary.lastUid, message.uid);

                    const reworkEmail = await findReworkEmailForReply(
                        client,
                        message
                    );

                    if (reworkEmail) {
                        candidates.push({ uid: message.uid, reworkEmail });
                    }
                }

                summary.matched = candidates.length;

                // Second pass, matches only: the body is the expensive fetch and
                // the overwhelming majority of this mailbox is unrelated mail.
                for (const candidate of candidates) {
                    const parsed = await downloadAndParse(imap, candidate.uid);

                    if (!parsed) {
                        continue;
                    }

                    const fromEmail = String(
                        parsed.from?.value?.[0]?.address ?? ""
                    )
                        .trim()
                        .toLowerCase();
                    const bodyFull = String(parsed.text ?? "");
                    const stripped = stripQuotedReply(bodyFull);

                    const inserted = await insertReworkEmailReply(client, {
                        reworkEmailId: candidate.reworkEmail.id,
                        fromEmail,
                        senderMatches:
                            fromEmail !== "" &&
                            fromEmail ===
                                String(candidate.reworkEmail.to_email ?? "")
                                    .trim()
                                    .toLowerCase(),
                        messageId: parsed.messageId ?? null,
                        receivedAt: parsed.date ?? null,
                        // A bottom-posted reply strips to nothing; showing the
                        // untouched text beats showing an empty card.
                        bodyText: stripped === "" ? bodyFull.trim() : stripped,
                        bodyFull,
                    });

                    if (inserted) {
                        summary.inserted += 1;
                    }
                }

                await savePollCursor(client, {
                    mailbox,
                    uidValidity: start.uidValidity,
                    lastUid: summary.lastUid,
                });
            });
        } finally {
            lock.release();
        }
    } finally {
        // logout() is the polite QUIT; close() is the guaranteed teardown, so a
        // half-dead connection can never leak into the next tick.
        try {
            await imap.logout();
        } catch (logoutError) {
            console.error(
                "[rework-email-inbound] logout failed:",
                logoutError && logoutError.message
            );
            if (typeof imap.close === "function") {
                imap.close();
            }
        }
    }

    return summary;
};

module.exports = {
    INBOUND_MAILBOX,
    INBOUND_HEADER_FIELDS,
    QUOTED_TAIL_PATTERNS,
    stripQuotedReply,
    normalizeMessageId,
    extractReferencedMessageIds,
    resolveCursorStart,
    createInboundImapClient,
    readPollCursor,
    savePollCursor,
    findReworkEmailForReply,
    insertReworkEmailReply,
    pollReworkEmailReplies,
};
