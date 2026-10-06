/**
 * AI material match — "does a material like this already exist?"
 *
 * A requester submits a single or mass material request; after the request has
 * been persisted we ask the material recommender (FastAPI, POST /recommend)
 * for the top-K existing materials that look like each requested line and
 * store the ranked answer in mat_request_ai_match. The approval dialogs read
 * it back and show rank / code / name / similarity next to the request.
 *
 * ADVISORY ONLY. No approval logic reads this table. A 97% match does not
 * block a request and a failed run does not hold one up — the approver looks
 * at the list and decides. Keep it that way: the score is embedding-derived,
 * and a false "this already exists" must never be able to stall a real
 * material.
 *
 * Asynchronous with respect to the request. The submit/rework handlers call
 * schedule*Match(), which returns immediately and does the work on a later
 * tick; the HTTP response never waits for the AI and nothing in this module is
 * allowed to throw into the request path.
 *
 * The whole feature is off unless MATERIAL_AI_MATCH_ENABLED === "true", so a
 * deployment with no recommender running behaves exactly as before.
 *
 * Internal calls go through module.exports.* on purpose: it is the seam the
 * tests stub (loadSingleRequestRow / loadMassRequestItems / upsertMatch /
 * callRecommender) so a run can be exercised without a database or a network.
 */

const axios = require("axios");
const DBClientWrapper = require("../helper/DBClientWrapper");
const {
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
} = require("../constants/materialAiMatch");
const { SINGLE_REQUEST_TICKET_TYPES } = require("../constants/material");

// Read on every call rather than at module load: dotenv populates process.env
// from server.js, and the tests flip MATERIAL_AI_MATCH_ENABLED per case.
function getConfig() {
    // A missing, unparseable or zero top_k means "nobody configured this",
    // which is the default rather than "rank nothing"; anything else is clamped
    // into the range the recommender and the dialog can both live with.
    const rawTopK =
        parseInt(process.env.MATERIAL_AI_MATCH_TOP_K, 10) ||
        AI_MATCH_DEFAULT_TOP_K;
    const topK = Math.min(Math.max(rawTopK, 1), AI_MATCH_MAX_TOP_K);

    return {
        enabled: process.env.MATERIAL_AI_MATCH_ENABLED === "true",
        baseUrl: (
            process.env.MATERIAL_AI_MATCH_URL || AI_MATCH_DEFAULT_URL
        ).replace(/\/+$/, ""),
        timeoutMs:
            Number(process.env.MATERIAL_AI_MATCH_TIMEOUT_MS) ||
            AI_MATCH_DEFAULT_TIMEOUT_MS,
        topK,
    };
}

// The recommender matches on text, so whitespace is noise: a description typed
// with a double space or a trailing newline must hash to the same query as the
// same words typed cleanly.
function normalizeText(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/\s+/g, " ")
        .trim();
}

function joinDescription(parts) {
    return parts.map(normalizeText).filter(Boolean).join(" ");
}

/**
 * A single request's line as the recommender wants it: the 40-char SAP
 * description is the name, and the three long-text continuation columns are
 * the free-text description (they are one string split across columns, so they
 * go back together before they are sent).
 */
function buildSingleRequestQuery(row) {
    return {
        code: normalizeText(row && row.material_code),
        name: normalizeText(row && row.material_description),
        desc: joinDescription([
            row && row.long_text_1,
            row && row.long_text_2,
            row && row.long_text_3,
        ]),
    };
}

/**
 * A mass item's line. Always code-less: mass items are new materials, so there
 * is nothing to match a code against — only the text.
 */
function buildMassItemQuery(item) {
    return {
        code: "",
        name: normalizeText(item && item.material_description),
        desc: joinDescription([
            item && item.po_text,
            item && item.spesifikasi_tambahan,
        ]),
    };
}

/**
 * Change and Extend requests already name an existing material — that is what
 * they are for — so asking "does this exist?" about them is noise. Only Create
 * gets a match.
 */
function shouldMatchSingleRequest(row) {
    return (
        normalizeText(row && row.ticket_type) ===
        SINGLE_REQUEST_TICKET_TYPES.CREATE
    );
}

function roundSimilarity(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return 0;
    }
    return Math.round(num * 10000) / 10000;
}

