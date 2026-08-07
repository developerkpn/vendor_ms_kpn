// Material SAP Oracle-staging service (VMS_MATERIALDATA push + write-back sync).
// warehouse_be-style: the Oracle staging concern lives in its own service. Folds
// the former helper/materialSapStaging.js payload builder together with the two
// MaterialModel push/sync methods (SQL-in-service).
//
// Builds the staging payload per the FDS "Data Staging" table: SAP only reads a
// subset of fields; the rest it hardcodes or derives from its own Z-tables, so
// only the FDS-listed columns are staged. Some VMS values are "CODE - Label"
// (e.g. "C - CHEMICAL INDUSTRY"); SAP wants the bare code → extractSapCode().

const db = require("../config/connection");
const Crud = require("../helper/crudquery");
const { getConnection } = require("../config/oracleconnection");
const {
    MATERIAL_SAP_STAGING_TABLE,
    SINGLE_REQUEST_MATERIAL_CODE_SQL,
    MASS_ITEM_GROUP_CODE_LATERAL_SQL,
    MAX_MATERIAL_DESCRIPTION_LENGTH,
} = require("../constants/material");

// "C - CHEMICAL INDUSTRY" -> "C";  "1 - FULL TAX" -> "1";  "PC" -> "PC".
const extractSapCode = value => {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (s === "") return null;
    const idx = s.indexOf(" - ");
    return idx >= 0 ? s.slice(0, idx).trim() : s;
};

const normalizeTicketType = value => {
    const s = String(value || "Create").trim().toLowerCase();
    if (s === "change") return "Change";
    if (s === "extend") return "Extend";
    return "Create";
};

// MATNR: Create uses the generated running code (final_code); Change/Extend
// reuse the existing SAP material code.
const resolveMaterialNumber = snapshot => {
    const ticket = normalizeTicketType(snapshot.ticket_type);
    if (ticket === "Create") {
        return snapshot.final_code ?? snapshot.material_code ?? null;
    }
    return snapshot.material_code ?? snapshot.final_code ?? null;
};

// DD.MM.YYYY in Asia/Jakarta — dependency-free (matches goodsmvt audit format).
const formatSapDate = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const get = type => parts.find(p => p.type === type)?.value ?? "";
    return `${get("day")}.${get("month")}.${get("year")}`;
};

const readRequestFields = snapshot => {
    let tp = snapshot.template_payload;
    if (typeof tp === "string") {
        try {
            tp = JSON.parse(tp);
        } catch (_e) {
            tp = null;
        }
    }
    return tp && typeof tp.requestFields === "object" && tp.requestFields
        ? tp.requestFields
        : {};
};

/**
 * @param {object} opts
 * @param {object} opts.snapshot       request row joined with material_group_code
 * @param {string} [opts.approvedBy]   local mst_user email of the MDM approver,
 *                                      written to APPROVED_BY (CREATED_BY is left
 *                                      for SAP to fill on write-back)
 * @param {Date}   [opts.now]          timestamp for the approval/push date
 * @returns {object} payload keyed by VMS_MATERIALDATA column names — the KEY
 *                   ORDER is the Oracle column list contract (Crud.insertItemOra
 *                   builds INSERT (cols) from these keys); do not reorder.
 */
