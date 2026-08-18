-- Add CORRESPONDENCE to the request comment event types.
-- Created: 2026-08-16
-- Purpose:
-- Rework to a different approver has two channels (REWORK_NOTIFY_CHANNELS).
-- "Via aplikasi" moves the request to the new approver. "Via email" does not:
-- it is correspondence only, the picked person is the RECIPIENT of a mail
-- rather than a new approver, no step row or header column is written, and the
-- request stays exactly where it was.
--
-- Reviewers can now add and remove attachments while reviewing, including on
-- the email channel. A removal has to leave an audit line, because the
-- attachment row is deleted outright rather than soft-deleted — without a
-- comment there is no evidence the file ever existed.
--
-- None of the five existing event types can carry that line honestly. REWORK is
-- the closest and is wrong: it would tell every later reader that the request
-- was reworked, when nothing moved. An event type that lies is worse than a
-- missing one, so this adds the sixth.
--
-- CORRESPONDENCE is the codebase's own word for this channel — see the
-- "'Via email' is CORRESPONDENCE ONLY (product decision 2026-08-07)" comment in
-- materialService.js, added alongside the channel itself.
--
-- Named for what happened, not how it was delivered: EMAIL would describe the
-- transport and go stale the day a second channel is added.

BEGIN;

ALTER TABLE public.mat_request_comment
    DROP CONSTRAINT IF EXISTS chk_mat_request_comment_event_type;

ALTER TABLE public.mat_request_comment
    ADD CONSTRAINT chk_mat_request_comment_event_type
        CHECK (event_type IN ('SUBMIT', 'RESUBMIT', 'APPROVE', 'REWORK', 'REJECT', 'CORRESPONDENCE'));

COMMENT ON COLUMN public.mat_request_comment.event_type IS
    'SUBMIT | RESUBMIT | APPROVE | REWORK | REJECT | CORRESPONDENCE. CORRESPONDENCE is the email-only rework channel: a message was sent, the request did not move.';

COMMIT;
