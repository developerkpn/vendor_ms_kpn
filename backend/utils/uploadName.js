const path = require("path");

const sanitizeUploadName = filename => {
    const safeOriginalName = path.basename(String(filename || ""));
    const extensionWithDot = path.extname(safeOriginalName);
    const extension = extensionWithDot.replace(".", "").toLowerCase();
    const baseName = path
        .basename(safeOriginalName, extensionWithDot)
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    return {
        extension,
        safeOriginalName: safeOriginalName || "attachment",
        safeBaseName: baseName || "attachment",
    };
};

module.exports = {
    sanitizeUploadName,
};
