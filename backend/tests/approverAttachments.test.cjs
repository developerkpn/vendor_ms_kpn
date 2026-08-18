const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The service only reads an upload out of the directory the multipart parser
// writes to, so a fixture path has to live there too — a bare "/tmp/x" is
// rejected as a body-supplied path, which is the point of the guard.
const uploadPath = name => path.join(os.tmpdir(), name);
const materialService = require("../services/materialService");
const MaterialController = require("../controllers/MaterialController");
const db = require("../config/connection");
const {
  resolveAttachmentChangeSet,
  assertUploadsCameFromThisRequest,
  buildAttachmentRemovalNote,
  normalizeAttachmentInstructions,
} = materialService;

// ---------------------------------------------------------------------------
// assertUploadsCameFromThisRequest — the gate between "a file this request
// uploaded" and "a path somebody typed into a JSON body". Everything below the
// upload directory is a real upload; anything else is refused before it can be
// read and copied into the public attachment directory.
// ---------------------------------------------------------------------------

test("assertUploadsCameFromThisRequest accepts a path inside the upload directory", () => {
  assert.doesNotThrow(() =>
    assertUploadsCameFromThisRequest([{ tempPath: uploadPath("upload-1") }])
  );
});

test("assertUploadsCameFromThisRequest rejects an absolute path outside the upload directory", () => {
  for (const outside of [
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    // A secrets file sitting next to a checkout — the realistic target, and
    // the reason this guard exists. Anchored to the home directory rather
    // than process.cwd() so it stays outside the upload root even when the
    // checkout itself lives under the temp directory.
    path.join(os.homedir(), "development.env"),
  ]) {
    assert.throws(
      () => assertUploadsCameFromThisRequest([{ tempPath: outside }]),
      error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "ATTACHMENT_INVALID_UPLOAD");
        return true;
      }
    );
  }
});

test("assertUploadsCameFromThisRequest rejects a traversal that climbs out of the upload directory", () => {
  assert.throws(
    () =>
      assertUploadsCameFromThisRequest([
        { tempPath: uploadPath("../../../etc/passwd") },
      ]),
    error => {
      assert.equal(error.code, "ATTACHMENT_INVALID_UPLOAD");
      return true;
    }
  );
});

test("assertUploadsCameFromThisRequest rejects a missing or non-string tempPath", () => {
  for (const bad of [{}, { tempPath: "" }, { tempPath: 42 }, { tempPath: null }]) {
    assert.throws(() => assertUploadsCameFromThisRequest([bad]), {
      code: "ATTACHMENT_INVALID_UPLOAD",
    });
  }
});

test("assertUploadsCameFromThisRequest ignores an empty or absent list", () => {
  assert.doesNotThrow(() => assertUploadsCameFromThisRequest([]));
  assert.doesNotThrow(() => assertUploadsCameFromThisRequest(undefined));
  assert.doesNotThrow(() => assertUploadsCameFromThisRequest(null));
});

// ---------------------------------------------------------------------------
// fs stub helper — every test below that inserts a new attachment writes a
// physical file (persistSingleRequestAttachmentFiles /
// persistMassRequestAttachmentFiles); every test that removes one deletes it
// (deleteSingleRequestStoredFiles). None of that should touch real disk.
// ---------------------------------------------------------------------------

const withStubbedFs = fn => async () => {
  const original = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    unlinkSync: fs.unlinkSync,
  };

  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.readFileSync = () => Buffer.from("stub");
  fs.writeFileSync = () => {};
  fs.unlinkSync = () => {};

  try {
    await fn();
  } finally {
    Object.assign(fs, original);
  }
};

// ---------------------------------------------------------------------------
// resolveAttachmentChangeSet — pure function, no DB. Mirrors the resubmit
// path's existing keep/remove/add resolution + count-limit rule, shared by
// every reviewer action that also carries attachment changes.
// ---------------------------------------------------------------------------

const existing = [
  { id: 1, file_name: "a.pdf", file_path: "attachments/single-request/2026-08-14/1/a.pdf" },
  { id: 2, file_name: "b.png", file_path: "attachments/single-request/2026-08-14/1/b.png" },
  { id: 3, file_name: "c.docx", file_path: "attachments/single-request/2026-08-14/1/c.docx" },
];

