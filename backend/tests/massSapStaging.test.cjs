// Mass-request SAP staging: per-item final codes at the Master Data step, the
// Create-only backstop on submit, and the per-item staging payload mapping.
//
// Everything here is either a pure function or approveMassRequest driven
// against a stubbed pg client — no database is touched.

const assert = require("node:assert/strict");
const test = require("node:test");
const db = require("../config/connection");
const materialService = require("../services/materialService");
const materialSapStagingService = require("../services/materialSapStagingService");
const MaterialController = require("../controllers/MaterialController");

const {
    assertMassRequestRowsAreCreateOnly,
    buildMassItemFinalCodeSuffixes,
    assertMassFinalCodesAreDistinct,
    buildMassRequestFinalCodePlan,
} = materialService;

// assert.throws / assert.rejects do not hand the error back, and every case
// below asserts on statusCode + code + message, so capture it directly.
const captureThrow = (fn, why = "expected the call to throw") => {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error(why);
};

const captureReject = async (fn, why = "expected the call to reject") => {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    throw new Error(why);
};

// ---------------------------------------------------------------------------
// Create-only backstop (createMassRequest)
// ---------------------------------------------------------------------------

test("assertMassRequestRowsAreCreateOnly accepts rows with no ticket type at all", () => {
    assert.equal(
        assertMassRequestRowsAreCreateOnly([
            { description: "BEARING" },
            { description: "SEAL", ticketType: "" },
            { description: "BOLT", ticketType: "  create  " },
            { description: "NUT", ticket_type: "CREATE" },
        ]),
        true
    );
});

test("assertMassRequestRowsAreCreateOnly rejects a Change/Extend row with MASS_REQUEST_CREATE_ONLY", () => {
    const error = captureThrow(() =>
        assertMassRequestRowsAreCreateOnly([
            { description: "BEARING" },
            { description: "SEAL", ticketType: "Change" },
            { description: "BOLT", ticket_type: "Extend" },
        ])
    );

    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "MASS_REQUEST_CREATE_ONLY");
    assert.deepEqual(
        error.errors.map(entry => entry.rowIndex),
        [1, 2]
    );
    assert.match(error.errors[0].message, /Row 2/);
    assert.match(error.errors[0].message, /Change/);
});

test("createMassRequest runs the create-only backstop before opening a transaction", () => {
    const source = materialService.createMassRequest.toString();
    const guardIndex = source.indexOf("assertMassRequestRowsAreCreateOnly");
    const beginIndex = source.indexOf('client.query("BEGIN")');

    assert.ok(guardIndex > -1, "createMassRequest must call the backstop");
    assert.ok(beginIndex > -1);
    assert.ok(guardIndex < beginIndex);
});

// ---------------------------------------------------------------------------
// Suffix validation / increment / padding / overflow
// ---------------------------------------------------------------------------

test("buildMassItemFinalCodeSuffixes increments the entered running number per item", () => {
    assert.deepEqual(
        buildMassItemFinalCodeSuffixes({
            finalCodeSuffix: "007",
            itemCount: 4,
        }),
        ["007", "008", "009", "010"]
    );
});

test("buildMassItemFinalCodeSuffixes zero-pads back to the entered width", () => {
    // 001 + 8 crosses two padding boundaries (009 -> 010 -> ... -> 099 -> 100).
    assert.deepEqual(
        buildMassItemFinalCodeSuffixes({
            finalCodeSuffix: "098",
            itemCount: 3,
        }),
        ["098", "099", "100"]
    );
});

test("buildMassItemFinalCodeSuffixes rejects a non-numeric suffix with 400", () => {
    for (const suffix of ["A01", "1", "12", "1234", "", null, undefined, "  "]) {
        const error = captureThrow(
            () =>
                buildMassItemFinalCodeSuffixes({
                    finalCodeSuffix: suffix,
                    itemCount: 2,
                }),
            `suffix ${JSON.stringify(suffix)} must be rejected`
        );

        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_SUFFIX_INVALID");
        assert.equal(error.errors[0].fieldKey, "finalCodeSuffix");
    }
});

