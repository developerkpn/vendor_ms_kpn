/**
 * Renders the AI document-validation verdict as a compact block for the
 * approval e-mails managers receive.
 *
 * The full panel lives on the form and is shown to Master Data only. Managers
 * approve from an e-mail link without opening VMS at all, so without this they
 * would decide with no sight of the verdict whatsoever. This is the overview,
 * not the detail: the headline numbers plus anything CRITICAL or HIGH.
 *
 * ADVISORY, and the copy says so. Nothing here changes what the approve/reject
 * buttons do.
 *
 * Returns "" whenever there is nothing worth showing — no run, or a run still
 * awaiting its callback — so the e-mail is unchanged rather than carrying an
 * empty shell. Every value is escaped: it is model-generated prose being
 * dropped into an HTML mail.
 */

const STATUS_STYLE = {
    VALID: { label: "Valid", bg: "#e4f0ea", fg: "#2a6f52" },
    VALID_WITH_NOTES: { label: "Valid with notes", bg: "#e4f0ea", fg: "#2a6f52" },
    NEEDS_REVIEW: { label: "Needs Review", bg: "#f6eed9", fg: "#8a6612" },
    INVALID: { label: "Invalid", bg: "#f6e4e4", fg: "#9b2f2f" },
};

const SEVERITY_STYLE = {
    CRITICAL: { bg: "#f6e4e4", fg: "#9b2f2f" },
    HIGH: { bg: "#f6eed9", fg: "#8a6612" },
};

function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function pill(text, bg, fg) {
    return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:bold;letter-spacing:0.04em;padding:3px 8px;border-radius:2px;">${escapeHtml(
        text
    )}</span>`;
}

/**
 * @param {object|null} validation row from aiValidationService.getLatestValidation
 * @returns {string} HTML fragment, or "" when there is nothing to report
 */
function buildAiSummaryHtml(validation) {
    if (!validation || !validation.status) return "";

    const meta = STATUS_STYLE[validation.status] || {
        label: validation.status,
        bg: "#eef1f4",
        fg: "#46545f",
    };
    const score =
        validation.overall_score === null || validation.overall_score === undefined
            ? "-"
            : Number(validation.overall_score).toFixed(1);

    // Only CRITICAL and HIGH earn space in an e-mail — MEDIUM and LOW are
    // notes, and a manager reading on a phone should see what disqualifies.
    const findings = [];
    for (const doc of validation.document_results || []) {
        for (const d of doc.discrepancies || []) {
            if (d.severity === "CRITICAL" || d.severity === "HIGH") {
                findings.push({ doc: doc.document_type, ...d });
            }
        }
    }
    for (const ci of (validation.cross_doc_check || {}).critical_inconsistencies || []) {
        findings.push({
            doc: "Cross-document",
            severity: "CRITICAL",
            field: ci.field,
            description: ci.description,
        });
    }

    const findingRows = findings
        .slice(0, 6)
        .map(f => {
            const s = SEVERITY_STYLE[f.severity] || SEVERITY_STYLE.HIGH;
            return `<tr>
                <td style="padding:6px 10px 6px 0;vertical-align:top;white-space:nowrap;">${pill(
                    f.severity,
                    s.bg,
                    s.fg
                )}</td>
                <td style="padding:6px 10px 6px 0;vertical-align:top;font-size:13px;color:#46545f;white-space:nowrap;">${escapeHtml(
                    f.doc
                )}</td>
                <td style="padding:6px 0;vertical-align:top;font-size:13px;color:#101820;">
                    <strong>${escapeHtml(f.field)}</strong><br />${escapeHtml(f.description)}
                </td>
            </tr>`;
        })
        .join("");

    const more =
        findings.length > 6
            ? `<tr><td colspan="3" style="padding:4px 0;font-size:12px;color:#6d7d89;">+ ${
                  findings.length - 6
              } more finding(s) — see the vendor form in VMS.</td></tr>`
            : "";

    const findingsTable = findings.length
        ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">${findingRows}${more}</table>`
        : `<p style="margin:10px 0 0;font-size:13px;color:#2a6f52;">No critical or high-severity findings.</p>`;

    const crossDoc = (validation.cross_doc_check || {}).summary
        ? `<p style="margin:10px 0 0;font-size:13px;color:#46545f;line-height:1.5;">${escapeHtml(
              validation.cross_doc_check.summary
          )}</p>`
        : "";

    return `
        <tr>
            <table class="bg_white" width="100%">
                <tr>
                    <td style="padding: 1.5em 2.5em 2em;">
                        <div style="border:1px solid #ccd6e0;border-left:3px solid #1d5a7a;padding:14px 16px;">
                            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#1d5a7a;font-weight:bold;">
                                AI Document Validation
                            </div>
                            <div style="margin-top:8px;font-size:14px;color:#101820;">
                                ${pill(meta.label, meta.bg, meta.fg)}
                                <span style="margin-left:10px;font-size:20px;font-weight:bold;">${escapeHtml(
                                    score
                                )}</span>
                                <span style="font-size:12px;color:#6d7d89;"> / 100</span>
                                <span style="margin-left:10px;font-size:13px;color:#46545f;">Recommendation: <strong>${escapeHtml(
                                    validation.recommendation || "-"
                                )}</strong></span>
                            </div>
                            ${crossDoc}
                            ${findingsTable}
                            <p style="margin:12px 0 0;font-size:12px;color:#6d7d89;line-height:1.5;">
                                Advisory only — an automated check of the uploaded documents
                                against the submitted form. It does not approve or reject this
                                request. Please verify anything flagged before deciding.
                            </p>
                        </div>
                    </td>
                </tr>
            </table>
        </tr>`;
}

module.exports = { buildAiSummaryHtml, escapeHtml };
