const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("pg");
const { loadMaterialAttachments } = require("../services/materialAttachmentService");

test("catalog attachment lookup links completed single and mass requests by final material code", {
  skip: !process.env.MATERIAL_ATTACHMENTS_TEST_DATABASE_URL,
}, async t => {
  const client = new Client({ connectionString: process.env.MATERIAL_ATTACHMENTS_TEST_DATABASE_URL });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_temp, pg_catalog");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query(`
      CREATE TEMP TABLE mat_sap_data (id integer, code text);
      CREATE TEMP TABLE mat_attachment (id integer, material_id integer, attachment text, type text);
      CREATE TEMP TABLE mat_single_request (id bigint, request_no text, ticket_type text, status text, final_code text, sap_push_status text);
      CREATE TEMP TABLE mat_single_request_attachment (id bigint, request_id bigint, file_name text, file_path text, file_type text);
      CREATE TEMP TABLE mat_mass_request_item (id bigint, mass_request_id bigint, status text, final_code text);
      CREATE TEMP TABLE mat_mass_request_attachment (id bigint, item_id bigint, file_name text, file_path text, file_type text);
      INSERT INTO mat_sap_data VALUES (932753, '977.302.006'), (932754, '977.302.007'), (932755, '977.302.008');
      INSERT INTO mat_single_request VALUES
        (160, '1000000160', 'Create', 'DONE', '977.302.006', 'SYNCED'),
        (161, '1000000161', 'Create', 'Submit', '977.302.006', 'PENDING'),
        (162, '1000000162', 'Create', 'REJECT', '977.302.006', NULL),
        (163, '1000000163', 'Create', 'Rework', '977.302.006', NULL),
        (164, '1000000164', 'Change', 'DONE', '977.302.006', 'SYNCED'),
        (165, '1000000165', 'Create', 'DONE', '977.302.008', 'SYNCED');
      INSERT INTO mat_single_request_attachment
        SELECT id, id, 'Specification.png', 'attachments/single-request/' || request_no || '/spec.png', 'image/png'
        FROM mat_single_request;
      INSERT INTO mat_mass_request_item VALUES
        (40, 20, 'DONE', '977.302.007'), (41, 20, 'Rework', '977.302.007'), (42, 20, 'DONE', '977.302.008');
      INSERT INTO mat_mass_request_attachment
        SELECT id, id, 'Specification.png', 'attachments/mass-request/item-' || id || '/spec.png', 'image/png'
        FROM mat_mass_request_item;
    `);

    await t.test("the reported ticket works for an already imported material with no catalog attachments", async () => {
      const files = await loadMaterialAttachments(client, [932753]);
      assert.equal(files.length, 1);
      assert.deepEqual(files[0], {
        material_id: 932753, id: "single-request:160", name: "Specification.png", type: "image/png", read_only: true,
        attachment: "attachments/single-request/1000000160/spec.png",
      });
    });
    await t.test("mass files belong to the matching completed item, including in a partially approved batch", async () => {
      const files = await loadMaterialAttachments(client, [932754]);
      assert.deepEqual(files.map(file => file.id), ["mass-request:40"]);
      assert.equal(files[0].attachment, "attachments/mass-request/item-40/spec.png");
      const all = await loadMaterialAttachments(client, [932753, 932754]);
      assert.deepEqual(new Set(all.map(file => file.material_id)), new Set([932753, 932754]));
      assert.equal(all.length, 2);
      assert.deepEqual(await loadMaterialAttachments(client, [999999]), []);
    });
    await t.test("existing uploads stay available and equal stored paths appear once", async () => {
      await client.query(`INSERT INTO mat_attachment VALUES
        (160, 932753, 'drawing.pdf', 'application/pdf'),
        (161, 932753, 'attachments/single-request/1000000160/spec.png', 'image/png')`);
      const files = await loadMaterialAttachments(client, [932753]);
      assert.deepEqual(files.map(file => file.id), ["single-request:160", 160]);
      assert.equal(files[0].read_only, true);
      assert.equal(files[1].attachment, "drawing.pdf");
      assert.deepEqual(await loadMaterialAttachments(client, [932753]), files);
      assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM mat_single_request_attachment")).rows[0].count, 6);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
