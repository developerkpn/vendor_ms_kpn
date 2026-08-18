-- Attachment uploader attribution.
-- Created: 2026-08-16
-- Purpose:
-- Until now every attachment on a request came from one person: the requester.
-- Approvers and Master Data could view attachments but not change them, so
-- "who attached this" had exactly one answer and needed no column.
--
-- Approvers and Master Data can now add and remove attachments while reviewing.
-- A request can therefore carry files from several people, and a later reviewer
-- has no way to tell a reviewer's file from the requester's original.
--
-- uploaded_by stores the username of whoever attached the file, matching how
-- mat_request_comment.actor_user_id records who said something. NULL means the
-- row predates this change: those attachments are all requester uploads, but
-- backfilling a name we never captured would invent a fact, so they stay NULL
-- and the UI omits the line rather than guessing.
--
-- Nullable on purpose. The column RECORDS, it does not ROUTE: nothing reads it
-- to decide what happens next, so a missing value can never block an approval.

BEGIN;

ALTER TABLE public.mat_single_request_attachment
    ADD COLUMN IF NOT EXISTS uploaded_by varchar(100) NULL;

ALTER TABLE public.mat_mass_request_attachment
    ADD COLUMN IF NOT EXISTS uploaded_by varchar(100) NULL;

COMMENT ON COLUMN public.mat_single_request_attachment.uploaded_by IS
    'Username of whoever attached this file. NULL for rows predating reviewer attachments (all requester uploads).';

COMMENT ON COLUMN public.mat_mass_request_attachment.uploaded_by IS
    'Username of whoever attached this file. NULL for rows predating reviewer attachments (all requester uploads).';

COMMIT;
