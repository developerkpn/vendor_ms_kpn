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

// The four description columns are one positional partition of a single string,
// so PURCHASE_ORDER_TEXT must be the long-text columns concatenated verbatim:
// no separator (SAP rejects the newline, and any separator splits the word that
// straddles a column boundary) and no per-column trim (the boundary space is
// real text). MATERIAL_DESC + PURCHASE_ORDER_TEXT must reproduce the source.
test("buildMaterialStagingPayload concatenates long text without a separator", () => {
  const full =
    "HEXAGON SOCKET HEAD CAP SCREW M10X30 STAINLESS STEEL A2-70 DIN 912 " +
    "PACK OF 100 PCS SUPPLIER PART NO 4711-A GRADE 8.8 ZINC PLATED FINISH " +
    "FOR MAINTENANCE USE IN PLANT EU73 WAREHOUSE RACK B12 SHELF 3 BIN 07";

  const payload = buildMaterialStagingPayload({
    snapshot: {
      request_no: "REQ-002",
      ticket_type: "Create",
      final_code: "901.001.001",
      material_description: full.slice(0, 40),
      long_text_1: full.slice(40, 110),
      long_text_2: full.slice(110, 180),
      long_text_3: full.slice(180, 250),
      base_uom: "PC",
      template_payload: { requestFields: {} },
    },
  });

  assert.ok(!payload.PURCHASE_ORDER_TEXT.includes("\n"));
  assert.ok(payload.PURCHASE_ORDER_TEXT.includes("GRADE 8.8"));
  assert.ok(payload.PURCHASE_ORDER_TEXT.includes("WAREHOUSE RACK"));
  assert.equal(payload.MATERIAL_DESC + payload.PURCHASE_ORDER_TEXT, full);
  assert.ok(payload.PURCHASE_ORDER_TEXT.length <= 210);
});

// A newline already persisted in a column (legacy row) is neutralised too, 1:1
// so the 210-char width still holds.
test("buildMaterialStagingPayload collapses a newline already stored in a column", () => {
  const payload = buildMaterialStagingPayload({
    snapshot: {
      request_no: "REQ-003",
      ticket_type: "Create",
      final_code: "901.001.001",
      material_description: "TEST MATERIAL",
      long_text_1: "LINE ONE\nLINE TWO",
      long_text_2: null,
      long_text_3: null,
      base_uom: "PC",
      template_payload: { requestFields: {} },
    },
  });

  assert.equal(payload.PURCHASE_ORDER_TEXT, "LINE ONE LINE TWO");
});

test("buildMaterialStagingPayload sends NULL when every long-text column is blank", () => {
  const payload = buildMaterialStagingPayload({
    snapshot: {
      request_no: "REQ-004",
      ticket_type: "Create",
      final_code: "901.001.001",
      material_description: "TEST MATERIAL",
      long_text_1: null,
      long_text_2: "",
      long_text_3: "   ",
      base_uom: "PC",
      template_payload: { requestFields: {} },
    },
  });

  assert.equal(payload.PURCHASE_ORDER_TEXT, null);
});
