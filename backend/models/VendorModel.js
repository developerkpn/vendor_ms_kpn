const db = require("../config/connection");
const TRANS = require("../config/transaction");
const uuid = require("uuidv4");
const crud = require("../helper/crudquery");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Exceljs = require("exceljs");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const { hashPassword } = require("../middleware/hashpass");
const { generate4Digit } = require("../helper/helper");
const Emailer = require("./EmailModel");
const { getConnection } = require("../config/oracleconnection");

const Vendor = {
    async showAll({ isactive, limit, start }) {
        const client = await db.connect();
        try {
            let q = `SELECT V.VEN_ID as id, V.NAME_1 as VEN_NAME, V.VEN_CODE, V.ACT_REMARK, V.IS_ACTIVE,
                        T.REMARKS, T.TICKET_ID
                        FROM VENDOR V 
                        LEFT JOIN TICKET_REQSTAT_VEN T ON T.VEN_ID = V.VEN_ID AND T.IS_ACTIVE = true
                        WHERE V.is_active is not null`;

            const vals = [];
            if (isactive != "") {
                q += ` and V.is_active = $1`;
                vals.push(isactive);
            }
            const result = await client.query(q, vals);
            return {
                count: result.rowCount,
                data: result.rows,
            };
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },

    async addBank(client, ven_id, banks) {
        const promise = new Promise(async (resolve, reject) => {
            try {
                banks.map(async bank => {
                    let qInsert = `insert into ven_bank(bankv_id, ven_id, bank_id, bank_acc, acc_hold, acc_name)
                values($1, $2, $3, $4, $5, $6);`;
                    let values = [
                        uuid.uuid(),
                        ven_id,
                        bank.bank_id,
                        bank.bank_acc,
                        bank.acc_hold,
                        bank.acc_name,
                    ];
                    const insertBnk = await client.query(qInsert, values);
                });
                resolve(true);
            } catch (err) {
                // console.error(err.stack);
                reject(err);
            }
        });
        return promise;
    },

    async saveTempFile(client, ven_id) {
        const promise = new Promise(async (resolve, reject) => {
            try {
                let files = await client.query(
                    `select * from temp_ven_file_atth where ven_id = $1`,
                    [ven_id]
                );
                if (files.rows.length === 0) {
                    resolve(true);
                }
                files.rows.map(async file => {
                    let qInsert = `insert into ven_file_atth(file_id, ven_id, file_name, file_type, created_at, created_by, desc_file)
                    values($1, $2, $3, $4, $5, $6, $7)`;
                    let values = [
                        file.file_id,
                        file.ven_id,
                        file.file_name,
                        file.file_type,
                        file.created_at,
                        file.created_by,
                        file.desc_file,
                    ];
                    const insertFile = await client.query(qInsert, values);
                    const cleanTemp = await client.query(
                        `delete from temp_ven_file_atth where ven_id = $1`,
                        [ven_id]
                    );
                });
                resolve(true);
            } catch (err) {
                console.error(err.stack);
                reject(err);
            }
        });
        return promise;
    },

    async setDetailVen(detail, client) {
        /*Flow :
    - file temporary already stored in temp_ven_file_atth, delete after move
    - bank could be multiple, map through bank object
   */
        try {
            const isExist = await client.query(
                `SELECT * FROM VENDOR WHERE ven_id = $1`,
                [detail.ven_id]
            );
            const { rows: getStatusTicket } = await client.query(
                `select reject_by, is_draft from ticket where ven_id = $1`,
                [detail.ven_id]
            );
            // const is_draftdb = getStatusTicket[0].is_draft;
            // const last_ver = isExist.rows[0].last_version;
            const today = new Date();
            if ("valid_until" in detail) {
                const valid_until = new Date(
                    detail.valid_until
                ).toLocaleDateString();
                detail.valid_until = valid_until ? valid_until : null;
            }
            detail.updated_at = moment(today).format("YYYY-MM-DD");
            detail.created_at = moment(today).format("YYYY-MM-DD");
            if (isExist.rowCount != 0) {
                [q, value] = crud.updateItem(
                    "VENDOR",
                    detail,
                    { ven_id: detail.ven_id },
                    "*"
                );
            } else {
                [q, value] = crud.insertItem("VENDOR", detail, "*");
                // return;
            }
            const submitTicket = await client.query(q, value);
            return client;
        } catch (err) {
            console.log(err);
            throw err;
        }
    },

    async setDetailVenCoupa(detail, client) {
        try {
            const today = new Date();
            if ("valid_until" in detail) {
                const valid_until = new Date(
                    detail.valid_until
                ).toLocaleDateString();
                detail.valid_until = valid_until ? valid_until : null;
            }
            detail.updated_at = moment(today).format("YYYY-MM-DD");
            detail.created_at = moment(today).format("YYYY-MM-DD");

            [q, value] = crud.insertItem("vendor", detail, "*");
            console.log(q, value);
            const submit = await client.query(q, value);
            // console.log(submit);
            return submit;
        } catch (err) {
            console.log(err);
            throw err;
        }
    },

    async setTemp(params) {
        const { fields, uploaded_files } = params;
        let promises = [];
        let data = [];
        // return;
        const client = await db.connect();
        await client.query("BEGIN");
        try {
            const qInsert = `insert into temp_ven_file_atth(file_id, ven_id, file_name, file_type, created_by, desc_file)
    values($1, $2, $3, $4, $5, $6) returning ven_id, file_id, file_name, desc_file, file_type, 'temp_ven_file_atth' as source, 'insert' as method`;
            // const { fields, upFile } = await uploadFile(params);
            // console.log(result);

            // const promise = uploaded_files.map(async file => {
            //     let values = [
            //         uuid.uuid(),
            //         fields.ven_id[0],
            //         file,
            //         fields.file_type[0],
            //         fields.created_by[0],
            //         fields.desc_file[0],
            //     ];
            //     return client.query(qInsert, values);
            // });
            for (const file of uploaded_files) {
                let values = [
                    uuid.uuid(),
                    fields.ven_id[0],
                    file,
                    fields.file_type[0],
                    fields.created_by[0],
                    fields.desc_file[0],
                ];
                promises.push(client.query(qInsert, values));
            }
            const result = await Promise.all(promises);
            await client.query("COMMIT");
            result.map(item => {
                data.push(item.rows[0]);
            });
            return data;
        } catch (err) {
            await client.query("ROLLBACK");
            console.error(err.stack);
            throw err;
        } finally {
            client.release();
        }
    },

    async setTempv2({ fields, uploaded_files }) {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                let payload = {
                    file_id: uuid.uuid(),
                    ven_id: fields.ven_id[0],
                    file_name: uploaded_files[0],
                    file_type: fields.file_type[0],
                    created_by: fields.created_by[0],
                    desc_file: fields.desc_file[0],
                };
                if (fields.expired_date) {
                    payload.expired_date = fields.expired_date[0];
                }
                const [queIns, valIns] = crud.insertItem(
                    "temp_ven_file_atth",
                    payload,
                    "ven_id, file_id, file_name, desc_file, file_type, coalesce(to_char(expired_date, 'dd-mm-yyyy'), '') as expired_date,'temp_ven_file_atth' as source, 'insert' as method"
                );
                const { rows: result } = await client.query(queIns, valIns);
                await client.query(TRANS.COMMIT);
                return result[0];
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async deleteTemp({ id, ven_id }) {
        const client = await db.connect();
        await client.query("BEGIN");
        if (id !== "") {
            try {
                const q =
                    "DELETE FROM temp_ven_file_atth where file_id = $1 returning file_name ;";
                const result = await client.query(q, [id]);
                const file_name = result.rows[0].file_name;
                if (os.platform() == "linux") {
                    await fs.promises.unlink(
                        path.join(path.resolve(), "backend/public") +
                            "/" +
                            file_name
                    );
                } else {
                    await fs.promises.unlink(
                        path.join(path.resolve(), "backend\\public") +
                            "\\" +
                            file_name
                    );
                }
                await client.query("COMMIT");
                return result.rows[0];
            } catch (err) {
                client.query(TRANS.ROLLBACK);
                throw err;
            } finally {
                client.release();
            }
        } else {
            try {
                const q =
                    "DELETE FROM temp_ven_file_atth where ven_id = $1 returning file_name ;";
                const result = await client.query(q, [ven_id]);
                result.rows.forEach(async item => {
                    const fileName = item.file_name;
                    try {
                        await fs.promises.unlink(
                            path.join(path.resolve(), "backend\\public") +
                                "\\" +
                                fileName
                        );
                    } catch (error) {
                        throw error;
                    }
                });
                await client.query("COMMIT");
                return result.rows;
            } catch (err) {
                client.query(TRANS.ROLLBACK);
                throw err;
            } finally {
                client.release();
            }
        }
    },

    async deleteFile({ id }) {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const q =
                    "DELETE FROM ven_file_atth where file_id = $1 returning file_name ;";
                const { rows } = await client.query(q, [id]);
                const file_name = rows[0].file_name;
                if (os.platform() == "linux") {
                    await fs.promises.unlink(
                        path.join(path.resolve(), "backend/public") +
                            "/" +
                            file_name
                    );
                } else {
                    await fs.promises.unlink(
                        path.join(path.resolve(), "backend\\public") +
                            "\\" +
                            file_name
                    );
                }
                await client.query("COMMIT");
                return rows[0];
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async getFiles(ven_id) {
        const client = await db.connect();
        try {
            const items = await client.query(
                `select
                file_id as id,
                file_id,
                file_name,
                ty.file_type as desc_file,
                tmp.file_type,
                coalesce(to_char(tmp.expired_date,
                'DD-MM-YYYY'),
                '') as expired_date,
                tmp.created_at,
                'temp_ven_file_atth' as source
            from
                temp_ven_file_atth tmp
            left join ticket t on
                t.ven_id = tmp.ven_id
            left join approval_steps as2 on
                as2.id_doctype = t.approval_type
                and as2.index_approval = '0'
            left join mst_file_type ty on
                ty.file_code = tmp.file_type
                and as2.bu_id = ty.bu_id
            where
                tmp.ven_id = $1
                and tmp.file_type not in ('A001', 'A002', 'A012')
            union 
                        select
                file_id as id,
                file_id,
                file_name,
                ty.file_type as desc_file,
                fl.file_type,
                coalesce(to_char(fl.expired_date,
                'DD-MM-YYYY'),
                '') as expired_date,
                fl.created_at,
                'ven_file_atth' as source
            from
                ven_file_atth fl
            left join ticket t on
                t.ven_id = fl.ven_id
            left join approval_steps as2 on
                as2.id_doctype = t.approval_type
                and as2.index_approval = '0'
            left join mst_file_type ty on
                ty.file_code = fl.file_type
                and as2.bu_id = ty.bu_id
            where
                fl.ven_id = $1
                and fl.file_type not in ('A001', 'A002', 'A012')`,
                [ven_id]
            );
            // console.log(items);
            let result = {
                count: items.rowCount,
                data: items.rows,
            };
            return result;
        } catch (err) {
            throw err;
        } finally {
            client.release();
        }
    },
    async getBank(ven_id) {
        const client = await db.connect();
        try {
            const items = await client.query(
                `SELECT distinct v.id as order_id, v.bankv_id as id, v.bank_acc, v.acc_hold, v.acc_name, 
                case
                    when tr.bu_id = 'CG' then cgb.bank_code
                    else cast(b.id as varchar)
                    end as bank_id,
                case
                    when tr.bu_id = 'CG' then cgb.bank_code
                    else b.bank_code
                    end as bank_code,
                case
                    when tr.bu_id = 'CG' then cgb.bank_name
                    else b.bank_name
                    end as bank_name,
               case
                    when tr.bu_id = 'CG' then cgb.bank_code
                    else b.bank_key
                    end as bank_key,v.bank_curr, v.country, b.source, cgb.is_new,
                case
                    when acl.file_type = 'A001' then acl.file_name
                    else ''
                    end as account_statement_letter,
                case
                    when acl.file_type = 'A001' then acl.file_id
                    else ''
                    end as account_statement_letter_id,
                case
                    when pbk.file_type = 'A002' then pbk.file_name
                    else ''
                    end as passbook,
                    case
                    when pbk.file_type = 'A002' then pbk.file_id
                    else ''
                    end as passbook_id,
                case
                    when fgt.file_type = 'A012' then fgt.file_name
                    else ''
                    end as form_dgt,
                case
                    when pbk.file_type = 'A012' then fgt.file_id
                    else ''
                    end as form_dgt_id
                FROM VEN_BANK V
                LEFT JOIN ticket t on v.ven_id = t.ven_id
                left join ticket_rule tr on tr.doctype = t.approval_type
                left join cg_mst_bank cgb on cgb.bank_code = v.bank_id
                LEFT JOIN MST_BANK_SAP B ON v.bank_id = cast(b.id as varchar)
                LEFT JOIN ven_file_atth acl on acl.bank_id = v.bankv_id and acl.file_type = 'A001'
                LEFT JOIN ven_file_atth pbk on pbk.bank_id = v.bankv_id and pbk.file_type = 'A002'
                LEFT JOIN ven_file_atth fgt on fgt.bank_id = v.bankv_id and fgt.file_type = 'A012'
                WHERE v.is_active = true and v.VEN_ID = $1
                order by order_id asc`,
                [ven_id]
            );
            // console.log(items);
            let result = {
                count: items.rowCount,
                data: items.rows,
            };
            return result;
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },
    async setBank(banks, client) {
        let method;
        let q;
        let val;
        if (banks.length === 0) {
            return client;
        }
        const promises = banks.map(async bank => {
            method = bank.method;
            delete bank.method;
            switch (method) {
                case "insert":
                    bank.bankv_id = uuid.uuid();
                    [q, val] = crud.insertItem("VEN_BANK", bank);
                    return client.query(q, val);

                case "update":
                    [q, val] = crud.updateItem("VEN_BANK", bank, {
                        bankv_id: bank.bankv_id,
                    });
                    return client.query(q, val);
            }
        });
        const promise = Promise.all(promises)
            .then(async result => {
                return client;
            })
            .catch(async err => {
                console.error(err.stack);
                throw err;
            });
        return promise;
    },

    async setBankRfctr(banks, client, ven_id) {
        let promises = [];
        let method;
        let q, val;
        try {
            for (let bank of banks) {
                method = bank.method;
                const payload = {
                    ven_id: ven_id,
                    bank_id: bank.bank_id,
                    bank_acc: bank.bank_acc,
                    country: bank.bank_country ?? null,
                    bank_curr: bank.bank_curr,
                    acc_hold: bank.acc_hold,
                    acc_name: bank.acc_name,
                };
                switch (method) {
                    case "insert":
                        payload.bankv_id = bank.id;
                        [q, val] = crud.insertItem("VEN_BANK", payload);
                        promises.push(client.query(q, val));
                        break;
                    case "update":
                        [q, val] = crud.updateItem("VEN_BANK", payload, {
                            bankv_id: bank.id,
                        });
                        promises.push(client.query(q, val));
                        break;
                }
            }
            const returnPromise = await Promise.all(promises);
            // console.log(returnPromise);
            return returnPromise;
        } catch (error) {
            console.error(error.stack);
            throw error;
        }
    },

    async deleteBankVen(id) {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const payload = {
                    is_active: false,
                    updated_at: moment().format("YYYY-MM-DDTHH:mm:ss"),
                };
                const [upQue, upVal] = crud.updateItem(
                    "ven_bank",
                    payload,
                    { bankv_id: id },
                    "bank_acc"
                );
                const { rows } = await client.query(upQue, upVal);
                await client.query(TRANS.COMMIT);
                return { bank_acc: rows[0].bank_acc };
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async setFile(files, client) {
        let method;
        let q;
        let val;
        let data;
        let ven_id;
        let cleanTemp = false;
        if (files.length === 0) {
            return client;
        }
        const promises = files.map(async file => {
            method = file.method;
            delete file.method;
            switch (method) {
                case "insert":
                    if (!cleanTemp) {
                        cleanTemp = true;
                        ven_id = file.ven_id;
                    }
                    data = await client.query(
                        `SELECT file_id, ven_id, file_name, file_type, created_at, created_by, desc_file FROM TEMP_VEN_FILE_ATTH WHERE file_id = $1`,
                        [file.file_id]
                    );
                    if (data.rowCount === 0) {
                        break;
                    }
                    [q, val] = crud.insertItem("VEN_FILE_ATTH", data.rows[0]);
                    return client.query(q, val);

                case "delete":
                    if (os.platform === "win32") {
                        await fs.promises.unlink(
                            path.join(path.resolve(), "backend\\public") +
                                "\\" +
                                file.file_name
                        );
                    } else {
                        await fs.promises.unlink(
                            path.join(path.resolve(), "backend/public") +
                                "/" +
                                file.file_name
                        );
                    }
                    q = crud.deleteItem(
                        "VEN_FILE_ATTH",
                        "file_id",
                        file.file_id
                    );
                    return client.query(q);
            }
        });
        const promise = Promise.all(promises)
            .then(async result => {
                q = crud.deleteItem("TEMP_VEN_FILE_ATTH", "ven_id", ven_id);
                try {
                    await client.query(q);
                    return client;
                } catch (error) {
                    throw err;
                }
            })
            .catch(err => {
                console.log(err);
                throw err;
            });
        return promise;
    },

    async setFileRfctr(vendor_id, files, client) {
        let method;
        let q;
        let val;
        let data;
        let ven_id;
        let cleanTemp = false;
        let promises = [];
        let files_id = [];
        let restfile = "";
        getTempFiles = await client.query(
            `select 
                file_id, 
                ven_id, 
                file_name, 
                file_type, 
                created_at, 
                created_by, 
                desc_file,
                expired_date,
                'insert' as method 
                from temp_ven_file_atth where ven_id = $1 ${restfile}`,
            [vendor_id]
        );
        tempFiles = getTempFiles.rows;
        let file_toUp = [...files, ...tempFiles];
        try {
            for (let file of file_toUp) {
                method = file.method;
                delete file.method;
                switch (method) {
                    case "insert":
                        if (!cleanTemp) {
                            cleanTemp = true;
                            ven_id = file.ven_id;
                        }
                        data = await client.query(
                            `SELECT file_id, ven_id, file_name, file_type, created_at, created_by, desc_file, expired_date FROM TEMP_VEN_FILE_ATTH WHERE file_id = $1`,
                            [file.file_id]
                        );
                        if (data.rowCount === 0) {
                            break;
                        }
                        [q, val] = crud.insertItem(
                            "VEN_FILE_ATTH",
                            data.rows[0]
                        );
                        promises.push(client.query(q, val));
                        break;
                    case "delete":
                        try {
                            await fs.promises.unlink(
                                path.join(path.resolve(), "backend/public") +
                                    "/" +
                                    file.file_name
                            );
                        } catch (error) {
                            throw error;
                        }
                        q = crud.deleteItem(
                            "VEN_FILE_ATTH",
                            "file_id",
                            file.file_id
                        );
                        promises.push(client.query(q));
                        break;
                }
            }
            // console.log(promises);
            const promise = await Promise.all(promises);
            // throw new Error("error");
            q = crud.deleteItem("TEMP_VEN_FILE_ATTH", "ven_id", ven_id);
            const deleteTemp = await client.query(q);
            return promise;
        } catch (error) {
            console.log(error);
            throw error;
        }
    },

    async getHeaderCode({ local_ovs, ven_acc, ven_type, ven_group }) {
        const client = await db.connect();
        const promise = new Promise(async (resolve, reject) => {
            const q = `SELECT HEADER FROM VEN_CODE_HD WHERE local_ovs = $1 and ven_acc = $2 and ven_type = $3 and ven_group = $4`;
            try {
                const headercode = await client.query(q, [
                    local_ovs,
                    ven_acc,
                    ven_type,
                    ven_group,
                ]);
                resolve({ status: true, header: headercode.rows[0] });
            } catch (err) {
                reject({ status: false, message: "Header not found" });
            } finally {
                client.release();
            }
        });
        return promise;
    },

    async getApprovedVendor() {
        const client = await db.connect();
        try {
            let query = `
            SELECT 
                ven.ven_code,
                ven.name_1,
                ven.email_pic,
                ven.no_telf_pic,
                ven.street,
                ven.city,
                bank.country,
                bank.bank_id,
                bank.bank_curr,
                bank.bank_acc,
                bank.acc_hold,
                user.email,
                file.file_name
            FROM vendor ven
            JOIN ven_bank bank ON ven.ven_id = bank.ven_id
            JOIN ticket tic ON ven.ticket_num = tic.ticket_id
            JOIN mst_user user ON tic.proc_id = user.user_id
            JOIN ven_file_atth file ON ven.ven_id = file.ven_id
            WHERE ven.ven_code IS NOT NULL
            `;

            const result = await client.query(query);
            return {
                count: result.rowCount,
                data: result.rows,
            };
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },

    async CreateUserVendor(client, ven_id, ven_code) {
        try {
            // const client = await db.connect();
            try {
                // await client.query(TRANS.BEGIN);
                const { rows: user_vendor } = await client.query(
                    `
                    select user_id, username from a_uservendor where user_id = $1 or username = $2
                    `,
                    [ven_id, ven_code]
                );
                if (user_vendor.length > 0) {
                    console.log(
                        `User Vendor ${user_vendor[0].username} already created `
                    );
                    return true;
                }
                const { rows: data_ven } = await client.query(
                    `
                    select 
                    ven_id, name_1, email_pic, ven_code
                    from vendor
                    where 
                    ven_id = $1                    
                    `,
                    [ven_id]
                );
                const ven = data_ven[0];
                const rand = generate4Digit();
                const password = `Kpn#2025`;
                const hashed = await hashPassword(password);
                const refreshToken = jwt.sign(
                    { id: ven.ven_id },
                    process.env.TOKEN_KEY,
                    { expiresIn: "6h" }
                );
                const userPayload = {
                    user_id: ven.ven_id,
                    fullname: ven.name_1,
                    email: ven.email_pic,
                    password: hashed,
                    is_active: true,
                    username: ven.ven_code,
                    department: "VENDOR",
                    token: refreshToken,
                    group_id: "39bbc879-0e03-49d2-a16b-c19eecae313d",
                    user_group_id: "2",
                };
                if (!userPayload.email || !userPayload.username)
                    throw new Error("Bad Request");
                // console.log(password);
                // console.log(userPayload);
                const [insertQue, insertVal] = crud.insertItem(
                    "a_uservendor",
                    userPayload,
                    "user_id"
                );
                await client.query(insertQue, insertVal);
                // await client.query(TRANS.COMMIT);
                return true;
            } catch (error) {
                // await client.query(TRANS.ROLLBACK);
                throw error;
            }
        } catch (error) {
            throw error;
        }
    },

    async verifyVendor(verified, id, notes, session) {
        // STATUS: 1 === approved; 2 === rejected
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const [query, value] = crud.updateItem(
                "vendor",
                { is_verif: verified, reject_verif_notes: notes },
                { ven_id: id },
                "ven_id, name_1, email_pic, ven_code"
            );
            const { rows: proc_email } = await client.query(
                `
                select
                    mu.email, t.token
                from
                    ticket t
                left join vendor v on
                    v.ven_id = t.ven_id
                left join mst_user mu on
                    mu.user_id = t.proc_id
                where
                    v.ven_id = $1
                `,
                [id]
            );
            // console.log(query);
            const result = await client.query(query, value);
            const targets = await Vendor.ticket_target(proc_email[0].token);
            const dataTrg = targets;
            // console.log("returning value", result.rows[0]);
            // IF APPROVED
            if (verified == 1) {
                // await Vendor.UploadStaging(result.rows[0].ven_id, client);
                const rand = generate4Digit();
                const password = `Kpn#2025`;
                const hashed = await hashPassword(password);
                const { rows: check_is_exist } = await client.query(
                    `
                    select * from a_uservendor where username = $1                    
                    `,
                    [result.rows[0].ven_code]
                );
                if (check_is_exist.length < 1) {
                    const refreshToken = jwt.sign(
                        { id: result.rows[0].ven_id },
                        process.env.TOKEN_KEY,
                        { expiresIn: "6h" }
                    );
                    const userPayload = {
                        user_id: result.rows[0].ven_id,
                        fullname: result.rows[0].name_1,
                        email: result.rows[0].email_pic,
                        password: hashed,
                        is_active: true,
                        username: result.rows[0].ven_code,
                        department: "VENDOR",
                        token: refreshToken,
                        group_id: "39bbc879-0e03-49d2-a16b-c19eecae313d",
                        user_group_id: "2",
                    };
                    if (!userPayload.email || !userPayload.username)
                        throw new Error("Bad Request");
                    // console.log(password);
                    // console.log(userPayload);
                    const [insertQue, insertVal] = crud.insertItem(
                        "a_uservendor",
                        userPayload,
                        "user_id"
                    );
                    const insertRes = await client.query(insertQue, insertVal);
                }
                // console.log(insertRes);
                // send approve email to proc
                //Email vendor sudah complete
                // await Emailer.toApprove(
                //     result.rows[0].ven_code,
                //     result.rows[0].name_1,
                //     dataTrg.proc_email,
                //     [
                //         dataTrg.mgr_pr_email,
                //         dataTrg.mgr_md_email,
                //         dataTrg.mdm_email,
                //     ]
                // );
                // //Email vendor ke orang pajak
                // await Emailer.NotifPajak(result.rows[0]);
                // await Emailer.approvedVerif(
                //     result.rows[0].ven_code,
                //     result.rows[0].name_1,
                //     result.rows[0].ven_code,
                //     proc_email[0].email,
                //     password
                // );
            }
            // IF REJECTED
            else {
                if (!notes) throw new Error("Reject notes are required");
                console.log(notes);
                const today = moment().format("YYYY-MM-DDTHH:mm:ss");
                const [qins, valins] = crud.insertItem(
                    "log_rejection",
                    {
                        ticket_id: proc_email[0].token,
                        create_at: today,
                        remarks: notes,
                        create_by: session.user_id,
                        ticket_state: "VERIF",
                    },
                    "ticket_id"
                );
                await client.query(
                    `UPDATE ticket
                                set reject_by = 'VERIFIC',
                                cur_pos = 'PROC',
                                remarks= $1,
                                ticket_state = 'FINA',
                                updated_at = DEFAULT
                                where token = $2
                                returning ticket_id`,
                    [notes, proc_email[0].token]
                );
                await client.query(qins, valins);
                // send reject email to proc
                await Emailer.rejectedVerif(
                    result.rows[0].ven_code,
                    result.rows[0].name_1,
                    notes,
                    proc_email[0].email,
                    dataTrg.mdm_email
                );
            }
            await client.query(TRANS.COMMIT);
            return result.rows[0];
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },

    async GetVerifiedVendors(limit, offset, q) {
        try {
            const client = await db.connect();
            try {
                let query = `%${q}%`;
                const { rows } = await client.query(
                    `
                    SELECT auv.fullname, 
                    auv.email, 
                    auv.username, 
                    concat('+', mpc.prefix, '-', no_telf_pic) as telf, 
                    v.ven_id,
                    t.token
                    from a_uservendor auv
                    LEFT JOIN vendor v on auv.user_id = v.ven_id
                    LEFT JOIN mst_phone_code mpc on v.country = mpc.territory 
                    LEFT JOIN ticket t on t.ven_id = v.ven_id
                    where auv.fullname like $1 or auv.username like $2 or auv.email like $3
                    limit $4 offset $5
                    `,
                    [query, query, query, limit, offset]
                );
                const { rows: dataCount } = await client.query(
                    `
                    SELECT count(*) as count_data from a_uservendor auv
                     where auv.fullname like $1 or auv.username like $2 or auv.email like $3
                    `,
                    [query, query, query]
                );

                return {
                    data: rows,
                    count: dataCount[0].count_data,
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async GetVendorVerif() {
        try {
            const client = await db.connect();
            try {
                const vendors = new Map();
                const baseq = `
                    select v.ven_id, 
                    ven_code, 
                    name_1, 
                    email_pic, 
                    concat('+', mpc.prefix, '-', no_telf_pic) as no_telf_pic, 
                    concat(street, ' ', street2, ' ', street3, ' ', street4) as street, 
                    v.city,
                    t.token,
                    mu.email as email_requestor
                    from vendor v
                    left join ticket t on t.ven_id = v.ven_id
                    left join mst_user mu on mu.user_id = t.proc_id
                    left join mst_phone_code mpc on mpc.territory = v.country 
                    where v.is_verif is null 
                    and (v.ven_code is not null and trim(v.ven_code) <> '') 
                `;
                const { rows: data_ven } = await client.query(baseq);
                if (data_ven.length < 1) {
                    throw new Error("List is empty");
                }
                data_ven.forEach(value => {
                    vendors.set(value.ven_id, value);
                });
                const bankbq = `
                WITH vb AS (
                    SELECT
                        v.ven_id,
                        vb.bankv_id,
                        vb.bank_id,
                        bank_acc,
                        acc_hold,
                        a001.file_name AS A001,
                        a002.file_name AS A002
                    FROM ven_bank vb
                    LEFT JOIN vendor v ON v.ven_id = vb.ven_id
                    LEFT JOIN ticket t ON t.ven_id = v.ven_id
                    LEFT JOIN approval_steps as2 ON as2.id_doctype = t.approval_type
                        AND as2.index_approval = '0'
                    LEFT JOIN ven_file_atth a001 ON vb.bankv_id = a001.bank_id
                        AND a001.file_type = 'A001'
                    LEFT JOIN ven_file_atth a002 ON vb.bankv_id = a002.bank_id
                        AND a002.file_type = 'A002'
                    WHERE v.is_verif IS NULL
                    AND (v.ven_code IS NOT NULL AND trim(v.ven_code) <> '')
                    AND as2.bu_id <> 'CG'
                )
                , vb_numeric AS (
                    SELECT *
                    FROM vb
                    WHERE bank_id ~ '^[0-9]+$'
                )
                SELECT
                    vb_numeric.*,
                    mbs.bank_name
                FROM vb_numeric
                LEFT JOIN mst_bank_sap mbs 
                    ON mbs.id = CAST(vb_numeric.bank_id AS int);
                `;
                const { rows: banks } = await client.query(bankbq);
                let initvenid = banks[0].ven_id;
                let bk = [];
                for (let i = 0; i < banks.length; i++) {
                    bk.push(banks[i]);
                    if (banks[i + 1]) {
                        if (initvenid !== banks[i + 1].ven_id) {
                            vendors.set(initvenid, {
                                ...vendors.get(initvenid),
                                bank: bk,
                            });
                            initvenid = banks[i + 1].ven_id;
                            bk = [];
                        }
                    } else {
                        vendors.set(initvenid, {
                            ...vendors.get(initvenid),
                            bank: bk,
                        });
                        initvenid = "";
                        bk = [];
                    }
                }
                return Array.from(vendors.values());
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async ticket_target(ticket_id) {
        const client = await db.connect();
        try {
            const getTargetsq = `
            select 
            proc.email as proc_email, 
            mdm.email as mdm_email, 
            mgr_pr.email as mgr_pr_email,
            mgr_md.email as mgr_md_email,
            proc.fullname as proc_fname,
            mdm.fullname as mdm_fname
            from ticket t
                left join mst_user proc on proc.user_id = t.proc_id
                left join mst_user mdm on mdm.user_id = t.mdm_id
                left join mst_mgr mgr_pr on mgr_pr.mgr_id = proc.mgr_id
                left join mst_mgr mgr_md on mgr_md.mgr_id = mdm.mgr_id
                where t.token = $1
            `;
            const item = await client.query(getTargetsq, [ticket_id]);
            return item.rows[0];
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    async SimpleData(ven_id) {
        try {
            const client = await db.connect();
            try {
                const { rows: vendor_data } = await client.query(
                    `
                    select
                        ven_code,
                        title,
                        local_ovs ,
                        name_1 ,
                        street ,
                        street2,
                        street3,
                        street4,
                        mc2.country_name as country,
                        postal ,
                        city,
                        telf1 ,
                        email,
                        npwp,
                        pay_mthd ,
                        pay_term,
                        mpt.term_name,
                        v.last_version
                    from
                        vendor v
                    left join mst_company mc on
                        mc.comp_id = v.company
                    left join mst_country mc2 on
                        mc2.country_code = v.country
                    left join mst_pay_term mpt on
                        mpt.term_code = v.pay_term
                    where
                        ven_id = $1                    
                    `,
                    [ven_id]
                );

                const { rows: ven_bank } = await client.query(
                    `
                    select
                        bankv_id,
                        mbs.bank_code ,
                        mbs.bank_name ,
                        bank_acc ,
                        bank_curr ,
                        acc_hold,
                        mc.country_name as country,
                        accst.file_name as account_statement_letter,
                        psbk.file_name as passbook,
                        vb.last_version
                        from 
                        ven_bank vb
                    left join mst_bank_sap mbs on
                        mbs.id = vb.bank_id::int
                    left join mst_country mc on
                        mc.country_code = vb.country
                    left join ven_file_atth accst on accst.bank_id = vb.bankv_id and accst.file_type = 'A001'
                    left join ven_file_atth psbk on psbk.bank_id = vb.bankv_id and psbk.file_type = 'A002'
                    where
                        vb.ven_id = $1
                    `,
                    [ven_id]
                );

                const { rows: ven_file } = await client.query(
                    `
                    select mft.file_type, vfa.file_name from ven_file_atth vfa 
                        left join mst_file_type mft on mft.file_code = vfa.file_type 
                        where ven_id = $1 and bank_id is null
                    `,
                    [ven_id]
                );
                if (!vendor_data.length > 0) {
                    throw new Error("Vendor data not found");
                }
                return {
                    detail: vendor_data[0],
                    banks: ven_bank,
                    files: ven_file,
                    version: {
                        vendor: vendor_data[0].last_version,
                        bank: ven_bank[0].last_version,
                    },
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async GetById(ven_id) {
        try {
            const client = await db.connect();
            try {
                const { rows: vendor } = await client.query(
                    `
                    select v.*, mpc.prefix as code_prefix from vendor v 
                    left join mst_phone_code mpc on mpc.territory = v.country
                    where ven_id = $1
                    `,
                    [ven_id]
                );
                const { rows: ven_bank } = await client.query(
                    `
                        select
                            bankv_id,
                            mbs.bank_code ,
                            mbs.bank_name ,
                            bank_acc ,
                            bank_curr ,
                            acc_hold,
                            mc.country_name as country,
                            vb.last_version,
                            accst.file_name as account_statement_letter,
                            psbk.file_name as passbook
                            from 
                            ven_bank vb
                        left join mst_bank_sap mbs on
                            mbs.id = vb.bank_id::int
                        left join mst_country mc on
                            mc.country_code = vb.country
                        left join ven_file_atth accst on accst.bank_id = vb.bankv_id and accst.file_type = 'A001'
                        left join ven_file_atth psbk on psbk.bank_id = vb.bankv_id and psbk.file_type = 'A002'
                        where
                            vb.ven_id = $1
                        `,
                    [ven_id]
                );
                const { rows: ven_file } = await client.query(
                    `
                        select mft.file_type, vfa.file_name, vfa.file_type as file_code from ven_file_atth vfa 
                            left join mst_file_type mft on mft.file_code = vfa.file_type 
                            where ven_id = $1 and bank_id is null
                        `,
                    [ven_id]
                );
                return {
                    detail: vendor[0],
                    files: ven_file,
                    banks: ven_bank,
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async GetRevisionById(ven_id) {
        try {
            const client = await db.connect();
            try {
                const { rows: vendor_stage } = await client.query(
                    `
                    select l.*, mpc.prefix as code_prefix from log_history_edit l 
                    left join vendor v on v.ven_id = l.ven_id and v.last_version = l.version
                    left join mst_phone_code mpc on mpc.territory = l.country
                    where l.ven_id = $1 
                    `,
                    [ven_id]
                );
                const { rows: vendor } = await client.query(
                    `
                    select l.*, mpc.prefix as code_prefix from log_history_edit l 
                    left join (
                    select case when last_version - 1 < 0
                    then last_version
                    else last_version - 1
                    end
                    as last_version, ven_id from vendor
                    ) v on v.ven_id = l.ven_id and v.last_version = l.version
                    left join mst_phone_code mpc on mpc.territory = l.country
                    where l.ven_id = $1 and l.version = v.last_version
                    `,
                    [ven_id]
                );
                const { rows: ven_file } = await client.query(
                    `
                        select
                        lf.file_id as id,
                        lf.file_id,
                            mft.file_type as desc_file,
                            lf.file_name,
                            lf.file_type,
                            v.last_version,
                            lf.updated_at,
                            'server' as source,
                            changes as method
                        from
                            log_file lf
                        left join mst_file_type mft on
                            mft.file_code = lf.file_type
                        left join vendor v on
                            v.ven_id = lf.ven_id
                        where
                            lf.ven_id = $1 
                            and lf."version" = v.last_version 
                        `,
                    [ven_id]
                );
                return {
                    detail_staged: vendor_stage[0],
                    detail: vendor[0],
                    changes: vendor_stage[0].changes,
                    files: ven_file,
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async UploadStaging(ven_id, pgclient) {
        try {
            let psqlclient = pgclient;
            if (!psqlclient) {
                psqlclient = await db.connect();
            }
            let oraclient;
            let sessionLocked = false;
            let releaseError;
            const lockKey = `vms:vendor:staging:${ven_id}`;
            try {
                // Serialize this vendor across replicas, including an upload
                // retried after Oracle committed but the worker lost its lease.
                // Legacy callers supply an open transaction; the worker owns
                // its connection and uses a session lock instead.
                await psqlclient.query(
                    pgclient
                        ? "SELECT pg_advisory_xact_lock(hashtext($1))"
                        : "SELECT pg_advisory_lock(hashtext($1))",
                    [lockKey]
                );
                sessionLocked = !pgclient;
                oraclient = await getConnection();
                oraclient.callTimeout = 60000;
                const { rows: vendor_data } = await psqlclient.query(
                    `
                    select
                        name_1,
                        ven_code,
                        title,
                        local_ovs ,
                        search_term,
                        purch_org,
                        mc.sap_code as company,
                        street ,
                        street2,
                        street3,
                        street4,
                        street_npwp ,
                        street2_npwp,
                        street3_npwp,
                        street4_npwp,
                        v.country,
                        postal ,
                        city,
                        telf1 ,
                        email,
                        npwp,
                        pay_mthd ,
                        pay_term,
                        mpt.term_name,
                        limit_vendor,
                        lim_curr,
                        ven_acc,
                        mpc.prefix as phone_pref,
                        nitku,
                        coupa_id
                    from
                        vendor v
                    left join mst_company mc on
                        mc.comp_id = v.company
                    left join mst_country mc2 on
                        mc2.country_code = v.country
                    left join mst_phone_code mpc on mpc.territory = v.country
                    left join mst_pay_term mpt on
                        mpt.term_code = v.pay_term
                    where
                        ven_id = $1                    
                    `,
                    [ven_id]
                );
                const ven = vendor_data[0];
                if (!ven || !ven.ven_code) {
                    throw new Error("Vendor code is required for SAP staging");
                }
                const { rows: staged } = await oraclient.execute(
                    "SELECT VEN_CODE FROM VMS_VENDORDATA WHERE VEN_ID = :venId",
                    { venId: ven_id }
                );
                if (staged.length) {
                    if (staged.length !== 1 || staged[0][0] !== ven.ven_code) {
                        throw new Error("Existing SAP staging record conflicts with this vendor");
                    }
                    // The header, banks and files are committed together. An
                    // existing matching header means that upload is complete;
                    // preserve SAP's flags and avoid appending duplicate children.
                    return { ven_code: ven.ven_code, already_staged: true };
                }
                let localovs;
                let title = "";
                if (ven.title === "COMPANY") {
                    title = "0003";
                }
                // nontrade : 50, trade : 00
                //
                switch (ven.local_ovs) {
                    case "LOCAL":
                        if (ven.ven_acc == "TRADE") {
                            localovs = "V100";
                        } else {
                            localovs = "V150";
                        }
                        break;
                    case "OVS":
                        if (ven.ven_acc == "TRADE") {
                            localovs = "V200";
                        } else {
                            localovs = "V250";
                        }
                        break;
                }

                const { rows: ven_bank } = await psqlclient.query(
                    `
                    select
                        bankv_id,
                        mbs.bank_key ,
                        mbs.bank_name ,
                        bank_acc ,
                        bank_curr ,
                        acc_hold,
                        vb.country
                        from 
                        ven_bank vb
                    left join mst_bank_sap mbs on
                        mbs.id = vb.bank_id::int
                    left join mst_country mc on
                        mc.country_code = vb.country
                    where
                        vb.ven_id = $1 and vb.is_active = true
                    `,
                    [ven_id]
                );

                const { rows: ven_file } = await psqlclient.query(
                    `
                    select mft.file_code, vfa.file_name from ven_file_atth vfa 
                        left join mst_file_type mft on mft.file_code = vfa.file_type 
                        where ven_id = $1 
                    `,
                    [ven_id]
                );
                const PayloadVenDet = {
                    VEN_ID: ven_id,
                    VEN_CODE: ven.ven_code,
                    TITLE: title,
                    NAME_1: ven.name_1,
                    GROUPING: localovs,
                    COMPANY: ven.company,
                    STREET_1: ven.street,
                    STREET_2: ven.street2,
                    STREET_3: ven.street3,
                    STREET_4: ven.street4,
                    STREET_1_NPWP: ven.street_npwp,
                    STREET_2_NPWP: ven.street2_npwp,
                    STREET_3_NPWP: ven.street3_npwp,
                    STREET_4_NPWP: ven.street4_npwp,
                    CITY: ven.city,
                    TELF_1: `${ven.phone_pref}${ven.telf1}`,
                    EMAIL: ven.email,
                    NPWP: ven.npwp,
                    PAY_MTHD: ven.pay_mthd,
                    PAY_TERM: ven.pay_term,
                    SEARCH_TERM: ven.search_term,
                    PUR_ORG: ven.purch_org,
                    LIMIT: ven.limit_vendor,
                    CURR: ven.lim_curr,
                    POSTAL: ven.postal,
                    COUNTRY: ven.country,
                    ISRETRIEVEDBYSAP: 0,
                    FLAG_CRT: "N",
                    FLAG_EXT: "N",
                    NITKU: ven.nitku,
                    COUPA_ID: ven.coupa_id,
                };

                const [insDet, valDet] = crud.insertItemOra(
                    "VMS_VENDORDATA",
                    PayloadVenDet
                );
                await oraclient.execute(insDet, valDet);
                for (const bank of ven_bank) {
                    const uid = uuid.uuid();
                    const PayloadBank = {
                        UUID: uid,
                        VEN_ID: ven_id,
                        BANK_COUNTRY: bank.country,
                        BANK_ID: bank.bank_key,
                        BANK_ACC: bank.bank_acc,
                        ACC_HOLD: bank.acc_hold,
                        ACC_NAME: bank.bank_name.slice(0, 40),
                    };
                    const [insBank, valBank] = crud.insertItemOra(
                        "VMS_VENDORBANK",
                        PayloadBank
                    );
                    await oraclient.execute(insBank, valBank);
                }
                for (const file of ven_file) {
                    const uid = uuid.uuid();
                    const PayloadFile = {
                        UUID: uid,
                        VEN_ID: ven_id,
                        FILE_TYPE: file.file_code,
                        FILE_NAME: file.file_name,
                    };
                    const [insFile, valFile] = crud.insertItemOra(
                        "VMS_FILEATTACHMENT",
                        PayloadFile
                    );
                    await oraclient.execute(insFile, valFile);
                }
                await oraclient.commit();
                return {
                    ven_code: ven.ven_code,
                };
            } catch (error) {
                if (oraclient) {
                    try {
                        await oraclient.rollback();
                    } catch (rollbackError) {
                        console.error("Vendor staging rollback failed:", rollbackError.message);
                    }
                }
                throw error;
            } finally {
                if (oraclient) {
                    try {
                        await oraclient.close();
                    } catch (closeError) {
                        console.error("Vendor staging connection close failed:", closeError.message);
                    }
                }
                if (sessionLocked) {
                    try {
                        await psqlclient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
                    } catch (unlockError) {
                        releaseError = unlockError;
                    }
                }
                if (!pgclient && psqlclient) {
                    // Drop a connection if unlocking failed, so a session lock
                    // cannot leak back into the connection pool.
                    psqlclient.release(releaseError);
                }
            }
        } catch (error) {
            throw error;
        }
    },

    async SyncStagingVendor() {
        try {
            const oraclient = await getConnection();
            const psqlclient = await db.connect();
            try {
                await psqlclient.query(TRANS.BEGIN);
                const ColORA = {
                    VEN_ID: 0,
                    VEN_CODE: 1,
                    NAME_1: 2,
                    ISRETRIEVEDBYSAP: 3,
                    FLAG_CRT: 4,
                    ERROR_MSG_CRT: 5,
                    FLAG_EXT: 6,
                    ERROR_MSG_EXT: 7,
                };
                const { rows } = await oraclient.execute(`
                    SELECT ${Object.keys(ColORA).join(
                        ", "
                    )} FROM VMS_VENDORDATA WHERE ISRETRIEVEDBYSAP = 1 AND IS_SYNCWEB IS NULL
                    `);
                let VenSuccess = [];
                let VenError = [];
                for (const row of rows) {
                    //if error in push sap
                    if (
                        [
                            row[ColORA["FLAG_CRT"]],
                            row[ColORA["FLAG_EXT"]],
                        ].includes("E")
                    ) {
                        const payloadError = {
                            error_msg:
                                row[ColORA["ERROR_MSG_CRT"]] ??
                                row[ColORA["ERROR_MSG_EX"]],
                            error_code:
                                row[ColORA["FLAG_CRT"]] == "E" ? "CRT" : "EXT",
                        };
                        const [upQue, valQue] = crud.updateItem(
                            "vendor",
                            payloadError,
                            {
                                ven_id: row[ColORA["VEN_ID"]],
                            }
                        );
                        await psqlclient.query(upQue, valQue);
                        VenError.push({
                            VENDOR: row[ColORA["VEN_CODE"]],
                            ERROR:
                                row[ColORA["ERROR_MSG_CRT"]] ??
                                row[ColORA["ERROR_MSG_EX"]],
                        });
                    }
                    //else is flag S => Success
                    else {
                        const payloadSuccess = {
                            is_pushsap: true,
                        };
                        const [upQue, valQue] = crud.updateItem(
                            "vendor",
                            payloadSuccess,
                            {
                                ven_id: row[ColORA["VEN_ID"]],
                            }
                        );
                        await psqlclient.query(upQue, valQue);
                        const payloadOraPulled = {
                            IS_SYNCWEB: 1,
                        };
                        const [upOra, valOra] = crud.updateItemOra(
                            "VMS_VENDORDATA",
                            payloadOraPulled,
                            {
                                VEN_ID: row[ColORA["VEN_ID"]],
                            }
                        );
                        await oraclient.execute(upOra, valOra);
                        await Vendor.CreateUserVendor(
                            psqlclient,
                            row[ColORA["VEN_ID"]],
                            row[ColORA["VEN_CODE"]]
                        );
                        VenSuccess.push(row[ColORA["VEN_CODE"]]);
                    }
                }
                console.log("-------");
                console.log("Vendor Synced");
                console.log("Success : ");
                for (const ven of VenSuccess) {
                    console.log(ven);
                }
                console.log("-------");
                for (const ven of VenError) {
                    console.log(ven.VENDOR);
                    console.log("Error :" + ven.ERROR);
                }
                console.log("-------");
                await oraclient.commit();
                await psqlclient.query(TRANS.COMMIT);
                return {
                    VenSuccess,
                    VenError,
                };
            } catch (error) {
                oraclient.rollback();
                psqlclient.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                if (oraclient) {
                    oraclient.release();
                }
                if (psqlclient) {
                    psqlclient.release();
                }
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    async ShowProgressSyncStagingSAP({ limit, offset, q }) {
        try {
            const client = await db.connect();
            try {
                let whereval = [];
                if (q) {
                    whereval.push(`%${q}%`);
                }
                if (limit && offset) {
                    whereval.push(limit);
                    whereval.push(offset);
                }
                const { rows } = await client.query(
                    `select
                    v.ven_code,
                    v.name_1,
                    v.is_pushsap,
                    to_char(t.updated_at, 'yyyy-mm-dd T HH24:MI:SS') as updated_at,
                    v.error_code,
                    v.error_msg
                from
                    vendor v
                left join ticket t on
                    v.ven_id = t.ven_id
                where
                    (t.ticket_state = 'END'
                        and is_pushsap is null)
                    or
                (is_pushsap is not null
                        and error_code is null
                        and now() < t.updated_at::date + interval '7 days' )
                    ${
                        q ? `and (v.name_1 like $1 or v.ven_code like $1)` : ""
                    } ${limit && offset ? `limit $2 offset $3` : ""}
                `,
                    whereval
                );
                const { rows: ctr } = await client.query(
                    `
                    select count(v.name_1) as counter from vendor v
                    left join ticket t on
                    v.ven_id = t.ven_id
                where
                    (t.ticket_state = 'END'
                        and is_pushsap is null)
                    or
                (is_pushsap is not null
                        and error_code is null
                        and now() < t.updated_at::date + interval '7 days' )
                    ${q ? `and (v.name_1 like $1 or v.ven_code like $1)` : ""}`,
                    whereval.slice(0, 1)
                );
                return {
                    data: rows,
                    count: ctr[0].counter,
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async CutOffVendorUser(file) {
        const colxl = {
            acc_grp: 1,
            ven_code: 2,
            ctry: 3,
            name: 5,
            city: 6,
            street: 7,
            no_id_addr: 8,
            telf: 9,
            fax: 10,
            email: 11,
            pic: 12,
            npwp: 13,
            pkp: 14,
        };
        // const alr_exs = [
        //     "AT11000255",
        //     "AT11000296",
        //     "LN11000431",
        //     "LN11000628",
        //     "LN11001168",
        //     "LN11001909",
        //     "LN11003528",
        //     "LN11004170",
        //     "LN13000429",
        //     "LN13001107",
        //     "LN13004214",
        // ];
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const workbook = new Exceljs.Workbook();
                const exportwb = new Exceljs.Workbook();
                const userlistSheet = exportwb.addWorksheet("ListUser");
                await workbook.xlsx.readFile(file.filepath, {
                    sheetStubs: true,
                });
                const tableHeader = new Map([
                    [
                        "A",
                        {
                            value: "name",
                            label: "Nama",
                            width: 20,
                        },
                    ],
                    [
                        "B",
                        {
                            value: "username",
                            label: "Username",
                            width: 20,
                        },
                    ],
                    [
                        "C",
                        {
                            value: "password",
                            label: "Password",
                            width: 10,
                        },
                    ],
                ]);
                const worksheet = workbook.getWorksheet("Sheet1");
                let tableStart = 1;
                for (const [cell, header] of tableHeader) {
                    userlistSheet.getCell(cell + tableStart).value =
                        header.label;
                    userlistSheet.getColumn(cell).width = header.width;
                    userlistSheet.getCell(cell + tableStart).fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "ffffcc00" },
                    };
                    userlistSheet.getCell(cell + tableStart).border = {
                        top: { style: "thin" },
                        left: { style: "thin" },
                        bottom: { style: "thin" },
                        right: { style: "thin" },
                    };
                }
                tableStart += 1;
                let promises_ven = [];
                let list_user = [];
                let today = new Date();
                let now = moment(today).format("YYYY-MM-DD");
                // let duplicate_ven = [];
                const input_todb = data_ven => {
                    return new Promise(async (resolve, reject) => {
                        try {
                            const { rows: vendor_dt, rowCount } =
                                await client.query(
                                    `
                                select a_ven.username, a_ven.user_id, ven.ticket_num from a_uservendor a_ven
                                left join vendor ven on a_ven.user_id = ven.ven_id
                                where username = $1
                                `,
                                    [data_ven[colxl.ven_code]]
                                );
                            // console.log(rowCount);
                            let exs_ven_id = vendor_dt[0]?.user_id;
                            //kalau aada nomor ticketnya berarti sudah pernah ada dari vendor web
                            let is_alr_ex =
                                vendor_dt[0]?.ticket_num &&
                                vendor_dt[0]?.ticket_num != ""
                                    ? true
                                    : false;
                            let action = "update";
                            if (rowCount == 0) {
                                action = "insert";
                            }
                            // else {
                            //     duplicate_ven.push(data_ven[colxl.ven_code]);
                            // }

                            //masukin data ke vendor
                            let local_ovs = "";
                            let ven_acc = "";
                            let ven_grp = "";
                            let pkp = false;
                            let ven_id = uuid.uuid();
                            if (exs_ven_id) {
                                ven_id = exs_ven_id;
                            }
                            if (
                                data_ven[colxl.pkp] &&
                                data_ven[colxl.pkp] != ""
                            ) {
                                pkp = true;
                            }
                            let ac_grp_data_ven = data_ven[colxl.acc_grp];
                            let ac_grp = "";
                            if (ac_grp_data_ven) {
                                ac_grp = ac_grp_data_ven.toUpperCase();
                            }
                            switch (ac_grp) {
                                case "V100":
                                    local_ovs = "LOCAL";
                                    ven_acc = "TRADE";
                                    ven_grp = "3RD_PARTY";
                                    break;
                                case "V150":
                                    local_ovs = "LOCAL";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "3RD_PARTY";
                                    break;
                                case "V200":
                                    local_ovs = "OVS";
                                    ven_acc = "TRADE";
                                    ven_grp = "3RD_PARTY";
                                    break;
                                case "V250":
                                    local_ovs = "OVS";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "3RD_PARTY";
                                    break;
                                case "V071":
                                    local_ovs = "LOCAL";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "";
                                    break;
                                case "V072":
                                    local_ovs = "LOCAL";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "";
                                    break;
                                case "V075":
                                    local_ovs = "LOCAL";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "";
                                    break;
                                case "V101":
                                    local_ovs = "LOCAL";
                                    ven_acc = "TRADE";
                                    ven_grp = "INTERCO";
                                    break;
                                case "V151":
                                    local_ovs = "LOCAL";
                                    ven_acc = "NON_TRADE";
                                    ven_grp = "INTERCO";
                                    break;
                            }
                            let vendor_data = {
                                ven_id: ven_id,
                                local_ovs: local_ovs,
                                ven_acc: ven_acc,
                                ven_code: data_ven[colxl.ven_code] || "",
                                name_1: data_ven[colxl.name] || "",
                                country: data_ven[colxl.ctry] || "",
                                city: data_ven[colxl.city] || "",
                                street: data_ven[colxl.street] || "",
                                telf1: data_ven[colxl.telf] || "",
                                postal: data_ven[colxl.no_id_addr] || "",
                                fax: data_ven[colxl.fax] || "",
                                email: data_ven[colxl.email] || "",
                                nama_pic: data_ven[colxl.pic] || "",
                                npwp: data_ven[colxl.npwp] || "",
                                is_pkp: pkp,
                                created_at: now,
                            };
                            Object.keys(vendor_data).map(key => {
                                if (key != "is_pkp" && !vendor_data[key]) {
                                    delete vendor_data[key];
                                }
                            });
                            // if (data_ven[colxl.npwp]?.length > 28) {
                            //     console.log(data_ven);
                            //     console.log(data_ven[colxl.ven_code]);
                            //     console.log(data_ven[colxl.npwp]);
                            //     console.log(data_ven[colxl.npwp].trim().length);
                            // }
                            let queDet, valDet;
                            //bukan data duplikat sebelumnya, bisa diupdate atau diinsert
                            if (!is_alr_ex) {
                                switch (action) {
                                    case "insert":
                                        [queDet, valDet] = crud.insertItem(
                                            "vendor",
                                            vendor_data
                                        );
                                        break;
                                    case "update":
                                        [queDet, valDet] = crud.updateItem(
                                            "vendor",
                                            vendor_data,
                                            { ven_id: ven_id }
                                        );
                                        break;
                                }
                                await client.query(queDet, valDet);
                            }
                            // const [insQue, insVal] = crud.insertItem(
                            //     "vendor",
                            //     vendor_data
                            // );
                            //masukin data ke a_uservendor
                            // const rand = generate4Digit();
                            const password = `Kpn#2025`;
                            const hashed = await hashPassword(password);
                            const refreshToken = jwt.sign(
                                { id: ven_id },
                                process.env.TOKEN_KEY,
                                { expiresIn: "6h" }
                            );
                            const userPayload = {
                                user_id: ven_id,
                                fullname: data_ven[colxl.name] ?? "",
                                email: data_ven[colxl.email] ?? "",
                                password: hashed,
                                is_active: true,
                                username: data_ven[colxl.ven_code],
                                department: "VENDOR",
                                token: refreshToken,
                                group_id:
                                    "39bbc879-0e03-49d2-a16b-c19eecae313d",
                                user_group_id: "2",
                            };
                            let uQue, uVal;
                            if (!is_alr_ex) {
                                switch (action) {
                                    case "insert":
                                        [uQue, uVal] = crud.insertItem(
                                            "a_uservendor",
                                            userPayload
                                        );
                                        break;
                                    case "update":
                                        [uQue, uVal] = crud.updateItem(
                                            "a_uservendor",
                                            userPayload,
                                            { user_id: ven_id }
                                        );
                                        break;
                                }
                                await client.query(uQue, uVal);
                            }
                            // const [uQue, uVal] = crud.insertItem(
                            //     "a_uservendor",
                            //     userPayload
                            // );
                            //masukin data ke ven_file_atth untuk kode A005
                            const file_id = uuid.uuid();
                            const filepayload = {
                                file_id: file_id,
                                ven_id: ven_id,
                                file_name: "Dummy.pdf",
                                file_type: "A006",
                                desc_file: "SPPKP / Surat Pernyataan NPKP",
                                created_at: now,
                            };
                            let fileQue, fileVal;
                            if (!is_alr_ex) {
                                const { rowCount } = await client.query(
                                    `select ven_id from ven_file_atth where ven_id = $1 and file_type = 'A006'`,
                                    [ven_id]
                                );
                                let action_file = "update";
                                if (rowCount == 0) {
                                    action_file = "insert";
                                }

                                switch (action_file) {
                                    case "insert":
                                        [fileQue, fileVal] = crud.insertItem(
                                            "ven_file_atth",
                                            filepayload
                                        );
                                        break;
                                    case "update":
                                        [fileQue, fileVal] = crud.updateItem(
                                            "ven_file_atth",
                                            filepayload,
                                            { ven_id: ven_id }
                                        );
                                        break;
                                }
                                await client.query(fileQue, fileVal);
                            }
                            // const [fileQue, fileVal] = crud.insertItem(
                            //     "ven_file_atth",
                            //     filepayload
                            // );
                            if (!is_alr_ex) {
                                list_user.push({
                                    name: data_ven[colxl.name] ?? "",
                                    username: data_ven[colxl.ven_code],
                                    password: password,
                                });
                            }
                            resolve(true);
                        } catch (error) {
                            reject(error);
                        }
                    });
                };
                worksheet.eachRow((row, rowNumber) => {
                    const datarow = row.values;
                    if (datarow[colxl.ven_code] && rowNumber != 1) {
                        const promise_cekdup = input_todb(datarow);
                        promises_ven.push(promise_cekdup);
                    }
                });
                await Promise.all(promises_ven);
                //print result users
                console.log(list_user);
                // console.log(duplicate_ven);
                for (
                    let i = tableStart;
                    i <= list_user.length + tableStart - 1;
                    i++
                ) {
                    const dataRow = list_user[i - tableStart];
                    for (const [cell, header] of tableHeader) {
                        userlistSheet.getCell(cell + i).value = {
                            richText: [
                                {
                                    text:
                                        typeof dataRow[header.value] !==
                                        "string"
                                            ? dataRow[header.value].toString()
                                            : dataRow[header.value],
                                },
                            ],
                        };
                        userlistSheet.getCell(cell + i).border = {
                            top: { style: "thin" },
                            left: { style: "thin" },
                            bottom: { style: "thin" },
                            right: { style: "thin" },
                        };
                    }
                }
                await client.query(TRANS.COMMIT);
                return exportwb;
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async EditExpiryDateFile(file_id, date, source) {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const payload = {
                    expired_date: date,
                };
                const [upQue, upVal] = crud.updateItem(
                    source,
                    payload,
                    { file_id: file_id },
                    "file_name"
                );
                const { rows: result } = await client.query(upQue, upVal);
                await client.query(TRANS.COMMIT);
                return result[0];
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async allVerified(type) {
        const client = await db.connect();
        try {
            let query = `
            select 
                v.ven_id as vendor_id,
                v.ven_code as vendor_code,
                v.name_1 as vendor_name,
                v.email,
                v.is_active,
                v.ven_acc as vendor_account,
                v.ven_type as vendor_type,
                trim(concat_ws(' ',
                    v.street,
                    v.street2,
                    v.street3,
                    v.street4
                )) as street_address
            from vendor v
            where v.is_pushsap = true
        `;

            const values = [];

            if (type) {
                values.push(type.toLowerCase());
                query += ` and lower(v.ven_type) = $${values.length}`;
            }

            const result = await client.query(query, values);

            return {
                count: result.rowCount,
                data: result.rows,
            };
        } catch (err) {
            console.error("error fetching verified vendors:", err);
            throw err;
        } finally {
            client.release();
        }
    },

    // async UpdateVendorData(ticket_id, updated_data) {
    //     try {
    //         const client = await db.connect() ;
    //         try {
    //             //check if last ticket is active
    //             const {rows : ticket_edit} = await client.query(`
    //                 select

    //                 `)
    //         } catch (error) {

    //         } finally {
    //             client.release()
    //         }
    //     } catch (error) {

    //     }
    // }

    /*
     There will be :
     - setter : setDetailVen, setBankVen, setFileVen, setTempFileVen
     - getter : getDetailVen, getBankVen, getFileVen => fetch from each table
     - process : Submit
        =>  Submit : promise all setDetailVen, setBankVen, setFileVen

     -setDetailVen : 
        expected input :
            {
                {ven_id : <ven_id>,
                ... fields for detail vendor}
            }
        expected output :
            boolean
    -setBankVen :
        expected input :
            [
                {
                    mode : <insert, update, delete>,
                    bank_id : <bank_id>,
                    ... fields for bank
                }
                ... array of object bank
            ]
        expected output :
            boolean
    -setFileVen :
        expected input :
            [
                {
                    mode : <insert, delete>,
                    file_id : <file_id>,
                    ... fields for file
                }
                ...array of object file
            ]
        expected output :
            boolean
    -setTempFileVen :
        expected input : multiform 
        expected output :
        [
            {
                mode : insert
                file_id : <file_id>,
                file_name : <file_name>,
                desc_file : <desc_file>
            }
        ]
    */
};

module.exports = Vendor;
