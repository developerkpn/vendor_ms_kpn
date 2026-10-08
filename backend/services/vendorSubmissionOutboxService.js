const { randomUUID } = require("crypto");
const db = require("../config/connection");

const MAX_ATTEMPTS = 12;

// The caller supplies the approval transaction. Jobs disappear on rollback
// and only become visible to workers once the vendor and ticket are committed.
async function enqueueVendorSubmissionJob(
    client,
    { ticketToken, venId, jobType, payload = {}, dependsOnType = null }
) {
    await client.query(
        `INSERT INTO vendor_submission_outbox
            (ticket_token, ven_id, job_type, payload, depends_on_type)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (ticket_token, job_type) DO NOTHING`,
        [ticketToken, venId, jobType, JSON.stringify(payload), dependsOnType]
    );
}

// Require models at dispatch time: ApprovalModel already depends on this
// service, and VendorModel/EmailModel participate in the existing model cycle.
async function executeVendorSubmissionJob(job) {
    const payload = job.payload;
    switch (job.job_type) {
        case "SAP_UPLOAD":
            return require("../models/VendorModel").UploadStaging(job.ven_id);
        case "VERIFICATION_EMAIL":
            return require("../models/EmailModel").RequestVerificator(
                payload.detail,
                payload.link,
                payload.to
            );
        case "TAX_EMAIL":
            return require("../models/EmailModel").NotifPajak(payload.detail);
        case "COMPLETION_EMAIL":
            return require("../models/EmailModelv2").EndTicket(
                payload.vendorName,
                payload.vendorCode,
                payload.config
            );
        default:
            throw new Error(`Unknown vendor submission job: ${job.job_type}`);
    }
}

const retryDelaySeconds = attempts =>
    Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);

const CLAIM_JOB_SQL = `
    UPDATE vendor_submission_outbox jobs
    SET status = 'PROCESSING', attempts = jobs.attempts + 1,
        locked_until = now() + interval '30 minutes', claim_token = $1
    WHERE jobs.id = (
        SELECT candidate.id FROM vendor_submission_outbox candidate
        WHERE candidate.attempts < $2
          AND (
            (candidate.status = 'PENDING' AND candidate.next_attempt_at <= now())
            OR (candidate.status = 'PROCESSING' AND candidate.locked_until < now())
          )
          AND (candidate.depends_on_type IS NULL OR EXISTS (
            SELECT 1 FROM vendor_submission_outbox dependency
            WHERE dependency.ticket_token = candidate.ticket_token
              AND dependency.job_type = candidate.depends_on_type
              AND dependency.status = 'DONE'
          ))
        ORDER BY candidate.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING jobs.*`;

async function processPendingVendorSubmissions({
    pool = db,
    executeJob = executeVendorSubmissionJob,
    logger = console,
    limit = 10,
} = {}) {
    const result = { succeeded: 0, retried: 0, failed: 0 };
    // A process may die on its final attempt. Make that exhausted lease
    // visible as FAILED rather than leaving it PROCESSING indefinitely.
    await pool.query(
        `UPDATE vendor_submission_outbox
         SET status = 'FAILED', locked_until = NULL, claim_token = NULL,
             last_error = COALESCE(last_error, 'Worker lease expired on final attempt')
         WHERE status = 'PROCESSING' AND locked_until < now() AND attempts >= $1`,
        [MAX_ATTEMPTS]
    );
    for (let index = 0; index < limit; index++) {
        const claimToken = randomUUID();
        const { rows } = await pool.query(CLAIM_JOB_SQL, [
            claimToken,
            MAX_ATTEMPTS,
        ]);
        const job = rows[0];
        if (!job) break;
        try {
            await executeJob(job);
            await pool.query(
                `UPDATE vendor_submission_outbox
                 SET status = 'DONE', completed_at = now(), last_error = NULL,
                     locked_until = NULL, claim_token = NULL
                 WHERE id = $1 AND claim_token = $2`,
                [job.id, claimToken]
            );
            result.succeeded++;
        } catch (error) {
            const exhausted = job.attempts >= MAX_ATTEMPTS;
            await pool.query(
                `UPDATE vendor_submission_outbox
                 SET status = $1, next_attempt_at = now() + make_interval(secs => $2),
                     last_error = $3, locked_until = NULL, claim_token = NULL
                 WHERE id = $4 AND claim_token = $5`,
                [
                    exhausted ? "FAILED" : "PENDING",
                    retryDelaySeconds(job.attempts),
                    `${error.code || ""} ${error.message || error}`
                        .trim()
                        .slice(0, 2000),
                    job.id,
                    claimToken,
                ]
            );
            result[exhausted ? "failed" : "retried"]++;
            logger.error(
                `[VENDOR-OUTBOX] ${job.job_type} job ${job.id} ${
                    exhausted ? "failed" : "will retry"
                }:`,
                error.message || error
            );
        }
    }
    return result;
}

module.exports = {
    enqueueVendorSubmissionJob,
    executeVendorSubmissionJob,
    processPendingVendorSubmissions,
    retryDelaySeconds,
    MAX_ATTEMPTS,
    CLAIM_JOB_SQL,
};
