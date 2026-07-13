-- ============================================================================
-- Group A rebuild for vendor_ms_dev  (run manually in DBeaver/psql)
-- Drops the request-workflow tables (incl. the approver matrix: 5 config rows
-- will be lost) and recreates them fresh from the consolidated CREATE scripts.
-- Keeps mat_sap_data / mat_item_group / mat_item_sub_group / mst_user etc.
-- Generated: 2026-06-15
-- ============================================================================

BEGIN;

-- 1) DROP Group A (CASCADE only affects FKs among these tables) -------------
DROP TABLE IF EXISTS
    public.mat_single_request_edit_history,
    public.mat_single_request_attachment,
    public.mat_mass_request_attachment,
    public.mat_mass_request_item,
    public.mat_mass_request,
    public.mat_single_request,
    public.mat_single_request_approval,
    public.mat_approvers_matrix
CASCADE;

-- 2) mat_single_request (+ attachment)  [20260506_create_mat_single_request_tables.sql] ------------------------------------------
-- Single material request persistence tables
-- Created: 2026-05-06 (consolidated 2026-06-15)
-- Purpose:
-- 1. Store single material request submissions separately from mat_sap_data.
-- 2. Store request attachments without altering existing material attachment tables.
-- 3. Hold the per-request approval STATE (approval_1/2/3_*), rework metadata,
--    change/extend reason, and the final material code.
-- Note: the per-requester approver assignment (who approves a given requester's
--       requests) lives in mat_approvers_matrix, not here.

CREATE TABLE IF NOT EXISTS public.mat_single_request (
    id bigserial PRIMARY KEY,
    request_no varchar(30) NOT NULL,
    ticket_type varchar(20) NOT NULL DEFAULT 'Create',
    change_extend_reason text NULL,
    material_group_id int4 NOT NULL,
    material_sub_group_id int4 NULL,
    plant_code varchar(20) NULL,
    sloc_code varchar(20) NULL,
    material_description varchar(255) NOT NULL,
    base_uom varchar(20) NOT NULL,
    long_text_1 text NULL,
    long_text_2 text NULL,
    long_text_3 text NULL,
    template_payload jsonb NULL,
    material_code varchar(50) NULL,
    final_code varchar(11) NULL,
    status varchar(20) NOT NULL DEFAULT 'Submit',
    assigned_to varchar(100) NOT NULL DEFAULT 'Approval 1',
    -- Per-request approval state (assignees copied from mat_approvers_matrix at create)
    approval_1_user_id varchar(100) NULL,
    approval_1_status varchar(20) NULL DEFAULT 'WAITING',
    approval_1_at timestamptz NULL,
    approval_1_remark text NULL,
    approval_2_user_id varchar(100) NULL,
    approval_2_status varchar(20) NULL,
    approval_2_at timestamptz NULL,
    approval_2_remark text NULL,
    approval_3_user_id varchar(100) NULL,
    approval_3_status varchar(20) NULL,
    approval_3_at timestamptz NULL,
    approval_3_remark text NULL,
    -- Latest requester rework metadata
    rework_stage varchar(32) NULL,
    rework_by_user_id varchar(64) NULL,
    rework_at timestamptz NULL,
    rework_reason text NULL,
    created_by varchar(100) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_single_request_no UNIQUE (request_no),
    CONSTRAINT fk_mat_single_request_group
        FOREIGN KEY (material_group_id)
        REFERENCES public.mat_item_group(id),
    CONSTRAINT fk_mat_single_request_sub_group
        FOREIGN KEY (material_sub_group_id)
        REFERENCES public.mat_item_sub_group(id),
    CONSTRAINT mat_single_request_rework_by_user_id_fkey
        FOREIGN KEY (rework_by_user_id)
        REFERENCES public.mst_user(user_id),
    CONSTRAINT chk_mat_single_request_approval_1_status
        CHECK (approval_1_status IS NULL OR approval_1_status IN ('WAITING', 'APPROVED', 'REWORK', 'REJECTED')),
    CONSTRAINT chk_mat_single_request_approval_2_status
        CHECK (approval_2_status IS NULL OR approval_2_status IN ('WAITING', 'APPROVED', 'REWORK', 'REJECTED')),
    CONSTRAINT chk_mat_single_request_approval_3_status
        CHECK (approval_3_status IS NULL OR approval_3_status IN ('WAITING', 'APPROVED', 'REWORK', 'REJECTED')),
    CONSTRAINT chk_mat_single_request_rework_stage
        CHECK (rework_stage IS NULL OR rework_stage IN ('Approval 1', 'Approval 2', 'Approval 3', 'Master Data'))
);

