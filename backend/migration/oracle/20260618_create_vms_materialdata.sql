-- ============================================================================
-- ORACLE DDL — run against the SAP-bridge ORACLE schema, NOT Postgres.
-- Connect as the SAP-bridge user (dev SAPBRIDGE_D / prod SAPBRIDGE_P). The table
-- is created UNQUALIFIED so it lives under the connecting user's own schema —
-- never hardcode the schema prefix. Oracle has no "CREATE TABLE IF NOT EXISTS";
-- run once (ORA-00955 is raised if it already exists).
-- ============================================================================
-- Staging table the SAP bridge job pulls to create/update the material master
-- via BAPI_MATERIAL_SAVEDATA — one row per completed single-material request.
-- Columns follow the FDS "Data Staging" table: SAP reads the material fields
-- below, hardcodes the rest (tax, batch, MRP, price, transport/loading,
-- distribution channel…) and derives PROFIT_CTR / VAL_CLASS from its own
-- Z-tables (ZEXMAT_PRCTR / ZMDMTVALCLASS), so those are NOT staged here. Column
-- names are human-readable; SAP maps them onto MATNR/MTART/… (noted per column).
-- Control columns follow the goods-movement convention: FLAG ('I' create / 'U'
-- change|extend), ISRETREIVEDBYSAP (SAP sets TRUE on pull), ERRORMSG_PULL/POST,
-- SYNCED_MATERIAL_NUMBER (write-back), + audit.

CREATE TABLE VMS_MATERIALDATA (
    APP_REQUEST_NO          VARCHAR2(30) NOT NULL,
    TICKET_TYPE             VARCHAR2(10) DEFAULT 'Create'
                                CHECK (TICKET_TYPE IN ('Create', 'Extend', 'Change')),

    -- ===== Material fields (per FDS Data Staging table) =====
    MATERIAL_NUMBER         VARCHAR2(40),        -- SAP MATNR (MARA)
    MATERIAL_TYPE           VARCHAR2(4),         -- SAP MTART (MARA)
    INDUSTRY_SECTOR         VARCHAR2(4),         -- SAP MBRSH (MARA; wider: VMS 'SPAR' > 1)
    PLANT                   VARCHAR2(4),         -- SAP WERKS (MARC)
    STORAGE_LOCATION        VARCHAR2(4),         -- SAP LGORT (MARD)
    SALES_ORGANIZATION      VARCHAR2(4),         -- SAP VKORG (MVKE)
    MATERIAL_DESC           VARCHAR2(40),        -- SAP MAKTX (MAKT)
    BASE_UOM                VARCHAR2(3),         -- SAP MEINS (MARA)
    MATERIAL_GROUP          VARCHAR2(9),         -- SAP MATKL (MARA)
    DIVISION                VARCHAR2(2) DEFAULT '90', -- SAP SPART (MARA)
    PURCHASE_ORDER_TEXT     VARCHAR2(132),       -- SAP TDLINE (STXH/STXL)

    -- ===== Audit =====
    CREATED_AT              VARCHAR2(10),        -- Date returned from SAP material created
    APPROVED_AT              VARCHAR2(10),       -- Current date MDM approved at 
    CREATED_BY              VARCHAR2(100),       -- SAP User id 
    APPROVED_BY              VARCHAR2(100),      -- Local mst_user email

    -- ===== SAP-bridge control columns =====
    FLAG                    VARCHAR2(1) DEFAULT 'I'
                                CHECK (FLAG IN ('I', 'S', 'E')),
    ISRETREIVEDBYSAP        VARCHAR2(5) DEFAULT 'FALSE'
                                CHECK (ISRETREIVEDBYSAP IN ('TRUE', 'FALSE')),
    ERRORMSG_POST           VARCHAR2(100),

    CONSTRAINT PK_VMS_MATERIALDATA PRIMARY KEY (APP_REQUEST_NO)
);
