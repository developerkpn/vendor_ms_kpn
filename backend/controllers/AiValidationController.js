const aiValidationService = require("../services/aiValidationService");

const AiValidationController = {};

/**
 * POST /api/ai-validation/webhook
 *
 * The AI service delivers its verdict here ~30s after we call /validate.
 *
 * Three things are load-bearing and easy to break:
 *
 * 1. req.body is a Buffer, not an object. The HMAC covers the raw bytes, so
 *    server.js installs express.raw() on this exact path BEFORE the global
 *    express.json(). Reserialising a parsed object would change key order and
 *    whitespace and every signature would fail.
 * 2. The 200 goes out before the work starts. Anything non-2xx (or slower than
 *    3s) triggers the retry ladder — 5s, 15s, 45s — so a slow database write
 *    would turn one result into four.
 * 3. Storage is idempotent on request_id, precisely because those retries
 *    re-send an identical body.
 */
AiValidationController.webhook = async (req, res) => {
    let rawBody;
    try {
        rawBody = Buffer.isBuffer(req.body)
            ? req.body.toString("utf-8")
            : typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body || {});
    } catch (error) {
        return res.status(400).json({ error: "Unreadable body" });
    }

    const verdict = aiValidationService.verifyWebhookSignature(
        rawBody,
        req.headers["x-validation-signature"],
        req.headers["x-validation-timestamp"]
    );
    if (!verdict.valid) {
        console.warn(
            `[AI-VALIDATION] webhook rejected: ${verdict.reason}`,
            req.headers["x-request-id"] || ""
        );
        // Stale timestamps are a replay guard, not a signature failure; the
        // service reads both as "do not retry into this endpoint".
        return res.status(401).json({ error: verdict.reason });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (error) {
        return res.status(400).json({ error: "Invalid JSON" });
    }

    // Ack first — the remaining work must not hold the response open.
    res.status(200).json({ received: true });

    aiValidationService
        .storeValidationResult(payload)
        .then(result => {
            console.log(
                `[AI-VALIDATION] result stored for ${result.ven_id} (${payload.request_id}): ${payload.status} / ${payload.recommendation} @ ${payload.overall_score}`
            );
        })
        .catch(error => {
            console.error(
                `[AI-VALIDATION] failed to store result ${payload.request_id}:`,
                error && error.message
            );
        });
};

/**
 * GET /api/ai-validation/vendor/:ven_id
 *
 * Latest run plus a short history, for the panel on the vendor form. `latest`
 * is null when the vendor has never been submitted for validation, which the
 * panel renders as "not run" rather than as an error.
 */
AiValidationController.getByVendor = async (req, res) => {
    try {
        const { ven_id } = req.params;
        if (!ven_id) {
            return res.status(400).send({ message: "ven_id is required" });
        }
        const [latest, history] = await Promise.all([
            aiValidationService.getLatestValidation(ven_id),
            aiValidationService.getValidationHistory(ven_id),
        ]);
        res.status(200).send({
            data: {
                latest,
                history,
                enabled: process.env.AI_VALIDATION_ENABLED === "true",
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: error.message });
    }
};

module.exports = AiValidationController;
