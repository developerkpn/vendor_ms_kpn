const EmailModel = {};
const db = require("../config/connection");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("pg");
const EmailGen = require("../helper/EmailGenv2");
const aiValidationService = require("../services/aiValidationService");
const { buildAiSummaryHtml } = require("../helper/aiValidationEmailBlock");
const mailer = require("nodemailer");

const tp = mailer.createTransport({
    host: process.env.SMTP_HOST,
    secure: true,
    port: 465,
    tls: {
        ciphers: "SSLv3",
        rejectUnauthorized: false,
    },
    auth: {
        user: `${process.env.SMTP_USERNAME}`,
        pass: `${process.env.SMTP_PASSWORD}`,
    },
});
/**
 * @typedef {Object} ven_detail
 * @property {string} ticket_num
 * @property {string} name_1
 *
 */
/**
 *
 * @param {Client} client
 * @returns {ven_detail}
 */

EmailModel.GetDataDetailVendor = async (client, ticket_id) => {
    try {
        const { rows: data_vendor } = await client.query(
            `
              select
                v.ven_id,
                v.ven_group,
                v.ven_acc,
                v.ven_type,
                v.title,
                case
                	when mbu.badan_usaha is not null then v.name_1 || ' ' || mbu.badan_usaha 
                	else v.name_1
                end as name_1,
                v.street,
                v.street2,
                v.street3,
                v.street4,
                v.telf1,
                v.fax,
                v.purch_org ,
                v.postal,
                v.email,
                v.npwp,
                upper(v.pay_mthd) as pay_mthd ,
                case
                	when tr.bu_id = 'CG' then concat(cgpt.pay_term_desc, ' (', cgpt.pay_term_code, ')') 
                	else concat(mpt.term_name, ' (', v.pay_term, ')') 
                end
                as pay_term,
                concat(cut.used_tax_desc, ' (', cut.used_tax_code, ')') as used_tax,
                case
                	when tr.bu_id = 'CG' then concat(cmv.class_desc, ' (', cmv.class_code, ')')
                	else concat(v.title, ' ', v.local_ovs)
                end as title,
                case
                    when v.local_ovs = 'LOCAL' then 'LOCAL'
                    when v.local_ovs = 'OVS' then 'OVERSEAS'
                    else ''
                end
            as local_ovs,
                v.lim_curr,
                v.city,
                v.country,
                mc.country_name,
                concat(mc2.sap_code,
                ' ',
                mc2."name") as company,
                v.purch_org ,
                v.lim_curr ,
                v.limit_vendor ,
                v.description,
                v.is_tender, 
                v.is_priority,
                t.token as ticket_id,
                t.ticket_id as ticket_num,
                v.kawasan_berikat,
                v.is_interest,
                case 
                    when tr.bu_id = 'CG' then 'CG'
                    else 'NON_CG'
                end as bu_type,
                concat(cmv.class_desc, ' (', cmv.class_code, ')') as ven_class,
                mu.fullname as requestor,
                mu.email as email_requestor
            from
                vendor v
            left join ticket t on
                v.ven_id = t.ven_id
            left join mst_pay_term mpt on
                mpt.term_code = v.pay_term
            left join mst_country mc on
                mc.country_code = v.country
            left join mst_company mc2 on
                mc2.comp_id = v.company
            left join mst_user mu on mu.user_id = t.proc_id
            left join ticket_rule tr on tr.doctype = t.approval_type
            left join cg_mst_payterm cgpt on cgpt.pay_term_code = v.pay_term
            left join cg_mst_venclass cmv on cmv.class_code = v.ven_class
            left join cg_mst_used_tax cut on cut.used_tax_code = v.used_tax
            left join mst_badan_usaha mbu on mbu.id_badan_usaha = v.badan_usaha
      where t.token = $1
      `,
            [ticket_id]
        );
        if (data_vendor.length < 1) {
            throw new Error("Vendor not found");
        }
        return data_vendor[0];
    } catch (error) {
        throw error;
    }
};

/**
 *
 * @param {*} email_type
 * @param {Object} config
 * @param {string | undefined} config.to
 * @param {string | undefined} config.cc
 * @param {*} ticket_id
 * @param {Client} client
 * @param {import("../class/ApprovalTrackerClass").approval_step} next_step
 * @param {Object} misc
 * @param {string|undefined} misc.token_appr
 * @param {boolean} reminder
 */

