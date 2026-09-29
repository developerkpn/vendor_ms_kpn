const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const formidable = require("formidable");

const GuideModel = require("../models/GuideModel");

// Uploaded bytes live beside the request attachments, under backend/public.
// __dirname rather than path.resolve() so the directory does not move when the
// process is started from somewhere other than the repo root.
const GUIDE_DIR_NAME = "guides";
const GUIDE_DIR = path.join(__dirname, "..", "public", GUIDE_DIR_NAME);

// Where the multipart parser writes bytes as they arrive.
//
// NOT os.tmpdir(), which formidable would use by default. On a host where /tmp
// is a tmpfs mount — the dev machine is one — that puts a 100MB video in RAM,
// and then the move to GUIDE_DIR crosses a device boundary and degrades into a
// full copy: the file is read and written a second time. Staging on the same
// filesystem as its destination makes the move an atomic rename instead, and
// the bytes never touch memory beyond the stream buffer.
//
// Outside backend/public on purpose: that tree is served by express.static, and
// half-written uploads have no business being reachable over HTTP.
const GUIDE_TMP_DIR = path.join(__dirname, "..", "tmp", GUIDE_DIR_NAME);

// Abandoned part-files, left by a connection that dropped mid-upload. Swept on
// the next upload rather than on a timer, which keeps this to one directory read
// on a path that is already doing disk work.
const STALE_UPLOAD_AGE_MS = 6 * 60 * 60 * 1000;

// Guides are read back through an endpoint that honours Range requests, not the
// plain /static mount: a 100MB training video has to be seekable, and a browser
// can only seek if the server answers 206 with the byte range it asked for.
const guideContentPath = id => `/material/guides/files/${id}/content`;

// 100MB per file, as specified. maxTotalFileSize has to be raised separately:
// formidable defaults it to maxFileSize, which would cap a bulk upload at one
// file's worth no matter how many were selected.
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 20;

// One batch, not one file. Twenty files at the full 100MB would be 2GB in a
// single request, which takes longer than Node's 5-minute request timeout on any
// ordinary office uplink and would be killed halfway. A gigabyte keeps a full
// batch inside that window; twenty smaller files are still fine.
const MAX_TOTAL_UPLOAD_BYTES = 1024 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
    // documents
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt",
    // video
    "mp4", "webm", "mov", "m4v", "avi", "mkv",
    // images
    "png", "jpg", "jpeg", "gif", "webp",
]);

const badRequest = (message, code) =>
    Object.assign(new Error(message), { statusCode: 400, code });

const extensionOf = filename => {
    const parts = String(filename || "").split(".");
    return parts.length > 1 ? parts.pop().toLowerCase() : "";
};

/**
 * A filename nothing the uploader typed can influence.
 *
 * The original name is kept in the database instead, so a crafted name cannot
 * escape the guide directory, collide with another upload, or overwrite it.
 */
const buildStoredName = originalName => {
    const extension = extensionOf(originalName);
    const unique = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    return extension ? `${unique}.${extension}` : unique;
};

const ensureGuideDirs = async () => {
    await fs.mkdir(GUIDE_DIR, { recursive: true });
    await fs.mkdir(GUIDE_TMP_DIR, { recursive: true });
};

/**
 * Delete part-files older than STALE_UPLOAD_AGE_MS.
 *
 * Best effort: a sweep that fails must never fail the upload that triggered it.
 */
const sweepStaleUploads = async () => {
    try {
        const entries = await fs.readdir(GUIDE_TMP_DIR);
        const cutoff = Date.now() - STALE_UPLOAD_AGE_MS;

        await Promise.all(
            entries.map(async entry => {
                const candidate = path.join(GUIDE_TMP_DIR, entry);
                try {
                    const stat = await fs.stat(candidate);
                    if (stat.isFile() && stat.mtimeMs < cutoff) {
                        await fs.unlink(candidate);
                    }
                } catch (error) {
                    if (error.code !== "ENOENT") {
                        console.error("Guide temp sweep failed:", error.message);
                    }
                }
            })
        );
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Guide temp sweep failed:", error.message);
        }
    }
};

/**
 * Absolute path of a stored guide, refusing anything that would resolve outside
 * the guide directory. stored_name comes from our own generator, so this is a
 * belt-and-braces check against a tampered or hand-edited database row.
 */
const resolveStoredPath = storedName => {
    const resolved = path.resolve(GUIDE_DIR, String(storedName || ""));
    const root = path.resolve(GUIDE_DIR);

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw badRequest("Invalid guide file path", "GUIDE_INVALID_PATH");
    }

    return resolved;
};

const firstValue = value => (Array.isArray(value) ? value[0] : value);

const toOptionalText = value => {
    const text = firstValue(value);
    if (text === undefined || text === null) {
        return null;
    }
    const trimmed = String(text).trim();
    return trimmed === "" ? null : trimmed;
};

