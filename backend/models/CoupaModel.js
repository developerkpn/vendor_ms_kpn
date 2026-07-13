const db = require("../config/connection");
const uuid = require("uuidv4");
const TRANS = require("../config/transaction");
const Vendor = require("../models/VendorModel");

const Coupa = {
    async getBankId(client, bank_key) {
        const res = await client.query(
            `select id from mst_bank_sap where bank_key = $1`,
            [bank_key]
        );

        return res.rows[0]?.id || null;
    },
    async submitVendorCoupa({ ven_detail, ven_banks }) {
        const client = await db.connect();

        try {
            await client.query(TRANS.BEGIN);

            ven_detail.ven_id = uuid.uuid();
            ven_detail.limit_vendor = 0;

            for (const item of ven_banks) {
                const newBankId = await this.getBankId(client, item.bank_id);

                if (!newBankId) {
                    throw new Error(
                        `Bank mapping not found for: ${item.bank_id}`
                    );
                }

                item.bank_id = newBankId;
            }

            console.log(ven_banks);
            await Vendor.setDetailVenCoupa(ven_detail, client);
            await Vendor.setBankRfctr(ven_banks, client, ven_detail.ven_id);
            await Vendor.UploadStaging(ven_detail.ven_id, client);
            await client.query(TRANS.COMMIT);

            return {
                message: `Vendor ${ven_detail.coupa_id} is saved`,
                data: {
                    ven_id: ven_detail.ven_id,
                    name_1: ven_detail.name_1,
                    title: ven_detail.title,
                },
            };
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            client.release();
        }
    },
    async getSubmitted() {
        const client = await db.connect();
        try {
            let q = `SELECT V.VEN_ID as id, V.COUPA_ID, V.NAME_1 as VEN_NAME, V.VEN_CODE FROM VENDOR V
                        WHERE V.is_pushsap is true AND V.COUPA_ID IS NOT NULL`;
            const vals = [];
            const result = await client.query(q, vals);
            return result.rows;
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },
    async detailVendor(code) {
        const client = await db.connect();
        console.log(code);
        try {
            const result = await client.query(
                `SELECT
                    v.*,
                    json_agg(vb.*) AS banks
                FROM vendor v
                LEFT JOIN ven_bank vb ON vb.ven_id = v.ven_id
                WHERE v.ven_code = $1
                GROUP BY v.ven_id`,
                [code]
            );
            return result.rows;
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },
};
module.exports = Coupa;
