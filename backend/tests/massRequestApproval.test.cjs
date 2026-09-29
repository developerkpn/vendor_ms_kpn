const assert = require("node:assert/strict");
const test = require("node:test");
const Material = require("../models/MaterialModel");
const materialService = require("../services/materialService");
const MaterialController = require("../controllers/MaterialController");

// ---------------------------------------------------------------------------
// Model method structural assertions (following existing test patterns)
// ---------------------------------------------------------------------------
test("approveMassRequest wraps updates in a transaction", () => {
    const source = materialService.approveMassRequest.toString();
    assert.match(source, /BEGIN/);
    assert.match(source, /COMMIT/);
    assert.match(source, /ROLLBACK/);
    assert.match(source, /FOR UPDATE OF i/);
});

test("requestMassRequestRework wraps updates in a transaction", () => {
    const source = materialService.requestMassRequestRework.toString();
    assert.match(source, /BEGIN/);
    assert.match(source, /COMMIT/);
    assert.match(source, /ROLLBACK/);
});

test("rejectMassRequestByAdmin wraps updates in a transaction", () => {
    const source = materialService.rejectMassRequestByAdmin.toString();
    assert.match(source, /BEGIN/);
    assert.match(source, /COMMIT/);
    assert.match(source, /ROLLBACK/);
});

test("getMassRequestApprovalInbox returns data via controller", () => {
    const source = MaterialController.getMassRequestApprovalInbox.toString();
    assert.match(source, /getMassRequestApprovalInbox/);
    assert.match(source, /cookies/i);
});

test("getMassRequestApprovalInbox SQL returns the first item's approval steps", () => {
    const query = materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY;
    // Since the dynamic-approver flow approvals are step rows: the first item's
    // steps come back as approval_steps (acted_at / claimed_at), which the UI
    // formats (MassApprovalStatusDialog -> formatDateTime). The header time is
    // still formatted here.
    assert.match(query, /FROM mat_mass_request_item_approval_step/i);
    assert.match(query, /'acted_at', s\.acted_at/i);
    assert.match(query, /'claimed_at', s\.claimed_at/i);
    assert.match(query, /COALESCE\(first_item\.approval_steps, '\[\]'::jsonb\) AS approval_steps/i);
    assert.match(query, /TO_CHAR\(m\.created_at, 'YYYY-MM-DD HH24:MI'\) AS created_at/i);
});

test("getMassRequestsByUser SQL returns the first item's approval steps", () => {
    const query = materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY;
    // Since the dynamic-approver flow approvals are step rows: the first item's
    // steps come back as approval_steps (acted_at / claimed_at), which the UI
    // formats (MassApprovalStatusDialog -> formatDateTime). The header time is
    // still formatted here.
    assert.match(query, /FROM mat_mass_request_item_approval_step/i);
    assert.match(query, /'acted_at', s\.acted_at/i);
    assert.match(query, /'claimed_at', s\.claimed_at/i);
    assert.match(query, /COALESCE\(first_item\.approval_steps, '\[\]'::jsonb\) AS approval_steps/i);
    assert.match(query, /TO_CHAR\(m\.created_at, 'YYYY-MM-DD HH24:MI'\) AS created_at/i);
});

test("approveMassRequest controller reads params and body", () => {
    const source = MaterialController.approveMassRequest.toString();
    assert.match(source, /req\.params\.id/);
    assert.match(source, /req\.cookies/);
    assert.match(source, /req\.body/);
});

test("requestMassRequestRework controller reads params and body", () => {
    const source = MaterialController.requestMassRequestRework.toString();
    assert.match(source, /req\.params\.id/);
    assert.match(source, /req\.body/);
});

test("rejectMassRequest controller reads params and body", () => {
    const source = MaterialController.rejectMassRequest.toString();
    assert.match(source, /req\.params\.id/);
    assert.match(source, /req\.body/);
});

test("saveMassRequestRework finds the reworked step at any level", () => {
    const source = materialService.saveMassRequestRework.toString();
    // Pins the fix for "Mass request rework stage is missing" when the rework
    // came from a later stage: the old resolver only checked approval_1/2.
    // With step rows the reworked step is whichever one is in REWORK status,
    // not a fixed column.
    assert.match(
        source,
        /firstItemSteps\.find\([\s\S]*normalizeStepStatus\(step\.status\) === "REWORK"/,
        "saveMassRequestRework must pick the step in REWORK status from all steps"
    );
    assert.doesNotMatch(source, /approval_[123]_status/);
});