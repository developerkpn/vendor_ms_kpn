const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const path = require("path");

const service = require("../services/materialAiMatchService");

// Nothing in this file may reach a database or the recommender. Every run test
// replaces the I/O seams by assignment — which is why the service calls itself
// through module.exports — and puts them back afterwards. The in-flight
// request lookup answers "none open" unless a test says otherwise.
const IO_SEAMS = [
  "loadSingleRequestRow",
  "loadMassRequestItems",
  "loadInFlightCandidates",
  "upsertMatch",
  "callRecommender",
  "runSingleRequestMatch",
  "runMassRequestMatch",
];

function stubService(stubs) {
  const original = {};
  for (const name of IO_SEAMS) {
    original[name] = service[name];
  }
  Object.assign(service, { loadInFlightCandidates: async () => [] }, stubs);
  return () => Object.assign(service, original);
}

// MATERIAL_AI_MATCH_* is read on every getConfig() call, so a test can flip it
// as long as it puts the previous value back — including "it was not set".
function withEnv(values, fn) {
  const original = {};
  for (const key of Object.keys(values)) {
    original[key] = process.env[key];
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  };

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Restore only once the callback is actually finished: an async one is still
  // running when it hands back its promise, and putting the environment back
  // underneath it would test the wrong configuration.
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      value => {
        restore();
        return value;
      },
      error => {
        restore();
        throw error;
      }
    );
  }
  restore();
  return result;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------------------
// getConfig — the feature switch and the knobs around it. top_k is clamped
// rather than trusted because it goes straight into a request to the model
// server, and a typo'd 99 would ask it for a list no approver can read.
// ---------------------------------------------------------------------------

test("getConfig is disabled and defaulted when nothing is configured", () => {
  withEnv(
    {
      MATERIAL_AI_MATCH_ENABLED: undefined,
      MATERIAL_AI_MATCH_URL: undefined,
      MATERIAL_AI_MATCH_TIMEOUT_MS: undefined,
      MATERIAL_AI_MATCH_TOP_K: undefined,
    },
    () => {
      const config = service.getConfig();
      assert.equal(config.enabled, false);
      assert.equal(config.baseUrl, "http://127.0.0.1:8000");
      assert.equal(config.timeoutMs, 30000);
      assert.equal(config.topK, 5);
    }
  );
});

test("getConfig only enables on the exact string true", () => {
  withEnv({ MATERIAL_AI_MATCH_ENABLED: "TRUE" }, () => {
    assert.equal(service.getConfig().enabled, false);
  });
  withEnv({ MATERIAL_AI_MATCH_ENABLED: "1" }, () => {
    assert.equal(service.getConfig().enabled, false);
  });
  withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () => {
    assert.equal(service.getConfig().enabled, true);
  });
});

test("getConfig strips trailing slashes from the base url", () => {
  withEnv({ MATERIAL_AI_MATCH_URL: "http://ai-box:8000///" }, () => {
    assert.equal(service.getConfig().baseUrl, "http://ai-box:8000");
  });
});

test("getConfig clamps top_k and falls back on a bad timeout", () => {
  withEnv({ MATERIAL_AI_MATCH_TOP_K: "99" }, () => {
    assert.equal(service.getConfig().topK, 10);
  });
  withEnv({ MATERIAL_AI_MATCH_TOP_K: "0" }, () => {
    assert.equal(service.getConfig().topK, 5);
  });
  withEnv({ MATERIAL_AI_MATCH_TOP_K: "-3" }, () => {
    assert.equal(service.getConfig().topK, 1);
  });
  withEnv({ MATERIAL_AI_MATCH_TOP_K: "" }, () => {
    assert.equal(service.getConfig().topK, 5);
  });
  withEnv({ MATERIAL_AI_MATCH_TOP_K: "abc" }, () => {
    assert.equal(service.getConfig().topK, 5);
  });
  withEnv({ MATERIAL_AI_MATCH_TIMEOUT_MS: "not-a-number" }, () => {
    assert.equal(service.getConfig().timeoutMs, 30000);
  });
});

// ---------------------------------------------------------------------------
// Query building. The long-text columns are one string split across three
// columns, so they go back together before they are sent — and the whitespace
// a requester typed must not change the query.
// ---------------------------------------------------------------------------

test("buildSingleRequestQuery joins the long-text columns with single spaces", () => {
  const query = service.buildSingleRequestQuery({
    material_code: "  935.461.472 ",
    material_description: "PUMP   LIFT\n",
    long_text_1: "HEAVY DUTY",
    long_text_2: "  50HZ  ",
    long_text_3: "",
  });

  assert.deepEqual(query, {
    code: "935.461.472",
    name: "PUMP LIFT",
    desc: "HEAVY DUTY 50HZ",
  });
});

test("buildSingleRequestQuery leaves the description empty when no long text was typed", () => {
  const query = service.buildSingleRequestQuery({
    material_code: null,
    material_description: "BEARING",
    long_text_1: null,
    long_text_2: "   ",
    long_text_3: undefined,
  });

  assert.deepEqual(query, { code: "", name: "BEARING", desc: "" });
});

