-- ============================================================================
-- ORACLE — trim the live VMS_MATERIALDATA table down to the final 22-column
-- FDS "Data Staging" set. The table was first created from a 39-column draft
-- (SAP-derived/hardcoded fields included); SAP now hardcodes/derives those in
-- ABAP, so they are no longer staged. This brings the live table in line with
-- oracle/20260618_create_vms_materialdata.sql.
--
-- Run against the SAP-bridge schema as the bridge user — DEV (SAPBRIDGE_D)
-- FIRST. Only run on PROD (SAPBRIDGE_P) once the SAP team has signed off.
-- Dev table currently has 0 rows, so no data is lost. App code (the INSERT
-- payload + the pull-back SELECT) only ever references the 22 surviving columns
-- and uses an explicit column list, so physical column order is irrelevant.
-- ============================================================================

-- 1) Drop the 17 columns SAP now hardcodes (IND_SECTOR, MATL_TYPE, tax, batch,
--    MRP, price, transport/loading, distr. channel) or derives from its own
--    Z-tables (PROFIT_CTR via ZEXMAT_PRCTR, VAL_CLASS via ZMDMTVALCLASS).
ALTER TABLE VMS_MATERIALDATA DROP (
    DISTRIBUTION_CHANNEL,
    DEPARTURE_COUNTRY,
    TAX_CATEGORY,
    TAX_CLASSIFICATION,
    AVAILABILITY_CHECK,
    BATCH_MANAGEMENT,
    BATCH_MANAGEMENT_PLANT,
    TRANSPORTATION_GROUP,
    LOADING_GROUP,
    PROFIT_CENTER,
    MRP_TYPE,
    VALUATION_CATEGORY,
    PRICE_DETERMINATION,
    VALUATION_CLASS,
    VALUATION_CLASS_PROJECT_STOCK,
    MOVING_PRICE,
    STANDARD_PRICE
);

-- 2) Rename to the FDS column name the app writes (MATERIAL_DESC, SAP MAKTX).
ALTER TABLE VMS_MATERIALDATA RENAME COLUMN MATERIAL_DESCRIPTION TO MATERIAL_DESC;

-- 3) Align the survivors with the canonical DDL: widen INDUSTRY_SECTOR and add
--    the TICKET_TYPE / DIVISION defaults the live table was missing.
ALTER TABLE VMS_MATERIALDATA MODIFY (
    INDUSTRY_SECTOR VARCHAR2(4),
    TICKET_TYPE     DEFAULT 'Create',
    DIVISION        DEFAULT '90'
);

-- 4) TICKET_TYPE domain check (FLAG / ISRETREIVEDBYSAP checks already exist).
ALTER TABLE VMS_MATERIALDATA
    ADD CONSTRAINT CK_VMS_MATERIALDATA_TICKET
        CHECK (TICKET_TYPE IN ('Create', 'Extend', 'Change'));
