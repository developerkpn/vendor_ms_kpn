-- 1) Vehicle & Transportation template (VEHICLE_TRANSPORTATION): add
--    Part Number + Material Name spec fields, in the same leading positions the
--    other templates use (part_number #1, material_name #2). Existing fields
--    (vehicle_type, brand_merek, model, capacity, year) shift down by 2.
--    part_number is optional here (a vehicle request does not always have one);
--    material_name is mandatory like on every other template.
-- 2) Spec inputs now allow special characters (validators relaxed in code:
--    CAPITAL_* rules only reject lowercase, NUMERIC_ONLY only rejects letters,
--    MIXED is free-form) — refresh the rule_detail hint texts to match.
--
-- Idempotent; run on dev and prod PG.

BEGIN;

-- Shift existing Vehicle & Transportation rules +2 (two-step bump so the
-- UNIQUE (template_id, field_order) constraint never sees a transient clash).
UPDATE mat_template_field_rules r
SET field_order = field_order + 100
WHERE r.template_id = (SELECT template_id FROM mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION')
  AND field_order < 100
  AND NOT EXISTS (
      SELECT 1
      FROM mat_template_field_rules pr
      JOIN mat_field_master pf ON pf.field_id = pr.field_id
      WHERE pr.template_id = r.template_id
        AND pf.field_key IN ('part_number', 'material_name')
  );

UPDATE mat_template_field_rules
SET field_order = field_order - 98
WHERE template_id = (SELECT template_id FROM mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION')
  AND field_order >= 100;

INSERT INTO mat_template_field_rules
    (template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, updated_at)
SELECT
    t.template_id, f.field_id, 1, false, 'PREFIX', 'P/N', 'Diawali "P/N"', NOW()
FROM mat_template_master t, mat_field_master f
WHERE t.template_code = 'VEHICLE_TRANSPORTATION' AND f.field_key = 'part_number'
ON CONFLICT (template_id, field_id) DO NOTHING;

INSERT INTO mat_template_field_rules
    (template_id, field_id, field_order, is_mandatory, validation_rule_type, rule_detail, updated_at)
SELECT
    t.template_id, f.field_id, 2, true, 'CAPITAL_ONLY', 'Huruf kapital, karakter khusus diperbolehkan', NOW()
FROM mat_template_master t, mat_field_master f
WHERE t.template_code = 'VEHICLE_TRANSPORTATION' AND f.field_key = 'material_name'
ON CONFLICT (template_id, field_id) DO NOTHING;

-- Refresh hint texts (tooltips read rule_detail first) to the relaxed rules.
UPDATE mat_template_field_rules
SET rule_detail = 'Huruf kapital, karakter khusus diperbolehkan', updated_at = NOW()
WHERE validation_rule_type IN ('CAPITAL_ONLY', 'CAPITAL_NO_SPECIAL_CHARS', 'ALPHANUMERIC_CAPITAL');

UPDATE mat_template_field_rules
SET rule_detail = 'Angka dan karakter khusus', updated_at = NOW()
WHERE validation_rule_type = 'NUMERIC_ONLY';

UPDATE mat_template_field_rules
SET rule_detail = 'Bebas (huruf, angka, karakter khusus)', updated_at = NOW()
WHERE validation_rule_type = 'MIXED_ALPHA_NUM_UNIT';

COMMIT;