test("buildMassItemQuery joins po_text and spesifikasi and never sends a code", () => {
  const query = service.buildMassItemQuery({
    material_description: "  INSERT  EXHAUST ",
    po_text: "P/N 31755122",
    spesifikasi_tambahan: "STAINLESS  STEEL",
  });

  assert.deepEqual(query, {
    code: "",
    name: "INSERT EXHAUST",
    desc: "P/N 31755122 STAINLESS STEEL",
  });
});

// ---------------------------------------------------------------------------
// shouldMatchSingleRequest — Change and Extend already name an existing
// material, so asking "does this exist?" about them is noise.
// ---------------------------------------------------------------------------

test("shouldMatchSingleRequest only accepts Create", () => {
  assert.equal(service.shouldMatchSingleRequest({ ticket_type: "Create" }), true);
  assert.equal(
    service.shouldMatchSingleRequest({ ticket_type: " Create " }),
    true
  );
  assert.equal(service.shouldMatchSingleRequest({ ticket_type: "Change" }), false);
  assert.equal(service.shouldMatchSingleRequest({ ticket_type: "Extend" }), false);
  assert.equal(service.shouldMatchSingleRequest({}), false);
  assert.equal(service.shouldMatchSingleRequest(null), false);
});

// ---------------------------------------------------------------------------
// normalizeRecommendations — rank is the order the recommender returned, not a
// re-sort of our own.
// ---------------------------------------------------------------------------

test("normalizeRecommendations ranks in input order and rounds to four decimals", () => {
  const recs = service.normalizeRecommendations([
    {
      code: " 935.461.472 ",
      name: "P/N 31755122  INSERT EXHAUST",
      similarity: 0.97314159,
      match_type: "EXACT (code + name match)",
    },
    { code: "935.461.473", name: "INSERT", similarity: "0.8125" },
  ]);

  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], {
    rank: 1,
    code: "935.461.472",
    name: "P/N 31755122 INSERT EXHAUST",
    similarity: 0.9731,
    matchType: "EXACT (code + name match)",
    source: "catalog",
    retired: false,
    requestStatus: "",
  });
  assert.equal(recs[1].rank, 2);
  assert.equal(recs[1].similarity, 0.8125);
  assert.equal(recs[1].matchType, "TEXT");
});

test("normalizeRecommendations scores an unusable similarity as zero", () => {
  const recs = service.normalizeRecommendations([
    { code: "A", name: "A", similarity: null },
    { code: "B", name: "B", similarity: "n/a" },
  ]);

  assert.equal(recs[0].similarity, 0);
  assert.equal(recs[1].similarity, 0);
});

test("normalizeRecommendations answers an empty list for anything that is not an array", () => {
  assert.deepEqual(service.normalizeRecommendations(null), []);
  assert.deepEqual(service.normalizeRecommendations(undefined), []);
  assert.deepEqual(service.normalizeRecommendations("nope"), []);
  assert.deepEqual(service.normalizeRecommendations({ 0: "x" }), []);
});

// ---------------------------------------------------------------------------
// describeAiError — the stored line is what a support ticket reads, so "the AI
// box is not running" and "it answered and said no" have to be tellable apart.
// ---------------------------------------------------------------------------

test("describeAiError names a timeout, a refused connection and an HTTP answer", () => {
  assert.equal(
    service.describeAiError({ code: "ECONNABORTED", message: "timeout of 30000ms" }),
    "AI recommender timed out"
  );
  assert.equal(
    service.describeAiError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }),
    "AI recommender unreachable"
  );
  assert.equal(
    service.describeAiError({
      response: { status: 503, data: { detail: "Models are still loading" } },
    }),
    "AI recommender responded 503: Models are still loading"
  );
  assert.equal(
    service.describeAiError({ response: { status: 500, data: {} } }),
    "AI recommender responded 500"
  );
  assert.equal(
    service.describeAiError({ response: { status: 400, data: { detail: { x: 1 } } } }),
    "AI recommender responded 400"
  );
  assert.equal(service.describeAiError(new Error("boom")), "boom");
  assert.equal(service.describeAiError({}), "Unknown error");
  assert.equal(service.describeAiError(null), "Unknown error");
});

// ---------------------------------------------------------------------------
// Scheduling. The submit handlers call these and immediately answer the
// requester, so a disabled feature must cost exactly one env read.
// ---------------------------------------------------------------------------

