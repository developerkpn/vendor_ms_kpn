const db = require("../config/connection.js");
const Crud = require("../helper/crudquery.js");
const fs = require("fs");
const path = require("path");
const DBClientWrapper = require("../helper/DBClientWrapper.js");
const getMimeType = require("../helper/mimetype.js");
const xlsx = require("xlsx");
const axios = require("axios");
const pool = require("../config/connection");
const saveToDatabase = require("../helper/sap_seeding");
const TRANS = require("../config/transaction.js");


function parseWildcardSearch(term) {
    if (!term || !term.includes('*')) return null;
    const segments = term.split('*').map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length === 0) return null;
    return { isWildcard: true, segments };
}

const Material = {
    // Create a new material group
    createMaterialGroup: async groupData => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name } = groupData;

                // Check if code already exists
                const existingCode = await client.query(
                    "SELECT id FROM mat_item_group WHERE code = $1",
                    [code]
                );

                if (existingCode.rows.length > 0) {
                    throw new Error("Group code already exists");
                }

                const now = new Date();
                const result = await client.query(
                    `INSERT INTO mat_item_group (code, name, created_at, updated_at)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id, code, name`,
                    [code, name, now, now]
                );

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error creating material group:", error);
            throw error;
        }
    },

    // Update material group
    updateMaterialGroup: async (groupId, groupData) => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name } = groupData;

                // Check if code already exists for another group
                if (code) {
                    const existingCode = await client.query(
                        "SELECT id FROM mat_item_group WHERE code = $1 AND id != $2",
                        [code, groupId]
                    );

                    if (existingCode.rows.length > 0) {
                        throw new Error("Group code already exists");
                    }
                }

                const now = new Date();
                let query = "UPDATE mat_item_group SET updated_at = $1";
                const params = [now];
                let paramIndex = 2;

                if (code) {
                    query += `, code = $${paramIndex}`;
                    params.push(code);
                    paramIndex++;
                }

                if (name) {
                    query += `, name = $${paramIndex}`;
                    params.push(name);
                    paramIndex++;
                }

                query += ` WHERE id = $${paramIndex} RETURNING id, code, name`;
                params.push(groupId);

                const result = await client.query(query, params);

                if (result.rows.length === 0) {
                    throw new Error("Group not found");
                }

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error updating material group:", error);
            throw error;
        }
    },

    // Delete material group (soft delete with cascade, no validation)
    deleteMaterialGroup: async (groupId, deletedBy) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");
                const now = new Date();
                // 1. Soft delete the group
                await client.query(
                    "UPDATE mat_item_group SET deleted_at = $1, deleted_by = $2 WHERE id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, groupId]
                );
                // 2. Soft delete all subgroups under this group
                await client.query(
                    "UPDATE mat_item_sub_group SET deleted_at = $1, deleted_by = $2 WHERE item_group_id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, groupId]
                );
                // 3. Get all subgroups under this group (including already soft deleted)
                const subgroupsRes = await client.query(
                    "SELECT id FROM mat_item_sub_group WHERE item_group_id = $1",
                    [groupId]
                );
                const subGroupIds = subgroupsRes.rows.map(row => row.id);
                if (subGroupIds.length > 0) {
                    // 4. Soft delete all materials under these subgroups
                    await client.query(
                        `UPDATE mat_sap_data SET dffromclient = true WHERE material_sub_group_id = ANY($1) AND (dffromclient IS NULL OR dffromclient = false)`,
                        [subGroupIds]
                    );
                }
                await client.query("COMMIT");
                return { id: groupId, deleted: true };
            });
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.error("Error soft deleting material group:", error);
            throw error;
        }
    },

    // Get all material groups
    getMaterialGroups: async (
        page,
        pageSize,
        searchQuery = "",
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const searchPattern = searchQuery ? `%${searchQuery}%` : null;

                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "mig.code",
                    name: "mig.name",
                    id: "mig.id",
                    created_at: "mig.created_at",
                    updated_at: "mig.updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "mig.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                // Only non-deleted groups
                const countQuery = searchPattern
                    ? await client.query(
                          `SELECT COUNT(*) as total FROM mat_item_group WHERE deleted_at IS NULL AND (code ILIKE $1 OR name ILIKE $1)`,
                          [searchPattern]
                      )
                    : await client.query(
                          `SELECT COUNT(*) as total FROM mat_item_group WHERE deleted_at IS NULL`
                      );
                const totalCount = parseInt(countQuery.rows[0].total);
                const queryText = searchPattern
                    ? `
                        SELECT
                            mig.id,
                            mig.code,
                            mig.name,
                            (SELECT COUNT(*) FROM mat_item_sub_group WHERE item_group_id = mig.id AND deleted_at IS NULL) as subgroups_count,
                            (
                                SELECT COUNT(*)
                                FROM mat_sap_data m
                                JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                                WHERE mis.item_group_id = mig.id AND mis.deleted_at IS NULL AND (m.dffromclient IS NULL OR m.dffromclient = false)
                            ) as materials_count
                        FROM mat_item_group mig
                        WHERE mig.deleted_at IS NULL AND (mig.code ILIKE $3 OR mig.name ILIKE $3)
                        ORDER BY ${sortClause}
                        LIMIT $1 OFFSET $2
                    `
                    : `
                        SELECT
                            mig.id,
                            mig.code,
                            mig.name,
                            (SELECT COUNT(*) FROM mat_item_sub_group WHERE item_group_id = mig.id AND deleted_at IS NULL) as subgroups_count,
                            (
                                SELECT COUNT(*)
                                FROM mat_sap_data m
                                JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                                WHERE mis.item_group_id = mig.id AND mis.deleted_at IS NULL AND (m.dffromclient IS NULL OR m.dffromclient = false)
                            ) as materials_count
                        FROM mat_item_group mig
                        WHERE mig.deleted_at IS NULL
                        ORDER BY ${sortClause}
                        LIMIT $1 OFFSET $2
                    `;
                const queryParams = searchPattern
                    ? [pageSize, offset, searchPattern]
                    : [pageSize, offset];
                const result = await client.query(queryText, queryParams);
                return {
                    data: result.rows,
                    pagination: {
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get all material groups for dropdown (no pagination)
    getAllMaterialGroups: async (sort = "code", order = "asc") => {
        try {
            return await DBClientWrapper(async client => {
                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "code",
                    name: "name",
                    id: "id",
                    created_at: "created_at",
                    updated_at: "updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";

                const result = await client.query(`
                    SELECT
                        id,
                        code,
                        name
                    FROM mat_item_group
                    WHERE deleted_at IS NULL
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                `);
                return result.rows;
            });
        } catch (error) {
            console.error("Error getting all material groups:", error);
            throw error;
        }
    },

    // Get all subgroups for a group for dropdown (no pagination)
    getAllSubgroupsByGroup: async (groupId, sort = "code", order = "asc") => {
        try {
            return await DBClientWrapper(async client => {
                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "code",
                    name: "name",
                    id: "id",
                    created_at: "created_at",
                    updated_at: "updated_at",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const result = await client.query(
                    `
                    SELECT
                        id,
                        code,
                        name,
                        item_group_id
                    FROM mat_item_sub_group
                    WHERE item_group_id = $1 AND deleted_at IS NULL
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                `,
                    [groupId]
                );
                return result.rows;
            });
        } catch (error) {
            console.error("Error getting all subgroups for group:", error);
            throw error;
        }
    },

    // Create a new material subgroup
    createMaterialSubGroup: async subGroupData => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name, item_group_id } = subGroupData;

                // Check if group exists
                const groupCheck = await client.query(
                    "SELECT id FROM mat_item_group WHERE id = $1",
                    [item_group_id]
                );

                if (groupCheck.rows.length === 0) {
                    throw new Error("Parent group not found");
                }

                // Check if code already exists within this group
                const existingCode = await client.query(
                    "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2",
                    [code, item_group_id]
                );

                if (existingCode.rows.length > 0) {
                    throw new Error(
                        "Subgroup code already exists within this group"
                    );
                }

                const now = new Date();
                const result = await client.query(
                    `INSERT INTO mat_item_sub_group (code, name, item_group_id, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id, code, name, item_group_id`,
                    [code, name, item_group_id, now, now]
                );

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error creating material subgroup:", error);
            throw error;
        }
    },

    // Update material subgroup
    updateMaterialSubGroup: async (subGroupId, subGroupData) => {
        try {
            return await DBClientWrapper(async client => {
                const { code, name, item_group_id } = subGroupData;

                // If changing group, check if new group exists
                if (item_group_id) {
                    const groupCheck = await client.query(
                        "SELECT id FROM mat_item_group WHERE id = $1",
                        [item_group_id]
                    );

                    if (groupCheck.rows.length === 0) {
                        throw new Error("Parent group not found");
                    }
                }

                // Get current subgroup data
                const currentSubgroup = await client.query(
                    "SELECT item_group_id FROM mat_item_sub_group WHERE id = $1",
                    [subGroupId]
                );

                if (currentSubgroup.rows.length === 0) {
                    throw new Error("Subgroup not found");
                }

                const currentGroupId =
                    item_group_id || currentSubgroup.rows[0].item_group_id;

                // Check if code already exists within the group for another subgroup
                if (code) {
                    const existingCode = await client.query(
                        "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2 AND id != $3",
                        [code, currentGroupId, subGroupId]
                    );

                    if (existingCode.rows.length > 0) {
                        throw new Error(
                            "Subgroup code already exists within this group"
                        );
                    }
                }

                const now = new Date();
                let query = "UPDATE mat_item_sub_group SET updated_at = $1";
                const params = [now];
                let paramIndex = 2;

                if (code) {
                    query += `, code = $${paramIndex}`;
                    params.push(code);
                    paramIndex++;
                }

                if (name) {
                    query += `, name = $${paramIndex}`;
                    params.push(name);
                    paramIndex++;
                }

                if (item_group_id) {
                    query += `, item_group_id = $${paramIndex}`;
                    params.push(item_group_id);
                    paramIndex++;
                }

                query += ` WHERE id = $${paramIndex} RETURNING id, code, name, item_group_id`;
                params.push(subGroupId);

                const result = await client.query(query, params);

                if (result.rows.length === 0) {
                    throw new Error("Subgroup not found");
                }

                return result.rows[0];
            });
        } catch (error) {
            console.error("Error updating material subgroup:", error);
            throw error;
        }
    },

    // Delete material subgroup (soft delete with cascade, no validation)
    deleteMaterialSubGroup: async (subGroupId, deletedBy) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");
                const now = new Date();
                // 1. Soft delete the subgroup
                await client.query(
                    "UPDATE mat_item_sub_group SET deleted_at = $1, deleted_by = $2 WHERE id = $3 AND deleted_at IS NULL",
                    [now, deletedBy, subGroupId]
                );
                // 2. Soft delete all materials under this subgroup
                await client.query(
                    `UPDATE mat_sap_data SET dffromclient = true WHERE material_sub_group_id = $1 AND (dffromclient IS NULL OR dffromclient = false)`,
                    [subGroupId]
                );
                await client.query("COMMIT");
                return { id: subGroupId, deleted: true };
            });
        } catch (error) {
            console.error("Error soft deleting material subgroup:", error);
            throw error;
        }
    },

    // Get subgroups by group ID
    getMaterialSubGroups: async (
        groupId,
        page = 1,
        pageSize = 10,
        searchQuery = "",
        sortField = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const searchPattern = searchQuery ? `%${searchQuery}%` : null;

                // Build the where clause based on whether we have a search query
                let whereClause = "mis.item_group_id = $1";
                let countWhereClause = "mis.item_group_id = $1";
                let params = [groupId];
                let countParams = [groupId];

                if (searchPattern) {
                    whereClause +=
                        " AND (mis.code ILIKE $4 OR mis.name ILIKE $4)";
                    countWhereClause +=
                        " AND (mis.code ILIKE $2 OR mis.name ILIKE $2)";
                    params.push(pageSize, offset, searchPattern);
                    countParams.push(searchPattern);
                } else {
                    params.push(pageSize, offset);
                }

                // First get the total count with search filter if provided
                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_item_sub_group mis
                    WHERE ${countWhereClause}
                    `,
                    countParams
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Determine safe sorting column and order (whitelist)
                const _allowedSortCols = {
                    code: "mis.code",
                    name: "mis.name",
                    id: "mis.id",
                    created_at: "mis.created_at",
                    updated_at: "mis.updated_at",
                };
                const _sortKey = String(sortField || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "mis.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";

                // Get the subgroups with pagination and search filter if provided
                const result = await client.query(
                    `
                    SELECT
                        mis.id,
                        mis.code,
                        mis.name,
                        mis.item_group_id,
                        mig.code as groupCode,
                        mig.name as groupName,
                        (SELECT COUNT(*) FROM mat_sap_data WHERE material_sub_group_id = mis.id) as materials_count
                    FROM mat_item_sub_group mis
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE ${whereClause}
                    ORDER BY ${_safeSortCol} ${_safeOrder}
                    LIMIT $2 OFFSET $3
                `,
                    params
                );

                return {
                    data: result.rows,
                    pagination: {
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get materials by group ID
    getMaterialsByGroup: async (
        groupId,
        page = 1,
        pageSize = 10,
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;

                // Whitelist allowed sort columns and directions
                const _allowedSortCols = {
                    code: "m.code",
                    name: "m.name",
                    description: "m.description",
                    created_at: "m.created_at",
                    updated_at: "m.updated_at",
                    uom: "m.unit_of_measurement",
                    group_code: "mig.code",
                    subgroup_code: "mis.code",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "m.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                // First get the total count
                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE mig.id = $1
                    `,
                    [groupId]
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Get group info
                const groupQuery = await client.query(
                    `SELECT id, code, name FROM mat_item_group WHERE id = $1`,
                    [groupId]
                );
                const groupDetails = groupQuery.rows[0] || null;

                // Get materials without attachments first
                const materialsQuery = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.created_by,
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE mig.id = $1
                    ORDER BY ${sortClause}
                    LIMIT $2 OFFSET $3
                    `,
                    [groupId, pageSize, offset]
                );

                // Get all material IDs to fetch attachments
                const materialIds = materialsQuery.rows.map(m => m.id);

                // Get attachments for these materials in a separate query
                const attachmentsQuery = await client.query(
                    `SELECT material_id, id, attachment, type
                     FROM mat_attachment
                     WHERE material_id = ANY($1)`,
                    [materialIds]
                );

                // Create a map of attachments by material_id
                const attachmentsByMaterialId = {};
                attachmentsQuery.rows.forEach(attachment => {
                    if (!attachmentsByMaterialId[attachment.material_id]) {
                        attachmentsByMaterialId[attachment.material_id] = [];
                    }
                    attachmentsByMaterialId[attachment.material_id].push({
                        id: attachment.id,
                        attachment: attachment.attachment,
                        type: attachment.type,
                    });
                });

                // Add attachments to each material
                const materialsWithAttachments = materialsQuery.rows.map(
                    material => ({
                        ...material,
                        attachments: attachmentsByMaterialId[material.id] || [],
                    })
                );

                return {
                    materials: materialsWithAttachments,
                    group: groupDetails,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Get materials by subgroup ID
    getMaterialsBySubGroup: async (
        subGroupId,
        page = 1,
        pageSize = 10,
        searchQuery = "",
        sort = "code",
        order = "asc"
    ) => {
        try {
            return await DBClientWrapper(async client => {
                const offset = (page - 1) * pageSize;
                const wildcard = parseWildcardSearch(searchQuery);

                const _allowedSortCols = {
                    code: "m.code",
                    name: "m.name",
                    description: "m.description",
                    created_at: "m.created_at",
                    updated_at: "m.updated_at",
                    uom: "m.unit_of_measurement",
                    group_code: "mig.code",
                    subgroup_code: "mis.code",
                };
                const _sortKey = String(sort || "code").toLowerCase();
                const _safeSortCol = _allowedSortCols[_sortKey] || "m.code";
                const _safeOrder =
                    order && String(order).toLowerCase() === "desc"
                        ? "DESC"
                        : "ASC";
                const sortClause = `${_safeSortCol} ${_safeOrder}`;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let countWhereClause = "m.material_sub_group_id = $1";
                let materialWhereClause = "m.material_sub_group_id = $1";
                let countParams = [subGroupId];
                let materialParams = [subGroupId, pageSize, offset];

                if (wildcard) {
                    const wildcardValues = [...wildcard.segments];

                    const countIlike = wildcard.segments.map(
                        (_, i) => `'%' || $${countParams.length + 1 + i} || '%'`
                    );
                    countWhereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${countIlike.join(", ")}])`;
                    countParams.push(...wildcardValues);

                    const matIlike = wildcard.segments.map(
                        (_, i) => `'%' || $${materialParams.length + 1 + i} || '%'`
                    );
                    materialWhereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${matIlike.join(", ")}])`;
                    materialParams.push(...wildcardValues);
                } else if (searchQuery) {
                    const searchPattern = `%${searchQuery}%`;
                    const fieldClause = searchableFields.map(f => `${f} ILIKE $2`).join(" OR ");
                    countWhereClause += ` AND (${fieldClause})`;
                    countParams.push(searchPattern);

                    const matFieldClause = searchableFields.map(f => `${f} ILIKE $4`).join(" OR ");
                    materialWhereClause += ` AND (${matFieldClause})`;
                    materialParams.push(searchPattern);
                }

                const countQuery = await client.query(
                    `
                    SELECT COUNT(*) as total
                    FROM mat_sap_data m
                    WHERE ${countWhereClause}
                    `,
                    countParams
                );

                const totalCount = parseInt(countQuery.rows[0].total);
                const totalPages = Math.ceil(totalCount / pageSize);

                // Get subgroup and group info
                const groupInfoQuery = await client.query(
                    `
                    SELECT
                        mis.id,
                        mis.code as subgroup_code,
                        mis.name as subgroup_name,
                        mis.item_group_id,
                        mig.id as group_id,
                        mig.code as group_code,
                        mig.name as group_name
                    FROM mat_item_sub_group mis
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE mis.id = $1
                    `,
                    [subGroupId]
                );

                // Build group and subgroup objects
                const groupInfo = groupInfoQuery.rows[0] || null;

                let group = null;
                let subgroup = null;

                if (groupInfo) {
                    group = {
                        id: groupInfo.group_id,
                        code: groupInfo.group_code,
                        name: groupInfo.group_name,
                    };

                    subgroup = {
                        id: groupInfo.id,
                        code: groupInfo.subgroup_code,
                        name: groupInfo.subgroup_name,
                        item_group_id: groupInfo.item_group_id,
                    };
                }

                // Get materials with search and pagination
                const materialsQuery = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.long_text,
                        m.unit_of_measurement,
                        CASE
                            WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                            WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                            WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                            ELSE NULL
                        END as combined_description,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient,
                        m.created_by,
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE ${materialWhereClause}
                    ORDER BY ${sortClause}
                    LIMIT $2 OFFSET $3
                    `,
                    materialParams
                );

                // Get all material IDs to fetch attachments
                const materialIds = materialsQuery.rows.map(m => m.id);

                // Skip attachment query if no materials
                if (materialIds.length === 0) {
                    return {
                        materials: [],
                        group,
                        subgroup,
                        pagination: {
                            page,
                            pageSize,
                            totalCount,
                            totalPages,
                        },
                    };
                }

                // Get attachments for these materials in a separate query
                const attachmentsQuery = await client.query(
                    `SELECT material_id, id, attachment, type
                     FROM mat_attachment
                     WHERE material_id = ANY($1)`,
                    [materialIds]
                );

                // Create a map of attachments by material_id
                const attachmentsByMaterialId = {};
                attachmentsQuery.rows.forEach(attachment => {
                    if (!attachmentsByMaterialId[attachment.material_id]) {
                        attachmentsByMaterialId[attachment.material_id] = [];
                    }
                    attachmentsByMaterialId[attachment.material_id].push({
                        id: attachment.id,
                        attachment: attachment.attachment,
                        type: attachment.type,
                    });
                });

                // Add attachments to each material
                const materialsWithAttachments = materialsQuery.rows.map(
                    material => ({
                        ...material,
                        attachments: attachmentsByMaterialId[material.id] || [],
                    })
                );

                return {
                    materials: materialsWithAttachments,
                    group,
                    subgroup,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages,
                    },
                };
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    // Search all materials (including deleted)
    searchAllMaterials: async (
        searchTerm,
        page = 1,
        pageSize = 10,
        sorting_state
    ) => {
        try {
            return await DBClientWrapper(async client => {
                let sorting_q = "";
                if (sorting_state) {
                    const colMap = {
                        CODE: "m.code",
                        NAME: "m.name",
                        CREATED_BY: "m.created_by",
                        CREATED_AT: "m.created_at",
                        GROUPNAME: "mig.name",
                        UPDATED_AT: "m.updated_at",
                        STATUS: "m.dffromclient",
                        UNIT_OF_MEASUREMENT: "m.unit_of_measurement",
                        FULLCODE: "m.code",
                        GROUPCODE: "mig.code",
                        SUBGROUPCODE: "mis.code",
                    };
                    sorting_q = sorting_state.reduce((result, item) => {
                        const col = String(item.col || "").toUpperCase();
                        const state = String(item.state || "").toUpperCase();
                        const mapped = colMap[col];
                        if (!mapped) return result;
                        const dir = state === "DESC" ? "DESC" : "ASC";
                        return result + `${mapped} ${dir},`;
                    }, "");
                }
                console.log(sorting_q);
                const offset = (page - 1) * pageSize;
                const safeSearchTerm = String(searchTerm || "").trim();
                const wildcard = parseWildcardSearch(safeSearchTerm);
                const isSearch = safeSearchTerm.length > 0;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let totalCount = 0;
                let materialsQueryResult = [];
                if (isSearch) {
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        const wildcardParams = [...wildcard.segments];

                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            WHERE CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])`,
                            wildcardParams
                        );
                        totalCount = parseInt(countRes.rows[0].total);

                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ORDER BY ${sorting_q}m.code ASC, m.name ASC
                            LIMIT $${wildcardParams.length + 1} OFFSET $${wildcardParams.length + 2}`,
                            [...wildcardParams, pageSize, offset]
                        );
                        materialsQueryResult = result.rows;
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        const ilikeExact = safeSearchTerm;
                        const ilikePartial = `%${safeSearchTerm}%`;
                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            WHERE (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )`,
                            [tsQuery, safeSearchTerm]
                        );
                        totalCount = parseInt(countRes.rows[0].total);
                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName",
                                ts_rank_cd(
                                    setweight(to_tsvector(COALESCE(m.name, '')), 'A') ||
                                    setweight(to_tsvector(COALESCE(m.description, '')), 'B') ||
                                    setweight(to_tsvector(COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '')), 'C') ||
                                    setweight(to_tsvector(COALESCE(m.alias1, '')), 'D'),
                                    to_tsquery('english', $1)
                                ) AS rank,
                                CASE
                                    WHEN m.code ILIKE $2 THEN 1
                                    WHEN m.code ILIKE $4 THEN 2
                                    ELSE 3
                                END AS code_match_rank
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($3, ' ')) AS word
                                )
                            ) ORDER BY ${sorting_q}code_match_rank, rank DESC, m.name ASC
                            LIMIT $5 OFFSET $6`,
                            [tsQuery, ilikeExact, safeSearchTerm, ilikePartial, pageSize, offset]
                        );
                        materialsQueryResult = result.rows;
                    }
                } else {
                    const countRes = await client.query(
                        `SELECT COUNT(*) AS total FROM mat_sap_data`
                    );
                    totalCount = parseInt(countRes.rows[0].total);
                    const result = await client.query(
                        `SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description,
                            CASE
                                WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                ELSE 'Active'
                            END AS status,
                            u.fullname AS "user_fullname",
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.filter_code_1,
                            m.filter_code_2,
                            m.material_sub_group_id,
                            m.created_at,
                            m.updated_at,
                            m.dfFromClient,
                            m.created_by,
                            mis.id AS "subGroupId",
                            mis.code AS "subGroupCode",
                            mis.name AS "subGroupName",
                            mig.id AS "groupId",
                            mig.code AS "groupCode",
                            mig.name AS "groupName"
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                        ORDER BY ${sorting_q}m.code ASC, m.name ASC
                        LIMIT $1 OFFSET $2`,
                        [pageSize, offset]
                    );
                    materialsQueryResult = result.rows;
                }
                const materialIds = materialsQueryResult.map(m => m.id);
                const attachmentsMap =
                    await Material.getAttachmentsByMaterialIds(
                        client,
                        materialIds
                    );
                const finalMaterials = materialsQueryResult.map(material => ({
                    ...material,
                    attachments: attachmentsMap[material.id] || [],
                }));
                return {
                    materials: finalMaterials,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error("Search all error:", error);
            throw error;
        }
    },

    // Update searchMaterials to only return non-deleted materials
    searchMaterials: async (
        searchTerm,
        page = 1,
        pageSize = 10,
        sorting_state,
        groupId = null
    ) => {
        try {
            return await DBClientWrapper(async client => {
                let sorting_q = "";
                if (sorting_state) {
                    const colMap = {
                        CODE: "m.code",
                        NAME: "m.name",
                        CREATED_AT: "m.created_at",
                        UPDATED_AT: "m.updated_at",
                        FULLCODE: "m.code",
                        GROUPCODE: "mig.code",
                        SUBGROUPCODE: "mis.code",
                    };
                    sorting_q = sorting_state.reduce((result, item) => {
                        const col = String(item.col || "").toUpperCase();
                        const state = String(item.state || "").toUpperCase();
                        const mapped = colMap[col];
                        if (!mapped) return result;
                        const dir = state === "DESC" ? "DESC" : "ASC";
                        return result + `${mapped} ${dir},`;
                    }, "");
                }
                const offset = (page - 1) * pageSize;
                const safeSearchTerm = String(searchTerm || "").trim();
                const wildcard = parseWildcardSearch(safeSearchTerm);
                const isSearch = safeSearchTerm.length > 0;

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let totalCount = 0;
                let materialsQueryResult = [];
                if (isSearch) {
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        const wildcardParams = [...wildcard.segments];
                        const groupParamIdx = wildcardParams.length + 1;

                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ${groupId ? ` AND mig.id = $${groupParamIdx}` : ""}`,
                            groupId ? [...wildcardParams, groupId] : wildcardParams
                        );
                        totalCount = parseInt(countRes.rows[0].total);

                        const limitIdx = groupId ? groupParamIdx + 1 : wildcardParams.length + 1;
                        const offsetIdx = limitIdx + 1;
                        const groupWhereIdx = groupId ? groupParamIdx : null;

                        let selectParams = [...wildcardParams];
                        let limitParamIdx = wildcardParams.length + 1;
                        if (groupId) {
                            selectParams.push(groupId);
                            limitParamIdx++;
                        }
                        selectParams.push(pageSize, offset);

                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                m.plant_code,
                                m.sloc_code,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ${groupId ? ` AND mig.id = $${wildcardParams.length + 1}` : ""}
                            ORDER BY ${sorting_q}m.code ASC, m.name ASC
                            LIMIT $${limitParamIdx} OFFSET $${limitParamIdx + 1}`,
                            selectParams
                        );
                        materialsQueryResult = result.rows;
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        const ilikeExact = safeSearchTerm;
                        const ilikePartial = `%${safeSearchTerm}%`;
                        const searchTermForTrgm = safeSearchTerm;
                        const countRes = await client.query(
                            `SELECT COUNT(*) AS total
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )
                            ${groupId ? " AND mig.id = $3" : ""}`,
                            groupId
                                ? [tsQuery, searchTermForTrgm, groupId]
                                : [tsQuery, searchTermForTrgm]
                        );
                        totalCount = parseInt(countRes.rows[0].total);
                        const result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                m.plant_code,
                                m.sloc_code,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.id AS "subGroupId",
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.id AS "groupId",
                                mig.code AS "groupCode",
                                mig.name AS "groupName",
                                ts_rank_cd(
                                    setweight(to_tsvector(COALESCE(m.name, '')), 'A') ||
                                    setweight(to_tsvector(COALESCE(m.description, '')), 'B') ||
                                    setweight(to_tsvector(COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '')), 'C') ||
                                    setweight(to_tsvector(COALESCE(m.alias1, '')), 'D'),
                                    to_tsquery('english', $1)
                                ) AS rank,
                                CASE
                                    WHEN m.code ILIKE $2 THEN 1
                                    WHEN m.code ILIKE $4 THEN 2
                                    ELSE 3
                                END AS code_match_rank
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($3, ' ')) AS word
                                )
                            )
                            ${groupId ? " AND mig.id = $7" : ""}
                            ORDER BY ${sorting_q}code_match_rank, rank DESC, m.name ASC
                            LIMIT $5 OFFSET $6`,
                            groupId
                                ? [
                                      tsQuery,
                                      ilikeExact,
                                      searchTermForTrgm,
                                      ilikePartial,
                                      pageSize,
                                      offset,
                                      groupId,
                                  ]
                                : [
                                      tsQuery,
                                      ilikeExact,
                                      searchTermForTrgm,
                                      ilikePartial,
                                      pageSize,
                                      offset,
                                  ]
                        );
                        materialsQueryResult = result.rows;
                    }
                } else {
                    const countRes = await client.query(
                        `SELECT COUNT(*) AS total 
                         FROM mat_sap_data m
                         JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                         JOIN mat_item_group mig ON mis.item_group_id = mig.id
                         WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                         ${groupId ? " AND mig.id = $1" : ""}`,
                        groupId ? [groupId] : []
                    );
                    totalCount = parseInt(countRes.rows[0].total);
                    const result = await client.query(
                        `SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            m.plant_code,
                            m.sloc_code,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description,
                            CASE
                                WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                ELSE 'Active'
                            END AS status,
                            u.fullname AS "user_fullname",
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.filter_code_1,
                            m.filter_code_2,
                            m.material_sub_group_id,
                            m.created_at,
                            m.updated_at,
                            m.dfFromClient,
                            m.created_by,
                            mis.id AS "subGroupId",
                            mis.code AS "subGroupCode",
                            mis.name AS "subGroupName",
                            mig.id AS "groupId",
                            mig.code AS "groupCode",
                            mig.name AS "groupName"
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                        WHERE (m.dffromclient IS NULL OR dffromclient = false) 
                        ${groupId ? " AND mig.id = $3" : ""}
                        ORDER BY ${sorting_q}m.code ASC, m.name ASC
                        LIMIT $1 OFFSET $2`,
                        groupId
                            ? [pageSize, offset, groupId]
                            : [pageSize, offset]
                    );
                    materialsQueryResult = result.rows;
                }
                const materialIds = materialsQueryResult.map(m => m.id);
                const attachmentsMap =
                    await Material.getAttachmentsByMaterialIds(
                        client,
                        materialIds
                    );
                const finalMaterials = materialsQueryResult.map(material => ({
                    ...material,
                    attachments: attachmentsMap[material.id] || [],
                }));
                return {
                    materials: finalMaterials,
                    pagination: {
                        page,
                        pageSize,
                        totalCount,
                        totalPages: Math.ceil(totalCount / pageSize),
                    },
                };
            });
        } catch (error) {
            console.error("Search error:", error);
            throw error;
        }
    },

    // Search suggestions for materials
    getSearchSuggestions: async ({
        query,
        materialGroupCode = null,
        limit = 10,
    }) => {
        try {
            return await DBClientWrapper(async client => {
                const safeSearchTerm = String(query || "").trim();
                if (safeSearchTerm.length < 2) return [];

                const safeLimit = Math.min(Number(limit) || 10, 25);

                const wildcard = parseWildcardSearch(safeSearchTerm);

                const searchableFields = [
                    "m.code",
                    "m.name",
                    "COALESCE(m.description, '')",
                    "COALESCE(m.long_text, '')",
                    "COALESCE(m.unit_of_measurement, '')",
                    "COALESCE(m.alias1, '')",
                    "COALESCE(m.alias2, '')",
                    "COALESCE(m.alias3, '')",
                ];

                let whereClause =
                    "(m.dffromclient IS NULL OR m.dffromclient = false)";
                const params = [];

                if (wildcard) {
                    const ilikePatterns = wildcard.segments.map(
                        (_, i) => `'%' || $${i + 1} || '%'`
                    );
                    params.push(...wildcard.segments);
                    whereClause += ` AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])`;

                    if (materialGroupCode) {
                        whereClause += ` AND mig.code = $${params.length + 1}`;
                        params.push(materialGroupCode);
                    }

                    const queryText = `
                        SELECT 
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description
                        FROM mat_sap_data m
                        LEFT JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        LEFT JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        WHERE ${whereClause}
                        ORDER BY m.code ASC
                        LIMIT $${params.length + 1}
                    `;

                    params.push(safeLimit);
                    const result = await client.query(queryText, params);
                    return result.rows;
                } else {
                    params.push(safeSearchTerm);

                    const wordMatchClause = `(
                        m.code ILIKE '%' || word || '%'
                        OR m.name ILIKE '%' || word || '%'
                        OR m.description ILIKE '%' || word || '%'
                        OR m.long_text ILIKE '%' || word || '%'
                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                        OR m.alias1 ILIKE '%' || word || '%'
                        OR m.alias2 ILIKE '%' || word || '%'
                        OR m.alias3 ILIKE '%' || word || '%'
                    )`;

                    whereClause += ` AND (
                        EXISTS (
                            SELECT 1 FROM unnest(string_to_array($1, ' ')) AS word
                            WHERE ${wordMatchClause}
                        )
                    )`;

                    if (materialGroupCode) {
                        whereClause += ` AND mig.code = $2`;
                        params.push(materialGroupCode);
                    }

                    const queryText = `
                        SELECT 
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.unit_of_measurement,
                            CASE
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                ELSE NULL
                            END AS combined_description
                        FROM mat_sap_data m
                        LEFT JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        LEFT JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        WHERE ${whereClause}
                        ORDER BY
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.code ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.name ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.description ILIKE '%' || word || '%') DESC,
                            m.code ASC
                        LIMIT $${params.length + 1}
                    `;

                    params.push(safeLimit);
                    const result = await client.query(queryText, params);
                    return result.rows;
                }

                const result = await client.query(queryText, params);
                return result.rows;
            });
        } catch (error) {
            console.error("Error fetching search suggestions:", error);
            throw error;
        }
    },

    // Utility: Fetch and group attachments
    getAttachmentsByMaterialIds: async (client, ids) => {
        if (!ids.length) return {};
        const res = await client.query(
            `SELECT material_id, id, attachment, type FROM mat_attachment WHERE material_id = ANY($1)`,
            [ids]
        );
        const map = {};
        res.rows.forEach(({ material_id, ...rest }) => {
            if (!map[material_id]) map[material_id] = [];
            map[material_id].push(rest);
        });
        return map;
    },

    // Get material by ID with full details
    getMaterialById: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient,
                        CASE 
                            WHEN m.dfFromClient THEN 'Inactive' 
                            ELSE 'Active' 
                        END AS status,
                        u.fullname AS "user_fullname",
                        mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName",
                        m.code as "fullCode"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE m.id = $1
                `,
                    [materialId]
                );
                return result.rows[0];
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    getMaterialByCode: async materialCode => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `
                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.type,
                        m.unit_of_measurement,
                        m.plant_code,
                        m.sloc_code,
                        mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                    WHERE m.code = $1
                `,
                    [materialCode]
                );
                return result.rows[0] || null;
            });
        } catch (error) {
            console.error(error);
            throw error;
        }
    },

    getMaterialAttachments: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                const result = await client.query(
                    `SELECT id, attachment, type, material_id
                    FROM mat_attachment
                    WHERE material_id = $1
                    ORDER BY id`,
                    [materialId]
                );
                return result.rows;
            });
        } catch (error) {
            console.error("Error fetching material attachments:", error);
            throw error;
        }
    },

    addAttachment: async (
        materialId,
        fileInfoArray,
        updatedBy,
        userRole,
        userName
    ) => {
        const uploadedFiles = [];
        const cleanupFiles = [];

        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Check current attachment count
                    const attachmentCountQuery = await client.query(
                        "SELECT COUNT(*) as count FROM mat_attachment WHERE material_id = $1",
                        [materialId]
                    );

                    const currentAttachmentCount = parseInt(
                        attachmentCountQuery.rows[0].count
                    );
                    const MAX_ATTACHMENTS = 3;

                    if (currentAttachmentCount >= MAX_ATTACHMENTS) {
                        throw new Error(
                            `Maximum number of attachments (${MAX_ATTACHMENTS}) reached for this material`
                        );
                    }

                    // Calculate how many more attachments we can add
                    const availableSlots =
                        MAX_ATTACHMENTS - currentAttachmentCount;

                    if (fileInfoArray.length > availableSlots) {
                        throw new Error(
                            `Can only add ${availableSlots} more attachment(s). Maximum of ${MAX_ATTACHMENTS} attachments allowed per material.`
                        );
                    }

                    // 1. Add attachments to database
                    for (const file of fileInfoArray) {
                        // Determine MIME type from extension
                        const mimeType = getMimeType(file.extension);

                        // Use Crud helper to generate insert query
                        const insertData = {
                            material_id: materialId,
                            attachment: file.newName,
                            type: mimeType,
                            created_at: "NOW()",
                            updated_at: "NOW()",
                        };

                        const [query, values] = Crud.insertItem(
                            "mat_attachment",
                            insertData,
                            "id"
                        );

                        const result = await client.query(query, values);

                        uploadedFiles.push({
                            id: result.rows[0].id,
                            originalName: file.originalName,
                            savedAs: file.newName,
                            type: mimeType,
                        });
                    }

                    const updateData = {
                        updated_at: "NOW()",
                        updated_by: updatedBy || null,
                    };

                    const whereCondition = {
                        id: materialId,
                    };

                    const [query, values] = Crud.updateItem(
                        "mat_sap_data",
                        updateData,
                        whereCondition
                    );

                    await client.query(query, values);

                    // Commit transaction
                    await client.query("COMMIT");

                    // 3. After successful database operations, save files to disk
                    for (const file of fileInfoArray) {
                        const publicDir = path.join(
                            path.resolve(),
                            "./backend/public"
                        );

                        // Ensure public directory exists
                        if (!fs.existsSync(publicDir)) {
                            fs.mkdirSync(publicDir, { recursive: true });
                        }

                        const finalPath = path.join(publicDir, file.newName);
                        cleanupFiles.push(finalPath);

                        // Read from temp location and write to final location
                        const rawData = fs.readFileSync(file.tempPath);
                        fs.writeFileSync(finalPath, rawData);
                    }

                    return {
                        success: true,
                        files: uploadedFiles,
                    };
                } catch (error) {
                    // Rollback transaction on error
                    await client.query("ROLLBACK");

                    for (const filePath of cleanupFiles) {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                    }

                    throw error;
                }
            });
        } catch (error) {
            console.error("Error processing attachment upload:", error);
            throw error;
        }
    },

    updateMaterialTimestamp: async (materialId, updatedBy) => {
        try {
            return await DBClientWrapper(async client => {
                // Create data object for update
                const updateData = {
                    updated_at: "NOW()",
                    updated_by: updatedBy || null,
                };

                // Create where condition
                const whereCondition = {
                    id: materialId,
                };

                // Use Crud helper to generate query
                const [query, values] = Crud.updateItem(
                    "mat_sap_data",
                    updateData,
                    whereCondition
                );

                const result = await client.query(query, values);

                if (result.rowCount === 0) {
                    throw new Error("Material not found or no changes made");
                }

                return {
                    materialId,
                    updatedBy: updatedBy || null,
                    updated: true,
                };
            });
        } catch (error) {
            console.error("Error updating material timestamp:", error);
            throw error;
        }
    },

    updateAliasesOnly: async (
        materialId,
        alias1,
        alias2,
        alias3,
        userRole,
        userName
    ) => {
        try {
            return await DBClientWrapper(async client => {
                await client.query("BEGIN");

                try {
                    // Get current material details for comparison and tracking
                    const materialDetailQuery = await client.query(
                        "SELECT code, name, alias1, alias2, alias3 FROM mat_sap_data WHERE id = $1",
                        [materialId]
                    );

                    if (materialDetailQuery.rows.length === 0) {
                        throw new Error("Material not found");
                    }

                    // Create data object for update
                    const updateData = {
                        alias1: alias1 || null,
                        alias2: alias2 || null,
                        alias3: alias3 || null,
                    };

                    // Create where condition
                    const whereCondition = {
                        id: materialId,
                    };

                    // Use Crud helper to generate query
                    const [query, values] = Crud.updateItem(
                        "mat_sap_data",
                        updateData,
                        whereCondition
                    );

                    const result = await client.query(query, values);

                    if (result.rowCount === 0) {
                        throw new Error(
                            "Material not found or no changes made"
                        );
                    }

                    await client.query("COMMIT");

                    return {
                        materialId,
                        alias1: alias1 || null,
                        alias2: alias2 || null,
                        alias3: alias3 || null,
                        updated: true,
                    };
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error updating aliases:", error);
            throw error;
        }
    },

    deleteAttachment: async (attachmentId, updatedBy) => {
        try {
            return await DBClientWrapper(async client => {
                // Begin transaction
                await client.query("BEGIN");

                try {
                    // Get attachment details to get the file path
                    const attachmentQuery = await client.query(
                        "SELECT id, material_id, attachment FROM mat_attachment WHERE id = $1",
                        [attachmentId]
                    );

                    if (attachmentQuery.rows.length === 0) {
                        throw new Error("Attachment not found");
                    }

                    const attachment = attachmentQuery.rows[0];
                    const materialId = attachment.material_id;
                    const filename = attachment.attachment;

                    // Delete the attachment from the database
                    await client.query(
                        "DELETE FROM mat_attachment WHERE id = $1",
                        [attachmentId]
                    );

                    // Update the material's updated_at timestamp
                    await client.query(
                        "UPDATE mat_sap_data SET updated_at = NOW(), updated_by = $1 WHERE id = $2",
                        [updatedBy || null, materialId]
                    );

                    // Commit transaction
                    await client.query("COMMIT");

                    // Try to delete the file from disk (but don't fail if this fails)
                    try {
                        const publicDir = path.join(
                            path.resolve(),
                            "./backend/public"
                        );
                        const filePath = path.join(publicDir, filename);

                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    } catch (fileError) {
                        console.error(
                            "Error deleting attachment file:",
                            fileError
                        );
                        // Don't throw here, we've already committed the DB changes
                    }

                    return {
                        success: true,
                        materialId,
                        attachmentId,
                    };
                } catch (error) {
                    // Rollback transaction on error
                    await client.query("ROLLBACK");
                    throw error;
                }
            });
        } catch (error) {
            console.error("Error deleting attachment:", error);
            throw error;
        }
    },

    // Export only groups to Excel
    exportOnlyGroupsToExcel: async () => {
        try {
            return await DBClientWrapper(async client => {
                // Query to get all groups
                const groupsResult = await client.query(`
                    SELECT
                        id,
                        code as group_code,
                        name as group_name
                    FROM mat_item_group
                    ORDER BY code
                `);

                // Create the export data for the "Groups" sheet
                const groupsData = groupsResult.rows.map(group => ({
                    "Group Code": group.group_code,
                    "Group Name": group.group_name,
                }));

                // Create a new workbook
                const workbook = xlsx.utils.book_new();

                // Add Groups worksheet
                const groupsWorksheet = xlsx.utils.json_to_sheet(groupsData);
                xlsx.utils.book_append_sheet(
                    workbook,
                    groupsWorksheet,
                    "Groups"
                );

                // Create buffer
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });

                return buffer;
            });
        } catch (error) {
            console.error("Error exporting groups to Excel:", error);
            throw error;
        }
    },

    // Export only subgroups to Excel
    exportOnlySubgroupsToExcel: async (groupId = null) => {
        try {
            return await DBClientWrapper(async client => {
                // Build the query based on whether we have a group ID
                let queryText;
                let queryParams = [];

                if (groupId) {
                    queryText = `
                        SELECT
                            s.id,
                            s.code as subgroup_code,
                            s.name as subgroup_name,
                            s.item_group_id,
                            g.code as group_code,
                            g.name as group_name
                        FROM mat_item_sub_group s
                        JOIN mat_item_group g ON s.item_group_id = g.id
                        WHERE s.item_group_id = $1
                        ORDER BY s.code
                    `;
                    queryParams.push(groupId);
                } else {
                    queryText = `
                        SELECT
                            s.id,
                            s.code as subgroup_code,
                            s.name as subgroup_name,
                            s.item_group_id,
                            g.code as group_code,
                            g.name as group_name
                        FROM mat_item_sub_group s
                        JOIN mat_item_group g ON s.item_group_id = g.id
                        ORDER BY g.code, s.code
                    `;
                }

                const subgroupsResult = await client.query(
                    queryText,
                    queryParams
                );

                // Create the export data for the "Subgroups" sheet
                const subgroupsData = subgroupsResult.rows.map(subgroup => ({
                    "Subgroup Code": subgroup.subgroup_code,
                    "Subgroup Name": subgroup.subgroup_name,
                    "Group Code": subgroup.group_code,
                    "Group Name": subgroup.group_name,
                }));

                // Create a new workbook
                const workbook = xlsx.utils.book_new();

                // Add Subgroups worksheet
                const subgroupsWorksheet =
                    xlsx.utils.json_to_sheet(subgroupsData);
                xlsx.utils.book_append_sheet(
                    workbook,
                    subgroupsWorksheet,
                    "Subgroups"
                );

                // Create buffer
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });

                return buffer;
            });
        } catch (error) {
            console.error("Error exporting subgroups to Excel:", error);
            throw error;
        }
    },

    // Import only groups from Excel
    importOnlyGroupsFromExcel: async (fileBuffer, userId) => {
        let client;
        try {
            // Get a client from the pool directly instead of using DBClientWrapper
            client = await db.connect();

            // Begin transaction
            await client.query("BEGIN");

            try {
                // Parse Excel file
                const workbook = xlsx.read(fileBuffer, { type: "buffer" });

                // Check if Groups sheet exists
                if (!workbook.SheetNames.includes("Groups")) {
                    throw new Error("Excel file must contain a 'Groups' sheet");
                }

                // Get Groups sheet data
                const groupsSheet = workbook.Sheets["Groups"];
                const groupsData = xlsx.utils.sheet_to_json(groupsSheet);

                // Statistics for operation
                const stats = {
                    total: groupsData.length,
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: [],
                };

                // Process each group in a try-catch block to prevent one error from failing the entire transaction
                for (const group of groupsData) {
                    try {
                        // Try multiple possible column naming formats since Excel exports can be inconsistent
                        // Check if column name is different than expected
                        const code = String(
                            group["Group Code"] ||
                                group["group_code"] ||
                                group["GroupCode"] ||
                                group["groupCode"] ||
                                group["group code"] ||
                                group["code"] ||
                                ""
                        ).trim();

                        const name = String(
                            group["Group Name"] ||
                                group["group_name"] ||
                                group["GroupName"] ||
                                group["groupName"] ||
                                group["group name"] ||
                                group["name"] ||
                                ""
                        ).trim();

                        // Skip empty rows
                        if (!code && !name) {
                            stats.skipped++;
                            continue;
                        }

                        // Validate required fields
                        if (!code || !name) {
                            throw new Error(
                                `Missing required fields. Group Code: ${code}, Group Name: ${name}`
                            );
                        }

                        // Check if group already exists
                        const existingGroup = await client.query(
                            "SELECT id FROM mat_item_group WHERE code = $1",
                            [code]
                        );

                        const now = new Date();

                        if (existingGroup.rows.length > 0) {
                            // Update existing group
                            const groupId = existingGroup.rows[0].id;
                            await client.query(
                                `UPDATE mat_item_group
                                SET name = $1, updated_at = $2, updated_by = $3
                                WHERE id = $4`,
                                [name, now, userId, groupId]
                            );
                            stats.updated++;
                        } else {
                            await client.query(
                                `INSERT INTO mat_item_group (code, name, created_at, updated_at, created_by, updated_by)
                                VALUES ($1, $2, $3, $4, $5, $6)
                                RETURNING id`,
                                [code, name, now, now, userId, userId]
                            );
                            stats.created++;
                        }
                    } catch (error) {
                        // Log the error but continue processing other groups
                        stats.errors.push({
                            row: JSON.stringify(group),
                            error: error.message,
                        });
                    }
                }

                // Commit transaction only if there were no errors or if some records were successful
                if (
                    stats.errors.length === 0 ||
                    stats.created > 0 ||
                    stats.updated > 0
                ) {
                    await client.query("COMMIT");
                } else {
                    // Rollback if nothing was processed successfully
                    await client.query("ROLLBACK");
                }

                return stats;
            } catch (error) {
                // Ensure rollback happens on any error
                if (client) {
                    await client.query("ROLLBACK");
                }
                throw error;
            }
        } catch (error) {
            throw error;
        } finally {
            // Always release the client back to the pool
            if (client) {
                client.release();
            }
        }
    },

    // Import only subgroups from Excel
    importOnlySubgroupsFromExcel: async (fileBuffer, userId) => {
        let client;
        try {
            // Get a client from the pool directly instead of using DBClientWrapper
            client = await db.connect();

            // Begin transaction
            await client.query("BEGIN");

            try {
                // Parse Excel file
                const workbook = xlsx.read(fileBuffer, { type: "buffer" });

                // Check if Subgroups sheet exists
                if (!workbook.SheetNames.includes("Subgroups")) {
                    throw new Error(
                        "Excel file must contain a 'Subgroups' sheet"
                    );
                }

                // Get Subgroups sheet data
                const subgroupsSheet = workbook.Sheets["Subgroups"];
                const subgroupsData = xlsx.utils.sheet_to_json(subgroupsSheet);

                // Statistics for operation
                const stats = {
                    total: subgroupsData.length,
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: [],
                };

                // Get all existing groups for validation
                const groupsResult = await client.query(
                    "SELECT id, code FROM mat_item_group"
                );
                const groupCodeToIdMap = new Map();
                groupsResult.rows.forEach(group => {
                    groupCodeToIdMap.set(group.code, group.id);
                });

                // Process each subgroup in a try-catch block to prevent one error from failing the entire transaction
                for (const subgroup of subgroupsData) {
                    try {
                        // Extract and validate data
                        const code = String(
                            subgroup["Subgroup Code"] || ""
                        ).trim();
                        const name = String(
                            subgroup["Subgroup Name"] || ""
                        ).trim();
                        const groupCode = String(
                            subgroup["Group Code"] || ""
                        ).trim();

                        // Skip empty rows
                        if (!code && !name) {
                            stats.skipped++;
                            continue;
                        }

                        // Validate required fields
                        if (!code || !name || !groupCode) {
                            throw new Error(
                                `Missing required fields. Subgroup Code: ${code}, Subgroup Name: ${name}, Group Code: ${groupCode}`
                            );
                        }

                        // Find the group ID from the map
                        if (!groupCodeToIdMap.has(groupCode)) {
                            throw new Error(
                                `Group with code ${groupCode} not found. Make sure it exists in the database before importing subgroups.`
                            );
                        }

                        const groupId = groupCodeToIdMap.get(groupCode);

                        // Check if subgroup already exists in this group
                        const existingSubgroup = await client.query(
                            "SELECT id FROM mat_item_sub_group WHERE code = $1 AND item_group_id = $2",
                            [code, groupId]
                        );

                        const now = new Date();

                        if (existingSubgroup.rows.length > 0) {
                            // Update existing subgroup
                            const subgroupId = existingSubgroup.rows[0].id;
                            await client.query(
                                `UPDATE mat_item_sub_group
                                SET name = $1, updated_at = $2, updated_by = $3
                                WHERE id = $4`,
                                [name, now, userId, subgroupId]
                            );
                            stats.updated++;
                        } else {
                            // Create new subgroup
                            await client.query(
                                `INSERT INTO mat_item_sub_group (code, name, item_group_id, created_at, updated_at, created_by, updated_by)
                                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                [code, name, groupId, now, now, userId, userId]
                            );
                            stats.created++;
                        }
                    } catch (error) {
                        // Log the error but continue processing other subgroups
                        stats.errors.push({
                            row: JSON.stringify(subgroup),
                            error: error.message,
                        });
                    }
                }

                // Commit transaction only if there were no errors or if some records were successful
                if (
                    stats.errors.length === 0 ||
                    stats.created > 0 ||
                    stats.updated > 0
                ) {
                    await client.query("COMMIT");
                } else {
                    // Rollback if nothing was processed successfully
                    await client.query("ROLLBACK");
                }

                return stats;
            } catch (error) {
                // Ensure rollback happens on any error
                if (client) {
                    try {
                        await client.query("ROLLBACK");
                    } catch (rollbackError) {
                        console.error("Error during rollback:", rollbackError);
                    }
                }
                throw error;
            }
        } catch (error) {
            console.error("Error importing subgroups from Excel:", error);
            throw error;
        } finally {
            // Always release the client back to the pool
            if (client) {
                client.release();
            }
        }
    },

    // Get full material details and attachments for materials by array of codes
    getAttachmentsByCodes: async codes => {
        try {
            return await DBClientWrapper(async client => {
                if (!Array.isArray(codes) || codes.length === 0) return [];
                // Fetch materials by codes
                const materialRes = await client.query(
                    `                    SELECT
                        m.id,
                        m.code,
                        m.name,
                        m.description,
                        m.long_text,
                        m.unit_of_measurement,
                        m.alias1,
                        m.alias2,
                        m.alias3,
                        m.filter_code_1,
                        m.filter_code_2,
                        m.created_at,
                        m.updated_at,
                        m.dfFromClient, CASE WHEN m.dfFromClient THEN 'Inactive' ELSE 'Active' END AS status, u.fullname AS "user_fullname", mis.id as "subGroupId",
                        mis.code as "subGroupCode",
                        mis.name as "subGroupName",
                        mig.id as "groupId",
                        mig.code as "groupCode",
                        mig.name as "groupName"
                    FROM mat_sap_data m
                    JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                    JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    WHERE m.code = ANY($1)`,
                    [codes]
                );
                const idToMaterial = {};
                materialRes.rows.forEach(row => {
                    idToMaterial[row.id] = { ...row, attachments: [] };
                });
                const ids = materialRes.rows.map(row => row.id);
                if (ids.length === 0) return [];
                // Fetch attachments for these materials
                const attachRes = await client.query(
                    `SELECT material_id, id, attachment, type FROM mat_attachment WHERE material_id = ANY($1)`,
                    [ids]
                );
                attachRes.rows.forEach(att => {
                    if (idToMaterial[att.material_id]) {
                        idToMaterial[att.material_id].attachments.push({
                            id: att.id,
                            attachment: att.attachment,
                            type: att.type,
                        });
                    }
                });
                // Return as array of material objects (with attachments)
                return Object.values(idToMaterial);
            });
        } catch (error) {
            console.error("Error fetching material details by codes:", error);
            throw error;
        }
    },

    // Export materials to Excel (filtered by group/subgroup or search query)
    exportMaterialsToExcel: async (groupId, subGroupId, searchTerm) => {
        try {
            return await DBClientWrapper(async client => {
                let materialsQueryResult = [];
                let groupCode = null;
                let subGroupCode = null;
                // The filename reports the filters that produced the file, so the
                // group code is needed on every branch, not only the one that
                // filters by group alone.
                if (groupId) {
                    const groupRes = await client.query(
                        "SELECT code FROM mat_item_group WHERE id = $1",
                        [groupId]
                    );
                    if (groupRes.rows.length > 0)
                        groupCode = groupRes.rows[0].code;
                }
                if (searchTerm && searchTerm.trim() !== "") {
                    const safeSearchTerm = String(searchTerm || "").trim();
                    const wildcard = parseWildcardSearch(safeSearchTerm);

                    const searchableFields = [
                        "m.code",
                        "m.name",
                        "COALESCE(m.description, '')",
                        "COALESCE(m.long_text, '')",
                        "COALESCE(m.unit_of_measurement, '')",
                        "COALESCE(m.alias1, '')",
                        "COALESCE(m.alias2, '')",
                        "COALESCE(m.alias3, '')",
                    ];

                    let result;
                    if (wildcard) {
                        const ilikePatterns = wildcard.segments.map(
                            (_, i) => `'%' || $${i + 1} || '%'`
                        );
                        result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                            ${groupId ? ` AND mig.id = $${wildcard.segments.length + 1}` : ""}
                            ORDER BY m.code ASC, m.name ASC`,
                            groupId
                                ? [...wildcard.segments, groupId]
                                : [...wildcard.segments]
                        );
                    } else {
                        const toTsQuery = input =>
                            input
                                .trim()
                                .split(/\s+/)
                                .map(word => `${word}:*`)
                                .join(" & ");
                        const tsQuery = toTsQuery(safeSearchTerm);
                        result = await client.query(
                            `SELECT
                                m.id,
                                m.code,
                                m.name,
                                m.description,
                                m.long_text,
                                m.unit_of_measurement,
                                CASE
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' AND m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN CONCAT(m.description, ' - ', m.long_text)
                                    WHEN m.description IS NOT NULL AND TRIM(m.description) <> '' THEN m.description
                                    WHEN m.long_text IS NOT NULL AND TRIM(m.long_text) <> '' THEN m.long_text
                                    ELSE NULL
                                END AS combined_description,
                                CASE
                                    WHEN m.dffromclient IS TRUE THEN 'Inactive'
                                    ELSE 'Active'
                                END AS status,
                                u.fullname AS "user_fullname",
                                m.alias1,
                                m.alias2,
                                m.alias3,
                                m.filter_code_1,
                                m.filter_code_2,
                                m.material_sub_group_id,
                                m.created_at,
                                m.updated_at,
                                m.dfFromClient,
                                m.created_by,
                                mis.code AS "subGroupCode",
                                mis.name AS "subGroupName",
                                mig.code AS "groupCode",
                                mig.name AS "groupName"
                            FROM mat_sap_data m
                            JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                            JOIN mat_item_group mig ON mis.item_group_id = mig.id
                            LEFT JOIN mst_user u ON m.created_by = u.user_id
                            WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                            AND (
                                to_tsvector('english', COALESCE(m.name, '') || ' ' || COALESCE(m.description, '') || ' ' || COALESCE(m.long_text, '') || ' ' || COALESCE(m.unit_of_measurement, '') || ' ' || COALESCE(m.alias1, '') || ' ' || COALESCE(m.alias2, '') || ' ' || COALESCE(m.alias3, '') || ' ' || COALESCE(m.code, '')) @@ to_tsquery('english', $1)
                                OR (
                                    SELECT bool_and(
                                        m.code ILIKE '%' || word || '%'
                                        OR m.name ILIKE '%' || word || '%'
                                        OR m.description ILIKE '%' || word || '%'
                                        OR m.long_text ILIKE '%' || word || '%'
                                        OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                                        OR m.alias1 ILIKE '%' || word || '%'
                                        OR m.alias2 ILIKE '%' || word || '%'
                                        OR m.alias3 ILIKE '%' || word || '%'
                                    )
                                    FROM unnest(string_to_array($2, ' ')) AS word
                                )
                            )
                            ${groupId ? " AND mig.id = $3" : ""}
                            ORDER BY m.code ASC, m.name ASC`,
                            groupId
                                ? [tsQuery, safeSearchTerm, groupId]
                                : [tsQuery, safeSearchTerm]
                        );
                    }
                    materialsQueryResult = result.rows;
                } else {
                    let query = `
                        SELECT
                            m.code,
                            m.name,
                            m.description,
                            m.long_text,
                            m.unit_of_measurement,
                            mig.code as group_code,
                            mig.name as group_name,
                            mis.code as subgroup_code,
                            mis.name as subgroup_name,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            m.created_at,
                            m.updated_at
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON m.material_sub_group_id = mis.id
                        JOIN mat_item_group mig ON mis.item_group_id = mig.id
                        LEFT JOIN mst_user u ON m.created_by = u.user_id
                    `;
                    const params = [];
                    let where = [];
                    if (subGroupId) {
                        where.push("mis.id = $" + (params.length + 1));
                        params.push(subGroupId);
                        // Fetch subgroup code and its parent group code
                        const subRes = await client.query(
                            "SELECT code, item_group_id FROM mat_item_sub_group WHERE id = $1",
                            [subGroupId]
                        );
                        if (subRes.rows.length > 0) {
                            subGroupCode = subRes.rows[0].code;
                            const groupIdFromSub = subRes.rows[0].item_group_id;
                            if (groupIdFromSub) {
                                const groupRes = await client.query(
                                    "SELECT code FROM mat_item_group WHERE id = $1",
                                    [groupIdFromSub]
                                );
                                if (groupRes.rows.length > 0)
                                    groupCode = groupRes.rows[0].code;
                            }
                        }
                    } else if (groupId) {
                        where.push("mig.id = $" + (params.length + 1));
                        params.push(groupId);
                    }
                    if (where.length > 0) {
                        query += " WHERE " + where.join(" AND ");
                    }
                    query += " ORDER BY m.code ASC, m.name ASC";
                    const result = await client.query(query, params);
                    materialsQueryResult = result.rows;
                }
                // Prepare data for Excel
                const materialsData = materialsQueryResult.map(row => {
                    let desc =
                        row.description && row.long_text
                            ? `${row.description} - ${row.long_text}`
                            : row.description || row.long_text || "";
                    // Remove carriage returns and newlines
                    desc = desc.replace(/\r\n|\r|\n/g, " ");
                    return {
                        Code: row.code,
                        Description: desc,
                        UOM: row.unit_of_measurement || "",
                        "Group Code": row.group_code || row.groupCode,
                        "Group Name": row.group_name || row.groupName,
                        "Subgroup Code": row.subgroup_code || row.subGroupCode,
                        "Subgroup Name": row.subgroup_name || row.subGroupName,
                        "Alias 1": row.alias1,
                        "Alias 2": row.alias2,
                        "Alias 3": row.alias3,
                        "Created At": row.created_at
                            ? row.created_at
                                  .toISOString()
                                  .slice(0, 19)
                                  .replace("T", " ")
                            : "",
                        "Updated At": row.updated_at
                            ? row.updated_at
                                  .toISOString()
                                  .slice(0, 19)
                                  .replace("T", " ")
                            : "",
                    };
                });
                const workbook = xlsx.utils.book_new();
                const worksheet = xlsx.utils.json_to_sheet(materialsData);
                const wscols = [
                    { wch: 20 }, // Code
                    { wch: 35 }, // Name
                    { wch: 60 }, // Description
                    { wch: 10 }, // UOM
                    { wch: 15 }, // Group Code
                    { wch: 25 }, // Group Name
                    { wch: 15 }, // Subgroup Code
                    { wch: 25 }, // Subgroup Name
                    { wch: 20 }, // Alias 1
                    { wch: 20 }, // Alias 2
                    { wch: 20 }, // Alias 3
                    { wch: 22 }, // Created At
                    { wch: 22 }, // Updated At
                ];
                worksheet["!cols"] = wscols;
                const rowCount = materialsData.length + 1; // +1 for header
                worksheet["!rows"] = Array.from({ length: rowCount }, () => ({
                    hpt: 22,
                }));
                xlsx.utils.book_append_sheet(workbook, worksheet, "Materials");
                const buffer = xlsx.write(workbook, {
                    type: "buffer",
                    bookType: "xlsx",
                });
                return { buffer, groupCode, subGroupCode };
            });
        } catch (error) {
            console.error("Error exporting materials to Excel:", error);
            throw error;
        }
    },

    // SAP Data Synchronization job (for cron/manual use)
    syncSAPDataJob: async ({ startDate, endDate, fieldName = "LAEDA" }) => {
        try {
            // Validate required parameters
            if (!startDate || !endDate) {
                throw new Error(
                    "startDate and endDate are required (format: YYYYMMDD)"
                );
            }
            if (!["ERSDA", "LAEDA"].includes(fieldName)) {
                throw new Error("fieldName must be either 'ERSDA' or 'LAEDA'");
            }
            const dateRegex = /^\d{8}$/;
            if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
                throw new Error("Dates must be in YYYYMMDD format");
            }
            console.log(
                `[SAP Sync] Starting: ${fieldName} from ${startDate} to ${endDate}`
            );
            // Configure axios instance with correct credentials
            const sapClient = axios.create({
                headers: {
                    Authorization: `Basic ${Buffer.from(
                        `${process.env.SAP_API_CREDENTIALS}`
                    ).toString("base64")}`,
                    "Content-Type": "application/json",
                },
                timeout: 30000,
            });
            // Fetch data from SAP
            // const SAP_URL = `http://erpdev-gm.gamasap.com:8000/sap/opu/odata/sap/ZMM_MATERIAL_MASTER_SRV/MATERIALSet?$filter=(${fieldName} gt '${startDate}')and(${fieldName} lt '${endDate}')&$format=json`;

            const SAP_URL = `${process.env.ODATADOM}:${process.env.ODATAPORT}/sap/opu/odata/sap/ZMM_MATERIAL_MASTER_SRV/MATERIALSet?$filter=(${fieldName} gt '${startDate}')and(${fieldName} lt '${endDate}')&$format=json`;

            const response = await sapClient.get(SAP_URL);
            const results = response.data.d.results;
            console.log(
                `[SAP Sync] Retrieved ${results.length} records from SAP`
            );
            // Filter valid items (starting with 9)
            const validItems = [];
            let skippedNotStartsWith9 = 0;
            for (const item of results) {
                if (!item.MATNR.startsWith("9")) {
                    skippedNotStartsWith9++;
                    continue;
                }
                validItems.push(item);
            }
            console.log(
                `[SAP Sync] Valid items: ${validItems.length}, Skipped: ${skippedNotStartsWith9}`
            );
            // Process database operations
            const dbStats = {
                inserted: 0,
                updated: 0,
                failed: 0,
                total: validItems.length,
            };
            for (const item of validItems) {
                const result = await saveToDatabase(item, pool);
                if (result.success) {
                    if (result.action === "inserted") {
                        dbStats.inserted++;
                    } else {
                        dbStats.updated++;
                    }
                } else {
                    dbStats.failed++;
                    console.error(
                        `[SAP Sync] Failed: ${result.materialId} - ${result.error}`
                    );
                }
            }
            const successRate = (
                ((dbStats.inserted + dbStats.updated) / (dbStats.total || 1)) *
                100
            ).toFixed(2);
            const summary = {
                sapRecords: results.length,
                validRecords: validItems.length,
                skippedNotStartsWith9,
                database: {
                    inserted: dbStats.inserted,
                    updated: dbStats.updated,
                    failed: dbStats.failed,
                    successRate: `${successRate}%`,
                },
                parameters: {
                    fieldName,
                    startDate,
                    endDate,
                },
            };
            console.log("[SAP Sync] Summary:", summary);
            return {
                success: true,
                message: "SAP data synchronization completed",
                data: summary,
            };
        } catch (error) {
            console.error("[SAP Sync] Error:", error);
            return { success: false, message: error.message, error };
        }
    },




    // Soft delete a material (set dffromclient = true)
    deleteMaterial: async materialId => {
        try {
            return await DBClientWrapper(async client => {
                await client.query(
                    "UPDATE mat_sap_data SET dffromclient = true WHERE id = $1 AND (dffromclient IS NULL OR dffromclient = false)",
                    [materialId]
                );
                return { id: materialId, deleted: true };
            });
        } catch (error) {
            s;
            console.error("Error soft deleting material:", error);
            throw error;
        }
    },
 };

module.exports = Material;
