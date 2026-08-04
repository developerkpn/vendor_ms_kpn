-- IBE-012: the Dimension spec field must accept letters, not only digits.
--
-- `dimension` carries NUMERIC_ONLY on all four templates that use it, so any unit
-- suffix (MM, CM, INCH) or a form like 10X20X5MM is rejected. `size_dimension` —
-- the equivalent field on the other templates — is already MIXED_ALPHA_NUM_UNIT,
-- so this aligns `dimension` with behaviour that already exists rather than
-- introducing a new rule.
--
-- No code change needed: MIXED_ALPHA_NUM_UNIT is already permissive on both sides
-- (TEMPLATE_VALIDATORS in services/materialService.js, validateSpecField in the
-- frontend). rule_detail is updated in the same statement because the tooltip
-- reads rule_detail before falling back to the rule type, and would otherwise
-- still tell the user "Angka dan karakter khusus".
--
-- Keyed on field_key, not field_code: the field_code assignments in
-- create_template_table.sql do not match this database.
--
-- Idempotent; run on dev and prod PG.

BEGIN;

UPDATE mat_template_field_rules r
SET validation_rule_type = 'MIXED_ALPHA_NUM_UNIT',
    rule_detail          = 'Bebas (huruf, angka, karakter khusus)',
    updated_at           = NOW()
FROM mat_field_master f
WHERE f.field_id  = r.field_id
  AND f.field_key = 'dimension'
  AND (r.validation_rule_type IS DISTINCT FROM 'MIXED_ALPHA_NUM_UNIT'
       OR r.rule_detail       IS DISTINCT FROM 'Bebas (huruf, angka, karakter khusus)');

COMMIT;