/**
 * The AI side's recommendations, ranked. Rank is the position the recommender
 * returned them in — it sorts by similarity itself, and re-sorting here would
 * hide a disagreement rather than surface it.
 */
function normalizeRecommendations(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map((item, index) => ({
        rank: index + 1,
        code: normalizeText(item && item.code),
        name: normalizeText(item && item.name),
        similarity: roundSimilarity(item && item.similarity),
        // Kept verbatim: the labels the dialog maps are the AI side's exact
        // strings, down to the parentheses.
        matchType: item && item.match_type ? String(item.match_type) : "TEXT",
        ...describeSource(item),
    }));
}

/**
 * Where a recommendation comes from. A "request" one is not a material yet:
 * its code is a request number, and the dialogs must not offer it as the
 * existing material to use. A retired one is a material SAP has flagged for
 * deletion or renamed "(NOT USE)": the same part, but not one to reuse as is.
 */
function describeSource(item) {
    const source =
        item && item.source === AI_MATCH_SOURCE.REQUEST
            ? AI_MATCH_SOURCE.REQUEST
            : AI_MATCH_SOURCE.CATALOG;
    return {
        source,
        retired: Boolean(item && item.retired),
        requestStatus:
            source === AI_MATCH_SOURCE.REQUEST
                ? normalizeText(
                      item && (item.request_status ?? item.requestStatus)
                  ).slice(0, 40)
                : "",
    };
}

/**
 * POST /recommend. Errors propagate: the caller maps them to a stored FAILED
 * row, which is where the description belongs.
 */
async function callRecommender({ code, name, desc, topK, candidates = [] }) {
    const config = module.exports.getConfig();
    const queryName = normalizeText(name);
    if (!queryName) {
        // The service answers 400 to this; failing here names the reason.
        throw new Error("AI recommender returned an empty name");
    }

    const response = await axios.post(
        `${config.baseUrl}/recommend`,
        {
            code: normalizeText(code),
            name: queryName,
            desc: normalizeText(desc),
            top_k: topK || config.topK,
            candidates: (Array.isArray(candidates) ? candidates : [])
                .slice(0, AI_MATCH_MAX_CANDIDATES)
                .map(candidate => ({
                    ref: normalizeText(candidate.ref),
                    name: normalizeText(candidate.name),
                    desc: normalizeText(candidate.desc),
                    status: normalizeText(candidate.status),
                })),
        },
        { timeout: config.timeoutMs }
    );
    return response.data;
}

/**
 * Turns whatever axios threw into one line a support ticket can act on. The
 * three cases worth telling apart are "the AI box is not running", "it is
 * running but slow", and "it answered and said no".
 */
function describeAiError(error) {
    if (!error) {
        return "Unknown error";
    }
    if (error.code === "ECONNABORTED") {
        return "AI recommender timed out";
    }
    if (error.code === "ECONNREFUSED") {
        return "AI recommender unreachable";
    }
    if (error.response) {
        const detail =
            error.response.data &&
            typeof error.response.data.detail === "string"
                ? error.response.data.detail
                : "";
        return (
            `AI recommender responded ${error.response.status}` +
            (detail ? `: ${detail}` : "")
        );
    }
    return error.message || "Unknown error";
}

/**
 * The pre-save check: rank existing materials for lines that are NOT saved
 * yet, so the requester can say "that one" or "none of these" before anything
 * is written. Nothing here touches the database.
 *
 * Same shape per line as a stored match, minus the ids, so the UI renders it
 * with the same table. One line failing is reported against that line and the
 * rest carry on; lines are called one after another for the same reason the
 * mass run is (a single-process model server).
 *
 * Each line may carry `siblings`: the other lines of the same unsaved form
 * ({ref, name, desc}), so a part entered twice in one batch is caught before
 * anything is saved. Open requests already in the database are added to them.
 *
 * @param {Array<{key: string|number, query: {code?: string, name: string, desc?: string}, siblings?: Array}>} lines
 */
