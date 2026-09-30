const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MATERIAL_PEOPLE_SQL } = require("../constants/material");

// Managers live in mst_mgr, not mst_user, and may request and approve
// materials. Every Materials lookup of a person reads both tables.
const MATERIAL_SOURCES = [
  "../services/materialService.js",
  "../models/MaterialModel.js",
  "../services/materialSapStagingService.js",
];

test("MATERIAL_PEOPLE_SQL reads staff and managers, with mgr_id as user_id", () => {
  assert.match(MATERIAL_PEOPLE_SQL, /FROM mst_user\b/);
  assert.match(MATERIAL_PEOPLE_SQL, /SELECT mgr_id AS user_id,[\s\S]*FROM mst_mgr\b/);
  assert.match(MATERIAL_PEOPLE_SQL, /UNION ALL/);
  for (const column of ["username", "fullname", "email", "is_active", "user_group"]) {
    assert.equal(MATERIAL_PEOPLE_SQL.split(column).length - 1, 2, `${column} on both sides`);
  }
});

test("no Materials query joins mst_user alone", () => {
  for (const file of MATERIAL_SOURCES) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.doesNotMatch(source, /\b(FROM|JOIN)\s+mst_user\s+[a-z_]+\s+(ON|WHERE|JOIN|LEFT)\b/i, file);
    assert.doesNotMatch(source, /\b(FROM|JOIN)\s+mst_user\s*$/im, file);
  }
});
