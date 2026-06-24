const mailer = require("nodemailer");
const Email = require("../helper/generateemail");
const EmailVerif = require("../helper/generateemailverif");
const db = require("../config/connection");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

const Emailer = {
    toManager: async (ven_name, comp, ticket_id, state, clientpg = null) => {
        let client = clientpg;
        try {
        if (!client) {
            client = await db.connect();
        }
        const { rows: getHostname } = await client.query(
            "SELECT hostname from hostname where mode_env = $1",
            [process.env.NODE_ENV]
        );
        const getData = await client.query(
            `select name, sap_code as code, group_comp from mst_company where comp_id = '${comp}'`
        );
        const { rows: getVenDetail } = await client.query(
            `
                        select
                v.ven_id,
                v.ven_group,
                v.ven_acc,
                v.ven_type,
                v.title,
                v.name_1,
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
                concat(v.pay_term,
                ' ',
                mpt.term_name) as pay_term,
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
                vat.ppn_desc as ppn,
                t.token,
                requestor.fullname,
                requestor.email
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
            left join mst_user requestor on requestor.user_id = t.proc_id
            left join mst_ppn vat on vat.ppn_code = v.ppn_type
            where t.token = $1
            `,
            [ticket_id]
        );
        const { rows: getBanks } = await client.query(
            `select
                                    mb.bank_name ,
                                    vb.bank_id,
                                    vb.bank_acc,
                                    vb.acc_hold,
                                    vb.bank_curr,
                                    vb.country
                                from
                                    ven_bank vb
                                left join mst_bank_sap mb on
                                    mb.id::varchar = vb.bank_id
                                where vb.ven_id = $1`,
            [getVenDetail[0].ven_id]
        );
        const { rows: getFiles } = await client.query(
            `select mft.file_type , vfa.file_name from ven_file_atth vfa
        left join mst_file_type mft on vfa.file_type = mft.file_code
        where vfa.ven_id = $1`,
            [getVenDetail[0].ven_id]
        );
        const fileAtth = getFiles.map(item => {
            let pathStream;
            if (os.platform() === "win32") {
                pathStream =
                    path.join(path.resolve(), "backend\\public") +
                    "\\" +
                    item.file_name;
            } else {
                pathStream =
                    path.join(path.resolve(), "backend/public") +
                    "/" +
                    item.file_name;
            }
            return {
                filename: `${item.file_type} - ${item.file_name} `,
                content: fs.createReadStream(pathStream),
            };
        });
        const bankTable = getBanks.map(item => {
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
        const company = getData.rows[0].code + " - " + getData.rows[0].name;
        const group = getData.rows[0].group_comp;
        let targetCeo = "";
        let targetPA = "";
        let queryPA = `SELECT email, first_name from mst_email WHERE id_user in ($1, $2) ORDER BY ID_USER ASC`;
        let email_target;
        if (group === "UPSTREAM") {
            const { rows: dataEmail } = await client.query(queryPA, [
                "CEOUP",
                "PACEOUP",
            ]);
            targetPA = dataEmail[1].email;
            email_target = dataEmail[0].email;
            targetCeo = dataEmail[0].first_name;
        } else if (group === "DOWNSTREAM") {
            // const { rows: dataEmail } = await client.query(queryPA, [
            //     "PACEODOWN",
            // ]);
            // targetPA = dataEmail[0].email;
            // email_target = process.env.CEO_DOWNSTREAM;
            // targetCeo = "Mr. or Mrs.";
            const { rows: dataEmail } = await client.query(queryPA, [
                "CEODOWN",
                "PACEODOWN",
            ]);
            targetPA = dataEmail[1].email;
            email_target = dataEmail[0].email;
            targetCeo = dataEmail[0].first_name;
        }
        // ${process.env.APP_URL}/api/ticket/mgrappr?ticket_id=${ticket_id}&action=accept
        const hostname = getHostname[0].hostname;
        // state = 0 => is tender
        // state = 1 => is priority
        // state = 3 => both
        let openingState;
        if (state === 0) {
            openingState = "who have participated in the tender at KPN Corp";
        } else if (state === 1) {
            openingState = "which is priority vendor";
        } else {
            openingState =
                "who have participated in the tender at KPN Corp also a priority vendor";
        }
        const opening = `Dear ${targetCeo}, <br /> Please approve for vendor ${openingState} :`;
        const linkapproval = `${hostname}/api/ticket/mgrappr?ticket_id=${ticket_id}&action=accept`;
        const linkreject = `${hostname}/api/ticket/mgrappr?ticket_id=${ticket_id}&action=reject`;
        const transporter = tp;
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: email_target,
                cc: targetPA,
                subject: `${ven_name} - ${company} - Request CFO Approval Vendor`,
                html: Email.toMGRPRC(
                    getVenDetail[0],
                    bankTable.join(""),
                    linkapproval,
                    linkreject,
                    opening
                ),
                attachments: fileAtth,
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        } finally {
            if (!clientpg) {
                client.release();
            }
        }
    },
    newRequest: async (title, local_ovs, ven_name, ticket_num, target, cc) => {
        try {
            const transporter = tp;
            const cc_email = cc.join(",");
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                cc: cc_email,
                subject: `Notification Filled User Form - ${ticket_num}`,
                html: Email.vendorreq(title, local_ovs, ven_name, ticket_num),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.error(error);
        }
    },

    toRequest: async (
        ticket_num,
        requestor,
        ven_name,
        ven_group,
        ven_account,
        comp,
        target,
        clientpg = null
    ) => {
        const transporter = tp;
        let client = clientpg;
        if (!client) {
            client = await db.connect();
        }
        try {
            const { rows: data } = await client.query(
                `select name, sap_code as code, group_comp from mst_company where comp_id = '${comp}'`
            );
            let { name, code } = data[0];
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                subject: `New Vendor Request - ${ticket_num}`,
                html: Email.request(
                    ticket_num,
                    requestor,
                    ven_name,
                    ven_group,
                    ven_account,
                    name + `(${code})`
                ),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
        } finally {
            if (!clientpg) {
                client.release();
            }
        }
    },
    toApprove: async (ven_code, ven_name, target, cc) => {
        const transporter = tp;
        const cc_email = cc.join(",");
        try {
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                cc: cc_email,
                subject: `Vendor ${ven_code} - ${ven_name} Approval Notification`,
                html: Email.approve(ven_code, ven_name),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        }
    },
    toReject: async (reason, ven_name, target, cc) => {
        const transporter = tp;
        const cc_email = cc.join(",");
        try {
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                cc: cc_email,
                subject: `Vendor ${ven_name} Reject Notification`,
                html: Email.reject(reason),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        }
    },
    RejectMgrToProc: async (ven_name, ven_type, company, reason, targets) => {
        const transporter = tp;
        const emailTargets = targets.join(",");
        try {
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: emailTargets,
                subject: `Vendor ${ven_name} CEO Rejection Notification`,
                html: Email.notifRejectMgrToProc(
                    ven_name,
                    ven_type,
                    company,
                    reason
                ),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        }
    },
    toMDM: async (
        ven_name,
        ticket_token,
        ticket_num,
        title,
        local_ovs,
        clientpg = null
    ) => {
        let client = clientpg;
        if (!client) {
            client = await db.connect();
        }
        try {
            const transporter = tp;
            const getmdm_emails = await client.query(
                `select email from mst_user where role = 'MDM'`
            );
            const { rows: procEmail } = await client.query(
                `
                select mu.email
                from ticket t
                left join mst_user mu on mu.user_id = t.proc_id
                 where t.token = $1`,
                [ticket_token]
            );
            const emailProc = procEmail[0].email;
            const getmgr_mdm = await client.query(`SELECT EMAIL
                                            FROM MST_MGR
                                            WHERE MGR_ID IN
                                                    (SELECT DISTINCT MGR_ID
                                                        FROM MST_USER
                                                        WHERE ROLE = 'MDM')`);
            const mdmEmail = getmdm_emails.rows.map(item => item.email);
            const mgrmdmEmail = getmgr_mdm.rows.map(item => item.email);
            mgrmdmEmail.push(emailProc);
            const weburl = `${process.env.APP_URL}/dashboard/form/${ticket_token}`;
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: /*"rafael.tektano@kpn-corp.com"*/ mdmEmail.join(","),
                cc: /*"rafael.tektano@kpn-corp.com"*/ mgrmdmEmail.join(","),
                // to: "rafael.tektano@kpn-corp.com",
                // cc: "rafael.tektano@kpn-corp.com",
                subject: `Vendor ${ven_name} Ticket Request ${ticket_num} `,
                html: Email.toMdm(
                    ticket_num,
                    title,
                    local_ovs,
                    ven_name,
                    weburl
                ),
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        } finally {
            if (!clientpg) {
                client.release();
            }
        }
    },
    toMGRPRC: async (ven_detail, ticket_id, role, clientpg = null) => {
        try {
            let client = clientpg;
            if (!client) {
                client = await db.connect();
            }
            try {
                const { rows: getHostname } = await client.query(
                    "SELECT hostname from hostname where mode_env = $1",
                    [process.env.NODE_ENV]
                );
                const { rows: getVenDetail } = await client.query(
                    `
                                select
                        v.ven_id,
                        v.ven_group,
                        v.ven_acc,
                        v.ven_type,
                        v.title,
                        v.name_1,
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
                        concat(v.pay_term,
                        ' ',
                        mpt.term_name) as pay_term,
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
                        t.token,
                        t.cur_pos,
                        t.ticket_type,
                        vat.ppn_desc as ppn,
                        requestor.fullname,
                        requestor.email
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
                    left join mst_user requestor on requestor.user_id = t.proc_id
                    left join mst_ppn vat on vat.ppn_code = v.ppn_type
                    where t.token = $1
                    `,
                    [ticket_id]
                );
                let ticket_type = getVenDetail[0].ticket_type;
                const { rows: getBanks } = await client.query(
                    `select
                                            mb.bank_name ,
                                            vb.bank_id,
                                            vb.bank_acc,
                                            vb.acc_hold,
                                            vb.bank_curr,
                                            vb.country
                                        from
                                            ven_bank vb
                                        left join mst_bank_sap mb on
                                            mb.id::varchar = vb.bank_id
                                        where vb.ven_id = $1`,
                    [ven_detail.ven_id]
                );
                const { rows: getFiles } = await client.query(
                    `select mft.file_type , vfa.file_name from ven_file_atth vfa
                left join mst_file_type mft on vfa.file_type = mft.file_code
                where vfa.ven_id = $1`,
                    [ven_detail.ven_id]
                );
                const { rows: getCompany } = await client.query(
                    `select sap_code as code, name from mst_company where comp_id = $1`,
                    [ven_detail.company]
                );

                const { rows: emailmgrprc } = await client.query(`select
                                        email from mst_mgr mm
                                    left join (
                                        select
                                            distinct user_group_id,
                                            user_group_name
                                        from
                                            mst_page_access mpa) mpa on
                                        mm.user_group = mpa.user_group_id
                                    where mpa.user_group_name = '${role}';`);
                const bankTable = getBanks.map(item => {
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
                const fileAtth = getFiles.map(item => {
                    let pathStream;
                    if (os.platform() === "win32") {
                        pathStream =
                            path.join(path.resolve(), "backend\\public") +
                            "\\" +
                            item.file_name;
                    } else {
                        pathStream =
                            path.join(path.resolve(), "backend/public") +
                            "/" +
                            item.file_name;
                    }
                    return {
                        filename: `${item.file_type} - ${item.file_name} `,
                        content: fs.createReadStream(pathStream),
                    };
                });
                const hostname = getHostname[0].hostname;
                ven_detail.company =
                    getCompany[0].code + " - " + getCompany[0].name;
                const approveLink = `${hostname}/api/ticket/mgrapprprc?ticket_id=${ticket_id}&action=accept&role=${role}`;
                const rejectLink = `${hostname}/api/ticket/mgrapprprc?ticket_id=${ticket_id}&action=reject&role=${role}`;
                const opening = `Kepada Yth. Bapak/Ibu <br />Mohon approval Request Registrasi Vendor dengan detail berikut :`;
                const html = Email.toMGRPRC(
                    getVenDetail[0],
                    bankTable.join(" "),
                    approveLink,
                    rejectLink,
                    opening
                );
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: emailmgrprc[0].email,
                    subject: `Vendor ${ven_detail.name_1} Manager ${
                        ticket_type === "DWS" ? "Downstream" : "Upstream"
                    } Approval Request (${ven_detail.ticket_num}) `,
                    html: html,
                    attachments: fileAtth,
                };
                await tp.sendMail(setup);
                return;
            } catch (error) {
                throw error;
            } finally {
                if (!clientpg) {
                    client.release();
                }
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },
    RejectMgrPrc: async (ven_name, ven_type, company, reason, targets, cc) => {
        const transporter = tp;
        const emailTargets = targets.join(",");
        try {
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: emailTargets,
                subject: `Vendor ${ven_name} Manager Rejection Notification`,
                html: Email.notifRejectMgrPrc(
                    ven_name,
                    ven_type,
                    company,
                    reason
                ),
                cc: cc,
            };
            const send = await transporter.sendMail(setup);
            return send;
        } catch (error) {
            console.log(error);
            throw error;
        }
    },
    NotifPajak: async detail => {
        const transporter = tp;
        try {
            const client = await db.connect();
            try {
                const { rows: getVenDetail } = await client.query(
                    `
                                select
                        v.ven_id,
                        v.ven_group,
                        v.ven_acc,
                        v.ven_type,
                        v.title,
                        v.name_1,
                        v.street,
                        v.telf1,
                        v.fax,
                        v.purch_org ,
                        v.postal,
                        v.email,
                        v.npwp,
                        v.ven_code,
                        upper(v.pay_mthd) as pay_mthd ,
                        concat(v.pay_term,
                        ' ',
                        mpt.term_name) as pay_term,
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
                        v.kawasan_berikat,
                        t.token
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
                    where v.ven_id = $1
                    `,
                    [detail.ven_id]
                );
                const ven_detail = getVenDetail[0];
                const { rows: getFiles } = await client.query(
                    `select mft.file_type , vfa.file_name from ven_file_atth vfa
                left join mst_file_type mft on vfa.file_type = mft.file_code
                where vfa.ven_id = $1 and vfa.file_type in ('A005', 'A006') `,
                    [detail.ven_id]
                );
                const { rows: getTarget } = await client.query(
                    `select email from mst_email where id_user = 'PAJAK'`
                );
                const fileAtth = getFiles.map(item => {
                    let pathStream;
                    if (os.platform() === "win32") {
                        pathStream =
                            path.join(path.resolve(), "backend\\public") +
                            "\\" +
                            item.file_name;
                    } else {
                        pathStream =
                            path.join(path.resolve(), "backend/public") +
                            "/" +
                            item.file_name;
                    }
                    return {
                        filename: `${item.file_type} - ${item.file_name} `,
                        content: fs.createReadStream(pathStream),
                    };
                });
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: getTarget[0].email,
                    subject: `Vendor ${detail.ven_code} - ${ven_detail.name_1} New Registration`,
                    html: Email.toNotifPajak(ven_detail, detail.ven_code),
                    attachments: fileAtth,
                };
                const send = await transporter.sendMail(setup);
                return send;
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    ApprovalDeact: async (ticketappr_id, ven_id, reason, action) => {
        try {
            const client = await db.connect();
            try {
                const { rows: getHostname } = await client.query(
                    "SELECT hostname from hostname where mode_env = $1",
                    [process.env.NODE_ENV]
                );
                const hostname = getHostname[0].hostname;
                const { rows: getVenDetail } = await client.query(
                    `
                                select
                        v.ven_id,
                        v.ven_code,
                        v.ven_group,
                        v.ven_acc,
                        v.ven_type,
                        v.title,
                        v.name_1,
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
                        concat(v.pay_term,
                        ' ',
                        mpt.term_name) as pay_term,
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
                        v.company as comp_id,
                        v.purch_org ,
                        v.lim_curr ,
                        v.limit_vendor ,
                        v.description,
                        t.token
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
                    where v.ven_id = $1
                    `,
                    [ven_id]
                );
                const { rows: getBanks } = await client.query(
                    `select
                                            mb.bank_name ,
                                            vb.bank_id,
                                            vb.bank_acc,
                                            vb.acc_hold,
                                            vb.bank_curr,
                                            vb.country
                                        from
                                            ven_bank vb
                                        left join mst_bank_sap mb on
                                            mb.id::varchar = vb.bank_id
                                        where vb.ven_id = $1`,
                    [ven_id]
                );

                const { rows: getCompany } = await client.query(
                    `select sap_code as code, name from mst_company where comp_id = $1`,
                    [getVenDetail[0].comp_id]
                );

                const { rows: emailmgrprc } = await client.query(`select
                    email from mst_mgr mm
                left join (
                    select
                        distinct user_group_id,
                        user_group_name
                    from
                        mst_page_access mpa) mpa on
                    mm.user_group = mpa.user_group_id
                where mpa.user_group_name = 'MGRPRC';`);

                const bankTable = getBanks.map(item => {
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
                const ven_detail = getVenDetail[0];
                ven_detail.company =
                    getCompany[0].code + " - " + getCompany[0].name;
                const approveLink = `${hostname}/api/reqstat/mgrappract?ticket_id=${ticketappr_id}&action=accept`;
                const rejectLink = `${hostname}/api/reqstat/mgrappract?ticket_id=${ticketappr_id}&action=reject`;
                const actionEmail =
                    action === "Activation" ? "Pengaktifan" : "Penonaktifan";
                const html = Email.ApprovalDeact(
                    actionEmail,
                    ven_detail,
                    bankTable.join(""),
                    reason,
                    approveLink,
                    rejectLink
                );
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: emailmgrprc[0].email,
                    subject: `Vendor ${ven_detail.name_1} ${action} Manager Approval Request  `,
                    html: html,
                };
                await tp.sendMail(setup);
                return;
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    toMDMApprDeact: async (action, ticket_num, ven_name, reason) => {
        try {
            const client = await db.connect();
            try {
                const { rows: getHostname } = await client.query(
                    "SELECT hostname from hostname where mode_env = $1",
                    [process.env.NODE_ENV]
                );
                const { rows: getEmailMDM } = await client.query(`select
                    distinct email
                from
                    mst_user mu
                left join mst_page_access mpa on
                    mu.user_group = mpa.user_group_id
                where
                    user_group_name = 'MDM';`);
                const hostname = getHostname[0].hostname;
                const emailmdm = getEmailMDM.map(item => item.email).join(",");
                const linkAccess = `${hostname}/dashboard/ticketreqstat`;
                const actionEmail =
                    action === "1" ? "reaktivasi" : "deaktivasi";
                const actionTitle =
                    action === "1" ? "Reactivate" : "Deactivate";
                const html = Email.ActVenMDM(
                    actionEmail,
                    ticket_num,
                    ven_name,
                    linkAccess,
                    reason
                );
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: emailmdm,
                    subject: `Vendor ${ven_name} ${actionTitle} Request MDM  `,
                    html: html,
                };
                await tp.sendMail(setup);
                return;
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    rejectedApprDeact: async (ticket_id, remarks) => {
        try {
            const client = await db.connect();
            try {
                const { rows } = await client.query(
                    `
                    select
                    trv.ticket_num,
                    v.name_1,
                    concat(c.name, ' (', c.sap_code, ')') as company,
                    trv.request,
                    mu.email
                    from ticket_reqstat_ven trv
                    left join vendor v on trv.ven_id = v.ven_id
                    left join mst_company c on c.comp_id = v.company
                    left join mst_user mu on mu.user_id = trv.requestor_id
                    where trv.ticket_id = $1`,
                    [ticket_id]
                );
                const {
                    ticket_num,
                    name_1,
                    request,
                    email: emailTarget,
                } = rows[0];
                const actionEmail =
                    request == "1" ? "reaktivasi" : "deaktivasi";
                const actionTitle =
                    request == "1" ? "Reactivation" : "Deactivation";
                const html = Email.RejVenReq(
                    actionEmail,
                    ticket_num,
                    name_1,
                    remarks
                );
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: emailTarget,
                    subject: `Vendor ${name_1} ${actionTitle} Request Rejected `,
                    html: html,
                };
                await tp.sendMail(setup);
                return;
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },
    ApprovedApprDeact: async ticket_id => {
        try {
            const client = await db.connect();
            try {
                const { rows } = await client.query(
                    `
                    select
                    trv.ticket_num,
                    v.name_1,
                    concat(c.name, ' (', c.sap_code, ')') as company,
                    trv.request,
                    mu.email
                    from ticket_reqstat_ven trv
                    left join vendor v on trv.ven_id = v.ven_id
                    left join mst_company c on c.comp_id = v.company
                    left join mst_user mu on mu.user_id = trv.requestor_id
                    where trv.ticket_id = $1`,
                    [ticket_id]
                );
                const {
                    ticket_num,
                    name_1,
                    request,
                    email: emailTarget,
                } = rows[0];
                const actionEmail =
                    request == "1" ? "reaktivasi" : "deaktivasi";
                const actionTitle =
                    request == "1" ? "Reactivation" : "Deactivation";
                const html = Email.ApprDeactVenReq(
                    actionEmail,
                    ticket_num,
                    name_1
                );
                const setup = {
                    from: process.env.SMTP_USERNAME,
                    to: emailTarget,
                    subject: `Vendor ${name_1} ${actionTitle} Request Approved`,
                    html: html,
                };
                await tp.sendMail(setup);
                return;
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    approvedVerif: async (
        ticket_num,
        name_1,
        username,
        email_target,
        password
    ) => {
        try {
            const html = Email.approvedVerify(
                ticket_num,
                name_1,
                username,
                password
            );
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: email_target,
                subject: `Vendor ${name_1} Verification Approved`,
                html: html,
            };
            const res = await tp.sendMail(setup);
            return res;
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    rejectedVerif: async (ticket_num, name_1, notes, target, bcc) => {
        try {
            const html = Email.rejectedVerify(ticket_num, name_1, notes);
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                bcc: bcc,
                subject: `Vendor ${name_1} Verification Rejected`,
                html: html,
            };
            // console.log(setup);
            const res = await tp.sendMail(setup);
            return res;
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    RequestVerificator: async (
        { title, local_ovs, ven_name },
        link,
        target
    ) => {
        try {
            const html = EmailVerif.EmailVerif(
                title,
                local_ovs,
                ven_name,
                link
            );
            const setup = {
                from: process.env.SMTP_USERNAME,
                to: target,
                subject: `Vendor ${ven_name} Verification Request`,
                html: html,
            };
            const res = await tp.sendMail(setup);
            return res;
        } catch (error) {
            console.error(error);
        }
    },

};

module.exports = Emailer;
