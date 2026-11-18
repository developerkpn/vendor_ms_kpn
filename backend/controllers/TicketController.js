const TRANS = require("../config/transaction");
const Ticket = require("../models/TicketModel");
const Vendor = require("../models/VendorModel");
const Emailer = require("../models/EmailModel");
const db = require("../config/connection");
const crud = require("../helper/crudquery");
const moment = require("moment");
const fa = require("speakeasy");
const path = require("path");
const fs = require("fs");
const formidable = require("formidable");
const jwt = require("jsonwebtoken");
const { isAxiosError } = require("axios");
const MutexModel = require("../models/MutexModel");

const TicketController = {};

TicketController.openNew = async (req, res) => {
    try {
        let result = await Ticket.openNewv2(req.body, req.cookies);
        res.status(200).send({
            status: 200,
            message: `Ticket ${result.ticket_id} successfully created`,
            data: result,
        });
    } catch (err) {
        console.log(err);
        res.status(500).send({
            message: err.stack,
        });
    }
};

TicketController.headerTicket = async (req, res) => {
    // console.log(req.params);
    try {
        let result = await Ticket.headerTicket(req.params);
        res.status(200).send({
            status: 200,
            data: result,
        });
    } catch (err) {
        res.status(500).send({
            status: 500,
            message: err.message,
        });
    }
};

TicketController.showAll = async (req, res) => {
    try {
        const state = req.query;
        const row = await Ticket.showAll(state);
        res.status(200).send({
            status: 200,
            data: row,
        });
    } catch (err) {
        console.log(err);
        res.status(500).send({
            status: 500,
            message: "Failed to fetch data",
        });
    }
};

TicketController.ShowAllv2 = async (req, res) => {
    const { emp_role_id, dept_id, bu_id, user_id } = req.cookies;
    const { q, is_active } = req.query;
    try {
        const result = await Ticket.ShowAllv2({
            bu_id,
            dept_id,
            emp_role_id,
            q,
            is_active,
            user_id,
        });
        res.status(200).send(result);
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error.message,
        });
    }
};

TicketController.getTicketById = async (req, res) => {
    try {
        const result = await Ticket.getTicketById(req.params.id);
        res.status(200).send({
            data: result,
        });
    } catch (err) {
        res.status(500).send({
            status: 500,
            message: "Failed to fetch data",
        });
    }
};

TicketController.submitTicket = async (req, res) => {
    const client = await db.connect();
    try {
        //expected input :
        /*
            {
                is_draft : <boolean>,
                ticket_id : ,
                ven_detail : {
                    ticket_id :
                    ven_id :,
                    ... data ven_detail
                }
                ven_banks : [
                    {
                        method : <insert, update, delete>
                        ven_id :,
                        bankv_id :,
                        ... data bank
                    },
                    ...
                ],
                ven_files : [
                    {
                        method : <insert, delete>,
                        ven_id :,
                        file_id :,
                        ... data file
                    }
                ]
            }
        */
        const {
            ticket_id,
            remarks,
            ven_detail,
            ven_banks,
            ven_files,
            is_draft,
            role,
            edited_fields,
        } = req.body;
        // return;
        //change ticket cur_pos
        await client.query(TRANS.BEGIN);
        let promises = [];
        // if (!is_draft) {
        //     promises.push(
        //         Ticket.submitTicket(
        //             { ticket_id: ticket_id, remarks: remarks },
        //             client
        //         )
        //     );
        // }
        if (ven_detail != null) {
            promises.push(Vendor.setDetailVen(ven_detail, client));
        }
        if (ven_banks.length != 0) {
            promises.push(Vendor.setBank(ven_banks, client));
        }
        if (ven_files.length != 0) {
            promises.push(Vendor.setFile(ven_files, client));
        }
        Promise.all(promises)
            .then(async result => {
                try {
                    const ticket = await Ticket.submitTicket(
                        {
                            ticket_id: ticket_id,
                            remarks: remarks,
                            is_draft: is_draft,
                        },
                        client
                    );
                    const targets = await Ticket.ticketTarget(ticket_id);
                    const dataTrg = targets.data;
                    const res_tnum = ticket.rows[0].ticket_id;
                    if (!is_draft && role === "PROC") {
                        await Emailer.toRequest(
                            ven_detail.ticket_num,
                            dataTrg.proc_fname,
                            dataTrg.proc_email,
                            [dataTrg.mgr_pr_email]
                        );
                    } else if (!is_draft && role === "MDM") {
                        await Emailer.toApprove(
                            ven_detail.ven_code,
                            ven_detail.name_1,
                            dataTrg.proc_email,
                            [
                                dataTrg.mgr_pr_email,
                                dataTrg.mgr_md_email,
                                dataTrg.mdm_email,
                            ]
                        );
                    }
                    await client.query(TRANS.COMMIT);
                    res.status(200).send({
                        status: 200,
                        message: !is_draft
                            ? `${ven_detail.name_1} Vendor with num ticket : ${res_tnum} has been requested`
                            : `${ven_detail.ticket_num} Ticket draft has been saved`,
                        data: req.body,
                    });
                } catch (err) {
                    console.log(err);
                }
            })
            .catch(async err => {
                res.status(500).send({
                    status: 500,
                    message: err.message,
                });
                await client.query(TRANS.ROLLBACK);
                console.error(err.stack);
            });
    } catch (err) {
        await client.query(TRANS.ROLLBACK);
        res.status(500).send({
            message: err.message,
        });
    } finally {
        client.release();
    }
};

