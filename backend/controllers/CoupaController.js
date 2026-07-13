const { raw } = require("express");
const CoupaService = require("../class/CoupaService");
const { isAxiosError } = require("axios");
const Ticket = require("../models/TicketModel");
const EmailModel = require("../models/EmailModelv2");
const CoupaModel = require("../models/CoupaModel");
const db = require("../config/connection");
const Coupa = require("../models/CoupaModel");

exports.getData = async (req, res) => {
    try {
        let date = req.body.date;
        if (!date) {
            const d = new Date();
            d.setDate(d.getDate() - 3);
            date = d.toISOString().slice(0, 10);
        }
        const rawData = await CoupaService.fetchData(date);

        const filteredData = rawData.map(item => ({
            id: item.id,
            coupa_id: item["supplier-id"],
            name: item.name,
            vendor_name: item["display-name"],
            vendor_code: item["supplier-number"],
            status: item.status,
            updated_at: item["updated-at"],
        }));

        res.json({
            success: true,
            data: filteredData,
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

function splitData(data, maxLength = 35, title) {
    if (!data) return {};

    const words = data.split(" ");
    const lines = [];
    let line = "";

    for (const word of words) {
        if ((line + " " + word).trim().length <= maxLength) {
            line = (line + " " + word).trim();
        } else {
            lines.push(line);
            line = word;
        }
    }

    if (line) lines.push(line);

    const result = {};
    lines.forEach((l, i) => {
        result[`${title}${i + 1}`] = l;
    });

    return result;
}

exports.getDetail = async (req, res) => {
    try {
        const id = req.body.id;
        if (!id) throw new Error("id is missing");
        const rawData = await CoupaService.getDetail(id);

        const filteredData = rawData.map(item => {
            const contact = item["supplier-information-contacts"]?.[0];
            const address = item["supplier-information-addresses"]?.[0];
            const insurance =
                item["supplier-information-insurance-detail"]?.[
                    "custom-fields"
                ];
            const purchOrg = item["custom-fields"]?.["purchasing-organization"];
            const enterprise =
                item["supplier-information-enterprise-detail"]?.[
                    "custom-fields"
                ];
            const company = item["custom-fields"]?.["company-code"];
            const bankInformations = [];

            const bankData = item["custom-fields"]?.["nama-bank--bank-name"];
            const bankRegion =
                item["custom-fields"]?.["negara-bank--bank-region"];

            if (bankData || item["custom-fields"]?.["bank-account-number"]) {
                bankInformations.push({
                    bank_country: bankRegion?.["external-ref-num"] || null,
                    bank_country_name: bankRegion?.name || null,

                    bank_key: bankData?.["external-ref-code"] || null,
                    bank_name: bankData?.name || null,

                    bank_curr: item["preferred-currency"]?.code || null,
                    bank_acc:
                        item["custom-fields"]?.["bank-account-number"] || null,
                    acc_hold:
                        item["custom-fields"]?.["account-holder-name"] || null,
                    swift_code: item["custom-fields"]?.["swift-code"] || null,
                });
            }

            const payTerm = item["payment-term"];
            const ppnData = item["custom-fields"]?.["ppn-type"];

            const fullAddress = [
                address["street-address"],
                address["street-address2"],
                address["street-address3"],
                address["street-address4"],
            ]
                .filter(Boolean)
                .join(" ");

            const npwpAddress =
                [
                    insurance?.["npwp-street-address-1"],
                    insurance?.["npwp-street-address-2"],
                    insurance?.["npwp-street-address-3"],
                    insurance?.["npwp-street-address-4"],
                ]
                    .filter(Boolean)
                    .join(" ") || null;

            const skkpAddress =
                [
                    enterprise?.["sppkp-street-address-1"],
                    enterprise?.["sppkp-street-address-2"],
                    enterprise?.["sppkp-street-address-3"],
                    enterprise?.["sppkp-street-address-4"],
                ]
                    .filter(Boolean)
                    .join(" ") || null;

            const streetLines = splitData(fullAddress, 35, "street");
            const npwpLines = splitData(npwpAddress, 35, "npwp_street");
            const skkpLines = splitData(skkpAddress, 35, "sppkp_street");

            return {
                company: {
                    title: item["custom-fields"]?.["title-perusahaan"] || null,
                    local_ovs: item["custom-fields"]?.["local-foreign"] || null,
                    country: address?.["country"]?.name || null,
                    country_code: address?.["country"]?.code || null,
                    name_1: item.name || null,
                    name_2: item["display-name"] || null,
                    phone:
                        [
                            contact?.["phone-work"]?.extension,
                            contact?.["phone-work"]?.number,
                        ]
                            .filter(Boolean)
                            .join(" ") || null,

                    fax:
                        [
                            contact?.["phone-fax"]?.extension,
                            contact?.["phone-fax"]?.number,
                        ]
                            .filter(Boolean)
                            .join(" ") || null,
                    email: contact?.["email"] || null,
                    kawasan_berikat: insurance?.["kawasan-berikat"],
                    coupa_id: item["supplier-id"] || null,
                },
                social_media: {
                    website_url: item.website || null,
                },
                company_organization: {
                    nama_direktur:
                        item["custom-fields"]?.["nama-direktur"] || null,
                    nama_pic:
                        [contact?.["name-given"], contact?.["name-family"]]
                            .filter(Boolean)
                            .join(" ") || null,
                    no_telf_pic:
                        [
                            contact?.["phone-mobile"]?.extension || null,
                            contact?.["phone-mobile"]?.number || null,
                        ]
                            .filter(Boolean)
                            .join(" ") || null,
                    email_finance:
                        item["custom-fields"]?.["email-finance"] || null,
                    email_pic: contact.email || null,
                },
                company_address: {
                    ...streetLines,
                    city: address?.city || null,
                    postal: address?.["postal-code"] || null,
                },
                npwp_address: {
                    ...npwpLines,
                    city_npwp: insurance?.["npwp-city"]?.name || null,
                    postal_npwp: insurance?.["npwp-postal-code"] || null,
                },
                sppkp_address: {
                    ...skkpLines,
                    city_sppkp: enterprise?.["sppkp-city"]?.name || null,
                    postal_sppkp: enterprise?.["sppkp-postal-code"] || null,
                },
                tax_payment: {
                    is_pkp: insurance?.statuspkp || null,
                    is_new_npwp: true,
                    npwp: item["custom-fields"]?.["npwp-16digits"] || null,
                    pay_mthd:
                        item["custom-fields"]?.["bank-method-payment"] || null,
                    pay_term: payTerm?.description || null,
                    pay_term_code: payTerm?.code || null,
                    pay_term_type: payTerm?.type || null,
                    ppn_description: ppnData?.description || null,
                    ppn_code: ppnData?.["external-ref-code"] || null,
                    nitku: enterprise?.nitku || null,
                },
                vendor_detail: {
                    company: company?.name || null,
                    company_code: company?.["external-ref-code"] || null,
                    purch_org: purchOrg?.name || null,
                    purch_org_code: purchOrg?.["external-ref-num"] || null,
                    ven_group: "3RD_PARTY",
                    ven_acc: "NON_TRADE",
                    ven_type:
                        item["custom-fields"]?.["vendor-category"] || null,
                    lim_curr: "",
                    limit_vendor: "",
                    is_tender: item["custom-fields"]?.["vendor-peserta-tender"],
                    is_priority: item["custom-fields"]?.["vendor-prioritas"],
                    is_interest:
                        item["custom-fields"]?.[
                            "prioritas-pembayaran-interest"
                        ],
                    ven_description: enterprise?.descriptive || null,
                },
                bank_information: bankInformations,
                vendor_code: item["supplier-number"],
                id: item.id,
            };
        });

        res.json({
            success: true,
            // rawData,
            data: filteredData[0],
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

exports.updateVendor = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) throw new Error("id is missing");

        const status = await CoupaService.updateData(id);

        if (status !== 200) {
            throw new Error("Failed to update vendor");
        }

        res.json({
            success: true,
            message: "Success update data vendor",
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

exports.submitVendorCoupa = async (req, res) => {
    const { ven_detail, ven_banks } = req.body;
    try {
        const data = await Coupa.submitVendorCoupa({
            ven_detail,
            ven_banks,
        });
        if (!data) throw new Error("No data returned from submitVendorCoupa");
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
    }
};

exports.sendEmail = async (req, res) => {
    const { ven_detail, ven_banks } = req.body;
    if (!ven_detail) {
        return res.status(400).send({ message: "ven_detail is missing" });
    }

    const client = await db.connect();
    try {
        const data = await EmailModel.coupaEmail(client, ven_detail, ven_banks);
        res.status(200).send({ message: "Email sent successfully", data });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error?.message ?? "Internal server error",
        });
    } finally {
        client.release();
    }
};

exports.getSubmitted = async (req, res) => {
    try {
        const data = await CoupaModel.getSubmitted();
        res.status(200).send({ message: "Success Get Data", data });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error?.message ?? "Internal server error",
        });
    }
};

exports.detailVendor = async (req, res) => {
    const { code } = req.body;
    try {
        console.log(req.body);
        const data = await CoupaModel.detailVendor(code);
        res.status(200).send({ message: "Success Get Data", data });
    } catch (error) {
        console.error(error);
        res.status(500).send({
            message: error?.message ?? "Internal server error",
        });
    }
};
