const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const pool = require("../config/connection");
const materialService = require("../services/materialService");
const requireMaterialAdmin = require("../middleware/requireMaterialAdmin");
const requireMaterialMasterData = require("../middleware/requireMaterialMasterData");

const {
  resolveMaterialMenuAccess,
  applyMaterialMenuAccess,
  isAdminMaterialApprover,
  refreshMaterialAdminUsernames,
  buildLoginUserGroupInfo,
} = materialService;
const { MATERIAL_APPROVER_ACCESS_QUERY, MATERIAL_ADMIN_USERNAMES_QUERY } = materialService.__private;

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

// Every login re-reads the MATERIAL_ADMIN members first. `admins` are the
// usernames the group holds for the test.
function answerAdminList(text, admins = []) {
  if (text === MATERIAL_ADMIN_USERNAMES_QUERY) {
    return { rows: admins.map(username => ({ username })), rowCount: admins.length };
  }
  return undefined;
}

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

test("resolveMaterialMenuAccess: ADMIN may do both, without an approver lookup", async () => {
  await withPoolQuery(
    text => {
      const admins = answerAdminList(text);
      if (admins) return admins;
      throw new Error("ADMIN must not need the approver lookup");
    },
    async calls => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "u-1", username: " admin " }), {
        isAdmin: true,
        canApprove: true,
      });
      assert.deepEqual(calls.map(call => call.text), [MATERIAL_ADMIN_USERNAMES_QUERY]);
    }
  );
});

test("resolveMaterialMenuAccess: a MATERIAL_ADMIN member is a Materials admin", async () => {
  await withPoolQuery(
    text => {
      const admins = answerAdminList(text, ["masterdata1"]);
      if (admins) return admins;
      throw new Error(`Unexpected query: ${text}`);
    },
    async () => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "MD-1", username: "masterdata1" }), {
        isAdmin: true,
        canApprove: true,
      });
      // The rest of the module sees it too, case-insensitively like ADMIN.
      assert.equal(isAdminMaterialApprover("MasterData1"), true);
      assert.equal(isAdminMaterialApprover("masterdata2"), false);
    }
  );
  // Removed from the group: gone at the next refresh.
  await withPoolQuery(
    text => answerAdminList(text, []),
    async () => {
      await refreshMaterialAdminUsernames();
      assert.equal(isAdminMaterialApprover("masterdata1"), false);
      assert.equal(isAdminMaterialApprover("ADMIN"), true);
    }
  );
});

test("refreshMaterialAdminUsernames keeps the last list when the database fails", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withPoolQuery(text => answerAdminList(text, ["masterdata1"]), () => refreshMaterialAdminUsernames());
    await withPoolQuery(
      () => {
        throw new Error("connection refused");
      },
      () => refreshMaterialAdminUsernames()
    );
    assert.equal(isAdminMaterialApprover("masterdata1"), true);
  } finally {
    console.error = originalError;
    await withPoolQuery(text => answerAdminList(text, []), () => refreshMaterialAdminUsernames());
  }
});

test("the MATERIAL_ADMIN query reads active members of the group", () => {
  assert.match(MATERIAL_ADMIN_USERNAMES_QUERY, /JOIN mst_page_access a ON a\.user_group_id = u\.user_group/);
  assert.match(MATERIAL_ADMIN_USERNAMES_QUERY, /a\.user_group_name = \$1/);
  assert.match(MATERIAL_ADMIN_USERNAMES_QUERY, /u\.is_active = true/);
});

test("buildLoginUserGroupInfo flags MATERIAL_ADMIN membership", () => {
  assert.equal(buildLoginUserGroupInfo([{ user_group_name: "MATERIAL_ADMIN" }], "g-1").user_group.is_material_admin, true);
  assert.equal(buildLoginUserGroupInfo([{ user_group_name: "MATERIAL" }], "g-2").user_group.is_material_admin, false);
});

test("resolveMaterialMenuAccess: an assigned approver may approve", async () => {
  await withPoolQuery(
    text => {
      const admins = answerAdminList(text);
      if (admins) return admins;
      assert.equal(text, MATERIAL_APPROVER_ACCESS_QUERY);
      return { rows: [{ is_approver: true }], rowCount: 1 };
    },
    async calls => {
      assert.deepEqual(await resolveMaterialMenuAccess({ userId: "APP-01", username: "approver" }), {
        isAdmin: false,
        canApprove: true,
      });
      assert.deepEqual(calls[1].params, ["APP-01"]);
      // Settled by the approver check; Master Data membership is not asked.
      assert.equal(calls.length, 2);
    }
  );
});

