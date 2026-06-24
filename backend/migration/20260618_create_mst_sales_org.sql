-- Migration: mst_sales_org — ONE sales org per company (Non-Trade), replacing
-- the earlier 1-to-many seed. Source: user-provided company->sales-org list.
-- Date: 2026-06-18. Distribution channel is 80 (Non-Trade/Sample) for all.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mst_sales_org (
    id bigserial PRIMARY KEY,
    company_code varchar(20),
    sales_org_code varchar(20) NOT NULL,
    distribution_channel_code varchar(20),
    sales_org_description varchar(255),
    distribution_channel_description varchar(255),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mst_sales_org_company UNIQUE (company_code)
);
CREATE INDEX IF NOT EXISTS idx_mst_sales_org_company ON public.mst_sales_org (company_code);

-- Reseed: drop the old 1-to-many rows + old unique key, load 1-per-company.
TRUNCATE TABLE public.mst_sales_org;
ALTER TABLE public.mst_sales_org DROP CONSTRAINT IF EXISTS uq_mst_sales_org;
ALTER TABLE public.mst_sales_org DROP CONSTRAINT IF EXISTS uq_mst_sales_org_company;
ALTER TABLE public.mst_sales_org ADD CONSTRAINT uq_mst_sales_org_company UNIQUE (company_code);

