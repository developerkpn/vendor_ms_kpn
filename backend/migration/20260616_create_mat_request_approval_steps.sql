-- Dynamic approvers — per-request approval STATE as one row per stage.
-- Date: 2026-06-16
-- One step per stage, frozen at request-create time. "Current stage = lowest
-- level whose status is not APPROVED" (NULL reads as WAITING).
--   kind = 'MANUAL' : approver_user_id is the assigned approver (from the matrix).
--   kind = 'MDM'    : the final stage. approver_user_id starts NULL (an open pool
--                     visible to all MDM_MATERIAL users); an MDM user "grabs" it,
--                     which atomically sets approver_user_id + claimed_at; after
--                     that only the claimer sees/acts on it.
-- These tables are written ALONGSIDE the existing approval_1/2/3_* columns during
-- the dual-write phase; the old columns stay authoritative until Phase 6 cutover.

CREATE TABLE IF NOT EXISTS public.mat_single_request_approval_step (
    id bigserial PRIMARY KEY,
    request_id bigint NOT NULL REFERENCES public.mat_single_request(id) ON DELETE CASCADE,
    level int2 NOT NULL CHECK (level >= 1),
    kind varchar(8) NOT NULL CHECK (kind IN ('MANUAL', 'MDM')),
    approver_user_id varchar(100) NULL,
    claimed_at timestamptz NULL,
    status varchar(20) NULL CHECK (status IS NULL OR status IN ('WAITING', 'APPROVED', 'REWORK', 'REJECTED')),
    acted_at timestamptz NULL,
    remark text NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_single_request_approval_step UNIQUE (request_id, level)
);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_approval_step_inbox
    ON public.mat_single_request_approval_step (approver_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mat_single_request_approval_step_one_mdm
    ON public.mat_single_request_approval_step (request_id) WHERE kind = 'MDM';

CREATE TABLE IF NOT EXISTS public.mat_mass_request_item_approval_step (
    id bigserial PRIMARY KEY,
    item_id bigint NOT NULL REFERENCES public.mat_mass_request_item(id) ON DELETE CASCADE,
    level int2 NOT NULL CHECK (level >= 1),
    kind varchar(8) NOT NULL CHECK (kind IN ('MANUAL', 'MDM')),
    approver_user_id varchar(100) NULL,
    claimed_at timestamptz NULL,
    status varchar(20) NULL CHECK (status IS NULL OR status IN ('WAITING', 'APPROVED', 'REWORK', 'REJECTED')),
    acted_at timestamptz NULL,
    remark text NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_mass_request_item_approval_step UNIQUE (item_id, level)
);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_approval_step_inbox
    ON public.mat_mass_request_item_approval_step (approver_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mat_mass_request_item_approval_step_one_mdm
    ON public.mat_mass_request_item_approval_step (item_id) WHERE kind = 'MDM';