test("scheduleSingleRequestMatch does nothing while the feature is off", async () => {
  let calls = 0;
  const restore = stubService({
    runSingleRequestMatch: async () => {
      calls += 1;
    },
  });

  try {
    const queued = withEnv({ MATERIAL_AI_MATCH_ENABLED: "false" }, () =>
      service.scheduleSingleRequestMatch(42)
    );
    assert.equal(queued, false);
    await tick();
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("scheduleSingleRequestMatch refuses a missing request id", () => {
  withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () => {
    assert.equal(service.scheduleSingleRequestMatch(null), false);
    assert.equal(service.scheduleSingleRequestMatch(undefined), false);
  });
});

test("scheduleSingleRequestMatch queues the run on a later tick", async () => {
  const seen = [];
  const restore = stubService({
    runSingleRequestMatch: async id => {
      seen.push(id);
    },
  });

  try {
    const queued = withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () =>
      service.scheduleSingleRequestMatch(42)
    );
    assert.equal(queued, true);
    // Still nothing: the response has already gone out by now.
    assert.deepEqual(seen, []);
    await tick();
    assert.deepEqual(seen, [42]);
  } finally {
    restore();
  }
});

test("scheduleMassRequestMatch queues the mass run on a later tick", async () => {
  const seen = [];
  const restore = stubService({
    runMassRequestMatch: async id => {
      seen.push(id);
    },
  });

  try {
    const queued = withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () =>
      service.scheduleMassRequestMatch(7)
    );
    assert.equal(queued, true);
    await tick();
    assert.deepEqual(seen, [7]);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// runSingleRequestMatch — PENDING first so the dialog can say "AI is working",
// then DONE or FAILED over the top of the same row.
// ---------------------------------------------------------------------------

const AI_RESPONSE = {
  success: true,
  code: "",
  name: "PUMP LIFT",
  desc: "",
  corrected_name: "PUMP LIFT",
  typo_corrected: false,
  entities: { category: ["PUMP"], specs: ["50HZ (frequency)"] },
  recommendations: [
    {
      code: "935.461.472",
      name: "P/N 31755122 INSERT EXHAUST",
      similarity: 0.9731,
      match_type: "TEXT",
    },
    {
      code: "935.461.473",
      name: "INSERT EXHAUST SPARE",
      similarity: 0.8412,
      match_type: "TEXT + same group",
    },
  ],
  latencies: { typo: 120.0, ner: 40.0, recommender: 30.0 },
  total_latency_ms: 190.0,
  timestamp: "2026-09-22 10:00:00",
};

const CREATE_ROW = {
  id: 501,
  ticket_type: "Create",
  material_code: "",
  material_description: "PUMP LIFT",
  long_text_1: "HEAVY DUTY",
  long_text_2: null,
  long_text_3: null,
};

test("runSingleRequestMatch writes PENDING then DONE with the top similarity", async () => {
  const upserts = [];
  let sentQuery = null;
  const restore = stubService({
    loadSingleRequestRow: async () => CREATE_ROW,
    callRecommender: async payload => {
      sentQuery = payload;
      return AI_RESPONSE;
    },
    upsertMatch: async args => {
      upserts.push(args);
      return { id: 9, request_kind: args.requestKind, status: args.status };
    },
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
      await service.runSingleRequestMatch(501);
    });

    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].status, "PENDING");
    assert.equal(upserts[0].requestKind, "SINGLE");
    assert.equal(upserts[0].requestId, 501);
    assert.deepEqual(upserts[0].query, {
      code: "",
      name: "PUMP LIFT",
      desc: "HEAVY DUTY",
    });

    assert.equal(upserts[1].status, "DONE");
    assert.equal(upserts[1].topSimilarity, 0.9731);
    assert.equal(upserts[1].recommendations[0].rank, 1);
    assert.equal(upserts[1].recommendations[1].rank, 2);
    assert.equal(upserts[1].correctedName, "PUMP LIFT");
    assert.equal(upserts[1].typoCorrected, false);
    assert.equal(upserts[1].latencyMs, 190);
    assert.deepEqual(upserts[1].entities, AI_RESPONSE.entities);

    assert.equal(sentQuery.name, "PUMP LIFT");
    assert.equal(sentQuery.topK, 5);
  } finally {
    restore();
  }
});

test("runSingleRequestMatch stores the described failure instead of throwing", async () => {
  const upserts = [];
  const restore = stubService({
    loadSingleRequestRow: async () => CREATE_ROW,
    callRecommender: async () => {
      const error = new Error("timeout of 30000ms exceeded");
      error.code = "ECONNABORTED";
      throw error;
    },
    upsertMatch: async args => {
      upserts.push(args);
      return { id: 9, status: args.status };
    },
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
      await assert.doesNotReject(() => service.runSingleRequestMatch(501));
    });

    assert.equal(upserts.length, 2);
    assert.equal(upserts[1].status, "FAILED");
    assert.equal(upserts[1].error, "AI recommender timed out");
  } finally {
    restore();
  }
});

test("runSingleRequestMatch swallows a database failure", async () => {
  const restore = stubService({
    loadSingleRequestRow: async () => {
      throw new Error("connection terminated unexpectedly");
    },
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
      assert.equal(await service.runSingleRequestMatch(501), null);
    });
  } finally {
    restore();
  }
});

