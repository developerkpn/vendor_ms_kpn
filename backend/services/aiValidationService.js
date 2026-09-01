/**
 * Integration with the external AI document-validation service (AWS Bedrock,
 * built by the CDT team — see KPN_VMS_INTEGRATION_GUIDE.md).
 *
 * Two legs, and they are asynchronous with respect to each other:
 *
 *   1. OUTBOUND. On vendor submit we POST the typed form values plus public
 *      URLs for every uploaded document to /validate. The service answers 202
 *      with a request_id in under 3s and does the actual OCR work off-line.
 *   2. INBOUND. ~30s later it POSTs the verdict to our own webhook, HMAC
 *      signed. See AiValidationController for the raw-body handling.
 *
 * ADVISORY ONLY. Nothing here touches the approval chain, the ticket, or the
 * vendor row. The verdict is stored and shown to Procurement/MDM; a human
 * still decides. Keep it that way — an OCR misread must not be able to stall a
 * real registration.
 *
 * The whole integration is off unless AI_VALIDATION_ENABLED === "true", so a
 * deployment with no credentials configured behaves exactly as before.
 */

const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const moment = require("moment");
const DBClientWrapper = require("../helper/DBClientWrapper");
const {
    mapFileCodeToAiType,
    ACCEPTED_EXTENSIONS,
    MAX_DOCUMENTS,
    MIN_DOCUMENTS,
    MIN_FILE_BYTES,
    STALE_RUN_MINUTES,
    SIGNATURE_MAX_AGE_SECONDS,
    SUBMIT_STATUS,
    DEFAULT_BU,
} = require("../constants/aiValidation");

// Read on every call rather than at module load: dotenv populates process.env
// from server.js, and the cron/test entry points import this file at unrelated
// times.
function getConfig() {
    return {
        enabled: process.env.AI_VALIDATION_ENABLED === "true",
        apiUrl: process.env.AI_VALIDATION_API_URL || "",
        apiKey: process.env.AI_VALIDATION_API_KEY || "",
        hmacSecret: process.env.AI_VALIDATION_HMAC_SECRET || "",
        callbackUrl: process.env.AI_VALIDATION_CALLBACK_URL || "",
        fileBaseUrl: (process.env.AI_VALIDATION_FILE_BASE_URL || "").replace(
            /\/+$/,
            ""
        ),
        timeoutMs: Number(process.env.AI_VALIDATION_TIMEOUT_MS || 15000),
    };
}

/**
 * Address fields are stored as up to four street lines. The service wants one
 * combined string and explicitly does not want them split, so join the
 * non-empty parts.
 */
function joinAddress(...parts) {
    return parts
        .map(p => (p === null || p === undefined ? "" : String(p).trim()))
        .filter(p => p.length > 0)
        .join(", ");
}

function asText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

/**
 * local | foreign, for the service's `vendor_type`.
 *
 * The two BUs disagree about which column holds this. UPS/DWS put LOCAL/OVS in
 * vendor.local_ovs and use ven_type for the commodity (MATERIAL, CONTRACTOR…).
 * The CG form has no local_ovs control at all — its "Vendor Type" dropdown
 * (LOCAL / OVERSEAS / PRIVATE / GOVERNMENT) is stored in ven_type, so a CG
 * vendor has local_ovs NULL. Reading only local_ovs made every CG vendor
 * "foreign", which is how PRC-26080637 went out mislabelled.
 *
 * Only an explicit overseas marker means foreign: PRIVATE and GOVERNMENT are
 * Indonesian entities, and defaulting an unknown to foreign is the error we
 * just made.
 */
function resolveVendorType(vendor) {
    const flag = (asText(vendor.local_ovs) || asText(vendor.ven_type)).toUpperCase();
    return flag === "OVS" || flag === "OVERSEAS" ? "foreign" : "local";
}

function fileExtension(fileName) {
    const parts = asText(fileName).split(".");
    if (parts.length < 2) return "";
    return parts[parts.length - 1].toLowerCase();
}

/**
 * Size of an attachment as it sits on disk, or null if it cannot be measured.
 *
 * Uploads land in backend/public and are served from there by
 * GET /api/master/file/:filename, so the bytes the AI service will fetch are
 * the bytes we can stat locally.
 *
 * Returning null on any failure is deliberate — see buildDocuments. We only act
 * on a size we positively know.
 */
