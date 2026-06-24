-- Drop mapping master tables that nothing uses: SAP derives valuation class from
-- its own ZMDMTVALCLASS (so we never stage VALUATION_CLASS), and VTWEG is
-- hardcoded '80' by SAP (so DISTRIBUTION_CHANNEL isn't staged either). Verified:
-- zero code references in backend or frontend; no inbound FKs.
-- (mst_sales_org is KEPT — SAP reads SALES_ORGANIZATION from the staging row and
--  it is per-company, derived via mst_plant.company_code -> mst_sales_org.)

DROP TABLE IF EXISTS public.mst_valuation_class;
DROP TABLE IF EXISTS public.mst_distribution_channel;
