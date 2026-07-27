-- Meeting notes 2026-07-20: in the Specification section, only Material Name
-- is mandatory — every other spec field (part_number, type_bentuk, capacity,
-- brand_merek, model, etc.) becomes optional across ALL templates.
-- Idempotent; run on dev and prod PG.

BEGIN;

UPDATE mat_template_field_rules r
SET is_mandatory = (f.field_key = 'material_name'), updated_at = NOW()
FROM mat_field_master f
WHERE r.field_id = f.field_id
  AND r.is_mandatory <> (f.field_key = 'material_name');

COMMIT;
