const db = require("../config/connection");
const moment = require("moment");
const uuid = require("uuidv4");
const TRANS = require("../config/transaction");
const Crud = require("../helper/crudquery");
const ApprovalTracker = require("../class/ApprovalTrackerClass");
const { Client } = require("pg");
const EmailModel = require("./EmailModelv2");
const jwt = require("jsonwebtoken");
const Emailer = require("./EmailModel");
const Ticket = require("./TicketModel");
const CGApi = require("./CGApiModel");
const {
    enqueueVendorSubmissionJob,
} = require("../services/vendorSubmissionOutboxService");

const ApprovalModel = {};

ApprovalModel.extendTicket = async (client, ticket_id, days) => {
    try {
        const today = new Date();
        let until = new Date();
        until.setDate(today.getDate() + days);
        const dateTicket = {
            valid_until: until,
        };
        const [q, val] = Crud.updateItem(
            "TICKET",
            dateTicket,
            { token: ticket_id },
            "ticket_id"
        );
        const updateTicket = await client.query(q, val);
        return {
            ticket_num: updateTicket.rows[0].ticket_id,
        };
    } catch (error) {
        console.error(error);
        throw error;
    }
};

ApprovalModel.AddNewRole = async ({ role_name, role_code, user_id }) => {
    try {
        const client = await db.connect();
        try {
            const today = moment().format("YYYY-MM-DDTHH:mm:ss");
            await client.query(TRANS.BEGIN);
            const trimmed_rolecode = role_code.trim();
            let method = "update";
            let result = "";
            let payload = {
                role_name: role_name,
                role_code: trimmed_rolecode,
            };
            const { rows } = await client.query(
                `select role_code from mst_emp_role where role_code = $1`,
                [trimmed_rolecode]
            );
            if (rows.length == 0) {
                method = "insert";
            }

            switch (method) {
                case "insert":
                    payload.create_at = today;
                    payload.create_by = user_id;
                    const [queIns, valIns] = Crud.insertItem(
                        "mst_emp_role",
                        payload,
                        "role_name"
                    );
                    await client.query(queIns, valIns);
                    result = `Role ${role_name} successfully created`;
                    break;

                case "update":
                    payload.update_at = today;
                    payload.update_by = user_id;
                    const [queUp, valUp] = Crud.updateItem(
                        "mst_emp_role",
                        payload,
                        {
                            role_code: role_code,
                        },
                        "role_name"
                    );
                    await client.query(queUp, valUp);
                    result = `Role ${role_name} successfully updated`;
                    break;
            }

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
};

ApprovalModel.DeleteRole = async ({ role_code }) => {
    try {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const { rows: affected_users } = await client.query(
                `update mst_user set emp_role_id = null where emp_role_id = $1 returning username`,
                [role_code]
            );
            const { rows: affected_mgr } = await client.query(
                `update mst_mgr set emp_role_id = null where emp_role_id = $1 returning username`,
                [role_code]
            );
            await client.query(
                `delete from mst_emp_role where role_code = $1`,
                [role_code]
            );
            await client.query(TRANS.COMMIT);
            return {
                affected_users: [...affected_mgr, ...affected_users].map(
                    item => item.username
                ),
            };
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        throw error;
    }
};

/**
 *
 * @param {Object} param
 * @param {string} param.id_doctype
 * @param {string} param.description
 * @param {Object[]} param.flow
 * @param {string} param.flow[].id
 * @param {string} param.flow[].index_approval
 * @param {string} param.flow[].id_role
 * @param {string} param.flow[].bu_id
 * @param {string} param.flow[].dept_id
 * @param {Object} param.flow[].on_submit
 * @param {string} param.flow[].on_submit.id
 * @param {Object[]} param.flow[].on_submit.data
 * @param {string} param.flow[].on_submit.data[].id
 * @param {string} param.flow[].on_submit.data[].group_cond
 * @param {string} param.flow[].on_submit.data[].next_index
 * @param {Object[]} param.flow[].on_submit.data[].condition
 * @param {string} param.flow[].on_submit.data[].condition[].field
 * @param {string} param.flow[].on_submit.data[].condition[].condition
 * @param {string | number | boolean} param.flow[].on_submit.data[].condition[].value
 * @param {string} param.flow[].reject_action
 * @param {numeric} param.flow[].reject_next_index
 * @param {string[] | null} param.flow[].disabled_input
 * @param {string[] | null} param.flow[].enabled_input
 * @param {string} param.flow[].default_next_index
 */

ApprovalModel.CreateApprovalFlow = async ({
    flow,
    id_doctype,
    description,
    method,
    user_id,
}) => {
    try {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const today = moment().toISOString();
            const { rows: check_exist } = await client.query(
                `select id_doctype from approval_doctype where id_doctype = $1`,
                [id_doctype]
            );
            let payload_doctype = {
                description: description,
            };
            if (check_exist.length > 0 && method === "insert") {
                throw new Error("Doctype name already taken");
            }
            if (check_exist.length < 0 && method === "update") {
                throw new Error(
                    "Cannot change doctype name, doctype name is key"
                );
            }
            let queDoc, valDoc;
            if (method === "insert") {
                payload_doctype = {
                    ...payload_doctype,
                    id_doctype: id_doctype,
                    created_at: today,
                    created_by: user_id,
                };
                [queDoc, valDoc] = Crud.insertItem(
                    "approval_doctype",
                    payload_doctype,
                    "id_doctype"
                );
            } else {
                payload_doctype = {
                    ...payload_doctype,
                    updated_at: today,
                    updated_by: user_id,
                };
                [queDoc, valDoc] = Crud.updateItem(
                    "approval_doctype",
                    {
                        id_doctype: id_doctype,
                    },
                    payload_doctype,
                    "id_doctype"
                );
            }
            const { rows: doctype_submit } = await client.query(queDoc, valDoc);
            let approval_steps = [];
            for (const f of flow) {
                let method_flow = "update";
                //check if index approval exist with current doctype
                const { rows: is_step_exist } = await client.query(
                    `select id from approval_steps
                    where index_approval = $1 and id_doctype = $2`,
                    [f.index_approval, id_doctype]
                );
                // if it is new approval index, act as insert
                if (is_step_exist.length == 0) {
                    method_flow = "insert";
                }
                let id_on_submit = null;
                //if there's a on submit condition, create uuid for it
                if (f.on_submit) {
                    id_on_submit = f.on_submit.id;
                    if (!id_on_submit) {
                        id_on_submit = uuid.uuid();
                    }
                }

                let payload = {
                    index_approval: f.index_approval,
                    emp_role_id: f.id_role,
                    bu_id: f.bu_id,
                    dept_id: f.dept_id,
                    on_submit: id_on_submit,
                    reject_action: f.reject_action,
                    reject_next_index: f.reject_next_index,
                    default_next_index: f.default_next_index,
                    def_submit_email_target: f.def_submit_email_target,
                    def_reject_email_target: f.def_reject_email_target,
                    def_submit_email: f.def_submit_email,
                    def_reject_email: f.def_reject_email,
                    is_onetime_appr: f.is_onetime_appr,
                    wo_auth: f.wo_auth,
                    allow_read_all: f.allow_read_all,
                    disabled_input: f.disabled_input,
                    enabled_input: f.enabled_input,
                    id_doctype: id_doctype,
                };
                //insert and update to approval_steps
                let queFlow, valFlow;
                if (method_flow == "insert") {
                    payload = {
                        ...payload,
                        id: uuid.uuid(),
                    };

                    [queFlow, valFlow] = Crud.insertItem(
                        "approval_steps",
                        payload,
                        "id"
                    );
                } else {
                    [queFlow, valFlow] = Crud.updateItem(
                        "approval_steps",
                        payload,
                        {
                            index_approval: f.index_approval,
                            id_doctype: id_doctype,
                        },
                        "id"
                    );
                }
                const { rows: flow_submit } = await client.query(
                    queFlow,
                    valFlow
                );
                // create on_submit afterwards
                if (f.on_submit) {
                    for (const o of f.on_submit.data) {
                        let method_onsub = "update";
                        let payload_on_submit = {
                            on_submit_id: id_on_submit,
                            group_cond: o.group_cond,
                            condition: o.condition,
                            next_index: o.next_index,
                            on_submit_email: o.on_submit_email,
                            on_submit_target: o.on_submit_target,
                        };
                        const { rows: onsub_chk } = await client.query(
                            `select id from approval_onsubmit where group_cond = $1
                            and on_submit_id = $2`,
                            [o.group_cond, id_on_submit]
                        );

                        if (onsub_chk.length == 0) {
                            method_onsub = "insert";
                        }
                        let queOnsub, valOnsub;
                        switch (method_onsub) {
                            case "insert":
                                [queOnsub, valOnsub] = Crud.insertItem(
                                    "approval_onsubmit",
                                    payload_on_submit
                                );
                                break;
                            case "update":
                                [queOnsub, valOnsub] = Crud.updateItem(
                                    "approval_onsubmit",
                                    payload_on_submit,
                                    {
                                        group_cond: o.group_cond,
                                        on_submit_id: id_on_submit,
                                    }
                                );
                                break;
                        }
                        await client.query(queOnsub, valOnsub);
                    }
                }
                approval_steps.push(flow_submit[0].id);
            }
            await client.query(TRANS.COMMIT);
            return {
                doctype: id_doctype,
                approval_steps: approval_steps,
            };
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        throw error;
    }
};

ApprovalModel.GetTicketFlow = async ({ ticket_id, doctype }) => {
    try {
        const client = await db.connect();
        try {
            let FlowTicket = new ApprovalTracker(client, ticket_id, doctype);
            await FlowTicket.init();
            return FlowTicket.getTicketFlow();
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        throw error;
    }
};

/**
 * @param {import("../class/ApprovalTrackerClass").approval_step} next_step
 * @param {import("../class/ApprovalTrackerClass").approval_step} current_step
 * @param {Client} client
 * @param {Object} misc
 * @param {string|undefined} misc.token_appr
 */

ApprovalModel.ProcessApproval = async (
    client,
    next_step,
    current_step,
    ticket_id,
    email_type,
    misc,
    session
) => {
    if (!client) {
        throw new Error("Provide client");
    }
    try {
        //update status ticket
        //check if ota (one time approval), save log if yes
        // console.log(current_step.is_onetime_appr);
        if (current_step.is_onetime_appr) {
            const ota_payload = {
                id_ticket: ticket_id,
                index_approval: current_step.index_approval,
            };
            const [insVal, insQue] = Crud.insertItem(
                "approval_store_ota",
                ota_payload
            );
            await client.query(insVal, insQue);
        }
        // throw new Error("test");
        let up_payload = {
            approval_pos: next_step.index_approval,
            updated_by: session.user_id,
            reject_by: null,
        };
        if ((current_step.emp_role_id = "MDM")) {
            up_payload.mdm_id = session.user_id;
        }
        const [upVal, upQue] = Crud.updateItem(
            "ticket",
            up_payload,
            {
                token: ticket_id,
            },
            "ticket_id"
        );
        let { rows: up_ticket } = await client.query(upVal, upQue);
        let { rows: data_vendor } = await client.query(
            `
            select
                name_1,
                v.ven_type,
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
            [ticket_id]
        );
        //email
        const email_target_type = current_step.def_submit_email_target;
        let email_config = { to: next_step.email };
        if (email_target_type == "PUBLIC") {
            email_config = {
                to: next_step.email,
                cc: current_step.email,
            };
        }
        if (next_step.cc_email) {
            let temp_cc = [];
            let current_cc = email_config?.cc;
            if (current_cc) {
                temp_cc.push(email_config.cc);
            }
            temp_cc.push(next_step.cc_email);
            email_config = {
                ...email_config,
                cc: temp_cc.join(","),
            };
        }
        await EmailModel.ProcessEmailGen(
            email_type,
            email_config,
            ticket_id,
            client,
            next_step,
            misc
        );
        return {
            message: `Ticket ${up_ticket[0].ticket_id} is updated`,
            ...data_vendor[0],
        };
    } catch (error) {
        throw error;
    }
};

ApprovalModel.EndApproval = async (client, ticket_id, user_id) => {
    try {
        const ApprovalTrack = new ApprovalTracker(client, ticket_id);
        await ApprovalTrack.init();
        let vendor_code;
        let vendor_name;
        const up_payload = {
            approval_pos: "END",
            is_active: false,
            updated_by: user_id,
            updated_at: new Date(),
        };
        const [upVal, upQue] = Crud.updateItem(
            "ticket",
            up_payload,
            {
                token: ticket_id,
            },
            "ticket_id"
        );
        await client.query(upVal, upQue);
        const { rows: hostname } = await client.query(
            `
            select hostname from hostname where mode_env = $1
            `,
            [process.env.NODE_ENV]
        );
        const { rows: data_vendor } = await client.query(
            `select title, 
            name_1, 
            case 
                when local_ovs = 'LOCAL' then 'LOCAL'
                when local_ovs = 'OVS' then 'OVERSEAS'
                else ''
                end
            as local_ovs,
            t.ticket_id as ticket_num,
            v.ven_id,
            tr.bu_id,
            v.ven_code,
            v.email_pic
            from vendor v
            left join ticket t on v.ven_id = t.ven_id
            left join ticket_rule tr on tr.doctype = t.approval_type
            where t.token = $1
             `,
            [ticket_id]
        );
        vendor_code = data_vendor[0].ven_code;
        vendor_name = data_vendor[0].name_1;
        const first_step = ApprovalTrack.getApprovalStep("0");
        let to = first_step.email;
        if (first_step.emp_role_id == "VENDOR") {
            to = data_vendor[0].email_pic;
        }
        let cc = ApprovalTrack.getEmailLastSteps();
        let additionalcc = ApprovalTrack.current_step.cc_email;
        cc.push(additionalcc);
        let config = {
            to,
            cc: cc.filter(Boolean).join(","),
        };
        // console.log(config);
        // throw new Error("error");
        const ven_detail = data_vendor[0];
        if (data_vendor[0].bu_id != "CG") {
            const { rows: verificator } = await client.query(`
                select
                    string_agg(email, ',') as email
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
            const job = { ticketToken: ticket_id, venId: ven_detail.ven_id };
            await enqueueVendorSubmissionJob(client, {
                ...job,
                jobType: "SAP_UPLOAD",
            });
            await enqueueVendorSubmissionJob(client, {
                ...job,
                jobType: "VERIFICATION_EMAIL",
                dependsOnType: "SAP_UPLOAD",
                payload: {
                    detail: {
                        title: ven_detail.title,
                        local_ovs: ven_detail.local_ovs,
                        ven_name: ven_detail.name_1,
                    },
                    link,
                    to: verificator[0].email,
                },
            });
            await enqueueVendorSubmissionJob(client, {
                ...job,
                jobType: "TAX_EMAIL",
                dependsOnType: "SAP_UPLOAD",
                payload: { detail: ven_detail },
            });
        } else {
            const result = await CGApi.SubmitToTiptop(
                client,
                ven_detail.ven_id,
                user_id
            );
            vendor_code = result.ven_code;
            vendor_name = result.name;
        }
        //email confirm selesai
        await enqueueVendorSubmissionJob(client, {
            ticketToken: ticket_id,
            venId: ven_detail.ven_id,
            jobType: "COMPLETION_EMAIL",
            dependsOnType: ven_detail.bu_id !== "CG" ? "SAP_UPLOAD" : null,
            payload: { vendorName: vendor_name, vendorCode: vendor_code, config },
        });
        return {
            message: `Ticket ${ven_detail.ticket_num} is Done`,
            ...ven_detail,
        };
    } catch (error) {
        throw error;
    }
};

ApprovalModel.RejectApproval = async (client, ticket_id, remarks, session) => {
    try {
        const today = moment().toISOString();
        // console.log(today);
        // throw new Error("test");
        const ApprovalTrack = new ApprovalTracker(client, ticket_id);
        await ApprovalTrack.init();
        if (!ApprovalTrack.checkIsApproverAllowed(session)) {
            throw new Error("User is not allowed");
        }
        const current_step = ApprovalTrack.current_step;
        const on_reject_action = current_step.reject_action;
        let next_step;
        let next_index;
        switch (on_reject_action) {
            case "deact":
                const payload_deact = {
                    is_active: false,
                    remarks: remarks,
                    reject_by: session.user_id,
                };
                const [deactQue, deactVal] = Crud.updateItem(
                    "ticket",
                    payload_deact,
                    {
                        token: ticket_id,
                    }
                );
                await client.query(deactQue, deactVal);
                break;
            case "move":
                next_index = current_step.reject_next_index.toString();
                const payload_move = {
                    approval_pos: next_index,
                    reject_by: current_step.emp_role_id,
                    remarks: remarks,
                };
                const [moveQue, moveVal] = Crud.updateItem(
                    "ticket",
                    payload_move,
                    {
                        token: ticket_id,
                    }
                );
                await client.query(moveQue, moveVal);
                next_step = ApprovalTrack.getApprovalStep(next_index);
                if (next_step.emp_role_id == "VENDOR") {
                    await ApprovalModel.extendTicket(client, ticket_id, 3);
                }
                break;
        }
        const [qins, valins] = Crud.insertItem(
            "log_rejection",
            {
                ticket_id: ticket_id,
                create_at: today,
                remarks: remarks,
                create_by: session.user_id,
                ticket_state: current_step.emp_role_id,
            },
            "ticket_id"
        );
        await client.query(qins, valins);
        const ven_detail = ApprovalTrack.ticket;
        let config_email = {
            to:
                next_step && next_step.email
                    ? next_step.email
                    : ven_detail.email,
            cc: current_step.email,
        };
        await EmailModel.RejectTicket(ven_detail, remarks, config_email);
        return {
            message: `Ticket ${ven_detail.ticket_num} is rejected`,
        };
    } catch (error) {
        throw error;
    }
};

/**
 *
 * @param {Client} client
 * @param {import("../class/ApprovalTrackerClass").approval_step} next_step
 */

ApprovalModel.CreateTokenApprovalLink = async (
    client,
    next_step,
    ticket_id
) => {
    try {
        const is_wo_auth = next_step?.wo_auth;
        if (!is_wo_auth) {
            return {};
        }
        const payload_token = {
            emp_role_id: next_step.emp_role_id,
            bu_id: next_step.bu_id,
            dept_id: next_step.dept_id,
            ticket_id: ticket_id,
        };

        const token_appr = jwt.sign(payload_token, process.env.TOKEN_KEY);

        const payload_db = {
            token_appr_link: token_appr,
        };

        const [upQue, upVal] = Crud.updateItem("ticket", payload_db, {
            token: ticket_id,
        });
        await client.query(upQue, upVal);
        return { token_appr: token_appr };
    } catch (error) {
        throw error;
    }
};

/**
 *
 * @param {import("../class/ApprovalTrackerClass").approval_step} current_flow
 * @param {Client} client
 */

ApprovalModel.GetNextIndexApproval = async (data, ticket_id, client) => {
    try {
        // console.log(client);
        const ApprovalTrack = new ApprovalTracker(client, ticket_id);
        await ApprovalTrack.init();
        let current_index = ApprovalTrack.current_step.index_approval;
        let skip = true;
        let next_index;
        let submit_email;
        let email_target;
        while (skip) {
            let current_step = ApprovalTrack.getApprovalStep(
                current_index.toString()
            );
            let on_sub_cond = current_step?.on_submit_condition;
            next_index = current_step.default_next_index;
            submit_email = current_step.def_submit_email;
            email_target = current_step.def_submit_email_target;
            if (!on_sub_cond) {
                skip = await ApprovalModel.CheckNextIsOTA(
                    next_index,
                    ticket_id,
                    client
                );
                if (skip) {
                    current_index = next_index;
                    continue;
                } else {
                    break;
                }
            }
            let is_change = false;
            for (let i = 0; i < on_sub_cond.length; i++) {
                if (is_change) break;
                let dt = on_sub_cond[i];
                let conditions = dt.condition;
                for (let k = 0; k < conditions.length; k++) {
                    if (is_change) break;
                    let dt_cond = conditions[k];
                    let temp_data_field = data[dt_cond.field];
                    let data_field = parseInt(temp_data_field);
                    let val_comparator = parseInt(dt_cond.value);
                    if (isNaN(data_field)) {
                        data_field = temp_data_field;
                    }
                    if (isNaN(val_comparator)) {
                        val_comparator = dt_cond.value;
                    }
                    if (data_field == undefined) {
                        throw new Error("Field data is undefined");
                    }

                    switch (dt_cond.condition) {
                        case "eq":
                            if (data_field == val_comparator) {
                                next_index = dt.next_index;
                                submit_email = dt.on_submit_email;
                                email_target = dt.on_submit_target;
                                is_change = true;
                            }
                            break;
                        case "le":
                            if (data_field <= val_comparator) {
                                next_index = dt.next_index;
                                submit_email = dt.on_submit_email;
                                email_target = dt.on_submit_target;
                                is_change = true;
                            }
                            break;
                        case "lt":
                            if (data_field < val_comparator) {
                                next_index = dt.next_index;
                                submit_email = dt.on_submit_email;
                                email_target = dt.on_submit_target;
                                is_change = true;
                            }
                            break;
                        case "ge":
                            if (data_field >= val_comparator) {
                                next_index = dt.next_index;
                                submit_email = dt.on_submit_email;
                                email_target = dt.on_submit_target;
                                is_change = true;
                            }
                            break;
                        case "gt":
                            if (data_field > val_comparator) {
                                next_index = dt.next_index;
                                submit_email = dt.on_submit_email;
                                email_target = dt.on_submit_target;
                                is_change = true;
                            }
                            break;
                    }
                }
            }
            skip = await ApprovalModel.CheckNextIsOTA(
                next_index,
                ticket_id,
                client
            );
            if (skip) {
                current_index = next_index;
                continue;
            } else {
                break;
            }
        }
        return {
            next_index,
            submit_email: submit_email,
            email_target: email_target,
        };
    } catch (error) {
        throw error;
    }
};

/**
 *
 * @param {*} next_index
 * @param {Client} client
 */

ApprovalModel.CheckNextIsOTA = async (next_index, ticket_id, client) => {
    // console.log(client);
    try {
        const { rows: next_index_data } = await client.query(
            `
            select * from approval_store_ota where id_ticket = $1 and index_approval = $2
            `,
            [ticket_id, next_index]
        );
        if (next_index_data.length > 0) {
            return true;
        }
        return false;
    } catch (error) {
        console.error(error);
    }
};

module.exports = ApprovalModel;