test("runSingleRequestMatch writes nothing at all for a Change ticket", async () => {
  const upserts = [];
  let recommenderCalls = 0;
  const restore = stubService({
    loadSingleRequestRow: async () => ({ ...CREATE_ROW, ticket_type: "Change" }),
    callRecommender: async () => {
      recommenderCalls += 1;
      return AI_RESPONSE;
    },
    upsertMatch: async args => {
      upserts.push(args);
      return { id: 9 };
    },
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
      assert.equal(await service.runSingleRequestMatch(501), null);
    });
    assert.deepEqual(upserts, []);
    assert.equal(recommenderCalls, 0);
  } finally {
    restore();
  }
});

test("runSingleRequestMatch does nothing while the feature is off", async () => {
  let loads = 0;
  const restore = stubService({
    loadSingleRequestRow: async () => {
      loads += 1;
      return CREATE_ROW;
    },
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "false" }, async () => {
      assert.equal(await service.runSingleRequestMatch(501), null);
    });
    assert.equal(loads, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// runMassRequestMatch — every line PENDING first, then one call at a time. Not
// Promise.all: a 30-row request would otherwise open 30 simultaneous
// connections to a single-process model server.
// ---------------------------------------------------------------------------

test("runMassRequestMatch pends every item, then calls sequentially and survives one failure", async () => {
  const upserts = [];
  const events = [];
  let inFlight = 0;

  const restore = stubService({
    loadMassRequestItems: async () => [
      {
        id: 11,
        mass_request_id: 7,
        item_no: 1,
        material_description: "PUMP LIFT",
        po_text: "HEAVY DUTY",
        spesifikasi_tambahan: null,
      },
      {
        id: 12,
        mass_request_id: 7,
        item_no: 2,
        material_description: "INSERT EXHAUST",
        po_text: null,
        spesifikasi_tambahan: "STAINLESS STEEL",
      },
    ],
    callRecommender: async payload => {
      inFlight += 1;
      // Sequential means the second call cannot start before the first has
      // settled — overlapping calls would show up here.
      assert.equal(inFlight, 1);
      events.push(`start:${payload.name}`);
      await tick();
      inFlight -= 1;
      events.push(`end:${payload.name}`);
      if (payload.name === "PUMP LIFT") {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:8000");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return AI_RESPONSE;
    },
    upsertMatch: async args => {
      upserts.push(args);
      return { id: args.requestId, status: args.status, item_no: args.requestId - 10 };
    },
  });

  try {
    const results = await withEnv(
      { MATERIAL_AI_MATCH_ENABLED: "true" },
      async () => service.runMassRequestMatch(7)
    );

    assert.deepEqual(
      upserts.map(u => `${u.requestId}:${u.status}`),
      ["11:PENDING", "12:PENDING", "11:FAILED", "12:DONE"]
    );
    assert.deepEqual(events, [
      "start:PUMP LIFT",
      "end:PUMP LIFT",
      "start:INSERT EXHAUST",
      "end:INSERT EXHAUST",
    ]);
    assert.equal(upserts[2].error, "AI recommender unreachable");
    assert.equal(upserts[3].topSimilarity, 0.9731);
    assert.equal(upserts[0].massRequestId, 7);
    assert.equal(results.length, 2);
  } finally {
    restore();
  }
});

test("runMassRequestMatch answers null for a request with no items", async () => {
  const restore = stubService({
    loadMassRequestItems: async () => [],
  });

  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
      assert.equal(await service.runMassRequestMatch(7), null);
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// matchRowToDto — jsonb comes back parsed, json-as-text does not, and a row
// read through the mass join can be either.
// ---------------------------------------------------------------------------

test("matchRowToDto parses string JSON columns and carries item_no", () => {
  const dto = service.matchRowToDto({
    id: "9",
    request_kind: "MASS",
    request_id: "12",
    mass_request_id: "7",
    item_no: 2,
    status: "DONE",
    error: null,
    query_code: "",
    query_name: "INSERT EXHAUST",
    query_desc: "STAINLESS STEEL",
    corrected_name: "INSERT EXHAUST",
    typo_corrected: false,
    entities: '{"category":["PUMP"],"specs":["50HZ (frequency)"]}',
    recommendations:
      '[{"rank":1,"code":"935.461.472","name":"INSERT","similarity":0.97314,"matchType":"TEXT"}]',
    top_similarity: "0.9731",
    latency_ms: "190.0",
    created_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:00:01.000Z",
  });

  assert.equal(dto.itemNo, 2);
  assert.deepEqual(dto.query, {
    code: "",
    name: "INSERT EXHAUST",
    desc: "STAINLESS STEEL",
  });
  assert.deepEqual(dto.entities.category, ["PUMP"]);
  assert.deepEqual(dto.entities.specs, ["50HZ (frequency)"]);
  assert.equal(dto.recommendations.length, 1);
  assert.equal(dto.recommendations[0].rank, 1);
  assert.equal(dto.recommendations[0].similarity, 0.9731);
  assert.equal(dto.topSimilarity, 0.9731);
  assert.equal(dto.latencyMs, 190);
});

test("matchRowToDto defaults the arrays a PENDING row has not filled yet", () => {
  const dto = service.matchRowToDto({
    id: 1,
    request_kind: "SINGLE",
    request_id: 501,
    mass_request_id: null,
    status: "PENDING",
    error: null,
    query_code: null,
    query_name: "PUMP LIFT",
    query_desc: null,
    corrected_name: null,
    typo_corrected: null,
    entities: null,
    recommendations: null,
    top_similarity: null,
    latency_ms: null,
    created_at: null,
    updated_at: null,
  });

  assert.equal(dto.itemNo, null);
  assert.deepEqual(dto.entities, { category: [], specs: [] });
  assert.deepEqual(dto.recommendations, []);
  assert.equal(dto.query.code, "");
  assert.equal(dto.query.desc, "");
  assert.equal(dto.topSimilarity, null);
  assert.equal(dto.latencyMs, null);
});

test("matchRowToDto survives a malformed json column and an absent row", () => {
  const dto = service.matchRowToDto({
    id: 1,
    request_kind: "SINGLE",
    request_id: 501,
    status: "DONE",
    query_name: "PUMP LIFT",
    entities: "{not json",
    recommendations: "[not json",
  });

  assert.deepEqual(dto.entities, { category: [], specs: [] });
  assert.deepEqual(dto.recommendations, []);
  assert.equal(service.matchRowToDto(null), null);
});

// ---------------------------------------------------------------------------
// Wiring. The routes and the four submit/rework hooks are the only things that
// make any of the above run, so they are pinned by source rather than left to
// a manual check.
// ---------------------------------------------------------------------------

const routeSource = fs.readFileSync(
  path.join(__dirname, "../routes/MaterialRoute.js"),
  "utf-8"
);

test("MaterialRoute exposes the four AI match endpoints", () => {
  for (const routePath of [
    '"/requests/single/:id/ai-match"',
    '"/requests/mass/:id/ai-match"',
    '"/requests/single/:id/ai-match/rerun"',
    '"/requests/mass/:id/ai-match/rerun"',
  ]) {
    assert.ok(
      routeSource.includes(routePath),
      `MaterialRoute.js is missing ${routePath}`
    );
  }

  for (const handler of [
    "MaterialController.getSingleRequestAiMatch",
    "MaterialController.getMassRequestAiMatch",
    "MaterialController.rerunSingleRequestAiMatch",
    "MaterialController.rerunMassRequestAiMatch",
  ]) {
    assert.ok(
      routeSource.includes(handler),
      `MaterialRoute.js is missing ${handler}`
    );
  }
});

test("submit and rework queue an AI match after the write", () => {
  const MaterialController = require("../controllers/MaterialController");

  const hooks = [
    ["createSingleRequest", "scheduleSingleRequestMatch"],
    ["createMassRequest", "scheduleMassRequestMatch"],
    ["saveSingleRequestRework", "scheduleSingleRequestMatch"],
    ["saveMassRequestRework", "scheduleMassRequestMatch"],
  ];

  for (const [handler, scheduler] of hooks) {
    const source = MaterialController[handler].toString();
    assert.ok(
      source.includes(`materialAiMatchService.${scheduler}`),
      `${handler} does not queue an AI match`
    );
  }
});

// --- Pre-save check -------------------------------------------------------

test("previewMatches ranks each line, fails an empty one and survives a failing call", async () => {
  const calls = [];
  const restore = stubService({
    callRecommender: async query => {
      calls.push(query);
      if (query.name === "BROKEN") {
        const error = new Error("refused");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return {
        corrected_name: query.name,
        typo_corrected: false,
        entities: { category: ["PUMP"], specs: [] },
        recommendations: [
          { code: "910.016.169", name: "PUMP,DOSING", similarity: 0.744377, match_type: "TEXT" },
        ],
      };
    },
  });
  try {
    const results = await withEnv({ MATERIAL_AI_MATCH_TOP_K: "3" }, () =>
      service.previewMatches([
        { key: 0, query: { name: "  PUMP   LIFT ", desc: "50HZ" } },
        { key: 1, query: { name: "" } },
        { key: 2, query: { name: "BROKEN" } },
      ])
    );

    assert.equal(results.length, 3);
    assert.equal(results[0].key, 0);
    assert.equal(results[0].status, "DONE");
    assert.equal(results[0].query.name, "PUMP LIFT");
    assert.equal(results[0].topSimilarity, 0.7444);
    assert.deepEqual(results[0].entities, { category: ["PUMP"], specs: [] });
    assert.equal(results[0].recommendations[0].rank, 1);

    assert.equal(results[1].status, "FAILED");
    assert.match(results[1].error, /empty/i);

    assert.equal(results[2].status, "FAILED");
    assert.equal(results[2].error, "AI recommender unreachable");

    // The empty line never reaches the recommender; top_k comes from config.
    assert.deepEqual(calls.map(call => call.name), ["PUMP LIFT", "BROKEN"]);
    assert.equal(calls[0].topK, 3);
  } finally {
    restore();
  }
});

test("previewMatches asks about at most ten lines", async () => {
  let count = 0;
  const restore = stubService({
    callRecommender: async () => {
      count += 1;
      return { recommendations: [] };
    },
  });
  try {
    const lines = Array.from({ length: 12 }, (_, key) => ({ key, query: { name: `ITEM ${key}` } }));
    const results = await service.previewMatches(lines);
    assert.equal(results.length, 10);
    assert.equal(count, 10);
  } finally {
    restore();
  }
});

test("sanitizeRequesterReview only accepts an explicit confirmation and caps the list", () => {
  assert.equal(service.sanitizeRequesterReview(null), null);
  assert.equal(service.sanitizeRequesterReview({ confirmedNew: "true" }), null);
  assert.equal(service.sanitizeRequesterReview({ confirmedNew: false }), null);

  const review = service.sanitizeRequesterReview({
    confirmedNew: true,
    recommendations: Array.from({ length: 15 }, (_, index) => ({
      rank: 99,
      code: ` 9${index} `,
      name: "X".repeat(400),
      similarity: "0.123456",
      matchType: "",
      extra: "dropped",
    })),
  });
  assert.equal(review.confirmedNew, true);
  assert.equal(review.recommendations.length, 10);
  assert.deepEqual(review.recommendations[0], {
    rank: 1,
    code: "90",
    name: "X".repeat(300),
    similarity: 0.1235,
    matchType: "TEXT",
    source: "catalog",
    retired: false,
    requestStatus: "",
  });
});

test("sanitizeRequesterReview records a confirmation with no matches shown", () => {
  assert.deepEqual(service.sanitizeRequesterReview({ confirmedNew: true }), {
    confirmedNew: true,
    recommendations: [],
  });
});

test("pairMassReviewsWithItems maps form rows to saved items by filled position", () => {
  // Form rows 0, 2 and 5 were filled, so they were saved as items 1, 2 and 3.
  const items = [
    { id: 501, item_no: 1 },
    { id: 502, item_no: 2 },
    { id: 503, item_no: 3 },
  ];
  const pairs = service.pairMassReviewsWithItems(
    [
      { rowIndex: 5, confirmedNew: true },
      { rowIndex: 0, confirmedNew: true },
      { rowIndex: 3, confirmedNew: true }, // not a filled row: dropped
      { rowIndex: "2", confirmedNew: true },
    ],
    [0, 2, 5],
    items
  );
  assert.deepEqual(
    pairs.map(pair => [pair.review.rowIndex, pair.item.id]),
    [
      [5, 503],
      [0, 501],
      ["2", 502],
    ]
  );
  assert.deepEqual(service.pairMassReviewsWithItems(null, [0], items), []);
});

test("matchRowToDto reports the requester review only when it was confirmed", () => {
  const confirmed = service.matchRowToDto({
    id: 1,
    request_kind: "SINGLE",
    request_id: 7,
    status: "DONE",
    recommendations: [],
    requester_confirmed_new: true,
    requester_reviewed_at: "2026-09-28T03:00:00Z",
    requester_reviewed_by: "u-1",
    requester_review: '[{"code":"1"},{"code":"2"}]',
  });
  assert.deepEqual(confirmed.requesterReview, {
    confirmedNew: true,
    reviewedAt: "2026-09-28T03:00:00Z",
    reviewedBy: "u-1",
    shownCount: 2,
  });

  const none = service.matchRowToDto({ id: 2, status: "DONE", requester_confirmed_new: null });
  assert.equal(none.requesterReview, null);
});

function fakeResponse() {
  return {
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
}

test("previewAiMatch answers enabled:false and calls nothing while the feature is off", async () => {
  const MaterialController = require("../controllers/MaterialController");
  let called = false;
  const original = service.previewMatches;
  service.previewMatches = async () => {
    called = true;
    return [];
  };
  try {
    const res = fakeResponse();
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: undefined }, () =>
      MaterialController.previewAiMatch({ body: { kind: "mass", rows: [{ description: "X" }] } }, res)
    );
    assert.deepEqual(res.body, { success: true, enabled: false, data: [] });
    assert.equal(called, false);
  } finally {
    service.previewMatches = original;
  }
});

test("previewAiMatch builds mass queries the same way the stored run does", async () => {
  const MaterialController = require("../controllers/MaterialController");
  let received;
  const original = service.previewMatches;
  service.previewMatches = async lines => {
    received = lines;
    return [{ key: 4, status: "DONE" }];
  };
  try {
    const res = fakeResponse();
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () =>
      MaterialController.previewAiMatch(
        {
          body: {
            kind: "mass",
            rows: [{ rowIndex: 4, description: "PUMP LIFT", poText: "50HZ", spesifikasiTambahan: "3 PHASE" }],
          },
        },
        res
      )
    );
    assert.deepEqual(received, [{ key: 4, query: { code: "", name: "PUMP LIFT", desc: "50HZ 3 PHASE" }, siblings: [] }]);
    assert.deepEqual(res.body, { success: true, enabled: true, data: [{ key: 4, status: "DONE" }] });
  } finally {
    service.previewMatches = original;
  }
});

test("previewAiMatch composes a single description from the template like the save does", async () => {
  const MaterialController = require("../controllers/MaterialController");
  const MaterialTemplate = require("../models/MaterialTemplateModel");
  const originalValidate = MaterialTemplate.validateMaterialRequestTemplate;
  const originalPreview = service.previewMatches;
  let received;
  MaterialTemplate.validateMaterialRequestTemplate = async () => ({
    template: {
      fields: [
        { fieldKey: "size", fieldOrder: 2 },
        { fieldKey: "noun", fieldOrder: 1 },
      ],
    },
    normalizedTemplateValues: { noun: "PUMP,LIFT", size: "50HZ" },
  });
  service.previewMatches = async lines => {
    received = lines;
    return [];
  };
  try {
    const res = fakeResponse();
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () =>
      MaterialController.previewAiMatch(
        { body: { kind: "single", materialGroupCode: "910", requestFields: {}, templateValues: {} } },
        res
      )
    );
    assert.deepEqual(received, [{ key: "single", query: { code: "", name: "PUMP,LIFT 50HZ", desc: "" } }]);
  } finally {
    MaterialTemplate.validateMaterialRequestTemplate = originalValidate;
    service.previewMatches = originalPreview;
  }
});

test("previewAiMatch rejects an unknown kind and an oversized batch", async () => {
  const MaterialController = require("../controllers/MaterialController");
  await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, async () => {
    const unknown = fakeResponse();
    await MaterialController.previewAiMatch({ body: { kind: "other" } }, unknown);
    assert.equal(unknown.statusCode, 400);

    const tooMany = fakeResponse();
    await MaterialController.previewAiMatch(
      { body: { kind: "mass", rows: Array.from({ length: 11 }, () => ({ description: "X" })) } },
      tooMany
    );
    assert.equal(tooMany.statusCode, 400);

    const noGroup = fakeResponse();
    await MaterialController.previewAiMatch({ body: { kind: "single" } }, noGroup);
    assert.equal(noGroup.statusCode, 400);
  });
});

test("MaterialRoute exposes the pre-save preview", () => {
  assert.ok(routeSource.includes('"/ai-match/preview"'));
  assert.ok(routeSource.includes("MaterialController.previewAiMatch"));
});

test("single and mass submit record the requester's confirmation after the write", () => {
  const MaterialController = require("../controllers/MaterialController");
  assert.ok(MaterialController.createSingleRequest.toString().includes("recordAiMatchReviewSafely"));
  assert.ok(MaterialController.createMassRequest.toString().includes("recordMassAiMatchReviewsSafely"));
});

// ---------------------------------------------------------------------------
// Requests not in SAP yet. Two requests for the same new part — on the same
// day, or as two lines of one batch — must see each other, so every line goes
// to the AI with the open requests (minus itself) as candidates.
// ---------------------------------------------------------------------------

test("normalizeRecommendations keeps where a recommendation comes from", () => {
  const [request, retired] = service.normalizeRecommendations([
    { code: "1000000071", name: "P/N 7X-2042 SEAL", similarity: 0.98, match_type: "PART NUMBER", source: "request", request_status: " Submit " },
    { code: "937.111.I62", name: "(NOT USE) P/N X HOSE", similarity: 0.9, match_type: "TEXT", source: "catalog", retired: true, request_status: "ignored" },
  ]);
  assert.equal(request.source, "request");
  assert.equal(request.requestStatus, "Submit");
  assert.equal(request.retired, false);
  assert.equal(retired.source, "catalog");
  assert.equal(retired.retired, true);
  assert.equal(retired.requestStatus, "");
  assert.equal(service.normalizeRecommendations([{ code: "1", source: "elsewhere" }])[0].source, "catalog");
});

test("runSingleRequestMatch sends the open requests except itself", async () => {
  let sent = null;
  const restore = stubService({
    loadSingleRequestRow: async () => CREATE_ROW,
    loadInFlightCandidates: async () => [
      { kind: "SINGLE", id: 501, ref: "1000000001", name: "PUMP LIFT", desc: "", status: "Submit" },
      { kind: "SINGLE", id: 502, ref: "1000000002", name: "PUMP LIFT 50HZ", desc: "", status: "Submit" },
      { kind: "MASS", id: 501, ref: "2000000001", name: "PUMP", desc: "", status: "Submit" },
    ],
    callRecommender: async payload => {
      sent = payload;
      return AI_RESPONSE;
    },
    upsertMatch: async args => ({ id: 9, request_kind: args.requestKind, status: args.status }),
  });
  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () => service.runSingleRequestMatch(501));
    assert.deepEqual(sent.candidates.map(c => c.ref), ["1000000002", "2000000001"]);
  } finally {
    restore();
  }
});

test("runSingleRequestMatch still matches when the open requests cannot be loaded", async () => {
  let sent = null;
  const restore = stubService({
    loadSingleRequestRow: async () => CREATE_ROW,
    loadInFlightCandidates: async () => {
      throw new Error("relation does not exist");
    },
    callRecommender: async payload => {
      sent = payload;
      return AI_RESPONSE;
    },
    upsertMatch: async args => ({ id: 9, request_kind: args.requestKind, status: args.status }),
  });
  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () => service.runSingleRequestMatch(501));
    assert.deepEqual(sent.candidates, []);
  } finally {
    restore();
  }
});

