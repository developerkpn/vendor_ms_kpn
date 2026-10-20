const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("pg");

// Opt in with a disposable/local PostgreSQL connection. All data stays in
// temporary tables inside a transaction; application tables are never read.
test("AI matching resolves selected classifications consistently before and after saving", {
  skip: !process.env.MATERIAL_AI_MATCH_TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.MATERIAL_AI_MATCH_TEST_DATABASE_URL });
  const pool = require("../config/connection");
  const service = require("../services/materialAiMatchService");
  const originalConnect = pool.connect;
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_temp, pg_catalog");
    await client.query("SET LOCAL statement_timeout = 10000");
    pool.connect = async () => ({ query: (...args) => client.query(...args), release() {} });
    await client.query(`
      CREATE TEMP TABLE mat_item_group (id integer, code text, name text, deleted_at timestamptz);
      CREATE TEMP TABLE mat_item_sub_group (id integer, code text, name text, item_group_id integer, deleted_at timestamptz);
      CREATE TEMP TABLE mat_single_request (
        id bigint, ticket_type text, material_code text, material_description text,
        long_text_1 text, long_text_2 text, long_text_3 text, material_group_id integer,
        material_sub_group_id integer, request_no text, status text, final_code text, created_at timestamptz,
        created_by text
      );
      CREATE TEMP TABLE mat_mass_request (id bigint, mass_request_no text, created_by text);
      CREATE TEMP TABLE mst_user (user_id text, username text, fullname text, email text, is_active boolean, user_group text);
      CREATE TEMP TABLE mst_mgr (mgr_id text, username text, fullname text, email text, is_active boolean, user_group text);
      INSERT INTO mst_user VALUES ('user-a', 'alice', 'Alice', 'private@example.test', true, 'REQUESTER');
      INSERT INTO mst_mgr VALUES ('user-b', 'bob', 'Bob Manager', 'private-manager@example.test', true, 'REQUESTER');
      CREATE TEMP TABLE mat_mass_request_item (
        id bigint, mass_request_id bigint, item_no smallint, material_description text,
        po_text text, spesifikasi_tambahan text, material_group text, material_sub_group text,
        request_no text, ticket_type text, status text, final_code text, created_at timestamptz
      );
      CREATE TEMP TABLE mat_sap_data (code text);
      INSERT INTO mat_item_group VALUES (1, '910', 'PUMPS', NULL), (2, '911', 'VALVES', NULL);
      INSERT INTO mat_item_sub_group VALUES
        (42, '016', 'LIFT', 1, NULL), (43, '016', 'FLOW', 2, NULL), (44, '017', 'DOSING', 1, NULL);
      INSERT INTO mat_single_request VALUES
        (101, 'Create', '', 'PUMP', 'HEAVY DUTY', NULL, NULL, 1, 42, 'REQ101', 'Submit', NULL, NOW(), 'user-a'),
        (102, 'Create', '', 'VALVE', NULL, NULL, NULL, 2, 42, 'REQ102', 'Rejected', NULL, NOW(), 'user-b'),
        (103, 'Create', '', 'OLDER PUMP', 'FULL DESCRIPTION', NULL, NULL, 1, 42, 'REQ103', 'DONE', '910.016.OLD', NOW() - interval '1 year', 'user-b'),
        (104, 'Create', '', 'CANCELLED PUMP', NULL, NULL, NULL, 1, 42, 'REQ104', 'CANCEL', NULL, NOW(), 'user-a'),
        (105, 'Change', '', 'CHANGED PUMP', NULL, NULL, NULL, 1, 42, 'REQ105', 'Submit', NULL, NOW(), 'user-a');
      INSERT INTO mat_sap_data VALUES ('910.016.OLD');
      INSERT INTO mat_mass_request VALUES (7, 'MASS7', 'user-b');
      INSERT INTO mat_mass_request_item VALUES
        (201, 7, 1, 'PUMP', '50HZ', NULL, ' PUMPS ', '016 - LIFT', 'REQ201', 'Create', 'Submit', NULL, NOW()),
        (202, 7, 2, 'PUMP', NULL, NULL, '910 - PUMPS', 'DOSING', 'REQ202', 'Create', 'Submit', NULL, NOW()),
        (203, 7, 3, 'VALVE', NULL, NULL, '911', 'LIFT', 'REQ203', 'Create', 'Submit', NULL, NOW()),
        (204, 7, 4, 'UNKNOWN', NULL, NULL, 'UNKNOWN', '016', 'REQ204', 'Create', 'Submit', NULL, NOW());
    `);

    const single = service.buildSingleRequestQuery(await service.loadSingleRequestRow(101));
    assert.deepEqual(single, { code: "", groupCode: "910", subgroupCode: "016", name: "PUMP", desc: "HEAVY DUTY" });
    const wrongSubgroup = service.buildSingleRequestQuery(await service.loadSingleRequestRow(102));
    assert.equal(wrongSubgroup.groupCode, "911");
    assert.equal(wrongSubgroup.subgroupCode, "");

    const saved = await service.loadMassRequestItems(7);
    const savedCodes = saved.map(service.buildMassItemQuery).map(query => [query.groupCode, query.subgroupCode]);
    assert.deepEqual(savedCodes, [["910", "016"], ["910", "017"], ["911", ""], ["", ""]]);
    const unsaved = await service.resolveMassClassifications([
      { material_group: " PUMPS ", material_sub_group: "016 - LIFT" },
      { material_group: "910 - PUMPS", material_sub_group: "DOSING" },
      { material_group: "911", material_sub_group: "LIFT" },
      { material_group: "UNKNOWN", material_sub_group: "016" },
    ]);
    assert.deepEqual(unsaved.map(service.buildMassItemQuery).map(query => [query.groupCode, query.subgroupCode]), savedCodes);

    const candidates = await service.loadInFlightCandidates();
    assert.equal(candidates.length, 8);
    const first = candidates.find(candidate => candidate.ref === "REQ101");
    assert.equal(first.groupCode, "910");
    assert.equal(first.subgroupCode, "016");
    assert.equal(first.requesterId, "user-a");
    assert.equal(first.requestDetails.requesterName, "Alice");
    assert.equal(candidates.find(candidate => candidate.ref === "REQ102").requestDetails.requesterName, "Bob Manager");
    const completed = candidates.find(candidate => candidate.ref === "REQ103");
    assert.equal(completed.requestDetails.materialCode, "910.016.OLD");
    assert.equal(completed.requestDetails.status, "DONE");
    assert.ok(candidates.some(candidate => candidate.ref === "REQ104"));
    assert.ok(!candidates.some(candidate => candidate.ref === "REQ105"));
    assert.ok(!JSON.stringify(candidates).includes("private@example.test"));
    for (const [index, codes] of savedCodes.entries()) {
      const candidate = candidates.find(candidate => candidate.ref === `REQ${201 + index}`);
      assert.deepEqual([candidate.groupCode, candidate.subgroupCode], codes);
      assert.equal(candidate.requesterId, "user-b");
      assert.equal(candidate.requestDetails.batchNo, "MASS7");
    }
    await client.query(`INSERT INTO mat_single_request
      SELECT 1000 + value, 'Create', '', 'UNRELATED', NULL, NULL, NULL, 2, 43,
        'REQ' || (1000 + value), 'Submit', NULL, NOW(), 'user-a'
      FROM generate_series(1, 301) value`);
    const history = await service.loadInFlightCandidates();
    assert.equal(history.length, 309);
    assert.equal(history.at(-1).ref, "REQ103");
  } finally {
    pool.connect = originalConnect;
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
