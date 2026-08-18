-- Per-user preference store: one row per (user, key). A status filter that must
-- survive logout, refresh, and follow the account to another machine cannot live
-- in browser storage (cleared on logout, per-browser), so it lives here instead.
-- Created: 2026-08-14
--
-- Generic over the key on purpose: a second preference (a different page, a
-- different setting) is a new row under a new pref_key, never a schema change.
-- Sibling of mst_user, hence the mst_ prefix rather than mat_.
--
-- No FK on user_id, same precedent as mat_request_comment.actor_user_id
-- (20260812_mat_request_comment.sql): a preference row must survive a user
-- being removed, and skipping the FK means this migration references no other
-- table, so it can be applied to an empty database to verify it executes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mst_user_preference (
    id bigserial PRIMARY KEY,
    user_id varchar(100) NOT NULL,
    pref_key varchar(100) NOT NULL,
    pref_value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mst_user_preference_user_key UNIQUE (user_id, pref_key)
);

COMMENT ON TABLE public.mst_user_preference IS
    'Per-user preferences, one row per (user_id, pref_key). Read once when the owning page loads and written on every change.';
COMMENT ON COLUMN public.mst_user_preference.user_id IS
    'mst_user.user_id of the preference owner (no FK: the row must survive a user being removed).';
COMMENT ON COLUMN public.mst_user_preference.pref_key IS
    'Namespaced to the page it belongs to, e.g. my_approval.status_filter, so a future page''s preference cannot collide with this one.';
COMMENT ON COLUMN public.mst_user_preference.pref_value IS
    'The stored value, always text. Interpretation (e.g. a status filter option) is the caller''s concern, not this table''s.';
COMMENT ON COLUMN public.mst_user_preference.updated_at IS
    'Set to NOW() on every write, insert or update.';

COMMIT;
