ALTER TABLE VMS_MATERIALDATA RENAME COLUMN UPDATED_AT TO APPROVED_AT;
ALTER TABLE VMS_MATERIALDATA RENAME COLUMN UPDATED_BY TO APPROVED_BY;

ALTER TABLE VMS_MATERIALDATA DROP (ERRORMSG_PULL, SYNCED_MATERIAL_NUMBER);

UPDATE VMS_MATERIALDATA SET FLAG = 'I' WHERE FLAG NOT IN ('I', 'S', 'E');

DECLARE
    v_constraint_name USER_CONSTRAINTS.CONSTRAINT_NAME%TYPE;
BEGIN
    SELECT c.constraint_name
      INTO v_constraint_name
      FROM user_constraints c
      JOIN user_cons_columns cc
        ON cc.constraint_name = c.constraint_name
       AND cc.table_name = c.table_name
     WHERE c.table_name = 'VMS_MATERIALDATA'
       AND c.constraint_type = 'C'
       AND cc.column_name = 'FLAG';
    EXECUTE IMMEDIATE
        'ALTER TABLE VMS_MATERIALDATA DROP CONSTRAINT ' || v_constraint_name;
EXCEPTION
    WHEN NO_DATA_FOUND THEN NULL;  -- nothing to drop (already migrated)
END;
/

ALTER TABLE VMS_MATERIALDATA
    ADD CONSTRAINT CK_VMS_MATERIALDATA_FLAG CHECK (FLAG IN ('I', 'S', 'E'));