TicketController.submitTicketv2 = async (req, res) => {
    const { ticket_id, ven_detail, ven_banks, ven_files, is_draft } = req.body;
    try {
        //lock transaction
        const user_id = req?.cookies?.user_id;
        if (!user_id) {
            user_id - "UNKNOWN";
        }
        await MutexModel.CreateLock(ticket_id, user_id);
        const data = await Ticket.submitVendorv2({
            ticket_id,
            session: req.cookies,
            ven_detail,
            ven_banks,
            ven_files,
            is_draft,
        });
        res.status(200).send(data);
    } catch (error) {
        console.error(error);
        let message = error?.message;
        if (isAxiosError(error)) {
            message = error.response.data.message;
        }
        res.status(500).send({
            message,
        });
    } finally {
        await MutexModel.Unlock(ticket_id);
    }
};

TicketController.submitVendor = async (req, res) => {
    try {
        const { ven_detail, is_draft } = req.body;
        const { user_id } = req.cookies;
        const payload = { ...req.body, id_user: user_id };
        const submission = await Ticket.submitVendor(payload);
        res.status(200).send({
            message: !is_draft
                ? `${ven_detail.name_1} Vendor with num ticket : ${submission} has been requested`
                : `${ven_detail.ticket_num} Ticket draft has been saved`,
            data: req.body,
        });
    } catch (err) {
        console.error(err);
        res.status(500).send({
            message: "Failed create ticket",
        });
    }
};

TicketController.ReminderApproval = async (req, res) => {
    try {
        const { ticket_id } = req.body;
        const reminderEmail = await Ticket.reminderApprovalEmail(ticket_id);
        res.status(200).send({
            message: "Reminder Sent",
        });
    } catch (error) {
        console.error(error);
        res.status(200).send({
            message: error.message,
        });
    }
};

TicketController.singleSubmit = async (req, res) => {
    const client = await db.connect();
    try {
        await client.query(TRANS.BEGIN);
        const [ticket_num, name_1] = await Ticket.submitTicket(
            req.body.ticket_id,
            client
        );
        res.status(200).send({
            status: 200,
            message: `Ticket ${ticket_num} is submitted`,
        });
        await client.query(TRANS.COMMIT);
    } catch (err) {
        await client.query(TRANS.ROLLBACK);
        res.status(500).send({
            status: 500,
            message: `Error submission`,
        });
    } finally {
        client.release();
    }
};