test("runMassRequestMatch loads the open requests once and leaves each item out of its own list", async () => {
  let loads = 0;
  const sent = [];
  const restore = stubService({
    loadMassRequestItems: async () => [
      { id: 11, item_no: 1, material_description: "P/N 41C3478 RIM AS" },
      { id: 12, item_no: 2, material_description: "P/N 41C3478 RIM AS ASSY" },
    ],
    loadInFlightCandidates: async () => {
      loads += 1;
      return [
        { kind: "MASS", id: 11, ref: "2000000009-1", name: "P/N 41C3478 RIM AS", desc: "", status: "Submit" },
        { kind: "MASS", id: 12, ref: "2000000009-2", name: "P/N 41C3478 RIM AS ASSY", desc: "", status: "Submit" },
      ];
    },
    callRecommender: async payload => {
      sent.push(payload.candidates.map(c => c.ref));
      return AI_RESPONSE;
    },
    upsertMatch: async args => ({ id: 1, request_kind: args.requestKind, status: args.status }),
  });
  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () => service.runMassRequestMatch(7));
    assert.equal(loads, 1);
    assert.deepEqual(sent, [["2000000009-2"], ["2000000009-1"]]);
  } finally {
    restore();
  }
});

test("previewMatches sends the other lines of the form before the open requests", async () => {
  let sent = null;
  const restore = stubService({
    loadInFlightCandidates: async () => [{ kind: "SINGLE", id: 1, ref: "1000000071", name: "SEAL", desc: "", status: "Submit" }],
    callRecommender: async payload => {
      sent = payload;
      return AI_RESPONSE;
    },
  });
  try {
    await service.previewMatches([
      {
        key: 0,
        query: { code: "", name: "P/N 41C3478 RIM AS", desc: "" },
        siblings: [{ ref: "Baris 2", name: " P/N 41C3478  RIM ", desc: "" }, { ref: "Baris 3", name: "", desc: "" }],
      },
    ]);
    assert.deepEqual(
      sent.candidates.map(c => [c.ref, c.name, c.status]),
      [["Baris 2", "P/N 41C3478 RIM", "this request"], ["1000000071", "SEAL", "Submit"]]
    );
  } finally {
    restore();
  }
});

