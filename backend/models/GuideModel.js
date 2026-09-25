const db = require("../config/connection");

// Material guides: folders and the uploaded files inside (or beside) them.
// Grouping is optional throughout, so every read returns folders and folderless
// files separately rather than pretending there is always a parent.

const FOLDER_COLUMNS = `
    id,
    name,
    description,
    created_by AS "createdBy",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
`;

const FILE_COLUMNS = `
    id,
    folder_id AS "folderId",
    name,
    description,
    original_name AS "originalName",
    stored_name AS "storedName",
    mime_type AS "mimeType",
    size_bytes AS "sizeBytes",
    created_by AS "createdBy",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
`;

const GuideModel = {
    listFolders: async () => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `SELECT ${FOLDER_COLUMNS} FROM public.mat_guide_folder ORDER BY name ASC, id ASC`
            );
            return rows;
        } finally {
            client.release();
        }
    },

    listFiles: async () => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `SELECT ${FILE_COLUMNS} FROM public.mat_guide_file
                 ORDER BY folder_id NULLS LAST, created_at ASC, id ASC`
            );
            return rows;
        } finally {
            client.release();
        }
    },

    getFolderById: async id => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `SELECT ${FOLDER_COLUMNS} FROM public.mat_guide_folder WHERE id = $1`,
                [id]
            );
            return rows[0] || null;
        } finally {
            client.release();
        }
    },

    getFileById: async id => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `SELECT ${FILE_COLUMNS} FROM public.mat_guide_file WHERE id = $1`,
                [id]
            );
            return rows[0] || null;
        } finally {
            client.release();
        }
    },

    createFolder: async ({ name, description, createdBy }) => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `INSERT INTO public.mat_guide_folder (name, description, created_by)
                 VALUES ($1, $2, $3)
                 RETURNING ${FOLDER_COLUMNS}`,
                [name, description, createdBy]
            );
            return rows[0];
        } finally {
            client.release();
        }
    },

    updateFolder: async (id, { name, description }) => {
        const client = await db.connect();
        try {
            // COALESCE keeps an omitted field untouched, so a rename does not
            // have to resend the description and vice versa.
            const { rows } = await client.query(
                `UPDATE public.mat_guide_folder
                 SET name = COALESCE($2, name),
                     description = COALESCE($3, description),
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING ${FOLDER_COLUMNS}`,
                [id, name ?? null, description ?? null]
            );
            return rows[0] || null;
        } finally {
            client.release();
        }
    },

    deleteFolder: async id => {
        const client = await db.connect();
        try {
            // The files inside are not deleted: mat_guide_file.folder_id is
            // ON DELETE SET NULL, so they fall back to standalone guides.
            const { rows } = await client.query(
                `DELETE FROM public.mat_guide_folder WHERE id = $1 RETURNING id`,
                [id]
            );
            return rows.length > 0;
        } finally {
            client.release();
        }
    },

    /**
     * Insert a batch of uploads as one statement, so a bulk upload either lands
     * whole or not at all.
     */
    insertFiles: async files => {
        if (!Array.isArray(files) || files.length === 0) {
            return [];
        }

        const client = await db.connect();
        try {
            const values = [];
            const placeholders = files.map((file, index) => {
                const base = index * 8;
                values.push(
                    file.folderId ?? null,
                    file.name ?? null,
                    file.description ?? null,
                    file.originalName,
                    file.storedName,
                    file.mimeType ?? null,
                    file.sizeBytes,
                    file.createdBy ?? null
                );
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
            });

            const { rows } = await client.query(
                `INSERT INTO public.mat_guide_file
                    (folder_id, name, description, original_name, stored_name, mime_type, size_bytes, created_by)
                 VALUES ${placeholders.join(", ")}
                 RETURNING ${FILE_COLUMNS}`,
                values
            );
            return rows;
        } finally {
            client.release();
        }
    },

    updateFile: async (id, { name, description, folderId, clearFolder }) => {
        const client = await db.connect();
        try {
            // folder_id is the one field a caller may legitimately want to set
            // back to NULL (moving a guide out of its folder), so it cannot use
            // the same COALESCE trick as the text fields.
            const { rows } = await client.query(
                `UPDATE public.mat_guide_file
                 SET name = COALESCE($2, name),
                     description = COALESCE($3, description),
                     folder_id = CASE WHEN $5 THEN NULL ELSE COALESCE($4, folder_id) END,
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING ${FILE_COLUMNS}`,
                [id, name ?? null, description ?? null, folderId ?? null, clearFolder === true]
            );
            return rows[0] || null;
        } finally {
            client.release();
        }
    },

    deleteFile: async id => {
        const client = await db.connect();
        try {
            const { rows } = await client.query(
                `DELETE FROM public.mat_guide_file WHERE id = $1
                 RETURNING stored_name AS "storedName"`,
                [id]
            );
            return rows[0] || null;
        } finally {
            client.release();
        }
    },
};

module.exports = GuideModel;
