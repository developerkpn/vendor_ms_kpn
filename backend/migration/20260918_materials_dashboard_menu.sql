-- Materials > Dashboard: the sidebar entry that shows the uploaded guides.
-- Created: 2026-09-18
-- Companion to 20260918_mat_guide.sql, which creates the tables behind the page.
--
-- Conventions this follows, learned from 20260518_grant_procurement_material_sidebar.sql:
-- - mst_page_access.page_id holds mst_page.menu_id, never mst_page.id.
-- - A CHILD row has is_parent NULL, not false: PageModel's child query filters
--   `is_parent is null`, so a child inserted as false never renders.
-- - mst_page.page is also the permission key the sidebar looks up
--   (NavSection checks permission[item.text].read), so the string here must match
--   the label exactly or the item silently disappears.
-- - The sidebar shows a child only when its PARENT is readable too, which is why
--   the grant below copies whoever can already read Materials (menu_id 7).
--
-- menu_id is derived rather than hardcoded so this applies to dev and prod even
-- though their sequences differ, and both statements are guarded so re-running
-- changes nothing.
--
-- Caveat for whoever maintains access: saving a group in the Access Menu screen
-- deletes and re-inserts every row for that group, so a page granted only by this
-- SQL is dropped unless it is also ticked there.

BEGIN;

-- 1. The menu entry. Inserted at the end here and moved to the front by step 2;
--    the position written now only has to be free, not final.
--    The Materials parent row is its own parent (menu_id = parent_id = 7), so it
--    is excluded from the position calculation or the new item would jump to 8.
INSERT INTO public.mst_page (
    menu_id, page, url_link, icon, position, parent_id, is_parent, type, is_active
)
SELECT
    (SELECT COALESCE(MAX(menu_id), 0) + 1 FROM public.mst_page),
    'Dashboard',
    '/dashboard/materials/dashboard',
    NULL,
    (SELECT COALESCE(MAX(position), 0) + 1
       FROM public.mst_page
      WHERE parent_id = 7 AND menu_id <> 7),
    7,
    NULL,
    'menu',
    true
WHERE NOT EXISTS (
    SELECT 1 FROM public.mst_page WHERE parent_id = 7 AND page = 'Dashboard'
);

-- 2. Dashboard leads the Materials submenu; everything else keeps its relative
--    order behind it. PageModel orders children by `position` alone, so leading
--    is a matter of renumbering rather than any flag.
--
--    Renumbering the whole branch rather than nudging one row keeps the sequence
--    gapless and makes this safe to re-run: the second run computes the numbers
--    the rows already hold and the guard updates nothing.
WITH ordered AS (
    SELECT
        menu_id,
        ROW_NUMBER() OVER (
            ORDER BY
                CASE WHEN page = 'Dashboard' THEN 0 ELSE 1 END,
                position,
                menu_id
        ) AS new_position
    FROM public.mst_page
    WHERE parent_id = 7 AND menu_id <> 7
)
UPDATE public.mst_page AS target
SET position = ordered.new_position
FROM ordered
WHERE target.menu_id = ordered.menu_id
  AND target.position IS DISTINCT FROM ordered.new_position;

-- 3. Read access for every group that can already see the Materials menu.
--    Guides are reference material for all material users, so the audience is
--    exactly the audience of the parent; deriving it keeps the two in step.
INSERT INTO public.mst_page_access (
    fcreate, fread, fupdate, fdelete,
    user_group_name, page_id, created_at, created_by, user_group_id
)
SELECT
    false, true, false, false,
    source.user_group_name,
    target.menu_id,
    CURRENT_DATE,
    'system',
    source.user_group_id
FROM (
    SELECT DISTINCT user_group_id, user_group_name
    FROM public.mst_page_access
    WHERE page_id = 7 AND fread = true AND user_group_id IS NOT NULL
) source
CROSS JOIN (
    SELECT menu_id FROM public.mst_page WHERE parent_id = 7 AND page = 'Dashboard'
) target
WHERE NOT EXISTS (
    SELECT 1
    FROM public.mst_page_access existing
    WHERE existing.user_group_id = source.user_group_id
      AND existing.page_id = target.menu_id
);

COMMIT;