function fileSizeOnDisk(fileName) {
    try {
        return fs.statSync(path.join(path.resolve(), "backend/public", fileName)).size;
    } catch (error) {
        return null;
    }
}

/**
 * Pulls everything the payload needs in one place: the vendor row, its ticket
 * (for BU and the numbers we log against), the primary bank, and every
 * attachment.
 */
async function loadVendorContext(client, ven_id) {
    const { rows: vendorRows } = await client.query(
        `select
            v.*,
            t.token as ticket_token,
            t.ticket_id as ticket_num,
            tr.bu_id as bu_id
        from vendor v
        left join ticket t on t.ven_id = v.ven_id
        left join ticket_rule tr on tr.doctype = t.approval_type
        where v.ven_id = $1
        order by t.created_at desc nulls last
        limit 1`,
        [ven_id]
    );
    if (vendorRows.length === 0) {
        throw new Error(`Vendor ${ven_id} not found`);
    }

    // One bank goes into the payload — informasi_bank is a single object on
    // the service side. Vendors normally register exactly one; if there are
    // several, the oldest active one is the primary account.
    const { rows: bankRows } = await client.query(
        // ven_bank.bank_id points at a different master per BU: UPS/DWS store a
        // numeric mst_bank.id ("191"), CG stores a cg_mst_bank.bank_code
        // ("MEGAIDJA"). Joining only mst_bank sent every CG vendor an empty
        // nama_bank, which the service scores HIGH — that is what happened on
        // PRC-26080638. Try both masters and take whichever resolves.
        `select
            vb.bankv_id,
            vb.bank_acc,
            vb.acc_hold,
            coalesce(mb.bank_name, cb.bank_name) as bank_name
        from ven_bank vb
        left join mst_bank mb on mb.id::text = vb.bank_id::text
        left join cg_mst_bank cb on cb.bank_code = vb.bank_id
        where vb.ven_id = $1
          and vb.is_active is not false
        order by vb.created_at asc nulls last
        limit 1`,
        [ven_id]
    );

    // Bank attachments (A001/A002) carry a bank_id, but that column is only
    // populated correctly on newer rows — 360 of 442 dev rows point at a
    // bankv_id that no longer exists. ven_id is set on every one of them, so
    // select by ven_id and let the per-code dedupe below drop leftovers from
    // banks the vendor has since replaced.
    const { rows: fileRows } = await client.query(
        `select
            fa.file_id,
            fa.file_name,
            fa.file_type as file_code,
            fa.expired_date,
            fa.created_at
        from ven_file_atth fa
        where fa.ven_id = $1
          and fa.file_name is not null
        order by fa.created_at desc nulls last, fa.id desc`,
        [ven_id]
    );

    return {
        vendor: vendorRows[0],
        bank: bankRows[0] || null,
        files: fileRows,
    };
}

/**
 * Turns VMS attachments into the service's `documents` array.
 *
 * Returns both the documents and the reasons anything was left out, so the
 * caller can persist why a payload looks thin instead of leaving support to
 * guess.
 */
