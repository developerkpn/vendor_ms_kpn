-- Dynamic approvers — per-requester ordered MANUAL approver levels.
-- Date: 2026-06-16
-- The Master Data (MDM) stage is NOT stored here: it is always appended in code
-- as the final stage and resolved from the MDM_MATERIAL group via a claim/grab
-- queue at runtime. This table holds only the admin-configured manual approvers.
-- The existing mat_approvers_matrix row stays as the per-requester header/anchor
-- (audit columns, MDM group config); its approval_1/2/3_user_id columns are kept
-- until the Phase 6 cutover.

CREATE TABLE IF NOT EXISTS public.mat_approvers_matrix_level (
    id bigserial PRIMARY KEY,
    requester_user_id varchar(100) NOT NULL,
    level int2 NOT NULL CHECK (level >= 1),
    approver_user_id varchar(100) NULL,           -- NULL = empty ordered slot
    created_at timestamptz NOT NULL DEFAULT NOW(),
    created_by varchar(100) NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by varchar(100) NULL,
    CONSTRAINT uq_mat_approvers_matrix_level UNIQUE (requester_user_id, level)
);

CREATE INDEX IF NOT EXISTS idx_mat_approvers_matrix_level_req
    ON public.mat_approvers_matrix_level (requester_user_id, level);

COMMENT ON TABLE public.mat_approvers_matrix_level IS
    'Per-requester ordered manual approver levels (1..N). MDM is appended in code as the final stage.';
