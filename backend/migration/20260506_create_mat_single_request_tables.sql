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
