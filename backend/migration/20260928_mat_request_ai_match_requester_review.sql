-- AI material match — the requester's own answer, recorded before the save.
-- Created: 2026-09-28
-- Companion to 20260922_mat_request_ai_match.sql.
--
-- Before a new Create request (single) or a mass batch is written, the requester
-- is shown the existing materials that look like what they typed and must pick
-- one or confirm "none of these, it is a brand new material". Picking one means
-- nothing is saved at all, so the only answer that ever reaches this table is
-- the confirmation. These columns keep it next to the approver-side ranking so
-- the approval dialog can say "the requester reviewed N similar materials and
-- confirmed this is new".
--
-- Still ADVISORY, same rule as the parent table: nothing in the approval chain
-- reads these columns.
--
-- requester_review holds the matches the requester was actually shown. It is
-- separate from recommendations on purpose: the post-save run overwrites
-- recommendations (and a re-run can change them), while this is a record of
-- what the requester saw at the moment they answered.
--
-- Applied manually, like its parent. Safe to re-run.

ALTER TABLE mat_request_ai_match
    ADD COLUMN IF NOT EXISTS requester_confirmed_new BOOLEAN NULL,
    ADD COLUMN IF NOT EXISTS requester_reviewed_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS requester_reviewed_by VARCHAR(100) NULL,
    ADD COLUMN IF NOT EXISTS requester_review JSONB NULL;

COMMENT ON COLUMN mat_request_ai_match.requester_confirmed_new IS
    'True when the requester saw the AI matches before saving and confirmed this line is a new material. NULL when no pre-save check ran (feature off, AI unavailable, or a rework).';
COMMENT ON COLUMN mat_request_ai_match.requester_reviewed_at IS
    'When the requester confirmed.';
COMMENT ON COLUMN mat_request_ai_match.requester_reviewed_by IS
    'mst_user.user_id of the requester who confirmed (no FK, same as created_by elsewhere).';
COMMENT ON COLUMN mat_request_ai_match.requester_review IS
    'The ranked matches the requester was shown when confirming: [{rank, code, name, similarity, matchType}].';