EmailModel.ProcessEmailGen = async (
    email_type,
    config,
    ticket_id,
    client,
    next_step,
    misc,
    reminder = false
) => {
    try {
        let detail_vendor = await EmailModel.GetDataDetailVendor(
            client,
            ticket_id
        );
        const bu_type = detail_vendor.bu_type;
        let html_gen = "";
        /**
         * @type {import("nodemailer").SendMailOptions}
         */
        let setup = {};
        switch (email_type) {
            case "Submit_Staff":
                let html_gen = "";
                if (bu_type == "NON_CG") {
                    html_gen = EmailGen.Submit_Staff(detail_vendor);
                } else {
                    html_gen = EmailGen.Submit_Staff_CG(detail_vendor);
                }

                setup = {
                    from: process.env.SMTP_USERNAME,
                    ...config,
                    subject: `Notification Filled User Form (${detail_vendor.ticket_num}) - ${detail_vendor.name_1}`,
                    html: html_gen,
                };
                await tp.sendMail(setup);
                break;
            case "Submit_Manager":
                await EmailModel.SendManager(
                    client,
                    next_step,
                    detail_vendor,
                    misc,
                    config,
                    bu_type,
                    reminder
                );
                break;
            case "Submit_CLevel":
                await EmailModel.SendCLevel(
                    client,
                    next_step,
                    detail_vendor,
                    misc,
                    config,
                    bu_type,
                    reminder
                );
                break;
            case "Submit_MDM":
                await EmailModel.SendMDM(client, detail_vendor, config);
                break;
            default:
                throw new Error("Email type not found");
                break;
        }
        return true;
    } catch (error) {
        throw error;
    }
};

