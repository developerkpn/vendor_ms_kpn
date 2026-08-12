-- Request comment history: one row per thing somebody said about a request.
-- Created: 2026-08-12
-- Purpose:
-- 1. Keep the WHOLE conversation of a request — the requester's submit reason,
--    every approve remark, every rework reason, the reject reason — in the order
--    it happened, so "View Comments" can render it as one thread.
-- 2. Stop losing reworks. mat_single_request carries a single set of
--    rework_stage / rework_by_user_id / rework_at / rework_reason columns ("Latest
--    requester rework metadata"), and mat_*_approval_step keeps one remark per
--    step, so reworking the SAME stage twice overwrites the first reason and it
--    is gone. mat_mass_request_item has no rework columns at all. This table is
--    append-only: nothing here is ever updated, so a second rework is a second
--    row.
--
-- This table RECORDS, it does not ROUTE. The approval state a request is in
-- still lives in mat_*_approval_step and the header columns, and every write
-- path keeps updating those exactly as before — a comment row is written
-- alongside them, never instead of them. Nothing reads this table to decide
-- what happens next.
--
-- request_kind + request_id, not two nullable FKs: a comment belongs to EITHER a
-- mat_single_request row OR a mat_mass_request row, and the two id spaces are
-- independent sequences. No FK for the same reason — one column cannot reference
-- two tables. Same shape mat_rework_email uses (20260807_rework_email_thread.sql).
--
-- MASS is the batch, not the item: every approval action on a mass request
-- applies to all of its items at once (one step level updated across every
-- mat_mass_request_item), so one comment per action per batch is the whole
-- story. request_id is mat_mass_request.id.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mat_request_comment (
    id bigserial PRIMARY KEY,
    request_kind varchar(10) NOT NULL,
    request_id bigint NOT NULL,
    event_type varchar(20) NOT NULL,
    stage varchar(32) NULL,
    actor_user_id varchar(100) NULL,
    comment text NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_mat_request_comment_request_kind
        CHECK (request_kind IN ('SINGLE', 'MASS')),
    CONSTRAINT chk_mat_request_comment_event_type
        CHECK (event_type IN ('SUBMIT', 'RESUBMIT', 'APPROVE', 'REWORK', 'REJECT'))
);

-- The only read path loads one request's whole thread in submitted order.
CREATE INDEX IF NOT EXISTS idx_mat_request_comment_request
    ON public.mat_request_comment (request_kind, request_id, created_at, id);

COMMENT ON TABLE public.mat_request_comment IS
    'Append-only comment history of a material request: submit reason, approve remarks, rework reasons, reject reason. Never updated or deleted.';
COMMENT ON COLUMN public.mat_request_comment.request_kind IS
    'Which request table request_id points at: SINGLE (mat_single_request) or MASS (mat_mass_request).';
COMMENT ON COLUMN public.mat_request_comment.request_id IS
    'mat_single_request.id or mat_mass_request.id — no FK, because one column cannot reference two tables.';
COMMENT ON COLUMN public.mat_request_comment.event_type IS
    'SUBMIT / RESUBMIT are the requester (create, and save-after-rework); APPROVE / REWORK / REJECT are an approval stage acting.';
COMMENT ON COLUMN public.mat_request_comment.stage IS
    'Approval stage that acted, in step-label form (Approval 1..N / Master Data). NULL on the requester''s own events, which belong to no stage.';
COMMENT ON COLUMN public.mat_request_comment.actor_user_id IS
    'mst_user.user_id of whoever caused the event (no FK: the row must survive a user being removed).';
COMMENT ON COLUMN public.mat_request_comment.comment IS
    'What was typed. NULL where the flow does not ask for text — a Create request has no submit reason, and an approve remark is optional. Rework and reject reasons are required by the API, so those are never NULL.';

-- One-time backfill so the thread is not blank for requests that already exist.
--
-- Every insert is guarded per request, not on the table being empty: the guard
-- has to hold whether this runs before the application does, after it, or twice.
-- A whole-table guard would look correct and then silently backfill NOTHING if a
-- single request had already been acted on by the new code — the ordering of a
-- deploy is not something a migration should depend on.
--
-- What the backfill can and cannot recover: the step tables hold the LATEST
-- action per step, so a stage reworked twice contributes one row here, and the
-- ordering within a stage is whatever acted_at says. Everything from this
-- migration forward is written per event and is complete. Requests old enough to
-- predate mat_*_approval_step (2026-06-16) contribute only their submit row —
-- their approvals were never recorded per stage anywhere this can read, and
-- "View Approval" is equally blank for them today.
INSERT INTO public.mat_request_comment (
    request_kind, request_id, event_type, stage, actor_user_id, comment, created_at
)
SELECT 'SINGLE', r.id, 'SUBMIT', NULL, r.created_by, r.change_extend_reason, r.created_at
FROM public.mat_single_request r
WHERE NOT EXISTS (
    SELECT 1
    FROM public.mat_request_comment c
    WHERE c.request_kind = 'SINGLE'
      AND c.request_id = r.id
      AND c.event_type = 'SUBMIT'
);

-- Matched on (request, event, stage) rather than on the timestamp: a step row
-- carries the acted_at of its LATEST action, so a stage the application has
-- already recorded would otherwise be inserted a second time under an older
-- reading of the same event.
WITH single_step_event AS (
    SELECT
        s.request_id,
        CASE s.status WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REWORK' THEN 'REWORK' ELSE 'REJECT' END AS event_type,
        CASE WHEN s.kind = 'MDM' THEN 'Master Data' ELSE 'Approval ' || s.level END AS stage,
        s.approver_user_id,
        s.remark,
        s.acted_at
    FROM public.mat_single_request_approval_step s
    WHERE s.status IN ('APPROVED', 'REWORK', 'REJECTED')
      AND s.acted_at IS NOT NULL
)
INSERT INTO public.mat_request_comment (
    request_kind, request_id, event_type, stage, actor_user_id, comment, created_at
)
SELECT
    'SINGLE', e.request_id, e.event_type, e.stage, e.approver_user_id, e.remark, e.acted_at
FROM single_step_event e
WHERE NOT EXISTS (
    SELECT 1
    FROM public.mat_request_comment c
    WHERE c.request_kind = 'SINGLE'
      AND c.request_id = e.request_id
      AND c.event_type = e.event_type
      AND c.stage = e.stage
);

INSERT INTO public.mat_request_comment (
    request_kind, request_id, event_type, stage, actor_user_id, comment, created_at
)
SELECT 'MASS', m.id, 'SUBMIT', NULL, m.created_by, m.mass_request_reason, m.created_at
FROM public.mat_mass_request m
WHERE NOT EXISTS (
    SELECT 1
    FROM public.mat_request_comment c
    WHERE c.request_kind = 'MASS'
      AND c.request_id = m.id
      AND c.event_type = 'SUBMIT'
);

-- Read off the batch's FIRST item only (item_no ASC): every item carries the
-- same step rows, written by the same action, so the other items would only
-- duplicate it. That is the same row every rework/approve path already locks
-- and gates the whole batch on.
WITH mass_step_event AS (
    SELECT
        i.mass_request_id,
        CASE s.status WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REWORK' THEN 'REWORK' ELSE 'REJECT' END AS event_type,
        CASE WHEN s.kind = 'MDM' THEN 'Master Data' ELSE 'Approval ' || s.level END AS stage,
        s.approver_user_id,
        s.remark,
        s.acted_at
    FROM public.mat_mass_request_item_approval_step s
    JOIN public.mat_mass_request_item i ON i.id = s.item_id
    WHERE s.status IN ('APPROVED', 'REWORK', 'REJECTED')
      AND s.acted_at IS NOT NULL
      AND i.item_no = (
          SELECT MIN(first_item.item_no)
          FROM public.mat_mass_request_item first_item
          WHERE first_item.mass_request_id = i.mass_request_id
      )
)
INSERT INTO public.mat_request_comment (
    request_kind, request_id, event_type, stage, actor_user_id, comment, created_at
)
SELECT
    'MASS', e.mass_request_id, e.event_type, e.stage, e.approver_user_id, e.remark, e.acted_at
FROM mass_step_event e
WHERE NOT EXISTS (
    SELECT 1
    FROM public.mat_request_comment c
    WHERE c.request_kind = 'MASS'
      AND c.request_id = e.mass_request_id
      AND c.event_type = e.event_type
      AND c.stage = e.stage
);

COMMIT;
