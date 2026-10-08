-- Commit vendor completion and its external work together in PostgreSQL.
-- Oracle uploads and notification emails run afterward, with durable retries.
CREATE TABLE IF NOT EXISTS vendor_submission_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_token text NOT NULL,
    ven_id text NOT NULL,
    job_type text NOT NULL CHECK (job_type IN
        ('SAP_UPLOAD', 'VERIFICATION_EMAIL', 'TAX_EMAIL', 'COMPLETION_EMAIL')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    depends_on_type text,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,
    claim_token uuid,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (ticket_token, job_type)
);

CREATE INDEX IF NOT EXISTS vendor_submission_outbox_due_idx
    ON vendor_submission_outbox (next_attempt_at, id)
    WHERE status IN ('PENDING', 'PROCESSING');
