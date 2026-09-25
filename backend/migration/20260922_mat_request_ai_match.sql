-- AI material match — one row per material line of a request.
-- Created: 2026-09-22
--
-- When a requester submits (or reworks) a single or mass material request, the
-- backend asks the material recommender "does something like this already
-- exist?" and stores the ranked answer here. The approver then sees, next to
-- the request, the existing materials that look like the one being asked for,
-- with a similarity per row.
--
-- ADVISORY ONLY. Nothing in here feeds the approval chain — no trigger, no FK,
-- no column read by the step engine or the SAP staging push. A high similarity
-- does not block a request and a missing row does not hold one up; the approver
-- decides. Keep it that way: the score is embedding-derived, and a false
-- "this already exists" must never be able to stall a real material.
--
-- One row per material LINE, not per request: a single request is one line, a
-- mass request is one line per item. request_id therefore points at
-- mat_single_request.id for SINGLE and at mat_mass_request_item.id for MASS,
-- with mass_request_id carrying the batch so the approval dialog can read a
-- whole mass request in one query. Deliberately NO foreign keys — the row is
-- advisory and must not be able to block a request delete.
--
-- A re-run overwrites in place (the UNIQUE on request_kind + request_id is what
-- the upsert conflicts on), so re-queueing a match after a rework replaces the
-- stale ranking instead of stacking a second one the UI would have to choose
-- between.
--
-- Applied manually, like 20260812_create_ai_validation.sql — it is not wired
-- into ensureSingleRequestSchema.

CREATE TABLE IF NOT EXISTS mat_request_ai_match (
    id BIGSERIAL PRIMARY KEY,
    request_kind VARCHAR(8) NOT NULL,      -- SINGLE | MASS
    request_id BIGINT NOT NULL,            -- SINGLE: mat_single_request.id, MASS: mat_mass_request_item.id
    mass_request_id BIGINT NULL,           -- MASS only: mat_mass_request.id (batch read path)
    status VARCHAR(16) NOT NULL,           -- PENDING | DONE | FAILED
    error TEXT NULL,
    query_code VARCHAR(50) NULL,
    query_name TEXT NOT NULL,
    query_desc TEXT NULL,
    corrected_name TEXT NULL,
    typo_corrected BOOLEAN NULL,
    entities JSONB NULL,
    recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_similarity NUMERIC(6, 4) NULL,
    latency_ms NUMERIC(10, 1) NULL,
    ai_response JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_request_ai_match UNIQUE (request_kind, request_id),
    CONSTRAINT chk_mat_request_ai_match_kind CHECK (request_kind IN ('SINGLE', 'MASS')),
    CONSTRAINT chk_mat_request_ai_match_status CHECK (status IN ('PENDING', 'DONE', 'FAILED'))
);

-- "Every line of this mass request" — the mass approval dialog's only read.
CREATE INDEX IF NOT EXISTS ix_mat_request_ai_match_mass
    ON mat_request_ai_match (mass_request_id)
    WHERE mass_request_id IS NOT NULL;