const buildMaterialStagingPayload = ({
    snapshot,
    approvedBy = null,
    now = new Date(),
}) => {
    const rf = readRequestFields(snapshot);

    // user-chosen value (template_payload), else null
    const userField = key => {
        const v = rf[key];
        if (v === undefined || v === null) return null;
        return String(v).trim() === "" ? null : v;
    };

    // PURCHASE_ORDER_TEXT continues MATERIAL_DESC: the four description columns
    // are ONE positional partition of the approver's single box (40 MAKTX +
    // 3×70 = 250), so the three long-text columns concatenate back
    // separator-less AND untrimmed — the same contract as the UI's
    // combineMaterialDescription. A separator injects a character SAP does not
    // want and splits a word at a column boundary; a per-column trim eats the
    // real space that lands on one.
    // \s -> " " is a 1:1 length-preserving guard (mirrors the UI's toSingleLine)
    // for rows written before this, so 3×70 = 210 stays exactly the
    // VARCHAR2(210) width and the slice is a belt-and-braces cap.
    const combinedLongText = [
        snapshot.long_text_1,
        snapshot.long_text_2,
        snapshot.long_text_3,
    ]
        .map(v => String(v ?? ""))
        .join("")
        .replace(/\s/g, " ");
    const tdline =
        combinedLongText.trim() === "" ? null : combinedLongText.slice(0, 210);

    const ticketType = normalizeTicketType(snapshot.ticket_type);
    const auditDate = formatSapDate(now);

    // Columns follow the FDS "Data Staging" table. SAP only reads a subset from
    // VMS_MATERIALDATA; it hardcodes the rest and derives PROFIT_CTR / VAL_CLASS
    // from its own Z-tables (ZEXMAT_PRCTR / ZMDMTVALCLASS), so those are not
    // staged here. We still send MATERIAL_TYPE / INDUSTRY_SECTOR / DIVISION as
    // the FDS keeps those columns.
    return {
        APP_REQUEST_NO: snapshot.request_no,
        TICKET_TYPE: ticketType,

        // ===== Material fields (per FDS Data Staging table) =====
        MATERIAL_NUMBER: resolveMaterialNumber(snapshot),
        // MTART / MBRSH are fixed constants (SAP also hardcodes MATL_TYPE=SPAR,
        // IND_SECTOR=C). Not sourced from a table.
        MATERIAL_TYPE: "SPAR",
        INDUSTRY_SECTOR: "C",
        PLANT: extractSapCode(snapshot.plant_code),
        STORAGE_LOCATION: extractSapCode(snapshot.sloc_code),
        // Derived from the plant's company via mst_sales_org (one per company);
        // falls back to any user-supplied value.
        SALES_ORGANIZATION: extractSapCode(
            snapshot.derived_sales_org ?? userField("sales_organization")
        ),
        MATERIAL_DESC: snapshot.material_description ?? null,
        BASE_UOM: extractSapCode(snapshot.base_uom),
        MATERIAL_GROUP:
            snapshot.material_group_code ??
            extractSapCode(userField("material_group")),
        DIVISION: "90", // SAP SPART, fixed constant
        PURCHASE_ORDER_TEXT: tdline,
        MOVING_AVG_PRICE:
            userField("moving_avg_price") ?? userField("MOVING_AVG_PRICE"),

        // ===== Audit =====
        // CREATED_AT / CREATED_BY (SAP material-created date + SAP user id) are
        // filled by SAP on write-back, so they go in NULL. APPROVED_* carry our
        // side: the MDM approval/push date and the approver's mst_user email.
        CREATED_AT: null,
        APPROVED_AT: auditDate,
        CREATED_BY: null,
        APPROVED_BY: approvedBy,

        // ===== SAP-bridge control columns =====
        // FLAG push status: 'I' inserted (here) / 'S' synced / 'E' error (SAP).
        FLAG: "I",
        ISRETREIVEDBYSAP: "FALSE",
        ERRORMSG_POST: null,
    };
};

/**
 * Adapt ONE mat_mass_request_item row to the snapshot shape
 * buildMaterialStagingPayload consumes, so a batch item and a single request
 * produce byte-identical staging rows from one builder.
 *
 * The only real difference is where the description text comes from.
 *
 *   single: ONE 250-char approver box, positionally partitioned across four
 *           columns — material_description holds chars 0..40 (MAKTX) and
 *           long_text_1..3 hold 40..250 (3×70), so MATERIAL_DESC +
 *           PURCHASE_ORDER_TEXT concatenate back to the original string.
 *   mass:   the grid has TWO independent columns, "Material Description" and
 *           "PO Text" — they were never one string, so concatenating them would
 *           glue two unrelated sentences together and split a word at the seam.
 *
 * So the partition is replicated by INTENT, not by literal re-slicing: what the
 * single flow actually guarantees SAP is the two column widths (MAKTX 40, the
 * TDLINE region 3×70 = 210) and a whitespace collapse that is 1:1 in length.
 * Here material_description feeds MATERIAL_DESC capped at 40 and po_text feeds
 * PURCHASE_ORDER_TEXT capped at 210 — the cap is applied by the shared builder
 * itself, by handing po_text in through long_text_1 (long_text_2/3 stay null),
 * which runs it through the same `\s -> " "` collapse + .slice(0, 210) the
 * single rows get. Both caps are belt-and-braces: the mass create endpoint
 * already rejects a description over 40 chars.
 *
 * @param {object} row  mat_mass_request_item row joined with
 *                      material_group_code + derived_sales_org
 * @returns {object} snapshot for buildMaterialStagingPayload
 */
