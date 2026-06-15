-- Mass material request persistence tables
-- Created: 2026-06-02
-- Purpose:
-- 1. Persist batch material-create submissions (1..10 rows per submit).
-- 2. Mirror the mat_single_request approval chain per item, resolved from
--    mat_approvers_matrix via buildSingleRequestApprovalSnapshot.

BEGIN;

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