test("resolveAttachmentChangeSet with no keepAttachmentIds keeps everything and removes nothing", () => {
  const result = resolveAttachmentChangeSet({
    existingAttachments: existing,
    attachmentInstructions: { newAttachments: [] },
    maxAttachments: 3,
    limitErrorCode: "LIMIT",
  });

  assert.deepEqual(result.keptAttachments, existing);
  assert.deepEqual(result.removedAttachments, []);
  assert.deepEqual(result.newAttachments, []);
});

test("resolveAttachmentChangeSet removes ids left out of keepAttachmentIds", () => {
  const result = resolveAttachmentChangeSet({
    existingAttachments: existing,
    attachmentInstructions: { keepAttachmentIds: [1, 3] },
    maxAttachments: 3,
    limitErrorCode: "LIMIT",
  });

  assert.deepEqual(result.removedAttachments.map(a => a.id), [2]);
  assert.deepEqual(result.keptAttachments.map(a => a.id), [1, 3]);
});

test("resolveAttachmentChangeSet composes a kept removal with a new addition", () => {
  const result = resolveAttachmentChangeSet({
    existingAttachments: existing,
    attachmentInstructions: {
      keepAttachmentIds: [1, 2],
      newAttachments: [{ new_name: "d.jpg", file_name: "d.jpg" }],
    },
    maxAttachments: 3,
    limitErrorCode: "LIMIT",
  });

  assert.deepEqual(result.removedAttachments.map(a => a.id), [3]);
  assert.equal(result.keptAttachments.length, 2);
  assert.equal(result.newAttachments.length, 1);
});

test("resolveAttachmentChangeSet rejects an addition that would exceed the maximum, counting existing files", () => {
  assert.throws(
    () =>
      resolveAttachmentChangeSet({
        existingAttachments: existing,
        attachmentInstructions: {
          newAttachments: [{ new_name: "d.jpg", file_name: "d.jpg" }],
        },
        maxAttachments: 3,
        limitErrorCode: "SINGLE_REQUEST_ATTACHMENT_LIMIT_EXCEEDED",
      }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "SINGLE_REQUEST_ATTACHMENT_LIMIT_EXCEEDED");
      return true;
    }
  );
});

test("resolveAttachmentChangeSet accepts removing then adding within the limit", () => {
  const result = resolveAttachmentChangeSet({
    existingAttachments: existing,
    attachmentInstructions: {
      keepAttachmentIds: [1],
      newAttachments: [
        { new_name: "d.jpg", file_name: "d.jpg" },
        { new_name: "e.jpg", file_name: "e.jpg" },
      ],
    },
    maxAttachments: 3,
    limitErrorCode: "LIMIT",
  });

  assert.equal(result.removedAttachments.length, 2);
  assert.equal(result.keptAttachments.length, 1);
  assert.equal(result.newAttachments.length, 2);
});

test("resolveAttachmentChangeSet treats string and numeric ids as equivalent", () => {
  const result = resolveAttachmentChangeSet({
    existingAttachments: existing,
    attachmentInstructions: { keepAttachmentIds: ["1", "2", "3"] },
    maxAttachments: 3,
    limitErrorCode: "LIMIT",
  });

  assert.deepEqual(result.removedAttachments, []);
});

// ---------------------------------------------------------------------------
// buildAttachmentRemovalNote / normalizeAttachmentInstructions
// ---------------------------------------------------------------------------

test("buildAttachmentRemovalNote names a single removed file", () => {
  assert.equal(
    buildAttachmentRemovalNote([{ file_name: "a.pdf" }]),
    "Removed attachment: a.pdf"
  );
});

test("buildAttachmentRemovalNote names several removed files, pluralized", () => {
  assert.equal(
    buildAttachmentRemovalNote([{ file_name: "a.pdf" }, { file_name: "b.png" }]),
    "Removed attachments: a.pdf, b.png"
  );
});

test("buildAttachmentRemovalNote returns null when nothing was removed", () => {
  assert.equal(buildAttachmentRemovalNote([]), null);
  assert.equal(buildAttachmentRemovalNote(undefined), null);
});