const toOptionalId = value => {
    const raw = firstValue(value);
    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return null;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw badRequest("Invalid folder id", "GUIDE_INVALID_FOLDER");
    }
    return parsed;
};

/**
 * Per-file names and descriptions, sent alongside the files as a JSON array in
 * the `meta` field and matched to the files by position. Both are optional, and
 * so is the field itself.
 */
const parseMeta = rawMeta => {
    const text = toOptionalText(rawMeta);
    if (!text) {
        return [];
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw badRequest("Invalid guide metadata", "GUIDE_INVALID_META");
    }

    if (!Array.isArray(parsed)) {
        throw badRequest("Invalid guide metadata", "GUIDE_INVALID_META");
    }

    return parsed;
};

const GuideService = {
    GUIDE_DIR,
    GUIDE_TMP_DIR,
    MAX_TOTAL_UPLOAD_BYTES,
    guideContentPath,
    MAX_FILE_SIZE_BYTES,
    MAX_FILES_PER_UPLOAD,
    ALLOWED_EXTENSIONS,
    buildStoredName,
    resolveStoredPath,
    parseMeta,

    /**
     * Everything the dashboard needs in one read: folders with their contents,
     * plus the guides that belong to no folder at all.
     */
    getGuideTree: async () => {
        const [folders, files] = await Promise.all([
            GuideModel.listFolders(),
            GuideModel.listFiles(),
        ]);

        const decorate = file => ({
            ...file,
            sizeBytes: Number(file.sizeBytes),
            contentPath: guideContentPath(file.id),
            displayName: file.name || file.originalName,
        });

        const byFolder = new Map(folders.map(folder => [String(folder.id), []]));
        const standalone = [];

        for (const file of files) {
            const decorated = decorate(file);
            const key = file.folderId === null ? null : String(file.folderId);
            if (key !== null && byFolder.has(key)) {
                byFolder.get(key).push(decorated);
            } else {
                standalone.push(decorated);
            }
        }

        return {
            folders: folders.map(folder => ({
                ...folder,
                files: byFolder.get(String(folder.id)) || [],
            })),
            files: standalone,
        };
    },

    createFolder: async ({ name, description, createdBy }) => {
        const trimmed = typeof name === "string" ? name.trim() : "";
        if (trimmed === "") {
            throw badRequest("Folder name is required", "GUIDE_FOLDER_NAME_REQUIRED");
        }

        return GuideModel.createFolder({
            name: trimmed,
            description: typeof description === "string" && description.trim() !== ""
                ? description.trim()
                : null,
            createdBy: createdBy || null,
        });
    },

    updateFolder: async (id, { name, description }) => {
        if (name !== undefined && String(name).trim() === "") {
            throw badRequest("Folder name is required", "GUIDE_FOLDER_NAME_REQUIRED");
        }

        return GuideModel.updateFolder(id, {
            name: name === undefined ? null : String(name).trim(),
            description: description === undefined ? null : String(description).trim(),
        });
    },

    deleteFolder: async id => GuideModel.deleteFolder(id),

    updateFile: async (id, { name, description, folderId }) => {
        // Editing may rename a guide but not leave it nameless; the column is
        // NOT NULL and the dashboard has nothing else to label it with.
        if (name !== undefined && String(name).trim() === "") {
            throw badRequest("Guide name is required", "GUIDE_NAME_REQUIRED");
        }

        // An explicit null folderId means "move it out of its folder", which is
        // different from omitting the field and leaving it where it is.
        const clearFolder = folderId === null;

        if (folderId !== undefined && folderId !== null) {
            const folder = await GuideModel.getFolderById(folderId);
            if (!folder) {
                throw badRequest("Folder not found", "GUIDE_FOLDER_NOT_FOUND");
            }
        }

        return GuideModel.updateFile(id, {
            name: name === undefined ? null : String(name).trim(),
            description: description === undefined ? null : String(description).trim(),
            folderId: clearFolder ? null : folderId,
            clearFolder,
        });
    },

    deleteFile: async id => {
        const removed = await GuideModel.deleteFile(id);
        if (!removed) {
            return false;
        }

        // The row is already gone; a file that cannot be unlinked leaves bytes
        // behind but must not fail the request, or the guide would reappear as
        // an error while being absent from every listing.
        try {
            await fs.unlink(resolveStoredPath(removed.storedName));
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("Guide file cleanup failed:", error.message);
            }
        }

        return true;
    },

    /**
     * Parse a bulk upload, move every accepted file into the guide directory,
     * and index them. Any failure removes whatever was already moved, so a
     * rejected upload leaves nothing behind on disk or in the database.
     */
    uploadGuides: async (req, { createdBy }) => {
        await ensureGuideDirs();
        await sweepStaleUploads();

        // `new formidable.IncomingForm(...)`, matching MaterialController: the v3
        // package exports an object, so calling the module itself throws.
        const form = new formidable.IncomingForm({
            multiples: true,
            maxFileSize: MAX_FILE_SIZE_BYTES,
            maxTotalFileSize: MAX_TOTAL_UPLOAD_BYTES,
            maxFiles: MAX_FILES_PER_UPLOAD,
            keepExtensions: true,
            uploadDir: GUIDE_TMP_DIR,
        });

        // formidable lists files in the order their writes FINISH, so a small
        // file sent after a large one can come first. meta is matched to files
        // by position, so keep the order the parts were sent: fileBegin fires in
        // stream order, with the same file objects parse() hands back.
        const sentOrder = [];
        form.on("fileBegin", (_name, file) => {
            sentOrder.push(file);
        });

        let fields;
        let incoming;
        try {
            [fields, incoming] = await form.parse(req);
        } catch (error) {
            // formidable's numeric codes, from its FormidableError table:
            // 1016 one file over maxFileSize, 1009 the batch over
            // maxTotalFileSize, 1015 too many files in one upload. Each gets the
            // message that tells the uploader what to change.
            const code = String(error.code);

            if (code === "1016") {
                throw badRequest(
                    "Each file must be 100MB or smaller",
                    "GUIDE_FILE_TOO_LARGE"
                );
            }
            if (code === "1009") {
                throw badRequest(
                    `One upload may total ${MAX_FILES_PER_UPLOAD * 100}MB at most. Upload in smaller batches.`,
                    "GUIDE_UPLOAD_TOO_LARGE"
                );
            }
            if (code === "1015") {
                throw badRequest(
                    `Up to ${MAX_FILES_PER_UPLOAD} files can be uploaded at once`,
                    "GUIDE_TOO_MANY_FILES"
                );
            }

            throw badRequest(error.message || "Upload failed", "GUIDE_UPLOAD_FAILED");
        }

        const uploaded = [].concat(incoming.files || incoming.file || []).sort(
            (left, right) => sentOrder.indexOf(left) - sentOrder.indexOf(right)
        );
        if (uploaded.length === 0) {
            throw badRequest("No files uploaded", "GUIDE_NO_FILES");
        }

        // From here on every exit unlinks whatever is still staged. The parser
        // has already written each file in full, so a rejection after this point
        // — wrong type, oversize, a failed insert — would otherwise strand a
        // 100MB part-file until the six-hour sweep.
        const discardStagedFiles = () =>
            Promise.all(
                uploaded.map(file =>
                    file?.filepath ? fs.unlink(file.filepath).catch(() => {}) : null
                )
            );

        const moved = [];
        try {
            const folderId = toOptionalId(fields.folderId);
            if (folderId !== null) {
                const folder = await GuideModel.getFolderById(folderId);
                if (!folder) {
                    throw badRequest("Folder not found", "GUIDE_FOLDER_NOT_FOUND");
                }
            }

            const meta = parseMeta(fields.meta);

            for (const file of uploaded) {
                const extension = extensionOf(file.originalFilename);
                if (!ALLOWED_EXTENSIONS.has(extension)) {
                    throw badRequest(
                        `File type .${extension || "unknown"} is not allowed`,
                        "GUIDE_FILE_TYPE"
                    );
                }
                if (file.size > MAX_FILE_SIZE_BYTES) {
                    throw badRequest(
                        "Each file must be 100MB or smaller",
                        "GUIDE_FILE_TOO_LARGE"
                    );
                }
            }

            const rows = [];

            for (const [index, file] of uploaded.entries()) {
                const storedName = buildStoredName(file.originalFilename);
                const destination = resolveStoredPath(storedName);

                // Staging and destination share a filesystem, so this is an
                // atomic rename. The copy is kept only for the case where an
                // operator has mounted one of the two elsewhere.
                try {
                    await fs.rename(file.filepath, destination);
                } catch (error) {
                    if (error.code !== "EXDEV") {
                        throw error;
                    }
                    await fs.copyFile(file.filepath, destination);
                    await fs.unlink(file.filepath).catch(() => {});
                }
                moved.push(destination);

                const entry = meta[index] || {};
                // Required, but never blocking: the uploader prefills it from
                // the filename, and a client that sends nothing falls back to
                // the same value rather than failing a completed upload.
                const providedName =
                    typeof entry.name === "string" ? entry.name.trim() : "";
                rows.push({
                    folderId,
                    name: providedName !== ""
                        ? providedName
                        : file.originalFilename || storedName,
                    description:
                        typeof entry.description === "string" && entry.description.trim() !== ""
                            ? entry.description.trim()
                            : null,
                    originalName: file.originalFilename || storedName,
                    storedName,
                    mimeType: file.mimetype || null,
                    sizeBytes: file.size,
                    createdBy: createdBy || null,
                });
            }

            return await GuideModel.insertFiles(rows);
        } catch (error) {
            await Promise.all(
                moved.map(destination => fs.unlink(destination).catch(() => {}))
            );
            throw error;
        } finally {
            // Renamed files are already gone from the staging directory, so this
            // only ever removes the ones that never made it.
            await discardStagedFiles();
        }
    },
};

module.exports = GuideService;
