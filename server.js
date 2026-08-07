const express = require("express");
const morgan = require("morgan");
const header = require("./backend/middleware/header");
const app = express();
const dotenv = require("dotenv").config({
    path: `./${process.env.NODE_ENV}.env`,
});
const os = require("os");
const https = require("https");
const http = require("http");
const path = require("path");
const routers = require("./backend/routes");
const port = process.env.PORT;
const cors = require("cors");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const db = require("./backend/config/connection");
const {
    ensureSingleRequestSchema,
} = require("./backend/config/ensureSingleRequestSchema");
const VerifyLogin = require("./backend/middleware/VerifyLogin");
const { SchedulerSyncStaged } = require("./backend/helper/Scheduler");
const Material = require("./backend/models/MaterialModel");
const materialSapStagingService = require("./backend/services/materialSapStagingService");
const reworkEmailInboundService = require("./backend/services/reworkEmailInboundService");
const cron = require("node-cron");
const moment = require("moment-timezone");

const whitelist = [
    "http://172.30.60.50:3000",
    "http://172.29.0.1:3000",
    "http://localhost:3000",
    "https://localhost:3000",
    "https://localhost:3004",
    "https://localhost:4173",
    "https://4c59-49-156-20-130.ngrok-free.app",
];
const servOption = {
    cert: fs.readFileSync("./ssl/cert.pem"),
    key: fs.readFileSync("./ssl/key.pem"),
};
const corsOption = {
    origin: function (req, callback) {
        if (whitelist.indexOf(req) !== -1) {
            callback(null, true);
        } else {
            callback(null, false);
        }
    },
    methods: ["POST", "PUT", "GET", "OPTIONS", "HEAD", "DELETE", "PATCH"],
    credentials: true,
    exposedHeaders: ["set-cookie", "Content-Disposition"],
};

// app.use(header);
app.set("view engine", "ejs");
app.use(header);
if (os.platform() === "linux") {
    app.set("views", path.join(__dirname, "/backend/views/pages"));
} else {
    app.set("views", path.join(__dirname, "\\backend\\views\\pages"));
}
app.use(cors(corsOption));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(routers);
app.use(
    morgan(":method :url :status :res[content-length] - :response-time ms")
);
app.use(express.static(path.join(__dirname, "public/build")));
app.use("/static", express.static(path.join(__dirname, "backend/public")));
app.get("/*$", (req, res) => {
    res.sendFile(path.join(__dirname, "public/build", "index.html"));
});

process.on("uncaughtException", err => {
    console.error(err, "Uncaught Exception thrown");
    process.exit(1);
});

setInterval(
    async () => {
        await SchedulerSyncStaged();
    },
    1000 * 60 * 11
); //11 minutes

// setInterval(() => {
//     console.log("client:" + db.totalCount);
// }, 1000);

// const server = http.createServer(servOption, app).listen(port, () => {
//     console.log(`App running on ${port}`);
// });

// Schedule SAP sync every day at 6pm Asia/Jakarta time
cron.schedule(
    "0 18 * * *",
    async () => {
        // Calculate yesterday and today in Asia/Jakarta time, format YYYYMMDD
        const yesterday = moment
            .tz("Asia/Jakarta")
            .subtract(2, "day")
            .format("YYYYMMDD");
        const today = moment
            .tz("Asia/Jakarta")
            .add(1, "day")
            .format("YYYYMMDD");
        console.log(
            `[CRON] Running SAP sync for date range: ${yesterday} to ${today}`
        );
        // Run for LAEDA
        const resultLAEDA = await Material.syncSAPDataJob({
            startDate: yesterday,
            endDate: today,
            fieldName: "LAEDA",
        });
        console.log("[CRON] SAP sync result (LAEDA):", resultLAEDA);
        // Run for ERSDA
        const resultERSDA = await Material.syncSAPDataJob({
            startDate: yesterday,
            endDate: today,
            fieldName: "ERSDA",
        });
        console.log("[CRON] SAP sync result (ERSDA):", resultERSDA);
    },
    {
        timezone: "Asia/Jakarta",
    }
);

// Reconcile the Oracle SAP staging table (VMS_MATERIALDATA) — runs every minute
// for now (testing); raise the interval for production. Pulls SAP's write-back —
// FLAG 'S' (success, material created) or 'E' (error + message) — back into
// mat_single_request.sap_push_status (the source of truth the UI reads), and
// also pushes any PENDING stragglers the inline post-MDM push may have missed.
cron.schedule(
    "* * * * *",
    async () => {
        try {
            const pushed =
                await materialSapStagingService.pushPendingMaterialsToSapStaging(
                    { limit: 50 }
                );
            const synced =
                await materialSapStagingService.syncMaterialStagingFromSap();
            if (
                pushed.pushed.length ||
                pushed.errors.length ||
                synced.synced.length ||
                synced.failed.length
            ) {
                console.log("[CRON] SAP material staging:", {
                    pushed: pushed.pushed.length,
                    pushErrors: pushed.errors.length,
                    synced: synced.synced.length,
                    syncFailed: synced.failed.length,
                });
            }
        } catch (error) {
            console.error(
                "[CRON] SAP material staging reconcile failed:",
                error
            );
        }
    },
    // Don't let a slow tick overlap the next one.
    { noOverlap: true }
);

// Pull rework-approver replies out of the VMS mailbox — every 60s.
// OFF unless REWORK_EMAIL_INBOUND_ENABLED === 'true': the box is shared with
// humans and holds 14k+ unrelated mails, so nothing connects to it until an
// operator opts in per environment. The first enabled tick only seeds its
// cursor at uidNext-1 and reads nothing (see reworkEmailInboundService).
cron.schedule(
    "* * * * *",
    async () => {
        if (process.env.REWORK_EMAIL_INBOUND_ENABLED !== "true") {
            return;
        }

        try {
            const result = await reworkEmailInboundService.pollReworkEmailReplies();
            if (result.scanned || result.inserted || result.reason !== "RESUME") {
                console.log("[CRON] Rework email inbound:", result);
            }
        } catch (error) {
            console.error("[CRON] Rework email inbound poll failed:", error);
        }
    },
    // A slow IMAP round trip must not stack ticks on the same mailbox.
    { noOverlap: true }
);

async function startServer() {
    await ensureSingleRequestSchema(db);

    https.createServer(servOption, app).listen(port, "0.0.0.0", () => {
        console.log(`App running on ${port}`);
    });
}

startServer().catch(error => {
    console.error("Failed to ensure single request schema:", error);
    process.exit(1);
});