INSERT INTO public.mst_sales_org (company_code, sales_org_code, distribution_channel_code, sales_org_description, distribution_channel_description) VALUES
    ('AC', 'ACNT', '80', 'AC NonTrade&Service', 'Non-Trade/Sample'),
    ('AG', 'AGNT', '80', 'AG NTrd (Service)', 'Non-Trade/Sample'),
    ('AJ', 'AJNT', '80', 'AJ NonTrade&Service', 'Non-Trade/Sample'),
    ('AM', 'AMNT', '80', 'AM NonTrade&Service', 'Non-Trade/Sample'),
    ('AN', 'ANNT', '80', 'AN NonTrade&Service', 'Non-Trade/Sample'),
    ('AR', 'ARNT', '80', 'AAG NonTrade&Service', 'Non-Trade/Sample'),
    ('AS', 'ASNT', '80', 'ASI NonTrade&Service', 'Non-Trade/Sample'),
    ('BM', 'BMNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('BN', 'BNNT', '80', 'KPBN Ntrd & Srvcs', 'Non-Trade/Sample'),
    ('BR', 'BRNT', '80', 'BR NTrd (Service)', 'Non-Trade/Sample'),
    ('BS', 'BSNT', '80', 'BS NonTrade&Service', 'Non-Trade/Sample'),
    ('BU', 'BUNT', '80', 'BU NonTrade&Service', 'Non-Trade/Sample'),
    ('CD', 'CDNT', '80', 'CD Nontrade&Service', 'Non-Trade/Sample'),
    ('CM', 'CMNT', '80', 'CM NonTrade&Service', 'Non-Trade/Sample'),
    ('CR', 'CRNT', '80', 'CR NonTrade&Service', 'Non-Trade/Sample'),
    ('CS', 'CSNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('EO', 'EONT', '80', 'EO NonTrade&Service', 'Non-Trade/Sample'),
    ('EU', 'EUNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('GF', 'GFNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('GM', 'GMNT', '80', 'GLM NonTrade&Service', 'Non-Trade/Sample'),
    ('GN', 'GNNT', '80', 'GN NonTrade&Service', 'Non-Trade/Sample'),
    ('GS', 'GSNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('GW', 'GWNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('HS', 'HSNT', '80', 'HS NonTrade&Service', 'Non-Trade/Sample'),
    ('IA', 'IANT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('IP', 'IPNT', '80', 'IP NonTrade&Service', 'Non-Trade/Sample'),
    ('IS', 'ISNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('IU', 'IUNT', '80', 'IU NonTrade&Service', 'Non-Trade/Sample'),
    ('JJ', 'JJNT', '80', 'JJ NonTrade&Service', 'Non-Trade/Sample'),
    ('JN', 'JNNT', '80', 'JPN NonTrade&Service', 'Non-Trade/Sample'),
    ('JP', 'JPNT', '80', 'JPN Ntrd & Srvcs', 'Non-Trade/Sample'),
    ('KA', 'KANT', '80', 'KA NTrd(Service)', 'Non-Trade/Sample'),
    ('KB', 'KBNT', '80', 'KB Ntrade (Nontrade)', 'Non-Trade/Sample'),
    ('KN', 'KNNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('KS', 'KSNT', '80', 'KS NonTrade&Service', 'Non-Trade/Sample'),
    ('KU', 'KUNT', '80', 'KU NonTrade&Service', 'Non-Trade/Sample'),
    ('LM', 'LMNT', '80', 'LM NTrd(Service)', 'Non-Trade/Sample'),
    ('MG', 'MGNT', '80', 'MPE NonTrade&Service', 'Non-Trade/Sample'),
    ('MM', 'MMNT', '80', 'MM NTrd(Service)', 'Non-Trade/Sample'),
    ('MS', 'MSNT', '80', 'AMS NonTrade&Service', 'Non-Trade/Sample'),
    ('MX', 'MXNT', '80', 'MX NTrd(Service)', 'Non-Trade/Sample'),
    ('ND', 'NDNT', '80', 'SAGS NonTrd (Local)', 'Non-Trade/Sample'),
    ('NJ', 'NJNT', '80', 'NJ NonTrade&Service', 'Non-Trade/Sample'),
    ('PA', 'PANT', '80', 'PA NTrd(Service)', 'Non-Trade/Sample'),
    ('PC', 'PCNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('PD', 'PDNT', '80', 'PD NonTrade&Service', 'Non-Trade/Sample'),
    ('PE', 'PENT', '80', 'PE NonTrade&Service', 'Non-Trade/Sample'),
    ('PI', 'PINT', '80', 'PI NTrd(Service)', 'Non-Trade/Sample'),
    ('PL', 'PLNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('PM', 'PMNT', '80', 'PM NonTrade&Service', 'Non-Trade/Sample'),
    ('PN', 'PNNT', '80', 'PN NonTrade&Service', 'Non-Trade/Sample'),
    ('PP', 'PPNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('PS', 'PSNT', '80', 'PS NonTrade&Service', 'Non-Trade/Sample'),
    ('PT', 'PTNT', '80', 'PT NonTrade&Service', 'Non-Trade/Sample'),
    ('PX', 'PXNT', '80', 'PEM NonTrade&Service', 'Non-Trade/Sample'),
    ('RB', 'RBNT', '80', 'RB NonTrade&Service', 'Non-Trade/Sample'),
    ('RF', 'RFNT', '80', 'RFI NonTrade&Service', 'Non-Trade/Sample'),
    ('RI', 'RINT', '80', 'RFI Ntrd & Srvcs', 'Non-Trade/Sample'),
    ('SA', 'SANT', '80', 'SA NonTrade&Service', 'Non-Trade/Sample'),
    ('SB', 'SBNT', '80', 'SB NonTrade&Service', 'Non-Trade/Sample'),
    ('SC', 'SCNT', '80', 'SPC NonTrade&Service', 'Non-Trade/Sample'),
    ('SD', 'SDNT', '80', 'SPI NonTrade&Service', 'Non-Trade/Sample'),
    ('SI', 'SINT', '80', 'SI NonTrade&Service', 'Non-Trade/Sample'),
    ('SN', 'SNNT', '80', 'SN NonTrade&Service', 'Non-Trade/Sample'),
    ('SS', 'SSNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('ST', 'STNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('SU', 'SUNT', '80', 'SU NonTrade&Service', 'Non-Trade/Sample'),
    ('SY', 'SYNT', '80', 'SY NTrd (Service)', 'Non-Trade/Sample'),
    ('TH', 'THNT', '80', 'TH NonTrade&Service', 'Non-Trade/Sample'),
    ('TP', 'TPNT', '80', 'TPG NonTrade&Service', 'Non-Trade/Sample'),
    ('TS', 'TSNT', '80', 'TS NonTrade&Service', 'Non-Trade/Sample'),
    ('UI', 'UINT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('WA', 'WANT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('WI', 'WINT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('WK', 'WKNT', '80', 'WK NTrd(Service)', 'Non-Trade/Sample'),
    ('WP', 'WPNT', '80', 'EUP NonTrade&Service', 'Non-Trade/Sample'),
    ('WS', 'WSNT', '80', 'WS NonTrade&Service', 'Non-Trade/Sample'),
    ('WW', 'WWNT', '80', 'WW NonTrade&Service', 'Non-Trade/Sample')
ON CONFLICT (company_code) DO UPDATE SET
    sales_org_code = EXCLUDED.sales_org_code,
    distribution_channel_code = EXCLUDED.distribution_channel_code,
    sales_org_description = EXCLUDED.sales_org_description,
    distribution_channel_description = EXCLUDED.distribution_channel_description,
    updated_at = NOW();

COMMIT;
