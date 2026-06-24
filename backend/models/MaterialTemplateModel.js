const DBClientWrapper = require("../helper/DBClientWrapper.js");
const {
    hasValue,
    mapTemplateConfigRows,
    normalizeTemplateValue,
    validateTemplateValues,
} = require("../services/materialService.js");
const {
    buildMaterialFormSchema,
} = require("../services/materialService.js");

function parseWildcardSearch(term) {
    if (!term || !term.includes('*')) return null;
    const segments = term.split('*').map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length === 0) return null;
    return { isWildcard: true, segments };
}

const MaterialTemplate = {
    getMaterialTemplates: async () => {
        return DBClientWrapper(async client => {
            const result = await client.query(`
                SELECT
                    tm.template_id,
                    tm.template_code,
                    tm.template_name,
                    ARRAY_AGG(tgm.material_group_code ORDER BY tgm.material_group_code) AS material_group_codes
                FROM mat_template_master tm
                JOIN mat_template_group_map tgm ON tgm.template_id = tm.template_id
                GROUP BY tm.template_id, tm.template_code, tm.template_name
                ORDER BY tm.template_name ASC
            `);

            return result.rows.map(row => ({
                templateId: row.template_id,
                templateCode: row.template_code,
                templateName: row.template_name,
                materialGroupCodes: row.material_group_codes || [],
            }));
        });
    },

    getMaterialTemplateByGroupCode: async materialGroupCode => {
        return DBClientWrapper(async client => {
            // Standard request fields (material_type/industry_sector/division,
            // tax, batch, …) are no longer table-driven — SAP hardcodes/derives
            // them. The form renders Material Group / Base UoM / spec fields from
            // hardcoded JSX + the template tables, so requestFieldRules is empty.
            const templateResult = await client.query(
                `
                    SELECT
                        tm.template_id,
                        tm.template_code,
                        tm.template_name,
                        tgm.material_group_code,
                        tr.template_rule_id,
                        tr.field_order,
                        tr.is_mandatory,
                        tr.validation_rule_type,
                        tr.prefix_value,
                        tr.rule_detail,
                        tr.max_length,
                        fm.field_id,
                        fm.field_code,
                        fm.field_key,
                        fm.field_name_id,
                        fm.data_type
                    FROM mat_template_group_map tgm
                    JOIN mat_template_master tm ON tm.template_id = tgm.template_id
                    JOIN mat_template_field_rules tr ON tr.template_id = tm.template_id
                    JOIN mat_field_master fm ON fm.field_id = tr.field_id
                    WHERE tgm.material_group_code = $1
                    ORDER BY tr.field_order ASC
                `,
                [materialGroupCode]
            );

            let templateConfig = mapTemplateConfigRows(templateResult.rows);

            // Fallback: if no direct mapping, use GENERAL_MISCELLANEOUS template
            if (!templateConfig) {
                const fallbackResult = await client.query(
                    `
                        SELECT
                            tm.template_id,
                            tm.template_code,
                            tm.template_name,
                            $1 AS material_group_code,
                            tr.template_rule_id,
                            tr.field_order,
                            tr.is_mandatory,
                            tr.validation_rule_type,
                            tr.prefix_value,
                            tr.rule_detail,
                            tr.max_length,
                            fm.field_id,
                            fm.field_code,
                            fm.field_key,
                            fm.field_name_id,
                            fm.data_type
                        FROM mat_template_master tm
                        JOIN mat_template_field_rules tr ON tr.template_id = tm.template_id
                        JOIN mat_field_master fm ON fm.field_id = tr.field_id
                        WHERE tm.template_code = 'GENERAL_MISCELLANEOUS'
                        ORDER BY tr.field_order ASC
                    `,
                    [materialGroupCode]
                );
                templateConfig = mapTemplateConfigRows(fallbackResult.rows);
            }

            if (!templateConfig) {
                throw new Error(
                    `Material template tidak ditemukan untuk material group ${materialGroupCode}`
                );
            }

            return {
                materialGroupCode,
                template: templateConfig,
            };
        });
    },

    getMaterialFormSchemaByGroupCode: async materialGroupCode => {
        let materialTemplate = null;
        try {
            materialTemplate =
                await MaterialTemplate.getMaterialTemplateByGroupCode(
                    materialGroupCode
                );
        } catch (error) {
            // If template not found, we still want the group and subgroups
            if (
                !error.message ||
                !error.message.includes("Material template tidak ditemukan")
            ) {
                throw error;
            }
        }

        return DBClientWrapper(async client => {
            const materialGroupResult = await client.query(
                `
                    SELECT id, code, name
                    FROM mat_item_group
                    WHERE code = $1
                      AND deleted_at IS NULL
                    LIMIT 1
                `,
                [materialGroupCode]
            );

            if (materialGroupResult.rows.length === 0) {
                throw new Error(
                    `Material group tidak ditemukan untuk kode ${materialGroupCode}`
                );
            }

            const materialGroup = {
                id: materialGroupResult.rows[0].id,
                code: materialGroupResult.rows[0].code,
                name: materialGroupResult.rows[0].name,
            };

            const subgroupResult = await client.query(
                `
                    SELECT id, code, name
                    FROM mat_item_sub_group
                    WHERE item_group_id = $1
                      AND deleted_at IS NULL
                    ORDER BY code ASC
                `,
                [materialGroup.id]
            );

            return buildMaterialFormSchema({
                materialGroup,
                template: materialTemplate ? materialTemplate.template : null,
                subgroups: subgroupResult.rows.map(row => ({
                    id: row.id,
                    code: row.code,
                    name: row.name,
                })),
            });
        });
    },

    previewMaterialTemplateDescription: async (
        materialGroupCode,
        templateValues
    ) => {
        const materialTemplate =
            await MaterialTemplate.getMaterialTemplateByGroupCode(
                materialGroupCode
            );
        const preview = validateTemplateValues(
            materialTemplate.template,
            templateValues || {}
        );

        return {
            materialGroupCode,
            template: materialTemplate.template,
            ...preview,
        };
    },

    validateMaterialRequestTemplate: async ({
        materialGroupCode,
        requestFields = {},
        templateValues = {},
    }) => {
        return DBClientWrapper(async client => {
            const materialTemplate =
                await MaterialTemplate.getMaterialTemplateByGroupCode(
                    materialGroupCode
                );
            const errors = [];
            const normalizedRequestFields = {};

            const preview = validateTemplateValues(
                materialTemplate.template,
                templateValues || {}
            );

            const materialDescription = hasValue(
                normalizedRequestFields.material_description
            )
                ? normalizedRequestFields.material_description
                : null;

            const previewErrors = (preview.errors || []).filter(
                error => error.fieldKey !== "material_description"
            );

            const searchTerm = normalizeTemplateValue(
                materialDescription ||
                    preview.materialDescription ||
                    preview.fullDescription ||
                    ""
            );
            let duplicateSuggestions = [];

            if (searchTerm) {
                const duplicateResult = await client.query(
                    `
                        SELECT
                            m.id,
                            m.code,
                            COALESCE(m.description, m.name) AS material_description,
                            mig.code AS material_group_code,
                            mig.name AS material_group_name
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON mis.id = m.material_sub_group_id
                        JOIN mat_item_group mig ON mig.id = mis.item_group_id
                        WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                          AND mig.code = $1
                          AND (
                            UPPER(COALESCE(m.description, '')) LIKE $2
                            OR UPPER(COALESCE(m.name, '')) LIKE $2
                            OR UPPER(COALESCE(m.code, '')) LIKE $2
                          )
                        ORDER BY m.code ASC
                        LIMIT 5
                    `,
                    [materialGroupCode, `%${searchTerm}%`]
                );
                duplicateSuggestions = duplicateResult.rows;
            }

            return {
                materialGroupCode,
                template: materialTemplate.template,
                normalizedRequestFields,
                normalizedTemplateValues: preview.normalizedValues,
                materialDescription,
                fullDescription: preview.fullDescription,
                exceedsMaterialDescriptionLimit:
                    preview.exceedsMaterialDescriptionLimit,
                duplicateSuggestions,
                errors: [...errors, ...previewErrors],
                isValid: errors.length === 0 && previewErrors.length === 0,
            };
        });
    },

    searchMaterialTemplateSuggestions: async ({
        query,
        materialGroupCode = null,
        limit = 10,
    }) => {
        return DBClientWrapper(async client => {
            const normalizedQuery = normalizeTemplateValue(query || "");
            if (normalizedQuery.length < 2) {
                return [];
            }

            const safeLimit = Math.min(Number(limit) || 10, 25);
            const wildcard = parseWildcardSearch(normalizedQuery);

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

            const params = [];
            let queryText;

            if (wildcard) {
                const ilikePatterns = wildcard.segments.map(
                    (_, i) => `'%' || $${i + 1} || '%'`
                );
                params.push(...wildcard.segments);

                if (materialGroupCode) {
                    params.push(materialGroupCode, safeLimit);
                    const wcLen = wildcard.segments.length;
                    queryText = `
                        SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            mig.code AS material_group_code,
                            mig.name AS material_group_name
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON mis.id = m.material_sub_group_id
                        JOIN mat_item_group mig ON mig.id = mis.item_group_id
                        WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                          AND mig.code = $${wcLen + 1}
                          AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                        ORDER BY m.code ASC
                        LIMIT $${wcLen + 2}
                    `;
                } else {
                    params.push(safeLimit);
                    queryText = `
                        SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            mig.code AS material_group_code,
                            mig.name AS material_group_name
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON mis.id = m.material_sub_group_id
                        JOIN mat_item_group mig ON mig.id = mis.item_group_id
                        WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                          AND CONCAT_WS(' ', ${searchableFields.join(", ")}) ILIKE ALL(ARRAY[${ilikePatterns.join(", ")}])
                        ORDER BY m.code ASC
                        LIMIT $${wildcard.segments.length + 1}
                    `;
                }
            } else {
                params.push(normalizedQuery);
                const wordMatchSubquery = `
                    m.code ILIKE '%' || word || '%'
                    OR m.name ILIKE '%' || word || '%'
                    OR m.description ILIKE '%' || word || '%'
                    OR m.long_text ILIKE '%' || word || '%'
                    OR COALESCE(m.unit_of_measurement, '') ILIKE '%' || word || '%'
                    OR m.alias1 ILIKE '%' || word || '%'
                    OR m.alias2 ILIKE '%' || word || '%'
                    OR m.alias3 ILIKE '%' || word || '%'
                `;

                const searchCondition = `
                    EXISTS (
                        SELECT 1 FROM unnest(string_to_array($search, ' ')) AS word
                        WHERE ${wordMatchSubquery}
                    )
                `;

                queryText = materialGroupCode
                    ? `
                        SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            mig.code AS material_group_code,
                            mig.name AS material_group_name
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON mis.id = m.material_sub_group_id
                        JOIN mat_item_group mig ON mig.id = mis.item_group_id
                        WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                          AND mig.code = $2
                          AND ${searchCondition.replace(/\$search/g, '$1')}
                        ORDER BY
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.code ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.name ILIKE '%' || word || '%') DESC,
                            m.code ASC
                        LIMIT $3
                    `
                    : `
                        SELECT
                            m.id,
                            m.code,
                            m.name,
                            m.description,
                            m.alias1,
                            m.alias2,
                            m.alias3,
                            mig.code AS material_group_code,
                            mig.name AS material_group_name
                        FROM mat_sap_data m
                        JOIN mat_item_sub_group mis ON mis.id = m.material_sub_group_id
                        JOIN mat_item_group mig ON mig.id = mis.item_group_id
                        WHERE (m.dffromclient IS NULL OR m.dffromclient = false)
                          AND ${searchCondition.replace(/\$search/g, '$1')}
                        ORDER BY
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.code ILIKE '%' || word || '%') DESC,
                            (SELECT COUNT(*) FROM unnest(string_to_array($1, ' ')) AS word WHERE m.name ILIKE '%' || word || '%') DESC,
                            m.code ASC
                        LIMIT $2
                    `;

                if (materialGroupCode) {
                    params.push(materialGroupCode, safeLimit);
                } else {
                    params.push(safeLimit);
                }
            }

            const result = await client.query(queryText, params);
            return result.rows;
        });
    },
};

module.exports = MaterialTemplate;
