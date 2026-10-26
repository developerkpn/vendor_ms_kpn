// Material files and the files on the completed Create request are one list
// in the catalog. Resolve by final code at read time so materials imported
// before this link was implemented are covered without copying ticket files.
// Request files stay read-only here: deleting them would damage ticket history.
const loadMaterialAttachments = async (client, materialIds = []) => {
    if (!materialIds.length) return [];

    const direct = await client.query(
        `SELECT material_id, id, attachment, type
         FROM mat_attachment
         WHERE material_id = ANY($1)
         ORDER BY material_id, id`,
        [materialIds]
    );
    const requests = await client.query(
        `SELECT m.id AS material_id,
                'single-request:' || a.id AS id,
                a.file_path AS attachment,
                a.file_name AS name,
                a.file_type AS type,
                TRUE AS read_only
         FROM mat_sap_data m
         JOIN mat_single_request r ON r.final_code = m.code
         JOIN mat_single_request_attachment a ON a.request_id = r.id
         WHERE m.id = ANY($1)
           AND r.ticket_type = 'Create'
           AND r.status = 'DONE'
         UNION ALL
         SELECT m.id AS material_id,
                'mass-request:' || a.id AS id,
                a.file_path AS attachment,
                a.file_name AS name,
                a.file_type AS type,
                TRUE AS read_only
         FROM mat_sap_data m
         JOIN mat_mass_request_item i ON i.final_code = m.code
         JOIN mat_mass_request_attachment a ON a.item_id = i.id
         WHERE m.id = ANY($1)
           AND i.status = 'DONE'
         ORDER BY material_id, id`,
        [materialIds]
    );

    const seen = new Set();
    return [...requests.rows, ...direct.rows].filter(attachment => {
        const storedPath = String(attachment.attachment || "")
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");
        if (!storedPath) return false;
        const key = `${attachment.material_id}:${storedPath}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

module.exports = { loadMaterialAttachments };