test("buildMassItemFinalCodeSuffixes rejects an overflow past the entered width with 409", () => {
    const error = captureThrow(() =>
        buildMassItemFinalCodeSuffixes({
            finalCodeSuffix: "998",
            itemCount: 3,
        })
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_SUFFIX_OVERFLOW");
    assert.match(error.message, /item 3/i);
    assert.match(error.message, /1000/);
});

test("buildMassItemFinalCodeSuffixes allows a batch that lands exactly on the last code", () => {
    assert.deepEqual(
        buildMassItemFinalCodeSuffixes({
            finalCodeSuffix: "998",
            itemCount: 2,
        }),
        ["998", "999"]
    );
});

// ---------------------------------------------------------------------------
// Composed plan: group-code resolution + sibling uniqueness
// ---------------------------------------------------------------------------

const massItems = [
    {
        item_id: 11,
        item_no: 1,
        request_no: "3000000011",
        material_group_code: "901",
        material_sub_group_code: "031",
    },
    {
        item_id: 12,
        item_no: 2,
        request_no: "3000000012",
        material_group_code: "901",
        material_sub_group_code: "031",
    },
    {
        item_id: 13,
        item_no: 3,
        request_no: "3000000013",
        material_group_code: "902",
        material_sub_group_code: "007",
    },
];

test("buildMassRequestFinalCodePlan composes one incremented code per item", () => {
    assert.deepEqual(
        buildMassRequestFinalCodePlan({
            finalCodeSuffix: "005",
            items: massItems,
        }),
        [
            {
                item_id: 11,
                item_no: 1,
                request_no: "3000000011",
                final_code: "901.031.005",
            },
            {
                item_id: 12,
                item_no: 2,
                request_no: "3000000012",
                final_code: "901.031.006",
            },
            {
                item_id: 13,
                item_no: 3,
                request_no: "3000000013",
                final_code: "902.007.007",
            },
        ]
    );
});

test("buildMassRequestFinalCodePlan orders by item_no regardless of the row order it is handed", () => {
    const plan = buildMassRequestFinalCodePlan({
        finalCodeSuffix: "005",
        items: [massItems[2], massItems[0], massItems[1]],
    });

    assert.deepEqual(
        plan.map(entry => `${entry.item_no}:${entry.final_code}`),
        ["1:901.031.005", "2:901.031.006", "3:902.007.007"]
    );
});

test("buildMassRequestFinalCodePlan 409s naming the item whose group code is unresolvable", () => {
    const error = captureThrow(() =>
        buildMassRequestFinalCodePlan({
            finalCodeSuffix: "005",
            items: [
                massItems[0],
                { ...massItems[1], material_sub_group_code: null },
            ],
        })
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_GROUP_UNRESOLVED");
    assert.match(error.message, /Item 2/);
});

test("assertMassFinalCodesAreDistinct 409s naming both colliding item numbers", () => {
    const error = captureThrow(() =>
        assertMassFinalCodesAreDistinct([
            { item_no: 1, final_code: "901.031.005" },
            { item_no: 2, final_code: "901.031.006" },
            { item_no: 3, final_code: "901.031.005" },
        ])
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS");
    assert.match(error.message, /Item 3/);
    assert.match(error.message, /901\.031\.005/);
    assert.match(error.message, /item 1/);
});

// ---------------------------------------------------------------------------
// approveMassRequest at the Master Data step (stubbed pg client)
// ---------------------------------------------------------------------------

// Every item shares the plan, so one MDM step row stands in for the batch.
const mdmSteps = () => [
    {
        id: 91,
        item_id: 11,
        level: 1,
        kind: "MDM",
        approver_user_id: "MDM-01",
        status: "WAITING",
    },
];

const groupCodeRows = () =>
    massItems.map(item => ({
        item_id: item.item_id,
        item_no: item.item_no,
        request_no: item.request_no,
        material_group_code: item.material_group_code,
        material_sub_group_code: item.material_sub_group_code,
    }));

// Drives approveMassRequest against a stub client. `duplicates` injects rows for
// the three uniqueness lookups; `queries` collects everything that was issued.
const runMassApprove = async ({
    duplicates = {},
    finalCodeSuffix = "005",
} = {}) => {
    const originalConnect = db.connect;
    const originalPush =
        materialSapStagingService.pushPendingMaterialsToSapStaging;
    const queries = [];
    const pushCalls = [];

    materialSapStagingService.pushPendingMaterialsToSapStaging = async args => {
        pushCalls.push(args);
        return { pushed: [], errors: [] };
    };

    db.connect = async () => ({
        query: async (queryText, params = []) => {
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(queryText)) {
                return { rows: [], rowCount: null };
            }

            queries.push({ queryText, params });

            if (/FOR UPDATE OF i/.test(queryText)) {
                return { rows: [{ id: 11, status: "Submit" }], rowCount: 1 };
            }

            if (/FOR UPDATE OF s/.test(queryText)) {
                return { rows: mdmSteps(), rowCount: 1 };
            }

            if (/mst_page_access/i.test(queryText)) {
                return { rows: [{ exists: 1 }], rowCount: 1 };
            }

            if (/mig\.code AS material_group_code/i.test(queryText)) {
                return { rows: groupCodeRows(), rowCount: 3 };
            }

            if (/FROM mat_sap_data WHERE code = ANY/i.test(queryText)) {
                const rows = duplicates.sap ?? [];
                return { rows, rowCount: rows.length };
            }

            if (/FROM mat_single_request\s+WHERE final_code = ANY/i.test(queryText)) {
                const rows = duplicates.single ?? [];
                return { rows, rowCount: rows.length };
            }

            if (
                /FROM mat_mass_request_item\s+WHERE final_code = ANY/i.test(
                    queryText
                )
            ) {
                const rows = duplicates.mass ?? [];
                return { rows, rowCount: rows.length };
            }

            if (/UPDATE mat_mass_request_item_approval_step/.test(queryText)) {
                return { rows: [], rowCount: 3 };
            }

            if (/UPDATE mat_mass_request_item\b/.test(queryText)) {
                return { rows: [{ id: 11 }, { id: 12 }, { id: 13 }], rowCount: 3 };
            }

            throw new Error(`Unexpected query: ${queryText}`);
        },
        release: () => {},
    });

    try {
        const result = await materialService.approveMassRequest({
            massRequestId: 5,
            actorUserId: "MDM-01",
            actorUsername: "master.data.one",
            remark: "approved",
            items: null,
            finalCodeSuffix,
        });
        return { result, queries, pushCalls };
    } finally {
        db.connect = originalConnect;
        materialSapStagingService.pushPendingMaterialsToSapStaging =
            originalPush;
    }
};

test("approveMassRequest writes an incremented final code per item and flags them PENDING", async () => {
    const { result, queries, pushCalls } = await runMassApprove();

    assert.deepEqual(
        result.final_codes.map(entry => entry.final_code),
        ["901.031.005", "901.031.006", "902.007.007"]
    );
    assert.equal(result.status, "DONE");

    const finalCodeWrites = queries.filter(entry =>
        /SET final_code = \$3/.test(entry.queryText)
    );
    assert.equal(finalCodeWrites.length, 3);
    assert.deepEqual(
        finalCodeWrites.map(entry => entry.params),
        [
            [11, 5, "901.031.005"],
            [12, 5, "901.031.006"],
            [13, 5, "902.007.007"],
        ]
    );

    const completion = queries.find(entry =>
        /UPDATE mat_mass_request_item\s+SET status = \$2/.test(entry.queryText)
    );
    assert.ok(completion);
    assert.match(completion.queryText, /sap_push_status = 'PENDING'/);

    // Terminal completion fires the same inline push the single flow fires.
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].massRequestId, 5);
});

