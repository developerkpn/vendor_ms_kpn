-- mat_single_request.rework_stage: accept every approval level.
-- Created: 2026-09-29
--
-- The constraint dates from the fixed three-stage flow and only allowed
-- 'Approval 1'..'Approval 3' (plus 'Master Data'). Since the dynamic-approver
-- flow a requester's chain can hold any number of manual steps, and a rework
-- stores the step label (stepLabel: 'Approval <level>' or 'Master Data'). A
-- rework requested at Approval 4 or later was therefore rejected by the
-- database (23514) and the approver's rework action failed.
--
-- Safe to re-run: the constraint is dropped and recreated with the same name.

BEGIN;

ALTER TABLE public.mat_single_request
    DROP CONSTRAINT IF EXISTS chk_mat_single_request_rework_stage;

ALTER TABLE public.mat_single_request
    ADD CONSTRAINT chk_mat_single_request_rework_stage
    CHECK (
        rework_stage IS NULL
        OR rework_stage = 'Master Data'
        OR rework_stage ~ '^Approval [1-9][0-9]*$'
    );

COMMIT;