function buildDocuments({ files, bu_id, fileBaseUrl }) {
    const documents = [];
    const skipped = [];
    const seenCodes = new Set();

    for (const file of files) {
        const aiType = mapFileCodeToAiType(bu_id || DEFAULT_BU, file.file_code);
        if (!aiType) {
            // Not part of the AI vocabulary (KTP, forms, Others, …) — expected.
            continue;
        }

        // Newest row per file_code wins; files are ordered newest-first.
        //
        // This does NOT truncate multi-page documents, because a file_code only
        // ever holds one file: UploadButton disables itself once a type has an
        // attachment, and the upload endpoint persists uploaded_files[0] only.
        // Genuinely multi-page documents arrive under DISTINCT codes — a UPS
        // Pakta Integritas is A004 (Pg.1) plus A004b (Pg.2), both of which map
        // to the same AI type and are both sent. A CG Kode Etik is one merged
        // file.
        //
        // What this does drop is duplication, of which ven_file_atth has two
        // kinds: the submit path inserts the same file_id twice (observed on
        // PRC-26080637 — ids 5652/5658 share file_id b51e1226), and attachments
        // from an abandoned earlier attempt are never cleared. Sending those
        // makes the service score the same document repeatedly and burns the
        // 20-document cap.
        if (seenCodes.has(file.file_code)) {
            skipped.push({
                file_name: file.file_name,
                file_code: file.file_code,
                reason: "superseded_by_newer_upload",
            });
            continue;
        }

        const ext = fileExtension(file.file_name);
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
            // VMS upload also accepts doc/docx; the service would 400 on them.
            skipped.push({
                file_name: file.file_name,
                file_code: file.file_code,
                reason: "unsupported_file_type",
            });
            continue;
        }

        // Undersized files are the worst failure mode this integration has: the
        // service accepts the request with 202 and then dies silently during
        // async processing, so the run hangs forever with nothing to read. Catch
        // it here, where we can name the file.
        //
        // Fails OPEN on an unmeasurable file. A null size means we could not
        // stat it — a path assumption that does not hold, a permissions problem
        // — not evidence the file is bad. Dropping a document the service could
        // have fetched perfectly well would be the worse error.
        const sizeBytes = fileSizeOnDisk(file.file_name);
        if (sizeBytes !== null && sizeBytes < MIN_FILE_BYTES) {
            skipped.push({
                file_name: file.file_name,
                file_code: file.file_code,
                reason: `file_too_small (${sizeBytes} bytes, minimum ${MIN_FILE_BYTES})`,
            });
            continue;
        }

        if (documents.length >= MAX_DOCUMENTS) {
            skipped.push({
                file_name: file.file_name,
                file_code: file.file_code,
                reason: "document_cap_reached",
            });
            continue;
        }

        seenCodes.add(file.file_code);
        documents.push({
            type: aiType,
            file_url: `${fileBaseUrl}/${encodeURIComponent(file.file_name)}`,
            file_name: file.file_name,
            expired_date: file.expired_date
                ? moment(file.expired_date).format("YYYY-MM-DD")
                : null,
        });
    }

    return { documents, skipped };
}

/**
 * Builds the exact body sent to POST /validate.
 *
 * Every form_data key is present even when empty — the contract says leave the
 * value as "" rather than omitting the key, because an absent key reads as
 * "not applicable" and a present-but-empty one reads as "same as domisili".
 */
function buildPayload({ vendor, bank, files, config }) {
    const { documents, skipped } = buildDocuments({
        files,
        bu_id: vendor.bu_id,
        fileBaseUrl: config.fileBaseUrl,
    });

    const payload = {
        registration_id: vendor.ven_id,
        vendor_type: resolveVendorType(vendor),
        callback_url: config.callbackUrl,
        form_data: {
            detail_perusahaan: {
                nama_perusahaan: asText(vendor.name_1),
                nomor_telepon_kantor: asText(vendor.telf1),
                email: asText(vendor.email),
            },
            organisasi_perusahaan: {
                nama_direktur: asText(vendor.nama_direktur),
                nama_pic: asText(vendor.nama_pic),
            },
            alamat_domisili: {
                alamat: joinAddress(
                    vendor.street,
                    vendor.street2,
                    vendor.street3,
                    vendor.street4
                ),
                kota: asText(vendor.city),
            },
            alamat_npwp: {
                alamat: joinAddress(
                    vendor.street_npwp,
                    vendor.street2_npwp,
                    vendor.street3_npwp,
                    vendor.street4_npwp
                ),
                kota: asText(vendor.city_npwp),
            },
            alamat_sppkp: {
                alamat: joinAddress(
                    vendor.street_sppkp,
                    vendor.street2_sppkp,
                    vendor.street3_sppkp,
                    vendor.street4_sppkp
                ),
                kota: asText(vendor.city_sppkp),
            },
            pajak_dan_pembayaran: {
                nomor_npwp: asText(vendor.npwp),
                pengusaha_kena_pajak: vendor.is_pkp === true,
            },
            informasi_bank: {
                nama_bank: asText(bank && bank.bank_name),
                rekening_bank: asText(bank && bank.bank_acc),
                pemegang_rekening: asText(bank && bank.acc_hold),
            },
        },
        documents,
    };

    return { payload, skipped };
}

async function insertRun(client, row) {
    const { rows } = await client.query(
        `insert into ai_validation (
            ven_id, ticket_token, ticket_num, bu_id,
            registration_id, request_id, vendor_type,
            submit_status, submit_error, request_payload
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning id, ven_id, request_id, submit_status`,
        [
            row.ven_id,
            row.ticket_token,
            row.ticket_num,
            row.bu_id,
            row.registration_id,
            row.request_id,
            row.vendor_type,
            row.submit_status,
            row.submit_error,
            row.request_payload ? JSON.stringify(row.request_payload) : null,
        ]
    );
    return rows[0];
}

