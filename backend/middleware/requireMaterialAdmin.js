const { isAdminMaterialApprover } = require("../services/materialService");

// The Materials Administrator section (approver chains, guide management)
// belongs to the ADMIN user. Hiding the menu entry is not enough on its own;
// this closes the API behind it. Same check, and the same session cookie, as
// the approver-master endpoints use. Mount after AuthToken.authSession.
module.exports = function requireMaterialAdmin(req, res, next) {
    if (!isAdminMaterialApprover(req.cookies?.username)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return next();
};