const buildMassItemStagingSnapshot = (row = {}) => {
    const description = String(row.material_description ?? "").replace(
        /\s/g,
        " "
    );

    return {
        request_no: row.request_no,
        // Mass batches are Create-only (enforced at createMassRequest), so
        // MATERIAL_NUMBER always resolves to the composed final_code.
        ticket_type: row.ticket_type ?? "Create",
        final_code: row.final_code ?? null,
        material_code: null,
        plant_code: row.plant_code ?? null,
        sloc_code: row.sloc_code ?? null,
        material_description:
            description.trim() === ""
                ? null
                : description.slice(0, MAX_MATERIAL_DESCRIPTION_LENGTH),
        base_uom: row.base_uom ?? null,
        material_group_code: row.material_group_code ?? null,
        derived_sales_org: row.derived_sales_org ?? null,
        // PO text enters through the long-text partition — see above.
        long_text_1: row.po_text ?? null,
        long_text_2: null,
        long_text_3: null,
        // Items carry no template payload, so MOVING_AVG_PRICE and the
        // user-supplied sales_organization fallback both come out NULL.
        template_payload: null,
    };
};

// ===========================================================================
// Push + write-back sync (decoupled from the approval request; run by the cron
// scheduler). A completed single request is flagged sap_push_status='PENDING';
// a completed MASS request flags every one of its ITEMS the same way, because a
// batch stages one VMS_MATERIALDATA row per item (keyed by the item's own
// request_no), not one row per batch. Both kinds flow through the same loop —
// only the Postgres table the status is written back to differs.
// ===========================================================================

// Which Postgres table a pending target lives in. Keeps the push/sync loops
// free of if/else chains: `kind` selects the table and its id column.
const PUSH_TARGET_TABLES = Object.freeze({
    single: { table: "mat_single_request", label: "material request" },
    mass: { table: "mat_mass_request_item", label: "mass request item" },
});

