// Generic helpers for vendor data. Pure functions only — no DB, no Express.

// Vendor name cut to what VMS accepts. 35 = VMS / SAP NAME1 max length; a
// source without that limit (Coupa) can hand back a longer name, which is cut
// to fit the vendor form it pre-fills.
const limitVendorName = name => {
    if (!name) return null;
    return String(name).trim().slice(0, 35).trim() || null;
};

module.exports = {
    limitVendorName,
};
