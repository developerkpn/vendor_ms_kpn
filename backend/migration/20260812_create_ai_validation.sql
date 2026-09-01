-- AI document validation (external AWS service) — one row per validation run.
-- Created: 2026-08-12
--
-- The external service checks the documents a vendor uploaded against the
-- values typed into the VMS registration form. VMS POSTs /validate and gets a
-- 202 back in under 3s; the verdict arrives ~30s later on our own webhook.
-- That is two writes to the same run, so request and result share one row
-- rather than living in two tables that would always be joined 1:1.
--
-- ADVISORY ONLY. Nothing in here feeds the approval chain — no trigger, no FK
-- into ticket, no column read by ApprovalTracker. A CRITICAL discrepancy is
-- shown to Procurement/MDM and they decide. This is deliberate: the verdict is
-- OCR-derived and a false positive must never be able to stall a real vendor.
--
-- registration_id is what we hand the AI side and get back verbatim in the
-- callback. It is ven_id, because that is the stable uuid of the thing being
-- validated and it survives ticket reissues. request_id is the AI side's own
-- id, arrives with the 202, and is the idempotency key for the webhook —
-- retries (3x after 5s/15s/45s) re-POST the same payload, so the result write
-- is ON CONFLICT (request_id) DO UPDATE and re-delivery is a no-op.
--
-- A vendor who reworks and resubmits produces a NEW row; history is kept. The
-- UI reads the newest row per ven_id.

CREATE TABLE IF NOT EXISTS ai_validation (
    id BIGSERIAL PRIMARY KEY,

    -- What was validated.
    ven_id VARCHAR(64) NOT NULL,
    ticket_token VARCHAR(64) NULL,          -- ticket.token (the FE's "ticket_id")
    ticket_num VARCHAR(64) NULL,            -- ticket.ticket_id, the human number
    bu_id VARCHAR(16) NULL,                 -- CG | UPS | DWS — decides the doc-type map

    -- Correlation with the external service.
    registration_id VARCHAR(128) NOT NULL,  -- sent as-is, echoed back in the webhook
    request_id VARCHAR(128) NULL,           -- assigned by the AI service on 202
    vendor_type VARCHAR(16) NOT NULL,       -- local | foreign

    -- Outbound leg.
    submit_status VARCHAR(24) NOT NULL,     -- PROCESSING | REJECTED | ERROR | SKIPPED
    submit_error TEXT NULL,                 -- 400 reasons, network failure, "no documents"
    request_payload JSONB NULL,             -- exactly what we POSTed, for support tickets

    -- Inbound leg (all NULL until the webhook lands).
    status VARCHAR(24) NULL,                -- VALID | VALID_WITH_NOTES | NEEDS_REVIEW | INVALID
    recommendation VARCHAR(24) NULL,        -- APPROVE | REVIEW | REJECT
    overall_score NUMERIC(5, 2) NULL,
    processed_at TIMESTAMPTZ NULL,          -- AI-side completion time
    document_results JSONB NULL,
    cross_doc_check JSONB NULL,
    discrepancy_summary JSONB NULL,
    result_metadata JSONB NULL,             -- ai_model, bedrock_calls, timings
    result_payload JSONB NULL,              -- the whole webhook body, verbatim
    result_received_at TIMESTAMPTZ NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency key for the webhook. Partial, because rows that never got a 202
-- (submit_status ERROR/REJECTED/SKIPPED) keep request_id NULL and there can be
-- many of those per vendor.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_validation_request_id
    ON ai_validation (request_id)
    WHERE request_id IS NOT NULL;

-- "Newest run for this vendor" — the only read path the UI has.
CREATE INDEX IF NOT EXISTS ix_ai_validation_ven_created
    ON ai_validation (ven_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_ai_validation_ticket_token
    ON ai_validation (ticket_token);
