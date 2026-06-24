-- Drop mat_request_field_rules. It is no longer used: the SAP staging push
-- hardcodes the only constants it ever supplied (material_type=SPAR,
-- industry_sector=C, division=90), and the request form / approval views render
-- their fields from hardcoded JSX + the template tables (mat_template_*/
-- mat_field_master), not from this table. Verified: no inbound FK, no view
-- depends on it. Apply only AFTER the code that read it is deployed.

DROP TABLE IF EXISTS public.mat_request_field_rules;
