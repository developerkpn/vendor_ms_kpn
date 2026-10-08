const fs = require("fs");
const path = require("path");

const VENDOR_SUBMISSION_OUTBOX_SQL = fs.readFileSync(
    path.join(__dirname, "../migration/20261008_vendor_submission_outbox.sql"),
    "utf8"
);

async function ensureVendorSubmissionOutboxSchema(db) {
    await db.query(VENDOR_SUBMISSION_OUTBOX_SQL);
}

module.exports = { ensureVendorSubmissionOutboxSchema };