test("approveMassRequest requires a numeric running number at the Master Data step", async () => {
    const error = await captureReject(() =>
        runMassApprove({ finalCodeSuffix: "A01" })
    );

    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_SUFFIX_INVALID");
});

test("approveMassRequest 409s when a composed code already exists in SAP master data", async () => {
    const error = await captureReject(() =>
        runMassApprove({ duplicates: { sap: [{ code: "901.031.006" }] } })
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS");
    assert.match(error.message, /Item 2/);
    assert.match(error.message, /SAP master data/);
});

test("approveMassRequest 409s when a composed code is held by a single request", async () => {
    const error = await captureReject(() =>
        runMassApprove({
            duplicates: {
                single: [
                    { request_no: "1000000710", final_code: "902.007.007" },
                ],
            },
        })
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS");
    assert.match(error.message, /Item 3/);
    assert.match(error.message, /1000000710/);
});

test("approveMassRequest 409s when a composed code is held by another batch's item", async () => {
    const error = await captureReject(() =>
        runMassApprove({
            duplicates: {
                mass: [
                    {
                        request_no: "3000000099",
                        item_no: 2,
                        final_code: "901.031.005",
                    },
                ],
            },
        })
    );

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "MASS_REQUEST_FINAL_CODE_ALREADY_EXISTS");
    assert.match(error.message, /Item 1/);
    assert.match(error.message, /3000000099/);
});

test("the mass uniqueness lookups release a CANCELled code and skip this same batch", () => {
    const source = materialService.assertMassFinalCodePlanIsAvailable.toString();

    assert.match(source, /FROM mat_sap_data WHERE code = ANY/);
    assert.match(
        source,
        /FROM mat_single_request[\s\S]*UPPER\(COALESCE\(status, ''\)\) <> 'CANCEL'/
    );
    assert.match(
        source,
        /FROM mat_mass_request_item[\s\S]*mass_request_id <> \$2[\s\S]*UPPER\(COALESCE\(status, ''\)\) <> 'CANCEL'/
    );
});

// ---------------------------------------------------------------------------
// Per-item staging payload mapping
// ---------------------------------------------------------------------------

test("buildMassItemStagingSnapshot feeds po_text through the long-text partition", () => {
    const snapshot = materialSapStagingService.buildMassItemStagingSnapshot({
        request_no: "3000000011",
        ticket_type: "Create",
        final_code: "901.031.005",
        plant_code: "EU73",
        sloc_code: "ST01",
        material_description: "BEARING BALL 6204 2RS",
        base_uom: "PC",
        material_group_code: "901",
        derived_sales_org: "1000",
        po_text: "SUPPLIER PART NO 4711-A",
    });

    assert.equal(snapshot.long_text_1, "SUPPLIER PART NO 4711-A");
    assert.equal(snapshot.long_text_2, null);
    assert.equal(snapshot.long_text_3, null);
    assert.equal(snapshot.template_payload, null);
    assert.equal(snapshot.material_code, null);
});

test("mass item payload caps MATERIAL_DESC at 40 and PURCHASE_ORDER_TEXT at 210", () => {
    const payload = materialSapStagingService.buildMaterialStagingPayload({
        snapshot: materialSapStagingService.buildMassItemStagingSnapshot({
            request_no: "3000000011",
            ticket_type: "Create",
            final_code: "901.031.005",
            plant_code: "EU73",
            sloc_code: "ST01",
            material_description: "D".repeat(60),
            base_uom: "PC",
            material_group_code: "901",
            derived_sales_org: "1000",
            po_text: "P".repeat(400),
        }),
        approvedBy: "mdm@example.com",
        now: new Date("2026-08-06T00:00:00.000Z"),
    });

    assert.equal(payload.MATERIAL_DESC, "D".repeat(40));
    assert.equal(payload.PURCHASE_ORDER_TEXT, "P".repeat(210));
    assert.equal(payload.MATERIAL_NUMBER, "901.031.005");
    assert.equal(payload.MATERIAL_GROUP, "901");
    assert.equal(payload.SALES_ORGANIZATION, "1000");
    assert.equal(payload.APPROVED_BY, "mdm@example.com");
    assert.equal(payload.MOVING_AVG_PRICE, null);
    assert.equal(payload.FLAG, "I");
});

test("mass item payload collapses newlines 1:1 so the 210 width still holds", () => {
    const payload = materialSapStagingService.buildMaterialStagingPayload({
        snapshot: materialSapStagingService.buildMassItemStagingSnapshot({
            request_no: "3000000012",
            final_code: "901.031.006",
            material_description: "BEARING\nBALL",
            base_uom: "PC",
            po_text: "LINE ONE\nLINE TWO",
        }),
    });

    assert.equal(payload.MATERIAL_DESC, "BEARING BALL");
    assert.equal(payload.PURCHASE_ORDER_TEXT, "LINE ONE LINE TWO");
});

test("mass item payload sends NULL PURCHASE_ORDER_TEXT when po_text is blank", () => {
    const payload = materialSapStagingService.buildMaterialStagingPayload({
        snapshot: materialSapStagingService.buildMassItemStagingSnapshot({
            request_no: "3000000013",
            final_code: "902.007.007",
            material_description: "SEAL OIL",
            base_uom: "PC",
            po_text: "   ",
        }),
    });

    assert.equal(payload.PURCHASE_ORDER_TEXT, null);
});

// ---------------------------------------------------------------------------
// Push / sync / resubmit wiring
// ---------------------------------------------------------------------------

test("pushPendingMaterialsToSapStaging selects pending mass items keyed by the item request_no", () => {
    const source =
        materialSapStagingService.pushPendingMaterialsToSapStaging.toString();

    assert.match(
        source,
        /FROM mat_mass_request_item i[\s\S]*i\.status = 'DONE' AND i\.sap_push_status = 'PENDING'/
    );
    assert.match(source, /AND i\.mass_request_id = \$2/);
    assert.match(source, /buildMassItemStagingSnapshot/);
    // Targeting one kind must not drag in the other.
    assert.match(source, /massRequestId != null\s*\?\s*\{ rows: \[\] \}/);
    assert.match(source, /requestId != null\s*\?\s*\{ rows: \[\] \}/);
});

test("syncMaterialStagingFromSap reconciles mass items alongside single requests", () => {
    const source = materialSapStagingService.syncMaterialStagingFromSap.toString();

    assert.match(
        source,
        /FROM mat_mass_request_item\s+WHERE sap_push_status = 'PUSHED'/
    );
    assert.match(source, /PUSH_TARGET_TABLES\[target\.kind\]/);
    assert.equal(
        materialSapStagingService.PUSH_TARGET_TABLES.mass.table,
        "mat_mass_request_item"
    );
});

test("requestMassSapErrorRework reopens the Master Data step and clears the item SAP fields", () => {
    const source = materialService.requestMassSapErrorRework.toString();

    assert.match(source, /BEGIN/);
    assert.match(source, /COMMIT/);
    assert.match(source, /ROLLBACK/);
    assert.match(source, /MASS_REQUEST_SAP_RETRY_CONFLICT/);
    assert.match(source, /MASS_REQUEST_SAP_RETRY_FORBIDDEN/);
    assert.match(source, /MASS_REQUEST_SAP_RETRY_NO_MDM/);
    assert.match(source, /status: "WAITING", acted_at: null, remark: null/);
    assert.match(source, /sap_push_status = NULL,\s*\n\s*sap_error_msg = NULL/);
});

// Regression guard: the existence probe must be a row SELECT, not the
// error-count aggregate. An ungrouped COUNT(*) always returns exactly one row,
// so probing `rows.length === 0` against it can never fire — a missing batch
// would fall through as "0 errors" and surface as a 409 RETRY_CONFLICT instead
// of a 404. The probe doubles as the FOR UPDATE lock (the same first-item
// anchor approveMassRequest takes), which is what serialises a concurrent
// approve against a resubmit.
test("requestMassSapErrorRework locks + probes existence on a row, not on the count", () => {
    const source = materialService.requestMassSapErrorRework.toString();

    // The 404 branch is guarded by a real row read that can return zero rows.
    assert.match(
        source,
        /SELECT i\.id\s+FROM mat_mass_request_item i\s+WHERE i\.mass_request_id = \$1\s+ORDER BY i\.item_no ASC\s+LIMIT 1\s+FOR UPDATE OF i/
    );
    assert.match(
        source,
        /lockResult\.rows\.length === 0[\s\S]{0,200}MASS_REQUEST_NOT_FOUND/
    );

    // The aggregate is a separate query and is only ever read for its value.
    assert.match(source, /errorCountResult[\s\S]*?COUNT\(\*\) AS error_count/);
    assert.match(
        source,
        /Number\(errorCountResult\.rows\[0\]\.error_count \|\| 0\) === 0/
    );
    assert.doesNotMatch(source, /lockResult\.rows\[0\]\.error_count/);
});

test("mass approve + resubmit are wired through the controller and routes", () => {
    assert.match(
        MaterialController.approveMassRequest.toString(),
        /finalCodeSuffix: req\.body\?\.finalCodeSuffix \?\? null/
    );
    assert.match(
        MaterialController.requestMassSapErrorRework.toString(),
        /requestMassSapErrorRework\(\{/
    );

    const routeSource = require("fs").readFileSync(
        require("path").join(__dirname, "../routes/MaterialRoute.js"),
        "utf8"
    );
    assert.match(routeSource, /"\/requests\/mass\/:id\/sap-resubmit"/);
    assert.match(routeSource, /MaterialController\.requestMassSapErrorRework/);
});