async function previewMatches(lines) {
    const config = module.exports.getConfig();
    const list = Array.isArray(lines)
        ? lines.slice(0, AI_MATCH_MAX_PREVIEW_LINES)
        : [];
    const inFlight = list.length ? await loadCandidatesSafely() : [];

    const results = [];
    for (const line of list) {
        const query = {
            code: normalizeText(line && line.query && line.query.code),
            name: normalizeText(line && line.query && line.query.name),
            desc: normalizeText(line && line.query && line.query.desc),
        };
        const base = {
            key: line ? line.key : null,
            query,
            correctedName: null,
            typoCorrected: null,
            entities: { category: [], specs: [] },
            recommendations: [],
            topSimilarity: null,
        };

        if (!query.name) {
            results.push({
                ...base,
                status: AI_MATCH_STATUS.FAILED,
                error: "Material description is empty",
            });
            continue;
        }

        try {
            const siblings = (Array.isArray(line.siblings) ? line.siblings : [])
                .map(sibling => ({
                    ref: normalizeText(sibling && sibling.ref),
                    name: normalizeText(sibling && sibling.name),
                    desc: normalizeText(sibling && sibling.desc),
                    status: "this request",
                }))
                .filter(sibling => sibling.name);
            const data = await module.exports.callRecommender({
                ...query,
                topK: config.topK,
                candidates: [...siblings, ...inFlight],
            });
            const recommendations = module.exports.normalizeRecommendations(
                data && data.recommendations
            );
            const entities = (data && data.entities) || {};
            results.push({
                ...base,
                status: AI_MATCH_STATUS.DONE,
                error: null,
                correctedName: (data && data.corrected_name) || null,
                typoCorrected: Boolean(data && data.typo_corrected),
                entities: {
                    category: Array.isArray(entities.category)
                        ? entities.category
                        : [],
                    specs: Array.isArray(entities.specs) ? entities.specs : [],
                },
                recommendations,
                topSimilarity: recommendations.length
                    ? recommendations[0].similarity
                    : null,
            });
        } catch (error) {
            const described = module.exports.describeAiError(error);
            console.error(`[AI-MATCH] preview line ${base.key} failed:`, described);
            results.push({
                ...base,
                status: AI_MATCH_STATUS.FAILED,
                error: described,
            });
        }
    }
    return results;
}

/**
 * The requester's "brand new" confirmation as it arrives with a submit, made
 * safe to store. The list is what the browser says it showed, so it is
 * re-normalised and capped rather than trusted: it is display-only, but it
 * must not be able to put anything but a short ranked list in the column.
 *
 * Anything other than an explicit confirmation answers null — no pre-save check
 * ran, so there is nothing to record.
 */
function sanitizeRequesterReview(raw) {
    if (!raw || typeof raw !== "object" || raw.confirmedNew !== true) {
        return null;
    }
    const list = Array.isArray(raw.recommendations)
        ? raw.recommendations.slice(0, AI_MATCH_MAX_TOP_K)
        : [];
    return {
        confirmedNew: true,
        recommendations: list.map((item, index) => ({
            rank: index + 1,
            code: normalizeText(item && item.code).slice(0, 50),
            name: normalizeText(item && item.name).slice(0, 300),
            similarity: roundSimilarity(item && item.similarity),
            matchType: normalizeText(item && item.matchType).slice(0, 60) || "TEXT",
            ...describeSource(item),
        })),
    };
}

/**
 * Pairs each mass review with the item it was saved as. Reviews arrive keyed by
 * the form's row position; createMassRequest saves only the filled rows and
 * numbers them by their position among those (item_no = index + 1). A review
 * for a row that was not saved is dropped.
 */
function pairMassReviewsWithItems(reviewRows, filledRowIndexes, items) {
    if (!Array.isArray(reviewRows) || !Array.isArray(filledRowIndexes)) {
        return [];
    }
    const itemByNo = new Map(
        (Array.isArray(items) ? items : []).map(item => [
            Number(item.item_no),
            item,
        ])
    );
    const pairs = [];
    for (const reviewRow of reviewRows) {
        const position = filledRowIndexes.indexOf(
            Number(reviewRow && reviewRow.rowIndex)
        );
        const item = position >= 0 ? itemByNo.get(position + 1) : null;
        if (item) {
            pairs.push({ item, review: reviewRow });
        }
    }
    return pairs;
}

/**
 * Stores the requester's confirmation against one saved line.
 *
 * Touches only the requester_* columns on conflict, so it can land before or
 * after the post-save run's own upsert without either clobbering the other.
 * When it lands first, it creates the row as PENDING — the run that was queued
 * for the same line fills in the ranking a moment later.
 */
