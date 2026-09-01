const express = require("express");
const User = require("./UserRoute");
const Ticket = require("./TicketRoute");
const Vendor = require("./VendorRoute");
const Master = require("./MasterRoute");
const Email = require("./EmailRoute");
const Reqstat = require("./ReqstatRoute");
const Otp = require("./OTPRoute");
const Approval = require("./ApprovalRoute");
const Ticeddet = require("./TicketEditReqDetRoute");
const CGApi = require("./CGApiRoute");
const Material = require("./MaterialRoute");
const ETender = require("./ETenderRoute");
const Report = require("./ReportRoute");
const Coupa = require("./CoupaRoute");
const AiValidation = require("./AiValidationRoute");
const openAPI = require("./ApiRoute");
const router = express.Router();

router.use("/api/user", User);
router.use("/api/ticket", Ticket);
router.use("/api/vendor", Vendor);
router.use("/api/master", Master);
router.use("/api/email", Email);
router.use("/api/reqstat", Reqstat);
router.use("/api/otp", Otp);
router.use("/api/approval", Approval);
router.use("/api/ticeddet", Ticeddet);
router.use("/api/cg", CGApi);
router.use("/api/material", Material);
router.use("/api/report", Report);
// e - tender;
router.use("/api/etender", ETender);
// Coupa
router.use("/api/coupa", Coupa);
// AI document validation (external AWS service)
router.use("/api/ai-validation", AiValidation);
// Open API
router.use("/api/v1", openAPI);

module.exports = router;
