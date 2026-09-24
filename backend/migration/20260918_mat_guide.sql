-- Material guides: documents and videos an administrator uploads for material
-- users to read, shown on the Materials > Dashboard page.
-- Created: 2026-09-18
--
-- Two tables, and the relationship between them is deliberately loose:
-- grouping is optional. A guide may sit in a folder or stand on its own, so
-- mat_guide_file.folder_id is nullable rather than a required parent. Deleting a
-- folder therefore SETs NULL rather than cascading — losing a folder must never
-- silently delete the 100MB videos inside it; they fall back to standalone and
-- stay visible on the dashboard.
--
-- A guide must be named: a dashboard of files called "VID_20260918_112233.mp4"
-- helps nobody. The uploader prefills the name from the filename, so "required"
-- costs a glance rather than typing. Descriptions stay optional, and so do
-- folder descriptions. original_name is kept regardless, as the download name
-- and as a record of what was actually uploaded.
--
-- No FK on created_by, same precedent as mst_user_preference.user_id
-- (20260814_mst_user_preference.sql): a guide must survive the departure of
-- whoever uploaded it, and skipping the FK keeps this migration applicable to an
-- empty database.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mat_guide_folder (
    id bigserial PRIMARY KEY,
    name varchar(200) NOT NULL,
    description text,
    created_by varchar(100),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.mat_guide_folder IS
    'Optional grouping for material guides, e.g. one folder per topic so its videos are listed together. A guide does not need a folder.';
COMMENT ON COLUMN public.mat_guide_folder.name IS
    'Folder label shown on the dashboard. Required: a folder with no name could not be told apart from another.';
COMMENT ON COLUMN public.mat_guide_folder.description IS
    'Optional blurb shown under the folder name.';
COMMENT ON COLUMN public.mat_guide_folder.created_by IS
    'mst_user.user_id of the administrator who created it (no FK: the folder outlives the account).';

CREATE TABLE IF NOT EXISTS public.mat_guide_file (
    id bigserial PRIMARY KEY,
    folder_id bigint REFERENCES public.mat_guide_folder(id) ON DELETE SET NULL,
    name varchar(300) NOT NULL,
    description text,
    original_name varchar(300) NOT NULL,
    stored_name varchar(300) NOT NULL,
    mime_type varchar(150),
    size_bytes bigint NOT NULL,
    created_by varchar(100),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_guide_file_stored_name UNIQUE (stored_name),
    CONSTRAINT ck_mat_guide_file_size_positive CHECK (size_bytes >= 0)
);

COMMENT ON TABLE public.mat_guide_file IS
    'One uploaded guide: a document or a video. Bytes live on disk under the guide upload directory; this row is the index into it.';
COMMENT ON COLUMN public.mat_guide_file.folder_id IS
    'Owning folder, or NULL for a standalone guide. ON DELETE SET NULL so removing a folder never destroys the uploads inside it.';
COMMENT ON COLUMN public.mat_guide_file.name IS
    'Display label, required. Prefilled from the filename at upload, so it is always something a reader can scan.';
COMMENT ON COLUMN public.mat_guide_file.original_name IS
    'Filename as uploaded, kept so a guide always has something to display and to name the download.';
COMMENT ON COLUMN public.mat_guide_file.stored_name IS
    'Generated filename on disk. Unique, and never derived from user input alone, so one upload cannot overwrite another.';
COMMENT ON COLUMN public.mat_guide_file.mime_type IS
    'Content type as reported at upload, used to decide between the video player and a download link.';
COMMENT ON COLUMN public.mat_guide_file.size_bytes IS
    'Size on disk. Shown on the dashboard and used to confirm the 100MB per-file ceiling was honoured.';

CREATE INDEX IF NOT EXISTS ix_mat_guide_file_folder_id
    ON public.mat_guide_file (folder_id);

COMMIT;
