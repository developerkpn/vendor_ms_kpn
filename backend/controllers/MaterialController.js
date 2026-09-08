const Material = require("../models/MaterialModel");
const materialService = require("../services/materialService");
const MaterialTemplate = require("../models/MaterialTemplateModel");
const formidable = require("formidable");
const fs = require("fs");
const path = require("path");
const getMimeType = require("../helper/mimetype");
const {
    buildMaterialDescriptionAndLongText,
} = require("../services/materialService");
const {
    isAdminMaterialApprover,
    normalizeSingleRequestTicketType,
} = require("../services/materialService");
const { sanitizeUploadName } = require("../utils/uploadName");

// User preference store: key is namespaced page.setting (matches mst_user_preference.pref_key).
const USER_PREFERENCE_KEY_PATTERN = /^[a-z0-9_.-]{1,100}$/;
const isValidUserPreferenceKey = key =>
    typeof key === "string" && USER_PREFERENCE_KEY_PATTERN.test(key);
const MAX_USER_PREFERENCE_VALUE_LENGTH = 255;

// Reviewer attachment changes (approve/rework on both approval dialogs). The
// values match the ones the requester's own upload paths enforce inline, so a
// reviewer may attach exactly what a requester may — deliberately no separate
// rule for reviewers. They are named here rather than repeated inline because
// four reviewer entry points share them; the requester paths still carry their
// own copies, so a change to what may be attached has to be made in both
// places until those are folded in too.
const ATTACHMENT_ALLOWED_EXTENSIONS = [
    "pdf",
    "doc",
    "docx",
    "png",
    "jpg",
    "jpeg",
];
const ATTACHMENT_MAX_FILE_SIZE = 5 * 1024 * 1024;

const isMultipartFormRequest = req =>
    String(req.headers?.["content-type"] || "").includes(
        "multipart/form-data"
    );

const buildUploadedAttachment = file => {
    const originalFilename = file.originalFilename || file.newFilename;
    const { extension, safeOriginalName, safeBaseName } =
        sanitizeUploadName(originalFilename);

    if (!ATTACHMENT_ALLOWED_EXTENSIONS.includes(extension)) {
        const error = new Error(
            "Invalid file format. Please upload files with valid extensions: " +
                ATTACHMENT_ALLOWED_EXTENSIONS.join(", ")
        );
        error.statusCode = 400;
        throw error;
    }

    return {
        tempPath: file.filepath,
        originalName: safeOriginalName,
        newName: `${Date.now()}_${safeBaseName}.${extension}`,
        extension,
        mimeType: getMimeType(extension),
    };
};

// An absent or malformed keep list means "no instruction given", which
// resolveAttachmentChangeSet reads as keep everything. Returning [] instead
// would read as "keep none" and delete every existing attachment — the
// requester's resubmit path has always passed the raw value for exactly this
// reason, and the reviewer paths must not diverge from it.
const parseKeepAttachmentIds = value =>
    Array.isArray(value)
        ? value.map(id => Number.parseInt(id, 10)).filter(Number.isInteger)
        : null;

// Merges the three parts of a mass approve/rework multipart body into the
// `{ id, attachments }[]` shape the service layer expects:
//
//   items            JSON, the per-item FIELD EDITS the reviewer made
//   itemAttachments  JSON, [{ id, keepAttachmentIds }] — which existing files
//                    each item keeps; anything absent from the list is removed
//   fileItemId       one per uploaded file, naming the item that file lands on
//
// Edits and attachment changes travel separately because they are independent:
// a reviewer can edit an item without touching its files, or the reverse. An
// item that appears in either list ends up in the result; one that appears in
// neither is untouched.
//
// Files are paired with items positionally — fileItemId[i] belongs to files[i]
// — which is the convention createMassRequest already uses (there:
// `fileRowIndex`). Shared by both the approve and rework multipart branches so
// the wiring is defined once.
// A JSON body carries no files, so it has no legitimate way to describe an
// attachment change — only the multipart branch does. Dropping `attachments`
// here means a hand-written JSON body cannot reach the attachment code at all,
// rather than relying on the service to reject each way it might be abused.
const stripAttachmentInstructions = items =>
    Array.isArray(items)
        ? items.map(item => {
              if (!item || typeof item !== "object" || !("attachments" in item)) {
                  return item;
              }
              const { attachments: _ignored, ...rest } = item;
              return rest;
          })
        : items;

const buildMassRequestItemsWithAttachments = (fields, files) => {
    const items = fields.items ? JSON.parse(fields.items) : [];
    const itemAttachments = fields.itemAttachments
        ? JSON.parse(fields.itemAttachments)
        : [];
    const fileItemIds = Array.isArray(fields.fileItemId)
        ? fields.fileItemId
        : fields.fileItemId != null
          ? [fields.fileItemId]
          : [];

    const newAttachmentsByItemId = new Map();
    for (let i = 0; i < files.length; i += 1) {
        const itemId = fileItemIds[i];
        if (itemId == null) {
            const error = new Error(
                "Invalid attachment upload. Each file must be linked to an item id."
            );
            error.statusCode = 400;
            throw error;
        }
        const key = String(itemId);
        if (!newAttachmentsByItemId.has(key)) {
            newAttachmentsByItemId.set(key, []);
        }
        newAttachmentsByItemId.get(key).push(buildUploadedAttachment(files[i]));
    }

    const keepIdsByItemId = new Map(
        (Array.isArray(itemAttachments) ? itemAttachments : [])
            .filter(entry => entry?.id != null)
            .map(entry => [
                String(entry.id),
                parseKeepAttachmentIds(entry.keepAttachmentIds),
            ])
    );

    const itemIds = new Set([
        ...items.map(item => String(item.id)),
        ...keepIdsByItemId.keys(),
        ...newAttachmentsByItemId.keys(),
    ]);

    return Array.from(itemIds).map(idKey => {
        const original = items.find(item => String(item.id) === idKey) || {
            id: idKey,
        };
        const newAttachments = newAttachmentsByItemId.get(idKey) || [];
        const hasAttachmentChange =
            keepIdsByItemId.has(idKey) || newAttachments.length > 0;

        if (!hasAttachmentChange) {
            return original;
        }

        return {
            ...original,
            id: original.id ?? idKey,
            attachments: {
                keepAttachmentIds: keepIdsByItemId.get(idKey) ?? null,
                newAttachments,
            },
        };
    });
};