/**
 * Submits one vendor registration for validation.
 *
 * Never throws for the caller's benefit: every outcome — disabled, misconfigured,
 * nothing to send, 400, network failure — is recorded and returned. The submit
 * path is fire-and-forget from the ticket flow and must not be able to fail a
 * vendor's submission.
 *
 * @param {string} ven_id
 * @returns {Promise<{skipped: boolean, reason?: string, run?: object}>}
 */
async function submitValidation(ven_id) {
    const config = getConfig();

    if (!config.enabled) {
        return { skipped: true, reason: "disabled" };
    }
    if (!config.apiUrl || !config.apiKey || !config.callbackUrl) {
        console.warn(
            "[AI-VALIDATION] enabled but AI_VALIDATION_API_URL / _API_KEY / _CALLBACK_URL is missing — skipping"
        );
        return { skipped: true, reason: "not_configured" };
    }
    if (!config.fileBaseUrl) {
        console.warn(
            "[AI-VALIDATION] AI_VALIDATION_FILE_BASE_URL is missing — the service cannot fetch documents, skipping"
        );
        return { skipped: true, reason: "not_configured" };
    }

    return DBClientWrapper(async client => {
        const { vendor, bank, files } = await loadVendorContext(client, ven_id);
        const { payload, skipped } = buildPayload({
            vendor,
            bank,
            files,
            config,
        });

        const base = {
            ven_id: vendor.ven_id,
            ticket_token: vendor.ticket_token || null,
            ticket_num: vendor.ticket_num || null,
            bu_id: vendor.bu_id || null,
            registration_id: payload.registration_id,
            vendor_type: payload.vendor_type,
            request_payload: payload,
        };

        if (payload.documents.length < MIN_DOCUMENTS) {
            const detail = skipped.length
                ? `no validatable documents (${skipped
                      .map(s => `${s.file_name}: ${s.reason}`)
                      .join("; ")})`
                : "no validatable documents uploaded";
            const run = await insertRun(client, {
                ...base,
                request_id: null,
                submit_status: SUBMIT_STATUS.SKIPPED,
                submit_error: detail,
            });
            console.warn(`[AI-VALIDATION] ${ven_id}: ${detail}`);
            return { skipped: true, reason: "no_documents", run };
        }

        if (skipped.length) {
            console.warn(
                `[AI-VALIDATION] ${ven_id}: ${skipped.length} attachment(s) not sent —`,
                skipped
            );
        }

        let response;
        try {
            response = await axios.post(config.apiUrl, payload, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": config.apiKey,
                },
                timeout: config.timeoutMs,
                // Inspect every status ourselves so a 400 is stored with its
                // reasons instead of surfacing as an opaque axios throw.
                validateStatus: () => true,
            });
        } catch (error) {
            const run = await insertRun(client, {
                ...base,
                request_id: null,
                submit_status: SUBMIT_STATUS.ERROR,
                submit_error: `transport: ${error.message}`,
            });
            console.error(
                `[AI-VALIDATION] ${ven_id}: transport failure —`,
                error.message
            );
            return { skipped: true, reason: "transport_error", run };
        }

        if (
            response.status === 202 &&
            response.data &&
            response.data.request_id
        ) {
            const run = await insertRun(client, {
                ...base,
                request_id: response.data.request_id,
                submit_status: SUBMIT_STATUS.PROCESSING,
                // Anything left out is recorded even on a successful submit, so
                // a reviewer reading a thin result can see WHICH document was
                // dropped and why, rather than wondering what got scored.
                submit_error: skipped.length
                    ? `not sent: ${skipped
                          .map(s => `${s.file_name} (${s.reason})`)
                          .join("; ")}`
                    : null,
            });
            console.log(
                `[AI-VALIDATION] ${ven_id}: queued as ${response.data.request_id} (${payload.documents.length} documents)`
            );
            return { skipped: false, run };
        }

        const isRejection = response.status === 400;
        const run = await insertRun(client, {
            ...base,
            request_id: null,
            submit_status: isRejection
                ? SUBMIT_STATUS.REJECTED
                : SUBMIT_STATUS.ERROR,
            submit_error: `HTTP ${response.status}: ${JSON.stringify(
                response.data
            )}`.slice(0, 4000),
        });
        console.error(
            `[AI-VALIDATION] ${ven_id}: HTTP ${response.status}`,
            response.data
        );
        return {
            skipped: true,
            reason: isRejection ? "rejected" : "http_error",
            run,
        };
    });
}

