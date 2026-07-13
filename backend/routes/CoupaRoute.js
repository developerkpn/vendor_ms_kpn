const express = require("express");
const route = express.Router();
const controller = require("../controllers/CoupaController");

route.post("/vendor/list", controller.getData);
route.post("/vendor/detail", controller.getDetail);
route.post("/vendor/submit", controller.submitVendorCoupa);
route.post("/vendor/update", controller.updateVendor);
route.post("/vendor/emailCfo", controller.sendEmail);
route.get("/vendor/history", controller.getSubmitted);
route.post("/vendor/history/detail", controller.detailVendor);

module.exports = route;
