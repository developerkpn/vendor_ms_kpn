const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildMaterialStagingPayload,
} = require("../services/materialSapStagingService");

test("buildMaterialStagingPayload maps moving average price from request fields", () => {
  const payload = buildMaterialStagingPayload({
    snapshot: {
      request_no: "REQ-001",
      ticket_type: "Create",
      final_code: "901.001.001",
      plant_code: "EU73",
      sloc_code: "ST01",
      material_description: "TEST MATERIAL",
      base_uom: "PC",
      material_group_code: "901",
      template_payload: {
        requestFields: {
          moving_avg_price: "12345.67",
        },
      },
    },
    approvedBy: "mdm@example.com",
    now: new Date("2026-07-07T00:00:00.000Z"),
  });

  assert.equal(payload.MOVING_AVG_PRICE, "12345.67");
});
