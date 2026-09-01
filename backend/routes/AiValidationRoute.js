const express = require("express");
const router = express.Router();
const controller = require("../controllers/AiValidationController");
const TokenManager = require("../middleware/tokenmanager");

// Unauthenticated on purpose: the caller is an AWS Lambda, not a VMS session.
// Authentication is the HMAC signature over the raw body plus a 5-minute
// timestamp window — see AiValidationController.webhook. The raw body itself
// is captured by express.raw() in server.js, which must run before the global
// express.json().
router.post("/webhook", controller.webhook);

// Read path for the form panel — internal roles only.
router.get("/vendor/:ven_id", TokenManager.authSession, controller.getByVendor);

module.exports = router;
