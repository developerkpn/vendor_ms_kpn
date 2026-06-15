-- Material approver assignment matrix
-- Created: 2026-05-11 (consolidated 2026-06-15, formerly mat_single_request_approval)
-- Purpose:
-- 1. Per-requester approver assignment configured by admin on the material admin page.
-- 2. One row per requester (requester_user_id): who is Approval 1, Approval 2, and
--    Approval 3 for requests created by that requester.
-- 3. Approval 3 is currently system-assigned from the MDM_MATERIAL user group.
-- On request create (single or mass), these assignees are copied into the per-request
-- approval state (mat_single_request / mat_mass_request_item approval_*_user_id) with
-- initial WAITING statuses via buildSingleRequestApprovalSnapshot.

CREATE TABLE IF NOT EXISTS public.mat_approvers_matrix (
    id bigserial PRIMARY KEY,
    requester_user_id varchar(100) NOT NULL,
    approval_1_user_id varchar(100) NULL,
    approval_2_user_id varchar(100) NULL,
    approval_3_user_id varchar(100) NULL,
    approval_3_type varchar(20) NOT NULL DEFAULT 'SYSTEM',
    approval_3_group varchar(100) NOT NULL DEFAULT 'MDM_MATERIAL',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    created_by varchar(100) NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by varchar(100) NULL,
    CONSTRAINT uq_mat_approvers_matrix_requester UNIQUE (requester_user_id),
    CONSTRAINT chk_mat_approvers_matrix_3_type CHECK (approval_3_type IN ('SYSTEM'))
);

CREATE INDEX IF NOT EXISTS idx_mat_approvers_matrix_requester_user_id
    ON public.mat_approvers_matrix (requester_user_id);

COMMENT ON TABLE public.mat_approvers_matrix IS
    'Per-requester approver assignment matrix (one row per requester_user_id).';
COMMENT ON COLUMN public.mat_approvers_matrix.requester_user_id IS
    'mst_user.user_id of the requester this approver assignment applies to.';
COMMENT ON COLUMN public.mat_approvers_matrix.approval_1_user_id IS
    'Assigned Approval 1 approver for this requester.';
COMMENT ON COLUMN public.mat_approvers_matrix.approval_2_user_id IS
    'Assigned Approval 2 approver for this requester.';
COMMENT ON COLUMN public.mat_approvers_matrix.approval_3_user_id IS
    'Assigned Approval 3 / Master Data approver (system-picked from MDM_MATERIAL when unset).';
