const pool = require("../config/connection");
const {
    isAdminMaterialApprover,
    isActorMdmMaterialUser,
    refreshMaterialAdminUsernames,
} = require("../services/materialService");

// Changes to a released material's data (deleting its attachments) belong to
// Master Data (the MDM_MATERIAL group) and Materials administrators (the ADMIN
// account and the MATERIAL_ADMIN group). Hiding the button is not enough on its
// own; this closes the API behind it. Mount after AuthToken.authSession.
//
// Admins are checked first, the same way as requireMaterialAdmin; Master Data
// membership is read from the database on every call, so a group change needs
// no restart.
module.exports = async function requireMaterialMasterData(req, res, next) {
    const username = req.cookies?.username;
    if (!isAdminMaterialApprover(username)) {
        await refreshMaterialAdminUsernames({ minAgeMs: 10 * 1000 });
    }
    if (isAdminMaterialApprover(username)) {
        return next();
    }
    try {
        if (await isActorMdmMaterialUser(pool, req.cookies?.user_id)) {
            return next();
        }
    } catch (error) {
        console.error(
            "[MATERIAL-ACCESS] could not check Master Data membership:",
            error && error.message
        );
        return res
            .status(500)
            .json({ success: false, message: "Could not check access" });
    }
    return res.status(403).json({ success: false, message: "Forbidden" });
};
