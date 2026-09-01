const db = require("../config/connection");
const uuid = require("uuidv4");
const TRANS = require("../config/transaction");
const crud = require("../helper/crudquery");
const jwt = require("jsonwebtoken");
const Vendor = require("../models/VendorModel");
const Emailer = require("../models/EmailModel");
const moment = require("moment");
const ApprovalTracker = require("../class/ApprovalTrackerClass");
const ApprovalModel = require("./ApprovalModel");
const MutexModel = require("./MutexModel");
const DBClientWrapper = require("../helper/DBClientWrapper");
const EmailModel = require("./EmailModelv2");
const aiValidationService = require("../services/aiValidationService");

const Ticket = {
    async showAll({ is_active, ticket_state }) {
        const client = await db.connect();
        try {
            const params = [];
            let where = "WHERE T.is_active = $1";
            params.push(is_active === "true");

            if (is_active === "true" && ticket_state) {
                const stateArray = ticket_state.split(",").map(s => s.trim());
                where += ` AND ticket_state = ANY($2)`;
                params.push(stateArray);
            }
            let q = `SELECT T.token,
            T.is_active, 
            T.ticket_id, 
            T.created_at,
            UP.fullname as updated_by,
            T.updated_at,
            case when T.cur_pos = 'CEO' then 'CFO'
            when T.cur_pos = 'MGRPRC' then 'Manager'
            when T.cur_pos = 'MGRDWS' then 'MGR PRC DWS'
            when T.cur_pos = 'MGRPRCDWS' then 'Manager DWS'
            else T.cur_pos
            end as cur_pos,
            T.ticket_state,
            V.NAME_1,
            V.VEN_CODE,
            UR.EMAIL,
            T.VALID_UNTIL,
            CASE WHEN T.REJECT_BY IS NOT NULL THEN 'REJECT'
            WHEN T.CUR_POS = 'END' THEN 'ACCEPTED'
            ELSE 'ON PROCESS' END
            AS STATUS_TICKET,
            CASE 
				WHEN T.VALID_UNTIL < NOW() THEN true
				ELSE false 
			END AS IS_EXPIRED
        FROM TICKET T
        LEFT JOIN VENDOR V ON V.VEN_ID = T.VEN_ID
        LEFT JOIN MST_USER UP ON T.updated_by = UP.user_id
        LEFT JOIN MST_USER UR ON UR.USER_ID = T.PROC_ID ${where}
        ORDER BY T.UPDATED_AT DESC, T.CREATED_AT DESC, T.TICKET_ID DESC`;
            const items = await client.query(q);
            return {
                count: items.rowCount,
                data: items.rows,
            };
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },
    async ShowAllv2({ bu_id, dept_id, emp_role_id, q, is_active, user_id }) {
        try {
            const client = await db.connect();
            try {
                let where_val = [];
                let where_que_arr = [];
                let where_que = "";
                let idx = 1;
                const { rows: res_allowed_ttype } = await client.query(
                    `
                    select id_doctype, emp_role_id, dept_id, bu_id, allow_read_all 
                    from approval_steps
                    where emp_role_id = $1 and dept_id = $2 and bu_id = $3
                    `,
                    [emp_role_id, dept_id, bu_id]
                );
                let where_ttype_arr = [];
                if (res_allowed_ttype.length < 1 && emp_role_id != "ADMIN") {
                    return { data: [] };
                } else if (emp_role_id != "ADMIN") {
                    for (const dt of res_allowed_ttype) {
                        if (dt.allow_read_all || is_active == "false") {
                            where_ttype_arr.push(`(approval_type = $${idx})`);
                            where_val.push(dt.id_doctype);
                            idx++;
                        } else {
                            where_ttype_arr.push(
                                `(approval_type like $${idx} and as2.emp_role_id = $${
                                    idx + 1
                                } and as2.dept_id = $${
                                    idx + 2
                                } and as2.bu_id = $${idx + 3})`
                            );
                            where_val.push(`${dt.id_doctype}`);
                            where_val.push(emp_role_id);
                            where_val.push(dept_id);
                            where_val.push(bu_id);
                            idx += 4;
                        }
                    }
                    where_que_arr.push(`(${where_ttype_arr.join(" or ")})`);
                }
                // if (emp_role_id == "STAFF" && is_active) {
                //     where_que_arr.push(`proc_id = $${idx}`);
                //     where_val.push(user_id);
                //     idx++;
                // }
                if (q) {
                    where_que_arr.push(
                        `t.ticket_id like $${idx} or v.ven_code like $${idx} or v.name_1 like $${idx}`
                    );
                    where_val.push(`%${q}%`);
                    idx++;
                }
                if (is_active) {
                    where_que_arr.push(`t.is_active = $${idx}`);
                    where_val.push(is_active);
                    idx++;
                }
                if (where_que_arr.length > 0) {
                    where_que = where_que_arr.join(" and ");
                }
                let que = `
                SELECT T.token,
                        T.is_active, 
                        T.ticket_id, 
                        T.created_at,
                        case 
                            when UP.fullname is not null then UP.fullname
                            else MG.fullname 
                            end
                         as updated_by,
                        T.updated_at,
                        V.NAME_1,
                        V.VEN_CODE,
                        UR.EMAIL,
                        T.VALID_UNTIL,
                        CASE WHEN T.REJECT_BY IS NOT NULL THEN 'REJECT'
                        when T.reject_by is null and t.approval_pos <> 'END' then 'ON PROCESS'
                        when T.reject_by is null and t.approval_pos = 'END' then 'DONE'
                        else ''
                        end as STATUS,
                        T.reject_by,
                        tr.doctype,
                        case
                            when t.approval_pos = 'END' then 'END'
                            else concat(mer.role_name, ' ', md.dept_name)
                        end
                        as CURRENT_POSITION,
                        as2.emp_role_id as cur_pos,
                        as2.dept_id as dept_id_ticket,
                        as2.bu_id,
                        tr.dept_id,
                        CASE 
                            WHEN T.VALID_UNTIL < NOW() THEN true
                            ELSE false 
                        END AS IS_EXPIRED,
                        t.approval_pos, 
                        t.proc_id
                    FROM TICKET T
                    LEFT JOIN VENDOR V ON V.VEN_ID = T.VEN_ID
                    LEFT JOIN MST_USER UP ON T.updated_by = UP.user_id
                    LEFT JOIN MST_MGR MG ON T.updated_by = MG.mgr_id
                    LEFT JOIN MST_USER UR ON UR.USER_ID = T.PROC_ID 
                    left join approval_steps as2 on as2.index_approval = t.approval_pos and as2.id_doctype = t.approval_type
                    left join mst_emp_role mer on mer.role_code = as2.emp_role_id
                    left join mst_department md on md.dept_code = as2.dept_id
                    left join ticket_rule tr on tr.doctype = t.approval_type
                    where t.is_close is null and ${where_que}
                    ORDER BY T.UPDATED_AT DESC, T.CREATED_AT DESC, T.TICKET_ID desc
                `;
                const { rows: results_data, rowCount } = await client.query(
                    que,
                    where_val
                );
                return {
                    data: results_data,
                    count: rowCount,
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

    async headerTicket({ tnum: ticket_num }) {
        const client = await db.connect();
        try {
            let formhd = await client.query(
                `SELECT T.ticket_id as ticket_id, T.cur_pos, T.remarks, t.valid_until, t.ven_id as ticket_ven_id, V.*, 
                PROC.email as email_proc, PROC.role as dep_proc, MDM.email as email_mdm, MDM.role as dep_mdm, VHD.header 
                                FROM TICKET T
                                LEFT JOIN VENDOR V ON V.VEN_ID = T.VEN_ID
                                LEFT JOIN MST_USER PROC ON PROC.USER_ID = T.PROC_ID
                                LEFT JOIN MST_USER MDM ON MDM.USER_ID = T.MDM_ID
                                LEFT JOIN VEN_CODE_HD VHD ON (V.local_ovs = VHD.local_ovs AND v.ven_group = vhd.ven_group AND v.ven_acc = vhd.ven_acc AND v.ven_type = vhd.ven_type )
                                WHERE T.TOKEN = '${ticket_num}'
                                ORDER BY T.CREATED_AT DESC`
            );
            if (formhd.rows[0] == null || formhd.rows[0] == undefined) {
                throw {
                    message: "Ticket is not found",
                };
            }
            const ticketDate = new Date(formhd.rows[0].valid_until).getTime();
            const today = new Date().getTime();
            if (formhd.rows[0].is_active === false) {
                throw {
                    message: `Ticket ${formhd.rows[0].ticket_id} is inactive`,
                };
            }
            if (today > ticketDate) {
                throw {
                    message: `Ticket ${formhd.rows[0].ticket_id} is expired`,
                };
            }
            return formhd.rows[0];
        } catch (err) {
            console.error(err);
            throw err;
        } finally {
            client.release();
        }
    },
    async openNew(params) {
        const client = await db.connect();
        try {
            const today = new Date();
            const until = new Date();
            const year = today.getFullYear().toString().substr(-2);
            const month = ("0" + (today.getMonth() + 1).toString()).substr(-2);
            const f_today = today.toLocaleDateString();
            until.setDate(today.getDate() + 3);
            const f_until = until.toLocaleDateString();
            const ticketid = await client.query(
                "select last_value + 1 as next_value from ticket_id_seq"
            );
            const ven_id = uuid.uuid();
            const token = uuid.uuid();
            const latestnum = ticketid.rows[0].next_value;
            const headerTicket = params.to_who === "VENDOR" ? "VEN" : "PRC";
            const ticketState = params.to_who === "VENDOR" ? "INIT" : "CREA";
            const ticketNumber =
                headerTicket +
                "-" +
                year +
                month +
                String(latestnum).padStart(4, "0");
            // insert into ticket
            await client.query("BEGIN");
            const ticket = {
                ticket_id: ticketNumber,
                ven_id: ven_id,
                proc_id: params.user_id,
                valid_until: until,
                cur_pos: params.to_who,
                t_type: params.to_who,
                ticket_type: params.ticket_type,
                is_active: true,
                token: token,
                ticket_state: ticketState,
            };
            const [q, val] = crud.insertItem("TICKET", ticket, "*");
            const result = await client.query(q, val);
            await client.query("COMMIT");
            return {
                link: `frm/newform/${result.rows[0].token}`,
                token: result.rows[0].token,
            };
        } catch (err) {
            console.error(err);
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    },

    async openNewv2(params, session) {
        try {
            const client = await db.connect();
            const { emp_role_id, dept_id, bu_id } = session;
            const { type_ticket } = params;
            try {
                let headerTicket = "";
                switch (type_ticket) {
                    case "new_vendor":
                        headerTicket = "VEN";
                        break;
                    case "new_vendor_fr_usr":
                        headerTicket = "PRC";
                        break;
                }
                const { rows: doctype } = await client.query(
                    `select doctype from ticket_rule
                    where
                    emp_role_id = $1 and bu_id = $2 and dept_id = $3 and type_ticket = $4`,
                    [emp_role_id, bu_id, dept_id, type_ticket]
                );
                if (doctype.length < 1) {
                    throw new Error(
                        "No doctype for this role exist, please contact administrator"
                    );
                }
                const dtype = doctype[0].doctype;
                const today = new Date();
                const until = new Date();
                const year = today.getFullYear().toString().substr(-2);
                const month = ("0" + (today.getMonth() + 1).toString()).substr(
                    -2
                );
                const f_today = today.toLocaleDateString();
                until.setDate(today.getDate() + 3);
                const f_until = until.toLocaleDateString();
                const ticketid = await client.query(
                    "select last_value + 1 as next_value from ticket_id_seq"
                );
                const ven_id = uuid.uuid();
                const token = uuid.uuid();
                const latestnum = ticketid.rows[0].next_value;
                const ticketNumber =
                    headerTicket +
                    "-" +
                    year +
                    month +
                    String(latestnum).padStart(4, "0");
                // insert into ticket
                await client.query("BEGIN");
                const ticket = {
                    ticket_id: ticketNumber,
                    ven_id: ven_id,
                    proc_id: session.user_id,
                    valid_until: until,
                    cur_pos: null,
                    approval_type: doctype[0].doctype,
                    approval_pos: "0",
                    is_active: true,
                    token: token,
                };
                const [q, val] = crud.insertItem(
                    "TICKET",
                    ticket,
                    "ticket_id, token"
                );
                const result = await client.query(q, val);
                await client.query("COMMIT");
                return {
                    ticket_id: result.rows[0].ticket_id,
                    link: `frm/newform/${result.rows[0].token}`,
                    token: result.rows[0].token,
                };
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },
    async getTicketById(ticket_num, session) {
        const client = await db.connect();
        try {
            const q = `select
                            T.ticket_id as ticket_num,
                            T.token as ticket_id,
                            T.cur_pos,
                            T.ticket_state,
                            T.remarks,
                            coalesce(v.ven_id ,
                            t.ven_id) as ven_id,
                            T.t_type as t_type,
                            T.ticket_type as bunit,
                            T.reject_by as reject_by,
                            t.is_active as ticket_stat,
                            t.approval_type,
                            t.approval_pos,
                            LR.counter ,
                            V.*,
                            PROC.email as email_proc,
                            md.dept_name as dep_proc,
                            MDM.email as email_mdm,
                            MDM.role as dep_mdm,
                            VHD.header,
                            as2.disabled_input,
                            as2.enabled_input,
                            as2.emp_role_id,
                            as2.dept_id,
                            as2.bu_id,
                            bu_ticket.bu_id as bu_ticket_type,
                            t.proc_id
                        from
                            TICKET T
                        left join VENDOR V on
                            V.VEN_ID = T.VEN_ID
                        left join MST_USER PROC on
                            PROC.USER_ID = T.PROC_ID
                        left join MST_USER MDM on
                            MDM.USER_ID = T.MDM_ID
                        left join VEN_CODE_HD VHD on
                            (V.local_ovs = VHD.local_ovs
                                and v.ven_group = vhd.ven_group
                                and v.ven_acc = vhd.ven_acc
                                and v.ven_type = vhd.ven_type )
                        left join                      (
                            select
                                ticket_id,
                                count(remarks) as counter
                            from
                                log_rejection
                            group by
                                ticket_id) LR on
                            LR.ticket_id = T.token
                        left join approval_steps as2 on t.approval_type = as2.id_doctype and t.approval_pos = as2.index_approval
                        left join mst_department md on md.dept_code = proc.dept_id 
                        left join ticket_rule bu_ticket on t.approval_type = bu_ticket.doctype 
                        where
                            T.TOKEN = $1
                        order by
                            T.CREATED_AT desc`;
            const item = await client.query(q, [ticket_num]);
            return item.rows[0];
        } catch (err) {
            console.error(err.stack);
            throw err;
        } finally {
            client.release();
        }
    },

    async submitTicket(item, client) {
        try {
            // let resetTicket = "";
            let payload = [
                { id: "updated_by", value: item.updated_by },
                {
                    id: "updated_at",
                    value: "DEFAULT",
                },
            ];
            if (item.is_draft) {
                // resetTicket = `is_draft = true`;
                payload.push({
                    id: "is_draft",
                    value: true,
                });
            } else {
                // resetTicket = `is_draft = false, reject_by = null`;
                payload.push({
                    id: "is_draft",
                    value: false,
                });
                payload.push({
                    id: "reject_by",
                    value: "null",
                });
            }
            if (item.mdm_id) {
                payload.push({
                    id: "mdm_id",
                    value: item.mdm_id,
                });
            }
            const ticketq =
                await client.query(`SELECT tic.ticket_id, tic.cur_pos, tic.ticket_state, 
                    proc.department as proc, mdm.department as mdm, 
                    v.is_tender, v.name_1,
                    tic.ticket_type
                    from ticket tic
                        left join (select user_id, department from mst_user) proc on proc.user_id = tic.proc_id
                        left join (select user_id, department from mst_user) mdm on mdm.user_id = tic.mdm_id
                        left join vendor v on tic.ven_id = v.ven_id 
                        where tic.token = '${item.ticket_id}'`);
            const ticket = ticketq.rows[0];
            const ticket_type = ticket.ticket_type;
            const session = ticket.ticket_state;
            const proc = ticket.proc;
            const mdm = ticket.mdm;
            const name_1 = ticket.name_1;
            let cur_pos;
            let is_active = true;
            //flow
            // VEN - PROC - MGRPRC - MGRDWS - CEO => ticket_type === DWS
            // VEN - PROC - MGRPRC - CEO => ticket_type === UPS
            if (!item.is_draft) {
                switch (session) {
                    case "INIT":
                        // cur_pos = "PROC";
                        // state = "CREA";
                        payload.push({
                            id: "cur_pos",
                            value: "PROC",
                        });
                        payload.push({
                            id: "ticket_state",
                            value: "CREA",
                        });
                        break;
                    case "CREA":
                        if (ticket.cur_pos === "PROC") {
                            // cur_pos = "MGRPRC";
                            // state = "CREA";
                            if (ticket_type === "UPS") {
                                payload.push({
                                    id: "cur_pos",
                                    value: "MGRPRC",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "CREA",
                                });
                            } else {
                                payload.push({
                                    id: "cur_pos",
                                    value: "MGRDWS",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "CREA",
                                });
                            }
                        } else if (ticket.cur_pos === "MGRPRC") {
                            //Pak IVAN
                            if (item.is_tender || item.is_priority) {
                                // cur_pos = "CEO";
                                // state = "FINA";
                                payload.push({
                                    id: "cur_pos",
                                    value: "CEO",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "FINA",
                                });
                            } else {
                                // cur_pos = "MDM";
                                // state = "FINA";
                                payload.push({
                                    id: "cur_pos",
                                    value: "MDM",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "FINA",
                                });
                            }
                        } else if (ticket.cur_pos === "MGRDWS") {
                            //Pak JONI
                            // cur_pos = "CEO";
                            // state = "FINA";
                            payload.push({
                                id: "cur_pos",
                                value: "MGRPRCDWS",
                            });
                            payload.push({
                                id: "ticket_state",
                                value: "CREA",
                            });
                        } else if (ticket.cur_pos === "MGRPRCDWS") {
                            //Pak Edward
                            if (item.is_tender || item.is_priority) {
                                // cur_pos = "CEO";
                                // state = "FINA";
                                payload.push({
                                    id: "cur_pos",
                                    value: "CEO",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "FINA",
                                });
                            } else {
                                // cur_pos = "MDM";
                                // state = "FINA";
                                payload.push({
                                    id: "cur_pos",
                                    value: "MDM",
                                });
                                payload.push({
                                    id: "ticket_state",
                                    value: "FINA",
                                });
                            }
                        }
                        break;
                    case "FINA":
                        // is_active = false;
                        // state = "END";
                        // cur_pos = "END";
                        payload.push({
                            id: "cur_pos",
                            value: "END",
                        });
                        payload.push({
                            id: "ticket_state",
                            value: "END",
                        });
                        payload.push({
                            id: "is_active",
                            value: false,
                        });
                        break;
                }
            }
            let queryUpdate = [];
            let valueUpdate = [];
            let index = 1;
            for (const pl of payload) {
                if (pl.value !== "null" && pl.value !== "DEFAULT") {
                    queryUpdate.push(`${pl.id} = $${index}`);
                    valueUpdate.push(pl.value);
                    index++;
                } else {
                    queryUpdate.push(`${pl.id} = ${pl.value}`);
                }
            }
            let queryFinal = `UPDATE ticket set ${queryUpdate.join(
                ","
            )} where ticket_id = $${index} returning ticket_id `;
            // const q = `UPDATE ticket
            //                     set cur_pos = $1,
            //                     remarks = $2,
            //                     ticket_state = $3,
            //                     is_active = $4, //
            //                     mdm_id = $5,
            //                     ${resetTicket},
            //                     updated_by = $6, //
            //                     updated_at = DEFAULT
            //                     where ticket_id = $7
            //                     returning ticket_id`;
            // const result = await client.query(q, [
            //     cur_pos,
            //     item.remarks,
            //     state,
            //     is_active,
            //     item.mdm_id,
            //     item.updated_by,
            //     ticket.ticket_id,
            // ]);
            const result = await client.query(queryFinal, [
                ...valueUpdate,
                ticket.ticket_id,
            ]);
            return result;
        } catch (err) {
            console.error(err);
            throw err;
        }
    },

    async rejectTicket(ticket_id, remarks, id_user) {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const today = moment().format("YYYY-MM-DDTHH:mm:ss");
            const ticketq =
                await client.query(`SELECT tic.token as ticket_id, tic.ticket_id as ticket_num, 
                        tic.ticket_state, tic.cur_pos, proc.department as proc, 
                        mdm.department as mdm, v.is_tender, v.name_1  from ticket tic
                        left join (select user_id, department from mst_user) proc on proc.user_id = tic.proc_id
                        left join (select user_id, department from mst_user) mdm on mdm.user_id = tic.mdm_id
                        left join vendor v on tic.ven_id = v.ven_id 
                        where tic.token = '${ticket_id}'`);
            // console.log(ticketq);
            const targets = await this.ticketTarget(ticket_id);
            const dataTrg = targets.data;
            const ticket = ticketq.rows[0];
            const session = ticket.ticket_state;
            const ticket_position = ticket.cur_pos;
            let reject_by;
            let cur_pos;
            let ticket_state;
            switch (session) {
                case "CREA":
                    if (ticket_position === "MGRPRC") {
                        reject_by = "MGRPRC";
                        ticket_state = "CREA";
                        cur_pos = "PROC";
                    } else if (ticket_position === "MGRDWS") {
                        reject_by = "MGRDWS";
                        ticket_state = "CREA";
                        cur_pos = "PROC";
                    } else if (ticket_position === "MGRPRCDWS") {
                        reject_by = "MGRPRCDWS";
                        ticket_state = "CREA";
                        cur_pos = "PROC";
                    } else {
                        reject_by = "PROC";
                        ticket_state = "INIT";
                        cur_pos = "VENDOR";
                    }
                    break;
                case "FINA":
                    reject_by = "MDM";
                    ticket_state = "CREA";
                    cur_pos = "PROC";
                    break;
            }
            const q = `UPDATE ticket
                                set reject_by = '${reject_by}',
                                cur_pos = '${cur_pos}',
                                remarks= '${remarks}',
                                ticket_state = '${ticket_state}',
                                updated_at = DEFAULT
                                where token = '${ticket.ticket_id}'
                                returning ticket_id`;
            const [qins, valins] = crud.insertItem(
                "log_rejection",
                {
                    ticket_id: ticket_id,
                    create_at: today,
                    remarks: remarks,
                    create_by: id_user,
                    ticket_state: session,
                },
                "ticket_id"
            );
            if (session === "CREA") {
                await this.extendTicket(ticket.ticket_id, 3);
            }
            const upTick = await client.query(q);
            const insLog = await client.query(qins, valins);
            await Emailer.toReject(remarks, ticket.name_1, dataTrg.proc_email, [
                dataTrg.mgr_pr_email,
                dataTrg.mgr_md_email,
            ]);
            await client.query(TRANS.COMMIT);
            return [upTick.rows[0].ticket_id, reject_by, ticket.name_1];
        } catch (err) {
            await client.query(TRANS.ROLLBACK);
            console.error(err?.stack);
            return err;
        } finally {
            client.release();
        }
    },

    async RejectTicketv2(ticket_id, remarks, session) {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const ApprovalTrack = new ApprovalTracker(client, ticket_id);
                await ApprovalTrack.init();
                console.log(ApprovalTrack.current_step);
                if (ApprovalTrack.current_step.index_approval == "END") {
                    throw new Error("Ticket already end, cannot be processed");
                }
                const result = await ApprovalModel.RejectApproval(
                    client,
                    ticket_id,
                    remarks,
                    session
                );
                // throw new Error("test");
                await client.query(TRANS.COMMIT);
                return result;
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

    async ticketTarget(ticket_id) {
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
                where t.token = '${ticket_id}'
            `;
            const item = await client.query(getTargetsq);
            return {
                count: item.rowCount,
                data: item.rows[0],
            };
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    async submitVendor({
        ven_detail,
        ven_banks,
        ven_files,
        ticket_id,
        remarks,
        ticket_state,
        is_draft,
        mdm_id,
        cur_pos,
        role,
        edited_fields,
        id_user,
    }) {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const { rows: getdtTType } = await client.query(
                `select ticket_type from ticket where token = $1`,
                [ticket_id]
            );
            const ticket_type = getdtTType[0].ticket_type;
            const client1 = await Vendor.setDetailVen(ven_detail, client);
            const client2 = await Vendor.setBankRfctr(
                ven_banks,
                client,
                ven_detail.ven_id
            );
            if (is_draft === false) {
                const client3 = await Vendor.setFileRfctr(
                    ven_detail.ven_id,
                    ven_files,
                    client
                );
            }
            const ticket = await this.submitTicket(
                {
                    ticket_id: ticket_id,
                    remarks: remarks,
                    mdm_id: mdm_id,
                    updated_by: id_user,
                    is_draft: is_draft,
                    is_tender: ven_detail.is_tender,
                    is_priority: ven_detail.is_priority,
                },
                client
            );

            //emails
            const targets = await this.ticketTarget(ticket_id);
            const dataTrg = targets.data;
            const res_tnum = ven_detail.ticket_num;
            let cc_emailCREA = [dataTrg.mgr_pr_email];
            if (!is_draft && ticket_state === "CREA") {
                if (cur_pos === "PROC") {
                    Emailer.toRequest(
                        ven_detail.ticket_num,
                        dataTrg.proc_fname,
                        ven_detail.name_1,
                        ven_detail.ven_group,
                        ven_detail.ven_acc,
                        ven_detail.company,
                        dataTrg.proc_email,
                        client
                    );
                    if (ticket_type === "UPS") {
                        await Emailer.toMGRPRC(
                            ven_detail,
                            ticket_id,
                            "MGRPRC",
                            client
                        );
                    } else {
                        await Emailer.toMGRPRC(
                            ven_detail,
                            ticket_id,
                            "MGRDWS",
                            client
                        );
                    }
                } else if (cur_pos === "MGRPRC") {
                    if (
                        ven_detail.is_tender === true ||
                        ven_detail.is_priority === true
                    ) {
                        let state;
                        if (ven_detail.is_tender && ven_detail.is_priority) {
                            state = 3;
                        } else if (ven_detail.is_tender) {
                            state = 0;
                        } else if (ven_detail.is_priority) {
                            state = 1;
                        }
                        // state = 0 => is tender
                        // state = 1 => is priority
                        // state = 3 => both
                        await Emailer.toManager(
                            ven_detail.name_1,
                            ven_detail.company,
                            ticket_id,
                            state,
                            client
                        );
                    } else {
                        await Emailer.toMDM(
                            ven_detail.name_1,
                            ticket_id,
                            ven_detail.ticket_num,
                            ven_detail.title,
                            ven_detail.local_ovs,
                            client
                        );
                    }
                } else if (cur_pos === "MGRDWS") {
                    await Emailer.toMGRPRC(
                        ven_detail,
                        ticket_id,
                        "MGRPRCDWS",
                        client
                    );
                } else if (cur_pos === "MGRPRCDWS") {
                    if (
                        ven_detail.is_tender === true ||
                        ven_detail.is_priority === true
                    ) {
                        let state;
                        if (ven_detail.is_tender && ven_detail.is_priority) {
                            state = 3;
                        } else if (ven_detail.is_tender) {
                            state = 0;
                        } else if (ven_detail.is_priority) {
                            state = 1;
                        }
                        // state = 0 => is tender
                        // state = 1 => is priority
                        // state = 3 => both
                        await Emailer.toManager(
                            ven_detail.name_1,
                            ven_detail.company,
                            ticket_id,
                            state,
                            client
                        );
                    } else {
                        await Emailer.toMDM(
                            ven_detail.name_1,
                            ticket_id,
                            ven_detail.ticket_num,
                            ven_detail.title,
                            ven_detail.local_ovs,
                            client
                        );
                    }
                }
            } else if (!is_draft && ticket_state === "FINA") {
                if (
                    ven_detail.ven_code == "" ||
                    ven_detail.ven_code.length != 10
                ) {
                    throw new Error("Inputted Vendor Code is not allowed");
                }
                const { rows: hostname } = await client.query(
                    `
                    select hostname from hostname where mode_env = $1
                    `,
                    [process.env.NODE_ENV]
                );
                const { rows: verificator } = await client.query(`
                    select
                        email
                    from
                        mst_mgr mm
                    left join (
                        select
                            distinct user_group_id,
                            user_group_name
                        from
                            mst_page_access mp) mpa on
                        mm.user_group = mpa.user_group_id
                    where
                        mpa.user_group_name = 'VERIFIC'

                    `);
                const link = `${hostname[0].hostname}/dashboard/vendorverif`;
                await Emailer.RequestVerificator(
                    {
                        title: ven_detail.title,
                        local_ovs: ven_detail.local_ovs,
                        ven_name: ven_detail.name_1,
                    },
                    link,
                    verificator[0].email
                );
                await Vendor.UploadStaging(ven_detail.ven_id, client);
                // //Email vendor sudah complete
                // await Emailer.toApprove(
                //     ven_detail.ven_code,
                //     ven_detail.name_1,
                //     dataTrg.proc_email,
                //     [
                //         dataTrg.mgr_pr_email,
                //         dataTrg.mgr_md_email,
                //         dataTrg.mdm_email,
                //     ]
                // );
                // //Email vendor ke orang pajak
                // await Emailer.NotifPajak(ven_detail);
            } else if (!is_draft && ticket_state === "INIT") {
                Emailer.newRequest(
                    ven_detail.title,
                    ven_detail.local_ovs,
                    ven_detail.name_1,
                    ven_detail.ticket_num,
                    dataTrg.proc_email,
                    [ven_detail.email]
                );
            }
            await client.query(TRANS.COMMIT);
            return res_tnum;
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    async submitVendorv2({
        ticket_id,
        session,
        ven_detail,
        ven_banks,
        ven_files,
        is_draft,
    }) {
        try {
            const client = await db.connect();
            let result;
            try {
                let misc = {};
                await client.query(TRANS.BEGIN);
                const ApprovalTrack = new ApprovalTracker(client, ticket_id);
                let sess = session;
                await ApprovalTrack.init();
                const currentApprovalStep = ApprovalTrack.getCurrentStep();
                if (Object.keys(session).length < 1) {
                    sess = {
                        user_id: "",
                        emp_role_id: "VENDOR",
                        bu_id: "",
                        dept_id: "",
                    };
                    1;
                }
                if (!ApprovalTrack.checkIsApproverAllowed(sess)) {
                    throw new Error("User not allowed to process");
                }

                //set detail vendor
                await Vendor.setDetailVen(ven_detail, client);

                //set bank vendor
                await Vendor.setBankRfctr(ven_banks, client, ven_detail.ven_id);

                //set file vendor
                if (is_draft == false) {
                    const result_upfile = await Vendor.setFileRfctr(
                        ven_detail.ven_id,
                        ven_files,
                        client
                    );
                    // console.log(result_upfile);
                }
                //get updated vendor
                const { rows: res_updated_vendor } = await client.query(
                    `
                    select v.*, t.ticket_id as ticket_num, t.token as ticket_id from vendor v 
                    left join ticket t on v.ven_id = t.ven_id
                    where t.token = $1
                    `,
                    [ticket_id]
                );

                if (is_draft === false) {
                    let next_ap = await ApprovalModel.GetNextIndexApproval(
                        res_updated_vendor[0],
                        ticket_id,
                        client
                    );
                    let next_step = ApprovalTrack.getApprovalStep(
                        next_ap.next_index
                    );

                    //if next_step is wo_auth, create token approval link
                    if (next_ap.next_index != "END") {
                        misc = await ApprovalModel.CreateTokenApprovalLink(
                            client,
                            next_step,
                            ticket_id
                        );
                    }

                    if (next_ap.next_index == "END") {
                        result = await ApprovalModel.EndApproval(
                            client,
                            ticket_id,
                            sess.user_id
                        );
                    } else {
                        result = await ApprovalModel.ProcessApproval(
                            client,
                            next_step,
                            currentApprovalStep,
                            ticket_id,
                            next_ap.submit_email,
                            misc,
                            sess
                        );
                    }
                } else {
                    const ven_detail = res_updated_vendor[0];
                    result = {
                        message: `Ticket ${ven_detail.ticket_num} draft is saved`,
                        data: {
                            name_1: ven_detail.name_1,
                            title: ven_detail.title,
                        },
                    };
                }
                await client.query(TRANS.COMMIT);

                // Hand the finished registration to the external AI document
                // validator. Fires on the first submit of the chain only —
                // index 0 is the VENDOR step on the self-service doctypes and
                // the STAFF step on the *_USR ones, and either way that is the
                // point where the form values and the attachments first exist
                // together. Later approvers do not re-trigger it.
                //
                // After COMMIT and not awaited: the result is advisory, arrives
                // ~30s later on a webhook, and must never be able to fail or
                // slow down a submission that has already succeeded.
                if (
                    is_draft === false &&
                    currentApprovalStep &&
                    String(currentApprovalStep.index_approval) === "0" &&
                    ven_detail &&
                    ven_detail.ven_id
                ) {
                    aiValidationService.submitValidationInBackground(
                        ven_detail.ven_id
                    );
                }

                return result;
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

    async reminderApprovalEmail(ticket_id) {
        return await DBClientWrapper(async client => {
            try {
                const approvalTracker = new ApprovalTracker(client, ticket_id);
                await approvalTracker.init();
                const currentStep = approvalTracker.getCurrentStep();
                if (!currentStep.wo_auth) {
                    throw new Error("Approval flow doesn't need reminder");
                }
                //move position backward to resend
                const backStep = approvalTracker.getApprovalStep(
                    parseInt(currentStep.index_approval) - 1 < 0
                        ? "0"
                        : (parseInt(currentStep.index_approval) - 1).toString()
                );

                const emailType = backStep.def_submit_email;
                //
                const emailConfig = {
                    to: currentStep.email,
                };

                const { rows: last_token } = await client.query(
                    `
                    select token_appr_link from ticket where token = $1
                    `,
                    [ticket_id]
                );
                await EmailModel.ProcessEmailGen(
                    emailType,
                    emailConfig,
                    ticket_id,
                    client,
                    currentStep,
                    { token_appr: last_token[0].token_appr_link },
                    true
                );
                return true;
            } catch (error) {
                throw error;
            }
        });
    },

    async processByLink(token_appr) {
        try {
            /**
             * @type {{emp_role_id : string, bu_id : string, dept_id : string, ticket_id : string}}
             */
            const decoded = jwt.decode(token_appr, process.env.TOKEN_KEY);
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const ApprovalTrack = new ApprovalTracker(
                    client,
                    decoded.ticket_id
                );
                await ApprovalTrack.init();
                let currentApprovalStep = ApprovalTrack.current_step;
                let emp_role_id = ApprovalTrack.current_step.emp_role_id;
                let bu_id = ApprovalTrack.current_step.bu_id;
                let dept_id = ApprovalTrack.current_step.dept_id;
                await MutexModel.CreateLock(decoded.ticket_id, emp_role_id);
                if (!ApprovalTrack.ticket.is_active) {
                    throw new Error("Ticket inactive");
                }
                if (
                    !(
                        emp_role_id == decoded.emp_role_id &&
                        bu_id == decoded.bu_id &&
                        dept_id == decoded.dept_id
                    )
                ) {
                    throw new Error("Forbidden");
                }
                const { rows: get_session_link } = await client.query(
                    `
                    select user_id from all_users where emp_role_id = $1 and dept_id = $2 and (bu_id = $3 or bu_id_1 = $3 or bu_id_2 = $3)                    
                    `,
                    [emp_role_id, dept_id, bu_id]
                );
                const sess = {
                    user_id: get_session_link[0].user_id,
                    emp_role_id: emp_role_id,
                    dept_id: dept_id,
                    bu_id: bu_id,
                };
                const { rows: res_updated_vendor } = await client.query(
                    `
                    select v.* from vendor v 
                    left join ticket t on v.ven_id = t.ven_id
                    where t.token = $1
                    `,
                    [decoded.ticket_id]
                );
                let next_ap = await ApprovalModel.GetNextIndexApproval(
                    res_updated_vendor[0],
                    decoded.ticket_id,
                    client
                );
                let next_step = ApprovalTrack.getApprovalStep(
                    next_ap.next_index.toString()
                );
                const misc = await ApprovalModel.CreateTokenApprovalLink(
                    client,
                    next_step,
                    decoded.ticket_id
                );
                if (next_ap.next_index == "END") {
                    await ApprovalModel.EndApproval(client, decoded.ticket_id);
                } else {
                    result = await ApprovalModel.ProcessApproval(
                        client,
                        next_step,
                        currentApprovalStep,
                        decoded.ticket_id,
                        next_ap.submit_email,
                        misc,
                        sess
                    );
                }
                await client.query(TRANS.COMMIT);
                return result;
                // await ApprovalTrack.init();
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                await MutexModel.Unlock(decoded.ticket_id);
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async renderRejectForm(token_appr) {
        try {
            /**
             * @type {{emp_role_id : string, bu_id : string, dept_id : string, ticket_id : string}}
             */
            const decoded = jwt.decode(token_appr, process.env.TOKEN_KEY);
            const client = await db.connect();
            try {
                const ApprovalTrack = new ApprovalTracker(
                    client,
                    decoded.ticket_id
                );
                await ApprovalTrack.init();
                const current_step = ApprovalTrack.getCurrentStep();
                const emp_role_id = current_step.emp_role_id;
                const bu_id = current_step.bu_id;
                const dept_id = current_step.dept_id;
                await MutexModel.CreateLock(decoded.ticket_id, emp_role_id);
                if (!ApprovalTrack.ticket.is_active) {
                    throw new Error("Ticket inactive");
                }
                if (
                    decoded.dept_id != dept_id ||
                    decoded.bu_id != bu_id ||
                    decoded.emp_role_id != emp_role_id
                ) {
                    throw new Error("Ticket not valid");
                }
                const { rows: res_vendor_data } = await client.query(
                    `
                    select
                        name_1 as name,
                        v.ven_type as type,
                        mc."name" as company,
                        concat(cmv.class_desc,
                        ' (',
                        cmv.class_code,
                        ')') as ven_class,
                        case 
                            when tr.bu_id = 'CG' then 'CG'
                            else 'NON_CG'
                        end as bu_type
                    from
                        vendor v
                    left join ticket t on
                        v.ven_id = t.ven_id
                    left join ticket_rule tr on tr.doctype = t.approval_type 
                    left join cg_mst_venclass cmv on
                        cmv.class_code = v.ven_class
                    left join mst_company mc on
                        mc.comp_id = v.company
                                where t.token = $1
                    `,
                    [decoded.ticket_id]
                );
                return res_vendor_data[0];
            } catch (error) {
                throw error;
            } finally {
                await MutexModel.Unlock(decoded.ticket_id);
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    async getSessionApprbyLink(ticket_id) {
        try {
            const client = await db.connect();
            try {
                const ApprovalTrack = new ApprovalTracker(client, ticket_id);
                await ApprovalTrack.init();
                const current_step = ApprovalTrack.getCurrentStep();
                const emp_role_id = current_step.emp_role_id;
                const dept_id = current_step.dept_id;
                const bu_id = current_step.bu_id;
                const { rows: user_link } = await client.query(
                    `
                    select user_id from all_users where emp_role_id = $1 and bu_id = $2 and dept_id = $3
                    `,
                    [emp_role_id, bu_id, dept_id]
                );
                return {
                    user_id: user_link[0].user_id,
                    emp_role_id: emp_role_id,
                    dept_id: dept_id,
                    bu_id: bu_id,
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

    async processMgr(ticket_id, action) {
        const client = await db.connect();
        let itemup = {};
        try {
            const { rows, rowCount } = await client.query(`
                select t.ticket_id, t.is_active, t.cur_pos,
                t.reject_by,
                v.name_1, v.ven_type, v.ven_id, c.name, c.sap_code as code
                from ticket t
                left join vendor v on v.ven_id = t.ven_id
                left join mst_company c on c.comp_id = v.company
                where token = '${ticket_id}'
            `);
            if (rowCount === 0 || !rows[0].is_active) {
                throw new Error("Ticket is not valid");
            }
            if (rows[0].cur_pos == "PROC" && rows[0].reject_by) {
                return {
                    action: "rejected",
                    ticket_num: rows[0].ticket_id,
                    name: rows[0].name_1,
                    type: rows[0].ven_type,
                    company: `${rows[0].code} - ${rows[0].name}`,
                };
            }
            if (rows[0].cur_pos !== "CEO") {
                throw new Error("Ticket is not valid");
            }
            const date = moment(new Date())
                .utc()
                .format("YYYY-MM-DD HH:mm:ss UTC");
            await client.query(TRANS.BEGIN);
            if (action === "accept") {
                itemup = {
                    cur_pos: "MDM",
                    ticket_state: "FINA",
                    updated_at: date,
                };
                const where = {
                    token: ticket_id,
                };
                const [query, val] = crud.updateItem(
                    "ticket",
                    itemup,
                    where,
                    "ticket_id"
                );
                // console.log(query);
                // console.log(val);
                const updateTicket = await client.query(query, val);
            } else if (action === "reject") {
                itemup = {
                    cur_pos: "PROC",
                    ticket_state: "CREA",
                    reject_by: "CEO",
                    updated_at: date,
                    remarks: "Rejected By CEO",
                };
            }
            await client.query(TRANS.COMMIT);
            return {
                action: action,
                ven_id: rows[0].ven_id,
                ticket_num: rows[0].ticket_id,
                name: rows[0].name_1,
                type: rows[0].ven_type,
                company: `${rows[0].code} - ${rows[0].name}`,
            };
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    async processMgrPrc(ticket_id, action, role) {
        const client = await db.connect();
        try {
            const { rows, rowCount } = await client.query(`
                select t.ticket_id, t.is_active, t.cur_pos, v.local_ovs,
                v.name_1, v.ven_type, v.ven_id, v.description, c.name, c.sap_code as code,
                v.is_tender, v.is_priority, v.company,
                t.reject_by, t.token, v.title, t.ticket_type, t.cur_pos
                from ticket t
                left join vendor v on v.ven_id = t.ven_id
                left join mst_company c on c.comp_id = v.company
                where token = '${ticket_id}'
            `);
            const ticket_type = rows[0].ticket_type;
            const ticket_curpos = rows[0].cur_pos;
            if (
                ticket_type === "UPS" &&
                ["MGRDWS", "MGRPRCDWS"].includes(role)
            ) {
                throw new Error("Ticket is not valid");
            }
            if (ticket_type === "DWS" && role === "MGRPRC") {
                throw new Error("Ticket is not valid");
            }
            if (!["MGRPRC", "MGRDWS", "MGRPRCDWS"].includes(role)) {
                //role not allowed
                throw new Error("Ticket is not valid");
            }
            if (
                ticket_curpos === "PROC" &&
                ["MGRPRC", "MGRDWS", "MGRPRCDWS"].includes(rows[0].reject_by)
            ) {
                //ticket is rejected
                return {
                    action: "rejected",
                    ven_id: rows[0].ven_id,
                    ticket_num: rows[0].ticket_id,
                    name: rows[0].name_1,
                    type: rows[0].ven_type,
                    company: `${rows[0].code} - ${rows[0].name}`,
                };
            }
            if (["CEO", "MDM"].includes(ticket_curpos)) {
                // ticket already approved and on ceo / mdm
                return {
                    action: "accept",
                    ven_id: rows[0].ven_id,
                    ticket_num: rows[0].ticket_id,
                    name: rows[0].name_1,
                    type: rows[0].ven_type,
                    company: `${rows[0].code} - ${rows[0].name}`,
                };
            }
            if (["PROC", "VENDOR"].includes(ticket_curpos)) {
                //ticket still on vendor or procurement
                throw new Error("Ticket is not valid");
            }
            if (rowCount === 0 || !rows[0].is_active) {
                throw new Error("Ticket is not valid");
            } else if (rows[0].cur_pos == "PROC" && rows[0].reject_by) {
                return {
                    action: "rejected",
                    ticket_num: rows[0].ticket_id,
                    name: rows[0].name_1,
                    type: rows[0].ven_type,
                    company: `${rows[0].code} - ${rows[0].name}`,
                };
            }
            // console.log(rows);
            // return;
            const date = moment(new Date())
                .utc()
                .format("YYYY-MM-DD HH:mm:ss UTC");
            await client.query(TRANS.BEGIN);
            if (action === "accept") {
                let itemup;
                if (role === "MGRPRC" || role === "MGRPRCDWS") {
                    if (
                        (rows[0].is_tender || rows[0].is_priority) &&
                        role === "MGRPRC"
                    ) {
                        itemup = {
                            cur_pos: "CEO",
                            ticket_state: "FINA",
                            updated_at: date,
                        };
                        let state;
                        if (rows[0].is_tender && rows[0].is_priority) {
                            state = 3;
                        } else if (rows[0].is_tender) {
                            state = 0;
                        } else if (rows[0].is_priority) {
                            state = 1;
                        }
                        //send email to CEO
                        await Emailer.toManager(
                            rows[0].name_1,
                            rows[0].company,
                            ticket_id,
                            state
                        );
                    } else {
                        itemup = {
                            cur_pos: "MDM",
                            ticket_state: "FINA",
                            updated_at: date,
                        };
                        await Emailer.toMDM(
                            rows[0].name_1,
                            rows[0].token,
                            rows[0].ticket_id,
                            rows[0].title,
                            rows[0].local_ovs
                        );
                    }
                } else if (role === "MGRDWS") {
                    const ven_detail = {
                        ven_id: rows[0].ven_id,
                        company: rows[0].company,
                        name_1: rows[0].name_1,
                        ticket_num: rows[0].ticket_id, // PRC and VEN ticket number
                    };
                    itemup = {
                        cur_pos: "MGRPRCDWS",
                        ticket_state: "CREA",
                        updated_at: date,
                    };
                    await Emailer.toMGRPRC(
                        ven_detail,
                        rows[0].token,
                        "MGRPRCDWS"
                    );
                }
                const where = {
                    token: ticket_id,
                };
                const [query, val] = crud.updateItem(
                    "ticket",
                    itemup,
                    where,
                    "ticket_id"
                );
                const updateTicket = await client.query(query, val);
            } else if (action === "reject") {
                itemup = {
                    reject_by: role,
                    cur_pos: "PROC",
                    ticket_state: "CREA",
                    updated_at: date,
                    remarks: "Rejected By Manager Procurement",
                };
            }
            await client.query(TRANS.COMMIT);
            return {
                action: action,
                ven_id: rows[0].ven_id,
                ticket_num: rows[0].ticket_id,
                name: rows[0].name_1,
                type: rows[0].ven_type,
                company: `${rows[0].code} - ${rows[0].name}`,
            };
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    async extendTicket(ticket_id, days) {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const today = new Date();
            let until = new Date();
            until.setDate(today.getDate() + days);
            const dateTicket = {
                valid_until: until,
            };
            const [q, val] = crud.updateItem(
                "TICKET",
                dateTicket,
                { token: ticket_id },
                "ticket_id"
            );
            const updateTicket = await client.query(q, val);
            await client.query(TRANS.COMMIT);
            return {
                ticket_num: updateTicket.rows[0].ticket_id,
            };
        } catch (error) {
            console.error(error);
            await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            client.release();
        }
    },
};

module.exports = Ticket;