CREATE INDEX IF NOT EXISTS idx_mat_single_request_status
    ON public.mat_single_request(status);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_created_by
    ON public.mat_single_request(created_by);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_group
    ON public.mat_single_request(material_group_id);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_sub_group
    ON public.mat_single_request(material_sub_group_id);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_approval_1_user_id
    ON public.mat_single_request(approval_1_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_approval_2_user_id
    ON public.mat_single_request(approval_2_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_approval_3_user_id
    ON public.mat_single_request(approval_3_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_single_request_rework_by_user_id
    ON public.mat_single_request(rework_by_user_id);

COMMENT ON COLUMN public.mat_single_request.change_extend_reason IS
    'Requester reason captured for Change and Extend ticket types.';
COMMENT ON COLUMN public.mat_single_request.material_code IS
    'Final material code assigned by Master Data when the request is completed.';
COMMENT ON COLUMN public.mat_single_request.final_code IS
    'Final material code composed at Approval 3 from mat_item_group.code, mat_item_sub_group.code, and user-entered 3-digit suffix.';
COMMENT ON COLUMN public.mat_single_request.rework_stage IS
    'Latest approval stage that requested requester rework.';
COMMENT ON COLUMN public.mat_single_request.rework_by_user_id IS
    'User id of approver or ADMIN who requested latest rework.';
COMMENT ON COLUMN public.mat_single_request.rework_at IS
    'Timestamp when latest requester rework was requested.';
COMMENT ON COLUMN public.mat_single_request.rework_reason IS
    'Reason text for latest requester rework request.';

CREATE TABLE IF NOT EXISTS public.mat_single_request_attachment (
    id bigserial PRIMARY KEY,
    request_id bigint NOT NULL,
    file_name varchar(255) NOT NULL,
    file_path varchar(500) NOT NULL,
    file_type varchar(100) NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mat_single_request_attachment_request
        FOREIGN KEY (request_id)
        REFERENCES public.mat_single_request(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mat_single_request_attachment_request_id
    ON public.mat_single_request_attachment(request_id);

-- 3) mat_single_request_edit_history  [20260520_create_mat_single_request_edit_history.sql] ------------------------------------------
-- Single material request edit history
-- Created: 2026-05-20 (cleaned 2026-06-15)
-- Purpose: snapshot of request values captured at each approval/requestor edit.

CREATE TABLE IF NOT EXISTS public.mat_single_request_edit_history (
    id bigserial PRIMARY KEY,
    request_id bigint NOT NULL,
    request_no varchar(30) NOT NULL,
    approval_stage varchar(20) NOT NULL,
    approved_by_user_id varchar(100) NULL,
    approve_remark text NULL,
    approved_at timestamptz NOT NULL DEFAULT NOW(),
    material_group_id int4 NOT NULL,
    material_sub_group_id int4 NULL,
    plant_code varchar(20) NULL,
    sloc_code varchar(20) NULL,
    material_description varchar(255) NOT NULL,
    base_uom varchar(20) NOT NULL,
    long_text_1 text NULL,
    long_text_2 text NULL,
    long_text_3 text NULL,
    template_payload jsonb NULL,
    created_by varchar(100) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mat_single_request_edit_history_request
        FOREIGN KEY (request_id)
        REFERENCES public.mat_single_request(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mat_single_request_edit_history_request_id
    ON public.mat_single_request_edit_history(request_id);

CREATE INDEX IF NOT EXISTS idx_mat_single_request_edit_history_approved_at
    ON public.mat_single_request_edit_history(approved_at DESC);

-- 4) mat_approvers_matrix  [20260511_create_mat_approvers_matrix.sql] ------------------------------------------
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

-- 5) mat_mass_request (+ item, + attachment)  [20260602_create_mat_mass_request_tables.sql] ------------------------------------------
-- Mass material request persistence tables
-- Created: 2026-06-02
-- Purpose:
-- 1. Persist batch material-create submissions (1..10 rows per submit).
-- 2. Mirror the mat_single_request approval chain per item, resolved from
--    mat_approvers_matrix via buildSingleRequestApprovalSnapshot.


CREATE TABLE IF NOT EXISTS public.mat_mass_request (
    id bigserial PRIMARY KEY,
    mass_request_no varchar(30) NOT NULL,
    item_count int2 NOT NULL CHECK (item_count BETWEEN 1 AND 10),
    mass_request_reason text NULL,
    created_by varchar(100) NOT NULL,
    created_by_username varchar(100) NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_mass_request_no UNIQUE (mass_request_no)
);

CREATE INDEX IF NOT EXISTS idx_mat_mass_request_created_by
    ON public.mat_mass_request(created_by);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_created_at
    ON public.mat_mass_request(created_at DESC);

COMMENT ON COLUMN public.mat_mass_request.mass_request_reason IS
    'Requester reason captured when submitting a mass material request batch.';

CREATE TABLE IF NOT EXISTS public.mat_mass_request_item (
    id bigserial PRIMARY KEY,
    mass_request_id bigint NOT NULL,
    item_no int2 NOT NULL,
    request_no varchar(30) NOT NULL,
    ticket_type varchar(20) NOT NULL DEFAULT 'Create',
    plant_code varchar(20) NULL,
    sloc_code varchar(20) NULL,
    material_group varchar(100) NULL,
    material_sub_group varchar(100) NULL,
    material_description varchar(255) NOT NULL,
    po_text text NULL,
    base_uom varchar(20) NOT NULL,
    spesifikasi_tambahan text NULL,
    status varchar(20) NOT NULL DEFAULT 'Submit',
    assigned_to varchar(100) NOT NULL DEFAULT 'Approval 1',
    created_by varchar(100) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    approval_1_user_id varchar(100) NULL,
    approval_1_status varchar(20) NULL DEFAULT 'WAITING',
    approval_1_at timestamptz NULL,
    approval_1_remark text NULL,
    approval_2_user_id varchar(100) NULL,
    approval_2_status varchar(20) NULL,
    approval_2_at timestamptz NULL,
    approval_2_remark text NULL,
    approval_3_user_id varchar(100) NULL,
    approval_3_status varchar(20) NULL,
    approval_3_at timestamptz NULL,
    approval_3_remark text NULL,
    CONSTRAINT uq_mat_mass_request_item_no UNIQUE (mass_request_id, item_no),
    CONSTRAINT uq_mat_mass_request_item_request_no UNIQUE (request_no),
    CONSTRAINT fk_mat_mass_request_item_mass FOREIGN KEY (mass_request_id)
        REFERENCES public.mat_mass_request(id) ON DELETE CASCADE,
    CONSTRAINT chk_mat_mass_request_item_approval_1_status
        CHECK (approval_1_status IS NULL OR approval_1_status IN ('WAITING','APPROVED','REWORK','REJECTED')),
    CONSTRAINT chk_mat_mass_request_item_approval_2_status
        CHECK (approval_2_status IS NULL OR approval_2_status IN ('WAITING','APPROVED','REWORK','REJECTED')),
    CONSTRAINT chk_mat_mass_request_item_approval_3_status
        CHECK (approval_3_status IS NULL OR approval_3_status IN ('WAITING','APPROVED','REWORK','REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_mass_request_id
    ON public.mat_mass_request_item(mass_request_id);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_status
    ON public.mat_mass_request_item(status);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_approval_1_user_id
    ON public.mat_mass_request_item(approval_1_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_approval_2_user_id
    ON public.mat_mass_request_item(approval_2_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_approval_3_user_id
    ON public.mat_mass_request_item(approval_3_user_id);
CREATE INDEX IF NOT EXISTS idx_mat_mass_request_item_created_by
    ON public.mat_mass_request_item(created_by);

CREATE TABLE IF NOT EXISTS public.mat_mass_request_attachment (
    id bigserial PRIMARY KEY,
    item_id bigint NOT NULL,
    file_name varchar(255) NOT NULL,
    file_path varchar(500) NOT NULL,
    file_type varchar(100) NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mat_mass_request_attachment_item FOREIGN KEY (item_id)
        REFERENCES public.mat_mass_request_item(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mat_mass_request_attachment_item_id
    ON public.mat_mass_request_attachment(item_id);


COMMIT;