EmailModel.SendManager = async (
    client,
    next_step,
    detail_vendor,
    misc,
    config,
    bu = "NON_CG",
    reminder
) => {
    try {
        let role_id = next_step.emp_role_id;
        let bu_id = next_step.bu_id;
        let dept_id = next_step.dept_id;

        if (!misc.token_appr) {
            throw new Error("Error generate token approval");
        }

        //get emp role_name
        const { rows: res_emp_role } = await client.query(
            `select role_name from mst_emp_role where role_code = $1`,
            [role_id]
        );
        let emp_role_name = res_emp_role[0].role_name;

        //get bu name
        const { rows: res_bu } = await client.query(
            `select bu_name from mst_bu where bu_code = $1`,
            [bu_id]
        );
        let bu_name = res_bu[0].bu_name;

        //get dept name
        const { rows: res_dept } = await client.query(
            `select dept_name from mst_department where dept_code = $1`,
            [dept_id]
        );
        let dept_name = res_dept[0].dept_name;

        const { rows: res_data_mgr } = await client.query(
            `
                select * from mst_mgr where emp_role_id = $1 and (bu_id = $2 or bu_id_1 = $2 or bu_id_2 = $2) and dept_id = $3 and is_active = true               
                `,
            [role_id, bu_id, dept_id]
        );
        let data_mgr = res_data_mgr[0];
        let title_mgr = "Bapak";
        if (data_mgr.gender == "F") {
            title_mgr = "Ibu";
        }

        const { rows: getHostname } = await client.query(
            "SELECT hostname from hostname where mode_env = $1",
            [process.env.NODE_ENV]
        );

        const hostname = getHostname[0].hostname;
        const approveLink = `${hostname}/api/ticket/mgrappr?token_appr=${misc.token_appr}`;
        const rejectLink = `${hostname}/api/ticket/mgrrej?token_appr=${misc.token_appr}`;
        let opening = `Kepada Yth. ${title_mgr} ${data_mgr.fullname} <br />Mohon approval Request Registrasi Vendor dengan detail berikut :`;

        const { rows: getBanks } = await client.query(
            `select
                          case 
                          	when tr.bu_id = 'CG' then cmb.bank_name
                          	else mb.bank_name
                          end as bank_name
                          ,
                          vb.bank_id,
                          vb.bank_acc,
                          vb.acc_hold,
                          vb.bank_curr,
                          vb.country
                      from
                          ven_bank vb
                      left join mst_bank_sap mb on
                          mb.id::varchar = vb.bank_id 
                      left join ticket t on t.ven_id = vb.ven_id 
                      left join ticket_rule tr on tr.doctype = t.approval_type 
                      left join cg_mst_bank cmb on cmb.bank_code = vb.bank_id
                      where vb.ven_id = $1 and vb.is_active = true `,
            [detail_vendor.ven_id]
        );

        let bankTable = "";
        if (bu == "NON_CG") {
            bankTable = getBanks.map(item => {
                return `
                        <tr>
                            <td>${item.country}</td>
                            <td>${item.bank_name}</td>
                            <td>${item.bank_curr}</td>
                            <td>${item.bank_acc}</td>
                            <td>${item.acc_hold}</td>
                        </tr>
                        `;
            });
        } else {
            bankTable = getBanks.map(item => {
                return `
                        <tr>
                            <td>${item.bank_name}</td>
                            <td>${item.bank_curr}</td>
                            <td>${item.bank_acc}</td>
                            <td>${item.acc_hold}</td>
                        </tr>
                        `;
            });
        }

        const { rows: getFiles } = await client.query(
            `select distinct mft.file_type , vfa.file_name from  ven_file_atth vfa 
                      left join ticket t on t.ven_id = vfa.ven_id
                      left join approval_steps as2 on as2.id_doctype = t.approval_type and as2.index_approval = '0'
                      left join mst_file_type mft on vfa.file_type = mft.file_code and as2.bu_id = mft.bu_id
                      where vfa.ven_id = $1`,
            [detail_vendor.ven_id]
        );

        const fileAtth = getFiles.map(item => {
            let pathStream =
                path.join(path.resolve(), "backend/public") +
                "/" +
                item.file_name;
            return {
                filename: `${item.file_type} - ${item.file_name} `,
                content: fs.createReadStream(pathStream),
            };
        });
        // Manager and C-Level approve straight from this e-mail without opening
        // VMS, so the AI verdict has to travel with it — the on-form panel is
        // Master Data only. Never let this block the mail: a missing or failed
        // lookup just means the e-mail goes out exactly as it did before.
        let ai_html = "";
        try {
            const latestValidation =
                await aiValidationService.getLatestValidation(
                    detail_vendor.ven_id
                );
            ai_html = buildAiSummaryHtml(latestValidation);
        } catch (error) {
            console.error(
                "[AI-VALIDATION] could not attach summary to approval e-mail:",
                error && error.message
            );
        }

        let html_gen = "";
        if (bu == "NON_CG") {
            html_gen = EmailGen.Submit_Manager(
                opening,
                detail_vendor,
                bankTable,
                approveLink,
                rejectLink,
                ai_html
            );
        } else {
            html_gen = EmailGen.Submit_Manager_CG(
                opening,
                detail_vendor,
                bankTable,
                approveLink,
                rejectLink,
                ai_html
            );
        }
        let setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `${reminder ? "Reminder :" : ""}Vendor ${
                detail_vendor.name_1
            } ${emp_role_name} ${bu_name} ${dept_name} Approval Request (${
                detail_vendor.ticket_num
            })`,
            html: html_gen,
            attachments: fileAtth,
        };
        await tp.sendMail(setup);
    } catch (error) {
        throw error;
    }
};