/**
 * Fire-and-forget wrapper for the ticket submit path.
 *
 * Deliberately not awaited by the caller and deliberately swallowing
 * everything: the vendor's submission has already committed by the time this
 * runs, and no failure of an advisory check may surface as a submit error.
 */
function submitValidationInBackground(ven_id) {
    setImmediate(() => {
        submitValidation(ven_id).catch(error => {
            console.error(
                `[AI-VALIDATION] background submit failed for ${ven_id}:`,
                error && error.message
            );
        });
    });
}

/**
 * Verifies the webhook HMAC.
 *
 * The signature covers `${timestamp}.${rawBody}` — the raw bytes, not a
 * re-serialised object, so the caller must hand over the untouched body.
 *
 * @param {string} rawBody
 * @param {string} signature value of x-validation-signature
 * @param {string} timestamp value of x-validation-timestamp
 * @returns {{valid: boolean, reason?: string}}
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
    const { hmacSecret } = getConfig();
    if (!hmacSecret) {
        return { valid: false, reason: "hmac_secret_not_configured" };
    }

    const rawTimestamp = String(timestamp === undefined || timestamp === null ? "" : timestamp);
    const ts = parseInt(rawTimestamp, 10);
    if (!Number.isFinite(ts)) {
        return { valid: false, reason: "missing_timestamp" };
    }
    if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_MAX_AGE_SECONDS) {
        return { valid: false, reason: "stale_timestamp" };
    }

    // Sign over the header EXACTLY as received, not the parsed integer. The
    // sender builds its digest from the string it put in the header, so any
    // round-trip through parseInt — a leading zero, surrounding whitespace, a
    // decimal — would yield a different digest and reject a valid callback.
    // The parsed value above is only for the staleness window.
    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", hmacSecret)
            .update(`${rawTimestamp}.${rawBody}`)
            .digest("hex");

    const provided = Buffer.from(String(signature || ""), "utf-8");
    const expectedBuf = Buffer.from(expected, "utf-8");
    // timingSafeEqual throws on a length mismatch, so the length check is not
    // an optimisation — it is what keeps a truncated signature from 500ing.
    if (provided.length !== expectedBuf.length) {
        return { valid: false, reason: "invalid_signature" };
    }
    if (!crypto.timingSafeEqual(provided, expectedBuf)) {
        return { valid: false, reason: "invalid_signature" };
    }
    return { valid: true };
}

/**
 * Persists a verdict.
 *
 * Idempotent on request_id: the service retries 3x (5s/15s/45s) with the same
 * body, so re-delivery overwrites the same row rather than stacking duplicates.
 * A verdict for a request_id we never issued still lands — as its own row —
 * because losing a real result is worse than storing an unmatched one.
 */
async function storeValidationResult(payload) {
    const requestId = asText(payload.request_id);
    const registrationId = asText(payload.registration_id);
    if (!requestId) {
        throw new Error("Webhook payload has no request_id");
    }

    return DBClientWrapper(async client => {
        const values = [
            payload.status || null,
            payload.recommendation || null,
            payload.overall_score === null ||
            payload.overall_score === undefined
                ? null
                : payload.overall_score,
            payload.processed_at || null,
            payload.document_results
                ? JSON.stringify(payload.document_results)
                : null,
            payload.cross_doc_check
                ? JSON.stringify(payload.cross_doc_check)
                : null,
            payload.discrepancy_summary
                ? JSON.stringify(payload.discrepancy_summary)
                : null,
            payload.metadata ? JSON.stringify(payload.metadata) : null,
            JSON.stringify(payload),
            requestId,
        ];

        const { rows: updated } = await client.query(
            `update ai_validation set
                status = $1,
                recommendation = $2,
                overall_score = $3,
                processed_at = $4,
                document_results = $5,
                cross_doc_check = $6,
                discrepancy_summary = $7,
                result_metadata = $8,
                result_payload = $9,
                result_received_at = NOW(),
                updated_at = NOW()
            where request_id = $10
            returning id, ven_id`,
            values
        );

        if (updated.length > 0) {
            return { matched: true, ...updated[0] };
        }

        // No outbound row for this request_id. Happens if the 202 write lost a
        // race with a very fast webhook, or if someone replays an old result.
        // Keep the verdict; registration_id is ven_id by construction.
        console.warn(
            `[AI-VALIDATION] webhook for unknown request_id ${requestId} — storing as orphan run`
        );
        const { rows: inserted } = await client.query(
            `insert into ai_validation (
                ven_id, registration_id, request_id, vendor_type,
                submit_status, submit_error,
                status, recommendation, overall_score, processed_at,
                document_results, cross_doc_check, discrepancy_summary,
                result_metadata, result_payload, result_received_at
            ) values (
                $11, $11, $10, 'unknown',
                $12, 'result arrived without a matching submit record',
                $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
            )
            on conflict (request_id) where request_id is not null
            do update set
                status = excluded.status,
                recommendation = excluded.recommendation,
                overall_score = excluded.overall_score,
                processed_at = excluded.processed_at,
                document_results = excluded.document_results,
                cross_doc_check = excluded.cross_doc_check,
                discrepancy_summary = excluded.discrepancy_summary,
                result_metadata = excluded.result_metadata,
                result_payload = excluded.result_payload,
                result_received_at = NOW(),
                updated_at = NOW()
            returning id, ven_id`,
            [...values, registrationId || "UNKNOWN", SUBMIT_STATUS.ERROR]
        );
        return { matched: false, ...inserted[0] };
    });
}