test("previewAiMatch passes the other rows of a mass form as siblings, never the row itself", async () => {
  const MaterialController = require("../controllers/MaterialController");
  let received;
  const original = service.previewMatches;
  service.previewMatches = async lines => {
    received = lines;
    return [];
  };
  try {
    await withEnv({ MATERIAL_AI_MATCH_ENABLED: "true" }, () =>
      MaterialController.previewAiMatch(
        {
          body: {
            kind: "mass",
            rows: [{ rowIndex: 0, description: "PUMP LIFT", poText: "", spesifikasiTambahan: "" }],
            siblings: [
              { rowIndex: 0, description: "PUMP LIFT" },
              { rowIndex: 2, description: "PUMP LIFT 50HZ", poText: "3 PHASE" },
            ],
          },
        },
        fakeResponse()
      )
    );
    assert.deepEqual(received[0].siblings, [{ ref: "Baris 3", name: "PUMP LIFT 50HZ", desc: "3 PHASE" }]);
  } finally {
    service.previewMatches = original;
  }
});

test("callRecommender sends the candidates trimmed and capped", async () => {
  const axios = require("axios");
  const originalPost = axios.post;
  let body = null;
  axios.post = async (url, payload) => {
    body = payload;
    return { data: AI_RESPONSE };
  };
  try {
    await service.callRecommender({
      name: "PUMP",
      candidates: Array.from({ length: 400 }, (_, i) => ({ ref: ` R${i} `, name: ` N ${i} `, desc: null, status: "Submit", kind: "SINGLE", id: i })),
    });
    assert.equal(body.candidates.length, 300);
    assert.deepEqual(body.candidates[0], { ref: "R0", name: "N 0", desc: "", status: "Submit" });
  } finally {
    axios.post = originalPost;
  }
});

test("a mass item is shown with its Mass Request ticket, not only its item number", () => {
  assert.equal(
    service.describeInFlightStatus({ status: "Submit", batch_no: " 2000000008 ", item_no: 1 }),
    "Mass 2000000008 #1 · Submit"
  );
  assert.equal(
    service.describeInFlightStatus({ status: "done", batch_no: "2000000008", item_no: 3 }),
    "Mass 2000000008 #3 · DONE, not in SAP yet"
  );
  assert.equal(service.describeInFlightStatus({ status: "Rework", batch_no: null, item_no: null }), "Rework");
  assert.equal(
    service.normalizeRecommendations([
      { code: "3000000032", source: "request", request_status: "Mass 2000000008 #1 · DONE, not in SAP yet" },
    ])[0].requestStatus,
    "Mass 2000000008 #1 · DONE, not in SAP yet"
  );
});
