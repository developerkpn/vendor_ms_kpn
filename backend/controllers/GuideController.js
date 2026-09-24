const fs = require("fs");
const fsPromises = require("fs/promises");

const GuideModel = require("../models/GuideModel");
const GuideService = require("../services/guideService");

// Content types the stored mime_type may not cover. The upload records whatever
// the browser claimed; this fills the gaps so a video still plays when it
// claimed nothing useful.
const EXTENSION_CONTENT_TYPES = {
    pdf: "application/pdf",
    txt: "text/plain",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
};

const contentTypeFor = file => {
    if (file.mimeType && file.mimeType !== "application/octet-stream") {
        return file.mimeType;
    }
    const extension = String(file.storedName || "").split(".").pop().toLowerCase();
    return EXTENSION_CONTENT_TYPES[extension] || "application/octet-stream";
};

/**
 * Parse a single `bytes=` range against a known size.
 *
 * Returns null when the header is absent or not a form we serve, in which case
 * the caller sends the whole file; returns "unsatisfiable" when the range falls
 * outside the file, which has to answer 416 rather than a wrong slice.
 */
const parseRange = (header, size) => {
    if (!header || typeof header !== "string") {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return null;
    }

    const [, rawStart, rawEnd] = match;

    if (rawStart === "" && rawEnd === "") {
        return null;
    }

    let start;
    let end;

    if (rawStart === "") {
        // A suffix range: the last N bytes.
        const suffixLength = Number(rawEnd);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return "unsatisfiable";
        }
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
    } else {
        start = Number(rawStart);
        end = rawEnd === "" ? size - 1 : Number(rawEnd);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return "unsatisfiable";
    }

    return { start, end: Math.min(end, size - 1) };
};

// Material guides. Reads are open to anyone with a session (the dashboard shows
// them to every material user); writes are administrator actions and the route
// table gates them with AuthToken.authSession.

const respondWithError = (res, error, fallbackMessage) => {
    const status = error?.statusCode || 500;

    if (status === 500) {
        console.error(`${fallbackMessage}:`, error);
    }

    return res.status(status).json({
        success: false,
        message: status === 500 ? fallbackMessage : error.message,
        code: error?.code,
    });
};

