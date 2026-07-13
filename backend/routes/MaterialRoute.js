const express = require("express");
const router = express.Router();
const MaterialController = require("../controllers/MaterialController");
const AuthToken = require("../middleware/tokenmanager");

// Get all material groups
router.get("/groups", MaterialController.getMaterialGroups);

// Get initial screen data (Plant, Sloc, Material Type)
router.get("/initial-screen-data", MaterialController.getInitialScreenData);

// Get all material groups for dropdown (no pagination)
router.get("/groups/dropdown", MaterialController.getAllMaterialGroups);

// Get attachments for materials by array of codes
router.post("/by-codes", MaterialController.getAttachmentsByCodes);

// Get all subgroups for a group for dropdown (no pagination)
router.get(
    "/subgroups/:groupId/dropdown",
    MaterialController.getAllSubgroupsByGroup
);

// CRUD operations for material groups
router.post(
    "/groups",
    AuthToken.authSession,
    MaterialController.createMaterialGroup
);
router.put(
    "/groups/:groupId",
    AuthToken.authSession,
    MaterialController.updateMaterialGroup
);
router.delete(
    "/groups/:groupId",
    AuthToken.authSession,
    MaterialController.deleteMaterialGroup
);

// Get subgroups by group ID
router.get(
    "/groups/:groupId/subgroups",
    MaterialController.getMaterialSubGroups
);

// CRUD operations for material subgroups
router.post(
    "/subgroups",
    AuthToken.authSession,
    MaterialController.createMaterialSubGroup
);
router.put(
    "/subgroups/:subGroupId",
    AuthToken.authSession,
    MaterialController.updateMaterialSubGroup
);
router.delete(
    "/subgroups/:subGroupId",
    AuthToken.authSession,
    MaterialController.deleteMaterialSubGroup
);

// Excel import/export routes for groups
router.post(
    "/groups/import",
    AuthToken.authSession,
    MaterialController.importOnlyGroupsFromExcel
);
router.get(
    "/groups/export/only",
    AuthToken.authSession,
    MaterialController.exportOnlyGroupsToExcel
);

// Excel import/export routes for subgroups
router.post(
    "/subgroups/import",
    AuthToken.authSession,
    MaterialController.importOnlySubgroupsFromExcel
);
router.get(
    "/subgroups/export/:groupId",
    AuthToken.authSession,
    MaterialController.exportOnlySubgroupsToExcel
);

// Get materials by group ID
router.get(
    "/groups/:groupId/materials",
    MaterialController.getMaterialsByGroup
);

// Get materials by subgroup ID
router.get(
    "/subgroups/:subGroupId/materials",
    MaterialController.getMaterialsBySubGroup
);

// Search materials (query parameter: ?q=searchTerm)
router.get("/search", MaterialController.searchMaterials);

// Get search suggestions (query parameter: ?q=searchTerm)
router.get("/suggestions", MaterialController.getSearchSuggestions);

// Search all materials (including deleted)
router.get("/search/all", MaterialController.searchAllMaterials);

// Get attachments by material ID
router.get(
    "/:materialId/attachments",
    MaterialController.getMaterialAttachments
);

// Upload attachment for a material
router.post(
    "/:materialId/attachments",
    AuthToken.authSession,
    MaterialController.uploadAttachment
);

// Delete attachment
router.delete(
    "/attachments/:attachmentId",
    AuthToken.authSession,
    MaterialController.deleteAttachment
);

// Update material aliases
router.put(
    "/:materialId/aliases",
    AuthToken.authSession,
    MaterialController.updateAliases
);

// Serve attachment file (catch-all so nested paths like
// `attachments/single-request/<date>/<id>/<file>` reach the controller intact).
// Express 4 path-to-regexp: (*) captures everything including nested path segments.
router.get("/file(*)", MaterialController.serveFile);

// SAP data synchronization endpoint