// Inserts PENDING single requests + PENDING mass items into the Oracle staging
// table. Each row gets its own Oracle commit so one failure does not block the
// rest; the request's/item's sap_push_status advances to PUSHED (or ERROR) on
// the Postgres side.
//
// `requestId` (single) and `massRequestId` (mass) are mutually exclusive
// targeting filters used by the inline post-approval push: passing either one
// restricts the sweep to that kind, so an inline single push never drags in
// unrelated pending mass items and vice versa. Passing neither (the cron)
// sweeps both.
const pushPendingMaterialsToSapStaging = async function ({
    limit = 50,
    requestId = null,
    massRequestId = null,
} = {}) {
    const psql = await db.connect();
    let oraclient;
    const pushed = [];
    const errors = [];
    try {
        const { rows: singleRows } = massRequestId != null
            ? { rows: [] }
            : await psql.query(
            `SELECT
                r.id AS request_id,
                r.request_no,
                r.ticket_type,
                r.final_code,
                ${SINGLE_REQUEST_MATERIAL_CODE_SQL} AS material_code,
                mig.code AS material_group_code,
                r.plant_code,
                r.sloc_code,
                r.material_description,
                r.base_uom,
                r.long_text_1,
                r.long_text_2,
                r.long_text_3,
                r.template_payload,
                r.created_by,
                -- Sales org derived from the plant's company (one per company):
                so.sales_org_code AS derived_sales_org,
                -- MDM approver email (one MDM step per request) -> APPROVED_BY:
                (SELECT mu.email
                   FROM mat_single_request_approval_step s
                   JOIN mst_user mu ON mu.user_id = s.approver_user_id
                  WHERE s.request_id = r.id AND s.kind = 'MDM') AS approved_by_email
             FROM mat_single_request r
             LEFT JOIN mat_item_group mig ON mig.id = r.material_group_id
             LEFT JOIN mst_plant mp ON mp.plant_code = r.plant_code
             LEFT JOIN mst_sales_org so ON so.company_code = mp.company_code
             WHERE r.status = 'DONE' AND r.sap_push_status = 'PENDING'
               ${requestId != null ? "AND r.id = $2" : ""}
             ORDER BY r.updated_at ASC
             LIMIT $1`,
            requestId != null ? [limit, requestId] : [limit]
        );

        // Mass items: one pending row per ITEM (status DONE + PENDING), keyed
        // by the item's own request_no. The group-code LATERAL is needed here
        // because the item stores its material group as free text, not an FK.
        const { rows: massRows } = requestId != null
            ? { rows: [] }
            : await psql.query(
            `SELECT
                i.id AS item_id,
                i.mass_request_id,
                i.item_no,
                i.request_no,
                i.ticket_type,
                i.final_code,
                mig.code AS material_group_code,
                i.plant_code,
                i.sloc_code,
                i.material_description,
                i.base_uom,
                i.po_text,
                -- Sales org derived from the plant's company (one per company):
                so.sales_org_code AS derived_sales_org,
                -- MDM approver email (one MDM step per item) -> APPROVED_BY:
                (SELECT mu.email
                   FROM mat_mass_request_item_approval_step s
                   JOIN mst_user mu ON mu.user_id = s.approver_user_id
                  WHERE s.item_id = i.id AND s.kind = 'MDM'
                  LIMIT 1) AS approved_by_email
             FROM mat_mass_request_item i
             ${MASS_ITEM_GROUP_CODE_LATERAL_SQL}
             LEFT JOIN mst_plant mp ON mp.plant_code = i.plant_code
             LEFT JOIN mst_sales_org so ON so.company_code = mp.company_code
             WHERE i.status = 'DONE' AND i.sap_push_status = 'PENDING'
               ${massRequestId != null ? "AND i.mass_request_id = $2" : ""}
             ORDER BY i.updated_at ASC, i.item_no ASC
             LIMIT $1`,
            massRequestId != null ? [limit, massRequestId] : [limit]
        );

        // One uniform work list: `kind` picks the Postgres table to mark, `id`
        // is that table's primary key, and `snapshot` is already in the shape
        // buildMaterialStagingPayload wants (single rows are natively in it).
        const targets = [
            ...singleRows.map(row => ({
                kind: "single",
                id: row.request_id,
                requestNo: row.request_no,
                snapshot: row,
                approvedBy: row.approved_by_email || null,
            })),
            ...massRows.map(row => ({
                kind: "mass",
                id: row.item_id,
                requestNo: row.request_no,
                snapshot: buildMassItemStagingSnapshot(row),
                approvedBy: row.approved_by_email || null,
            })),
        ];

        if (targets.length === 0) {
            return { pushed, errors };
        }

        oraclient = await getConnection();

        // A Postgres failure when marking one row must not abort the whole
        // batch — the Oracle row may already be committed, so swallow+log and
        // let the next cron tick reconcile.
        const markPushed = async target => {
            const { table, label } = PUSH_TARGET_TABLES[target.kind];
            try {
                await psql.query(
                    `UPDATE ${table}
                     SET sap_push_status = 'PUSHED',
                         sap_pushed_at = NOW(),
                         sap_error_msg = NULL,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [target.id]
                );
            } catch (markError) {
                console.error(
                    `Failed to mark ${label} ${target.id} PUSHED:`,
                    markError
                );
            }
        };

        for (const target of targets) {
            try {
                const payload = buildMaterialStagingPayload({
                    snapshot: target.snapshot,
                    approvedBy: target.approvedBy,
                });
                // Idempotent (re)stage: drop any prior row for this request first
                // so an MDM re-approval after a SAP error replaces the stale
                // (FLAG='E') row with a fresh FLAG='I' row carrying the corrected
                // data, instead of colliding on the APP_REQUEST_NO primary key.
                // This also keeps a benign inline-push/cron overlap on the same
                // PENDING row safe — whichever commits last leaves the same row.
                await oraclient.execute(
                    `DELETE FROM ${MATERIAL_SAP_STAGING_TABLE} WHERE APP_REQUEST_NO = :1`,
                    [target.requestNo]
                );
                const [insertSql, values] = Crud.insertItemOra(
                    MATERIAL_SAP_STAGING_TABLE,
                    payload
                );
                await oraclient.execute(insertSql, values);
                await oraclient.commit();

                await markPushed(target);
                pushed.push(target.requestNo);
            } catch (rowError) {
                try {
                    await oraclient.rollback();
                } catch (_rollbackError) {
                    // ignore — proceed to mark the row and continue
                }

                // ORA-00001 (errorNum 1): the staging row already exists — a
                // prior tick committed to Oracle but didn't mark Postgres (crash
                // or pg blip). SAP already has it, so reconcile to PUSHED rather
                // than stranding the request as a false ERROR.
                if (rowError && rowError.errorNum === 1) {
                    await markPushed(target);
                    pushed.push(target.requestNo);
                    continue;
                }

                const message = String(
                    rowError?.message || rowError || ""
                ).slice(0, 500);
                const { table, label } = PUSH_TARGET_TABLES[target.kind];
                try {
                    await psql.query(
                        `UPDATE ${table}
                         SET sap_push_status = 'ERROR',
                             sap_error_msg = $2,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [target.id, message]
                    );
                } catch (markError) {
                    console.error(
                        `Failed to mark ${label} ${target.id} ERROR:`,
                        markError
                    );
                }
                errors.push({ request_no: target.requestNo, error: message });
            }
        }

        return { pushed, errors };
    } catch (error) {
        console.error("Error pushing materials to SAP staging:", error);
        throw error;
    } finally {
        if (oraclient) {
            try {
                await oraclient.close();
            } catch (_closeError) {
                // ignore
            }
        }
        psql.release();
    }
};