TicketController.rejectTicket = async (req, res) => {
    const params = req.body;
    const cookies = req.cookies;
    try {
        const [ticket_id, reject_by, ven_name] = await Ticket.rejectTicket(
            params.ticket_id,
            params.remarks,
            cookies.user_id
        );
        const targets = await Ticket.ticketTarget(params.ticket_id);
        const dt_target = targets.data;
        if (params.role === "MDM") {
            await Emailer.toReject(
                params.remarks,
                ticket_id,
                ven_name,
                dt_target.proc_email,
                [
                    dt_target.mdm_email,
                    dt_target.mgr_md_email,
                    dt_target.mgr_pr_email,
                ]
            );
        }
        res.status(200).send({
            status: 200,
            message: `Ticket Number : ${ticket_id} is rejected by ${reject_by}`,
        });
    } catch (err) {
        res.status(500).send({
            status: 500,
            message: err.message,
        });
    }
};

TicketController.RejectTicketv2 = async (req, res) => {
    const { remarks, ticket_id } = req.body;
    const session = req.cookies;
    try {
        await MutexModel.CreateLock(ticket_id, session.user_id);
        const result = await Ticket.RejectTicketv2(ticket_id, remarks, session);
        res.status(200).send(result);
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: error.message });
    } finally {
        await MutexModel.Unlock(ticket_id);
    }
};

TicketController.processMgr = async (req, res) => {
    const ticket_id = req.query.ticket_id;
    const action = req.query.action;
    try {
        const updateTicket = await Ticket.processMgr(ticket_id, action);
        if (updateTicket.action === "accept") {
            res.render("response", {
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                reason: "has approved by you",
                rejected: "approved",
            });
        } else if (updateTicket.action === "rejected") {
            res.render("response", {
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                reason: "has rejected by you",
                rejected: "rejected",
            });
        } else {
            res.render("rejectform", {
                cur_pos: "CEO",
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                ticket_id: req.query.ticket_id,
                reason: "has rejected by you",
                ticket_id: ticket_id,
            });
        }
    } catch (error) {
        res.render("notvalid");
    }
};

TicketController.processMgrv2 = async (req, res) => {
    try {
        const { token_appr } = req.query;
        const data = await Ticket.processByLink(token_appr);
        if (data.bu_type == "NON_CG") {
            res.render("response", {
                ven_name: data.name_1,
                ven_type: data.ven_type,
                company: data.company,
                reason: "has approved by you",
                rejected: "approved",
            });
        } else {
            res.render("response_cg", {
                ven_name: data.name_1,
                ven_type: data.ven_type,
                ven_class: data.ven_class,
                reason: "has approved by you",
                rejected: "approved",
            });
        }
    } catch (error) {
        console.error(error);
        res.render("notvalid");
        // res.status(500).send({
        //     message: error.message,
        // });
    }
};

TicketController.rejectMgrv2 = async (req, res) => {
    try {
        const { token_appr } = req.query;
        const result = await Ticket.renderRejectForm(token_appr);
        const renderData = {
            ven_name: result.name,
            ven_type: result.type,
            company: result.company,
            token: token_appr,
            reason: "has rejected by you",
            rework_logs: result.rework_logs || [],
        };
        if (result.bu_type == "NON_CG") {
            res.render("rejectform", renderData);
        } else {
            renderData.ven_class = result.ven_class;
            res.render("rejectform_cg", renderData);
        }
    } catch (error) {
        console.error(error);
        res.render("notvalid");
    }
};