// Single material request endpoints
router.get(
    "/requests/single/active-check",
    AuthToken.authSession,
    MaterialController.checkActiveSingleRequest
);
router.post(
    "/requests/single",
    AuthToken.authSession,
    MaterialController.createSingleRequest
);
router.post(
    "/requests/mass",
    AuthToken.authSession,
    MaterialController.createMassRequest
);
router.get(
    "/requests/mass",
    AuthToken.authSession,
    MaterialController.getMassRequests
);
router.get(
    "/requests/single",
    AuthToken.authSession,
    MaterialController.getSingleRequests
);
router.get(
    "/requests/single/approval-inbox",
    AuthToken.authSession,
    MaterialController.getSingleRequestApprovalInbox
);
router.get(
    "/requests/mass/approval-inbox",
    AuthToken.authSession,
    MaterialController.getMassRequestApprovalInbox
);
router.post(
    "/requests/mass/:id/approve",
    AuthToken.authSession,
    MaterialController.approveMassRequest
);
router.post(
    "/requests/mass/:id/rework",
    AuthToken.authSession,
    MaterialController.requestMassRequestRework
);
router.post(
    "/requests/mass/:id/reject",
    AuthToken.authSession,
    MaterialController.rejectMassRequest
);
router.get(
    "/requests/mass/:id/items",
    AuthToken.authSession,
    MaterialController.getMassRequestItems
);
router.get(
    "/requests/single/approver-masters",
    AuthToken.authSession,
    MaterialController.getSingleRequestApproverMasters
);
router.get(
    "/requests/single/:id",
    AuthToken.authSession,
    MaterialController.getSingleRequestById
);
// Whole-list save of a requester's ordered manual approver chain.
router.put(
    "/requests/single/approver-masters/:requesterUserId",
    AuthToken.authSession,
    MaterialController.assignSingleRequestApproverMaster
);
// PATCH alias kept temporarily for backward compatibility during cutover.
router.patch(
    "/requests/single/approver-masters/:requesterUserId",
    AuthToken.authSession,
    MaterialController.assignSingleRequestApproverMaster
);
router.patch(
    "/requests/single/:id/assign-approvers",
    AuthToken.authSession,
    MaterialController.assignSingleRequestApprovers
);
// MDM grab: claim the open Master Data (final) step.
router.post(
    "/requests/single/:id/claim-mdm",
    AuthToken.authSession,
    MaterialController.claimSingleRequestMdmStep
);
router.post(
    "/requests/mass/:id/claim-mdm",
    AuthToken.authSession,
    MaterialController.claimMassRequestMdmStep
);
router.post(
    "/requests/single/:id/approve",
    AuthToken.authSession,
    MaterialController.approveSingleRequest
);
router.post(
    "/requests/single/:id/rework",
    AuthToken.authSession,
    MaterialController.requestSingleRequestRework
);
router.post(
    "/requests/single/:id/reject",
    AuthToken.authSession,
    MaterialController.rejectSingleRequest
);
router.put(
    "/requests/single/:id/rework",
    AuthToken.authSession,
    MaterialController.saveSingleRequestRework
);
router.post(
    "/requests/single/:id/sap-resubmit",
    AuthToken.authSession,
    MaterialController.requestSapErrorRework
);
router.put(
    "/requests/mass/:id/rework",
    AuthToken.authSession,
    MaterialController.saveMassRequestRework
);


// Material template endpoints
router.get("/templates", MaterialController.getMaterialTemplates);
router.get(
    "/material-suggestions",
    MaterialController.searchMaterialTemplateSuggestions
);
router.post(
    "/template-validations",
    MaterialController.validateMaterialTemplate
);
router.post(
    "/groups/:materialGroupCode/template-description-previews",
    MaterialController.previewMaterialTemplateDescription
);
router.get(
    "/groups/:materialGroupCode/form-schema",
    MaterialController.getMaterialFormSchemaByGroup
);
router.get(
    "/groups/:materialGroupCode/template",
    MaterialController.getMaterialTemplateByGroup
);

// Export materials to Excel (filtered by group/subgroup)
router.get(
    "/export/materials",
    AuthToken.authSession,
    MaterialController.exportMaterialsToExcel
);

// Get UoM master list for dropdown
router.get("/uom", AuthToken.authSession, MaterialController.getUomMaster);

// Get plant master list for dropdown
router.get("/plant", AuthToken.authSession, MaterialController.getPlantMaster);

// Get storage location master list for dropdown
router.get(
    "/storage-location",
    AuthToken.authSession,
    MaterialController.getStorageLocationMaster
);

// Get material by ID with full details and attachments
router.get("/:materialId", MaterialController.getMaterialById);

// Soft delete a material
router.delete(
    "/:materialId",
    AuthToken.authSession,
    MaterialController.deleteMaterial
);

module.exports = router;
