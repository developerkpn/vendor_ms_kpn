-- Drop mat_reqedit: the material-edit email-notification pipeline was removed
-- (the 12 PM/6 PM crons in server.js, MaterialModel.EmailNotificationEditMaterial,
-- EmailModel.materialEditNotification, and helper/generateemailmaterial.js, plus the
-- mat_reqedit logging inserts in addAttachment/updateAliasesOnly).
-- Nothing reads or writes this table anymore.
-- Verified on dev (vendor_ms_dev): 0 inbound FK references (no CASCADE needed).
-- Run on dev and prod.

DROP TABLE IF EXISTS public.mat_reqedit;
