/**
 * Constants for the external AI document-validation service.
 *
 * The service only understands its own fixed document-type vocabulary; VMS
 * stores attachments as mst_file_type.file_code. The two do not line up
 * one-to-one, and — this is the trap — file_code is NOT globally unique:
 *
 *   A004 = "Ethical Code"          on bu_id CG
 *   A004 = "Integrity Pact (Pg.1)" on bu_id UPS and DWS
 *
 * so every lookup here is keyed on (bu_id, file_code). CG has no Integrity
 * Pact at all and UPS/DWS have no Ethical Code — that is the master data, not
 * an omission.
 *
 * Codes with no AI counterpart (A003 KTP, A007, A008, A011, A012, A013, X002,
 * X005, X099) are absent on purpose: sending them would just burn a slot
 * against the 20-document cap and confuse the scorer.
 */

// The exact strings the service accepts. Anything else comes back as a 400
// with reason "unknown_document_type", so these are pinned, not derived.
const AI_DOC_TYPE = {
    NPWP: "NPWP",
    SPPKP: "SPPKP",
    PASSBOOK: "Buku Tabungan",
    ACCOUNT_STATEMENT: "Surat Pernyataan Rekening",
    INTEGRITY_PACT: "Pakta Integritas",
    ETHICAL_CODE: "Kode Etik",
    NIB: "NIB",
    COMPANY_PROFILE: "Company Profile",
};

// Shared by every BU.
const COMMON_FILE_CODE_MAP = {
    A001: AI_DOC_TYPE.ACCOUNT_STATEMENT,
    A002: AI_DOC_TYPE.PASSBOOK,
    A005: AI_DOC_TYPE.NPWP,
    A006: AI_DOC_TYPE.SPPKP,
    // NIB replaced SIUP under OSS; vendors upload the NIB into the SIUP slot.
    A009: AI_DOC_TYPE.NIB,
    A010: AI_DOC_TYPE.COMPANY_PROFILE,
};

const FILE_CODE_MAP_BY_BU = {
    CG: {
        ...COMMON_FILE_CODE_MAP,
        A004: AI_DOC_TYPE.ETHICAL_CODE,
    },
    UPS: {
        ...COMMON_FILE_CODE_MAP,
        // Integrity Pact is submitted one entry per page, same type string on
        // both — the service groups them into a single AI call itself.
        A004: AI_DOC_TYPE.INTEGRITY_PACT,
        A004b: AI_DOC_TYPE.INTEGRITY_PACT,
    },
    DWS: {
        ...COMMON_FILE_CODE_MAP,
        A004: AI_DOC_TYPE.INTEGRITY_PACT,
        A004b: AI_DOC_TYPE.INTEGRITY_PACT,
    },
};

// BUs outside CG/UPS/DWS (CORP, ADMIN, blank) run the UPS ticket rules, so
// they get the UPS vocabulary.
const DEFAULT_BU = "UPS";

/**
 * @param {string} bu_id
 * @param {string} file_code
 * @returns {string|null} the AI document type, or null if VMS holds no
 *   equivalent and the attachment should not be sent.
 */
function mapFileCodeToAiType(bu_id, file_code) {
    if (!file_code) return null;
    const map = FILE_CODE_MAP_BY_BU[bu_id] || FILE_CODE_MAP_BY_BU[DEFAULT_BU];
    // file_code is stored exactly as seeded ("A004b" is lower-case b).
    return map[file_code.trim()] || null;
}

// Attachments filed against a bank rather than the vendor. Only these are
// deduped per code — see buildDocuments. Every other code may legitimately
// appear several times, one entry per page of a multi-page document.
const BANK_SCOPED_FILE_CODES = ["A001", "A002", "A012"];

// The service rejects anything else with reason "unsupported_file_type". VMS
// uploads also accept doc/docx, which is why this filter exists.
const ACCEPTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "pneg", "webp"];

// Hard caps from the service contract.
const MAX_DOCUMENTS = 20;
const MIN_DOCUMENTS = 1;

// The service treats anything under 5 KB as corrupt. It does NOT reject these
// up front — an undersized file still returns 202, then the run dies during
// async processing and no callback is ever sent (observed on
// val-20260813-4780961a, silent for 18 minutes on two 2,911-byte PDFs). VMS
// itself enforces only a 2 MB ceiling and no floor, so nothing else catches it.
const MIN_FILE_BYTES = 5 * 1024;

// A run still PROCESSING long past the quoted 25-40s has no way of completing:
// the service has no status endpoint to poll and its webhook retry ladder
// (5s/15s/45s) is long exhausted. Sweep it so the panel stops reporting work
// that is not happening.
const STALE_RUN_MINUTES = 10;

// Webhook replay window, in seconds.
const SIGNATURE_MAX_AGE_SECONDS = 300;

// Terminal verdicts the webhook can carry.
const RESULT_STATUS = {
    VALID: "VALID",
    VALID_WITH_NOTES: "VALID_WITH_NOTES",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    INVALID: "INVALID",
};

// Our own outbound-leg bookkeeping — not the service's vocabulary.
const SUBMIT_STATUS = {
    PROCESSING: "PROCESSING", // 202 accepted, awaiting webhook
    REJECTED: "REJECTED", // 400 — payload/file problem, fix and resubmit
    ERROR: "ERROR", // network, 401/403, 5xx
    SKIPPED: "SKIPPED", // nothing worth validating (no mappable documents)
};

module.exports = {
    AI_DOC_TYPE,
    BANK_SCOPED_FILE_CODES,
    FILE_CODE_MAP_BY_BU,
    DEFAULT_BU,
    mapFileCodeToAiType,
    ACCEPTED_EXTENSIONS,
    MAX_DOCUMENTS,
    MIN_DOCUMENTS,
    MIN_FILE_BYTES,
    STALE_RUN_MINUTES,
    SIGNATURE_MAX_AGE_SECONDS,
    RESULT_STATUS,
    SUBMIT_STATUS,
};
