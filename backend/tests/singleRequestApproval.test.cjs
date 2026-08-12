const assert = require("node:assert/strict");
const test = require("node:test");
const Material = require("../models/MaterialModel");
const materialService = require("../services/materialService");
const MaterialController = require("../controllers/MaterialController");
const db = require("../config/connection");
const MaterialTemplate = require("../models/MaterialTemplateModel");
const {
  canActorReviseSingleRequest,
  assertRequiredActionReason,
  buildSingleRequestFinalCode,
} = require("../services/materialService");

test("assertRequiredActionReason rejects blank reason values", () => {
  assert.throws(
    () => assertRequiredActionReason("   ", "rework"),
    /rework reason is required/i
  );
});

test("buildSingleRequestFinalCode composes dotted code from group, subgroup, and suffix", () => {
  assert.equal(
    buildSingleRequestFinalCode({
      materialGroupCode: "901",
      materialSubGroupCode: "031",
      finalCodeSuffix: "123",
    }),
    "901.031.123"
  );
});

test("buildSingleRequestFinalCode accepts a 3-char alphanumeric suffix (uppercased)", () => {
  assert.equal(
    buildSingleRequestFinalCode({
      materialGroupCode: "901",
      materialSubGroupCode: "031",
      finalCodeSuffix: "a1b",
    }),
    "901.031.A1B"
  );
});

test("buildSingleRequestFinalCode requires exactly three alphanumeric suffix chars", () => {
  assert.throws(
    () =>
      buildSingleRequestFinalCode({
        materialGroupCode: "901",
        materialSubGroupCode: "031",
        finalCodeSuffix: "1-A",
      }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "SINGLE_REQUEST_FINAL_CODE_SUFFIX_INVALID");
      assert.deepEqual(error.errors, [
        {
          fieldKey: "finalCodeSuffix",
          message: "Final code suffix must be exactly 3 letters or digits",
        },
      ]);
      return true;
    }
  );
});

test("canActorReviseSingleRequest allows requester and admin only", () => {
  assert.equal(
    canActorReviseSingleRequest({
      request: { created_by: "REQ-01" },
      actorUserId: "REQ-01",
      actorUsername: "requester.user",
    }),
    true
  );
  assert.equal(
    canActorReviseSingleRequest({
      request: { created_by: "REQ-01" },
      actorUserId: "APP-01",
      actorUsername: "approver.user",
    }),
    false
  );
  assert.equal(
    canActorReviseSingleRequest({
      request: { created_by: "REQ-01" },
      actorUserId: "ADMIN-01",
      actorUsername: "ADMIN",
    }),
    true
  );
});

test("createSingleRequest query includes approval columns on mat_single_request", () => {
  assert.match(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /approval_1_user_id/i);
  assert.match(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /approval_2_user_id/i);
  assert.match(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /ticket_type/i);
  assert.doesNotMatch(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /material_code/i);
  assert.match(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /change_extend_reason/i);
});

test("createSingleRequest query stores material_group_id instead of material_group_code", () => {
  assert.match(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /material_group_id/i);
  assert.doesNotMatch(materialService.__private.CREATE_SINGLE_REQUEST_INSERT_QUERY, /material_group_code/i);
});

test("getAdministratorApproverMasters query includes master join and lock metadata", () => {
  assert.match(materialService.__private.GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY, /LEFT JOIN mat_single_request_approval/i);
  assert.match(materialService.__private.GET_ADMINISTRATOR_APPROVER_MASTERS_QUERY, /active_request_count/i);
});

test("getSingleRequestApprovalInbox query no longer joins mat_single_request_approval", () => {
  assert.doesNotMatch(materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY, /LEFT JOIN mat_single_request_approval a/i);
});

test("getSingleRequestApprovalInbox query reads group code through the id join", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /r\.material_group_id/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /LEFT JOIN mat_item_group mig ON mig\.id = r\.material_group_id/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /mig\.code AS material_group_code/i
  );
});

test("getSingleRequestApprovalInbox query includes subgroup fields for approval detail dialog", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /LEFT JOIN mat_item_sub_group mis ON mis\.id = r\.material_sub_group_id/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /mis\.code AS material_sub_group_code/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /mis\.name AS material_sub_group_name/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /r\.rework_stage/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /r\.rework_reason/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /TO_CHAR\(r\.rework_at, 'YYYY-MM-DD HH24:MI'\) AS rework_at/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /rework_by\.username AS rework_by_username/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /approval_1_user\.fullname.*AS approval_1_user_name/is
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /LEFT JOIN mst_user approval_2_user ON approval_2_user\.user_id = r\.approval_2_user_id/i
  );
});

test("single request read queries expose final_code for approval and request views", () => {
  assert.match(materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY, /r\.final_code/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.final_code/i);
  assert.match(materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY, /r\.final_code/i);
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /LEFT JOIN mat_item_sub_group mis ON mis\.id = r\.material_sub_group_id/i
  );
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /mis\.code AS material_sub_group_code/i
  );
});

test("getSingleRequests list query reads approval snapshot from mat_single_request", () => {
  assert.doesNotMatch(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /LEFT JOIN mat_single_request_approval a/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.approval_1_user_id/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.approval_2_status/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.approval_3_status/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.rework_stage/i);
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /r\.rework_reason/i);
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
    /TO_CHAR\(r\.rework_at, 'YYYY-MM-DD HH24:MI'\) AS rework_at/i
  );
  assert.match(materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY, /rework_by\.username AS rework_by_username/i);
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
    /approval_1_user\.fullname.*AS approval_1_user_name/is
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
    /LEFT JOIN mst_user approval_3_user ON approval_3_user\.user_id = r\.approval_3_user_id/i
  );
});

test("legacy single request read queries omit rework columns and joins", () => {
  assert.doesNotMatch(
    materialService.__private.GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY,
    /r\.rework_stage|r\.rework_reason|rework_by\.username/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY,
    /NULL::varchar AS rework_stage/i
  );
  assert.doesNotMatch(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY,
    /r\.rework_stage|r\.rework_reason|rework_by\.username/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY,
    /NULL::varchar AS rework_stage/i
  );
});

test("migration adds rework fields, check constraint, and comments", () => {
  const migrationSource = require("fs").readFileSync(
    require("path").join(
      __dirname,
      "../migration/20260522_add_mat_single_request_rework_fields.sql"
    ),
    "utf8"
  );

  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS rework_stage VARCHAR\(32\)/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS rework_by_user_id VARCHAR\(64\)/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS rework_at TIMESTAMPTZ NULL/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS rework_reason TEXT/i);
  assert.match(migrationSource, /chk_mat_single_request_rework_stage/i);
  assert.match(
    migrationSource,
    /CHECK\s*\(\s*rework_stage IS NULL OR\s*rework_stage IN \('Approval 1', 'Approval 2', 'Approval 3'\)\s*\)/i
  );
  assert.match(migrationSource, /COMMENT ON COLUMN mat_single_request\.rework_stage/i);
  assert.match(migrationSource, /COMMENT ON COLUMN mat_single_request\.rework_by_user_id/i);
  assert.match(migrationSource, /COMMENT ON COLUMN mat_single_request\.rework_at/i);
  assert.match(migrationSource, /COMMENT ON COLUMN mat_single_request\.rework_reason/i);
});

test("migration adds nullable final_code to mat_single_request", () => {
  const migrationSource = require("fs").readFileSync(
    require("path").join(
      __dirname,
      "../migration/20260608_add_mat_single_request_final_code.sql"
    ),
    "utf8"
  );

  assert.match(migrationSource, /ALTER TABLE public\.mat_single_request/i);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS final_code varchar\(11\) NULL/i);
  assert.match(migrationSource, /COMMENT ON COLUMN public\.mat_single_request\.final_code/i);
});

test("getSingleRequests list query reads group code through the id join", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
    /LEFT JOIN mat_item_group mig ON mig\.id = r\.material_group_id/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
    /mig\.code AS material_group_code/i
  );
});

test("getSingleRequests list query joins mst_user only once", () => {
  const joinMatches =
    materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY.match(
      /LEFT JOIN mst_user u ON u\.user_id = r\.created_by/gi
    ) || [];

  assert.equal(joinMatches.length, 1);
});

test("approval action workflow skips edit history for Change and Extend requests", () => {
  const source = materialService.approveSingleRequestByAdmin.toString();
  assert.match(source, /ticketType|ticket_type/);
  assert.match(source, /INSERT INTO mat_single_request_edit_history/i);
});

test("approval action workflow applies Change updates to mat_sap_data and validates Extend material codes", () => {
  const source = materialService.approveSingleRequestByAdmin.toString();
  assert.match(source, /UPDATE mat_sap_data/i);
  assert.match(source, /unit_of_measurement/i);
  assert.match(source, /resolveSingleRequestMaterialCode/i);
  assert.match(source, /Done|Completed/);
});

test("approval action workflow accepts finalCodeSuffix and stores final_code at Approval 3", () => {
  const source = materialService.approveSingleRequestByAdmin.toString();
  assert.match(source, /finalCodeSuffix/);
  assert.match(source, /buildSingleRequestFinalCode/);
  assert.match(source, /final_code/);
});

test("final_code duplicate guard skips cancelled requests", () => {
  const source = materialService.approveSingleRequestByAdmin.toString();
  assert.match(
    source,
    /SELECT request_no FROM mat_single_request[\s\S]*WHERE final_code = \$1 AND id <> \$2[\s\S]*AND UPPER\(COALESCE\(status, ''\)\) <> 'CANCEL'/i
  );
});

test("approveSingleRequestByAdmin stores composed final_code on Approval 3", async () => {
  const originalConnect = db.connect;
  let finalUpdateParams = null;

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              assigned_to: "Approval 3",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Submit",
              ticket_type: "Create",
              material_group_code: "901",
              material_sub_group_code: "031",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: new Date("2026-05-01T09:00:00.000Z"),
              approval_1_status: "APPROVED",
              approval_1_remark: "ok",
              approval_2_user_id: "APP-02",
              approval_2_at: new Date("2026-05-01T10:00:00.000Z"),
              approval_2_status: "APPROVED",
              approval_2_remark: "ok",
              approval_3_user_id: "APP-03",
              approval_3_at: null,
              approval_3_status: "WAITING",
              approval_3_remark: null,
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              template_payload: { requestFields: {}, templateValues: {} },
            },
          ],
          rowCount: 1,
        };
      }

      if (/FROM mst_user mu[\s\S]*JOIN mst_page_access/i.test(queryText)) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }

      if (/UPDATE mat_single_request[\s\S]*final_code = \$\d+/i.test(queryText)) {
        finalUpdateParams = params;
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    const result = await materialService.approveSingleRequestByAdmin({
      requestId: 77,
      actorUserId: "APP-03",
      actorUsername: "mdm.user",
      remark: "approved",
      finalCodeSuffix: "123",
    });

    assert.ok(finalUpdateParams);
    assert.equal(finalUpdateParams.includes("901.031.123"), true);
    assert.equal(result.final_code, "901.031.123");
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestApprovalInbox query aggregates edit history from history table", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /LEFT JOIN LATERAL\s*\(\s*SELECT[\s\S]*jsonb_agg\([\s\S]*ORDER BY eh\.approved_at DESC[\s\S]*FROM mat_single_request_edit_history eh[\s\S]*WHERE eh\.request_id = r\.id[\s\S]*\)\s*edit_history_rows ON TRUE/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /COALESCE\(edit_history_rows\.edit_history, '\[\]'::jsonb\) AS edit_history/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /'approved_by_user_id', eh\.approved_by_user_id[\s\S]*'approved_by_username', COALESCE\(au\.username, eh\.approved_by_user_id\)[\s\S]*'approve_remark', eh\.approve_remark[\s\S]*'created_by', eh\.created_by[\s\S]*'created_at', eh\.created_at/i
  );
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /'material_description', eh\.material_description[\s\S]*'base_uom', eh\.base_uom[\s\S]*'template_payload', eh\.template_payload/i
  );
});

test("locked approval snapshot query reads runtime approval data from mat_single_request", () => {
  assert.doesNotMatch(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /LEFT JOIN mat_single_request_approval/i
  );
  assert.doesNotMatch(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /approval_request_id/i
  );
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /r\.created_by AS requester_user_id/i
  );
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /r\.ticket_type/i
  );
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /requestFields,material_number/i
  );
  assert.match(
    materialService.__private.LOCKED_SINGLE_REQUEST_APPROVAL_SNAPSHOT_QUERY,
    /r\.change_extend_reason/i
  );
});

test("controller preserves partial approver-master payload fields", () => {
  assert.match(
    MaterialController.assignSingleRequestApproverMaster.toString(),
    /hasOwnProperty/
  );
});

test("approve controller forwards editedRequest payload", () => {
  assert.match(
    MaterialController.approveSingleRequest.toString(),
    /editedRequest:\s*req\.body\?\.editedRequest\s*\?\?\s*null/
  );
});