test("normalizeAttachmentInstructions wraps a bare array as newAttachments", () => {
  const files = [{ new_name: "a.pdf" }];
  assert.deepEqual(normalizeAttachmentInstructions(files), {
    newAttachments: files,
  });
});

test("normalizeAttachmentInstructions passes an instruction object through unchanged", () => {
  const instructions = { keepAttachmentIds: [1], newAttachments: [] };
  assert.equal(normalizeAttachmentInstructions(instructions), instructions);
});

test("normalizeAttachmentInstructions returns null for null/undefined", () => {
  assert.equal(normalizeAttachmentInstructions(null), null);
  assert.equal(normalizeAttachmentInstructions(undefined), null);
});

// ---------------------------------------------------------------------------
// approveSingleRequestByAdmin — approve path, backend test pattern: db client
// stubbed, matching on SQL text. A 2-level MANUAL chain keeps the active step
// at level 1 (approved) with level 2 still WAITING, so the batch stays
// "Submit" and never triggers the terminal SAP-staging push — out of scope
// here.
// ---------------------------------------------------------------------------

const SINGLE_APPROVE_SNAPSHOT_ROW = {
  request_id: 501,
  request_no: "1000000501",
  assigned_to: "Approval 1",
  created_by: "REQ-01",
  created_at: new Date("2026-08-01T00:00:00.000Z"),
  status: "Submit",
  sap_push_status: null,
  sap_error_msg: null,
  ticket_type: "Create",
  material_code: null,
  final_code: null,
  change_extend_reason: null,
  material_group_code: "901",
  material_sub_group_code: "031",
  requester_user_id: "REQ-01",
  rework_stage: null,
  rework_by_user_id: null,
  rework_at: null,
  rework_reason: null,
  material_group_id: 12,
  material_sub_group_id: 110,
  plant_code: "P1",
  sloc_code: "S1",
  material_description: "Desc",
  base_uom: "EA",
  long_text_1: null,
  long_text_2: null,
  long_text_3: null,
  template_payload: { requestFields: {}, templateValues: {} },
};

const SINGLE_APPROVE_TWO_LEVEL_STEPS = () => [
  {
    id: 9001,
    request_id: 501,
    level: 1,
    kind: "MANUAL",
    approver_user_id: "APP-01",
    approver_name: "Approver One",
    status: "WAITING",
    acted_at: null,
    remark: null,
  },
  {
    id: 9002,
    request_id: 501,
    level: 2,
    kind: "MANUAL",
    approver_user_id: "APP-02",
    approver_name: "Approver Two",
    status: "WAITING",
    acted_at: null,
    remark: null,
  },
];

