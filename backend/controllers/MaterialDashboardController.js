const materialDashboardService = require("../services/materialDashboardService");

module.exports = {
    getDashboard: async (req, res) => {
        try {
            const data = await materialDashboardService.getMaterialDashboard({
                actorUserId: req.cookies?.user_id,
                actorUsername: req.cookies?.username,
                query: req.query,
            });
            return res.status(200).json({ success: true, data });
        } catch (error) {
            if (!error.statusCode)
                console.error("[MATERIAL-DASHBOARD]", error.message);
            return res.status(error.statusCode || 500).json({
                success: false,
                message: error.statusCode
                    ? error.message
                    : "Failed to load the material dashboard.",
            });
        }
    },
};