test("createSingleRequest controller forwards ticketType-specific fields", () => {
  const source = MaterialController.createSingleRequest.toString();
  assert.match(source, /ticketType/i);
  assert.match(source, /materialCode/i);
  assert.match(source, /changeExtendReason/i);
});

test("createSingleRequest controller accepts JSON Change payloads without multipart attachments", async () => {
  const originalCreateSingleRequest = materialService.createSingleRequest;
  const originalGetMaterialByCode = Material.getMaterialByCode;
  const originalGetGroupById = materialService.getGroupById;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalHasActiveSingleRequest = materialService.hasActiveSingleRequest;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  let receivedPayload = null;
  let receivedValidationPayload = null;

  Material.getMaterialByCode = async code => ({
    code,
    type: "ZROH",
    unit_of_measurement: "PC",
    groupCode: "PACK",
    groupId: 21,
    subGroupId: 210,
  });
  materialService.getGroupById = async () => ({
    id: 21,
    code: "PACK",
  });
  materialService.getSubGroupById = async () => ({
    id: 210,
    item_group_id: 21,
    deleted_at: null,
  });
  materialService.hasActiveSingleRequest = async () => false;
  MaterialTemplate.validateMaterialRequestTemplate = async payload => {
    receivedValidationPayload = payload;
    return {
      errors: [],
      materialDescription: payload.requestFields.material_description,
      normalizedRequestFields: {
        material_description: payload.requestFields.material_description,
        base_unit_of_measure: payload.requestFields.base_unit_of_measure,
      },
      normalizedTemplateValues: payload.templateValues,
    };
  };
  materialService.createSingleRequest = async payload => {
    receivedPayload = payload;
    return { request_id: 77, ticket_type: "Change" };
  };

  const response = {
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
    await MaterialController.createSingleRequest(
      {
        cookies: { user_id: "REQ-01", username: "requester.user" },
        headers: { "content-type": "application/json" },
        body: {
          ticketType: "Change",
          materialCode: "MAT-001",
          change_extend_reason: "Need updated description",
          requestFields: {
            material_description: "New desc",
            base_unit_of_measure: "KG",
          },
          templateValues: {
            density: "1.2",
          },
        },
      },
      response
    );

    assert.equal(response.statusCode, 201);
    assert.deepEqual(receivedValidationPayload.requestFields, {
      material_description: "New desc",
      material_number: "MAT-001",
      material_type: "ZROH",
      material_group: "PACK",
      base_unit_of_measure: "KG",
    });
    assert.equal(receivedPayload.ticketType, "Change");
    assert.equal(receivedPayload.materialGroupId, 21);
    assert.equal(receivedPayload.materialSubGroupId, 210);
    assert.equal(receivedPayload.materialCode, "MAT-001");
    assert.equal(
      receivedPayload.changeExtendReason,
      "Need updated description"
    );
    assert.deepEqual(receivedPayload.requestFields, {
      material_description: "New desc",
      base_unit_of_measure: "KG",
      plant: null,
      storage_location: null,
    });
    assert.deepEqual(receivedPayload.templateValues, {
      density: "1.2",
    });
    assert.deepEqual(receivedPayload.attachments, []);
  } finally {
    materialService.createSingleRequest = originalCreateSingleRequest;
    Material.getMaterialByCode = originalGetMaterialByCode;
    materialService.getGroupById = originalGetGroupById;
    materialService.getSubGroupById = originalGetSubGroupById;
    materialService.hasActiveSingleRequest = originalHasActiveSingleRequest;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
  }
});

test("createSingleRequest controller allows Change payloads when SAP snapshot has no template values", async () => {
  const originalCreateSingleRequest = materialService.createSingleRequest;
  const originalGetMaterialByCode = Material.getMaterialByCode;
  const originalGetGroupById = materialService.getGroupById;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalHasActiveSingleRequest = materialService.hasActiveSingleRequest;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  let receivedPayload = null;

  Material.getMaterialByCode = async code => ({
    code,
    type: "ZROH",
    unit_of_measurement: "PC",
    groupCode: "PACK",
    groupId: 21,
    subGroupId: 210,
  });
  materialService.getGroupById = async () => ({
    id: 21,
    code: "PACK",
  });
  materialService.getSubGroupById = async () => ({
    id: 210,
    item_group_id: 21,
    deleted_at: null,
  });
  materialService.hasActiveSingleRequest = async () => false;
  MaterialTemplate.validateMaterialRequestTemplate = async payload => ({
    errors: [
      {
        fieldKey: "brand_merek",
        message: "BRAND / MEREK wajib diisi",
      },
      {
        fieldKey: "part_number",
        message: "PART NUMBER wajib diisi",
      },
    ],
    template: {
      fields: [
        { fieldKey: "brand_merek", isMandatory: true },
        { fieldKey: "part_number", isMandatory: true },
      ],
    },
    materialDescription: payload.requestFields.material_description,
    normalizedRequestFields: {
      material_description: payload.requestFields.material_description,
      base_unit_of_measure: payload.requestFields.base_unit_of_measure,
    },
    normalizedTemplateValues: {},
  });
  materialService.createSingleRequest = async payload => {
    receivedPayload = payload;
    return { request_id: 78, ticket_type: "Change" };
  };

  const response = {
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
    await MaterialController.createSingleRequest(
      {
        cookies: { user_id: "REQ-01", username: "requester.user" },
        headers: { "content-type": "application/json" },
        body: {
          ticketType: "Change",
          materialCode: "MAT-001",
          change_extend_reason: "Need updated description",
          requestFields: {
            material_description: "New desc",
            base_unit_of_measure: "KG",
          },
          templateValues: {},
        },
      },
      response
    );

    assert.equal(response.statusCode, 201);
    assert.equal(receivedPayload.ticketType, "Change");
    assert.deepEqual(receivedPayload.templateValues, {});
  } finally {
    materialService.createSingleRequest = originalCreateSingleRequest;
    Material.getMaterialByCode = originalGetMaterialByCode;
    materialService.getGroupById = originalGetGroupById;
    materialService.getSubGroupById = originalGetSubGroupById;
    materialService.hasActiveSingleRequest = originalHasActiveSingleRequest;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
  }
});

