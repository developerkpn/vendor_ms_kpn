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

test("getMassRequestApprovalInbox SQL formats first-item approval timestamps", () => {
    // Approval timestamps must be returned as friendly YYYY-MM-DD HH:MM strings,
    // matching the single-request inbox format. Without this, the UI surfaces
    // raw ISO 8601 strings (e.g. "2026-06-05T03:44:39.139Z") that are hard to read.
    const query = materialService.__private.GET_MASS_REQUEST_APPROVAL_INBOX_QUERY;
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_1_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_1_at/i
    );
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_2_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_2_at/i
    );
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_3_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_3_at/i
    );
});

test("getMassRequestsByUser SQL formats first-item approval timestamps", () => {
    const query = materialService.__private.GET_MASS_REQUESTS_BY_USER_QUERY;
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_1_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_1_at/i
    );
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_2_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_2_at/i
    );
    assert.match(
        query,
        /TO_CHAR\(first_item\.approval_3_at, 'YYYY-MM-DD HH24:MI'\) AS first_item_approval_3_at/i
    );
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

test("saveMassRequestRework detects REWORK on approval stage 3", () => {
    const source = materialService.saveMassRequestRework.toString();
    // Pins fix for the bug where rework requested by the third approval stage
    // returned "Mass request rework stage is missing" because the resolver
    // only checked approval_1_status and approval_2_status.
    assert.match(
        source,
        /approval_3_status[\s\S]*=== ?["']REWORK["']/,
        "saveMassRequestRework must inspect approval_3_status for REWORK"
    );
});