const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pool = require("../config/connection");
const materialService = require("../services/materialService");
const requireMaterialAdmin = require("../middleware/requireMaterialAdmin");

const { resolveMaterialMenuAccess, applyMaterialMenuAccess } = materialService;
const { MATERIAL_APPROVER_ACCESS_QUERY } = materialService.__private;

const FULL = { create: true, read: true, update: true, delete: true };
const CLOSED = { create: false, read: false, update: false, delete: false };

function groupPermission() {
  return {
    Materials: { ...FULL },
    "My Approval": { ...FULL },
    Administrator: { ...FULL },
    "Request Material": { ...FULL },
  };
}

// Nothing here may reach the database: pool.query is replaced per test.
async function withPoolQuery(answer, fn) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };
  try {
    return await fn(calls);
  } finally {
    pool.query = original;
  }
}

const MDM_QUERY = /FROM mst_user mu[\s\S]*JOIN mst_page_access/;

test("applyMaterialMenuAccess closes Administrator for anyone but ADMIN", () => {
  const permission = applyMaterialMenuAccess(groupPermission(), { isAdmin: false, canApprove: true });
  assert.deepEqual(permission.Administrator, CLOSED);
  assert.deepEqual(permission["My Approval"], FULL);
  assert.deepEqual(permission["Request Material"], FULL);
});

test("applyMaterialMenuAccess closes My Approval for a non-approver", () => {
  const permission = applyMaterialMenuAccess(groupPermission(), { isAdmin: false, canApprove: false });
  assert.deepEqual(permission["My Approval"], CLOSED);
  assert.deepEqual(permission.Materials, FULL);
});

test("applyMaterialMenuAccess only narrows: it never opens a page the group closed", () => {
  const permission = {
    "My Approval": { ...CLOSED },
    Administrator: { ...CLOSED },
  };
  applyMaterialMenuAccess(permission, { isAdmin: true, canApprove: true });
  assert.deepEqual(permission["My Approval"], CLOSED);
  assert.deepEqual(permission.Administrator, CLOSED);
});

test("applyMaterialMenuAccess keeps the group's My Approval when approver access is unknown", () => {
  const permission = applyMaterialMenuAccess(groupPermission(), { isAdmin: false, canApprove: null });
  assert.deepEqual(permission["My Approval"], FULL);
  assert.deepEqual(permission.Administrator, CLOSED);
});

test("applyMaterialMenuAccess leaves a map without those pages alone", () => {
  const permission = { Vendors: { ...FULL } };
  applyMaterialMenuAccess(permission, { isAdmin: false, canApprove: false });
  assert.deepEqual(permission, { Vendors: FULL });
});

test("resolveMaterialMenuAccess: ADMIN may do both, without a database call", async () => {
  await withPoolQuery(
    () => {
      throw new Error("ADMIN must not need the database");
    },
    async calls => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "u-1", username: " admin " }), {
        isAdmin: true,
        canApprove: true,
      });
      assert.equal(calls.length, 0);
    }
  );
});

test("resolveMaterialMenuAccess: an assigned approver may approve", async () => {
  await withPoolQuery(
    text => {
      assert.equal(text, MATERIAL_APPROVER_ACCESS_QUERY);
      return { rows: [{ is_approver: true }], rowCount: 1 };
    },
    async calls => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "APP-01", username: "approver" }), {
        isAdmin: false,
        canApprove: true,
      });
      assert.deepEqual(calls[0].params, ["APP-01"]);
      // Settled by the approver check; Master Data membership is not asked.
      assert.equal(calls.length, 1);
    }
  );
});

test("resolveMaterialMenuAccess: a Master Data user may approve without being in a chain", async () => {
  await withPoolQuery(
    text => {
      if (text === MATERIAL_APPROVER_ACCESS_QUERY) return { rows: [{ is_approver: false }], rowCount: 1 };
      if (MDM_QUERY.test(text)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "MDM-01", username: "mdm.user" }), {
        isAdmin: false,
        canApprove: true,
      });
    }
  );
});

test("resolveMaterialMenuAccess: a plain requester may not approve", async () => {
  await withPoolQuery(
    text => {
      if (text === MATERIAL_APPROVER_ACCESS_QUERY) return { rows: [{ is_approver: false }], rowCount: 1 };
      if (MDM_QUERY.test(text)) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "REQ-01", username: "requester" }), {
        isAdmin: false,
        canApprove: false,
      });
    }
  );
});

test("resolveMaterialMenuAccess answers unknown, not an error, when the lookup fails", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withPoolQuery(
      () => {
        throw new Error('relation "mat_approvers_matrix_level" does not exist');
      },
      async () => {
        assert.deepEqual(await resolveMaterialMenuAccess({ userId: "REQ-01", username: "requester" }), {
          isAdmin: false,
          canApprove: null,
        });
      }
    );
  } finally {
    console.error = originalError;
  }
});

test("the approver query covers the chain and waiting single and mass steps", () => {
  assert.match(MATERIAL_APPROVER_ACCESS_QUERY, /FROM mat_approvers_matrix_level\s+WHERE approver_user_id = \$1/);
  assert.match(
    MATERIAL_APPROVER_ACCESS_QUERY,
    /FROM mat_single_request_approval_step\s+WHERE approver_user_id = \$1\s+AND COALESCE\(status, 'WAITING'\) = 'WAITING'/
  );
  assert.match(
    MATERIAL_APPROVER_ACCESS_QUERY,
    /FROM mat_mass_request_item_approval_step\s+WHERE approver_user_id = \$1\s+AND COALESCE\(status, 'WAITING'\) = 'WAITING'/
  );
});

test("login and session restore apply the per-user access; the group editor does not", () => {
  const UserModel = require("../models/UserModel");
  assert.match(UserModel.loginUser.toString(), /applyMaterialMenuAccess\(\s*authPerm/);
  assert.match(UserModel.GetDataUser.toString(), /applyMaterialMenuAccess\(\s*authPerm/);
  // Menu Access edits a user group's settings: it must show them unfiltered.
  assert.doesNotMatch(UserModel.getAuthorization.toString(), /applyMaterialMenuAccess/);
});

function runMiddleware(username) {
  let nextCalled = false;
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  requireMaterialAdmin({ cookies: username === undefined ? undefined : { username } }, res, () => {
    nextCalled = true;
  });
  return { nextCalled, res };
}

test("requireMaterialAdmin lets ADMIN through and answers 403 to anyone else", () => {
  assert.equal(runMiddleware("ADMIN").nextCalled, true);
  assert.equal(runMiddleware("admin").nextCalled, true);

  for (const username of ["requester", "", undefined]) {
    const { nextCalled, res } = runMiddleware(username);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, message: "Forbidden" });
  }
});

test("guide management routes are ADMIN-only; reading guides stays open", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/MaterialRoute.js"), "utf8");
  const guarded = [
    /"\/guides\/upload",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
    /router\.post\(\s*"\/guides\/folders",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
    /router\.put\(\s*"\/guides\/folders\/:folderId",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
    /router\.delete\(\s*"\/guides\/folders\/:folderId",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
    /router\.put\(\s*"\/guides\/files\/:fileId",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
    /router\.delete\(\s*"\/guides\/files\/:fileId",\s*AuthToken\.authSession,\s*requireMaterialAdmin,/,
  ];
  for (const pattern of guarded) {
    assert.match(source, pattern);
  }
  assert.match(source, /router\.get\("\/guides", AuthToken\.authSession, GuideController\.getGuides\);/);
});