async function recordRequesterReview({
    requestKind,
    requestId,
    massRequestId = null,
    review,
    reviewedBy = null,
}) {
    if (!review || !requestId) {
        return null;
    }
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `INSERT INTO mat_request_ai_match (
                request_kind,
                request_id,
                mass_request_id,
                status,
                query_name,
                requester_confirmed_new,
                requester_reviewed_at,
                requester_reviewed_by,
                requester_review
            ) VALUES ($1, $2, $3, $4, '', $5, NOW(), $6, $7)
            ON CONFLICT (request_kind, request_id) DO UPDATE SET
                requester_confirmed_new = EXCLUDED.requester_confirmed_new,
                requester_reviewed_at = EXCLUDED.requester_reviewed_at,
                requester_reviewed_by = EXCLUDED.requester_reviewed_by,
                requester_review = EXCLUDED.requester_review
            RETURNING *`,
            [
                requestKind,
                requestId,
                massRequestId,
                AI_MATCH_STATUS.PENDING,
                review.confirmedNew === true,
                reviewedBy ? String(reviewedBy).slice(0, 100) : null,
                JSON.stringify(review.recommendations || []),
            ]
        );
        return rows[0] || null;
    });
}

async function loadSingleRequestRow(requestId) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `SELECT
                id,
                ticket_type,
                material_code,
                material_description,
                long_text_1,
                long_text_2,
                long_text_3
            FROM mat_single_request
            WHERE id = $1`,
            [requestId]
        );
        return rows[0] || null;
    });
}

async function loadMassRequestItems(massRequestId) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `SELECT
                id,
                mass_request_id,
                item_no,
                material_description,
                po_text,
                spesifikasi_tambahan
            FROM mat_mass_request_item
            WHERE mass_request_id = $1
            ORDER BY item_no`,
            [massRequestId]
        );
        return rows;
    });
}

/**
 * Create requests that are not SAP materials yet: still in approval, or
 * approved but not in mat_sap_data until the next daily SAP sync. Sent to the
 * AI with every line so that two requests for the same new part - on the same
 * day, or in the same batch - see each other. Newest first, capped.
 *
 * Each carries kind + id so a run can leave out the line it is matching.
 */
async function loadInFlightCandidates() {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `SELECT kind, id, ref, name, descr, status FROM (
                SELECT 'SINGLE' AS kind, s.id, s.request_no AS ref,
                    s.material_description AS name,
                    concat_ws(' ', s.long_text_1, s.long_text_2, s.long_text_3) AS descr,
                    s.status, s.final_code, s.created_at
                FROM mat_single_request s
                WHERE s.ticket_type = $1
                UNION ALL
                SELECT 'MASS', i.id, i.request_no, i.material_description,
                    concat_ws(' ', i.po_text, i.spesifikasi_tambahan),
                    i.status, i.final_code, i.created_at
                FROM mat_mass_request_item i
                WHERE i.ticket_type = $1
            ) r
            WHERE upper(btrim(r.status)) <> ALL($2::text[])
              AND btrim(coalesce(r.name, '')) <> ''
              AND (upper(btrim(r.status)) <> 'DONE'
                   OR NOT EXISTS (
                       SELECT 1 FROM mat_sap_data m
                       WHERE m.code = btrim(r.final_code)))
            ORDER BY r.created_at DESC
            LIMIT $3`,
            [
                SINGLE_REQUEST_TICKET_TYPES.CREATE,
                AI_MATCH_CLOSED_REQUEST_STATUSES,
                AI_MATCH_MAX_CANDIDATES,
            ]
        );
        return rows.map(row => ({
            kind: row.kind,
            id: row.id,
            ref: normalizeText(row.ref),
            name: normalizeText(row.name),
            desc: normalizeText(row.descr),
            status:
                normalizeText(row.status).toUpperCase() === "DONE"
                    ? "DONE, not in SAP yet"
                    : normalizeText(row.status),
        }));
    });
}

/**
 * The in-flight requests, or none: they make a match better, never possible,
 * so failing to load them must not fail the match.
 */
async function loadCandidatesSafely() {
    try {
        return await module.exports.loadInFlightCandidates();
    } catch (error) {
        console.error(
            "[AI-MATCH] could not load in-flight requests, matching without them:",
            error && error.message
        );
        return [];
    }
}