test("createSingleRequest controller keeps Change template format errors when values are provided", async () => {
  const originalCreateSingleRequest = materialService.createSingleRequest;
  const originalGetMaterialByCode = Material.getMaterialByCode;
  const originalGetGroupById = materialService.getGroupById;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  let createCalled = false;

  Material.getMaterialByCode = async code => ({
    code,
    type: "ZROH",
    unit_of_measurement: "PC",
    groupCode: "PACK",
    groupId: 21,
    subGroupId: 210,
  });
  materialService.getGroupById = async () => ({
    id: 21,
    code: "PACK",
  });
  materialService.getSubGroupById = async () => ({
    id: 210,
    item_group_id: 21,
    deleted_at: null,
  });
  MaterialTemplate.validateMaterialRequestTemplate = async payload => ({
    errors: [
      {
        fieldKey: "brand_merek",
        message: "BRAND / MEREK tidak sesuai rule CAPITAL_ONLY",
      },
    ],
    template: {
      fields: [{ fieldKey: "brand_merek", isMandatory: true }],
    },
    materialDescription: payload.requestFields.material_description,
    normalizedRequestFields: {
      material_description: payload.requestFields.material_description,
      base_unit_of_measure: payload.requestFields.base_unit_of_measure,
    },
    normalizedTemplateValues: payload.templateValues,
  });
  materialService.createSingleRequest = async () => {
    createCalled = true;
    return { request_id: 79, ticket_type: "Change" };
  };

  const response = {
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
    await MaterialController.createSingleRequest(
      {
        cookies: { user_id: "REQ-01", username: "requester.user" },
        headers: { "content-type": "application/json" },
        body: {
          ticketType: "Change",
          materialCode: "MAT-001",
          change_extend_reason: "Need updated description",
          requestFields: {
            material_description: "New desc",
            base_unit_of_measure: "KG",
          },
          templateValues: {
            brand_merek: "bad-value!",
          },
        },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(response.jsonPayload.errors, [
      {
        fieldKey: "brand_merek",
        message: "BRAND / MEREK tidak sesuai rule CAPITAL_ONLY",
      },
    ]);
  } finally {
    materialService.createSingleRequest = originalCreateSingleRequest;
    Material.getMaterialByCode = originalGetMaterialByCode;
    materialService.getGroupById = originalGetGroupById;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
  }
});

test("approve controller preserves custom status codes and validation errors", async () => {
  const originalApprove = materialService.approveSingleRequestByAdmin;
  const req = {
    params: { id: "77" },
    cookies: { user_id: "APP-01", username: "user.one" },
    body: {
      remark: "approve",
      editedRequest: {
        material_description: "",
      },
    },
  };
  const response = {
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

  materialService.approveSingleRequestByAdmin = async () => {
    const error = new Error("Material request validation failed");
    error.statusCode = 400;
    error.code = "SINGLE_REQUEST_EDIT_VALIDATION_FAILED";
    error.errors = [
      {
        fieldKey: "material_description",
        message: "Required",
      },
    ];
    throw error;
  };

  try {
    await MaterialController.approveSingleRequest(req, response);

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.jsonPayload, {
      success: false,
      message: "Material request validation failed",
      code: "SINGLE_REQUEST_EDIT_VALIDATION_FAILED",
      errors: [
        {
          fieldKey: "material_description",
          message: "Required",
        },
      ],
    });
  } finally {
    materialService.approveSingleRequestByAdmin = originalApprove;
  }
});

test("approve controller forwards finalCodeSuffix to approval workflow", async () => {
  const originalApprove = materialService.approveSingleRequestByAdmin;
  let receivedPayload = null;
  const req = {
    params: { id: "77" },
    cookies: { user_id: "APP-03", username: "mdm.user" },
    body: {
      remark: "approved",
      finalCodeSuffix: "123",
    },
  };
  const response = {
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

  materialService.approveSingleRequestByAdmin = async payload => {
    receivedPayload = payload;
    return {
      request_id: 77,
      status: "Done",
      final_code: "901.031.123",
    };
  };

  try {
    await MaterialController.approveSingleRequest(req, response);

    assert.equal(response.statusCode, 200);
    assert.equal(receivedPayload.finalCodeSuffix, "123");
    assert.equal(response.jsonPayload.data.final_code, "901.031.123");
  } finally {
    materialService.approveSingleRequestByAdmin = originalApprove;
  }
});

test("controller exports requester master handlers", () => {
  assert.equal(typeof MaterialController.assignSingleRequestApproverMaster, "function");
  assert.equal(typeof MaterialController.getSingleRequestApproverMasters, "function");
});

test("createSingleRequest controller validates subgroup membership with item_group_id", () => {
  assert.match(MaterialController.createSingleRequest.toString(), /subgroup\.item_group_id/);
  assert.match(MaterialController.createSingleRequest.toString(), /materialGroup\.id/);
  assert.doesNotMatch(
    MaterialController.createSingleRequest.toString(),
    /subgroup\.group_code[\s\S]*materialGroupCode/
  );
});

test("approval edit validation rejects subgroup outside current material group", async () => {
  await assert.rejects(
    materialService.__private.prepareSingleRequestApprovalEditPatch({
      snapshot: {
        material_group_id: 10,
        material_sub_group_id: 100,
        material_group_code: "CHEM",
        material_description: "Current description",
        base_uom: "EA",
        plant_code: "P1",
        sloc_code: "S1",
        long_text_1: null,
        long_text_2: null,
        long_text_3: null,
        template_payload: { requestFields: {}, templateValues: {} },
      },
      editedRequest: {
        material_sub_group_id: 200,
      },
      getSubGroupById: async () => ({
        id: 200,
        item_group_id: 99,
        deleted_at: null,
      }),
      validateMaterialRequestTemplate: async () => ({
        errors: [],
        normalizedRequestFields: {
          material_description: "Current description",
          base_unit_of_measure: "EA",
        },
        normalizedTemplateValues: {},
      }),
    }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.match(
        error.message,
        /Sub material group does not belong to the selected material group/
      );
      return true;
    }
  );
});

test("rework edit validation allows material group change and validates subgroup against new group", async () => {
  let receivedValidationPayload = null;

  const patch = await materialService.__private.prepareSingleRequestApprovalEditPatch({
    snapshot: {
      material_group_id: 10,
      material_sub_group_id: 100,
      material_group_code: "CHEM",
      material_description: "Current description",
      base_uom: "EA",
      plant_code: "P1",
      sloc_code: "S1",
      long_text_1: null,
      long_text_2: null,
      long_text_3: null,
      template_payload: { requestFields: {}, templateValues: { density: "1.0" } },
    },
    editedRequest: {
      material_group_id: 11,
      material_group_code: "PACK",
      material_sub_group_id: 210,
      material_description: "Updated description",
      template_payload: { templateValues: { density: "1.2" } },
    },
    allowMaterialGroupChange: true,
    getSubGroupById: async () => ({
      id: 210,
      item_group_id: 11,
      deleted_at: null,
    }),
    validateMaterialRequestTemplate: async payload => {
      receivedValidationPayload = payload;
      return {
        errors: [],
        materialDescription: payload.requestFields.material_description,
        normalizedRequestFields: {
          material_description: payload.requestFields.material_description,
          base_unit_of_measure: payload.requestFields.base_unit_of_measure,
          plant: payload.requestFields.plant,
          storage_location: payload.requestFields.storage_location,
        },
        normalizedTemplateValues: payload.templateValues,
      };
    },
  });

  assert.equal(patch.material_group_id, 11);
  assert.equal(patch.material_sub_group_id, 210);
  assert.equal(receivedValidationPayload.materialGroupCode, "PACK");
});

test("approval edit validation surfaces template validation errors", async () => {
  await assert.rejects(
    materialService.__private.prepareSingleRequestApprovalEditPatch({
      snapshot: {
        material_group_id: 10,
        material_sub_group_id: 100,
        material_group_code: "CHEM",
        material_description: "Current description",
        base_uom: "EA",
        plant_code: "P1",
        sloc_code: "S1",
        long_text_1: null,
        long_text_2: null,
        long_text_3: null,
        template_payload: { requestFields: {}, templateValues: {} },
      },
      editedRequest: {
        material_description: "",
        template_payload: { templateValues: { foo: "" } },
      },
      getSubGroupById: async () => ({
        id: 100,
        item_group_id: 10,
        deleted_at: null,
      }),
      validateMaterialRequestTemplate: async () => ({
        errors: [
          {
            fieldKey: "material_description",
            message: "Required",
          },
        ],
        normalizedRequestFields: {},
        normalizedTemplateValues: { foo: "" },
      }),
    }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Material request validation failed/);
      assert.deepEqual(error.errors, [
        {
          fieldKey: "material_description",
          message: "Required",
        },
      ]);
      return true;
    }
  );
});

test("approval edit validation rejects template validation errors", async () => {
  await assert.rejects(
    materialService.__private.prepareSingleRequestApprovalEditPatch({
      snapshot: {
        material_group_id: 10,
        material_sub_group_id: 100,
        material_group_code: "CHEM",
        material_description: "Current description",
        base_uom: "EA",
        plant_code: "P1",
        sloc_code: "S1",
        long_text_1: null,
        long_text_2: null,
        long_text_3: null,
        template_payload: { requestFields: {}, templateValues: {} },
      },
      editedRequest: {
        base_uom: "",
      },
      getSubGroupById: async () => ({
        id: 100,
        item_group_id: 10,
        deleted_at: null,
      }),
      validateMaterialRequestTemplate: async () => ({
        errors: [
          {
            fieldKey: "base_unit_of_measure",
            message: "Base Unit of Measure wajib diisi",
          },
        ],
        normalizedRequestFields: {},
        normalizedTemplateValues: {},
      }),
    }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Material request validation failed/);
      assert.deepEqual(error.errors, [
        {
          fieldKey: "base_unit_of_measure",
          message: "Base Unit of Measure wajib diisi",
        },
      ]);
      return true;
    }
  );
});

test("approval edit validation returns normalized editable patch", async () => {
  const patch = await materialService.__private.prepareSingleRequestApprovalEditPatch({
    snapshot: {
      material_group_id: 10,
      material_sub_group_id: 100,
      material_group_code: "CHEM",
      material_description: "Current description",
      base_uom: "EA",
      plant_code: "P1",
      sloc_code: "S1",
      long_text_1: "old1",
      long_text_2: null,
      long_text_3: null,
      template_payload: { requestFields: { material_description: "Current description" }, templateValues: { old: true } },
    },
    editedRequest: {
      material_description: "New desc",
      base_uom: "KG",
      template_payload: { templateValues: { foo: "bar" } },
    },
    getSubGroupById: async () => ({
      id: 100,
      item_group_id: 10,
      deleted_at: null,
    }),
    validateMaterialRequestTemplate: async ({ requestFields, templateValues }) => ({
      errors: [],
      materialDescription: requestFields.material_description,
      normalizedRequestFields: {
        material_description: requestFields.material_description,
        base_unit_of_measure: requestFields.base_unit_of_measure,
        plant: requestFields.plant,
        storage_location: requestFields.storage_location,
        long_text_1: requestFields.long_text_1,
      },
      normalizedTemplateValues: templateValues,
    }),
  });

  assert.equal(patch.material_description, "New desc");
  assert.equal(patch.base_uom, "KG");
  assert.deepEqual(patch.template_payload, {
    requestFields: {
      material_description: "New desc",
      base_unit_of_measure: "KG",
      plant: "P1",
      storage_location: "S1",
      long_text_1: "old1",
    },
    templateValues: {
      foo: "bar",
    },
  });
});

test("approval edit validation runs for plant and sloc changes", async () => {
  let validationCalls = 0;

  const patch = await materialService.__private.prepareSingleRequestApprovalEditPatch({
    snapshot: {
      material_group_id: 10,
      material_sub_group_id: 100,
      material_group_code: "CHEM",
      material_description: "Current description",
      base_uom: "EA",
      plant_code: "P1",
      sloc_code: "S1",
      long_text_1: "old1",
      long_text_2: null,
      long_text_3: null,
      template_payload: { requestFields: {}, templateValues: { old: true } },
    },
    editedRequest: {
      plant_code: "P2",
      sloc_code: "S2",
    },
    getSubGroupById: async () => ({
      id: 100,
      item_group_id: 10,
      deleted_at: null,
    }),
    validateMaterialRequestTemplate: async ({ requestFields, templateValues }) => {
      validationCalls += 1;

      assert.equal(requestFields.plant, "P2");
      assert.equal(requestFields.storage_location, "S2");
      assert.equal(requestFields.material_description, "Current description");
      assert.equal(requestFields.base_unit_of_measure, "EA");
      assert.deepEqual(templateValues, { old: true });

      return {
        errors: [],
        materialDescription: requestFields.material_description,
        normalizedRequestFields: {
          material_description: requestFields.material_description,
          base_unit_of_measure: requestFields.base_unit_of_measure,
          plant: requestFields.plant,
          storage_location: requestFields.storage_location,
        },
        normalizedTemplateValues: templateValues,
      };
    },
  });

  assert.equal(validationCalls, 1);
  assert.equal(patch.plant_code, "P2");
  assert.equal(patch.sloc_code, "S2");
});

test("approval edit validation rejects invalid required-field outcome from long text edit", async () => {
  let validationCalls = 0;

  await assert.rejects(
    materialService.__private.prepareSingleRequestApprovalEditPatch({
      snapshot: {
        material_group_id: 10,
        material_sub_group_id: 100,
        material_group_code: "CHEM",
        material_description: null,
        base_uom: null,
        plant_code: "P1",
        sloc_code: "S1",
        long_text_1: "old1",
        long_text_2: null,
        long_text_3: null,
        template_payload: { requestFields: {}, templateValues: {} },
      },
      editedRequest: {
        long_text_1: "",
      },
      getSubGroupById: async () => ({
        id: 100,
        item_group_id: 10,
        deleted_at: null,
      }),
      validateMaterialRequestTemplate: async ({ requestFields }) => {
        validationCalls += 1;
        assert.equal(requestFields.long_text_1, "");

        return {
          errors: [],
          normalizedRequestFields: {
            material_description: "",
            base_unit_of_measure: "",
            plant: requestFields.plant,
            storage_location: requestFields.storage_location,
            long_text_1: requestFields.long_text_1,
          },
          normalizedTemplateValues: {},
        };
      },
    }),
    error => {
      assert.equal(validationCalls, 1);
      assert.equal(error.statusCode, 400);
      assert.match(
        error.message,
        /Material description and Base UoM are required/
      );
      return true;
    }
  );
});

test("getSingleRequestApprovalInbox query includes Approval 3 waiting rows", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /approval_2_status = 'APPROVED'[\s\S]*COALESCE\(r\.approval_3_status, 'WAITING'\) = 'WAITING'/i
  );
});

test("getSingleRequestApprovalInbox query keeps final list statuses for filtering", () => {
  assert.match(
    materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
    /UPPER\(COALESCE\(r\.status, ''\)\) IN \('DONE', 'REWORK', 'REJECT', 'REJECTED', 'CANCEL'\)/i
  );
});

test("getSingleRequestApprovalInbox returns aggregated edit_history rows", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async queryText => {
      queryCalls.push(queryText);
      return {
        rows: [
          {
            id: 77,
            status: "Submit",
            approval_1_status: "WAITING",
            approval_2_status: null,
            approval_3_status: null,
            approval_1_user_id: "APP-01",
            approval_2_user_id: null,
            approval_3_user_id: null,
            edit_history: [
              {
                id: 5,
                request_id: 77,
                request_no: "1000000077",
                approval_stage: "Approval 2",
                approved_by_user_id: "APP-01",
                approved_by_username: "approval.user.one",
                approve_remark: "latest edit",
                approved_at: "2026-05-20T11:30:00.000Z",
                material_group_id: 12,
                material_sub_group_id: 120,
                plant_code: "P2",
                sloc_code: "S2",
                material_description: "Changed desc",
                base_uom: "KG",
                long_text_1: "l1",
                long_text_2: "l2",
                long_text_3: "l3",
                template_payload: { templateValues: { density: "1.2" } },
                created_by: "REQ-01",
                created_at: "2026-05-01T08:00:00.000Z",
              },
              {
                id: 4,
                request_id: 77,
                request_no: "1000000077",
                approval_stage: "Approval 1",
                approved_by_user_id: "APP-01",
                approved_by_username: "approval.user.one",
                approve_remark: "older edit",
                approved_at: "2026-05-20T09:15:00.000Z",
                material_group_id: 12,
                material_sub_group_id: 110,
                plant_code: "P1",
                sloc_code: "S1",
                material_description: "Original desc",
                base_uom: "EA",
                long_text_1: null,
                long_text_2: null,
                long_text_3: null,
                template_payload: { templateValues: { density: "1.0" } },
                created_by: "REQ-01",
                created_at: "2026-05-01T08:00:00.000Z",
              },
            ],
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestApprovalInbox("APP-01", "user.one");

    assert.equal(queryCalls.length, 1);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].edit_history, [
      {
        id: 5,
        request_id: 77,
        request_no: "1000000077",
        approval_stage: "Approval 2",
        approved_by_user_id: "APP-01",
        approved_by_username: "approval.user.one",
        approve_remark: "latest edit",
        approved_at: "2026-05-20T11:30:00.000Z",
        material_group_id: 12,
        material_sub_group_id: 120,
        plant_code: "P2",
        sloc_code: "S2",
        material_description: "Changed desc",
        base_uom: "KG",
        long_text_1: "l1",
        long_text_2: "l2",
        long_text_3: "l3",
        template_payload: { templateValues: { density: "1.2" } },
        created_by: "REQ-01",
        created_at: "2026-05-01T08:00:00.000Z",
      },
      {
        id: 4,
        request_id: 77,
        request_no: "1000000077",
        approval_stage: "Approval 1",
        approved_by_user_id: "APP-01",
        approved_by_username: "approval.user.one",
        approve_remark: "older edit",
        approved_at: "2026-05-20T09:15:00.000Z",
        material_group_id: 12,
        material_sub_group_id: 110,
        plant_code: "P1",
        sloc_code: "S1",
        material_description: "Original desc",
        base_uom: "EA",
        long_text_1: null,
        long_text_2: null,
        long_text_3: null,
        template_payload: { templateValues: { density: "1.0" } },
        created_by: "REQ-01",
        created_at: "2026-05-01T08:00:00.000Z",
      },
    ]);
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestApprovalInbox falls back when edit history table is missing", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async queryText => {
      queryCalls.push(queryText);

      if (queryText === materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY) {
        const error = new Error('relation "mat_single_request_edit_history" does not exist');
        error.code = "42P01";
        throw error;
      }

      assert.equal(
        queryText,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_LEGACY_QUERY
      );

      return {
        rows: [
          {
            id: 88,
            status: "Submit",
            approval_1_status: "WAITING",
            approval_2_status: null,
            approval_3_status: null,
            approval_1_user_id: "APP-01",
            approval_2_user_id: null,
            approval_3_user_id: null,
            edit_history: [],
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestApprovalInbox("APP-01", "user.one");

    assert.deepEqual(queryCalls, [
      materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
      materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_LEGACY_QUERY,
    ]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].edit_history, []);
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestApprovalInbox falls back when rework columns are missing", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async queryText => {
      queryCalls.push(queryText);

      if (queryText === materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY) {
        const error = new Error('column r.rework_stage does not exist');
        error.code = "42703";
        throw error;
      }

      assert.equal(
        queryText,
        materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY
      );

      return {
        rows: [
          {
            id: 99,
            status: "Submit",
            approval_1_status: "WAITING",
            approval_2_status: null,
            approval_3_status: null,
            approval_1_user_id: "APP-01",
            approval_2_user_id: null,
            approval_3_user_id: null,
            rework_stage: null,
            rework_by_user_id: null,
            rework_at: null,
            rework_by_username: null,
            rework_reason: null,
            edit_history: [],
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestApprovalInbox("APP-01", "user.one");

    assert.deepEqual(queryCalls, [
      materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_QUERY,
      materialService.__private.GET_SINGLE_REQUEST_APPROVAL_INBOX_PRE_REWORK_QUERY,
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rework_stage, null);
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestsByUser falls back when rework columns are missing", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryCalls.push({ queryText, params });

      if (queryText === materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY) {
        const error = new Error('column r.rework_by_user_id does not exist');
        error.code = "42703";
        throw error;
      }

      assert.equal(
        queryText,
        materialService.__private.GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY
      );
      assert.deepEqual(params, ["REQ-01"]);

      return {
        rows: [
          {
            id: 71,
            requester_user_id: "REQ-01",
            rework_stage: null,
            rework_by_user_id: null,
            rework_at: null,
            rework_by_username: null,
            rework_reason: null,
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestsByUser("REQ-01");

    assert.deepEqual(
      queryCalls.map(call => call.queryText),
      [
        materialService.__private.GET_SINGLE_REQUEST_LIST_QUERY,
        materialService.__private.GET_SINGLE_REQUEST_LIST_PRE_REWORK_QUERY,
      ]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 71);
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestsByUser falls back when final_code column is missing", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryCalls.push({ queryText, params });

      if (/r\.final_code/i.test(queryText)) {
        const error = new Error("column r.final_code does not exist");
        error.code = "42703";
        throw error;
      }

      assert.doesNotMatch(queryText, /r\.final_code/i);
      assert.match(queryText, /NULL::varchar AS final_code/i);
      assert.deepEqual(params, ["REQ-01"]);

      return {
        rows: [
          {
            id: 72,
            requester_user_id: "REQ-01",
            final_code: null,
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestsByUser("REQ-01");

    assert.equal(queryCalls.length, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].final_code, null);
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestApprovalInbox falls back when final_code column is missing", async () => {
  const originalConnect = db.connect;
  const queryCalls = [];

  db.connect = async () => ({
    query: async queryText => {
      queryCalls.push(queryText);

      if (/r\.final_code/i.test(queryText)) {
        const error = new Error("column r.final_code does not exist");
        error.code = "42703";
        throw error;
      }

      assert.doesNotMatch(queryText, /r\.final_code/i);
      assert.match(queryText, /NULL::varchar AS final_code/i);

      return {
        rows: [
          {
            id: 73,
            requester_user_id: "REQ-01",
            final_code: null,
            approval_1_status: "WAITING",
            approval_1_user_id: "APP-01",
          },
        ],
      };
    },
    release: () => {},
  });

  try {
    const rows = await materialService.getSingleRequestApprovalInbox("APP-01", "user.one");

    assert.equal(queryCalls.length, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].final_code, null);
  } finally {
    db.connect = originalConnect;
  }
});

// Fixture for the inbox scope tests (IBE-009). Rebuilt per call because
// applyStepInboxVisibility attaches its step payload onto the rows in place.
//   901 => MDM step grabbed by another Master Data user
//   902 => MDM step grabbed by the acting Master Data user
//   903 => still on a MANUAL step owned by APP-09
//   904 => MDM step nobody has grabbed yet
//   905 => MDM step grabbed by another Master Data user, then reworked
//   906 => MDM step grabbed by another Master Data user, then rejected
//   907 => MDM step grabbed by another Master Data user, then approved
const buildMdmScopeInboxRows = () => [
  {
    id: 901,
    request_no: "1000000901",
    status: "Submit",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: "MDM-02",
        approver_name: "Master Data Two",
        status: "WAITING",
      },
    ],
  },
  {
    id: 902,
    request_no: "1000000902",
    status: "Submit",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: "MDM-01",
        approver_name: "Master Data One",
        status: "WAITING",
      },
    ],
  },
  {
    id: 903,
    request_no: "1000000903",
    status: "Submit",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-09",
        approver_name: "Approver Nine",
        status: "WAITING",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: null,
        approver_name: null,
        status: "WAITING",
      },
    ],
  },
  {
    id: 904,
    request_no: "1000000904",
    status: "Submit",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: null,
        approver_name: null,
        status: "WAITING",
      },
    ],
  },
  {
    id: 905,
    request_no: "1000000905",
    status: "Rework",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: "MDM-02",
        approver_name: "Master Data Two",
        status: "REWORK",
      },
    ],
  },
  {
    id: 906,
    request_no: "1000000906",
    status: "CANCEL",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: "MDM-02",
        approver_name: "Master Data Two",
        status: "REJECTED",
      },
    ],
  },
  {
    id: 907,
    request_no: "1000000907",
    status: "Done",
    approval_steps: [
      {
        level: 1,
        kind: "MANUAL",
        approver_user_id: "APP-77",
        approver_name: "Approver Seven Seven",
        status: "APPROVED",
      },
      {
        level: 2,
        kind: "MDM",
        approver_user_id: "MDM-02",
        approver_name: "Master Data Two",
        status: "APPROVED",
      },
    ],
  },
];

