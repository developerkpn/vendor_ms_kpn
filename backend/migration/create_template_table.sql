-- Template tables for the material request form (spec / template fields:
-- mat_template_master / mat_template_group_map / mat_field_master / mat_template_field_rules).
-- NOTE: mat_request_field_rules was removed (standard SAP fields are hardcoded/derived).

CREATE TABLE IF NOT EXISTS public.mat_template_master (
    template_id serial4 PRIMARY KEY,
    template_code varchar(100) NOT NULL UNIQUE,
    template_name varchar(150) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mat_template_group_map (
    template_group_map_id serial4 PRIMARY KEY,
    template_id int4 NOT NULL
        REFERENCES public.mat_template_master(template_id)
        ON DELETE CASCADE,
    material_group_code varchar(10) NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mat_field_master (
    field_id serial4 PRIMARY KEY,
    field_code varchar(10) NOT NULL UNIQUE,
    field_key varchar(100) NOT NULL UNIQUE,
    field_name_id varchar(100) NOT NULL,
    data_type varchar(20) NOT NULL DEFAULT 'TEXT',
    is_template_field bool NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mat_template_field_rules (
    template_rule_id serial4 PRIMARY KEY,
    template_id int4 NOT NULL
        REFERENCES public.mat_template_master(template_id)
        ON DELETE CASCADE,
    field_id int4 NOT NULL
        REFERENCES public.mat_field_master(field_id)
        ON DELETE CASCADE,
    field_order int4 NOT NULL,
    is_mandatory bool NOT NULL DEFAULT false,
    validation_rule_type varchar(50) NULL,
    prefix_value varchar(50) NULL,
    rule_detail text NULL,
    max_length int4 NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mat_template_field_rules_un_template_field UNIQUE (template_id, field_id),
    CONSTRAINT mat_template_field_rules_un_template_order UNIQUE (template_id, field_order)
);

-- Seed: mat_field_master
INSERT INTO public.mat_field_master (field_code, field_key, field_name_id, data_type, is_template_field, updated_at) VALUES 
('101', 'part_number', 'Part Number', 'TEXT', true, NOW()),
('102', 'type_bentuk', 'Type / Bentuk', 'TEXT', true, NOW()),
('103', 'model', 'Model', 'TEXT', true, NOW()),
('104', 'bahan_warna_material', 'Bahan / Warna Material', 'TEXT', true, NOW()),
('105', 'size_dimension', 'Size / Dimension', 'TEXT', true, NOW()),
('106', 'brand_merek', 'Brand', 'TEXT', true, NOW()),
('107', 'capacity', 'Capacity', 'TEXT', true, NOW()),
('108', 'power', 'Power', 'TEXT', true, NOW()),
('109', 'speed', 'Speed', 'TEXT', true, NOW()),
('110', 'voltage', 'Voltage', 'TEXT', true, NOW()),
('111', 'current', 'Current', 'TEXT', true, NOW()),
('112', 'frequency', 'Frequency', 'TEXT', true, NOW()),
('113', 'material', 'Material', 'TEXT', true, NOW()),
('114', 'pressure', 'Pressure', 'TEXT', true, NOW()),
('115', 'temperature', 'Temperature', 'TEXT', true, NOW()),
('116', 'connection', 'Connection', 'TEXT', true, NOW()),
('117', 'application', 'Application', 'TEXT', true, NOW()),
('118', 'grade', 'Grade', 'TEXT', true, NOW()),
('119', 'standard', 'Standard', 'TEXT', true, NOW()),
('120', 'concentration', 'Concentration', 'TEXT', true, NOW()),
('121', 'volume', 'Volume', 'TEXT', true, NOW()),
('122', 'weight', 'Weight', 'TEXT', true, NOW()),
('123', 'color', 'Color', 'TEXT', true, NOW())
ON CONFLICT (field_code) DO UPDATE SET
    field_key = EXCLUDED.field_key,
    field_name_id = EXCLUDED.field_name_id,
    data_type = EXCLUDED.data_type,
    is_template_field = EXCLUDED.is_template_field,
    updated_at = NOW();

-- Seed: template master
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('MECHANICAL_COMPONENT', 'Mechanical Component', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('ELECTRICAL_COMPONENT', 'Electrical Component', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('EQUIPMENT_MACHINERY', 'Equipment / Machinery', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('PROCESS_PLANT_EQUIPMENT', 'Process / Plant Equipment', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('PIPING_SYSTEM', 'Piping System', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('CHEMICAL_CONSUMABLES', 'Chemical & Consumables', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('PACKAGING_PRODUCT_MATERIAL', 'Packaging & Product Material', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('CONSTRUCTION_CIVIL_MATERIAL', 'Construction / Civil Material', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('OFFICE_GENERAL_SUPPLIES', 'Office & General Supplies', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('VEHICLE_TRANSPORTATION', 'Vehicle & Transportation', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('CAPITAL_EQUIPMENT', 'Capital Equipment', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();
INSERT INTO public.mat_template_master (template_code, template_name, updated_at)
VALUES ('GENERAL_MISCELLANEOUS', 'General / Miscellaneous', NOW())
ON CONFLICT (template_code) DO UPDATE SET
    template_name = EXCLUDED.template_name,
    updated_at = NOW();

-- Seed: template to material group map
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '905', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '907', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '911', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '917', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '925', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '932', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '950', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '957', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '968', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '940', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '955', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '909', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '920', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '921', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '947', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '953', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '944', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    '915', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '903', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '904', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '902', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '906', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '913', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '916', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '927', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '935', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '936', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '937', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '938', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '969', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '941', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '982', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '946', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '971', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '928', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '954', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '973', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '984', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '960', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '918', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '943', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '942', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    '961', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    '962', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    '963', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    '965', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    '966', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    '979', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '912', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '959', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '929', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '931', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '922', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '980', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    '985', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '958', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '983', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '972', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '967', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '948', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '926', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    '949', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    '914', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    '976', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    '945', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    '956', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    '974', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    '978', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    '930', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    '939', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    '952', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    '910', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    '934', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    '951', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();

-- Additional missing group mappings (from blueprint sections 3.2.1-3.2.12)
-- 901 → MECHANICAL_COMPONENT (3.2.1 - Valve, Actuator & Control Valve)
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '901', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
-- 908 → EQUIPMENT_MACHINERY (3.2.3 - Burner, Blower & Industrial Fan)
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    '908', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();
-- 933 → MECHANICAL_COMPONENT (3.2.1)
INSERT INTO public.mat_template_group_map (template_id, material_group_code, updated_at)
VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    '933', NOW()
) ON CONFLICT (material_group_code) DO UPDATE SET
    template_id = EXCLUDED.template_id,
    updated_at = NOW();

-- Seed: template field rules
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '101'),
    1, true, 'PREFIX', 'P/N', 'Diawali "P/N"', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    2, true, 'CAPITAL_NO_SPECIAL_CHARS', NULL, 'Huruf kapital, tanpa tanda baca khusus', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    3, true, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '104'),
    4, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '105'),
    5, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    6, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'MECHANICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    7, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '101'),
    1, true, 'PREFIX', 'P/N', 'Diawali "P/N"', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    2, true, 'CAPITAL_NO_SPECIAL_CHARS', NULL, 'Huruf kapital, tanpa tanda baca khusus', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    3, true, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '104'),
    4, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '108'),
    5, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '109'),
    6, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '110'),
    7, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '111'),
    8, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '112'),
    9, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    10, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'ELECTRICAL_COMPONENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    11, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '101'),
    1, true, 'PREFIX', 'P/N|POS', 'Diawali "P/N" atau "POS"', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    2, true, 'CAPITAL_NO_SPECIAL_CHARS', NULL, 'Huruf kapital, tanpa tanda baca khusus', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    3, true, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '113'),
    4, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '114'),
    5, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '115'),
    6, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    7, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'EQUIPMENT_MACHINERY'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    8, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_NO_SPECIAL_CHARS', NULL, 'Huruf kapital, tanpa tanda baca khusus', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '113'),
    3, false, 'NONE', NULL, 'Tidak ada ketentuan input', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '105'),
    4, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    5, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PROCESS_PLANT_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    6, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '104'),
    3, false, 'MIXED_ALPHA_NUM_UNIT', NULL, 'Angka dan satuan ukuran', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '116'),
    4, false, 'MIXED_ALPHA_NUM_UNIT', NULL, 'Angka dan huruf', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '105'),
    5, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PIPING_SYSTEM'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '117'),
    6, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '118'),
    3, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '119'),
    4, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '104'),
    5, false, 'MIXED_ALPHA_NUM_UNIT', NULL, 'Angka dan satuan', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CHEMICAL_CONSUMABLES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    6, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '120'),
    3, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '105'),
    4, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '121'),
    5, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'PACKAGING_PRODUCT_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    6, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '119'),
    3, false, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '120'),
    4, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CONSTRUCTION_CIVIL_MATERIAL'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '117'),
    5, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '118'),
    3, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '120'),
    4, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'OFFICE_GENERAL_SUPPLIES'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    5, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '122'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    3, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '113'),
    4, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'VEHICLE_TRANSPORTATION'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '123'),
    5, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '113'),
    3, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '114'),
    4, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '106'),
    5, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'CAPITAL_EQUIPMENT'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    6, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '102'),
    1, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '103'),
    2, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '118'),
    3, false, 'ALPHANUMERIC_CAPITAL', NULL, 'Huruf kapital dan angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '120'),
    4, false, 'NUMERIC_ONLY', NULL, 'Angka', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
INSERT INTO public.mat_template_field_rules (
    template_id, field_id, field_order, is_mandatory, validation_rule_type, prefix_value, rule_detail, max_length, updated_at
) VALUES (
    (SELECT template_id FROM public.mat_template_master WHERE template_code = 'GENERAL_MISCELLANEOUS'),
    (SELECT field_id FROM public.mat_field_master WHERE field_code = '107'),
    5, true, 'CAPITAL_ONLY', NULL, 'Huruf kapital', NULL, NOW()
) ON CONFLICT (template_id, field_id) DO UPDATE SET
    field_order = EXCLUDED.field_order,
    is_mandatory = EXCLUDED.is_mandatory,
    validation_rule_type = EXCLUDED.validation_rule_type,
    prefix_value = EXCLUDED.prefix_value,
    rule_detail = EXCLUDED.rule_detail,
    max_length = EXCLUDED.max_length,
    updated_at = NOW();