/** The candidates for one line: everything but the line itself. */
function candidatesExcluding(candidates, kind, id) {
    return (candidates || []).filter(
        candidate => !(candidate.kind === kind && String(candidate.id) === String(id))
    );
}

/**
 * Writes one material line's match.
 *
 * Upsert rather than insert: a re-run — after a rework, or from the dialog's
 * re-run button — replaces the stale ranking in place instead of stacking a
 * second row the UI would have to choose between. The PENDING write and the
 * DONE/FAILED write that follows it are the same two calls hitting the same
 * row.
 */
async function upsertMatch({
    requestKind,
    requestId,
    massRequestId = null,
    status,
    error = null,
    query,
    correctedName = null,
    typoCorrected = null,
    entities = null,
    recommendations = [],
    topSimilarity = null,
    latencyMs = null,
    aiResponse = null,
}) {
    const safeQuery = query || {};
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `INSERT INTO mat_request_ai_match (
                request_kind,
                request_id,
                mass_request_id,
                status,
                error,
                query_code,
                query_name,
                query_desc,
                corrected_name,
                typo_corrected,
                entities,
                recommendations,
                top_similarity,
                latency_ms,
                ai_response
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
            )
            ON CONFLICT (request_kind, request_id) DO UPDATE SET
                mass_request_id = EXCLUDED.mass_request_id,
                status = EXCLUDED.status,
                error = EXCLUDED.error,
                query_code = EXCLUDED.query_code,
                query_name = EXCLUDED.query_name,
                query_desc = EXCLUDED.query_desc,
                corrected_name = EXCLUDED.corrected_name,
                typo_corrected = EXCLUDED.typo_corrected,
                entities = EXCLUDED.entities,
                recommendations = EXCLUDED.recommendations,
                top_similarity = EXCLUDED.top_similarity,
                latency_ms = EXCLUDED.latency_ms,
                ai_response = EXCLUDED.ai_response,
                updated_at = NOW()
            RETURNING *`,
            [
                requestKind,
                requestId,
                massRequestId,
                status,
                error
                    ? String(error).slice(0, AI_MATCH_MAX_ERROR_LENGTH)
                    : null,
                safeQuery.code || null,
                safeQuery.name || "",
                safeQuery.desc || null,
                correctedName,
                typoCorrected,
                entities ? JSON.stringify(entities) : null,
                JSON.stringify(recommendations || []),
                topSimilarity,
                latencyMs,
                aiResponse ? JSON.stringify(aiResponse) : null,
            ]
        );
        return rows[0] || null;
    });
}