// Stub client for the inbox scope tests: the MDM_MATERIAL membership probe is
// the only other query the inbox path issues, and it decides authorization.
const connectMdmScopeInboxStub = isMdmMaterial => async () => ({
  query: async queryText => {
    if (/mst_page_access/i.test(queryText)) {
      return { rows: isMdmMaterial ? [{ exists: 1 }] : [], rowCount: isMdmMaterial ? 1 : 0 };
    }

    return { rows: buildMdmScopeInboxRows() };
  },
  release: () => {},
});

test("getSingleRequestApprovalInbox scope=mdmAll adds rows grabbed by another Master Data user", async () => {
  const originalConnect = db.connect;
  db.connect = connectMdmScopeInboxStub(true);

  try {
    const defaultRows = await materialService.getSingleRequestApprovalInbox(
      "MDM-01",
      "master.data.one"
    );
    const scopedRows = await materialService.getSingleRequestApprovalInbox(
      "MDM-01",
      "master.data.one",
      "mdmAll"
    );

    // 901 is the widening: grabbed by MDM-02, so it never reaches this user today.
    assert.deepEqual(
      defaultRows.map(row => row.id),
      [902, 904]
    );

    // Every request a Master Data user has ever grabbed, whatever the step's
    // status became afterwards: still waiting (901), reworked (905), rejected
    // (906), approved and finished (907). A grab is never released, so each of
    // these still names the Master Data user who took it.
    assert.deepEqual(
      scopedRows.map(row => row.id),
      [901, 902, 904, 905, 906, 907]
    );

    // Superset, so switching filters in the UI can never drop a row.
    assert.ok(
      defaultRows.every(row => scopedRows.some(scoped => scoped.id === row.id))
    );

    // MANUAL queues stay private even under the widened scope: 903 is parked on
    // Approval 1 and its Master Data step has never been grabbed.
    assert.ok(!scopedRows.some(row => row.id === 903));

    // The grabber's name has to ride along for the Assigned To column.
    const grabbedRow = scopedRows.find(row => row.id === 901);
    assert.equal(grabbedRow.approvalSteps[1].approverUserId, "MDM-02");
    assert.equal(grabbedRow.approvalSteps[1].approverName, "Master Data Two");
    assert.equal(grabbedRow.currentStageLabel, "Master Data");
  } finally {
    db.connect = originalConnect;
  }
});

test("getSingleRequestApprovalInbox scope=mdmAll is ignored for a non-Master-Data actor", async () => {
  const originalConnect = db.connect;
  db.connect = connectMdmScopeInboxStub(false);

  try {
    const defaultRows = await materialService.getSingleRequestApprovalInbox(
      "APP-09",
      "approval.user.nine"
    );
    const scopedRows = await materialService.getSingleRequestApprovalInbox(
      "APP-09",
      "approval.user.nine",
      "mdmAll"
    );

    // Authorization is decided server-side off the DB membership probe, so the
    // param buys a manual approver nothing.
    assert.deepEqual(
      defaultRows.map(row => row.id),
      [903]
    );
    assert.deepEqual(
      scopedRows.map(row => row.id),
      defaultRows.map(row => row.id)
    );
  } finally {
    db.connect = originalConnect;
  }
});

test("approveSingleRequestByAdmin still forbids a Master Data step grabbed by another Master Data user", async () => {
  const grabbedSteps = [
    {
      id: 9011,
      request_id: 901,
      level: 1,
      kind: "MANUAL",
      approver_user_id: "APP-77",
      approver_name: "Approver Seven Seven",
      status: "APPROVED",
    },
    {
      id: 9012,
      request_id: 901,
      level: 2,
      kind: "MDM",
      approver_user_id: "MDM-02",
      approver_name: "Master Data Two",
      status: "WAITING",
    },
  ];

  // The widened scope makes this row visible...
  assert.equal(materialService.hasGrabbedMdmStep(grabbedSteps), true);

  // ...while permission is unchanged: visibility is not permission.
  assert.equal(
    materialService.canActorActOnStep(materialService.resolveActiveStep(grabbedSteps), {
      actorUserId: "MDM-01",
      actorUsername: "master.data.one",
      actorIsMdmMaterial: true,
    }),
    false
  );

  const originalConnect = db.connect;
  const queryLog = [];

  db.connect = async () => ({
    query: async queryText => {
      queryLog.push(queryText);

      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 901,
              request_no: "1000000901",
              status: "Submit",
              ticket_type: "CREATE",
              created_by: "REQ-01",
              material_group_id: 12,
              material_group_code: "901",
            },
          ],
        };
      }

      if (/FOR UPDATE OF s/.test(queryText)) {
        return { rows: grabbedSteps };
      }

      if (/mst_page_access/i.test(queryText)) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    await assert.rejects(
      materialService.approveSingleRequestByAdmin({
        requestId: 901,
        actorUserId: "MDM-01",
        actorUsername: "master.data.one",
        remark: "approving somebody else's grabbed row",
      }),
      error => {
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, "SINGLE_REQUEST_APPROVAL_FORBIDDEN");
        return true;
      }
    );

    assert.ok(queryLog.includes("ROLLBACK"));
    assert.ok(!queryLog.includes("COMMIT"));
  } finally {
    db.connect = originalConnect;
  }
});

test("approveSingleRequestByAdmin stores original request creator metadata in edit history", async () => {
  const originalConnect = db.connect;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  const queryLog = [];
  let insertHistoryParams = null;
  const snapshotCreatedAt = new Date("2026-05-01T08:00:00.000Z");

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryLog.push({ queryText, params });

      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              assigned_to: "Approval 1",
              created_by: "REQ-01",
              created_at: snapshotCreatedAt,
              status: "Submit",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: null,
              approval_1_status: "WAITING",
              approval_1_remark: null,
              approval_2_user_id: "APP-02",
              approval_2_at: null,
              approval_2_status: "WAITING",
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_at: null,
              approval_3_status: null,
              approval_3_remark: null,
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              long_text_1: "old1",
              long_text_2: null,
              long_text_3: null,
              template_payload: {
                requestFields: { material_description: "Original desc" },
                templateValues: { density: "1.0" },
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (/INSERT INTO mat_single_request_edit_history/i.test(queryText)) {
        insertHistoryParams = params;
        return { rows: [], rowCount: 1 };
      }

      if (/SET material_description = \$2, base_uom = \$3, template_payload = \$4,[\s\S]*updated_at = NOW\(\)/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      if (/SET approval_1_user_id = COALESCE\(approval_1_user_id, \$2\),[\s\S]*COALESCE\(approval_1_status, 'WAITING'\) = 'WAITING'/i.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              approval_1_user_id: "APP-01",
              approval_1_status: "APPROVED",
              approval_1_at: "2026-05-20 12:00",
              approval_1_remark: "approved with edit",
              approval_2_user_id: "APP-02",
              approval_2_status: "WAITING",
              approval_2_at: null,
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_status: null,
              approval_3_at: null,
              approval_3_remark: null,
            },
          ],
          rowCount: 1,
        };
      }

      if (/SET assigned_to = \$2,/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  materialService.getSubGroupById = async () => ({
    id: 110,
    item_group_id: 12,
    deleted_at: null,
  });
  MaterialTemplate.validateMaterialRequestTemplate = async ({
    requestFields,
    templateValues,
  }) => ({
    errors: [],
    materialDescription: requestFields.material_description,
    normalizedRequestFields: {
      material_description: requestFields.material_description,
      base_unit_of_measure: requestFields.base_unit_of_measure,
      plant: requestFields.plant,
      storage_location: requestFields.storage_location,
      long_text_1: requestFields.long_text_1,
    },
    normalizedTemplateValues: templateValues,
  });

  try {
    await materialService.approveSingleRequestByAdmin({
      requestId: 77,
      actorUserId: "APP-01",
      actorUsername: "user.one",
      remark: "approved with edit",
      editedRequest: {
        material_description: "Changed desc",
        base_uom: "KG",
        template_payload: { templateValues: { density: "1.2" } },
      },
    });

    assert.ok(insertHistoryParams);
    assert.equal(insertHistoryParams.length, 17);
    assert.equal(insertHistoryParams[0], 77);
    assert.equal(insertHistoryParams[1], "1000000077");
    assert.equal(insertHistoryParams[2], "Approval 1");
    assert.equal(insertHistoryParams[3], "APP-01");
    assert.equal(insertHistoryParams[4], "approved with edit");
    assert.equal(insertHistoryParams[5], 12);
    assert.equal(insertHistoryParams[6], 110);
    assert.equal(insertHistoryParams[7], "P1");
    assert.equal(insertHistoryParams[8], "S1");
    assert.equal(insertHistoryParams[9], "Original desc");
    assert.equal(insertHistoryParams[10], "EA");
    assert.equal(insertHistoryParams[11], "old1");
    assert.equal(insertHistoryParams[12], null);
    assert.equal(insertHistoryParams[13], null);
    assert.deepEqual(insertHistoryParams[14], {
      requestFields: { material_description: "Original desc" },
      templateValues: { density: "1.0" },
    });
    assert.equal(insertHistoryParams[15], "REQ-01");
    assert.equal(insertHistoryParams[16], snapshotCreatedAt);
    assert.notEqual(insertHistoryParams[15], "APP-01");

    const historyInsert = queryLog.find(entry =>
      /INSERT INTO mat_single_request_edit_history/i.test(entry.queryText)
    );
    assert.ok(historyInsert);
    assert.match(
      historyInsert.queryText,
      /\$15, \$16, \$17/
    );
    assert.doesNotMatch(
      historyInsert.queryText,
      /\$15, \$16, NOW\(\)/
    );
  } finally {
    db.connect = originalConnect;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
  }
});

