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