// jsonb comes back parsed, json-as-text does not, and a row read through a
// join can be either. Parse what needs parsing and fall back to the default
// rather than letting a malformed column break the dialog.
function parseJsonColumn(value, fallback) {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function matchRowToDto(row) {
    if (!row) {
        return null;
    }

    const entities = parseJsonColumn(row.entities, {}) || {};
    const recommendations = parseJsonColumn(row.recommendations, []) || [];

    return {
        id: row.id,
        requestKind: row.request_kind,
        requestId: row.request_id,
        massRequestId: row.mass_request_id ?? null,
        // Only present when the row came through the mass read path, which
        // joins the item back in for its number.
        itemNo: row.item_no ?? null,
        status: row.status,
        error: row.error ?? null,
        query: {
            code: row.query_code ?? "",
            name: row.query_name ?? "",
            desc: row.query_desc ?? "",
        },
        correctedName: row.corrected_name ?? null,
        typoCorrected: row.typo_corrected ?? null,
        entities: {
            category: Array.isArray(entities.category) ? entities.category : [],
            specs: Array.isArray(entities.specs) ? entities.specs : [],
        },
        recommendations: (Array.isArray(recommendations)
            ? recommendations
            : []
        ).map((item, index) => ({
            rank: Number(item && item.rank) || index + 1,
            code: item && item.code ? String(item.code) : "",
            name: item && item.name ? String(item.name) : "",
            similarity: roundSimilarity(item && item.similarity),
            matchType: (item && item.matchType) || "TEXT",
        })),
        topSimilarity: toNumberOrNull(row.top_similarity),
        latencyMs: toNumberOrNull(row.latency_ms),
        // What the requester answered before saving. null when no pre-save
        // check ran, which the dialog must not read as "confirmed".
        requesterReview:
            row.requester_confirmed_new === true
                ? {
                      confirmedNew: true,
                      reviewedAt: row.requester_reviewed_at ?? null,
                      reviewedBy: row.requester_reviewed_by ?? null,
                      shownCount: (
                          parseJsonColumn(row.requester_review, []) || []
                      ).length,
                  }
                : null,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
    };
}

/**
 * One single request, end to end: PENDING row first so the dialog can say "AI
 * is working", then the call, then DONE or FAILED over the top of it.
 *
 * Never throws. The caller is a fire-and-forget scheduler running after the
 * request has already committed; there is nobody left to hand an error to.
 */
async function runSingleRequestMatch(requestId) {
    try {
        const config = module.exports.getConfig();
        if (!config.enabled) {
            return null;
        }

        const row = await module.exports.loadSingleRequestRow(requestId);
        if (!row) {
            return null;
        }
        // Not a Create — no row is written at all, so the dialog renders
        // nothing rather than an empty result the approver has to interpret.
        if (!module.exports.shouldMatchSingleRequest(row)) {
            return null;
        }

        const query = module.exports.buildSingleRequestQuery(row);
        const candidates = candidatesExcluding(
            await loadCandidatesSafely(),
            AI_MATCH_KIND.SINGLE,
            row.id
        );
        await module.exports.upsertMatch({
            requestKind: AI_MATCH_KIND.SINGLE,
            requestId: row.id,
            status: AI_MATCH_STATUS.PENDING,
            query,
        });

        try {
            const data = await module.exports.callRecommender({
                ...query,
                topK: config.topK,
                candidates,
            });
            const recommendations = module.exports.normalizeRecommendations(
                data && data.recommendations
            );
            const saved = await module.exports.upsertMatch({
                requestKind: AI_MATCH_KIND.SINGLE,
                requestId: row.id,
                status: AI_MATCH_STATUS.DONE,
                query,
                correctedName: (data && data.corrected_name) || null,
                typoCorrected: Boolean(data && data.typo_corrected),
                entities: (data && data.entities) || null,
                recommendations,
                topSimilarity: recommendations.length
                    ? recommendations[0].similarity
                    : null,
                latencyMs: Number(data && data.total_latency_ms) || null,
                aiResponse: data || null,
            });
            return module.exports.matchRowToDto(saved);
        } catch (error) {
            const described = module.exports.describeAiError(error);
            console.error(
                `[AI-MATCH] single request ${requestId} failed:`,
                described
            );
            const saved = await module.exports.upsertMatch({
                requestKind: AI_MATCH_KIND.SINGLE,
                requestId: row.id,
                status: AI_MATCH_STATUS.FAILED,
                error: described,
                query,
            });
            return module.exports.matchRowToDto(saved);
        }
    } catch (error) {
        console.error(
            `[AI-MATCH] single request ${requestId} match run aborted:`,
            error && error.message
        );
        return null;
    }
}

/**
 * Every line of one mass request.
 *
 * All the PENDING rows go in first so the dialog shows the whole batch as
 * working rather than revealing items one at a time, then the calls run one
 * after another — deliberately NOT Promise.all, because a 30-row mass request
 * would otherwise open 30 simultaneous connections to a single-process model
 * server. One item failing is stored against that item and the loop carries on.
 */
async function runMassRequestMatch(massRequestId) {
    try {
        const config = module.exports.getConfig();
        if (!config.enabled) {
            return null;
        }

        const items = await module.exports.loadMassRequestItems(massRequestId);
        if (!Array.isArray(items) || items.length === 0) {
            return null;
        }

        const queries = items.map(item => ({
            item,
            query: module.exports.buildMassItemQuery(item),
        }));
        // Loaded once for the batch: it already holds this batch's other lines
        // (they are open requests too), which is how an item repeated within
        // one mass request is caught.
        const inFlight = await loadCandidatesSafely();

        for (const { item, query } of queries) {
            await module.exports.upsertMatch({
                requestKind: AI_MATCH_KIND.MASS,
                requestId: item.id,
                massRequestId,
                status: AI_MATCH_STATUS.PENDING,
                query,
            });
        }

        const results = [];
        for (const { item, query } of queries) {
            try {
                const data = await module.exports.callRecommender({
                    ...query,
                    topK: config.topK,
                    candidates: candidatesExcluding(
                        inFlight,
                        AI_MATCH_KIND.MASS,
                        item.id
                    ),
                });
                const recommendations = module.exports.normalizeRecommendations(
                    data && data.recommendations
                );
                const saved = await module.exports.upsertMatch({
                    requestKind: AI_MATCH_KIND.MASS,
                    requestId: item.id,
                    massRequestId,
                    status: AI_MATCH_STATUS.DONE,
                    query,
                    correctedName: (data && data.corrected_name) || null,
                    typoCorrected: Boolean(data && data.typo_corrected),
                    entities: (data && data.entities) || null,
                    recommendations,
                    topSimilarity: recommendations.length
                        ? recommendations[0].similarity
                        : null,
                    latencyMs: Number(data && data.total_latency_ms) || null,
                    aiResponse: data || null,
                });
                results.push(module.exports.matchRowToDto(saved));
            } catch (error) {
                const described = module.exports.describeAiError(error);
                console.error(
                    `[AI-MATCH] mass request ${massRequestId} item ${item.item_no} failed:`,
                    described
                );
                const saved = await module.exports.upsertMatch({
                    requestKind: AI_MATCH_KIND.MASS,
                    requestId: item.id,
                    massRequestId,
                    status: AI_MATCH_STATUS.FAILED,
                    error: described,
                    query,
                });
                results.push(module.exports.matchRowToDto(saved));
            }
        }

        return results;
    } catch (error) {
        console.error(
            `[AI-MATCH] mass request ${massRequestId} match run aborted:`,
            error && error.message
        );
        return null;
    }
}

/**
 * Fire-and-forget entry points for the submit/rework handlers.
 *
 * Deliberately not awaited and deliberately swallowing everything: the request
 * has already committed by the time this runs, and no failure of an advisory
 * check may surface as a submit error. Returns whether a run was queued, which
 * is what the re-run endpoint answers with.
 */
function scheduleSingleRequestMatch(requestId) {
    if (!module.exports.getConfig().enabled || !requestId) {
        return false;
    }
    setImmediate(() => {
        module.exports.runSingleRequestMatch(requestId).catch(error => {
            console.error(
                `[AI-MATCH] background single match failed for ${requestId}:`,
                error && error.message
            );
        });
    });
    return true;
}

function scheduleMassRequestMatch(massRequestId) {
    if (!module.exports.getConfig().enabled || !massRequestId) {
        return false;
    }
    setImmediate(() => {
        module.exports.runMassRequestMatch(massRequestId).catch(error => {
            console.error(
                `[AI-MATCH] background mass match failed for ${massRequestId}:`,
                error && error.message
            );
        });
    });
    return true;
}

/** What the single approval dialog reads. null when no run has happened. */
async function getSingleRequestMatch(requestId) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `SELECT *
            FROM mat_request_ai_match
            WHERE request_kind = 'SINGLE'
              AND request_id = $1`,
            [requestId]
        );
        return module.exports.matchRowToDto(rows[0] || null);
    });
}

