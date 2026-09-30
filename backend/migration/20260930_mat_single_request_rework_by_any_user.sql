-- mat_single_request.rework_by_user_id: allow managers (mst_mgr) as well.
-- Created: 2026-09-30
--
-- Managers (mst_mgr, whose mgr_id is their user id) can now request materials
-- and approve them, and an approver who sends a request back is recorded in
-- rework_by_user_id. The foreign key to mst_user(user_id) rejected a manager's
-- id (23503), so the rework failed. A key cannot point at two tables, and no
-- other Materials table keys on the user tables, so it is dropped; the id is
-- still only ever written from the logged-in session.
--
-- Production never had this constraint; there it is a no-op.
-- Safe to re-run.

BEGIN;

ALTER TABLE public.mat_single_request
    DROP CONSTRAINT IF EXISTS mat_single_request_rework_by_user_id_fkey;

COMMIT;
