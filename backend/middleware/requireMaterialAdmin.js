const {
    isAdminMaterialApprover,
    refreshMaterialAdminUsernames,
} = require("../services/materialService");

// The Materials Administrator section (approver chains, guide management)
// belongs to Materials administrators: the ADMIN account and the MATERIAL_ADMIN
// group. Hiding the menu entry is not enough on its own; this closes the API
// behind it. Same check, and the same session cookie, as the approver-master
// endpoints use. Mount after AuthToken.authSession.
//
// A user not in the cached admin list gets one re-check against the database
// (at most every 10 s), so a group change needs no restart.
module.exports = async function requireMaterialAdmin(req, res, next) {
    const username = req.cookies?.username;
    if (!isAdminMaterialApprover(username)) {
        await refreshMaterialAdminUsernames({ minAgeMs: 10 * 1000 });
    }
    if (!isAdminMaterialApprover(username)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return next();
};