const MaterialController = {
    // Create a new material group
    createMaterialGroup: async (req, res) => {
        try {
            const { code, name } = req.body;

            // Validate required fields
            if (!code || !name) {
                return res.status(400).json({
                    success: false,
                    message: "Group code and name are required",
                });
            }

            const result = await Material.createMaterialGroup({ code, name });

            res.status(201).json({
                success: true,
                message: "Material group created successfully",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to create material group";

            if (error.message === "Group code already exists") {
                statusCode = 409;
                message = error.message;
            }

            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Update a material group
    updateMaterialGroup: async (req, res) => {
        try {
            const { groupId } = req.params;
            const { code, name } = req.body;

            // Validate at least one field to update
            if (!code && !name) {
                return res.status(400).json({
                    success: false,
                    message:
                        "At least one field (code or name) is required for update",
                });
            }

            const result = await Material.updateMaterialGroup(groupId, {
                code,
                name,
            });

            res.status(200).json({
                success: true,
                message: "Material group updated successfully",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to update material group";

            if (error.message === "Group not found") {
                statusCode = 404;
                message = error.message;
            } else if (error.message === "Group code already exists") {
                statusCode = 409;
                message = error.message;
            }

            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Delete a material group (soft delete)
    deleteMaterialGroup: async (req, res) => {
        try {
            const { groupId } = req.params;
            const deletedBy = req.cookies.user_id;
            // Validation: check if group exists and is not already deleted
            const groupCheck = await materialService.getGroupById(groupId);
            if (!groupCheck) {
                throw new Error("Group not found");
            }
            if (groupCheck.deleted_at) {
                throw new Error("Group is already deleted");
            }
            const result = await Material.deleteMaterialGroup(
                groupId,
                deletedBy
            );
            res.status(200).json({
                success: true,
                message: "Material group soft deleted successfully (cascade)",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to soft delete material group";
            if (error.message === "Group not found") {
                statusCode = 404;
                message = error.message;
            } else if (error.message === "Group is already deleted") {
                statusCode = 400;
                message = error.message;
            }
            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Create a new material subgroup
    createMaterialSubGroup: async (req, res) => {
        try {
            const { code, name, item_group_id } = req.body;

            // Validate required fields
            if (!code || !name || !item_group_id) {
                return res.status(400).json({
                    success: false,
                    message: "Subgroup code, name, and group ID are required",
                });
            }

            const result = await Material.createMaterialSubGroup({
                code,
                name,
                item_group_id,
            });

            res.status(201).json({
                success: true,
                message: "Material subgroup created successfully",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to create material subgroup";

            if (error.message === "Parent group not found") {
                statusCode = 404;
                message = error.message;
            } else if (
                error.message ===
                "Subgroup code already exists within this group"
            ) {
                statusCode = 409;
                message = error.message;
            }

            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Update a material subgroup
    updateMaterialSubGroup: async (req, res) => {
        try {
            const { subGroupId } = req.params;
            const { code, name, item_group_id } = req.body;

            // Validate at least one field to update
            if (!code && !name && !item_group_id) {
                return res.status(400).json({
                    success: false,
                    message:
                        "At least one field (code, name, or group ID) is required for update",
                });
            }

            const result = await Material.updateMaterialSubGroup(subGroupId, {
                code,
                name,
                item_group_id,
            });

            res.status(200).json({
                success: true,
                message: "Material subgroup updated successfully",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to update material subgroup";

            if (
                error.message === "Subgroup not found" ||
                error.message === "Parent group not found"
            ) {
                statusCode = 404;
                message = error.message;
            } else if (
                error.message ===
                "Subgroup code already exists within this group"
            ) {
                statusCode = 409;
                message = error.message;
            }

            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Delete a material subgroup (soft delete)
    deleteMaterialSubGroup: async (req, res) => {
        try {
            const { subGroupId } = req.params;
            const deletedBy = req.cookies.user_id;
            // Validation: check if subgroup exists and is not already deleted
            const subGroupCheck = await materialService.getSubGroupById(subGroupId);
            if (!subGroupCheck) {
                throw new Error("Subgroup not found");
            }
            if (subGroupCheck.deleted_at) {
                throw new Error("Subgroup is already deleted");
            }
            const result = await Material.deleteMaterialSubGroup(
                subGroupId,
                deletedBy
            );
            res.status(200).json({
                success: true,
                message:
                    "Material subgroup soft deleted successfully (cascade)",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to soft delete material subgroup";
            if (error.message === "Subgroup not found") {
                statusCode = 404;
                message = error.message;
            } else if (error.message === "Subgroup is already deleted") {
                statusCode = 400;
                message = error.message;
            }
            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Export only groups to Excel
    exportOnlyGroupsToExcel: async (req, res) => {
        try {
            const buffer = await Material.exportOnlyGroupsToExcel();

            // Set headers for Excel file download
            res.setHeader(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            res.setHeader(
                "Content-Disposition",
                "attachment; filename=groups.xlsx"
            );
            res.setHeader("Content-Length", buffer.length);

            // Send the file buffer
            res.send(buffer);
        } catch (error) {
            console.error("Groups Excel export error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to export groups to Excel",
                error: error.message,
            });
        }
    },

    // Export only subgroups to Excel
    exportOnlySubgroupsToExcel: async (req, res) => {
        try {
            const groupId = req.params.groupId || null;
            const buffer = await Material.exportOnlySubgroupsToExcel(groupId);

            // Set filename based on whether we're exporting for a specific group
            const filename = groupId
                ? `subgroups_${groupId}.xlsx`
                : "subgroups.xlsx";

            // Set headers for Excel file download
            res.setHeader(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            res.setHeader(
                "Content-Disposition",
                `attachment; filename=${filename}`
            );
            res.setHeader("Content-Length", buffer.length);

            // Send the file buffer
            res.send(buffer);
        } catch (error) {
            console.error("Subgroups Excel export error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to export subgroups to Excel",
                error: error.message,
            });
        }
    },

    // Import only groups from Excel
    importOnlyGroupsFromExcel: async (req, res) => {
        try {
            // Get user ID from session
            const userId = req.cookies.user_id;

            // Parse form with uploaded file
            const form = new formidable.IncomingForm();
            const [fields, items] = await form.parse(req);

            // Get the uploaded file - handle different possible formats from formidable
            const file = items.file?.[0] || items.files?.[0] || null;

            if (!file) {
                console.error("No file found in request:", { fields, items });
                return res.status(400).json({
                    success: false,
                    message:
                        "No file uploaded or file field not found in request",
                });
            }

            // Check file extension
            const fileExtension = path
                .extname(file.originalFilename)
                .toLowerCase();
            if (fileExtension !== ".xlsx" && fileExtension !== ".xls") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid file format. Please upload an Excel file (.xlsx or .xls)",
                });
            }

            // Read file buffer
            const fileBuffer = fs.readFileSync(file.filepath);

            // Import groups from Excel
            await Material.importOnlyGroupsFromExcel(fileBuffer, userId);

            // Delete temp file
            fs.unlinkSync(file.filepath);

            res.status(200).json({
                success: true,
                message: "Groups imported successfully",
            });
        } catch (error) {
            console.error("Groups Excel import error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to import groups from Excel",
                error: error.message,
            });
        }
    },

    // Import only subgroups from Excel
    importOnlySubgroupsFromExcel: async (req, res) => {
        try {
            // Get user ID from session
            const userId = req.cookies.user_id;

            // Parse form with uploaded file
            const form = new formidable.IncomingForm();
            const [fields, items] = await form.parse(req);

            // Get the uploaded file - handle different possible formats from formidable
            const file = items.file?.[0] || items.files?.[0] || null;

            if (!file) {
                console.error("No file found in request:", { fields, items });
                return res.status(400).json({
                    success: false,
                    message:
                        "No file uploaded or file field not found in request",
                });
            }

            // Check file extension
            const fileExtension = path
                .extname(file.originalFilename)
                .toLowerCase();
            if (fileExtension !== ".xlsx" && fileExtension !== ".xls") {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid file format. Please upload an Excel file (.xlsx or .xls)",
                });
            }

            // Read file buffer
            const fileBuffer = fs.readFileSync(file.filepath);

            // Import subgroups from Excel
            await Material.importOnlySubgroupsFromExcel(fileBuffer, userId);

            // Delete temp file
            fs.unlinkSync(file.filepath);

            res.status(200).json({
                success: true,
                message: "Subgroups imported successfully",
            });
        } catch (error) {
            console.error("Subgroups Excel import error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to import subgroups from Excel",
                error: error.message,
            });
        }
    },

    // Get all material groups
    getMaterialGroups: async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;
            const searchQuery = req.query.q || "";
            const sort = req.query.sort || "code";
            const order = req.query.order || "asc";

            const result = await Material.getMaterialGroups(
                page,
                pageSize,
                searchQuery,
                sort,
                order
            );
            res.status(200).json({
                success: true,
                data: result.data,
                searchQuery: searchQuery,
                pagination: {
                    page,
                    pageSize,
                    totalCount: result.pagination.totalCount,
                    totalPages: result.pagination.totalPages,
                },
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch material groups",
                error: error.message,
            });
        }
    },

    // Get all material groups for dropdown (no pagination)
    getAllMaterialGroups: async (req, res) => {
        try {
            const result = await Material.getAllMaterialGroups();
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch all material groups",
                error: error.message,
            });
        }
    },

    // Get all subgroups for a group for dropdown (no pagination)
    getAllSubgroupsByGroup: async (req, res) => {
        try {
            const { groupId } = req.params;
            const result = await Material.getAllSubgroupsByGroup(groupId);
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch all subgroups for group",
                error: error.message,
            });
        }
    },

    // Get subgroups by group ID
    getMaterialSubGroups: async (req, res) => {
        try {
            const { groupId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;
            const searchQuery = req.query.q || "";
            const sort = req.query.sort || "code";
            const order = req.query.order || "asc";

            const result = await Material.getMaterialSubGroups(
                groupId,
                page,
                pageSize,
                searchQuery,
                sort,
                order
            );
            res.status(200).json({
                success: true,
                data: result.data,
                searchQuery: searchQuery,
                pagination: {
                    page,
                    pageSize,
                    totalCount: result.pagination.totalCount,
                    totalPages: result.pagination.totalPages,
                },
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch material subgroups",
                error: error.message,
            });
        }
    },

    // Get materials by group ID
    getMaterialsByGroup: async (req, res) => {
        try {
            const { groupId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;

            const result = await Material.getMaterialsByGroup(
                groupId,
                page,
                pageSize
            );
            res.status(200).json({
                success: true,
                data: result.materials,
                group: result.group,
                pagination: result.pagination,
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch materials by group",
                error: error.message,
            });
        }
    },

    // Get materials by subgroup ID
    getMaterialsBySubGroup: async (req, res) => {
        try {
            const { subGroupId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;
            const searchQuery = req.query.q || "";
            const sort = req.query.sort || "code";
            const order = req.query.order || "asc";

            const result = await Material.getMaterialsBySubGroup(
                subGroupId,
                page,
                pageSize,
                searchQuery,
                sort,
                order
            );
            res.status(200).json({
                success: true,
                data: result.materials,
                subGroup: result.subgroup,
                group: result.group,
                searchQuery: searchQuery,
                pagination: result.pagination,
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch materials",
                error: error.message,
            });
        }
    },

    // Search materials
    searchMaterials: async (req, res) => {
        try {
            const { q, groupId, sortBy, sortOrder } = req.query;
            let sorting_state = [];
            const reservedQueryKeys = new Set([
                "q",
                "pageSize",
                "page",
                "groupId",
                "sortBy",
                "sortOrder",
            ]);

            Object.keys(req.query).map(key => {
                if (reservedQueryKeys.has(key)) return;
                sorting_state.push({ col: key, state: req.query[key] });
            });

            if (sortBy) {
                sorting_state.unshift({
                    col: sortBy,
                    state: sortOrder || "asc",
                });
            }

            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;

            // If no search query is provided, get all materials sorted by group
            const searchTerm = q ? q.trim() : "";
            const result = await Material.searchMaterials(
                searchTerm,
                page,
                pageSize,
                sorting_state,
                groupId
            );

            res.status(200).json({
                success: true,
                data: result.materials,
                searchTerm: searchTerm,
                count: result.materials.length,
                pagination: result.pagination,
                totalCount: result.pagination.totalCount,
            });
        } catch (error) {
            console.error("Search error:", error.message);
            res.status(500).json({
                success: false,
                message: "Failed to search materials",
                error: error.message,
            });
        }
    },

    // Search all materials (including deleted)
    searchAllMaterials: async (req, res) => {
        try {
            const { q } = req.query;
            let sorting_state = [];
            Object.keys(req.query).map(key => {
                if (key == "q" || key == "pageSize" || key == "page") return;
                sorting_state.push({ col: key, state: req.query[key] });
            });
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 10;
            const searchTerm = q ? q.trim() : "";
            const result = await Material.searchAllMaterials(
                searchTerm,
                page,
                pageSize,
                sorting_state
            );
            res.status(200).json({
                success: true,
                data: result.materials,
                searchTerm: searchTerm,
                count: result.materials.length,
                pagination: result.pagination,
                totalCount: result.pagination.totalCount,
            });
        } catch (error) {
            console.error("Search all error:", error.message);
            res.status(500).json({
                success: false,
                message: "Failed to search all materials",
                error: error.message,
            });
        }
    },

    // Get material by ID with attachments
    getMaterialById: async (req, res) => {
        try {
            const { materialId } = req.params;
            const material = await Material.getMaterialById(materialId);

            if (!material) {
                return res.status(404).json({
                    success: false,
                    message: "Material not found",
                });
            }

            const attachments =
                await Material.getMaterialAttachments(materialId);

            res.status(200).json({
                success: true,
                data: {
                    ...material,
                    attachments,
                },
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch material details",
                error: error.message,
            });
        }
    },

    // Upload attachment for a material
    uploadAttachment: async (req, res) => {
        // Track the temporary files and paths to handle cleanup on failure
        const tempFilePaths = [];

        try {
            const { materialId } = req.params;
            const updatedBy = req.cookies.user_id;

            // Check if material exists
            const material = await Material.getMaterialById(materialId);
            if (!material) {
                return res.status(404).json({
                    success: false,
                    message: "Material not found",
                });
            }

            // Allowed file extensions
            const extensions = ["pdf", "doc", "docx", "png", "jpg", "jpeg"];

            // Configure formidable
            const form = new formidable.IncomingForm();
            form.options.multiples = true;
            form.options.maxFileSize = 5 * 1024 * 1024; // 5MB max file size

            // Store files temporarily but don't move them yet
            const [fields, items] = await form.parse(req);
            const files = items.files || items.file;

            if (!files || files.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "No files uploaded",
                });
            }

            const filesToProcess = [];

            for (const file of files) {
                try {
                    // Generate timestamp for unique filename
                    const timestamp = Date.now().toString();

                    // Split filename to get extension
                    let name = file.originalFilename.split(".");
                    name[0] = name[0].replace(/ /g, "_");
                    const extension = name[name.length - 1].toLowerCase();

                    // Check if extension is allowed
                    if (!extensions.includes(extension)) {
                        throw new Error("File format invalid");
                    }

                    // Create new filename with timestamp
                    const newName = `${name
                        .slice(0, -1)
                        .join(".")}_${timestamp}.${extension}`;

                    // Save the temporary file path for later
                    tempFilePaths.push(file.filepath);

                    // Add to list of files to process (let model determine MIME type)
                    filesToProcess.push({
                        tempPath: file.filepath,
                        newName,
                        extension,
                        originalName: file.originalFilename,
                    });
                } catch (error) {
                    if (error.message === "File format invalid") {
                        return res.status(400).json({
                            success: false,
                            message:
                                "Invalid file format. Please upload files with valid extensions: " +
                                extensions.join(", "),
                        });
                    }
                    throw error;
                }
            }

            // Get user group from cookies for role checking
            const userRole = req.cookies?.role;
            const userName = req.cookies?.username;

            // Use the addAttachment method that handles both database and file operations
            const result = await Material.addAttachment(
                materialId,
                filesToProcess,
                updatedBy,
                userRole,
                userName
            );

            res.status(200).json({
                success: true,
                files: result.files,
            });
        } catch (error) {
            console.error("Upload error:", error);

            if (error.code === 1016) {
                return res.status(400).json({
                    success: false,
                    message: "File size exceeded. Maximum file size is 5MB",
                });
            }

            res.status(500).json({
                success: false,
                message: "Failed to upload attachment",
                error: error.message,
            });
        }
    },

    // Update material aliases
    updateAliases: async (req, res) => {
        try {
            const { materialId } = req.params;
            const { alias1, alias2, alias3 } = req.body;

            const updatedBy = req.cookies.user_id;
            const userRole = req.cookies?.role;
            const userName = req.cookies?.username;

            // Check if material exists
            const material = await Material.getMaterialById(materialId);
            if (!material) {
                return res.status(404).json({
                    success: false,
                    message: "Material not found",
                });
            }

            // Update aliases without updating timestamps
            const result = await Material.updateAliasesOnly(
                materialId,
                alias1,
                alias2,
                alias3,
                userRole,
                userName
            );

            // Update timestamps separately
            await Material.updateMaterialTimestamp(materialId, updatedBy);

            res.status(200).json({
                success: true,
                message: "Material aliases updated successfully",
                data: result,
            });
        } catch (error) {
            console.error("Update aliases error:", error);
            res.status(500).json({
                success: false,
                message: "Failed to update material aliases",
                error: error.message,
            });
        }
    },

    // Get material attachments
    getMaterialAttachments: async (req, res) => {
        try {
            const { materialId } = req.params;

            // Get attachments for the material
            const attachments =
                await Material.getMaterialAttachments(materialId);

            res.status(200).json({
                success: true,
                data: attachments,
            });
        } catch (error) {
            console.error("Error fetching attachments:", error);
            res.status(500).json({
                success: false,
                message: "Failed to fetch attachments",
                error: error.message,
            });
        }
    },

    // Serve file from public directory
    serveFile: async (req, res) => {
        try {
            // With route "/file*", req.params[0] captures everything after "/file"
            // (e.g. "/attachments/single-request/..."). Strip the leading "/".
            const rawSubPath =
                typeof req.params[0] === "string"
                    ? req.params[0]
                    : Array.isArray(req.params.subPath)
                      ? req.params.subPath.join("/")
                      : typeof req.params.subPath === "string"
                        ? req.params.subPath
                        : "";
            const subPath = rawSubPath.replace(/^\/+/, "");
            const normalizedSubPath = String(subPath).replace(/\\/g, "/");
            const absoluteDirectory = path.join(
                path.resolve(),
                "backend",
                "public"
            );
            const candidatePath = path.resolve(
                absoluteDirectory,
                normalizedSubPath
            );
            const directoryPrefix = `${absoluteDirectory}${path.sep}`;
            const filepath =
                candidatePath !== absoluteDirectory &&
                !candidatePath.startsWith(directoryPrefix)
                    ? null
                    : fs.existsSync(candidatePath)
                      ? candidatePath
                      : undefined;

            // Check if file exists
            if (!filepath) {
                return res.status(404).json({
                    success: false,
                    message: "File not found",
                });
            }

            // Get file stats
            const stats = fs.statSync(filepath);

            // Determine content type based on file extension
            const ext = path.extname(subPath).toLowerCase();
            let contentType = "application/octet-stream";

            switch (ext) {
                case ".pdf":
                    contentType = "application/pdf";
                    break;
                case ".png":
                    contentType = "image/png";
                    break;
                case ".jpg":
                case ".jpeg":
                    contentType = "image/jpeg";
                    break;
                case ".gif":
                    contentType = "image/gif";
                    break;
                case ".doc":
                case ".docx":
                    contentType = "application/msword";
                    break;
            }

            // Set appropriate headers (use only the basename for the
            // Content-Disposition filename to avoid leaking folder names).
            const basename = path.basename(subPath);
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", stats.size);
            res.setHeader(
                "Content-Disposition",
                `inline; filename="${basename}"`
            );

            // Stream the file
            const fileStream = fs.createReadStream(filepath);
            fileStream.pipe(res);
        } catch (error) {
            console.error("Error serving file:", error);
            res.status(500).json({
                success: false,
                message: "Failed to serve file",
                error: error.message,
            });
        }
    },

    // Delete attachment
    deleteAttachment: async (req, res) => {
        try {
            const { attachmentId } = req.params;
            const updatedBy = req.cookies.user_id;

            const result = await Material.deleteAttachment(
                attachmentId,
                updatedBy
            );

            res.status(200).json({
                success: true,
                message: "Attachment deleted successfully",
                data: result,
            });
        } catch (error) {
            console.error("Error deleting attachment:", error);

            let statusCode = 500;
            let message = "Failed to delete attachment";

            if (error.message === "Attachment not found") {
                statusCode = 404;
                message = error.message;
            }

            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    // Get attachments for materials by array of codes
    getAttachmentsByCodes: async (req, res) => {
        try {
            const codes = req.body.codes;
            if (!Array.isArray(codes) || codes.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "'codes' must be a non-empty array.",
                });
            }
            const result = await Material.getAttachmentsByCodes(codes);
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Failed to fetch attachments by codes",
                error: error.message,
            });
        }
    },

    // SAP Data Synchronization endpoint
    syncSAPData: async (req, res) => {
        try {
            const { startDate, endDate, fieldName = "LAEDA" } = req.query;
            const result = await Material.syncSAPDataJob({
                startDate,
                endDate,
                fieldName,
            });
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(500).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to sync SAP data",
                error: error.message,
            });
        }
    },

    getMaterialTemplates: async (req, res) => {
        try {
            const templates = await MaterialTemplate.getMaterialTemplates();
            return res.status(200).json({
                success: true,
                message: "Material templates fetched successfully",
                data: templates,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch material templates",
                error: error.message,
            });
        }
    },

    getMaterialTemplateByGroup: async (req, res) => {
        try {
            const { materialGroupCode } = req.params;
            const materialTemplate =
                await MaterialTemplate.getMaterialTemplateByGroupCode(
                    materialGroupCode
                );

            return res.status(200).json({
                success: true,
                message: "Material template fetched successfully",
                data: materialTemplate,
            });
        } catch (error) {
            const statusCode =
                error.message &&
                error.message.includes("Material template tidak ditemukan")
                    ? 404
                    : 500;

            return res.status(statusCode).json({
                success: false,
                message: "Failed to fetch material template",
                error: error.message,
            });
        }
    },

    getMaterialFormSchemaByGroup: async (req, res) => {
        try {
            const { materialGroupCode } = req.params;
            const formSchema =
                await MaterialTemplate.getMaterialFormSchemaByGroupCode(
                    materialGroupCode
                );

            return res.status(200).json({
                success: true,
                message: "Material form schema fetched successfully",
                data: formSchema,
            });
        } catch (error) {
            const statusCode =
                error.message &&
                (error.message.includes("Material template tidak ditemukan") ||
                    error.message.includes("Material group tidak ditemukan"))
                    ? 404
                    : 500;

            return res.status(statusCode).json({
                success: false,
                message: "Failed to fetch material form schema",
                error: error.message,
            });
        }
    },

    previewMaterialTemplateDescription: async (req, res) => {
        try {
            const { materialGroupCode: materialGroupCodeParam } = req.params;
            const {
                materialGroupCode = materialGroupCodeParam,
                templateValues = {},
            } = req.body || {};

            if (!materialGroupCode) {
                return res.status(400).json({
                    success: false,
                    message: "materialGroupCode is required",
                });
            }

            const preview =
                await MaterialTemplate.previewMaterialTemplateDescription(
                    materialGroupCode,
                    templateValues
                );

            return res.status(200).json({
                success: true,
                message: "Material description preview generated successfully",
                data: preview,
            });
        } catch (error) {
            const statusCode =
                error.message &&
                error.message.includes("Material template tidak ditemukan")
                    ? 404
                    : 500;

            return res.status(statusCode).json({
                success: false,
                message: "Failed to generate material description preview",
                error: error.message,
            });
        }
    },

    validateMaterialTemplate: async (req, res) => {
        try {
            const {
                materialGroupCode,
                requestFields = {},
                templateValues = {},
            } = req.body || {};

            if (!materialGroupCode) {
                return res.status(400).json({
                    success: false,
                    message: "materialGroupCode is required",
                });
            }

            const validation =
                await MaterialTemplate.validateMaterialRequestTemplate({
                    materialGroupCode,
                    requestFields,
                    templateValues,
                });

            return res.status(200).json({
                success: true,
                message: "Material template validated successfully",
                data: validation,
            });
        } catch (error) {
            const statusCode =
                error.message &&
                error.message.includes("Material template tidak ditemukan")
                    ? 404
                    : 500;

            return res.status(statusCode).json({
                success: false,
                message: "Failed to validate material template",
                error: error.message,
            });
        }
    },

    checkActiveSingleRequest: async (req, res) => {
        try {
            const materialCode = String(req.query?.materialCode ?? "").trim();
            const ticketType = String(req.query?.ticketType ?? "").trim();

            if (!materialCode) {
                return res.status(400).json({
                    success: false,
                    message: "Material code is required",
                });
            }

            if (!ticketType || (ticketType !== "Change" && ticketType !== "Extend")) {
                return res.status(400).json({
                    success: false,
                    message: "Ticket type must be Change or Extend",
                });
            }

            const hasActive = await materialService.hasActiveSingleRequest({
                materialCode,
                ticketType,
            });

            return res.status(200).json({
                success: true,
                data: { materialCode, ticketType, hasActive },
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to check active request status",
            });
        }
    },

    createSingleRequest: async (req, res) => {
        let tempFilePaths = [];

        try {
            const userId = req.cookies.user_id;
            const allowedFileExtensions = [
                "pdf",
                "doc",
                "docx",
                "png",
                "jpg",
                "jpeg",
            ];
            const maxAttachments = 3;
            const isMultipartRequest = String(
                req.headers?.["content-type"] || ""
            ).includes("multipart/form-data");
            let materialGroupCode = "";
            let materialGroupId = Number.parseInt(
                req.body?.materialGroupId,
                10
            );
            let ticketType = normalizeSingleRequestTicketType(
                req.body?.ticketType
            ).trim();
            let materialCode = String(req.body?.materialCode || "").trim();
            let changeExtendReason = String(
                req.body?.change_extend_reason || ""
            ).trim();
            let comment = String(req.body?.comment || "").trim();
            let materialSubGroupId = Number.parseInt(
                req.body?.materialSubGroupId,
                10
            );
            let requestFields = req.body?.requestFields || {};
            let templateValues = req.body?.templateValues || {};
            let files = [];
            let sapMaterial = null;

            if (isMultipartRequest) {
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = 5 * 1024 * 1024;

                const [fields, items] = await form.parse(req);
                materialGroupCode = String(fields.materialGroupCode || "").trim();
                ticketType = normalizeSingleRequestTicketType(
                    fields.ticketType
                );
                materialCode = String(fields.materialCode || "").trim();
                changeExtendReason = String(
                    fields.changeExtendReason || ""
                ).trim();
                comment = String(fields.comment || "").trim();
                materialSubGroupId = Number.parseInt(fields.subgroup, 10);
                requestFields = JSON.parse(fields.requestFields);
                templateValues = JSON.parse(fields.templateValues);
                files = (items.files || []).filter(Boolean);
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);
            }

            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: "Unauthorized",
                });
            }

            if (
                ticketType !== "Create" &&
                !materialCode
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Material code is required",
                });
            }

            if (!isMultipartRequest && ticketType !== "Create") {
                sapMaterial = await Material.getMaterialByCode(materialCode);

                if (!sapMaterial) {
                    return res.status(404).json({
                        success: false,
                        message: "Material code not found in SAP master data",
                    });
                }

                materialGroupId = Number.parseInt(sapMaterial.groupId, 10);
                materialSubGroupId = Number.parseInt(sapMaterial.subGroupId, 10);
                materialGroupCode = String(sapMaterial.groupCode || "").trim();
            }

            if (
                isMultipartRequest &&
                !materialGroupCode
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Material group is required",
                });
            }

            if (
                !isMultipartRequest &&
                !Number.isInteger(materialGroupId)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Material group is required",
                });
            }

            if (
                ticketType === "Create" &&
                files.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Minimum 1 attachment is required",
                });
            }

            if (
                ticketType !== "Create" &&
                files.length > 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: `${ticketType} requests do not support attachments`,
                });
            }

            if (files.length > maxAttachments) {
                return res.status(400).json({
                    success: false,
                    message: `Maximum ${maxAttachments} attachments are allowed`,
                });
            }

            const materialGroup = isMultipartRequest
                ? await materialService.getMaterialGroupByCode(materialGroupCode)
                : await materialService.getGroupById(materialGroupId);
            if (!materialGroup) {
                return res.status(404).json({
                    success: false,
                    message: "Material group not found",
                });
            }

            // Sub material group is optional at submission time — MDM can fill
            // it in later via the approval-edit patch. Only validated when the
            // requester did pick one.
            if (Number.isInteger(materialSubGroupId)) {
                const subgroup =
                    await materialService.getSubGroupById(materialSubGroupId);
                if (!subgroup || subgroup.deleted_at) {
                    return res.status(404).json({
                        success: false,
                        message: "Sub material group not found",
                    });
                }

                if (Number(subgroup.item_group_id) !== Number(materialGroup.id)) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Sub material group does not belong to the selected material group",
                    });
                }
            } else {
                materialSubGroupId = null;
            }

            const attachments = files.map(file => {
                const originalFilename = file.originalFilename || file.newFilename;
                const { extension, safeOriginalName, safeBaseName } =
                    sanitizeUploadName(originalFilename);

                if (!allowedFileExtensions.includes(extension)) {
                    const error = new Error(
                        "Invalid file format. Please upload files with valid extensions: " +
                            allowedFileExtensions.join(", ")
                    );
                    error.statusCode = 400;
                    throw error;
                }

                return {
                    tempPath: file.filepath,
                    originalName: safeOriginalName,
                    newName: `${Date.now()}_${safeBaseName}.${extension}`,
                    extension,
                    mimeType: getMimeType(extension),
                };
            });

            const hydratedRequestFields = { ...requestFields };
            if (sapMaterial && ticketType !== "Create") {
                hydratedRequestFields.material_number =
                    hydratedRequestFields.material_number ??
                    (String(materialCode || sapMaterial.code || "").trim() ||
                        null);
                hydratedRequestFields.material_type =
                    hydratedRequestFields.material_type ??
                    (String(sapMaterial.type || "").trim() || null);
                hydratedRequestFields.material_group =
                    hydratedRequestFields.material_group ??
                    (String(
                        materialGroup?.code || sapMaterial.groupCode || ""
                    ).trim() || null);
                hydratedRequestFields.base_unit_of_measure =
                    hydratedRequestFields.base_unit_of_measure ??
                    (String(sapMaterial.unit_of_measurement || "").trim() ||
                        null);
            }
            const validation =
                ticketType === "Extend"
                    ? {
                          errors: [],
                          normalizedRequestFields: hydratedRequestFields,
                          normalizedTemplateValues: templateValues,
                      }
                    : await MaterialTemplate.validateMaterialRequestTemplate({
                          materialGroupCode,
                          requestFields: hydratedRequestFields,
                          templateValues,
                      });

            const validationErrors = (validation.errors || []).filter(error => {
                const fieldKey = error.fieldKey ?? error.field_key;
                if (!fieldKey) {
                    return false;
                }
                if (ticketType !== "Change") {
                    return true;
                }
                const matchingTemplateField = Array.isArray(
                    validation.template?.fields
                )
                    ? validation.template.fields.find(
                          field =>
                              (field?.fieldKey ?? field?.field_key) === fieldKey
                      )
                    : null;
                const templateValue = templateValues[fieldKey];
                const hasTemplateValue =
                    templateValue !== undefined &&
                    templateValue !== null &&
                    !(
                        typeof templateValue === "string" &&
                        templateValue.trim() === ""
                    );
                const isMissingTemplateValueError =
                    Boolean(matchingTemplateField?.isMandatory) &&
                    !hasTemplateValue &&
                    /wajib diisi/i.test(String(error.message || ""));
                return !isMissingTemplateValueError;
            });

            if (validationErrors.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: "Material request validation failed",
                    errors: validationErrors,
                });
            }

            const baseNormalizedFields =
                validation.normalizedRequestFields || {};
            const normalizedRequestFields = {
                ...baseNormalizedFields,
                material_description:
                    requestFields.material_description ||
                    validation.materialDescription ||
                    baseNormalizedFields.material_description,
                storage_location: requestFields.storage_location || null,
                plant: requestFields.plant || null,
            };
            for (const fieldKey of [
                "long_text_1",
                "long_text_2",
                "long_text_3",
                "moving_avg_price",
            ]) {
                if (
                    requestFields[fieldKey] !== undefined &&
                    requestFields[fieldKey] !== null
                ) {
                    normalizedRequestFields[fieldKey] = requestFields[fieldKey];
                }
            }

            if (
                hydratedRequestFields.base_unit_of_measure !== undefined &&
                hydratedRequestFields.base_unit_of_measure !== null
            ) {
                normalizedRequestFields.base_unit_of_measure =
                    hydratedRequestFields.base_unit_of_measure;
            }

            if (
                ticketType !== "Extend" &&
                !normalizedRequestFields.base_unit_of_measure
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Base UoM is required",
                });
            }

            if (
                ticketType === "Extend" &&
                (!normalizedRequestFields.plant ||
                    !normalizedRequestFields.storage_location)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Plant and storage location are required",
                });
            }

            if (
                ticketType !== "Create" &&
                !changeExtendReason
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Change or extend reason is required",
                });
            }

            if (ticketType !== "Create") {
                const hasActive = await materialService.hasActiveSingleRequest({
                    materialCode,
                    ticketType,
                });

                if (hasActive) {
                    return res.status(409).json({
                        success: false,
                        message: `An active ${ticketType.toLowerCase()} request already exists for material ${materialCode}. Please wait for it to complete before submitting a new one.`,
                    });
                }
            }

            const createdRequest = await materialService.createSingleRequest({
                ticketType,
                materialCode,
                changeExtendReason,
                comment,
                materialGroupId: materialGroup.id,
                materialSubGroupId,
                requestFields: normalizedRequestFields,
                templateValues:
                    validation.normalizedTemplateValues || templateValues,
                templateConfig: validation.template || null,
                attachments,
                createdBy: userId,
                createdByUsername: req.cookies?.username ?? null,
            });

            return res.status(201).json({
                success: true,
                message: "Single material request created successfully",
                data: createdRequest,
            });
        } catch (error) {
            const statusCode =
                error.statusCode || (error.code === 1016 ? 400 : 500);

            return res.status(statusCode).json({
                success: false,
                message:
                    error.code === 1016
                        ? "File size exceeded. Maximum file size is 5MB"
                        : error.message ||
                          "Failed to create single material request",
                errors: error.errors || [],
            });
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },
    // Create a batch of material-create requests (1..10 rows per submit).
    createMassRequest: async (req, res) => {
        let tempFilePaths = [];

        try {
            const userId = req.cookies.user_id;
            const maxRows = 10;
            const minRows = 2;
            const maxAttachmentsPerRow = 3;
            const minAttachmentsPerRow = 1;
            const allowedFileExtensions = [
                "pdf",
                "doc",
                "docx",
                "png",
                "jpg",
                "jpeg",
            ];
            const textFields = [
                "plant",
                "sloc",
                "materialGroup",
                "materialSubGroup",
                "description",
                "poText",
                "uom",
                "spesifikasiTambahan",
            ];
            const requiredFieldMessages = {
                plant: "Plant wajib diisi.",
                sloc: "Sloc wajib diisi.",
                materialGroup: "Material group wajib diisi.",
                materialSubGroup: "Sub material group wajib diisi.",
                description: "Material description wajib diisi.",
                uom: "Base UoM wajib diisi.",
            };
            const isMultipartRequest = String(
                req.headers?.["content-type"] || ""
            ).includes("multipart/form-data");

            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: "Unauthorized",
                });
            }

            if (!isMultipartRequest) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Mass request must be submitted as multipart/form-data.",
                });
            }

            const form = new formidable.IncomingForm();
            form.options.multiples = true;
            form.options.maxFileSize = 5 * 1024 * 1024;

            const [fields, items] = await form.parse(req);
            const rows = JSON.parse(fields.rows);
            const files = (items.files || []).filter(Boolean);
            tempFilePaths = files.map(file => file.filepath).filter(Boolean);
            const fileRowIndexes = (fields.fileRowIndex || []).map(index =>
                Number.parseInt(index, 10)
            );
            const massRequestReason =
                String(fields.massRequestReason || "").trim() || null;

            if (!massRequestReason) {
                return res.status(400).json({
                    success: false,
                    message: "Mass request reason wajib diisi.",
                });
            }

            const errors = [];
            const filledRowIndexes = [];
            const filesByRow = Array.from({ length: maxRows }, () => 0);
            for (let i = 0; i < fileRowIndexes.length && i < files.length; i += 1) {
                const index = fileRowIndexes[i];
                if (
                    Number.isInteger(index) &&
                    index >= 0 &&
                    index < maxRows
                ) {
                    filesByRow[index] += 1;
                }
            }
            if (rows.length > maxRows) {
                errors.push({
                    rowIndex: -1,
                    fieldKey: "rows",
                    message: `Maksimal ${maxRows} baris per submit.`,
                });
            }
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                const row = rows[rowIndex];
                const isFilled = textFields.some(
                    fieldKey => String(row?.[fieldKey] || "").trim() !== ""
                );
                if (!isFilled) {
                    continue;
                }
                filledRowIndexes.push(rowIndex);

                for (const fieldKey of textFields) {
                    if (
                        fieldKey === "poText" ||
                        fieldKey === "spesifikasiTambahan"
                    ) {
                        continue;
                    }
                    if (String(row?.[fieldKey] || "").trim() === "") {
                        errors.push({
                            rowIndex,
                            fieldKey,
                            message:
                                requiredFieldMessages[fieldKey] ||
                                "Field wajib diisi.",
                        });
                    }
                }

                if (String(row.description || "").length > 40) {
                    errors.push({
                        rowIndex,
                        fieldKey: "description",
                        message: "Material description maksimal 40 karakter.",
                    });
                }

                const attachmentCount = filesByRow[rowIndex] || 0;
                if (attachmentCount < minAttachmentsPerRow) {
                    errors.push({
                        rowIndex,
                        fieldKey: "attachments",
                        message: `Minimal ${minAttachmentsPerRow} attachment per baris.`,
                    });
                } else if (attachmentCount > maxAttachmentsPerRow) {
                    errors.push({
                        rowIndex,
                        fieldKey: "attachments",
                        message: `Maksimal ${maxAttachmentsPerRow} attachment per baris.`,
                    });
                }
            }

            if (filledRowIndexes.length < minRows && errors.length === 0) {
                errors.push({
                    rowIndex: -1,
                    fieldKey: "rows",
                    message: "Minimal 2 baris harus diisi.",
                });
            }

            if (errors.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: "Material request validation failed",
                    errors,
                });
            }

            const attachmentsByRow = Array.from(
                { length: maxRows },
                () => []
            );
            for (let i = 0; i < files.length; i += 1) {
                const file = files[i];
                const rowIndex = Number.parseInt(fileRowIndexes[i], 10);
                if (
                    !Number.isInteger(rowIndex) ||
                    rowIndex < 0 ||
                    rowIndex >= maxRows
                ) {
                    const error = new Error(
                        "Invalid file row mapping. Each file must be linked to a valid row index."
                    );
                    error.statusCode = 400;
                    throw error;
                }

                const originalFilename =
                    file.originalFilename || file.newFilename || "attachment";
                const { extension, safeOriginalName, safeBaseName } =
                    sanitizeUploadName(originalFilename);
                if (!allowedFileExtensions.includes(extension)) {
                    const error = new Error(
                        "Invalid file format. Please upload files with valid extensions: " +
                            allowedFileExtensions.join(", ")
                    );
                    error.statusCode = 400;
                    throw error;
                }

                attachmentsByRow[rowIndex].push({
                    tempPath: file.filepath,
                    originalName: safeOriginalName,
                    newName: `${Date.now()}_${safeBaseName}.${extension}`,
                    mimeType: getMimeType(extension),
                });
            }

            const createdMassRequest = await materialService.createMassRequest({
                rows: rows.filter((_, idx) => filledRowIndexes.includes(idx)),
                attachmentsByRow: attachmentsByRow.filter((_, idx) =>
                    filledRowIndexes.includes(idx)
                ),
                createdBy: userId,
                createdByUsername: req.cookies?.username ?? null,
                massRequestReason,
            });
            return res.status(201).json({
                success: true,
                message: "Mass material request created successfully",
                data: createdMassRequest,
            });
        } catch (error) {
            const statusCode =
                error.statusCode || (error.code === 1016 ? 400 : 500);

            return res.status(statusCode).json({
                success: false,
                message:
                    error.code === 1016
                        ? "File size exceeded. Maximum file size is 5MB"
                        : error.message ||
                          "Failed to create mass material request",
                errors: error.errors || [],
            });
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },


    getSingleRequests: async (req, res) => {
        try {
            const userId = req.cookies.user_id;
            const rows = await materialService.getSingleRequestsByUser(userId);

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch single material requests",
                error: error.message,
            });
        }
    },

    getMassRequests: async (req, res) => {
        try {
            const userId = req.cookies.user_id;
            const rows = await materialService.getMassRequestsByUser(userId);

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch mass material requests",
                error: error.message,
            });
        }
    },

    getSingleRequestById: async (req, res) => {
        try {
            const row = await materialService.getSingleRequestById({
                requestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                data: row,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to fetch single material request"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },


    getMassRequestApprovalInbox: async (req, res) => {
        try {
            const actorUsername = req.cookies?.username;
            const actorUserId = req.cookies?.user_id;

            const rows = await materialService.getMassRequestApprovalInbox(
                actorUserId,
                actorUsername,
                req.query?.scope
            );

            return res.status(200).json({
                success: true,
                message: "Mass request approval inbox fetched successfully",
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch mass request approval inbox",
                error: error.message,
            });
        }
    },

    approveMassRequest: async (req, res) => {
        let tempFilePaths = [];

        try {
            let result;

            if (isMultipartFormRequest(req)) {
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = ATTACHMENT_MAX_FILE_SIZE;

                const [fields, filesResult] = await form.parse(req);
                const files = filesResult.files
                    ? filesResult.files.filter(Boolean)
                    : [];
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);

                result = await materialService.approveMassRequest({
                    massRequestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    remark: fields.remark
                        ? String(fields.remark).trim() || null
                        : null,
                    items: buildMassRequestItemsWithAttachments(fields, files),
                    finalCodeSuffixes: fields.finalCodeSuffixes
                        ? JSON.parse(fields.finalCodeSuffixes)
                        : null,
                });
            } else {
                result = await materialService.approveMassRequest({
                    massRequestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    remark: req.body?.remark ?? null,
                    items: stripAttachmentInstructions(
                        req.body?.items ?? null
                    ),
                    // One running number per item, keyed by item_id, entered one
                    // by one. Required at the Master Data step.
                    finalCodeSuffixes: req.body?.finalCodeSuffixes ?? null,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Mass request approved successfully",
                data: result,
            });
        } catch (error) {
            if (Number.isInteger(error?.statusCode)) {
                const payload = {
                    success: false,
                    message: error.message,
                };

                if (error.code) {
                    payload.code = error.code;
                }

                if (Array.isArray(error.errors) && error.errors.length > 0) {
                    payload.errors = error.errors;
                }

                return res.status(error.statusCode).json(payload);
            }

            return res.status(500).json({
                success: false,
                message: "Failed to approve mass request",
                error: error.message,
            });
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },

    requestMassRequestRework: async (req, res) => {
        let tempFilePaths = [];

        try {
            let result;

            if (isMultipartFormRequest(req)) {
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = ATTACHMENT_MAX_FILE_SIZE;

                const [fields, filesResult] = await form.parse(req);
                const files = filesResult.files
                    ? filesResult.files.filter(Boolean)
                    : [];
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);

                result = await materialService.requestMassRequestRework({
                    massRequestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    reason: fields.reason
                        ? String(fields.reason).trim() || null
                        : null,
                    newApprovers: fields.newApprovers
                        ? JSON.parse(fields.newApprovers)
                        : null,
                    notifyVia: fields.notifyVia
                        ? String(fields.notifyVia).trim() || null
                        : null,
                    emailSubject: fields.emailSubject
                        ? String(fields.emailSubject)
                        : null,
                    emailBody: fields.emailBody
                        ? String(fields.emailBody)
                        : null,
                    items: buildMassRequestItemsWithAttachments(fields, files),
                });
            } else {
                result = await materialService.requestMassRequestRework({
                    massRequestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    reason: req.body?.reason ?? null,
                    // Optional replacement approver chain (ordered user_ids) and
                    // notification channel; the service validates both. Accepts
                    // `newApprovers` (preferred) or the `newApproverIds` alias.
                    // No `reworkToLevel` here — mass rework has no rewind mode.
                    newApprovers:
                        req.body?.newApprovers ?? req.body?.newApproverIds ?? null,
                    notifyVia: req.body?.notifyVia ?? null,
                    // Mail content, editable by Master Data; required (and
                    // validated) by the service only on the EMAIL channel.
                    emailSubject: req.body?.emailSubject ?? null,
                    emailBody: req.body?.emailBody ?? null,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Mass request rework requested successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to request mass request rework"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
                code: error.code,
            };

            if (Array.isArray(error.errors) && error.errors.length > 0) {
                payload.errors = error.errors;
            }

            return res.status(statusCode).json(payload);
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },

    rejectMassRequest: async (req, res) => {
        try {
            const result = await materialService.rejectMassRequestByAdmin({
                massRequestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
                reason: req.body?.reason ?? null,
            });

            return res.status(200).json({
                success: true,
                message: "Mass request rejected successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to reject mass request"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },

    getMassRequestItems: async (req, res) => {
        try {
            const items = await materialService.getMassRequestItems(req.params.id);

            return res.status(200).json({
                success: true,
                data: items,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch mass request items",
                error: error.message,
            });
        }
    },

    // --- Rework e-mail thread (chain replacement, notifyVia = EMAIL) --------
    // Draft reads for the Master Data dialog, thread reads for the request
    // detail. All four are plain reads behind AuthToken.authSession, like the
    // other material request detail routes.

    getSingleRequestReworkEmailTemplate: async (req, res) => {
        try {
            const template =
                await materialService.getSingleRequestReworkEmailTemplate({
                    requestId: req.params.id,
                    // Optional: the approver the dialog has already picked, so
                    // the greeting can name him instead of saying "Approver".
                    approverUserId: req.query.approverUserId,
                });

            return res.status(200).json({
                success: true,
                data: template,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to build single request rework email template"
                        : error.message,
                code: error.code,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },

    getMassRequestReworkEmailTemplate: async (req, res) => {
        try {
            const template =
                await materialService.getMassRequestReworkEmailTemplate({
                    massRequestId: req.params.id,
                    // Optional: the approver the dialog has already picked, so
                    // the greeting can name him instead of saying "Approver".
                    approverUserId: req.query.approverUserId,
                });

            return res.status(200).json({
                success: true,
                data: template,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to build mass request rework email template"
                        : error.message,
                code: error.code,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },

    getSingleRequestReworkEmailThread: async (req, res) => {
        try {
            const rows = await materialService.getReworkEmailThread({
                requestKind: "SINGLE",
                requestId: req.params.id,
            });

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch single request rework email thread",
                error: error.message,
            });
        }
    },

    getMassRequestReworkEmailThread: async (req, res) => {
        try {
            const rows = await materialService.getReworkEmailThread({
                requestKind: "MASS",
                requestId: req.params.id,
            });

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch mass request rework email thread",
                error: error.message,
            });
        }
    },

    getSingleRequestComments: async (req, res) => {
        try {
            const rows = await materialService.getRequestComments({
                requestKind: "SINGLE",
                requestId: req.params.id,
            });

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch single request comments",
                error: error.message,
            });
        }
    },

    getMassRequestComments: async (req, res) => {
        try {
            const rows = await materialService.getRequestComments({
                requestKind: "MASS",
                requestId: req.params.id,
            });

            return res.status(200).json({
                success: true,
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch mass request comments",
                error: error.message,
            });
        }
    },

    // Generic per-user preference store (My Approval's status filter, for now).
    // The key is a path param but never trusted as free text: it is checked
    // against a fixed shape before it reaches a query, same as the value on the
    // write side. The owner is always req.cookies.user_id from the verified
    // session token, never a param or body field — a client cannot read or
    // overwrite another user's preferences by editing the URL.
    getUserPreference: async (req, res) => {
        try {
            const userId = req.cookies?.user_id;
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: "Unauthorized",
                });
            }

            const key = req.params.key;
            if (!isValidUserPreferenceKey(key)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid preference key",
                });
            }

            const value = await materialService.getUserPreference({ userId, key });

            return res.status(200).json({
                success: true,
                data: { key, value },
            });
        } catch (error) {
            // No error detail in the response: a DB error here can carry a
            // table or column name, and this endpoint has no reason to expose
            // its schema to the client.
            console.error("Error fetching user preference:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch user preference",
            });
        }
    },

    setUserPreference: async (req, res) => {
        try {
            const userId = req.cookies?.user_id;
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: "Unauthorized",
                });
            }

            const key = req.params.key;
            if (!isValidUserPreferenceKey(key)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid preference key",
                });
            }

            const value = req.body?.value;
            if (typeof value !== "string" || value.trim() === "" || value.length > MAX_USER_PREFERENCE_VALUE_LENGTH) {
                return res.status(400).json({
                    success: false,
                    message: `value is required and must be a non-empty string of at most ${MAX_USER_PREFERENCE_VALUE_LENGTH} characters`,
                });
            }

            await materialService.setUserPreference({ userId, key, value });

            return res.status(200).json({
                success: true,
                data: { key, value },
            });
        } catch (error) {
            console.error("Error saving user preference:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to save user preference",
            });
        }
    },

    getSingleRequestApprovalInbox: async (req, res) => {
        try {
            const actorUsername = req.cookies?.username;
            const actorUserId = req.cookies?.user_id;

            const rows = await materialService.getSingleRequestApprovalInbox(
                actorUserId,
                actorUsername,
                req.query?.scope
            );

            return res.status(200).json({
                success: true,
                message: "Single request approval inbox fetched successfully",
                data: rows,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch single request approval inbox",
                error: error.message,
            });
        }
    },

    requestSingleRequestRework: async (req, res) => {
        let tempFilePaths = [];

        try {
            let result;

            if (isMultipartFormRequest(req)) {
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = ATTACHMENT_MAX_FILE_SIZE;

                const [fields, filesResult] = await form.parse(req);
                const attachmentInstructions = fields.attachments
                    ? JSON.parse(fields.attachments)
                    : {};
                const files = filesResult.files
                    ? filesResult.files.filter(Boolean)
                    : [];
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);

                result = await materialService.requestSingleRequestRework({
                    requestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    reason: fields.reason
                        ? String(fields.reason).trim() || null
                        : null,
                    reworkToLevel: fields.reworkToLevel
                        ? String(fields.reworkToLevel).trim() || null
                        : null,
                    newApprovers: fields.newApprovers
                        ? JSON.parse(fields.newApprovers)
                        : null,
                    notifyVia: fields.notifyVia
                        ? String(fields.notifyVia).trim() || null
                        : null,
                    emailSubject: fields.emailSubject
                        ? String(fields.emailSubject)
                        : null,
                    emailBody: fields.emailBody
                        ? String(fields.emailBody)
                        : null,
                    attachments: {
                        keepAttachmentIds: parseKeepAttachmentIds(
                            attachmentInstructions.keepAttachmentIds
                        ),
                        newAttachments: files.map(buildUploadedAttachment),
                    },
                });
            } else {
                result = await materialService.requestSingleRequestRework({
                    requestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    reason: req.body?.reason ?? null,
                    // Optional rewind target; the service validates the level.
                    reworkToLevel: req.body?.reworkToLevel ?? null,
                    // Optional replacement approver chain (ordered user_ids) and
                    // notification channel; the service validates both. Accepts
                    // `newApprovers` (preferred) or the `newApproverIds` alias.
                    newApprovers:
                        req.body?.newApprovers ?? req.body?.newApproverIds ?? null,
                    notifyVia: req.body?.notifyVia ?? null,
                    // Mail content, editable by Master Data; required (and
                    // validated) by the service only on the EMAIL channel.
                    emailSubject: req.body?.emailSubject ?? null,
                    emailBody: req.body?.emailBody ?? null,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Single request rework requested successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to request single request rework"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
                code: error.code,
            };

            if (Array.isArray(error.errors) && error.errors.length > 0) {
                payload.errors = error.errors;
            }

            return res.status(statusCode).json(payload);
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },

    // Start a SAP-error resubmit: only an active MDM_MATERIAL user (or ADMIN)
    // may do this. Reopens the Master Data step directly (WAITING, grabber
    // preserved) so the MDM user edits the data in the approval dialog and
    // re-approves; re-approval re-stages the row to Oracle (fresh FLAG='I').
    requestSapErrorRework: async (req, res) => {
        try {
            const result = await materialService.requestSapErrorRework({
                requestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                message: "Request sent back to Master Data for resubmission",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to resubmit single request to SAP"
                        : error.message,
                code: error.code,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },

    // Start a SAP-error resubmit for a MASS batch: request-level like every
    // other mass approval action, so one errored item reopens the Master Data
    // step for the whole batch. Same actor rule as the single one.
    requestMassSapErrorRework: async (req, res) => {
        try {
            const result = await materialService.requestMassSapErrorRework({
                massRequestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                message:
                    "Mass request sent back to Master Data for resubmission",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            return res.status(statusCode).json({
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to resubmit mass request to SAP"
                        : error.message,
                code: error.code,
                error: statusCode === 500 ? error.message : undefined,
            });
        }
    },

    saveSingleRequestRework: async (req, res) => {
        let tempFilePaths = [];

        try {
            const allowedFileExtensions = [
                "pdf",
                "doc",
                "docx",
                "png",
                "jpg",
                "jpeg",
            ];
            const maxAttachments = 3;
            let editedRequest = req.body?.editedRequest ?? null;
            let comment = req.body?.comment ?? null;
            let attachments = null;
            const isMultipartRequest = String(
                req.headers?.["content-type"] || ""
            ).includes("multipart/form-data");

            if (
                !isMultipartRequest &&
                req.body?.attachments != null
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Attachment updates for single request rework require multipart/form-data",
                });
            }

            if (isMultipartRequest) {
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = 5 * 1024 * 1024;

                const [fields, items] = await form.parse(req);
                const materialGroupCode = String(
                    fields.materialGroupCode || ""
                ).trim();
                comment = fields.comment ?? null;
                let materialSubGroupId = Number.parseInt(fields.subgroup, 10);
                const requestFields = JSON.parse(fields.requestFields);
                const templateValues = JSON.parse(fields.templateValues);
                const attachmentInstructions = JSON.parse(fields.attachments);
                const files = items.files ? items.files.filter(Boolean) : [];
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);

                if (!materialGroupCode) {
                    return res.status(400).json({
                        success: false,
                        message: "Material group is required",
                        errors: [
                            {
                                fieldKey: "material_group",
                                message: "Material group is required",
                            },
                        ],
                    });
                }

                if (files.length > maxAttachments) {
                    return res.status(400).json({
                        success: false,
                        message: `Maximum ${maxAttachments} attachments are allowed`,
                    });
                }

                const materialGroup =
                    await materialService.getMaterialGroupByCode(materialGroupCode);
                if (!materialGroup) {
                    return res.status(404).json({
                        success: false,
                        message: "Material group not found",
                        errors: [
                            {
                                fieldKey: "material_group",
                                message: "Material group not found",
                            },
                        ],
                    });
                }

                // Sub material group is optional — MDM can fill it in later via
                // the approval-edit patch. Only validated when picked.
                if (Number.isInteger(materialSubGroupId)) {
                    const subgroup =
                        await materialService.getSubGroupById(materialSubGroupId);
                    if (!subgroup || subgroup.deleted_at) {
                        return res.status(404).json({
                            success: false,
                            message: "Sub material group not found",
                            errors: [
                                {
                                    fieldKey: "material_sub_group_id",
                                    message: "Sub material group not found",
                                },
                            ],
                        });
                    }

                    if (
                        Number(subgroup.item_group_id) !==
                        Number(materialGroup.id)
                    ) {
                        return res.status(400).json({
                            success: false,
                            message:
                                "Sub material group does not belong to the selected material group",
                            errors: [
                                {
                                    fieldKey: "material_sub_group_id",
                                    message:
                                        "Sub material group does not belong to the selected material group",
                                },
                            ],
                        });
                    }
                } else {
                    materialSubGroupId = null;
                }

                try {
                    const templateConfig =
                        await MaterialTemplate.getMaterialTemplateByGroupCode(
                            materialGroupCode
                        );
                    if (
                        templateConfig?.template &&
                        Object.keys(templateValues).length > 0
                    ) {
                        const generated =
                            buildMaterialDescriptionAndLongText(
                                templateValues,
                                templateConfig.template
                            );
                        requestFields.material_description =
                            generated.material_description ||
                            requestFields.material_description;
                        requestFields.long_text_1 =
                            generated.long_text_1 ||
                            requestFields.long_text_1;
                        requestFields.long_text_2 =
                            generated.long_text_2 ||
                            requestFields.long_text_2;
                        requestFields.long_text_3 =
                            generated.long_text_3 ||
                            requestFields.long_text_3;
                    }
                } catch (_) {}

                editedRequest = {
                    material_group_id: materialGroup?.id ?? null,
                    material_group_code: materialGroup?.code ?? null,
                    material_sub_group_id: materialSubGroupId,
                    plant_code: requestFields.plant ?? null,
                    sloc_code: requestFields.storage_location ?? null,
                    material_description:
                        requestFields.material_description ?? null,
                    base_uom: requestFields.base_unit_of_measure ?? null,
                    long_text_1: requestFields.long_text_1 ?? null,
                    long_text_2: requestFields.long_text_2 ?? null,
                    long_text_3: requestFields.long_text_3 ?? null,
                    template_payload: {
                        requestFields,
                        templateValues,
                    },
                };
                attachments = {
                    keepAttachmentIds: attachmentInstructions.keepAttachmentIds
                        .map(id => Number.parseInt(id, 10))
                        .filter(Number.isInteger),
                    newAttachments: files.map(file => {
                        const originalFilename =
                            file.originalFilename || file.newFilename;
                        const { extension, safeOriginalName, safeBaseName } =
                            sanitizeUploadName(originalFilename);

                        if (!allowedFileExtensions.includes(extension)) {
                            const error = new Error(
                                "Invalid file format. Please upload files with valid extensions: " +
                                    allowedFileExtensions.join(", ")
                            );
                            error.statusCode = 400;
                            throw error;
                        }

                        return {
                            tempPath: file.filepath,
                            originalName: safeOriginalName,
                            newName: `${Date.now()}_${safeBaseName}.${extension}`,
                            extension,
                            mimeType: getMimeType(extension),
                        };
                    }),
                };
            }

            const result = await materialService.saveSingleRequestRework({
                requestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
                editedRequest,
                comment,
                attachments,
            });

            return res.status(200).json({
                success: true,
                message: "Single request rework saved successfully",
                data: result,
            });
        } catch (error) {
            if (Number.isInteger(error?.statusCode)) {
                const payload = {
                    success: false,
                    message: error.message,
                };

                if (error.code) {
                    payload.code = error.code;
                }

                if (Array.isArray(error.errors) && error.errors.length > 0) {
                    payload.errors = error.errors;
                }

                return res.status(error.statusCode).json(payload);
            }

            return res.status(500).json({
                success: false,
                message: "Failed to save single request rework",
                error: error.message,
            });
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },

    rejectSingleRequest: async (req, res) => {
        try {
            const result = await materialService.rejectSingleRequestByAdmin({
                requestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
                reason: req.body?.reason ?? null,
            });

            return res.status(200).json({
                success: true,
                message: "Single request rejected successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to reject single request"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
                code: error.code,
            };

            if (Array.isArray(error.errors) && error.errors.length > 0) {
                payload.errors = error.errors;
            }

            return res.status(statusCode).json(payload);
        }
    },

    approveSingleRequest: async (req, res) => {
        let tempFilePaths = [];

        try {
            let result;

            if (isMultipartFormRequest(req)) {
                // Multipart only when the reviewer actually staged an
                // attachment change; a plain JSON approve (no files touched)
                // keeps using the branch below unchanged.
                const form = new formidable.IncomingForm();
                form.options.multiples = true;
                form.options.maxFileSize = ATTACHMENT_MAX_FILE_SIZE;

                const [fields, filesResult] = await form.parse(req);
                const attachmentInstructions = fields.attachments
                    ? JSON.parse(fields.attachments)
                    : {};
                const files = filesResult.files
                    ? filesResult.files.filter(Boolean)
                    : [];
                tempFilePaths = files.map(file => file.filepath).filter(Boolean);

                result = await materialService.approveSingleRequestByAdmin({
                    requestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    remark: fields.remark
                        ? String(fields.remark).trim() || null
                        : null,
                    editedRequest: fields.editedRequest
                        ? JSON.parse(fields.editedRequest)
                        : null,
                    finalCodeSuffix: fields.finalCodeSuffix
                        ? String(fields.finalCodeSuffix).trim() || null
                        : null,
                    attachments: {
                        keepAttachmentIds: parseKeepAttachmentIds(
                            attachmentInstructions.keepAttachmentIds
                        ),
                        newAttachments: files.map(buildUploadedAttachment),
                    },
                });
            } else {
                result = await materialService.approveSingleRequestByAdmin({
                    requestId: req.params.id,
                    actorUserId: req.cookies.user_id,
                    actorUsername: req.cookies.username,
                    remark: req.body?.remark ?? null,
                    editedRequest: req.body?.editedRequest ?? null,
                    finalCodeSuffix: req.body?.finalCodeSuffix ?? null,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Single request approved successfully",
                data: result,
            });
        } catch (error) {
            if (Number.isInteger(error?.statusCode)) {
                const payload = {
                    success: false,
                    message: error.message,
                };

                if (error.code) {
                    payload.code = error.code;
                }

                if (Array.isArray(error.errors) && error.errors.length > 0) {
                    payload.errors = error.errors;
                }

                return res.status(error.statusCode).json(payload);
            }

            return res.status(500).json({
                success: false,
                message: "Failed to approve single request",
                error: error.message,
            });
        } finally {
            for (const filepath of tempFilePaths) {
                if (!filepath) {
                    continue;
                }

                try {
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                } catch (error) {
                    console.error("Failed to clean up temp upload:", error);
                }
            }
        }
    },

    assignSingleRequestApprovers: async (req, res) => {
        try {
            if (!isAdminMaterialApprover(req.cookies?.username)) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Forbidden: single request approver assignment is only available for ADMIN",
                });
            }

            const assignmentPayload = {
                requestId: req.params.id,
                actorUsername: req.cookies.username,
            };

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body || {},
                    "approval1UserId"
                )
            ) {
                assignmentPayload.approval1UserId = req.body.approval1UserId;
            }

            if (
                Object.prototype.hasOwnProperty.call(
                    req.body || {},
                    "approval2UserId"
                )
            ) {
                assignmentPayload.approval2UserId = req.body.approval2UserId;
            }

            const result =
                await materialService.assignSingleRequestApproversByAdmin(
                    assignmentPayload
                );

            return res.status(200).json({
                success: true,
                message: "Single request approvers assigned successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const message =
                statusCode === 500
                    ? "Failed to assign single request approvers"
                    : error.message;

            return res.status(statusCode).json({
                success: false,
                message,
            });
        }
    },

    getSingleRequestApproverMasters: async (req, res) => {
        try {
            if (!isAdminMaterialApprover(req.cookies?.username)) {
                return res.status(403).json({ success: false, message: "Forbidden" });
            }

            // Optional pagination + search (omit page/limit to get all). Aliases: pageSize, q.
            const { page, limit, pageSize, search, q } = req.query || {};
            const result = await materialService.getAdministratorApproverMasters({
                page,
                limit: limit ?? pageSize,
                search: search ?? q,
            });
            return res.status(200).json({ success: true, ...result });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch requester approver masters",
                error: error.message,
            });
        }
    },

    assignSingleRequestApproverMaster: async (req, res) => {
        try {
            if (!isAdminMaterialApprover(req.cookies?.username)) {
                return res.status(403).json({ success: false, message: "Forbidden" });
            }

            // Whole-list save: ordered array of manual approver user_ids.
            // Accept `manualApprovers` (preferred) or `manualApproverIds` alias.
            const manualApproverIds =
                req.body?.manualApprovers ?? req.body?.manualApproverIds;

            const result = await materialService.saveRequesterApproverChain({
                requesterUserId: req.params.requesterUserId,
                manualApproverIds,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                message: "Requester approver chain saved successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    error.message || "Failed to save requester approver chain",
            };

            if (error.code) {
                payload.code = error.code;
            }

            if (Array.isArray(error.errors) && error.errors.length > 0) {
                payload.errors = error.errors;
            }

            return res.status(statusCode).json(payload);
        }
    },

    // MDM grab: an active MDM_MATERIAL user atomically claims the open
    // Master Data (final) step of a single request.
    claimSingleRequestMdmStep: async (req, res) => {
        try {
            const result = await materialService.claimSingleRequestMdmStepByUser({
                requestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                message: "Master Data step claimed successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to claim Master Data step"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
                code: error.code,
            };

            return res.status(statusCode).json(payload);
        }
    },

    // MDM grab for a mass request: claims the open Master Data step across
    // all items of the batch atomically (single winner).
    claimMassRequestMdmStep: async (req, res) => {
        try {
            const result = await materialService.claimMassRequestMdmStepByUser({
                massRequestId: req.params.id,
                actorUserId: req.cookies.user_id,
                actorUsername: req.cookies.username,
            });

            return res.status(200).json({
                success: true,
                message: "Master Data step claimed successfully",
                data: result,
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const payload = {
                success: false,
                message:
                    statusCode === 500
                        ? "Failed to claim Master Data step"
                        : error.message,
                error: statusCode === 500 ? error.message : undefined,
                code: error.code,
            };

            return res.status(statusCode).json(payload);
        }
    },

    searchMaterialTemplateSuggestions: async (req, res) => {
        try {
            const { q = "", materialGroupCode = null, limit = 10 } = req.query;
            const suggestions =
                await MaterialTemplate.searchMaterialTemplateSuggestions({
                    query: q,
                    materialGroupCode,
                    limit,
                });

            return res.status(200).json({
                success: true,
                message: "Material suggestions fetched successfully",
                data: suggestions,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to fetch material suggestions",
                error: error.message,
            });
        }
    },

    getSearchSuggestions: async (req, res) => {
        try {
            const { q = "", materialGroupCode = null, limit = 10 } = req.query;
            const suggestions = await Material.getSearchSuggestions({
                query: q,
                materialGroupCode,
                limit,
            });

            return res.status(200).json({
                success: true,
                message: "Material suggestions fetched successfully",
                data: suggestions,
            });
        } catch (error) {
            console.error("Error in getSearchSuggestions:", error);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch material suggestions",
                error: error.message,
            });
        }
    },

    // Export materials to Excel (filtered by group/subgroup or search query)
    exportMaterialsToExcel: async (req, res) => {
        try {
            const groupId = req.query.groupId || null;
            const subGroupId = req.query.subGroupId || null;
            const searchTerm = req.query.q || null;
            const { groupCode, subGroupCode } =
                await Material.resolveMaterialExportFilterCodes(
                    groupId,
                    subGroupId,
                    searchTerm
                );

            // Debug logging
            console.log(
                "[ExportExcel] groupId:",
                groupId,
                "subGroupId:",
                subGroupId,
                "searchTerm:",
                searchTerm,
                "groupCode:",
                groupCode,
                "subGroupCode:",
                subGroupCode
            );

            // `q` is user input that ends up in a response header, so the name is
            // held to a conservative character set. Every active filter is kept:
            // the search term previously overwrote the group, so two exports of
            // different data could land under the same filename.
            const safeForFilename = value =>
                String(value)
                    .trim()
                    .replace(/[^A-Za-z0-9._-]+/g, "_")
                    .replace(/^_+|_+$/g, "")
                    .slice(0, 60);

            const nameParts = ["materials"];
            if (searchTerm && searchTerm.trim() !== "") {
                const safeTerm = safeForFilename(searchTerm);
                if (safeTerm) nameParts.push(`search_${safeTerm}`);
            }
            if (groupCode) nameParts.push(`group_${safeForFilename(groupCode)}`);
            if (subGroupCode)
                nameParts.push(`subgroup_${safeForFilename(subGroupCode)}`);
            const filename = `${nameParts.join("_")}.xlsx`;

            console.log("[ExportExcel] Final filename:", filename);

            res.setHeader(
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            res.setHeader(
                "Content-Disposition",
                `attachment; filename=${filename}`
            );
            // No Content-Length: the workbook is written to the response as it
            // is built, so its size is not known when the headers go out.
            await Material.streamMaterialsToExcel(
                res,
                groupId,
                subGroupId,
                searchTerm
            );
        } catch (error) {
            console.error("Materials Excel export error:", error);
            if (res.headersSent) {
                // Part of the workbook is already on the wire, so there is no
                // way back to a JSON error. Destroying the response fails the
                // transfer instead of handing the client a truncated file that
                // looks like a complete one.
                res.destroy();
                return;
            }
            res.status(500).json({
                success: false,
                message: "Failed to export materials to Excel",
                error: error.message,
            });
        }
    },

    // Soft delete a material (set dffromclient = true)
    deleteMaterial: async (req, res) => {
        try {
            const { materialId } = req.params;
            // Validation: check if material exists and is not already soft deleted
            const material = await Material.getMaterialById(materialId);
            if (!material) {
                throw new Error("Material not found");
            }
            if (material.dfFromClient) {
                throw new Error("Material is already deleted");
            }
            const result = await Material.deleteMaterial(materialId);
            res.status(200).json({
                success: true,
                message: "Material soft deleted successfully",
                data: result,
            });
        } catch (error) {
            let statusCode = 500;
            let message = "Failed to soft delete material";
            if (error.message === "Material not found") {
                statusCode = 404;
                message = error.message;
            } else if (error.message === "Material is already deleted") {
                statusCode = 400;
                message = error.message;
            }
            res.status(statusCode).json({
                success: false,
                message,
                error: error.message,
            });
        }
    },

    getInitialScreenData: async (req, res) => {
        try {
            const [locations, types] = await Promise.all([
                materialService.getLocationAndPlant(),
                materialService.getMaterialTypes(),
            ]);

            res.status(200).json({
                success: true,
                data: { locations, types },
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    },

    saveMassRequestRework: async (req, res) => {
        try {
            const result = await materialService.saveMassRequestRework({
                massRequestId: req.params.id,
                actorUserId: req.cookies.user_id,
                items: req.body?.items ?? null,
                comment: req.body?.comment ?? null,
            });

            return res.status(200).json({
                success: true,
                message: "Mass request rework saved successfully",
                data: result,
            });
        } catch (error) {
            if (Number.isInteger(error?.statusCode)) {
                return res.status(error.statusCode).json({
                    success: false,
                    message: error.message,
                });
            }
            return res.status(500).json({
                success: false,
                message: "Failed to save mass request rework",
                error: error.message,
            });
        }
    },

    getUomMaster: async (req, res) => {
        try {
            const uomList = await materialService.getUomMaster();
            res.status(200).json({ success: true, data: uomList });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    },

    getPlantMaster: async (req, res) => {
        try {
            const plantList = await materialService.getPlantMaster();
            res.status(200).json({ success: true, data: plantList });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    },

    getStorageLocationMaster: async (req, res) => {
        try {
            const slocList = await materialService.getStorageLocationMaster();
            res.status(200).json({ success: true, data: slocList });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    },
};

module.exports = MaterialController;