EmailModel.SendCLevel = async (
    client,
    next_step,
    detail_vendor,
    misc,
    config,
    bu = "NON_CG",
    reminder
) => {
    try {
        let role_id = next_step.emp_role_id;
        let bu_id = next_step.bu_id;
        let dept_id = next_step.dept_id;

        if (!misc.token_appr) {
            throw new Error("Error generate token approval");
        }

        //get emp role_name
        const { rows: res_emp_role } = await client.query(
            `select role_name from mst_emp_role where role_code = $1`,
            [role_id]
        );
        let emp_role_name = res_emp_role[0].role_name;

        //get bu name
        const { rows: res_bu } = await client.query(
            `select bu_name from mst_bu where bu_code = $1`,
            [bu_id]
        );
        let bu_name = res_bu[0].bu_name;

        const { rows: res_data_mgr } = await client.query(
            `
                select * from mst_mgr where emp_role_id = $1 and bu_id = $2 and dept_id = $3 and is_active = true            
                `,
            [role_id, bu_id, dept_id]
        );
        let data_mgr = res_data_mgr[0];
        let title_mgr = "Mr. ";
        if (data_mgr.gender == "F") {
            title_mgr = "Mrs. ";
        }

        const { rows: getHostname } = await client.query(
            "SELECT hostname from hostname where mode_env = $1",
            [process.env.NODE_ENV]
        );

        const hostname = getHostname[0].hostname;
        const approveLink = `${hostname}/api/ticket/mgrappr?token_appr=${misc.token_appr}`;
        const rejectLink = `${hostname}/api/ticket/mgrrej?token_appr=${misc.token_appr}`;

        // state = 0 => is tender
        // state = 1 => is priority
        // state = 3 => both
        let openingState = "";
        if (detail_vendor?.is_tender && !detail_vendor?.is_priority) {
            openingState = "who have participated in the tender at KPN Corp";
            if (detail_vendor?.is_interest) {
                openingState =
                    "who have participated in the tender at KPN Corp and prioritized in its interest payment";
            }
        } else if (!detail_vendor?.is_tender && detail_vendor?.is_priority) {
            openingState = "which is priority vendor";
        } else if (detail_vendor?.is_tender && detail_vendor?.is_priority) {
            openingState =
                "who have participated in the tender at KPN Corp also a priority vendor";
        } else if (detail_vendor?.is_interest) {
            openingState = "who prioritized in its interest payment";
        }

        let opening = `Dear ${title_mgr} ${res_data_mgr[0].fullname}, <br /> Please approve for vendor ${openingState} :`;

        const { rows: getBanks } = await client.query(
            `select
                          case 
                          	when tr.bu_id = 'CG' then cmb.bank_name
                          	else mb.bank_name
                          end as bank_name
                          ,
                          vb.bank_id,
                          vb.bank_acc,
                          vb.acc_hold,
                          vb.bank_curr,
                          vb.country
                      from
                          ven_bank vb
                      left join mst_bank_sap mb on
                          mb.id::varchar = vb.bank_id 
                      left join ticket t on t.ven_id = vb.ven_id 
                      left join ticket_rule tr on tr.doctype = t.approval_type 
                      left join cg_mst_bank cmb on cmb.bank_code = vb.bank_id
                      where vb.ven_id = $1 and vb.is_active = true `,
            [detail_vendor.ven_id]
        );
        let bankTable = "";
        if (bu == "NON_CG") {
            bankTable = getBanks.map(item => {
                return `
                        <tr>
                            <td>${item.country}</td>
                            <td>${item.bank_name}</td>
                            <td>${item.bank_curr}</td>
                            <td>${item.bank_acc}</td>
                            <td>${item.acc_hold}</td>
                        </tr>
                        `;
            });
        } else {
            bankTable = getBanks.map(item => {
                return `
                        <tr>
                            <td>${item.bank_name}</td>
                            <td>${item.bank_curr}</td>
                            <td>${item.bank_acc}</td>
                            <td>${item.acc_hold}</td>
                        </tr>
                        `;
            });
        }

        const { rows: getFiles } = await client.query(
            `select distinct mft.file_type , vfa.file_name from  ven_file_atth vfa 
                      left join ticket t on t.ven_id = vfa.ven_id
                      left join approval_steps as2 on as2.id_doctype = t.approval_type and as2.index_approval = '0'
                      left join mst_file_type mft on vfa.file_type = mft.file_code and as2.bu_id = mft.bu_id
                      where vfa.ven_id = $1`,
            [detail_vendor.ven_id]
        );

        const fileAtth = getFiles.map(item => {
            let pathStream =
                path.join(path.resolve(), "backend/public") +
                "/" +
                item.file_name;
            return {
                filename: `${item.file_type} - ${item.file_name} `,
                content: fs.createReadStream(pathStream),
            };
        });

        // Manager and C-Level approve straight from this e-mail without opening
        // VMS, so the AI verdict has to travel with it — the on-form panel is
        // Master Data only. Never let this block the mail: a missing or failed
        // lookup just means the e-mail goes out exactly as it did before.
        let ai_html = "";
        try {
            const latestValidation =
                await aiValidationService.getLatestValidation(
                    detail_vendor.ven_id
                );
            ai_html = buildAiSummaryHtml(latestValidation);
        } catch (error) {
            console.error(
                "[AI-VALIDATION] could not attach summary to approval e-mail:",
                error && error.message
            );
        }

        let html_gen = "";
        if (bu == "NON_CG") {
            html_gen = EmailGen.Submit_Manager(
                opening,
                detail_vendor,
                bankTable,
                approveLink,
                rejectLink,
                ai_html
            );
        } else {
            html_gen = EmailGen.Submit_Manager_CG(
                opening,
                detail_vendor,
                bankTable,
                approveLink,
                rejectLink,
                ai_html
            );
        }
        let setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `${reminder ? "Reminder :" : ""}Vendor ${
                detail_vendor.name_1
            } ${emp_role_name} ${bu_name} Approval Request (${
                detail_vendor.ticket_num
            })`,
            html: html_gen,
            attachments: fileAtth,
        };
        await tp.sendMail(setup);
    } catch (error) {
        throw error;
    }
};

