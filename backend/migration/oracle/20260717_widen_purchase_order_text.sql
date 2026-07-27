-- Widen VMS_MATERIALDATA.PURCHASE_ORDER_TEXT 132 -> 250.
-- The combined PO text (material description + long text) max was raised from
-- 160 to 250 chars: MAKTX column stays 40, the 3 long-text columns are now 70
-- each (3*70 + 2 newline separators = max 212 staged chars; 250 gives slack).
-- Run manually against SAPBRIDGE_D (dev) and SAPBRIDGE_P (prod).

ALTER TABLE VMS_MATERIALDATA MODIFY (PURCHASE_ORDER_TEXT VARCHAR2(210));
