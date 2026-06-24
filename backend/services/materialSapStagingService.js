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

// Create => 'I' (insert/create), Change|Extend => 'U' (update).
const flagForTicketType = ticketType =>
    normalizeTicketType(ticketType) === "Create" ? "I" : "U";

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
 * @param {string} [opts.pushedBy]     audit user written to CREATED_BY/UPDATED_BY
 * @param {Date}   [opts.now]          timestamp for the audit date
 * @returns {object} payload keyed by VMS_MATERIALDATA column names — the KEY
 *                   ORDER is the Oracle column list contract (Crud.insertItemOra
 *                   builds INSERT (cols) from these keys); do not reorder.
 */
const buildMaterialStagingPayload = ({
    snapshot,
    pushedBy = "SYSTEM",
    now = new Date(),
}) => {
    const rf = readRequestFields(snapshot);

    // user-chosen value (template_payload), else null
    const userField = key => {
        const v = rf[key];
        if (v === undefined || v === null) return null;
        return String(v).trim() === "" ? null : v;
    };

    const tdline =
        [snapshot.long_text_1, snapshot.long_text_2, snapshot.long_text_3]
            .map(v => (v == null ? "" : String(v).trim()))
            .filter(Boolean)
            .join("\n")
            .slice(0, 132) || null;

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

        // ===== Audit =====
        CREATED_AT: auditDate,
        UPDATED_AT: auditDate,
        CREATED_BY: pushedBy,
        UPDATED_BY: pushedBy,

        // ===== SAP-bridge control columns =====
        FLAG: flagForTicketType(ticketType),
        ISRETREIVEDBYSAP: "FALSE",
        ERRORMSG_PULL: null,
        ERRORMSG_POST: null,
        SYNCED_MATERIAL_NUMBER: null,
    };
};

// ===========================================================================
// Push + write-back sync (decoupled from the approval request; run by the cron
// scheduler). A completed single request is flagged sap_push_status='PENDING'.
// ===========================================================================

// Inserts PENDING single requests into the Oracle staging table. Each row gets
// its own Oracle commit so one failure does not block the rest; the request's
// sap_push_status advances to PUSHED (or ERROR) on the Postgres side.
const pushPendingMaterialsToSapStaging = async function ({
    limit = 50,
    requestId = null,
} = {}) {
    const psql = await db.connect();
    let oraclient;
    const pushed = [];
    const errors = [];
    try {
        const { rows } = await psql.query(
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
                so.sales_org_code AS derived_sales_org
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

        if (rows.length === 0) {
            return { pushed, errors };
        }

        oraclient = await getConnection();

        // A Postgres failure when marking one row must not abort the whole
        // batch — the Oracle row may already be committed, so swallow+log and
        // let the next cron tick reconcile.
        const markPushed = async requestId => {
            try {
                await psql.query(
                    `UPDATE mat_single_request
                     SET sap_push_status = 'PUSHED',
                         sap_pushed_at = NOW(),
                         sap_error_msg = NULL,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [requestId]
                );
            } catch (markError) {
                console.error(
                    `Failed to mark material request ${requestId} PUSHED:`,
                    markError
                );
            }
        };

        for (const row of rows) {
            try {
                const payload = buildMaterialStagingPayload({
                    snapshot: row,
                    pushedBy: row.created_by || "SYSTEM",
                });
                const [insertSql, values] = Crud.insertItemOra(
                    MATERIAL_SAP_STAGING_TABLE,
                    payload
                );
                await oraclient.execute(insertSql, values);
                await oraclient.commit();

                await markPushed(row.request_id);
                pushed.push(row.request_no);
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
                    await markPushed(row.request_id);
                    pushed.push(row.request_no);
                    continue;
                }

                const message = String(
                    rowError?.message || rowError || ""
                ).slice(0, 500);
                try {
                    await psql.query(
                        `UPDATE mat_single_request
                         SET sap_push_status = 'ERROR',
                             sap_error_msg = $2,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [row.request_id, message]
                    );
                } catch (markError) {
                    console.error(
                        `Failed to mark material request ${row.request_id} ERROR:`,
                        markError
                    );
                }
                errors.push({ request_no: row.request_no, error: message });
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

// Reads SAP's write-back on already-pushed rows: when ISRETREIVEDBYSAP='TRUE',
// promote the Postgres request to SYNCED (capturing SYNCED_MATERIAL_NUMBER) or
// ERROR (capturing ERRORMSG_POST). Rows SAP hasn't pulled yet stay PUSHED.
const syncMaterialStagingFromSap = async function () {
    const psql = await db.connect();
    let oraclient;
    const synced = [];
    const failed = [];
    try {
        const { rows: pending } = await psql.query(
            `SELECT id, request_no
             FROM mat_single_request
             WHERE sap_push_status = 'PUSHED'
             ORDER BY sap_pushed_at ASC
             LIMIT 500`
        );

        if (pending.length === 0) {
            return { synced, failed };
        }

        const idByRequestNo = new Map(
            pending.map(r => [String(r.request_no), r.id])
        );
        const requestNos = [...idByRequestNo.keys()];

        oraclient = await getConnection();

        const CHUNK = 500;
        for (let i = 0; i < requestNos.length; i += CHUNK) {
            const chunk = requestNos.slice(i, i + CHUNK);
            const binds = chunk.map((_value, ix) => `:${ix + 1}`).join(", ");
            const { rows: oraRows } = await oraclient.execute(
                `SELECT APP_REQUEST_NO, SYNCED_MATERIAL_NUMBER, ERRORMSG_POST
                 FROM VMS_MATERIALDATA
                 WHERE ISRETREIVEDBYSAP = 'TRUE'
                   AND APP_REQUEST_NO IN (${binds})`,
                chunk
            );

            for (const oraRow of oraRows) {
                // oracledb default outFormat is ARRAY:
                // [APP_REQUEST_NO, SYNCED_MATERIAL_NUMBER, ERRORMSG_POST]
                const appRequestNo = oraRow[0];
                const syncedMaterialNumber = oraRow[1];
                const errorPost = oraRow[2];
                const id = idByRequestNo.get(String(appRequestNo));
                if (!id) {
                    continue;
                }

                if (errorPost) {
                    await psql.query(
                        `UPDATE mat_single_request
                         SET sap_push_status = 'ERROR',
                             sap_error_msg = $2,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [id, String(errorPost).slice(0, 500)]
                    );
                    failed.push({
                        request_no: appRequestNo,
                        error: errorPost,
                    });
                } else {
                    await psql.query(
                        `UPDATE mat_single_request
                         SET sap_push_status = 'SYNCED',
                             sap_synced_matnr = $2,
                             sap_error_msg = NULL,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [id, syncedMaterialNumber ?? null]
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
    flagForTicketType,
    resolveMaterialNumber,
    formatSapDate,
    buildMaterialStagingPayload,
    pushPendingMaterialsToSapStaging,
    syncMaterialStagingFromSap,
};
