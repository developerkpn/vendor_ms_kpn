const EmailStyle = require(`../helper/EmailStyle`);
const moment = require("moment");

const EmailGen = {
    Submit_Staff: ven_detail => {
        return `
    <!doctype html>
    <html lang="en">
    ${EmailStyle}
    <body
        width="100%"
        style="
            margin: 0;
            padding: 0 !important;
            mso-line-height-rule: exactly;
            background-color: #222222;
        "
    >
        <center style="width: 100%; background-color: #f1f1f1">
            <div
                style="max-width: 600px; margin: 0 auto"
                class="email-container"
            >
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                    class="bg_white"
                >
                    <tr>
                        <td
                            valign="top"
                            class="bg_white"
                            style="padding: 1em 2.5em"
                        >
                            <table
                                role="presentation"
                                border="0"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                            >
                                <tr>
                                    <td class="logo" style="text-align: left">
                                        <img
                                            width="40%"
                                            src="${
                                                process.env.APP_URL
                                            }/static/assets/kpn-logo-2.png"
                                        />
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <table width="100%">
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                    width="100%"
                                >
                                    <h4>
                                        Kepada Yth. Bapak/Ibu <br />
                                        Form registrasi vendor dengan nomor
                                        ticket ${
                                            ven_detail.ticket_num
                                        } sudah terisi.
                                        <br />
                                        Detail :
                                    </h4>
                                </td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr>
                                <td width="30%" style="padding: 0.1em 2.5em">
                                    Title
                                </td>
                                <td style="padding: 0.1em 2.5em">: ${
                                    ven_detail.title
                                }</td>
                            </tr>
                            <tr>
                                <td width="30%" style="padding: 0.1em 2.5em">
                                    Local / Overseas
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    : ${ven_detail.local_ovs}
                                </td>
                            </tr>
                            <tr>
                                <td width="30%" style="padding: 0.1em 2.5em">
                                    Vendor Name
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    : ${ven_detail.name_1}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                </table>
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                >
                    <tr>
                        <td
                            valign="middle"
                            class="bg_black footer email-section"
                        >
                            <table>
                                <tr>
                                    <td>KPN Corp Copyright ${moment().format(
                                        "YYYY"
                                    )}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>
        </center>
    </body>
    </html>
    `;
    },
    Submit_Manager: (opening, ven_detail, banks_html, approve, reject, ai_html = "") => {
        return `
      <!doctype html>
      <html lang="en">
      ${EmailStyle}
      <body
        width="100%"
        style="
            margin: 0;
            padding: 0 !important;
            mso-line-height-rule: exactly;
            background-color: #222222;
        "
    >
        <center style="width: 100%; background-color: #f1f1f1">
            <div
                style="max-width: 1000px; margin: 0 auto"
                class="email-container"
            >
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                    class="bg_white"
                >
                    <tr>
                        <td
                            valign="top"
                            class="bg_white"
                            style="padding: 1em 2.5em"
                        >
                            <table
                                role="presentation"
                                border="0"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                            >
                                <tr>
                                    <td class="logo" style="text-align: left">
                                        <img
                                            width="40%"
                                            src="${
                                                process.env.APP_URL
                                            }/static/assets/kpn-logo-2.png"
                                        />
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <table style="width: 100%">
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <h4>${opening}</h4>
                                </td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Vendor Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Requestor
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.requestor} (${
                                        ven_detail.email_requestor
                                    })
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Title
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.title}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Local / Overseas
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.local_ovs}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Name
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.name_1}
                                </td>
                            </tr>
                             <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Status Kawasan Berikat
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${
                                        ven_detail.kawasan_berikat
                                            ? "Kawasan Berikat"
                                            : "Kawasan Bebas Berikat"
                                    }
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Address</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Street
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${[
                                        ven_detail.street,
                                        ven_detail.street2,
                                        ven_detail.street3,
                                        ven_detail.street4,
                                    ].join(" ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Country
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.country}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Postal Code
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.postal}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    City
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.city}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Tax and Payment</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Tax Number
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.npwp}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Payment Method
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_mthd}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Payment Term
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_term}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Company Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Company
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.company}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Purchasing Organization
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.purch_org}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Group
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_group.replace("_", " ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Account
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_acc.replace("_", " ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Type
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_type}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Limit
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.lim_curr ?? ""} ${
                                        ven_detail.limit_vendor
                                            ? parseInt(ven_detail.limit_vendor)
                                                  .toFixed(2)
                                                  .replace(
                                                      /\d(?=(\d{3})+\.)/g,
                                                      "$&,"
                                                  )
                                            : ""
                                    }
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Description
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.description}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table id="tabledet">
                            <tr>
                                <th>Country</th>
                                <th>Bank Name</th>
                                <th>Currency</th>
                                <th>Bank Account</th>
                                <th>Account Holder</th>
                            </tr>
                            ${banks_html.join(" ")}
                        </table>
                    </tr>
                    ${ai_html}
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr>
                                <td width="20%" style="padding: 2em 2.5em">
                                    Action
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    <a href="${approve}">
                                        <button
                                            class="btn btn-primary"
                                            style="
                                                padding-left: 2em;
                                                padding-right: 2em;
                                                padding-top: 1em;
                                                padding-bottom: 1em;
                                            "
                                        >
                                            Yes
                                        </button>
                                    </a>
                                    <a href="${reject}">
                                        <button
                                            class="btn btn-primary"
                                            style="
                                                padding-left: 2em;
                                                padding-right: 2em;
                                                padding-top: 1em;
                                                padding-bottom: 1em;
                                            "
                                        >
                                            No
                                        </button>
                                    </a>
                                </td>
                            </tr>
                        </table>
                    </tr>
                </table>
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                >
                    <tr>
                        <td
                            valign="middle"
                            class="bg_black footer email-section"
                        >
                            <table>
                                <tr>
                                    <td>KPN Corp Copyright ${moment().format(
                                        "YYYY"
                                    )}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>
        </center>
    </body>
      `;
    },

    Submit_MDM: (ven_detail, weburl) => {
        return `
         <!doctype html>
        <html lang="en">
        ${EmailStyle}
        <body
                width="100%"
                style="
                    margin: 0;
                    padding: 0 !important;
                    mso-line-height-rule: exactly;
                    background-color: #222222;
                "
            >
                <center style="width: 100%; background-color: #f1f1f1">
                    <div
                        style="max-width: 600px; margin: 0 auto"
                        class="email-container"
                    >
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                            class="bg_white"
                        >
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <table
                                        role="presentation"
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        width="100%"
                                    >
                                        <tr>
                                            <td class="logo" style="text-align: left">
                                                <img
                                                    width="40%"
                                                    src="${
                                                        process.env.APP_URL
                                                    }/static/assets/kpn-logo-2.png"
                                                />
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <table style="width: 100%">
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Kepada Yth. Bapak/Ibu <br />
                                                Mohon proses Request Registrasi Vendor
                                                dengan detail berikut :
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                            <tr>
                                <table class="bg_white" width="100%">
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Ticket Number
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.ticket_num}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Title
                                        </td>
                                        <td style="padding: 0.1em 2.5em">: ${
                                            ven_detail.title
                                        }</td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Local / Overseas
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.local_ovs}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Name
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.name_1}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding-top: 1rem"></td>
                                    </tr>
                                </table>
                            </tr>
                            <tr>
                                <table style="width: 100%">
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Dapat diakses dilink berikut :
                                                <a href="${weburl}">${weburl}</a>
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                        </table>
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                        >
                            <tr>
                                <td
                                    valign="middle"
                                    class="bg_black footer email-section"
                                >
                                    <table>
                                        <tr>
                                            <td>KPN Corp Copyright ${moment().format(
                                                "YYYY"
                                            )}</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </div>
                </center>
            </body>
        `;
    },
    RejectReq: (ven_detail, remarks) => {
        return `
          <!doctype html>
        <html lang="en">
        ${EmailStyle}
        <body
                width="100%"
                style="
                    margin: 0;
                    padding: 0 !important;
                    mso-line-height-rule: exactly;
                    background-color: #222222;
                "
            >
                <center style="width: 100%; background-color: #f1f1f1">
                    <div
                        style="max-width: 600px; margin: 0 auto"
                        class="email-container"
                    >
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                            class="bg_white"
                        >
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <table
                                        role="presentation"
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        width="100%"
                                    >
                                        <tr>
                                            <td class="logo" style="text-align: left">
                                                <img
                                                    width="40%"
                                                    src="${
                                                        process.env.APP_URL
                                                    }/static/assets/kpn-logo-2.png"
                                                />
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <table>
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Kepada Yth. Bapak/Ibu <br />
                                                Permintaan registrasi vendor anda : <br/>
                                        </td>
                                    </tr>
                                    <tr>
                                        <table class="bg_white" width="100%">
                                            <tr>
                                                <td width="30%" style="padding: 0.1em 2.5em">
                                                    Ticket Number
                                                </td>
                                                <td style="padding: 0.1em 2.5em">
                                                    : ${ven_detail.ticket_num}
                                                </td>
                                            </tr>
                                            <tr>
                                                <td width="30%" style="padding: 0.1em 2.5em">
                                                    Vendor Name
                                                </td>
                                                <td style="padding: 0.1em 2.5em">
                                                    : ${ven_detail.name_1}
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding-top: 1rem"></td>
                                            </tr>
                                        </table>
                                    </tr>
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                                adalah <span class="rejected">Rejected</span> dengan detail
                                                sebagai berikut :
                                                <br />
                                                <br />
                                                ${remarks} 
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                        </table>
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                        >
                            <tr>
                                <td
                                    valign="middle"
                                    class="bg_black footer email-section"
                                >
                                    <table>
                                        <tr>
                                            <td>KPN Corp Copyright ${moment().format(
                                                "YYYY"
                                            )}</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </div>
                </center>
            </body>
        </html>
        `;
    },
    Submit_Staff_CG: ven_detail => {
        return `
        <!doctype html>
            <html lang="en">
            ${EmailStyle}
            <body
                width="100%"
                style="
                    margin: 0;
                    padding: 0 !important;
                    mso-line-height-rule: exactly;
                    background-color: #222222;
                "
            >
                <center style="width: 100%; background-color: #f1f1f1">
                    <div
                        style="max-width: 600px; margin: 0 auto"
                        class="email-container"
                    >
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                            class="bg_white"
                        >
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <table
                                        role="presentation"
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        width="100%"
                                    >
                                        <tr>
                                            <td class="logo" style="text-align: left">
                                                <img
                                                    width="40%"
                                                    src="${
                                                        process.env.APP_URL
                                                    }/static/assets/kpn-logo-2.png"
                                                />
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <table width="100%">
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                            width="100%"
                                        >
                                            <h4>
                                                Kepada Yth. Bapak/Ibu <br />
                                                Form registrasi vendor dengan nomor
                                                ticket ${
                                                    ven_detail.ticket_num
                                                } sudah terisi.
                                                <br />
                                                Detail :
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                            <tr>
                                <table class="bg_white" width="100%">
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Type
                                        </td>
                                        <td style="padding: 0.1em 2.5em">: ${
                                            ven_detail.ven_type
                                        }</td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Name
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.name_1}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding-top: 1rem"></td>
                                    </tr>
                                </table>
                            </tr>
                        </table>
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                        >
                            <tr>
                                <td
                                    valign="middle"
                                    class="bg_black footer email-section"
                                >
                                    <table>
                                        <tr>
                                            <td>KPN Corp Copyright ${moment().format(
                                                "YYYY"
                                            )}</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </div>
                </center>
            </body>
            </html>
        `;
    },

    Submit_Manager_CG: (opening, ven_detail, banks_html, approve, reject, ai_html = "") => {
        return `
      <!doctype html>
      <html lang="en">
      ${EmailStyle}
      <body
        width="100%"
        style="
            margin: 0;
            padding: 0 !important;
            mso-line-height-rule: exactly;
            background-color: #222222;
        "
    >
        <center style="width: 100%; background-color: #f1f1f1">
            <div
                style="max-width: 1000px; margin: 0 auto"
                class="email-container"
            >
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                    class="bg_white"
                >
                    <tr>
                        <td
                            valign="top"
                            class="bg_white"
                            style="padding: 1em 2.5em"
                        >
                            <table
                                role="presentation"
                                border="0"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                            >
                                <tr>
                                    <td class="logo" style="text-align: left">
                                        <img
                                            width="40%"
                                            src="${
                                                process.env.APP_URL
                                            }/static/assets/kpn-logo-2.png"
                                        />
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <table style="width: 100%">
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <h4>${opening}</h4>
                                </td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Vendor Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Requestor
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.requestor} (${
                                        ven_detail.email_requestor
                                    })
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Type
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_type}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Name
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.name_1}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Address</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Street
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${[
                                        ven_detail.street,
                                        ven_detail.street2,
                                        ven_detail.street3,
                                        ven_detail.street4,
                                    ].join(" ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Country
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.country}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Postal Code
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.postal}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    City
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.city}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Tax and Payment</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Tax Number
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.npwp}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Used Tax
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.used_tax}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Price Term
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_mthd}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Payment Term
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_term}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Company Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Class
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_class}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Currency
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.lim_curr}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Description
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.description}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table id="tabledet">
                            <tr>
                                <th>Bank Name</th>
                                <th>Currency</th>
                                <th>Bank Account</th>
                                <th>Account Holder</th>
                            </tr>
                            ${banks_html.join(" ")}
                        </table>
                    </tr>
                    ${ai_html}
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr>
                                <td width="20%" style="padding: 2em 2.5em">
                                    Action
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    <a href="${approve}">
                                        <button
                                            class="btn btn-primary"
                                            style="
                                                padding-left: 2em;
                                                padding-right: 2em;
                                                padding-top: 1em;
                                                padding-bottom: 1em;
                                            "
                                        >
                                            Yes
                                        </button>
                                    </a>
                                    <a href="${reject}">
                                        <button
                                            class="btn btn-primary"
                                            style="
                                                padding-left: 2em;
                                                padding-right: 2em;
                                                padding-top: 1em;
                                                padding-bottom: 1em;
                                            "
                                        >
                                            No
                                        </button>
                                    </a>
                                </td>
                            </tr>
                        </table>
                    </tr>
                </table>
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                >
                    <tr>
                        <td
                            valign="middle"
                            class="bg_black footer email-section"
                        >
                            <table>
                                <tr>
                                    <td>KPN Corp Copyright ${moment().format(
                                        "YYYY"
                                    )}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>
        </center>
    </body>
      `;
    },
    Submit_MDM_CG: (ven_detail, weburl) => {
        return `
         <!doctype html>
        <html lang="en">
        ${EmailStyle}
        <body
                width="100%"
                style="
                    margin: 0;
                    padding: 0 !important;
                    mso-line-height-rule: exactly;
                    background-color: #222222;
                "
            >
                <center style="width: 100%; background-color: #f1f1f1">
                    <div
                        style="max-width: 600px; margin: 0 auto"
                        class="email-container"
                    >
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                            class="bg_white"
                        >
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <table
                                        role="presentation"
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        width="100%"
                                    >
                                        <tr>
                                            <td class="logo" style="text-align: left">
                                                <img
                                                    width="40%"
                                                    src="${
                                                        process.env.APP_URL
                                                    }/static/assets/kpn-logo-2.png"
                                                />
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <table style="width: 100%">
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Kepada Yth. Bapak/Ibu <br />
                                                Mohon proses Request Registrasi Vendor
                                                dengan detail berikut :
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                            <tr>
                                <table class="bg_white" width="100%">
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Ticket Number
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.ticket_num}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Type
                                        </td>
                                        <td style="padding: 0.1em 2.5em">: ${
                                            ven_detail.ven_type
                                        }</td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Class
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.ven_class}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td width="30%" style="padding: 0.1em 2.5em">
                                            Vendor Name
                                        </td>
                                        <td style="padding: 0.1em 2.5em">
                                            : ${ven_detail.name_1}
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding-top: 1rem"></td>
                                    </tr>
                                </table>
                            </tr>
                            <tr>
                                <table style="width: 100%">
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Dapat diakses dilink berikut :
                                                <a href="${weburl}">${weburl}</a>
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                        </table>
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                        >
                            <tr>
                                <td
                                    valign="middle"
                                    class="bg_black footer email-section"
                                >
                                    <table>
                                        <tr>
                                            <td>KPN Corp Copyright ${moment().format(
                                                "YYYY"
                                            )}</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </div>
                </center>
            </body>
        `;
    },

    Submit_END: (ven_code, ven_name) => {
        return `
         <!doctype html>
        <html lang="en">
        ${EmailStyle}
        <body
                width="100%"
                style="
                    margin: 0;
                    padding: 0 !important;
                    mso-line-height-rule: exactly;
                    background-color: #222222;
                "
            >
                <center style="width: 100%; background-color: #f1f1f1">
                    <div
                        style="max-width: 600px; margin: 0 auto"
                        class="email-container"
                    >
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                            class="bg_white"
                        >
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                    <table
                                        role="presentation"
                                        border="0"
                                        cellpadding="0"
                                        cellspacing="0"
                                        width="100%"
                                    >
                                        <tr>
                                            <td class="logo" style="text-align: left">
                                                <img
                                                    width="40%"
                                                    src="${
                                                        process.env.APP_URL
                                                    }/static/assets/kpn-logo-2.png"
                                                />
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <table>
                                    <tr>
                                        <td
                                            valign="top"
                                            class="bg_white"
                                            style="padding: 1em 2.5em"
                                        >
                                            <h4>
                                                Kepada Yth. Bapak/Ibu <br />
                                                Permintaan registrasi kode vendor anda telah di setujui dengan kode sebagai berikut:
                                                <br />
                                                ${ven_code} - ${ven_name}
                                            </h4>
                                        </td>
                                    </tr>
                                </table>
                            </tr>
                        </table>
                        <table
                            align="center"
                            role="presentation"
                            cellspacing="0"
                            cellpadding="0"
                            border="0"
                            width="100%"
                            style="margin: auto"
                        >
                            <tr>
                                <td
                                    valign="middle"
                                    class="bg_black footer email-section"
                                >
                                    <table>
                                        <tr>
                                            <td>KPN Corp Copyright ${moment().format(
                                                "YYYY"
                                            )}</td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </div>
                </center>
            </body>
        </html>
        `;
    },

    Submit_Coupa: (ven_detail, banks_html) => {
        return `
      <!doctype html>
      <html lang="en">
      ${EmailStyle}
      <body
        width="100%"
        style="
            margin: 0;
            padding: 0 !important;
            mso-line-height-rule: exactly;
            background-color: #222222;
        "
    >
        <center style="width: 100%; background-color: #f1f1f1">
            <div
                style="max-width: 1000px; margin: 0 auto"
                class="email-container"
            >
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                    class="bg_white"
                >
                    <tr>
                        <td
                            valign="top"
                            class="bg_white"
                            style="padding: 1em 2.5em"
                        >
                            <table
                                role="presentation"
                                border="0"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                            >
                                <tr>
                                    <td class="logo" style="text-align: left">
                                        <img
                                            width="40%"
                                            src="${
                                                process.env.APP_URL
                                            }/static/assets/kpn-logo-2.png"
                                        />
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <table style="width: 100%">
                            <tr>
                                <td
                                    valign="top"
                                    class="bg_white"
                                    style="padding: 1em 2.5em"
                                >
                                      <h4>Please find attached the information regarding the vendor registration categorized as a ${
                                          ven_detail.is_tender
                                              ? "tender"
                                              : ven_detail.is_priority
                                              ? "priority"
                                              : "internal payment priority vendor"
                                      }  . The vendor has been created in the system in accordance with the category specified by the user.<br/>
Below are the details of the respective vendor.</h4>
                                </td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Vendor Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Requestor
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                   Coupa
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Title
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.title}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Local / Overseas
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.local_ovs}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Name
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.name_1}
                                </td>
                            </tr>
                             <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Status Kawasan Berikat
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${
                                        ven_detail.kawasan_berikat
                                            ? "Kawasan Berikat"
                                            : "Kawasan Bebas Berikat"
                                    }
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Address</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Street
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${[
                                        ven_detail.street,
                                        ven_detail.street2,
                                        ven_detail.street3,
                                        ven_detail.street4,
                                    ].join(" ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Country
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.country}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Postal Code
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.postal}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    City
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.city}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Tax and Payment</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Tax Number
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.npwp}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Payment Method
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_mthd}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Payment Term
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.pay_term}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="section-detail">
                                <td>Company Details</td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table class="bg_white" width="100%">
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Company
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.company}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Purchasing Organization
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.purch_org}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Group
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_group.replace("_", " ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Account
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_acc.replace("_", " ")}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Vendor Type
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.ven_type}
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Limit
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                    ${ven_detail.lim_curr ?? ""} ${
                                        ven_detail.limit_vendor
                                            ? parseInt(ven_detail.limit_vendor)
                                                  .toFixed(2)
                                                  .replace(
                                                      /\d(?=(\d{3})+\.)/g,
                                                      "$&,"
                                                  )
                                            : ""
                                    }
                                </td>
                            </tr>
                            <tr class="detail">
                                <td width="20%" style="padding: 0.1em 2.5em">
                                    Description
                                </td>
                                <td style="padding: 0.1em 2.5em" width="1%">
                                    :
                                </td>
                                <td style="padding: 0.1em 2.5em">
                                ${
                                    ven_detail.is_tender
                                        ? "Vendor is classified as a tender vendor."
                                        : ven_detail.is_priority
                                        ? "Vendor is classified as a priority vendor."
                                        : ven_detail.is_interest
                                        ? "Vendor is prioritized for interest payments."
                                        : ven_detail.description ?? ""
                                }
                                </td>
                            </tr>
                            <tr>
                                <td style="padding-top: 1rem"></td>
                            </tr>
                        </table>
                    </tr>
                    <tr>
                        <table id="tabledet">
                            <tr>
                                <th>Country</th>
                                <th>Bank Name</th>
                                <th>Currency</th>
                                <th>Bank Account</th>
                                <th>Account Holder</th>
                            </tr>
                            ${banks_html.join(" ")}
                        </table>
                    </tr>
                </table>
                <table
                    align="center"
                    role="presentation"
                    cellspacing="0"
                    cellpadding="0"
                    border="0"
                    width="100%"
                    style="margin: auto"
                >
                    <tr>
                        <td
                            valign="middle"
                            class="bg_black footer email-section"
                        >
                            <table>
                                <tr>
                                    <td>KPN Corp Copyright ${moment().format(
                                        "YYYY"
                                    )}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>
        </center>
    </body>
      `;
    },
};

module.exports = EmailGen;