/**
 * @param {Object} config
 * @param {string | undefined} config.to
 * @param {string | undefined} config.cc
 */

EmailModel.SendMDM = async (client, detail_vendor, config, bu = "NON_CG") => {
    try {
        // assign cc to creator
        const { rows: res_email_proc } = await client.query(`
            select mu.email from ticket t
                left join mst_user mu on t.proc_id = mu.user_id
            `);
        email_proc = res_email_proc[0].email;
        let ccemail = config?.cc;
        if (ccemail) {
            config.cc += "," + email_proc;
        } else {
            config.cc = email_proc;
        }

        const { rows: getHostname } = await client.query(
            "SELECT hostname from hostname where mode_env = $1",
            [process.env.NODE_ENV]
        );

        const hostname = getHostname[0].hostname;
        const weburl = `${hostname}/dashboard/form/${detail_vendor.ticket_id}`;
        let html_gen = "";
        if (bu == "NON_CG") {
            html_gen = EmailGen.Submit_MDM(detail_vendor, weburl);
        } else {
            html_gen = EmailGen.Submit_MDM_CG(detail_vendor, weburl);
        }
        const setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `Vendor ${detail_vendor.name_1} Create Request (${detail_vendor.ticket_num})`,
            html: html_gen,
        };
        await tp.sendMail(setup);
    } catch (error) {
        throw error;
    }
};

EmailModel.RejectTicket = async (detail_vendor, remarks, config) => {
    try {
        const html_gen = EmailGen.RejectReq(detail_vendor, remarks);
        /**
         * @type {import("nodemailer").SendMailOptions}
         */
        const setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `Vendor ${detail_vendor.name_1} Rejected Request (${detail_vendor.ticket_num})`,
            html: html_gen,
        };
        await tp.sendMail(setup);
    } catch (error) {
        throw error;
    }
};

EmailModel.EndTicket = async (ven_name, ven_code, config) => {
    try {
        const html_gen = EmailGen.Submit_END(ven_code, ven_name);
        /**
         * @type {import("nodemailer").SendMailOptions}
         */
        const setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `Vendor ${ven_name} Created`,
            html: html_gen,
        };
        await tp.sendMail(setup);
    } catch (error) {
        throw error;
    }
};

EmailModel.coupaEmail = async (client, ven_detail, ven_banks) => {
    try {
        const { rows } = await client.query(`
            SELECT email
            FROM mst_mgr
            WHERE emp_role_id = 'C_LEVEL'
            AND is_active = true
            LIMIT 1
        `);

        if (!rows.length) {
            throw new Error("C-Level email not found");
        }

        const to = rows[0].email;

        const config = {
            to,
            cc: process.env.COUPA_EMAIL_CC,
        };

        const banks_html = await Promise.all(
            ven_banks.map(async bank => {
                const { rows } = await client.query(
                    `SELECT bank_name FROM mst_bank_sap WHERE id::varchar = $1`,
                    [bank.bank_id]
                );
                const bank_name = rows[0]?.bank_name ?? bank.bank_id;
                return `
                <tr>
                    <td>${bank.bank_country ?? ""}</td>
                    <td>${bank_name}</td>
                    <td>${bank.bank_curr ?? ""}</td>
                    <td>${bank.bank_acc ?? ""}</td>
                    <td>${bank.acc_hold ?? ""}</td>
                </tr>
                `;
            })
        );

        const html_gen = EmailGen.Submit_Coupa(ven_detail, banks_html);
        const setup = {
            from: process.env.SMTP_USERNAME,
            ...config,
            subject: `Information Coupa Vendor ${ven_detail.name_1}`,
            html: html_gen,
        };

        await tp.sendMail(setup);
        return { skipped: false };
    } catch (error) {
        throw error;
    }
};

module.exports = EmailModel;
