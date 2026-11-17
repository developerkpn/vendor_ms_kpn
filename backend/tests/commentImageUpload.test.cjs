const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");
const fs = require("fs");
const MaterialController = require("../controllers/MaterialController");

test("MaterialController has uploadCommentImage handler", () => {
    assert.equal(typeof MaterialController.uploadCommentImage, "function");
});

test("MaterialController.uploadCommentImage rejects requests with no files", async () => {
    const req = {
        headers: { "content-type": "application/json" },
        pipe: () => {},
        on: () => {},
        cookies: { user_id: "test_user" },
    };

    let statusCode = null;
    let responseBody = null;

    const res = {
        status: code => {
            statusCode = code;
            return res;
        },
        json: data => {
            responseBody = data;
            return res;
        },
    };

    await MaterialController.uploadCommentImage(req, res);

    // Formidable will fail to find files or parse
    assert.ok(statusCode >= 400);
    assert.equal(responseBody.success, false);
});