// Reads SAP's write-back (run by the reconcile cron in server.js): a row whose
// FLAG SAP flipped to 'S' promotes the Postgres request to SYNCED (created in
// SAP); FLAG 'E' marks it ERROR with ERRORMSG_POST. Rows still FLAG 'I' stay
// PUSHED ("waiting for SAP"). MATERIAL_NUMBER is the code we pushed (not a
// SAP-returned value), so it is not read back. Confirm the exact SAP write-back
// contract with the SAP team.
//
// Mass items participate exactly like single requests, one Oracle row per item:
// the write-back is looked up by APP_REQUEST_NO, and a mass item's request_no
// lives in its own number range (3xxxxxxxxx) disjoint from the single one
// (1xxxxxxxxx), so both kinds can share one lookup map — `kind` says which
// Postgres table the resulting status lands in.
const syncMaterialStagingFromSap = async function () {
    const psql = await db.connect();
    let oraclient;
    const synced = [];
    const failed = [];
    try {
        const { rows: pendingSingles } = await psql.query(
            `SELECT id, request_no
             FROM mat_single_request
             WHERE sap_push_status = 'PUSHED'
             ORDER BY sap_pushed_at ASC
             LIMIT 500`
        );
        const { rows: pendingMassItems } = await psql.query(
            `SELECT id, request_no
             FROM mat_mass_request_item
             WHERE sap_push_status = 'PUSHED'
             ORDER BY sap_pushed_at ASC
             LIMIT 500`
        );

        if (pendingSingles.length === 0 && pendingMassItems.length === 0) {
            return { synced, failed };
        }

        const targetByRequestNo = new Map([
            ...pendingSingles.map(r => [
                String(r.request_no),
                { kind: "single", id: r.id },
            ]),
            ...pendingMassItems.map(r => [
                String(r.request_no),
                { kind: "mass", id: r.id },
            ]),
        ]);
        const requestNos = [...targetByRequestNo.keys()];

        oraclient = await getConnection();

        const CHUNK = 500;
        for (let i = 0; i < requestNos.length; i += CHUNK) {
            const chunk = requestNos.slice(i, i + CHUNK);
            const binds = chunk.map((_value, ix) => `:${ix + 1}`).join(", ");
            const { rows: oraRows } = await oraclient.execute(
                `SELECT APP_REQUEST_NO, ERRORMSG_POST, FLAG
                 FROM VMS_MATERIALDATA
                 WHERE FLAG IN ('S', 'E')
                   AND APP_REQUEST_NO IN (${binds})`,
                chunk
            );

            for (const oraRow of oraRows) {
                // oracledb default outFormat is ARRAY:
                // [APP_REQUEST_NO, ERRORMSG_POST, FLAG]
                const appRequestNo = oraRow[0];
                const errorPost = oraRow[1];
                const flag = oraRow[2];
                const target = targetByRequestNo.get(String(appRequestNo));
                if (!target) {
                    continue;
                }

                const { table } = PUSH_TARGET_TABLES[target.kind];

                if (flag === "E" || errorPost) {
                    await psql.query(
                        `UPDATE ${table}
                         SET sap_push_status = 'ERROR',
                             sap_error_msg = $2,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [
                            target.id,
                            String(
                                errorPost ?? "SAP error (no message returned)"
                            ).slice(0, 500),
                        ]
                    );
                    failed.push({
                        request_no: appRequestNo,
                        error: errorPost,
                    });
                } else {
                    await psql.query(
                        `UPDATE ${table}
                         SET sap_push_status = 'SYNCED',
                             sap_error_msg = NULL,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [target.id]
                    );
                    synced.push(appRequestNo);
                }
            }
        }

        return { synced, failed };
    } catch (error) {
        console.error("Error syncing materials from SAP staging:", error);
        throw error;
    } finally {
        if (oraclient) {
            try {
                await oraclient.close();
            } catch (_closeError) {
                // ignore
            }
        }
        psql.release();
    }
};

module.exports = {
    MATERIAL_SAP_STAGING_TABLE,
    extractSapCode,
    normalizeTicketType,
    resolveMaterialNumber,
    formatSapDate,
    buildMaterialStagingPayload,
    buildMassItemStagingSnapshot,
    PUSH_TARGET_TABLES,
    pushPendingMaterialsToSapStaging,
    syncMaterialStagingFromSap,
};