TicketController.RejectMgrbyLink = async (req, res) => {
    let reason = "";
    let token = "";
    let uploadedFiles = [];

    try {
        const contentType = req.headers["content-type"] || "";
        if (contentType.includes("multipart/form-data")) {
            const form = new formidable.IncomingForm();
            form.options.multiples = true;
            form.options.maxFileSize = 25 * 1024 * 1024;
            const [fields, files] = await form.parse(req);
            token = Array.isArray(fields.token) ? fields.token[0] : fields.token;
            reason = Array.isArray(fields.reason) ? fields.reason[0] : fields.reason;

            let fileList = [];
            if (files.files) {
                fileList = Array.isArray(files.files) ? files.files : [files.files];
            } else if (files.attachment) {
                fileList = Array.isArray(files.attachment) ? files.attachment : [files.attachment];
            }

            const uploadDir = path.join(__dirname, "../public/rework");
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            for (const file of fileList) {
                if (file && file.originalFilename) {
                    const safeName = `${Date.now()}_${file.originalFilename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
                    const destPath = path.join(uploadDir, safeName);
                    fs.copyFileSync(file.filepath, destPath);
                    uploadedFiles.push({
                        originalName: file.originalFilename,
                        filename: safeName,
                        path: destPath,
                        mimetype: file.mimetype,
                        size: file.size,
                        url: `/static/rework/${safeName}`,
                    });
                }
            }
        } else {
            token = req.body.token;
            reason = req.body.reason;
        }

        const decoded = jwt.decode(token, process.env.TOKEN_KEY);
        await MutexModel.CreateLock(decoded.ticket_id);
        const getCurrentSession = await Ticket.getSessionApprbyLink(
            decoded.ticket_id
        );
        const session = getCurrentSession;
        try {
            const result = await Ticket.RejectTicketv2(
                decoded.ticket_id,
                reason,
                session,
                uploadedFiles
            );
            res.status(200).send({
                message: "Ticket rejected",
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({
                message: error.message,
            });
        } finally {
            await MutexModel.Unlock(decoded.ticket_id);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send({
            message: err.message,
        });
    }
};

TicketController.processMgrPrc = async (req, res) => {
    const ticket_id = req.query.ticket_id;
    const action = req.query.action;
    const role = req.query?.role;
    try {
        const updateTicket = await Ticket.processMgrPrc(
            ticket_id,
            action,
            role
        );
        if (updateTicket.action === "accept") {
            res.render("response", {
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                reason: "has approved by you",
                rejected: "approved",
            });
        } else if (updateTicket.action === "rejected") {
            res.render("response", {
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                reason: "has rejected by you",
                rejected: "rejected",
            });
        } else {
            res.render("rejectform", {
                cur_pos: "MGRPRC",
                ven_name: updateTicket.name,
                ven_type: updateTicket.type,
                company: updateTicket.company,
                ticket_id: req.query.ticket_id,
                reason: "has rejected by you",
                ticket_id: ticket_id,
            });
        }
    } catch (error) {
        res.render("notvalid");
    }
};

TicketController.deleteTicket = async (req, res) => {
    const ticket_id = req.params.ticket_id;
    const client = await db.connect();
    await client.query(TRANS.BEGIN);
    const check = await client.query(
        `select ticket_id, ven_id from ticket where token = '${ticket_id}'`
    );
    const ven_id = check.rows[0].ven_id;
    if (check.rowCount == 0) {
        res.status(203).send({
            message: "ticket not exist",
        });
    }
    try {
        const [upque, upval] = crud.updateItem(
            "ticket",
            { is_close: true },
            { token: ticket_id },
            "ticket_id"
        );
        const deleteTicket = await client.query(upque, upval);
        const deletedTicket = deleteTicket.rows[0].ticket_id;
        const checkVen = await client.query(
            `select ven_id from vendor where ven_id = '${ven_id}'`
        );
        if (checkVen.rowCount > 0) {
            const [venque, venval] = crud.updateItem(
                "vendor",
                { is_active: false },
                { ven_id: ven_id }
            );
            await client.query(venque, venval);
        }
        await client.query(TRANS.COMMIT);
        res.status(200).send({
            data: deletedTicket,
        });
    } catch (error) {
        await client.query(TRANS.ROLLBACK);
        console.log(error.message);
        res.status(500).send({
            message: error.message,
        });
    } finally {
        client.release();
    }
};

TicketController.testmgr = (req, res) => {
    res.render("rejectform", {
        ven_name: "jess",
        ven_type: "jess",
        company: "jess",
        ven_id: "122331",
        reason: "undefined",
    });
};

TicketController.rejectformmgr = async (req, res) => {
    const { ticket_id, reason } = req.body;
    const date = moment().format("YYYY-MM-DD");
    const logrejectdate = moment().format("YYYY-MM-DDTHH:mm:ss");
    const client = await db.connect();
    try {
        await client.query(TRANS.BEGIN);
        const checkTicket = await client.query(`
                select t.ticket_id, t.is_active, t.cur_pos,
                v.name_1, v.ven_type, v.ven_id, c.name, c.sap_code as code,
                usr.email as email_user, mgr.email as email_mgr
                from ticket t
                left join vendor v on v.ven_id = t.ven_id
                left join mst_company c on c.comp_id = v.company
                left join mst_user usr on t.proc_id = usr.user_id 
                left join mst_mgr mgr on usr.mgr_id = mgr.mgr_id
                where t.token = '${ticket_id}'
        `);
        const ticketItem = checkTicket.rows[0];
        const emailTargets = [ticketItem.email_user, ticketItem.email_mgr];
        const itemup = {
            cur_pos: "PROC",
            ticket_state: "CREA",
            reject_by: "CEO",
            updated_at: date,
            remarks: reason,
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
        const rejectTicket = await client.query(query, val);
        const [qins, valins] = crud.insertItem(
            "log_rejection",
            {
                ticket_id: ticket_id,
                create_at: logrejectdate,
                remarks: reason,
                create_by: "CEO",
                ticket_state: "FINA",
            },
            "ticket_id"
        );
        await client.query(qins, valins);
        await client.query(TRANS.COMMIT);
        await Emailer.RejectMgrToProc(
            ticketItem.name_1,
            ticketItem.ven_type,
            `${ticketItem.code} - ${ticketItem.name}`,
            reason,
            emailTargets
        );
        res.render("response", {
            ven_name: ticketItem.name_1,
            ven_type: ticketItem.ven_type,
            company: `${ticketItem.code} - ${ticketItem.name}`,
            reason: "has rejected by you",
            rejected: "rejected",
        });
        // res.status(200).send({
        //     message: "Ticket has been rejected",
        // });
    } catch (error) {
        console.log(error);
        await client.query(TRANS.ROLLBACK);
        res.status(500).send({
            message: "error updating",
        });
    } finally {
        client.release();
    }
};

TicketController.rejectformgrproc = async (req, res) => {
    const { ticket_id, reason } = req.body;
    const today = moment().format("YYYY-MM-DD");
    const logrejectdate = moment().format("YYYY-MM-DDTHH:mm:ss");
    try {
        const client = await db.connect();
        try {
            await client.query(TRANS.BEGIN);
            const { rows: ticketItem } = await client.query(`
                select t.ticket_id, t.is_active, t.cur_pos,
                v.name_1, v.ven_type, v.ven_id, c.name, c.sap_code as code,
                usr.email as email_user, mgr.email as email_mgr
                from ticket t
                left join vendor v on v.ven_id = t.ven_id
                left join mst_company c on c.comp_id = v.company
                left join mst_user usr on t.proc_id = usr.user_id
                left join mst_mgr mgr on usr.mgr_id = mgr.mgr_id
                where t.token = '${ticket_id}'`);
            const cur_pos = ticketItem[0].cur_pos;
            const { rows: emailmgrprc } = await client.query(
                `select
                email from mst_mgr mm
            left join (
                select
                    distinct user_group_id,
                    user_group_name
                from
                    mst_page_access mpa) mpa on
                mm.user_group = mpa.user_group_id 
            where mpa.user_group_name = $1;`,
                [cur_pos]
            );
            const emailTargets = ticketItem[0].email_user;
            const ticketUp = {
                reject_by: cur_pos,
                cur_pos: "PROC",
                updated_at: today,
                remarks: reason,
            };
            const where = {
                token: ticket_id,
            };
            const [que, val] = crud.updateItem(
                "ticket",
                ticketUp,
                where,
                "ticket_id"
            );
            const [qins, valins] = crud.insertItem(
                "log_rejection",
                {
                    ticket_id: ticket_id,
                    create_at: logrejectdate,
                    remarks: reason,
                    create_by: cur_pos,
                    ticket_state: "CREA",
                },
                "ticket_id"
            );
            await client.query(que, val);
            await client.query(qins, valins);
            // await client.query(TRANS.COMMIT);
            await Emailer.RejectMgrPrc(
                ticketItem[0].name_1,
                ticketItem[0].ven_type,
                `${ticketItem[0].code} - ${ticketItem[0].name}`,
                reason,
                [emailTargets],
                emailmgrprc[0].email
            );
            await client.query(TRANS.COMMIT);
            res.render("response", {
                ven_name: ticketItem.name_1,
                ven_type: ticketItem.ven_type,
                company: `${ticketItem.code} - ${ticketItem.name}`,
                reason: "has rejected by you",
                rejected: "rejected",
            });
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error.message,
        });
    }
};

TicketController.checkValidTicket = async (req, res) => {
    const { ticket_id } = req.body;
    try {
        const client = await db.connect();
        try {
            const getTime = await client.query(
                `select valid_until, ticket_id from ticket where token = '${ticket_id}'`
            );
            const timeValid = new Date(getTime.rows[0].valid_until);
            const today = new Date();
            if (timeValid < today) {
                res.status(403).send({
                    message: `${getTime.rows[0].ticket_id} is closed`,
                });
            } else {
                res.status(200).send({
                    message: "ticket is valid",
                });
            }
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        res.status(500).send({
            message: "something went wrong",
            error: error.message,
        });
    }
};

TicketController.extendOneDay = async (req, res) => {
    try {
        const ticket_id = req.body.ticket_id;
        const updateExpiry = await Ticket.extendTicket(ticket_id, 1);
        res.status(200).send({
            ticket_num: updateExpiry.ticket_num,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error.message,
        });
    }
};

TicketController.resendCEO = async (req, res) => {
    try {
        const client = await db.connect();
        try {
            const ticket_id = req.body.ticket_id;
            const { rows } = await client.query(
                `SELECT T.TOKEN,
            V.NAME_1,
            V.DESCRIPTION,
            V.VEN_TYPE,
            V.COMPANY
        FROM TICKET T
        LEFT JOIN VENDOR V ON T.VEN_ID = V.VEN_ID
        WHERE T.TOKEN = $1`,
                [ticket_id]
            );
            let { name_1, description, ven_type, company } = rows[0];
            await Emailer.toManager(name_1, company, ticket_id);
            res.status(200).send({
                message: "Ticket Resent",
            });
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error.message,
        });
    }
};

TicketController.rejectLog = async (req, res) => {
    try {
        const client = await db.connect();
        try {
            const { ticket_state, ticket_id } = req.query;
            const q = `select lr.remarks, lr.create_at, coalesce(mu.fullname, lr.create_by) as create_by, lr.id, lr.ticket_state 
            from log_rejection lr
            left join all_users mu on mu.user_id = lr.create_by 
            where lr.ticket_id = $1  
               or lr.ticket_id in (select cast(ticket_id as varchar) from ticket where token = $1 or ticket_num = $1)
               or lr.ticket_id in (select token from ticket where cast(ticket_id as varchar) = $1 or ticket_num = $1)
            order by lr.create_at desc`;
            const { rows } = await client.query(q, [ticket_id]);
            const results = rows.map(item => ({
                id: item.id,
                remarks: item.remarks,
                create_at: moment(item.create_at).format("DD-MM-YYYY HH:mm:ss"),
                create_by: item.create_by,
                ticket_state: item.ticket_state,
            }));
            res.status(200).send(results);
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error.message,
        });
    }
};
module.exports = TicketController;
