// Rework -> new-approver notification: EMAIL channel PLACEHOLDER.
//
// Chain-replacement rework (Master Data swaps a request's manual approver chain
// for a fresh one) lets the caller pick how the new Approval 1 is told:
//   APP   — nothing to send; the request simply shows up in that user's inbox.
//   EMAIL — this module. The wording/branding of that mail is not decided yet,
//           so nothing is actually sent and NOTHING here talks to the network.
//
// Deliberate non-dependencies: this module imports nothing at all — no mail
// transport, no HTTP client, no queue, no environment reads (a test pins that).
// The service calls it AFTER its transaction commits, so a future real sender
// can never roll back an approval chain that is already persisted, and today's
// no-op can never make a committed rework look like it failed. Swapping in the
// real sender means editing this file only.

/**
 * Build the (not yet written) notification mail for the new approver chain.
 *
 * Returns hardcoded TODO markers on purpose: callers may store/log the result,
 * but must not present it to a user as a finished message. Kept separate from
 * the send path so the eventual template can be unit-tested without a sender.
 *
 * @param {object} [ctx] request/approver context the real template will consume
 *                       (requestNo, approverUserId, reason, ... ) — accepted and
 *                       ignored while the copy is pending.
 * @returns {{subject: string, body: string}} placeholder strings
 */
const buildReworkApproverEmailTemplate = (ctx = {}) => {
    void ctx;

    return {
        subject: "TODO: rework approver notification subject (template pending)",
        body: "TODO: rework approver notification body (template pending)",
    };
};

/**
 * Fire-and-forget stand-in for the EMAIL channel. SYNCHRONOUS by design — the
 * caller must not be able to await, retry, or fail on it.
 *
 * `sent: false` is the honest answer (no mail left the process) and is what the
 * API surfaces, so no client can mistake the placeholder for a delivery.
 *
 * @param {object} [ctx] same context the template takes; ignored for now
 * @returns {{sent: false, placeholder: true}}
 */
const notifyReworkApproversViaEmailPlaceholder = (ctx = {}) => {
    void ctx;
    console.log("[rework-email] placeholder - no email sent");

    return { sent: false, placeholder: true };
};

module.exports = {
    buildReworkApproverEmailTemplate,
    notifyReworkApproversViaEmailPlaceholder,
};
