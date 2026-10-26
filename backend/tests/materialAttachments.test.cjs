const assert = require("node:assert/strict");
const test = require("node:test");
const pool = require("../config/connection");
const Material = require("../models/MaterialModel");
const { loadMaterialAttachments } = require("../services/materialAttachmentService");

const requestFile = {
  material_id: 932753,
  id: "single-request:160",
  attachment: "attachments/single-request/2026-10-19/1000000160/spec.png",
  name: "Specification.png",
  type: "image/png",
  read_only: true,
};
const directFile = { material_id: 932753, id: 160, attachment: "drawing.pdf", type: "application/pdf" };

async function withClient(client, run) {
  const original = pool.connect;
  pool.connect = async () => ({ ...client, release() {} });
  try { await run(); } finally { pool.connect = original; }
}

function attachmentClient({ direct = [directFile], requests = [requestFile] } = {}) {
  return { async query(sql) {
    if (/FROM mat_single_request|JOIN mat_single_request/.test(sql)) return { rows: requests };
    if (/FROM mat_attachment/.test(sql)) return { rows: direct };
    if (/WHERE m.code = ANY/.test(sql)) return { rows: [{ id: 932753, code: "977.302.006" }] };
    if (["BEGIN", "ROLLBACK", "COMMIT"].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
}

test("an empty material list needs no attachment lookup", async () => {
  assert.deepEqual(await loadMaterialAttachments({ query() { throw new Error("No query expected"); } }, []), []);
});

test("material search, batch lookup and attachment dialog expose the same request files", async () => {
  const client = attachmentClient();
  const { material_id, ...file } = requestFile;
  const { material_id: ignored, ...direct } = directFile;
  await withClient(client, async () => {
    assert.deepEqual(await Material.getAttachmentsByMaterialIds(client, [932753]), { 932753: [file, direct] });
    assert.deepEqual(await Material.getMaterialAttachments(932753), [requestFile, directFile]);
    assert.deepEqual(await Material.getAttachmentsByCodes(["977.302.006"]), [
      { id: 932753, code: "977.302.006", attachments: [file, direct] },
    ]);
  });
});

test("deduplicate stored paths, retain separate files with the same display name, and protect ticket originals", async () => {
  const result = await loadMaterialAttachments(attachmentClient({
    direct: [directFile, { ...directFile, id: 999, attachment: "/" + requestFile.attachment }],
    requests: [requestFile, { ...requestFile, id: "mass-request:160", attachment: "attachments/mass-request/another/spec.png" }],
  }), [932753]);
  assert.deepEqual(result.map(file => file.id), ["single-request:160", "mass-request:160", 160]);
  assert.equal(result[0].read_only, true);
});

test("request attachment IDs cannot delete a catalog file with the same numeric ID", async () => {
  await withClient({ query() { throw new Error("No database mutation expected"); } }, async () => {
    for (const id of ["single-request:160", "mass-request:160"]) {
      await assert.rejects(Material.deleteAttachment(id, "MDM"), { statusCode: 403 });
    }
  });
});

test("upload capacity counts inherited request attachments", async () => {
  const client = attachmentClient({ direct: [], requests: [1, 2, 3].map(id => ({
    ...requestFile, id: `single-request:${id}`, attachment: `attachments/single-request/spec-${id}.png`,
  })) });
  await withClient(client, async () => {
    await assert.rejects(Material.addAttachment(932753, [{ newName: "extra.pdf" }], "MDM"), /Maximum number of attachments \(3\) reached/);
  });
});