/**
 * Marks runs that can no longer complete.
 *
 * A run sits at PROCESSING from the moment the service returns 202 until its
 * webhook arrives. If that webhook never comes there is nothing to end the
 * wait: the service exposes no status endpoint to poll, and its retry ladder
 * (5s/15s/45s) is spent within a minute of processing. The row would otherwise
 * claim "Processing…" indefinitely and a dead run would be indistinguishable
 * from a slow one — which is exactly what happened on 2026-08-13, when four
 * requests were accepted and none ever called back.
 *
 * This does NOT recover a result and does not retry — it only stops the UI
 * asserting something false. A late webhook still lands: storeValidationResult
 * matches on request_id and overwrites, whatever submit_status says.
 *
 * @returns {Promise<Array<{id: string, ven_id: string, request_id: string}>>}
 */
async function sweepStaleValidations() {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `update ai_validation
                set submit_status = $1,
                    submit_error = coalesce(submit_error || ' | ', '')
                        || 'no webhook received within ${STALE_RUN_MINUTES} minutes; marked stale by sweeper',
                    updated_at = NOW()
              where submit_status = $2
                and status is null
                and created_at < NOW() - ($3 || ' minutes')::interval
          returning id, ven_id, request_id`,
            [SUBMIT_STATUS.ERROR, SUBMIT_STATUS.PROCESSING, String(STALE_RUN_MINUTES)]
        );
        if (rows.length) {
            console.warn(
                `[AI-VALIDATION] swept ${rows.length} stale run(s):`,
                rows.map(r => r.request_id).join(", ")
            );
        }
        return rows;
    });
}

/**
 * Newest run for a vendor — what the form panel reads. Returns null when the
 * vendor has never been validated.
 */
async function getLatestValidation(ven_id) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `select
                id, ven_id, ticket_num, bu_id, request_id, vendor_type,
                submit_status, submit_error,
                status, recommendation, overall_score, processed_at,
                document_results, cross_doc_check, discrepancy_summary,
                result_metadata, result_received_at,
                created_at, updated_at,
                jsonb_array_length(coalesce(request_payload -> 'documents', '[]'::jsonb)) as documents_sent
            from ai_validation
            where ven_id = $1
            order by created_at desc, id desc
            limit 1`,
            [ven_id]
        );
        return rows[0] || null;
    });
}

/**
 * Full run history for a vendor, newest first. Used by the panel's "previous
 * runs" list so a rework cycle is visible.
 */
async function getValidationHistory(ven_id) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `select
                id, request_id, submit_status, status, recommendation,
                overall_score, created_at, result_received_at
            from ai_validation
            where ven_id = $1
            order by created_at desc, id desc
            limit 20`,
            [ven_id]
        );
        return rows;
    });
}

module.exports = {
    submitValidation,
    submitValidationInBackground,
    verifyWebhookSignature,
    storeValidationResult,
    sweepStaleValidations,
    getLatestValidation,
    getValidationHistory,
    // exported for tests / debugging
    buildPayload,
    buildDocuments,
    joinAddress,
};
