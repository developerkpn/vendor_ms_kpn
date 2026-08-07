// Rework -> new-approver notification: PLAIN-TEXT template composer.
//
// Chain-replacement rework (Master Data swaps a request's manual approver chain
// for a fresh one) can tell the new Approval 1 by mail. This module turns the
// request's own data into the Indonesian draft Master Data sees in the dialog,
// edits, and sends — nothing here sends anything, reads the network, or reads
// the environment, so the wording stays unit-testable without a transport.
//
// The subject always carries a `[VMS#<request_no>]` token. It is the thread key
// the inbound poller falls back to when a mail client drops In-Reply-To /
// References, so it must survive Master Data's edits — ensureSubjectToken puts
// it back if the editor deleted it.
//
// Plain text, not HTML, on purpose: the reply comes back through
// stripQuotedReply, and a text/plain original keeps the approver's answer and
// the quoted tail separable by line heuristics.

// One partition of the token so the format is written once. Anything but `]`
// and whitespace is a legal request_no here — the numbering schemes in play are
// 1xxxxxxxxx (single) / 3xxxxxxxxx (mass item), but the token is matched, not
// parsed, so it never has to know that.
const REWORK_EMAIL_TOKEN_PATTERN = /\[VMS#([^\]\s]+)\]/;

/** Longest PO-text / spec excerpt carried into the mail body before ellipsis. */
const EXCERPT_MAX_LENGTH = 240;

/** Label column width, so the plain-text field block lines up in any client. */
const LABEL_WIDTH = 22;

/**
 * The thread token for a request number.
 *
 * @param {string|number} requestNo request_no of the thread's request
 * @returns {string} e.g. `[VMS#1000000810]`
 */
const buildReworkEmailToken = requestNo =>
    `[VMS#${String(requestNo ?? "").trim()}]`;

/**
 * Pull the request number back out of a subject line.
 *
 * @param {string} [subject] any subject, including a `Re: ...` reply subject
 * @returns {string|null} the request_no inside the token, or null when absent
 */
const extractReworkEmailToken = subject => {
    const match = REWORK_EMAIL_TOKEN_PATTERN.exec(String(subject ?? ""));
    return match ? match[1] : null;
};

/**
 * Guarantee the subject carries the thread token.
 *
 * Appended, never prepended: Master Data writes the human part of the subject,
 * and a token in front of it is the first thing an approver reads. A subject
 * that already carries ANY token is left byte-for-byte alone — re-tokenizing a
 * hand-corrected subject would put two tokens on one thread.
 *
 * @param {string} [subject] subject as edited by Master Data
 * @param {string|number} requestNo request_no the thread belongs to
 * @returns {string} subject that always matches REWORK_EMAIL_TOKEN_PATTERN
 */
const ensureSubjectToken = (subject, requestNo) => {
    const safeSubject = String(subject ?? "").trim();
    const token = buildReworkEmailToken(requestNo);

    if (REWORK_EMAIL_TOKEN_PATTERN.test(safeSubject)) {
        return safeSubject;
    }

    return safeSubject === "" ? token : `${safeSubject} ${token}`;
};

const asText = value =>
    value === undefined || value === null ? "" : String(value).trim();

const orDash = value => {
    const text = asText(value);
    return text === "" ? "-" : text;
};

/**
 * Collapse a long free-text field to one readable excerpt.
 *
 * Newlines become spaces first: the field block is a label/value table, and a
 * raw newline inside a value would break the alignment the approver reads.
 */
const excerpt = (value, limit = EXCERPT_MAX_LENGTH) => {
    const text = asText(value).replace(/\s+/g, " ");

    if (text === "") return "-";

    return text.length <= limit ? text : `${text.slice(0, limit)}...`;
};

const field = (label, value) => `${label.padEnd(LABEL_WIDTH)}: ${value}`;

/**
 * Plant + storage location as one cell, e.g. `EU73 / ST01`.
 */
const plantSloc = (plantCode, slocCode) => {
    const plant = asText(plantCode);
    const sloc = asText(slocCode);

    if (plant === "" && sloc === "") return "-";

    return `${plant === "" ? "-" : plant} / ${sloc === "" ? "-" : sloc}`;
};

// Closing block, identical on both kinds: the reply instruction (the whole
// point of the mail — the answer has to come back as a REPLY so the poller can
// thread it).
const REWORK_EMAIL_CLOSING = [
    "Mohon membalas email ini dengan hasil review atau tanggapan Anda.",
    "",
    "Terima kasih.",
    "Vendor Management System (VMS)",
].join("\n");

const REWORK_EMAIL_GREETING = "Kepada Yth. Approver,";

/**
 * The greeting line, addressed to the picked approver when his name is known.
 *
 * Pure string work on purpose: the caller resolves the name from mst_user, and
 * every way of not having one — no id asked about, no active row, an account
 * with a blank fullname — arrives here as an empty string and falls back to the
 * generic greeting rather than producing `Kepada Yth. ,`.
 *
 * @param {string} [approverName] fullname of the picked approver
 * @returns {string} e.g. `Kepada Yth. Budi Santoso,`
 */
const buildReworkEmailGreeting = approverName => {
    const name = asText(approverName);
    return name === "" ? REWORK_EMAIL_GREETING : `Kepada Yth. ${name},`;
};

/**
 * Compose the rework mail for a SINGLE material request.
 *
 * Thread identity is `request_no` — the same number the request is known by
 * everywhere else in VMS.
 *
 * @param {object} [row] a mat_single_request row as the existing list loader
 *                       returns it (runSingleRequestListQuery): `ticket_number`
 *                       is the request_no, `uom` the base UOM, and
 *                       long_text_1..3 the PO-text partition.
 * @param {object} [options]
 * @param {string} [options.approverName] fullname of the picked approver, when
 *                                        the dialog asked about one
 * @returns {{subject: string, body: string, requestNo: string}}
 */
const buildSingleReworkEmailTemplate = (row = {}, { approverName } = {}) => {
    const requestNo = asText(row.ticket_number ?? row.request_no);
    // long_text_1..3 are ONE 250-char box positionally partitioned (40 + 3x70),
    // so they concatenate back separator-less — see buildMaterialStagingPayload.
    const poText = [row.long_text_1, row.long_text_2, row.long_text_3]
        .map(part => (part === undefined || part === null ? "" : String(part)))
        .join("");

    const body = [
        buildReworkEmailGreeting(approverName),
        "",
        "Permintaan material berikut dikembalikan oleh Master Data dan kini",
        "menunggu review Anda di VMS.",
        "",
        field("No. Request", orDash(requestNo)),
        field("Jenis Ticket", orDash(row.ticket_type)),
        field("Deskripsi Material", orDash(row.material_description)),
        field("Plant / Sloc", plantSloc(row.plant_code, row.sloc_code)),
        field("Base UOM", orDash(row.uom ?? row.base_uom)),
        field("PO Text / Spesifikasi", excerpt(poText)),
        "",
        REWORK_EMAIL_CLOSING,
    ].join("\n");

    return {
        subject: ensureSubjectToken(
            `Review Request Material ${orDash(requestNo)}`,
            requestNo
        ),
        body,
        requestNo,
    };
};

/**
 * Compose the rework mail for a MASS material request (the whole batch — mass
 * rework always acts on every item at once).
 *
 * Thread identity is the FIRST item's request_no (item_no ASC): that is the
 * exact row requestMassRequestRework locks FOR UPDATE and status-gates the
 * batch on, so the token names the same row the rework flow already treats as
 * the batch's representative.
 *
 * Description / base UOM / PO text live on the ITEMS, not on the batch, so they
 * appear in the numbered list rather than in the field block — a batch has N of
 * each and picking one for a header line would misdescribe the other N-1.
 * Plant + storage location DO go in the field block when the batch is uniform
 * (the normal case, one grid = one plant); when it is not, the block says so
 * and each item line carries its own.
 *
 * @param {Array<object>} [items] mat_mass_request_item rows as the existing
 *                                loader returns them (getMassRequestItems),
 *                                ordered by item_no
 * @param {object} [options]
 * @param {string} [options.approverName] fullname of the picked approver, when
 *                                        the dialog asked about one
 * @returns {{subject: string, body: string, requestNo: string}}
 */
const buildMassReworkEmailTemplate = (items = [], { approverName } = {}) => {
    const rows = Array.isArray(items) ? items : [];
    const firstItem = rows[0] ?? {};
    const requestNo = asText(firstItem.request_no);

    const locations = new Set(
        rows.map(item => plantSloc(item.plant_code, item.sloc_code))
    );
    const uniformLocation = locations.size === 1;

    const itemLines = rows.flatMap((item, index) => {
        const itemNo = asText(item.item_no) || String(index + 1);
        const lines = [
            `${itemNo}. ${orDash(item.material_description)} (UOM: ${orDash(
                item.uom ?? item.base_uom
            )})`,
            `   No. Item             : ${orDash(item.request_no)}`,
        ];

        if (!uniformLocation) {
            lines.push(
                `   Plant / Sloc         : ${plantSloc(
                    item.plant_code,
                    item.sloc_code
                )}`
            );
        }

        lines.push(
            `   PO Text / Spesifikasi: ${excerpt(
                [item.po_text, item.spesifikasi_tambahan]
                    .filter(part => asText(part) !== "")
                    .join(" - ")
            )}`
        );

        return lines;
    });

    const body = [
        buildReworkEmailGreeting(approverName),
        "",
        "Permintaan material massal berikut dikembalikan oleh Master Data dan",
        "kini menunggu review Anda di VMS.",
        "",
        field("No. Request", orDash(requestNo)),
        field("Jenis Ticket", orDash(firstItem.ticket_type)),
        field(
            "Plant / Sloc",
            uniformLocation
                ? plantSloc(firstItem.plant_code, firstItem.sloc_code)
                : "(berbeda per item)"
        ),
        field("Jumlah Item", String(rows.length)),
        "",
        "Daftar item:",
        ...(itemLines.length > 0 ? itemLines : ["(tidak ada item)"]),
        "",
        REWORK_EMAIL_CLOSING,
    ].join("\n");

    return {
        subject: ensureSubjectToken(
            `Review Request Material Massal ${orDash(requestNo)}`,
            requestNo
        ),
        body,
        requestNo,
    };
};

module.exports = {
    REWORK_EMAIL_TOKEN_PATTERN,
    buildReworkEmailToken,
    extractReworkEmailToken,
    ensureSubjectToken,
    buildReworkEmailGreeting,
    buildSingleReworkEmailTemplate,
    buildMassReworkEmailTemplate,
};