/**
 * What the mass approval dialog reads: every line of the batch, in item order.
 * The join is what carries item_no into the DTO — the match row only knows the
 * item id.
 */
async function getMassRequestMatches(massRequestId) {
    return DBClientWrapper(async client => {
        const { rows } = await client.query(
            `SELECT m.*, i.item_no
            FROM mat_request_ai_match m
            JOIN mat_mass_request_item i ON i.id = m.request_id
            WHERE m.request_kind = 'MASS'
              AND m.mass_request_id = $1
            ORDER BY i.item_no`,
            [massRequestId]
        );
        return rows.map(row => module.exports.matchRowToDto(row));
    });
}

module.exports = {
    getConfig,
    normalizeText,
    buildSingleRequestQuery,
    buildMassItemQuery,
    shouldMatchSingleRequest,
    normalizeRecommendations,
    callRecommender,
    describeAiError,
    previewMatches,
    sanitizeRequesterReview,
    pairMassReviewsWithItems,
    recordRequesterReview,
    loadSingleRequestRow,
    loadMassRequestItems,
    loadInFlightCandidates,
    upsertMatch,
    matchRowToDto,
    runSingleRequestMatch,
    runMassRequestMatch,
    scheduleSingleRequestMatch,
    scheduleMassRequestMatch,
    getSingleRequestMatch,
    getMassRequestMatches,
};