test("approveSingleRequestByAdmin auto-assigns Approval 3 for Change when MDM user is available", async () => {
  const originalConnect = db.connect;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              assigned_to: "Approval 1",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Submit",
              ticket_type: "Change",
              material_code: "MAT-001",
              change_extend_reason: "Need update",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: null,
              approval_1_status: "WAITING",
              approval_1_remark: null,
              approval_2_user_id: null,
              approval_2_at: null,
              approval_2_status: "APPROVED",
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_at: null,
              approval_3_status: "WAITING",
              approval_3_remark: null,
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              long_text_1: null,
              long_text_2: null,
              long_text_3: null,
              template_payload: {
                requestFields: { material_description: "Original desc" },
                templateValues: {},
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (/SELECT approval_3_user_id\s+FROM mat_single_request_approval/i.test(queryText)) {
        return { rows: [{ approval_3_user_id: "MDM-01" }], rowCount: 1 };
      }

      if (/FROM mst_user mu[\s\S]*JOIN mst_page_access/i.test(queryText)) {
        return {
          rows: [{ user_id: "MDM-01" }],
          rowCount: 1,
        };
      }

      if (/UPDATE mat_single_request\s+SET approval_1_user_id = COALESCE\(approval_1_user_id, \$2\),[\s\S]*approval_3_user_id = \$4,[\s\S]*approval_3_status = 'WAITING'/i.test(queryText)) {
        assert.deepEqual(params, [77, "APP-01", "approved", "MDM-01"]);
        return {
          rows: [
            {
              request_id: 77,
              approval_1_user_id: "APP-01",
              approval_1_status: "APPROVED",
              approval_1_at: "2026-05-20 12:00",
              approval_1_remark: "approved",
              approval_2_user_id: null,
              approval_2_status: "APPROVED",
              approval_2_at: null,
              approval_2_remark: null,
              approval_3_user_id: "MDM-01",
              approval_3_status: "WAITING",
              approval_3_at: null,
              approval_3_remark: null,
            },
          ],
          rowCount: 1,
        };
      }

      if (/SET assigned_to = \$2,/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  materialService.getSubGroupById = async () => ({ id: 110, item_group_id: 12, deleted_at: null });
  MaterialTemplate.validateMaterialRequestTemplate = async ({ requestFields, templateValues }) => ({
    errors: [],
    materialDescription: requestFields.material_description,
    normalizedRequestFields: {
      material_description: requestFields.material_description,
      base_unit_of_measure: requestFields.base_unit_of_measure,
    },
    normalizedTemplateValues: templateValues,
  });

  try {
    const result = await materialService.approveSingleRequestByAdmin({
      requestId: 77,
      actorUserId: "APP-01",
      actorUsername: "approver.user",
      remark: "approved",
      editedRequest: null,
    });

  assert.deepEqual(result, {
    request_id: 77,
    stage: "Approval 1",
    next_stage: "Approval 3",
    approval_3_user_id: "MDM-01",
    approval_3_status: "WAITING",
  });
  } finally {
    db.connect = originalConnect;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate = originalValidateMaterialRequestTemplate;
  }
});

test("approveSingleRequestByAdmin skips history insert when edit-history table is missing", async () => {
  const originalConnect = db.connect;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  const originalWarn = console.warn;
  const queryLog = [];
  const warnings = [];

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryLog.push({ queryText, params });

      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              assigned_to: "Approval 1",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Submit",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: null,
              approval_1_status: "WAITING",
              approval_1_remark: null,
              approval_2_user_id: "APP-02",
              approval_2_at: null,
              approval_2_status: "WAITING",
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_at: null,
              approval_3_status: null,
              approval_3_remark: null,
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              long_text_1: "old1",
              long_text_2: null,
              long_text_3: null,
              template_payload: {
                requestFields: { material_description: "Original desc" },
                templateValues: { density: "1.0" },
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (/INSERT INTO mat_single_request_edit_history/i.test(queryText)) {
        const error = new Error(
          'relation "mat_single_request_edit_history" does not exist'
        );
        error.code = "42P01";
        throw error;
      }

      if (/SET material_description = \$2, base_uom = \$3, template_payload = \$4,[\s\S]*updated_at = NOW\(\)/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      if (/SET approval_1_user_id = COALESCE\(approval_1_user_id, \$2\),[\s\S]*COALESCE\(approval_1_status, 'WAITING'\) = 'WAITING'/i.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              approval_1_user_id: "APP-01",
              approval_1_status: "APPROVED",
              approval_1_at: "2026-05-20 12:00",
              approval_1_remark: "approved with edit",
              approval_2_user_id: "APP-02",
              approval_2_status: "WAITING",
              approval_2_at: null,
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_status: null,
              approval_3_at: null,
              approval_3_remark: null,
            },
          ],
          rowCount: 1,
        };
      }

      if (/SET assigned_to = \$2,/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  materialService.getSubGroupById = async () => ({
    id: 110,
    item_group_id: 12,
    deleted_at: null,
  });
  MaterialTemplate.validateMaterialRequestTemplate = async ({
    requestFields,
    templateValues,
  }) => ({
    errors: [],
    materialDescription: requestFields.material_description,
    normalizedRequestFields: {
      material_description: requestFields.material_description,
      base_unit_of_measure: requestFields.base_unit_of_measure,
      plant: requestFields.plant,
      storage_location: requestFields.storage_location,
      long_text_1: requestFields.long_text_1,
    },
    normalizedTemplateValues: templateValues,
  });
  console.warn = message => {
    warnings.push(message);
  };

  try {
    const result = await materialService.approveSingleRequestByAdmin({
      requestId: 77,
      actorUserId: "APP-01",
      actorUsername: "user.one",
      remark: "approved with edit",
      editedRequest: {
        material_description: "Changed desc",
        base_uom: "KG",
        template_payload: { templateValues: { density: "1.2" } },
      },
    });

    assert.deepEqual(result, {
      request_id: 77,
      stage: "Approval 1",
      next_stage: "Approval 2",
    });
    assert.equal(
      queryLog.some(entry =>
        /INSERT INTO mat_single_request_edit_history/i.test(entry.queryText)
      ),
      true
    );
    assert.equal(
      queryLog.some(entry =>
        /SET material_description = \$2, base_uom = \$3, template_payload = \$4,[\s\S]*updated_at = NOW\(\)/i.test(
          entry.queryText
        )
      ),
      true
    );
    assert.equal(
      warnings.some(message =>
        /mat_single_request_edit_history is missing/.test(message)
      ),
      true
    );
  } finally {
    db.connect = originalConnect;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
    console.warn = originalWarn;
  }
});

test("createSingleRequest stores aligned insert values for Extend and auto-assigns MDM approval 3 when available", async () => {
  const originalConnect = db.connect;
  const originalExistsSync = require("fs").existsSync;
  const originalMkdirSync = require("fs").mkdirSync;
  const originalReadFileSync = require("fs").readFileSync;
  const originalWriteFileSync = require("fs").writeFileSync;
  let insertParams = null;

  require("fs").existsSync = () => true;
  require("fs").mkdirSync = () => {};
  require("fs").readFileSync = () => Buffer.from("stub");
  require("fs").writeFileSync = () => {};

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/nextval\(pg_get_serial_sequence\('mat_single_request', 'id'\)\)/i.test(queryText)) {
        return { rows: [{ next_id: 77 }], rowCount: 1 };
      }

      if (/SELECT approval_1_user_id, approval_2_user_id(?:,\s*approval_3_user_id)?\s+FROM mat_single_request_approval/i.test(queryText)) {
        return { rows: [{ approval_1_user_id: null, approval_2_user_id: null, approval_3_user_id: "MDM-01" }], rowCount: 1 };
      }

      if (/FROM mst_user mu[\s\S]*JOIN mst_page_access/i.test(queryText)) {
        return {
          rows: [{ user_id: "MDM-01" }],
          rowCount: 1,
        };
      }

      if (/INSERT INTO mat_single_request\s*\(/i.test(queryText)) {
        insertParams = params;
        return {
          rows: [
            {
              id: 77,
              request_no: "1000000077",
              ticket_type: "Extend",
              material_code: "MAT-001",
              change_extend_reason: "Open new storage",
              material_description: null,
              base_uom: null,
              status: "Submit",
               assigned_to: "Approval 3",
               created_by: "REQ-01",
               created_at: new Date("2026-05-26T00:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    const result = await materialService.createSingleRequest({
      ticketType: "Extend",
      materialCode: "MAT-001",
      changeExtendReason: "Open new storage",
      materialGroupId: 21,
      materialSubGroupId: 210,
      requestFields: {
        plant: "P1",
        storage_location: "S1",
      },
      templateValues: {},
      attachments: [],
      createdBy: "REQ-01",
      createdByUsername: "requester.user",
    });

    assert.equal(result.ticket_type, "Extend");
    assert.ok(insertParams);
      assert.equal(insertParams.length, 22);
      assert.deepEqual(insertParams, [
      77,
      "1000000077",
      "Extend",
      "Open new storage",
      21,
      210,
      "P1",
      "S1",
      undefined,
      undefined,
      null,
      null,
      null,
      JSON.stringify({
        requestFields: {
          plant: "P1",
          storage_location: "S1",
          material_number: "MAT-001",
        },
        templateValues: {},
      }),
      "Approval 3",
      "REQ-01",
      null,
      "APPROVED",
      null,
      "APPROVED",
      "MDM-01",
      "WAITING",
    ]);
  } finally {
    db.connect = originalConnect;
    require("fs").existsSync = originalExistsSync;
    require("fs").mkdirSync = originalMkdirSync;
    require("fs").readFileSync = originalReadFileSync;
    require("fs").writeFileSync = originalWriteFileSync;
  }
});

test("createMassRequest stores attachments under item request number path", async () => {
  const originalConnect = db.connect;
  const originalExistsSync = require("fs").existsSync;
  const originalMkdirSync = require("fs").mkdirSync;
  const originalReadFileSync = require("fs").readFileSync;
  const originalWriteFileSync = require("fs").writeFileSync;
  let insertedAttachmentParams = null;
  const writtenFilePaths = [];

  require("fs").existsSync = () => true;
  require("fs").mkdirSync = () => {};
  require("fs").readFileSync = () => Buffer.from("stub");
  require("fs").writeFileSync = filepath => {
    writtenFilePaths.push(String(filepath).replace(/\\/g, "/"));
  };

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/nextval\(pg_get_serial_sequence\('mat_mass_request', 'id'\)\)/i.test(queryText)) {
        return { rows: [{ next_id: 15 }], rowCount: 1 };
      }

      if (/SELECT approval_1_user_id, approval_2_user_id, approval_3_user_id\s+FROM mat_single_request_approval/i.test(queryText)) {
        return { rows: [], rowCount: 0 };
      }

      if (/INSERT INTO mat_mass_request\s*\(/i.test(queryText)) {
        return {
          rows: [
            {
              id: 15,
              mass_request_no: "2000000015",
              item_count: 1,
              mass_request_reason: "Project",
              created_by: "REQ-01",
              created_by_username: "requester.user",
              created_at: new Date("2026-06-05T09:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }

      if (/nextval\(pg_get_serial_sequence\('mat_mass_request_item', 'id'\)\)/i.test(queryText)) {
        return { rows: [{ next_id: 88 }], rowCount: 1 };
      }

      if (/INSERT INTO mat_mass_request_item\s*\(/i.test(queryText)) {
        return {
          rows: [
            {
              id: 88,
              item_no: 1,
              request_no: "2000000088",
              ticket_type: "Create",
              status: "Submit",
              assigned_to: "Approval 1",
              created_by: "REQ-01",
              created_at: new Date("2026-06-05T09:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }

      if (/INSERT INTO mat_mass_request_attachment\s*\(/i.test(queryText)) {
        insertedAttachmentParams = params;
        return {
          rows: [
            {
              id: 501,
              file_name: params[1],
              file_path: params[2],
              file_type: params[3],
              created_at: new Date("2026-06-05T09:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    const result = await materialService.createMassRequest({
      rows: [
        {
          plant: "P1",
          sloc: "S1",
          materialGroup: "CHEM",
          materialSubGroup: "SUB",
          description: "Spec sheet",
          poText: "PO",
          uom: "EA",
          spesifikasiTambahan: "Spec",
        },
      ],
      attachmentsByRow: [
        [
          {
            tempPath: "C:\\tmp\\spec.pdf",
            originalName: "spec.pdf",
            newName: "1717578000001_spec.pdf",
            mimeType: "application/pdf",
          },
        ],
      ],
      createdBy: "REQ-01",
      createdByUsername: "requester.user",
      massRequestReason: "Project",
    });

    assert.deepEqual(insertedAttachmentParams, [
      88,
      "spec.pdf",
      "attachments/mass-request/2026-06-05/2000000088/1717578000001_spec.pdf",
      "application/pdf",
    ]);
    assert.equal(
      result.items[0].attachments[0].file_path,
      "attachments/mass-request/2026-06-05/2000000088/1717578000001_spec.pdf"
    );
    assert.match(
      writtenFilePaths[0],
      /\/attachments\/mass-request\/2026-06-05\/2000000088\/1717578000001_spec\.pdf$/
    );
  } finally {
    db.connect = originalConnect;
    require("fs").existsSync = originalExistsSync;
    require("fs").mkdirSync = originalMkdirSync;
    require("fs").readFileSync = originalReadFileSync;
    require("fs").writeFileSync = originalWriteFileSync;
  }
});

test("material model exposes single request rework and detail methods", () => {
  assert.equal(typeof materialService.requestSingleRequestRework, "function");
  assert.equal(typeof materialService.saveSingleRequestRework, "function");
  assert.equal(typeof materialService.getSingleRequestById, "function");
});

test("approval edit preparation scopes Change and Extend rework fields", () => {
  const source = materialService.__private.prepareSingleRequestApprovalEditPatch.toString();
  assert.match(source, /ticket_type|ticketType/i);
  assert.match(source, /change_extend_reason/i);
  assert.match(source, /material_number/i);
});

test("controller exports single request detail and rework handlers", () => {
  assert.equal(typeof MaterialController.getSingleRequestById, "function");
  assert.equal(typeof MaterialController.requestSingleRequestRework, "function");
  assert.equal(typeof MaterialController.saveSingleRequestRework, "function");
});

test("controller detail and rework handlers forward params and cookies", () => {
  assert.match(MaterialController.getSingleRequestById.toString(), /req\.params\.id/);
  assert.match(
    MaterialController.requestSingleRequestRework.toString(),
    /req\.body\?\.reason\s*\?\?\s*null/
  );
  assert.match(
    MaterialController.saveSingleRequestRework.toString(),
    /req\.body\?\.editedRequest\s*\?\?\s*null/
  );
  assert.match(
    MaterialController.saveSingleRequestRework.toString(),
    /multipart\/form-data/
  );
  assert.match(
    MaterialController.saveSingleRequestRework.toString(),
    /req\.body\?\.attachments != null/
  );
});

test("single request detail route is registered after inbox and approver master routes", () => {
  const routeSource = require("fs").readFileSync(
    require("path").join(__dirname, "../routes/MaterialRoute.js"),
    "utf8"
  );

  const detailRouteIndex = routeSource.indexOf('"/requests/single/:id"');
  const inboxRouteIndex = routeSource.indexOf('"/requests/single/approval-inbox"');
  const approverMasterRouteIndex = routeSource.indexOf('"/requests/single/approver-masters"');

  assert.notEqual(detailRouteIndex, -1);
  assert.notEqual(inboxRouteIndex, -1);
  assert.notEqual(approverMasterRouteIndex, -1);
  assert.ok(detailRouteIndex > inboxRouteIndex);
  assert.ok(detailRouteIndex > approverMasterRouteIndex);
});

test("single request rework routes are registered after detail route", () => {
  const routeSource = require("fs").readFileSync(
    require("path").join(__dirname, "../routes/MaterialRoute.js"),
    "utf8"
  );

  const detailRouteIndex = routeSource.indexOf('"/requests/single/:id"');
  const reworkPostRouteIndex = routeSource.indexOf('"/requests/single/:id/rework"');
  const approveRouteIndex = routeSource.indexOf('"/requests/single/:id/approve"');
  const reworkRouteMatches =
    routeSource.match(/"\/requests\/single\/:id\/rework"/g) || [];

  assert.notEqual(reworkPostRouteIndex, -1);
  assert.ok(reworkPostRouteIndex > detailRouteIndex);
  assert.ok(reworkPostRouteIndex > approveRouteIndex);
  assert.equal(reworkRouteMatches.length, 2);
});

test("Material exposes rejectSingleRequestByAdmin", () => {
  assert.equal(typeof materialService.rejectSingleRequestByAdmin, "function");
});

test("MaterialController exposes rejectSingleRequest", () => {
  assert.equal(typeof MaterialController.rejectSingleRequest, "function");
});

test("rejectSingleRequest controller delegates request id, actor, and reason", () => {
  const source = MaterialController.rejectSingleRequest.toString();

  assert.match(source, /materialService\.rejectSingleRequestByAdmin/);
  assert.match(source, /requestId:\s*req\.params\.id/);
  assert.match(source, /actorUserId:\s*req\.cookies\.user_id/);
  assert.match(source, /actorUsername:\s*req\.cookies\.username/);
  assert.match(source, /reason:\s*req\.body\?\.reason\s*\?\?\s*null/);
});

test("rejectSingleRequest controller preserves backend validation metadata", async () => {
  const originalRejectSingleRequestByAdmin =
    materialService.rejectSingleRequestByAdmin;

  materialService.rejectSingleRequestByAdmin = async () => {
    const error = new Error("reject reason is required");
    error.statusCode = 400;
    error.code = "REJECT_REASON_REQUIRED";
    error.errors = [
      {
        fieldKey: "reason",
        message: "reject reason is required",
      },
    ];
    throw error;
  };

  const response = {
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
    await MaterialController.rejectSingleRequest(
      {
        params: { id: "77" },
        cookies: { user_id: "APP-01", username: "approver.user" },
        body: { reason: "   " },
      },
      response
    );

    assert.equal(response.statusCode, 400);
    assert.equal(response.jsonPayload.message, "reject reason is required");
    assert.equal(response.jsonPayload.code, "REJECT_REASON_REQUIRED");
    assert.deepEqual(response.jsonPayload.errors, [
      {
        fieldKey: "reason",
        message: "reject reason is required",
      },
    ]);
  } finally {
    materialService.rejectSingleRequestByAdmin = originalRejectSingleRequestByAdmin;
  }
});

test("MaterialRoute registers single request reject endpoint", () => {
  const routeSource = require("fs").readFileSync(
    require("path").join(__dirname, "../routes/MaterialRoute.js"),
    "utf8"
  );

  assert.match(routeSource, /\/requests\/single\/:id\/reject/);
  assert.match(routeSource, /MaterialController\.rejectSingleRequest/);
});

test("updateSingleRequestColumns inlines SQL timestamp expressions instead of binding string literals", async () => {
  const calls = [];
  const client = {
    query: async (queryText, params) => {
      calls.push({ queryText, params });
      return { rows: [], rowCount: 1 };
    },
  };

  await materialService.__private.updateSingleRequestColumns(client, 77, {
    status: "Rework",
    assigned_to: "Requester",
    rework_stage: "Approval 1",
    rework_by_user_id: "APP-01",
    rework_at: { __sql: "NOW()" },
    rework_reason: "Need revision",
    approval_1_status: "REWORK",
    approval_1_remark: "Need revision",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].queryText, /rework_at = NOW\(\)/);
  assert.equal(calls[0].params.includes("NOW()"), false);
});

test("saveSingleRequestRework keeps requested attachments and appends new uploads safely", async () => {
  const originalConnect = db.connect;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  const originalExistsSync = require("fs").existsSync;
  const originalMkdirSync = require("fs").mkdirSync;
  const originalReadFileSync = require("fs").readFileSync;
  const originalWriteFileSync = require("fs").writeFileSync;
  const originalUnlinkSync = require("fs").unlinkSync;
  const queryLog = [];
  const deletedAttachmentParams = [];
  let insertedAttachmentParams = null;

  require("fs").existsSync = pathValue =>
    String(pathValue).includes("single-request");
  require("fs").mkdirSync = () => {};
  require("fs").readFileSync = () => Buffer.from("pdf");
  require("fs").writeFileSync = () => {};
  require("fs").unlinkSync = () => {};

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryLog.push({ queryText, params });

      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Rework",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: null,
              approval_1_status: "REWORK",
              approval_1_remark: "Need update",
              approval_2_user_id: "APP-02",
              approval_2_at: null,
              approval_2_status: "WAITING",
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_at: null,
              approval_3_status: null,
              approval_3_remark: null,
              rework_stage: "Approval 1",
              rework_by_user_id: "APP-01",
              rework_at: new Date("2026-05-21T08:00:00.000Z"),
              rework_reason: "Need update",
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              long_text_1: "old1",
              long_text_2: null,
              long_text_3: null,
              template_payload: {
                requestFields: { material_description: "Original desc" },
                templateValues: { density: "1.0" },
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (/SELECT id, file_name, file_path, file_type\s+FROM mat_single_request_attachment/i.test(queryText)) {
        return {
          rows: [
            {
              id: 10,
              file_name: "keep.pdf",
              file_path: "single-request-attachments/CHEM/SUB/keep.pdf",
              file_type: "application/pdf",
            },
            {
              id: 11,
              file_name: "drop.pdf",
              file_path: "single-request-attachments/CHEM/SUB/drop.pdf",
              file_type: "application/pdf",
            },
          ],
          rowCount: 2,
        };
      }

      if (/UPDATE mat_single_request[\s\S]*rework_stage = \$\d[\s\S]*updated_at = NOW\(\)/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      if (/DELETE FROM mat_single_request_attachment\s+WHERE request_id = \$1 AND id = ANY/i.test(queryText)) {
        deletedAttachmentParams.push(params);
        return { rows: [], rowCount: 1 };
      }

      if (/INSERT INTO mat_single_request_attachment/i.test(queryText)) {
        insertedAttachmentParams = params;
        return { rows: [{ id: 12 }], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  materialService.getSubGroupById = async () => ({
    id: 110,
    item_group_id: 12,
    deleted_at: null,
  });
  MaterialTemplate.validateMaterialRequestTemplate = async ({
    requestFields,
    templateValues,
  }) => ({
    errors: [],
    materialDescription: requestFields.material_description,
    normalizedRequestFields: {
      material_description: requestFields.material_description,
      base_unit_of_measure: requestFields.base_unit_of_measure,
      plant: requestFields.plant,
      storage_location: requestFields.storage_location,
      long_text_1: requestFields.long_text_1,
    },
    normalizedTemplateValues: templateValues,
  });

  try {
    const result = await materialService.saveSingleRequestRework({
      requestId: 77,
      actorUserId: "REQ-01",
      actorUsername: "requester.user",
      editedRequest: {
        material_description: "Changed desc",
        base_uom: "KG",
        template_payload: { templateValues: { density: "1.2" } },
      },
      attachments: {
        keepAttachmentIds: [10],
        newAttachments: [
          {
            tempPath: "C:\\tmp\\new-file.pdf",
            originalName: "new-file.pdf",
            newName: "1778000000001_new-file.pdf",
            mimeType: "application/pdf",
          },
        ],
      },
    });

    assert.deepEqual(result, {
      request_id: 77,
      stage: "Approval 1",
      status: "Submit",
    });
    assert.equal(deletedAttachmentParams.length, 1);
    assert.deepEqual(deletedAttachmentParams[0], [77, [11]]);
    assert.equal(insertedAttachmentParams[0], 77);
    assert.equal(insertedAttachmentParams[1], "new-file.pdf");
    assert.match(
      insertedAttachmentParams[2],
      /^attachments\/single-request\/2026-05-01\/1000000077\/1778000000001_new-file\.pdf$/
    );
    assert.equal(insertedAttachmentParams[3], "application/pdf");
    assert.equal(
      queryLog.some(
        entry =>
          entry.queryText ===
          "DELETE FROM mat_single_request_attachment WHERE request_id = $1"
      ),
      false
    );
  } finally {
    db.connect = originalConnect;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
    require("fs").existsSync = originalExistsSync;
    require("fs").mkdirSync = originalMkdirSync;
    require("fs").readFileSync = originalReadFileSync;
    require("fs").writeFileSync = originalWriteFileSync;
    require("fs").unlinkSync = originalUnlinkSync;
  }
});

test("saveSingleRequestRework rejects attachment mutation for Change tickets", async () => {
  const originalConnect = db.connect;

  db.connect = async () => ({
    query: async queryText => {
      if (queryText === "BEGIN" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Rework",
              ticket_type: "Change",
              material_code: "MAT-001",
              change_extend_reason: "Need update",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_status: "REWORK",
              approval_2_status: "APPROVED",
              approval_3_status: "WAITING",
              rework_stage: "Approval 1",
              rework_by_user_id: "APP-01",
              rework_reason: "Need update",
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              template_payload: { requestFields: {}, templateValues: {} },
            },
          ],
          rowCount: 1,
        };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    await assert.rejects(
      () =>
        materialService.saveSingleRequestRework({
          requestId: 77,
          actorUserId: "REQ-01",
          actorUsername: "requester.user",
          editedRequest: {
            changeExtendReason: "Need update",
          },
          attachments: {
            keepAttachmentIds: [10],
            newAttachments: [],
          },
        }),
      error => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /do not support attachments/i);
        return true;
      }
    );
  } finally {
    db.connect = originalConnect;
  }
});

test("saveSingleRequestRework persists selected material group for rework edits", async () => {
  const originalConnect = db.connect;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalValidateMaterialRequestTemplate =
    MaterialTemplate.validateMaterialRequestTemplate;
  const queryLog = [];
  let validationMaterialGroupCode = null;

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      queryLog.push({ queryText, params });

      if (queryText === "BEGIN" || queryText === "COMMIT" || queryText === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 77,
              request_no: "1000000077",
              created_by: "REQ-01",
              created_at: new Date("2026-05-01T08:00:00.000Z"),
              status: "Rework",
              material_group_code: "CHEM",
              requester_user_id: "REQ-01",
              approval_1_user_id: "APP-01",
              approval_1_at: null,
              approval_1_status: "REWORK",
              approval_1_remark: "Need update",
              approval_2_user_id: "APP-02",
              approval_2_at: null,
              approval_2_status: "WAITING",
              approval_2_remark: null,
              approval_3_user_id: null,
              approval_3_at: null,
              approval_3_status: null,
              approval_3_remark: null,
              rework_stage: "Approval 1",
              rework_by_user_id: "APP-01",
              rework_at: new Date("2026-05-21T08:00:00.000Z"),
              rework_reason: "Need update",
              material_group_id: 12,
              material_sub_group_id: 110,
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              long_text_1: "old1",
              long_text_2: null,
              long_text_3: null,
              template_payload: {
                requestFields: { material_description: "Original desc" },
                templateValues: { density: "1.0" },
              },
            },
          ],
          rowCount: 1,
        };
      }

      if (
        /UPDATE mat_single_request[\s\S]*material_group_id = \$\d/i.test(queryText) &&
        /UPDATE mat_single_request[\s\S]*material_sub_group_id = \$\d/i.test(queryText) &&
        /updated_at = NOW\(\)/i.test(queryText)
      ) {
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  materialService.getSubGroupById = async () => ({
    id: 210,
    item_group_id: 21,
    deleted_at: null,
  });
  MaterialTemplate.validateMaterialRequestTemplate = async ({
    materialGroupCode,
    requestFields,
    templateValues,
  }) => {
    validationMaterialGroupCode = materialGroupCode;
    return {
      errors: [],
      materialDescription: requestFields.material_description,
      normalizedRequestFields: {
        material_description: requestFields.material_description,
        base_unit_of_measure: requestFields.base_unit_of_measure,
        plant: requestFields.plant,
        storage_location: requestFields.storage_location,
      },
      normalizedTemplateValues: templateValues,
    };
  };

  try {
    const result = await materialService.saveSingleRequestRework({
      requestId: 77,
      actorUserId: "REQ-01",
      actorUsername: "requester.user",
      editedRequest: {
        material_group_id: 21,
        material_group_code: "PACK",
        material_sub_group_id: 210,
        material_description: "Changed desc",
        base_uom: "KG",
        template_payload: { templateValues: { density: "1.2" } },
      },
    });

    assert.deepEqual(result, {
      request_id: 77,
      stage: "Approval 1",
      status: "Submit",
    });
    assert.equal(validationMaterialGroupCode, "PACK");
    assert.equal(
      queryLog.some(
        entry =>
          /UPDATE mat_single_request[\s\S]*material_group_id = \$\d/i.test(
            entry.queryText
          ) &&
          /UPDATE mat_single_request[\s\S]*material_sub_group_id = \$\d/i.test(
            entry.queryText
          ) &&
          /updated_at = NOW\(\)/i.test(entry.queryText) &&
          entry.params.includes(21) &&
          entry.params.includes(210)
      ),
      true
    );
  } finally {
    db.connect = originalConnect;
    materialService.getSubGroupById = originalGetSubGroupById;
    MaterialTemplate.validateMaterialRequestTemplate =
      originalValidateMaterialRequestTemplate;
  }
});

test("saveSingleRequestRework controller parses multipart keepAttachmentIds and uploaded files", async () => {
  const formidable = require("formidable");
  const fs = require("fs");
  const originalIncomingForm = formidable.IncomingForm;
  const originalExistsSync = fs.existsSync;
  const originalUnlinkSync = fs.unlinkSync;
  const originalGetMaterialGroupByCode = materialService.getMaterialGroupByCode;
  const originalGetSubGroupById = materialService.getSubGroupById;
  const originalSaveSingleRequestRework = materialService.saveSingleRequestRework;
  const unlinked = [];
  let receivedPayload = null;

  formidable.IncomingForm = function IncomingFormStub() {
    this.options = {};
    this.parse = async () => [
      {
        materialGroupCode: "CHEM",
        subgroup: "110",
        requestFields: JSON.stringify({
          material_description: "Changed desc",
          base_unit_of_measure: "KG",
          plant: "P1",
          storage_location: "S1",
        }),
        templateValues: JSON.stringify({ density: "1.2" }),
        attachments: JSON.stringify({ keepAttachmentIds: [10] }),
      },
      {
        files: [
          {
            filepath: "C:\\tmp\\upload-1.pdf",
            originalFilename: "upload-1.pdf",
          },
        ],
      },
    ];
  };
  fs.existsSync = filepath => String(filepath).includes("upload-1.pdf");
  fs.unlinkSync = filepath => {
    unlinked.push(filepath);
  };
  materialService.getMaterialGroupByCode = async () => ({ id: 12, code: "CHEM" });
  materialService.getSubGroupById = async () => ({
    id: 110,
    item_group_id: 12,
    subgroup_code: "SUB",
    deleted_at: null,
  });
  materialService.saveSingleRequestRework = async payload => {
    receivedPayload = payload;
    return { request_id: 77, stage: "Approval 1", status: "Submit" };
  };

  const req = {
    params: { id: "77" },
    cookies: { user_id: "REQ-01", username: "requester.user" },
    headers: { "content-type": "multipart/form-data; boundary=123" },
  };
  const response = {
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
    await MaterialController.saveSingleRequestRework(req, response);

    assert.equal(response.statusCode, 200);
    assert.ok(receivedPayload);
    assert.equal(receivedPayload.requestId, "77");
    assert.equal(receivedPayload.editedRequest.material_group_id, 12);
    assert.equal(receivedPayload.editedRequest.material_sub_group_id, 110);
    assert.equal(receivedPayload.editedRequest.base_uom, "KG");
    assert.deepEqual(receivedPayload.attachments.keepAttachmentIds, [10]);
    assert.equal(receivedPayload.attachments.newAttachments.length, 1);
    assert.match(
      receivedPayload.attachments.newAttachments[0].newName,
      /^\d+_upload-1\.pdf$/
    );
    assert.deepEqual(unlinked, ["C:\\tmp\\upload-1.pdf"]);
  } finally {
    formidable.IncomingForm = originalIncomingForm;
    fs.existsSync = originalExistsSync;
    fs.unlinkSync = originalUnlinkSync;
    materialService.getMaterialGroupByCode = originalGetMaterialGroupByCode;
    materialService.getSubGroupById = originalGetSubGroupById;
    materialService.saveSingleRequestRework = originalSaveSingleRequestRework;
  }
});

test("saveSingleRequestRework controller rejects non-multipart attachment updates", async () => {
  const req = {
    headers: { "content-type": "application/json" },
    body: {
      editedRequest: { material_description: "Updated" },
      attachments: { keepAttachmentIds: [10] },
    },
  };
  const response = {
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

  await MaterialController.saveSingleRequestRework(req, response);

  assert.equal(response.statusCode, 400);
  assert.match(
    response.jsonPayload.message,
    /Attachment updates for single request rework require multipart\/form-data/i
  );
});

test("saveSingleRequestRework controller forwards canonical JSON Change editedRequest", async () => {
  const originalSaveSingleRequestRework = materialService.saveSingleRequestRework;
  let receivedPayload = null;

  materialService.saveSingleRequestRework = async payload => {
    receivedPayload = payload;
    return { request_id: 77, stage: "Approval 1", status: "Submit" };
  };

  const response = {
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
    await MaterialController.saveSingleRequestRework(
      {
        params: { id: "77" },
        cookies: { user_id: "REQ-01", username: "requester.user" },
        headers: { "content-type": "application/json" },
        body: {
          editedRequest: {
            ticket_type: "Change",
            change_extend_reason: "Need rename",
            base_uom: "KG",
            material_description: "Updated desc",
            template_payload: { templateValues: { density: "1.2" } },
          },
        },
      },
      response
    );

    assert.equal(response.statusCode, 200);
    assert.ok(receivedPayload);
    assert.deepEqual(receivedPayload.editedRequest, {
      ticket_type: "Change",
      change_extend_reason: "Need rename",
      base_uom: "KG",
      material_description: "Updated desc",
      template_payload: { templateValues: { density: "1.2" } },
    });
  } finally {
    materialService.saveSingleRequestRework = originalSaveSingleRequestRework;
  }
});

// --- Rework target: Master Data rewinds to an earlier MANUAL step -----------
// Chain used throughout: Approval 1 + Approval 2 both APPROVED, Master Data
// (level 3) active and grabbed by MDM-01.
const rewindSteps = () => [
  {
    id: 7101,
    request_id: 710,
    level: 1,
    kind: "MANUAL",
    approver_user_id: "APP-01",
    approver_name: "Approver One",
    status: "APPROVED",
    acted_at: new Date("2026-07-01T02:00:00.000Z"),
    remark: "ok",
  },
  {
    id: 7102,
    request_id: 710,
    level: 2,
    kind: "MANUAL",
    approver_user_id: "APP-02",
    approver_name: "Approver Two",
    status: "APPROVED",
    acted_at: new Date("2026-07-02T02:00:00.000Z"),
    remark: "ok too",
  },
  {
    id: 7103,
    request_id: 710,
    level: 3,
    kind: "MDM",
    approver_user_id: "MDM-01",
    approver_name: "Master Data One",
    status: "WAITING",
    acted_at: null,
    remark: null,
  },
];

test("normalizeReworkToLevel treats absent values as no target and rejects junk", () => {
  for (const absent of [undefined, null, ""]) {
    assert.equal(materialService.normalizeReworkToLevel(absent), null);
  }

  assert.equal(materialService.normalizeReworkToLevel(2), 2);
  assert.equal(materialService.normalizeReworkToLevel("2"), 2);

  for (const junk of ["abc", 1.5, 0, -1, true, [], {}]) {
    assert.throws(
      () => materialService.normalizeReworkToLevel(junk),
      error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_INVALID");
        return true;
      },
      `expected ${JSON.stringify(junk)} to be rejected`
    );
  }
});

test("buildStepReworkPatch is unchanged when no rework target is given", () => {
  const steps = rewindSteps();
  const patch = materialService.buildStepReworkPatch({
    activeStep: steps[2],
    reason: "Data salah",
  });

  assert.deepEqual(patch, {
    step: {
      status: "REWORK",
      acted_at: { __sql: "NOW()" },
      remark: "Data salah",
    },
    header: {
      status: "Rework",
      assigned_to: "Requester",
      rework_stage: "Master Data",
      rework_by_user_id: null,
      rework_at: { __sql: "NOW()" },
      rework_reason: "Data salah",
    },
  });
  assert.equal(patch.targetStep, undefined);
});

test("buildStepRewindPatch reopens the target step and Master Data without a Rework status", () => {
  const steps = rewindSteps();
  const patch = materialService.buildStepRewindPatch({
    steps,
    activeStep: steps[2],
    reworkToLevel: 2,
    actorUserId: "MDM-01",
    reason: "Approval 2 salah pilih plant",
  });

  // Both rows reopen; the grab is preserved by omission.
  assert.deepEqual(patch.targetStep, {
    status: "WAITING",
    acted_at: null,
    remark: null,
  });
  assert.deepEqual(patch.step, {
    status: "WAITING",
    acted_at: null,
    remark: null,
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch.step, "approver_user_id"),
    false
  );

  assert.deepEqual(patch.header, {
    status: "Submit",
    assigned_to: "Approval 2",
    rework_stage: "Master Data",
    rework_by_user_id: "MDM-01",
    rework_at: { __sql: "NOW()" },
    rework_reason: "Approval 2 salah pilih plant",
  });
  assert.equal(patch._meta.targetStep.id, 7102);

  // Approval 1 is left APPROVED, which is what sends it straight back to MDM.
  assert.equal(steps[0].status, "APPROVED");
});

test("buildStepRewindPatch rejects the Master Data step as its own target", () => {
  const steps = rewindSteps();

  assert.throws(
    () =>
      materialService.buildStepRewindPatch({
        steps,
        activeStep: steps[2],
        reworkToLevel: 3,
        actorUserId: "MDM-01",
        reason: "Balik ke diri sendiri",
      }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_INVALID");
      return true;
    }
  );
});

test("buildStepRewindPatch rejects a level that is not part of this request", () => {
  const steps = rewindSteps();

  assert.throws(
    () =>
      materialService.buildStepRewindPatch({
        steps,
        activeStep: steps[2],
        reworkToLevel: 9,
        actorUserId: "MDM-01",
        reason: "Level ngawur",
      }),
    error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_INVALID");
      return true;
    }
  );
});

test("buildStepRewindPatch refuses a rewind raised from a MANUAL stage", () => {
  const steps = rewindSteps();
  const manualActive = { ...steps[1], status: "WAITING" };

  assert.throws(
    () =>
      materialService.buildStepRewindPatch({
        steps,
        activeStep: manualActive,
        reworkToLevel: 1,
        actorUserId: "APP-02",
        reason: "Approver biasa coba mundur",
      }),
    error => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_FORBIDDEN");
      return true;
    }
  );
});

test("buildStepRewindPatch still requires a reason", () => {
  const steps = rewindSteps();

  assert.throws(
    () =>
      materialService.buildStepRewindPatch({
        steps,
        activeStep: steps[2],
        reworkToLevel: 2,
        actorUserId: "MDM-01",
        reason: "   ",
      }),
    /rework reason is required/i
  );
});

// Service seam: db.connect replaced by a fake client that matches on SQL.
const connectRewindStub = (steps, { queryLog, stepUpdates, headerUpdates }) =>
  async () => ({
    query: async (queryText, params = []) => {
      queryLog.push(queryText);

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 710,
              request_no: "1000000710",
              status: "Submit",
              ticket_type: "CREATE",
              created_by: "REQ-01",
            },
          ],
        };
      }

      if (/FOR UPDATE OF s/.test(queryText)) {
        return { rows: steps };
      }

      if (/mst_page_access/i.test(queryText)) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }

      if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
        stepUpdates.push({ queryText, params });
        return { rows: [], rowCount: 1 };
      }

      if (/UPDATE mat_single_request\b/.test(queryText)) {
        headerUpdates.push({ queryText, params });
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

test("requestSingleRequestRework without a target keeps sending the request to the requester", async () => {
  const originalConnect = db.connect;
  const queryLog = [];
  const stepUpdates = [];
  const headerUpdates = [];

  db.connect = connectRewindStub(rewindSteps(), {
    queryLog,
    stepUpdates,
    headerUpdates,
  });

  try {
    const result = await materialService.requestSingleRequestRework({
      requestId: 710,
      actorUserId: "MDM-01",
      actorUsername: "master.data.one",
      reason: "Requester salah isi",
    });

    assert.equal(result.status, "Rework");
    assert.equal(result.assigned_to, "Requester");
    assert.equal(result.stage, "Master Data");

    // Exactly one step row is touched: the active Master Data step.
    assert.equal(stepUpdates.length, 1);
    assert.equal(stepUpdates[0].params[0], 7103);
    assert.ok(stepUpdates[0].params.includes("REWORK"));

    assert.equal(headerUpdates.length, 1);
    assert.ok(headerUpdates[0].params.includes("Rework"));
    assert.ok(headerUpdates[0].params.includes("Requester"));
    assert.ok(queryLog.includes("COMMIT"));
  } finally {
    db.connect = originalConnect;
  }
});

test("requestSingleRequestRework rewinds to the chosen MANUAL step instead of the requester", async () => {
  const originalConnect = db.connect;
  const queryLog = [];
  const stepUpdates = [];
  const headerUpdates = [];

  db.connect = connectRewindStub(rewindSteps(), {
    queryLog,
    stepUpdates,
    headerUpdates,
  });

  try {
    const result = await materialService.requestSingleRequestRework({
      requestId: 710,
      actorUserId: "MDM-01",
      actorUsername: "master.data.one",
      reason: "Plant di Approval 2 keliru",
      reworkToLevel: 2,
    });

    assert.equal(result.status, "Submit");
    assert.equal(result.assigned_to, "Approval 2");

    // Master Data + the Approval 2 target reopen; Approval 1 stays untouched.
    assert.equal(stepUpdates.length, 2);
    assert.deepEqual(
      stepUpdates.map(update => update.params[0]),
      [7103, 7102]
    );
    for (const update of stepUpdates) {
      assert.ok(update.params.includes("WAITING"));
      assert.equal(update.params.includes("REWORK"), false);
    }
    assert.equal(
      stepUpdates.some(update => update.params[0] === 7101),
      false
    );

    // Master Data keeps its grab; the target's approver is not touched at all.
    assert.match(stepUpdates[0].queryText, /approver_user_id = \$/);
    assert.ok(stepUpdates[0].params.includes("MDM-01"));
    assert.doesNotMatch(stepUpdates[1].queryText, /approver_user_id/);

    assert.equal(headerUpdates.length, 1);
    assert.ok(headerUpdates[0].params.includes("Submit"));
    assert.ok(headerUpdates[0].params.includes("Approval 2"));
    assert.ok(headerUpdates[0].params.includes("Master Data"));
    assert.ok(headerUpdates[0].params.includes("Plant di Approval 2 keliru"));
    assert.equal(headerUpdates[0].params.includes("Rework"), false);
    assert.equal(headerUpdates[0].params.includes("Requester"), false);
    assert.ok(queryLog.includes("COMMIT"));
  } finally {
    db.connect = originalConnect;
  }
});

test("requestSingleRequestRework rolls back an invalid rework target without writing", async () => {
  const cases = [
    { reworkToLevel: 3, code: "SINGLE_REQUEST_REWORK_TARGET_INVALID", statusCode: 400 },
    { reworkToLevel: 9, code: "SINGLE_REQUEST_REWORK_TARGET_INVALID", statusCode: 400 },
    { reworkToLevel: "abc", code: "SINGLE_REQUEST_REWORK_TARGET_INVALID", statusCode: 400 },
  ];

  for (const { reworkToLevel, code, statusCode } of cases) {
    const originalConnect = db.connect;
    const queryLog = [];
    const stepUpdates = [];
    const headerUpdates = [];

    db.connect = connectRewindStub(rewindSteps(), {
      queryLog,
      stepUpdates,
      headerUpdates,
    });

    try {
      await assert.rejects(
        materialService.requestSingleRequestRework({
          requestId: 710,
          actorUserId: "MDM-01",
          actorUsername: "master.data.one",
          reason: "Tujuan tidak valid",
          reworkToLevel,
        }),
        error => {
          assert.equal(error.statusCode, statusCode, `for ${reworkToLevel}`);
          assert.equal(error.code, code, `for ${reworkToLevel}`);
          return true;
        }
      );

      assert.equal(stepUpdates.length, 0, `for ${reworkToLevel}`);
      assert.equal(headerUpdates.length, 0, `for ${reworkToLevel}`);
      assert.ok(queryLog.includes("ROLLBACK"), `for ${reworkToLevel}`);
      assert.equal(queryLog.includes("COMMIT"), false, `for ${reworkToLevel}`);
    } finally {
      db.connect = originalConnect;
    }
  }
});

test("requestSingleRequestRework refuses a rework target when the active step is not Master Data", async () => {
  const originalConnect = db.connect;
  const queryLog = [];
  const stepUpdates = [];
  const headerUpdates = [];
  // Approval 2 is the active step: Approval 1 approved, the rest still waiting.
  const midChainSteps = rewindSteps().map(step =>
    step.level === 2 ? { ...step, status: "WAITING", acted_at: null, remark: null } : step
  );

  db.connect = connectRewindStub(midChainSteps, {
    queryLog,
    stepUpdates,
    headerUpdates,
  });

  try {
    await assert.rejects(
      materialService.requestSingleRequestRework({
        requestId: 710,
        actorUserId: "APP-02",
        actorUsername: "approver.two",
        reason: "Approver biasa coba pilih tujuan",
        reworkToLevel: 1,
      }),
      error => {
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, "SINGLE_REQUEST_REWORK_TARGET_FORBIDDEN");
        return true;
      }
    );

    assert.equal(stepUpdates.length, 0);
    assert.equal(headerUpdates.length, 0);
    assert.ok(queryLog.includes("ROLLBACK"));
    assert.equal(queryLog.includes("COMMIT"), false);
  } finally {
    db.connect = originalConnect;
  }
});

test("rework controller forwards the optional rework target and surfaces its error code", () => {
  assert.match(
    MaterialController.requestSingleRequestRework.toString(),
    /req\.body\?\.reworkToLevel\s*\?\?\s*null/
  );
  assert.match(
    MaterialController.requestSingleRequestRework.toString(),
    /code: error\.code/
  );
});

test("serveFile resolves files inside configured directories only", () => {
  const controllerSource = require("fs").readFileSync(
    require("path").join(__dirname, "../controllers/MaterialController.js"),
    "utf8"
  );
  assert.doesNotMatch(controllerSource, /resolveMaterialFilePath/);
  assert.match(
    controllerSource,
    /path\.resolve\(\s*absoluteDirectory,\s*normalizedSubPath\s*\)/
  );
  assert.match(controllerSource, /candidatePath\.startsWith\(directoryPrefix\)/);
});

// Master Data may swap the sub material group on the same action that assigns
// the running number, so the composed code must follow the edit: request 710
// arrives on sub group 110 (code 031) and is approved on 555 (code 042).
test("approveSingleRequestByAdmin composes the final code from the sub material group Master Data selected", async () => {
  const originalConnect = db.connect;
  const requestUpdates = [];

  db.connect = async () => ({
    query: async (queryText, params = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
        return { rows: [], rowCount: null };
      }

      if (/FOR UPDATE OF r/.test(queryText)) {
        return {
          rows: [
            {
              request_id: 710,
              request_no: "1000000710",
              status: "Submit",
              ticket_type: "Create",
              created_by: "REQ-01",
              created_at: new Date("2026-07-01T01:00:00.000Z"),
              material_group_id: 12,
              material_sub_group_id: 110,
              material_group_code: "901",
              material_sub_group_code: "031",
              plant_code: "P1",
              sloc_code: "S1",
              material_description: "Original desc",
              base_uom: "EA",
              template_payload: { requestFields: {}, templateValues: {} },
            },
          ],
          rowCount: 1,
        };
      }

      if (/FOR UPDATE OF s/.test(queryText)) {
        return { rows: rewindSteps(), rowCount: 3 };
      }

      if (/mst_page_access/i.test(queryText)) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }

      if (/FROM mat_item_sub_group mis/i.test(queryText)) {
        return {
          rows: [
            {
              id: 555,
              subgroup_code: "042",
              deleted_at: null,
              item_group_id: 12,
              group_code: "901",
            },
          ],
          rowCount: 1,
        };
      }

      if (/INSERT INTO mat_single_request_edit_history/i.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      // Codes re-read once the sub group edit has been written.
      if (/mis\.code AS material_sub_group_code/i.test(queryText)) {
        return {
          rows: [
            { material_group_code: "901", material_sub_group_code: "042" },
          ],
          rowCount: 1,
        };
      }

      if (/FROM mat_sap_data WHERE code = \$1/i.test(queryText)) {
        return { rows: [], rowCount: 0 };
      }

      if (/SELECT request_no FROM mat_single_request/i.test(queryText)) {
        return { rows: [], rowCount: 0 };
      }

      if (/UPDATE mat_single_request_approval_step/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      // Terminal completion triggers the staging push; nothing pending for it.
      if (/sap_push_status = 'PENDING'/.test(queryText)) {
        return { rows: [], rowCount: 0 };
      }

      if (/UPDATE mat_single_request\b/.test(queryText)) {
        requestUpdates.push({ queryText, params });
        return { rows: [], rowCount: 1 };
      }

      // Every request action also appends to the request comment history; the
      // stub answers that write the way the database would.
      if (/mat_request_comment/.test(queryText)) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${queryText}`);
    },
    release: () => {},
  });

  try {
    const result = await materialService.approveSingleRequestByAdmin({
      requestId: 710,
      actorUserId: "MDM-01",
      actorUsername: "master.data.one",
      remark: "approved",
      editedRequest: { material_sub_group_id: 555 },
      finalCodeSuffix: "123",
    });

    assert.equal(result.final_code, "901.042.123");

    const finalCodeUpdate = requestUpdates.find(update =>
      /final_code = \$\d+/i.test(update.queryText)
    );
    assert.ok(finalCodeUpdate);
    assert.equal(finalCodeUpdate.params.includes("901.042.123"), true);
    assert.equal(finalCodeUpdate.params.includes("901.031.123"), false);
  } finally {
    db.connect = originalConnect;
  }
});