test("resolveMaterialMenuAccess: a Master Data user may approve without being in a chain", async () => {
  await withPoolQuery(
    text => {
      const admins = answerAdminList(text);
      if (admins) return admins;
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
      const admins = answerAdminList(text);
      if (admins) return admins;
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

async function runMiddleware(username) {
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
  await requireMaterialAdmin({ cookies: username === undefined ? undefined : { username } }, res, () => {
    nextCalled = true;
  });
  return { nextCalled, res };
}

test("requireMaterialAdmin lets Materials admins through and answers 403 to anyone else", async () => {
  await withPoolQuery(
    text => answerAdminList(text, ["masterdata1"]),
    async () => {
      await refreshMaterialAdminUsernames();
      assert.equal((await runMiddleware("ADMIN")).nextCalled, true);
      assert.equal((await runMiddleware("admin")).nextCalled, true);
      assert.equal((await runMiddleware("masterdata1")).nextCalled, true);

      for (const username of ["requester", "", undefined]) {
        const { nextCalled, res } = await runMiddleware(username);
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { success: false, message: "Forbidden" });
      }
    }
  );
  await withPoolQuery(text => answerAdminList(text, []), () => refreshMaterialAdminUsernames());
});

test("requireMaterialAdmin re-checks the database for a user it does not know yet", async () => {
  await withPoolQuery(text => answerAdminList(text, []), () => refreshMaterialAdminUsernames());
  // Added to the group after the last refresh, and more than 10 s ago.
  await withPoolQuery(
    text => answerAdminList(text, ["masterdata2"]),
    async calls => {
      const realNow = Date.now;
      Date.now = () => realNow() + 60 * 1000;
      try {
        assert.equal((await runMiddleware("masterdata2")).nextCalled, true);
      } finally {
        Date.now = realNow;
      }
      assert.equal(calls.length, 1);
    }
  );
  await withPoolQuery(text => answerAdminList(text, []), () => refreshMaterialAdminUsernames());
});

test("login and session restore send is_material_admin for the approval dialogs", () => {
  const UserModel = require("../models/UserModel");
  assert.match(UserModel.loginUser.toString(), /is_material_admin: materialAccess\.isAdmin === true/);
  assert.match(UserModel.GetDataUser.toString(), /is_material_admin: materialAccess\.isAdmin === true/);
});

test("guide management routes are Materials-admin only; reading guides stays open", () => {
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

async function runMasterDataMiddleware(cookies) {
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
  await requireMaterialMasterData({ cookies }, res, () => {
    nextCalled = true;
  });
  return { nextCalled, res };
}

// Answers the admin list and the MDM_MATERIAL membership check.
function answerAdminAndMdm(text, params, { admins = [], mdmUserIds = [] } = {}) {
  if (text === MATERIAL_ADMIN_USERNAMES_QUERY) {
    return answerAdminList(text, admins);
  }
  if (/mpa\.user_group_name = \$2/.test(text) && params[1] === "MDM_MATERIAL") {
    const isMdm = mdmUserIds.includes(params[0]);
    return { rows: isMdm ? [{ "?column?": 1 }] : [], rowCount: isMdm ? 1 : 0 };
  }
  return undefined;
}

test("requireMaterialMasterData lets Master Data and Materials admins through, 403 to anyone else", async () => {
  await withPoolQuery(
    (text, params) => answerAdminAndMdm(text, params, { admins: ["matadmin1"], mdmUserIds: ["U-MDM"] }),
    async () => {
      await refreshMaterialAdminUsernames();
      assert.equal((await runMasterDataMiddleware({ username: "ADMIN", user_id: "U-1" })).nextCalled, true);
      assert.equal((await runMasterDataMiddleware({ username: "matadmin1", user_id: "U-2" })).nextCalled, true);
      assert.equal((await runMasterDataMiddleware({ username: "mdmuser", user_id: "U-MDM" })).nextCalled, true);

      for (const cookies of [{ username: "requester", user_id: "U-REQ" }, { username: "" }, undefined]) {
        const { nextCalled, res } = await runMasterDataMiddleware(cookies);
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { success: false, message: "Forbidden" });
      }
    }
  );
  await withPoolQuery(text => answerAdminList(text, []), () => refreshMaterialAdminUsernames());
});

test("requireMaterialMasterData answers 500, not next(), when the Master Data check fails", async () => {
  await withPoolQuery(
    text => {
      if (text === MATERIAL_ADMIN_USERNAMES_QUERY) {
        return answerAdminList(text, []);
      }
      throw new Error("db down");
    },
    async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        const { nextCalled, res } = await runMasterDataMiddleware({ username: "mdmuser", user_id: "U-MDM" });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 500);
      } finally {
        console.error = originalError;
      }
    }
  );
});

test("deleting a material attachment is guarded by requireMaterialMasterData", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/MaterialRoute.js"), "utf8");
  assert.match(
    source,
    /router\.delete\(\s*"\/attachments\/:attachmentId",\s*AuthToken\.authSession,\s*requireMaterialMasterData,\s*MaterialController\.deleteAttachment/
  );
});