// Builds a stubbed db.connect for a single-request approve call. `recorders`
// collects the queries the test cares about; `existingAttachments` seeds what
// getSingleRequestAttachments reads back.
const buildSingleApproveStubConnect =
  ({ existingAttachments = [], recorders = {} }) =>
  async () => ({
    query: async (queryText, params = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return { rows: [SINGLE_APPROVE_SNAPSHOT_ROW], rowCount: 1 };
      }

      if (/FOR UPDATE OF s/.test(queryText)) {
        const rows = SINGLE_APPROVE_TWO_LEVEL_STEPS();
        return { rows, rowCount: rows.length };
      }

      const trimmed = queryText.trimStart();

      if (
        trimmed.startsWith("SELECT") &&
        queryText.includes("mat_single_request_attachment")
      ) {
        return { rows: existingAttachments, rowCount: existingAttachments.length };
      }

      if (
        trimmed.startsWith("DELETE") &&
        queryText.includes("mat_single_request_attachment")
      ) {
        recorders.deleteCalls = (recorders.deleteCalls || 0) + 1;
        recorders.deletedIds = params[1];
        return { rows: [], rowCount: Array.isArray(params[1]) ? params[1].length : 0 };
      }

      if (trimmed.startsWith("INSERT INTO mat_single_request_attachment")) {
        recorders.insertCalls = (recorders.insertCalls || 0) + 1;
        recorders.insertedParams = recorders.insertedParams || [];
        recorders.insertedParams.push(params);
        return { rows: [], rowCount: 1 };
      }

      if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      if (/UPDATE mat_single_request\b/.test(queryText)) {
        recorders.headerUpdateParams = params;
        return { rows: [], rowCount: 1 };
      }

      if (/mat_request_comment/.test(queryText)) {
        // Also matches the SAVEPOINT/RELEASE SAVEPOINT queries
        // insertRequestComment wraps itself in — only the actual INSERT
        // carries the comment text worth recording.
        if (trimmed.startsWith("INSERT INTO mat_request_comment")) {
          recorders.commentParams = params;
        }
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

test(
  "approveSingleRequestByAdmin with no attachment changes behaves exactly as before",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    db.connect = buildSingleApproveStubConnect({ recorders });

    try {
      const result = await materialService.approveSingleRequestByAdmin({
        requestId: 501,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        remark: "looks good",
      });

      assert.equal(result.status, "Submit");
      assert.equal(recorders.deleteCalls, undefined);
      assert.equal(recorders.insertCalls, undefined);
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "approveSingleRequestByAdmin with an addition inserts one row and leaves existing rows alone",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    const existingAttachments = [
      { id: 1, file_name: "existing.pdf", file_path: "attachments/single-request/2026-08-01/1000000501/existing.pdf", file_type: "application/pdf" },
    ];
    db.connect = buildSingleApproveStubConnect({ existingAttachments, recorders });

    try {
      const result = await materialService.approveSingleRequestByAdmin({
        requestId: 501,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        remark: "adding a drawing",
        attachments: {
          newAttachments: [
            {
              tempPath: uploadPath("upload-1"),
              originalName: "drawing.pdf",
              newName: "1_drawing.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      });

      assert.equal(result.status, "Submit");
      assert.equal(recorders.deleteCalls, undefined);
      assert.equal(recorders.insertCalls, 1);
      assert.equal(recorders.insertedParams[0][1], "drawing.pdf");
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "approveSingleRequestByAdmin with a removal deletes only the named row",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    const existingAttachments = [
      { id: 1, file_name: "keep-one.pdf", file_path: "path/1", file_type: "application/pdf" },
      { id: 2, file_name: "remove-me.pdf", file_path: "path/2", file_type: "application/pdf" },
      { id: 3, file_name: "keep-three.pdf", file_path: "path/3", file_type: "application/pdf" },
    ];
    db.connect = buildSingleApproveStubConnect({ existingAttachments, recorders });

    try {
      const result = await materialService.approveSingleRequestByAdmin({
        requestId: 501,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        remark: "wrong file",
        attachments: { keepAttachmentIds: [1, 3] },
      });

      assert.equal(result.status, "Submit");
      assert.deepEqual(recorders.deletedIds, [2]);
      assert.equal(recorders.insertCalls, undefined);
      // The removal is recorded in the comment history alongside the remark.
      assert.match(recorders.commentParams[5] || "", /remove-me\.pdf/);
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "approveSingleRequestByAdmin composes a removal and an addition into the expected final set",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    const existingAttachments = [
      { id: 1, file_name: "keep.pdf", file_path: "path/1", file_type: "application/pdf" },
      { id: 2, file_name: "swap-out.pdf", file_path: "path/2", file_type: "application/pdf" },
    ];
    db.connect = buildSingleApproveStubConnect({ existingAttachments, recorders });

    try {
      await materialService.approveSingleRequestByAdmin({
        requestId: 501,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        remark: null,
        attachments: {
          keepAttachmentIds: [1],
          newAttachments: [
            {
              tempPath: uploadPath("upload-2"),
              originalName: "swap-in.pdf",
              newName: "2_swap-in.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      });

      assert.deepEqual(recorders.deletedIds, [2]);
      assert.equal(recorders.insertCalls, 1);
      assert.equal(recorders.insertedParams[0][1], "swap-in.pdf");
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "approveSingleRequestByAdmin rolls back a limit-exceeding addition, leaving no inserted rows",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    // Already at the maximum of 3 — adding one more without removing any
    // exceeds the limit against the resulting set.
    const existingAttachments = [
      { id: 1, file_name: "a.pdf", file_path: "path/1", file_type: "application/pdf" },
      { id: 2, file_name: "b.pdf", file_path: "path/2", file_type: "application/pdf" },
      { id: 3, file_name: "c.pdf", file_path: "path/3", file_type: "application/pdf" },
    ];
    db.connect = buildSingleApproveStubConnect({ existingAttachments, recorders });

    try {
      await assert.rejects(
        materialService.approveSingleRequestByAdmin({
          requestId: 501,
          actorUserId: "APP-01",
          actorUsername: "approver.one",
          remark: "too many",
          attachments: {
            newAttachments: [
              {
                tempPath: uploadPath("upload-3"),
                originalName: "d.pdf",
                newName: "3_d.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        }),
        error => {
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, "SINGLE_REQUEST_ATTACHMENT_LIMIT_EXCEEDED");
          return true;
        }
      );

      assert.equal(recorders.deleteCalls, undefined);
      assert.equal(recorders.insertCalls, undefined);
      assert.equal(recorders.headerUpdateParams, undefined);
      assert.equal(recorders.commentParams, undefined);
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "approveSingleRequestByAdmin forbids a reviewer who cannot act on the active step from changing attachments",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const recorders = {};
    const existingAttachments = [
      { id: 1, file_name: "a.pdf", file_path: "path/1", file_type: "application/pdf" },
    ];
    db.connect = buildSingleApproveStubConnect({ existingAttachments, recorders });

    try {
      await assert.rejects(
        materialService.approveSingleRequestByAdmin({
          requestId: 501,
          actorUserId: "SOMEONE-ELSE",
          actorUsername: "not.the.approver",
          remark: "trying anyway",
          attachments: { keepAttachmentIds: [] },
        }),
        error => {
          assert.equal(error.statusCode, 403);
          assert.equal(error.code, "SINGLE_REQUEST_APPROVAL_FORBIDDEN");
          return true;
        }
      );

      // Rejected before the attachment block is ever reached.
      assert.equal(recorders.deleteCalls, undefined);
      assert.equal(recorders.insertCalls, undefined);
    } finally {
      db.connect = originalConnect;
    }
  })
);

test(
  "rejectSingleRequestByAdmin leaves attachments untouched even with pending changes",
  async () => {
    const originalConnect = db.connect;
    const recorders = {};

    db.connect = async () => ({
      query: async (queryText, params = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
          return { rows: [], rowCount: null };
        }

        if (/FOR UPDATE OF r/.test(queryText)) {
          return { rows: [SINGLE_APPROVE_SNAPSHOT_ROW], rowCount: 1 };
        }

        if (/FOR UPDATE OF s/.test(queryText)) {
          const rows = SINGLE_APPROVE_TWO_LEVEL_STEPS();
          return { rows, rowCount: rows.length };
        }

        // rejectSingleRequestByAdmin takes no `attachments` param, so a
        // client sending one anyway must never reach an attachment query —
        // any attempt here fails the test via "Unexpected query" below.
        if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
          return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_single_request\b/.test(queryText)) {
          return { rows: [], rowCount: 1 };
        }

        if (/mat_request_comment/.test(queryText)) {
          recorders.commentParams = params;
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unexpected query: ${queryText}`);
      },
      release: () => {},
    });

    try {
      const result = await materialService.rejectSingleRequestByAdmin({
        requestId: 501,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        reason: "not needed",
        // A client sending this anyway (e.g. a stale dialog state) must be
        // silently ignored — the service signature has no such param.
        attachments: { keepAttachmentIds: [], newAttachments: [{ new_name: "x.pdf" }] },
      });

      assert.equal(result.request_id, 501);
    } finally {
      db.connect = originalConnect;
    }
  }
);

test("reject controller never forwards attachment changes to the service", async () => {
  const originalReject = materialService.rejectSingleRequestByAdmin;
  let receivedPayload = null;

  materialService.rejectSingleRequestByAdmin = async payload => {
    receivedPayload = payload;
    return { request_id: 501, stage: "Approval 1", status: "REJECTED" };
  };

  const req = {
    params: { id: "501" },
    cookies: { user_id: "APP-01", username: "approver.one" },
    body: {
      reason: "bad request",
      // A stale/rogue client sending this must never reach the service.
      attachments: { keepAttachmentIds: [] },
    },
  };
  const res = {
    statusCode: null,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
  };

  try {
    await MaterialController.rejectSingleRequest(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(receivedPayload);
    assert.equal(
      Object.prototype.hasOwnProperty.call(receivedPayload, "attachments"),
      false
    );
  } finally {
    materialService.rejectSingleRequestByAdmin = originalReject;
  }
});

// ---------------------------------------------------------------------------
// approveMassRequest — per-item attachment changes, each item resolved
// independently of the others.
// ---------------------------------------------------------------------------

const MASS_APPROVE_LOCK_ROW = { id: 601, status: "Submit" };

const MASS_APPROVE_STEPS = () => [
  {
    id: 8001,
    item_id: 601,
    level: 1,
    kind: "MANUAL",
    approver_user_id: "APP-01",
    approver_name: "Approver One",
    status: "WAITING",
    acted_at: null,
    remark: null,
  },
  {
    id: 8002,
    item_id: 601,
    level: 2,
    kind: "MANUAL",
    approver_user_id: "APP-02",
    approver_name: "Approver Two",
    status: "WAITING",
    acted_at: null,
    remark: null,
  },
];

test(
  "approveMassRequest applies independent attachment changes to each item",
  withStubbedFs(async () => {
    const originalConnect = db.connect;
    const deletesByItem = {};
    const insertsByItem = {};
    const deleteScopedToBatch = [];

    const existingByItem = {
      601: [
        { id: 11, file_name: "item601-old.pdf", file_path: "path/11", file_type: "application/pdf" },
      ],
      602: [
        { id: 21, file_name: "item602-a.pdf", file_path: "path/21", file_type: "application/pdf" },
      ],
    };
    const requestNoByItem = { 601: "3000000601", 602: "3000000602" };

    db.connect = async () => ({
      query: async (queryText, params = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
          return { rows: [], rowCount: null };
        }

        if (/FOR UPDATE OF i/.test(queryText)) {
          return { rows: [MASS_APPROVE_LOCK_ROW], rowCount: 1 };
        }

        if (/FOR UPDATE OF s/.test(queryText)) {
          const rows = MASS_APPROVE_STEPS();
          return { rows, rowCount: rows.length };
        }

        const trimmed = queryText.trimStart();

        if (
          trimmed.startsWith("SELECT") &&
          queryText.includes("mat_mass_request_attachment")
        ) {
          const itemId = params[0];
          return {
            rows: existingByItem[itemId] || [],
            rowCount: (existingByItem[itemId] || []).length,
          };
        }

        if (
          trimmed.startsWith("SELECT request_no") &&
          queryText.includes("mat_mass_request_item")
        ) {
          const itemId = params[0];
          return { rows: [{ request_no: requestNoByItem[itemId] }], rowCount: 1 };
        }

        // DELETE ... USING mat_mass_request_item: ($1 item, $2 batch, $3 ids).
        // The batch is in the statement so an id from another batch cannot be
        // deleted; the ids are therefore the THIRD parameter, not the second.
        if (
          trimmed.startsWith("DELETE") &&
          queryText.includes("mat_mass_request_attachment")
        ) {
          const itemId = params[0];
          deletesByItem[itemId] = params[2];
          deleteScopedToBatch.push(params[1]);
          return { rows: [], rowCount: Array.isArray(params[2]) ? params[2].length : 0 };
        }

        if (trimmed.startsWith("INSERT INTO mat_mass_request_attachment")) {
          const itemId = params[0];
          insertsByItem[itemId] = insertsByItem[itemId] || [];
          insertsByItem[itemId].push(params);
          return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_mass_request_item_approval_step/.test(queryText)) {
          return { rows: [], rowCount: 1 };
        }

        if (/UPDATE mat_mass_request_item\s+SET status = \$2/.test(queryText)) {
          return { rows: [{ id: 601 }, { id: 602 }], rowCount: 2 };
        }

        if (/mat_request_comment/.test(queryText)) {
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unexpected query: ${queryText}`);
      },
      release: () => {},
    });

    try {
      const result = await materialService.approveMassRequest({
        massRequestId: 900,
        actorUserId: "APP-01",
        actorUsername: "approver.one",
        remark: "batch ok",
        items: [
          {
            id: 601,
            attachments: {
              keepAttachmentIds: [],
              newAttachments: [
                { tempPath: uploadPath("601"), originalName: "item601-new.pdf", newName: "n1.pdf", mimeType: "application/pdf" },
              ],
            },
          },
          {
            id: 602,
            attachments: {
              keepAttachmentIds: [21],
              newAttachments: [
                { tempPath: uploadPath("602a"), originalName: "item602-b.pdf", newName: "n2.pdf", mimeType: "application/pdf" },
                { tempPath: uploadPath("602b"), originalName: "item602-c.pdf", newName: "n3.pdf", mimeType: "application/pdf" },
              ],
            },
          },
        ],
      });

      assert.equal(result.status, "Submit");

      // Every removal names the batch as well as the item, so an attachment
      // id belonging to a different batch cannot be deleted through this path.
      assert.ok(deleteScopedToBatch.length > 0);
      assert.ok(deleteScopedToBatch.every(id => String(id) === "900"));

      // Item 601: removed its one existing row, added one — its own limit
      // (3) never sees item 602's files.
      assert.deepEqual(deletesByItem[601], [11]);
      assert.equal(insertsByItem[601].length, 1);
      assert.equal(insertsByItem[601][0][1], "item601-new.pdf");

      // Item 602: kept its existing row, added two more — independent of
      // item 601's removal.
      assert.equal(deletesByItem[602], undefined);
      assert.equal(insertsByItem[602].length, 2);
    } finally {
      db.connect = originalConnect;
    }
  })
);

// ---------------------------------------------------------------------------
// applyMassRequestItemAttachmentChanges — batch ownership.
//
// Item ids arrive in a request body and item ids are global, so only a row in
// mat_mass_request_item says which batch owns one. These cover the case where
// a reviewer acting on batch A names an item belonging to batch B.
// ---------------------------------------------------------------------------

const { applyMassRequestItemAttachmentChanges } = materialService;

test(
  "applyMassRequestItemAttachmentChanges refuses an item that belongs to another batch",
  withStubbedFs(async () => {
    const queries = [];
    const client = {
      query: async (queryText, params = []) => {
        queries.push(queryText.trimStart());
        // No row: the item exists, but not inside this batch.
        if (queryText.includes("SELECT request_no")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected query: ${queryText}`);
      },
    };

    await assert.rejects(
      () =>
        applyMassRequestItemAttachmentChanges(client, {
          massRequestId: 900,
          items: [{ id: 4242, attachments: { keepAttachmentIds: [] } }],
        }),
      error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "MASS_REQUEST_ITEM_NOT_IN_BATCH");
        return true;
      }
    );

    // Ownership is settled before anything is read or written: the only
    // statement issued is the ownership check itself.
    assert.equal(queries.length, 1);
    assert.ok(queries[0].startsWith("SELECT request_no"));
  })
);

test(
  "applyMassRequestItemAttachmentChanges scopes the existing-attachment read to the batch",
  withStubbedFs(async () => {
    const selectParams = [];
    const client = {
      query: async (queryText, params = []) => {
        const trimmed = queryText.trimStart();
        if (queryText.includes("SELECT request_no")) {
          return { rows: [{ request_no: "1000000601" }], rowCount: 1 };
        }
        if (
          trimmed.startsWith("SELECT") &&
          queryText.includes("mat_mass_request_attachment")
        ) {
          selectParams.push(params);
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected query: ${queryText}`);
      },
    };

    await applyMassRequestItemAttachmentChanges(client, {
      massRequestId: 900,
      items: [{ id: 601, attachments: { keepAttachmentIds: [] } }],
    });

    assert.deepEqual(selectParams, [[601, 900]]);
  })
);

test(
  "applyMassRequestItemAttachmentChanges refuses a body-supplied file path before touching the database",
  withStubbedFs(async () => {
    let queried = false;
    const client = {
      query: async () => {
        queried = true;
        return { rows: [], rowCount: 0 };
      },
    };

    await assert.rejects(
      () =>
        applyMassRequestItemAttachmentChanges(client, {
          massRequestId: 900,
          items: [
            {
              id: 601,
              attachments: {
                newAttachments: [
                  { tempPath: "/etc/passwd", newName: "x.pdf" },
                ],
              },
            },
          ],
        }),
      { code: "ATTACHMENT_INVALID_UPLOAD" }
    );

    assert.equal(queried, false);
  })
);