const parseId = value => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const GuideController = {
    getGuides: async (req, res) => {
        try {
            const data = await GuideService.getGuideTree();
            return res.json({ success: true, data });
        } catch (error) {
            return respondWithError(res, error, "Failed to load guides");
        }
    },

    createFolder: async (req, res) => {
        try {
            const folder = await GuideService.createFolder({
                name: req.body?.name,
                description: req.body?.description,
                createdBy: req.cookies?.user_id,
            });
            return res.status(201).json({ success: true, data: folder });
        } catch (error) {
            return respondWithError(res, error, "Failed to create folder");
        }
    },

    updateFolder: async (req, res) => {
        try {
            const id = parseId(req.params.folderId);
            if (!id) {
                return res.status(400).json({ success: false, message: "Invalid folder id" });
            }

            const folder = await GuideService.updateFolder(id, {
                name: req.body?.name,
                description: req.body?.description,
            });

            if (!folder) {
                return res.status(404).json({ success: false, message: "Folder not found" });
            }

            return res.json({ success: true, data: folder });
        } catch (error) {
            return respondWithError(res, error, "Failed to update folder");
        }
    },

    deleteFolder: async (req, res) => {
        try {
            const id = parseId(req.params.folderId);
            if (!id) {
                return res.status(400).json({ success: false, message: "Invalid folder id" });
            }

            const deleted = await GuideService.deleteFolder(id);
            if (!deleted) {
                return res.status(404).json({ success: false, message: "Folder not found" });
            }

            // The guides inside are kept and become standalone, so say so rather
            // than letting the caller assume they went with it.
            return res.json({
                success: true,
                message: "Folder deleted. Its guides are now standalone.",
            });
        } catch (error) {
            return respondWithError(res, error, "Failed to delete folder");
        }
    },

    uploadGuides: async (req, res) => {
        try {
            const files = await GuideService.uploadGuides(req, {
                createdBy: req.cookies?.user_id,
            });
            return res.status(201).json({ success: true, data: files });
        } catch (error) {
            return respondWithError(res, error, "Failed to upload guides");
        }
    },

    updateFile: async (req, res) => {
        try {
            const id = parseId(req.params.fileId);
            if (!id) {
                return res.status(400).json({ success: false, message: "Invalid guide id" });
            }

            const file = await GuideService.updateFile(id, {
                name: req.body?.name,
                description: req.body?.description,
                // Present-and-null moves the guide out of its folder; absent
                // leaves it where it is.
                folderId: Object.prototype.hasOwnProperty.call(req.body || {}, "folderId")
                    ? req.body.folderId === null || req.body.folderId === ""
                        ? null
                        : parseId(req.body.folderId)
                    : undefined,
            });

            if (!file) {
                return res.status(404).json({ success: false, message: "Guide not found" });
            }

            return res.json({ success: true, data: file });
        } catch (error) {
            return respondWithError(res, error, "Failed to update guide");
        }
    },

    /**
     * Stream a guide back, honouring Range so a video can be seeked.
     *
     * Deliberately not behind authSession: a <video src> or an <iframe> cannot
     * attach the Authorization header this API authenticates with, and the same
     * is already true of the material attachment endpoint next door. Stored
     * names are random, and the listing that reveals them does require a session.
     */
    streamFile: async (req, res) => {
        try {
            const id = parseId(req.params.fileId);
            if (!id) {
                return res.status(400).json({ success: false, message: "Invalid guide id" });
            }

            const file = await GuideModel.getFileById(id);
            if (!file) {
                return res.status(404).json({ success: false, message: "Guide not found" });
            }

            const absolutePath = GuideService.resolveStoredPath(file.storedName);

            let stat;
            try {
                stat = await fsPromises.stat(absolutePath);
            } catch (error) {
                if (error.code === "ENOENT") {
                    return res
                        .status(404)
                        .json({ success: false, message: "Guide file is missing on disk" });
                }
                throw error;
            }

            const downloadName = file.originalName || file.storedName;
            const disposition = req.query.download === "1" ? "attachment" : "inline";

            res.setHeader("Content-Type", contentTypeFor(file));
            res.setHeader("Accept-Ranges", "bytes");
            // Quotes escaped so a name containing one cannot break out of the header.
            res.setHeader(
                "Content-Disposition",
                `${disposition}; filename="${String(downloadName).replace(/"/g, "'")}"`
            );

            const range = parseRange(req.headers.range, stat.size);

            if (range === "unsatisfiable") {
                res.setHeader("Content-Range", `bytes */${stat.size}`);
                return res.status(416).end();
            }

            if (range) {
                const chunkSize = range.end - range.start + 1;
                res.status(206);
                res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
                res.setHeader("Content-Length", chunkSize);
                return fs
                    .createReadStream(absolutePath, { start: range.start, end: range.end })
                    .pipe(res);
            }

            res.setHeader("Content-Length", stat.size);
            return fs.createReadStream(absolutePath).pipe(res);
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return undefined;
            }
            return respondWithError(res, error, "Failed to load guide file");
        }
    },

    deleteFile: async (req, res) => {
        try {
            const id = parseId(req.params.fileId);
            if (!id) {
                return res.status(400).json({ success: false, message: "Invalid guide id" });
            }

            const deleted = await GuideService.deleteFile(id);
            if (!deleted) {
                return res.status(404).json({ success: false, message: "Guide not found" });
            }

            return res.json({ success: true, message: "Guide deleted" });
        } catch (error) {
            return respondWithError(res, error, "Failed to delete guide");
        }
    },
};

module.exports = GuideController;
