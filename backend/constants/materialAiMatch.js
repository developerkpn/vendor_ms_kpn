// AI material match constants (advisory "does this material already exist?"
// ranking run after a single/mass request is submitted or reworked). Single
// source of truth for the service, the controller and the tests.

const AI_MATCH_KIND = Object.freeze({ SINGLE: "SINGLE", MASS: "MASS" });
const AI_MATCH_STATUS = Object.freeze({
    PENDING: "PENDING",
    DONE: "DONE",
    FAILED: "FAILED",
});

// The recommender runs next to the app; the default is the FastAPI dev port.
const AI_MATCH_DEFAULT_URL = "http://127.0.0.1:8000";

// Generous: a cold model load on the AI side is measured in seconds, and the
// call is already off the request path, so waiting costs a requester nothing.
const AI_MATCH_DEFAULT_TIMEOUT_MS = 30000;

// How many existing materials to rank. Capped because the approver dialog has
// to stay readable and a longer list is noise, not evidence.
const AI_MATCH_DEFAULT_TOP_K = 5;
const AI_MATCH_MAX_TOP_K = 10;

// Stored errors are for a support ticket, not a stack trace.
const AI_MATCH_MAX_ERROR_LENGTH = 500;

// Lines one pre-save preview call may ask about. A mass request is capped at
// 10 lines, so this is the whole batch; the UI still sends one line per call so
// no single HTTP request outlives a load balancer's idle timeout.
const AI_MATCH_MAX_PREVIEW_LINES = 10;

// Where a recommendation comes from: an existing SAP material (mat_sap_data),
// or a request that is not in SAP yet — still in approval, approved but not
// synced (the SAP sync runs once a day), or another line of the same batch.
// The AI ranks the requests sent to it with the materials and tags them.
const AI_MATCH_SOURCE = Object.freeze({
    CATALOG: "catalog",
    REQUEST: "request",
});

// Requests sent along with each line. The AI only shows the ones that look
// like the same material (at most 2 per line), so this is a ceiling on payload
// size, newest first; at today's volume (~30 open requests) it is never hit.
const AI_MATCH_MAX_CANDIDATES = 300;

// Request statuses that end a request without creating a material.
const AI_MATCH_CLOSED_REQUEST_STATUSES = Object.freeze(["CANCEL", "REJECTED", "REJECT"]);

module.exports = {
    AI_MATCH_KIND,
    AI_MATCH_STATUS,
    AI_MATCH_DEFAULT_URL,
    AI_MATCH_DEFAULT_TIMEOUT_MS,
    AI_MATCH_DEFAULT_TOP_K,
    AI_MATCH_MAX_TOP_K,
    AI_MATCH_MAX_ERROR_LENGTH,
    AI_MATCH_MAX_PREVIEW_LINES,
    AI_MATCH_SOURCE,
    AI_MATCH_MAX_CANDIDATES,
    AI_MATCH_CLOSED_REQUEST_STATUSES,
};
