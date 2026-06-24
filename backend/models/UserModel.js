const db = require("../config/connection.js");
const uuid = require("uuidv4");
const jwt = require("jsonwebtoken");
const { hashPassword, validatePassword } = require("../middleware/hashpass.js");
const TRANS = require("../config/transaction.js");
const crud = require("../helper/crudquery.js");
const moment = require("moment");
const PageModel = require("../models/PageModel.js");
const { param } = require("../routes/UserRoute.js");
const { buildLoginUserGroupInfo } = require("../services/materialService.js");

const User = {
    showAll: async ({ page, limit, search } = {}) => {
        const client = await db.connect();
        try {
            const row = await client.query(`
            SELECT us.user_id as id, us.fullname, us.username, us.email, sec.user_group_name, us.role, 
                TO_CHAR(us.created_at, 'mm-dd-yyyy') as created_at, 
                TO_CHAR(us.expired_date, 'mm-dd-yyyy') as expired_date,
                us.is_active
                FROM mst_user us
                LEFT JOIN (SELECT DISTINCT user_group_name, user_group_id from mst_page_access) sec on us.user_group = sec.user_group_id
UNION
SELECT us.mgr_id as id, us.fullname, us.username, us.email, sec.user_group_name, us.role, 
                TO_CHAR(us.created_at, 'mm-dd-yyyy') as created_at, 
                TO_CHAR(us.expired_date, 'mm-dd-yyyy') as expired_date,
                us.is_active
                FROM mst_mgr us
				LEFT JOIN (SELECT DISTINCT user_group_name, user_group_id from mst_page_access) sec on us.user_group = sec.user_group_id`);
            let rows = row.rows;

            // Optional backend search across name / username / email / role / group.
            const term = typeof search === "string" ? search.trim().toLowerCase() : "";
            if (term) {
                rows = rows.filter(user =>
                    [
                        user.fullname,
                        user.username,
                        user.email,
                        user.role,
                        user.user_group_name,
                    ].some(value => String(value ?? "").toLowerCase().includes(term))
                );
            }

            const total = rows.length;

            // Optional pagination — applied only when BOTH page and limit are valid
            // positive integers. Otherwise the full (filtered) list is returned, so
            // existing callers that pass no params keep the original { count, data }.
            const pageNum = Number.parseInt(page, 10);
            const limitNum = Number.parseInt(limit, 10);
            const paginate =
                Number.isInteger(pageNum) &&
                pageNum > 0 &&
                Number.isInteger(limitNum) &&
                limitNum > 0;

            const result = {
                count: total,
                data: paginate
                    ? rows.slice((pageNum - 1) * limitNum, (pageNum - 1) * limitNum + limitNum)
                    : rows,
            };
            if (paginate) {
                result.page = pageNum;
                result.limit = limitNum;
                result.totalPages = Math.ceil(total / limitNum);
            }
            return result;
        } catch (error) {
            console.error(error);
        } finally {
            client.release();
        }
    },
    createUser: async params => {
        const uidExist = params.user_id;
        let pass;
        let query, val;
        let submitState = "";
        if (uidExist != "") {
            submitState = "update";
        } else {
            submitState = "insert";
        }
        console.log(params);
        if (params.hasOwnProperty("password")) {
            pass = await hashPassword(params.password);
        }
        const token = jwt.sign(
            { username: params.username },
            process.env.TOKEN_KEY,
            { expiresIn: "1d" }
        );
        const startDate = params.createddate;
        const validDate = params.expireddate;
        const user_id = uidExist != "" ? uidExist : uuid.uuid();
        const fullname = params.fullname;
        const username = params.username;
        const email = params.email;
        const userGroup = params.usergroup;
        const mgr_id = params.mgr_id;
        const role = params.role;
        let userSubmit = {
            fullname: fullname,
            username: username,
            email: email,
            role: role,
            updated_at: moment().format("YYYY-MM-DD"),
            is_active: true,
            user_group: userGroup,
            user_id: user_id,
            mgr_id: mgr_id,
            token: token,
            bu_id: params.bu_id,
            bu_id_1: params.bu_id_1,
            bu_id_2: params.bu_id_2,
            gender: params.gender,
            dept_id: params.dept_id,
            emp_role_id: params.emp_role_id,
        };
        if (startDate) {
            userSubmit.created_at = moment(validDate).format("YYYY-MM-DD");
        }
        if (validDate) {
            userSubmit.expired_date = moment(validDate).format("YYYY-MM-DD");
        }
        if (params.hasOwnProperty("password")) {
            userSubmit.password = pass;
        }
        if (submitState == "insert") {
            [query, val] = crud.insertItem("mst_user", userSubmit, "username");
        } else {
            [query, val] = crud.updateItem(
                "mst_user",
                userSubmit,
                {
                    user_id: uidExist,
                },
                "username"
            );
        }

        let client;
        try {
            client = await db.connect();
            await client.query(TRANS.BEGIN);
            const insertUser = await client.query(query, val);
            await client.query(TRANS.COMMIT);
            return { name: insertUser.rows[0].username };
        } catch (error) {
            if (client) await client.query(TRANS.ROLLBACK);
            throw error;
        } finally {
            if (client) client.release();
        }
    },

    updateVendor: async params => {
        try {
            const client = await db.connect();
            try {
                await client.query(TRANS.BEGIN);
                const newpass = await hashPassword(params.password);
                const payload = {
                    fullname: params.fullname,
                    username: params.username,
                    password: newpass,
                    email: params.email,
                    updated_at: moment().format("YYYY-MM-DD"),
                };
                const [upque, upval] = crud.updateItem(
                    "a_uservendor",
                    payload,
                    { user_id: params.user_id }
                );
                await client.query(upque, upval);
                await client.query(TRANS.COMMIT);
                return {
                    name: params.fullname,
                };
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    showUserData: async idUser => {
        const client = await db.connect();
        const q = `SELECT * FROM (SELECT FULLNAME,
            USERNAME,
            PASSWORD,
            ROLE,
            USER_GROUP AS USERGROUP,
            USER_ID,
            MGR_ID,
            TO_CHAR(CREATED_AT, 'yyyy-mm-dd') AS DATECREATED,
            TO_CHAR(EXPIRED_DATE, 'yyyy-mm-dd') AS EXPIREDDATE ,
            GENDER,
            BU_ID,
            BU_ID_1,
            BU_ID_2,
            DEPT_ID, 
            EMP_ROLE_ID,
            EMAIL
        FROM MST_USER
        UNION ALL
        SELECT FULLNAME,
            USERNAME,
            PASSWORD,
            ROLE,
            USER_GROUP AS USERGROUP,
            MGR_ID AS USER_ID,
            '' AS MGR_ID,
            TO_CHAR(CREATED_AT, 'yyyy-mm-dd') AS DATECREATED,
            TO_CHAR(EXPIRED_DATE, 'yyyy-mm-dd') AS EXPIREDDATE ,
            GENDER,
            BU_ID,
            BU_ID_1,
            BU_ID_2,
            DEPT_ID, 
            EMP_ROLE_ID,
            EMAIL
        FROM MST_MGR
        UNION ALL
        SELECT FULLNAME,
            USERNAME,
            PASSWORD,
            'VENDOR' as ROLE,
            null AS USERGROUP,
            user_id AS USER_ID,
            '' AS MGR_ID,
              TO_CHAR(CREATED_AT, 'yyyy-mm-dd') AS DATECREATED,
            TO_CHAR(EXPIRED_DATE, 'yyyy-mm-dd') AS EXPIREDDATE ,
            null as GENDER,
            null as BU_ID,
            null as BU_ID_1,
            null as BU_ID_2,
            null as DEPT_ID, 
            null as EMP_ROLE_ID,
            EMAIL
        FROM a_uservendor
        ) AS userdata where user_id = $1`;
        try {
            const showUserbyId = await client.query(q, [idUser]);
            return {
                data: showUserbyId.rows[0],
            };
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    createManager: async params => {
        const uidExist = params.user_id;
        let pass = "";
        let query, val;
        if (uidExist != "") {
            submitState = "update";
        } else {
            submitState = "insert";
        }
        if (params.hasOwnProperty("password")) {
            pass = await hashPassword(params.password);
        }
        const token = jwt.sign(
            { username: params.username },
            process.env.TOKEN_KEY,
            { expiresIn: "1d" }
        );
        const currentdate = new Date().toLocaleDateString();
        const startDate = params.createddate;
        const validDate = params.expireddate;
        const user_id = uuid.uuid();
        const fullname = params.fullname;
        const username = params.username;
        const email = params.email;
        const userGroup = params.usergroup;
        const department = params.department;
        const role = params.role;
        const userSubmit = {
            fullname: fullname,
            username: username,
            email: email,
            role: role,
            created_at: moment(startDate).format("YYYY-MM-DD"),
            expired_date: moment(validDate).format("YYYY-MM-DD"),
            updated_at: moment(currentdate).format("YYYY-MM-DD"),
            is_active: true,
            department: department,
            user_group: userGroup,
            mgr_id: user_id,
            bu_id: params.bu_id,
            bu_id_1: params.bu_id_1,
            bu_id_2: params.bu_id_2,
            gender: params.gender,
            dept_id: params.dept_id,
            emp_role_id: params.emp_role_id,
            token: token,
        };
        if (params.hasOwnProperty("password")) {
            userSubmit.password = pass;
        }
        if (submitState == "insert") {
            [query, val] = crud.insertItem("mst_mgr", userSubmit, "username");
        } else {
            [query, val] = crud.updateItem(
                "mst_mgr",
                userSubmit,
                {
                    mgr_id: uidExist,
                },
                "username"
            );
        }
        let client;
        try {
            client = await db.connect();
            const insertUserMgr = await client.query(query, val);
            return { name: insertUserMgr.rows[0].username };
        } catch (error) {
            throw error.message;
        } finally {
            if (client) client.release();
        }
    },

    checkUserExist: async (user_email, username) => {
        const connect = await db.connect();
        try {
            let status = true;
            const messages = [];
            const checkExistemaila = await connect.query(
                `select user_id from mst_user where email = $1`,
                [user_email]
            );
            const checkExistemailb = await connect.query(
                `select user_id from mst_mgr where email = $1`,
                [user_email]
            );
            const checkExistUnamea = await connect.query(
                `select user_id from mst_user where username = $1`,
                [username]
            );
            const checkExistUnameb = await connect.query(
                `select user_id from mst_mgr where username = $1`,
                [username]
            );
            if (
                checkExistemaila.rowCount > 0 ||
                checkExistemailb.rowCount > 0
            ) {
                messages.push("Email already exist");
                status = false;
            }
            if (
                checkExistUnamea.rowCount > 0 ||
                checkExistUnameb.rowCount > 0
            ) {
                messages.push("Username already exist");
                status = false;
            }
            if (status) {
                return {
                    status: true,
                };
            } else {
                return {
                    status: false,
                    message: messages,
                };
            }
        } catch (error) {
            return {
                status: false,
                error: error.message,
            };
        } finally {
            connect.release();
        }
    },
    loginUser: async ({ username, password }) => {
        const client = await db.connect();
        let transactionStarted = false;
        try {
            // add union to a_uservendor
            const userData = await client.query(
                `SELECT * FROM 
                (SELECT USERNAME,
                    PASSWORD,
                    FULLNAME,
                    ROLE,
                    USER_GROUP,
                    USER_ID,
                    EMAIL,
                    EMP_ROLE_ID,
                    BU_ID,
                    DEPT_ID,
                    IS_ACTIVE
                FROM MST_USER
                UNION
                SELECT USERNAME,
                    PASSWORD,
                    FULLNAME,
                    ROLE,
                    USER_GROUP,
                    MGR_ID AS USER_ID,
                    EMAIL,
                    EMP_ROLE_ID,
                    BU_ID,
                    DEPT_ID,
                    IS_ACTIVE
                FROM MST_MGR
                UNION
                SELECT USERNAME,
                    PASSWORD,
                    FULLNAME,
                    DEPARTMENT AS ROLE,
                    GROUP_ID AS USER_GROUP,
                    USER_ID,
                    EMAIL,
                    'VENDOR' as EMP_ROLE_ID,
                    '' as BU_ID,
                    '' as DEPT_ID,
                    IS_ACTIVE
                FROM A_USERVENDOR)
                AS user_vms
                where USERNAME = $1`,
                [username]
            );
            if (userData.rows.length === 0) {
                throw new Error("User not found");
            }
            const userGroup = userData.rows[0].user_group;
            const userGroupInfoResult = await client.query(
                `SELECT DISTINCT
                    user_group_id,
                    user_group_name
                FROM mst_page_access
                WHERE user_group_id = $1
                    AND user_group_name IS NOT NULL
                ORDER BY user_group_name`,
                [userGroup]
            );
            const userGroupInfo = buildLoginUserGroupInfo(
                userGroupInfoResult.rows,
                userGroup
            );
            const getAuthorization = await client.query(
                `
            SELECT 
                            PG.MENU_ID AS "id",
                            PG.PAGE,
                            case
                                when acs.fcreate then acs.fcreate
                                else false 
                            end
                            as "fcreate",
                            case
                                when acs.fread then acs.fread
                                else false 
                            end
                            as "fread",
                            case
                                when acs.fupdate then acs.fupdate
                                else false 
                            end
                            as "fupdate",
                            case
                                when acs.fdelete then acs.fdelete
                                else false
                            end
                            as "fdelete"
                            FROM MST_PAGE PG
                            LEFT JOIN 
                            MST_PAGE_ACCESS 
                            ACS ON ACS.PAGE_ID = PG.MENU_ID AND ACS.user_group_id = $1
                        order by PG.parent_id asc, is_parent asc
            `,
                [userGroup]
            );
            let authPerm = {};
            getAuthorization.rows.map(item => {
                authPerm[item.page] = {
                    create: item.fcreate,
                    read: item.fread,
                    update: item.fupdate,
                    delete: item.fdelete,
                };
            });
            if (!userData.rows[0].is_active) {
                throw new Error("User is inactive");
            }
            const hashed = userData.rows[0].password;
            // console.log(userData.rows[0]);
            const valid = await validatePassword({ password, hashed });
            if (valid === false) {
                throw new Error("Password false");
            }
            const resdata = userData.rows[0];
            accessToken = jwt.sign(
                {
                    user_id: resdata.user_id,
                    username: resdata.username,
                    role: resdata.role,
                    emp_role_id: resdata.emp_role_id,
                    bu_id: resdata.bu_id,
                    dept_id: resdata.dept_id,
                    groupid: resdata.user_group,
                },
                process.env.TOKEN_KEY,
                { expiresIn: "15m" }
            );
            refreshToken = jwt.sign(
                {
                    user_id: resdata.user_id,
                    username: resdata.username,
                    role: resdata.role,
                    emp_role_id: resdata.emp_role_id,
                    bu_id: resdata.bu_id,
                    dept_id: resdata.dept_id,
                    groupid: resdata.user_group,
                },
                process.env.TOKEN_KEY,
                {
                    expiresIn: "7d" }
            );
            await client.query(TRANS.BEGIN);
            transactionStarted = true;
            let is_reset_pwd = null;
            if (resdata.role === "MGR") {
                await client.query(
                    "UPDATE MST_MGR set token = $1 where mgr_id = $2",
                    [refreshToken, resdata.user_id]
                );
            } else if (resdata.role === "VENDOR") {
                // IF USER VENDOR, CHECK RESET PASS
                // SELECT IS_RESET_PWD
                const resIsPwd = await client.query(
                    `SELECT is_reset_pwd FROM a_uservendor WHERE user_id = $1`,
                    [resdata.user_id]
                );
                // console.log(resIsPwd);
                is_reset_pwd = resIsPwd.rows[0].is_reset_pwd;
                await client.query(
                    "UPDATE a_uservendor SET token = $1 where user_id = $2",
                    [refreshToken, resdata.user_id]
                );
            } else {
                await client.query(
                    "UPDATE MST_USER SET token = $1 where user_id = $2",
                    [refreshToken, resdata.user_id]
                );
            }
            await client.query(TRANS.COMMIT);
            transactionStarted = false;
            return {
                fullname: resdata.fullname,
                username: resdata.username,
                user_id: resdata.user_id,
                email: resdata.email,
                role: resdata.role,
                accessToken: accessToken,
                permission: authPerm,
                groupid: userGroup,
                ...userGroupInfo,
                emp_role_id: resdata.emp_role_id,
                bu_id: resdata.bu_id,
                dept_id: resdata.dept_id,
                is_reset_pwd: is_reset_pwd,
            };
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query(TRANS.ROLLBACK);
                } catch (rollbackError) {
                    console.error("Login rollback failed:", rollbackError);
                }
            }
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    GetDataUser: async ({ user_id }) => {
        try {
            const client = await db.connect();
            try {
                const userData = await client.query(
                    `SELECT * FROM 
                    (select
                        USERNAME,
                        password,
                        FULLNAME,
                        role,
                        USER_GROUP,
                        USER_ID,
                        EMAIL,
                        emp_role_id,
                        dept_id,
                        bu_id,
                        IS_ACTIVE
                    from
                        MST_USER
                    union
                                        select
                        USERNAME,
                        password,
                        FULLNAME,
                        role,
                        USER_GROUP,
                        MGR_ID as USER_ID,
                        EMAIL,
                        emp_role_id,
                        dept_id,
                        bu_id,
                        IS_ACTIVE
                    from
                        MST_MGR
                    union
                                        select
                        USERNAME,
                        password,
                        FULLNAME,
                        DEPARTMENT as role,
                        GROUP_ID as USER_GROUP,
                        USER_ID,
                        EMAIL,
                        'VENDOR' as emp_role_id,
                        '' as dept_id,
                        '' as bu_id,
                        IS_ACTIVE
                    from
                        A_USERVENDOR)
                    AS user_vms
                    where USER_ID = $1`,
                    [user_id]
                );
                if (userData.rows.length === 0) {
                    throw new Error("User not found");
                }
                const user = userData.rows[0];
                const getAuthorization = await client.query(
                    `
                    SELECT 
                                    PG.MENU_ID AS "id",
                                    PG.PAGE,
                                    case
                                        when acs.fcreate then acs.fcreate
                                        else false 
                                    end
                                    as "fcreate",
                                    case
                                        when acs.fread then acs.fread
                                        else false 
                                    end
                                    as "fread",
                                    case
                                        when acs.fupdate then acs.fupdate
                                        else false 
                                    end
                                    as "fupdate",
                                    case
                                        when acs.fdelete then acs.fdelete
                                        else false
                                    end
                                    as "fdelete"
                                    FROM MST_PAGE PG
                                    LEFT JOIN 
                                    MST_PAGE_ACCESS 
                                    ACS ON ACS.PAGE_ID = PG.MENU_ID AND ACS.user_group_id = $1
                                order by PG.parent_id asc, is_parent asc
                    `,
                    [user.user_group]
                );
                let authPerm = {};
                getAuthorization.rows.map(item => {
                    authPerm[item.page] = {
                        create: item.fcreate,
                        read: item.fread,
                        update: item.fupdate,
                        delete: item.fdelete,
                    };
                });
                if (user.role === "VENDOR") {
                    // IF USER VENDOR, CHECK RESET PASS
                    // SELECT IS_RESET_PWD
                    const resIsPwd = await client.query(
                        `SELECT is_reset_pwd FROM a_uservendor WHERE user_id = $1`,
                        [user_id]
                    );
                    // console.log(resIsPwd);
                    is_reset_pwd = resIsPwd.rows[0].is_reset_pwd;
                } else {
                    is_reset_pwd = true;
                }
                const { jsonMenu: menu } = await PageModel.showAll(
                    user.user_group,
                    user.username
                );
                return {
                    fullname: user.fullname,
                    username: user.username,
                    user_id: user.user_id,
                    email: user.email,
                    role: user.role,
                    emp_role_id: user.emp_role_id,
                    dept_id: user.dept_id,
                    bu_id: user.bu_id,
                    permission: authPerm,
                    groupid: user.user_group,
                    is_reset_pwd: is_reset_pwd,
                    menu: menu,
                };
            } catch (error) {
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },

    getAuthorization: async userGroup => {
        const client = await db.connect();
        try {
            const getAuthorization = await client.query(
                `
            SELECT 
                            PG.MENU_ID AS "id",
                            PG.PAGE,
                            case
                                when acs.fcreate then acs.fcreate
                                else false 
                            end
                            as "fcreate",
                            case
                                when acs.fread then acs.fread
                                else false 
                            end
                            as "fread",
                            case
                                when acs.fupdate then acs.fupdate
                                else false 
                            end
                            as "fupdate",
                            case
                                when acs.fdelete then acs.fdelete
                                else false
                            end
                            as "fdelete"
                            FROM MST_PAGE PG
                            LEFT JOIN 
                            MST_PAGE_ACCESS 
                ACS ON ACS.PAGE_ID = PG.MENU_ID AND ACS.user_group_id = $1
                    order by PG.parent_id asc, is_parent asc
            `,
                [userGroup]
            );
            let authPerm = {};
            getAuthorization.rows.map(item => {
                authPerm[item.page] = {
                    create: item.fcreate,
                    read: item.fread,
                    update: item.fupdate,
                    delete: item.fdelete,
                };
            });
            return authPerm;
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    showExistSecGrp: async () => {
        const client = await db.connect();
        try {
            const q = `select distinct 
                        user_group_name, 
                        user_group_id, 
                        TO_CHAR(created_at, 'mm/dd/yyyy') as createddate
                        from mst_page_access`;
            const userGroups = await client.query(q);
            return {
                count: userGroups.rowCount,
                data: userGroups.rows,
            };
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    },

    showSecurityGroup: async group_id => {
        const client = await db.connect();
        try {
            let secName = "";
            if (group_id !== "") {
                const secNameq = `
                                SELECT 
                                    distinct user_group_name
                                from
                                    mst_page_access where user_group_id = $1 ;
                `;
                const getname = await client.query(secNameq, [group_id]);
                secName = getname.rows[0].user_group_name;
            }
            const secMtxq = `SELECT 
                                PG.MENU_ID AS "id",
                                PG.PAGE,
                                case
                                    when acs.fcreate then acs.fcreate
                                    else false 
                                end
                                as "fcreate",
                                case
                                    when acs.fread then acs.fread
                                    else false 
                                end
                                as "fread",
                                case
                                    when acs.fupdate then acs.fupdate
                                    else false 
                                end
                                as "fupdate",
                                case
                                    when acs.fdelete then acs.fdelete
                                    else false
                                end
                                as "fdelete"
                                FROM MST_PAGE PG
                                LEFT JOIN 
                                MST_PAGE_ACCESS 
                                ACS ON ACS.PAGE_ID = PG.MENU_ID AND ACS.user_group_id = $1
                            order by PG.parent_id asc, is_parent asc
                            `;
            const secMtx = await client.query(
                secMtxq,
                group_id ? [group_id] : [""]
            );
            return {
                name: secName,
                count: secMtx.rowCount,
                data: secMtx.rows,
            };
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    },

    submitSecurityGroup: async (groupname, groupid, accessmtx) => {
        const connect = await db.connect();
        try {
            let group_id = groupid;
            await connect.query(TRANS.BEGIN);
            if (group_id != "") {
                await connect.query(
                    `delete from mst_page_access where user_group_id = $1 ;`,
                    [group_id]
                );
            }
            if (group_id == "") {
                group_id = uuid.uuid();
            }
            const promisesSubmit = accessmtx.map(item => {
                const insertedItem = {
                    user_group_id: group_id,
                    user_group_name: groupname,
                    page_id: item.id,
                    fcreate: item.fcreate,
                    fread: item.fread,
                    fupdate: item.fupdate,
                    fdelete: item.fdelete,
                };
                const [query, val] = crud.insertItem(
                    "mst_page_access",
                    insertedItem,
                    "user_group_name"
                );
                return connect.query(query, val);
            });

            const insertion = await Promise.all([
                ...promisesSubmit,
                connect.query(TRANS.COMMIT),
            ]);
            return {
                name: insertion[0].rows[0].user_group_name,
            };
        } catch (error) {
            await connect.query(TRANS.ROLLBACK);
            console.error(error);
            throw error;
        } finally {
            connect.release();
        }
    },

    showRole: async () => {
        const client = await db.connect();
        try {
            const q = `select id_role, role from mst_role`;
            const roles = await client.query(q);
            return {
                count: roles.rowCount,
                data: roles.rows,
            };
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    showManagers: async () => {
        const client = await db.connect();
        try {
            const q = `select mgr_id, fullname from mst_mgr`;
            const managers = await client.query(q);
            return {
                count: managers.rowCount,
                data: managers.rows,
            };
        } catch (error) {
            console.error(error);
            throw error;
        } finally {
            client.release();
        }
    },

    ResetPassVendor: async (password, user_id) => {
        try {
            const client = await db.connect();
            try {
                const { rows: user_data } = await client.query(
                    `
                    select password from a_uservendor where user_id = $1
                    `,
                    [user_id]
                );
                let hashedPass = user_data[0].password;
                if (!hashedPass) {
                    throw new Error("Password not set");
                }
                await client.query(TRANS.BEGIN);
                const verif = await validatePassword({
                    password,
                    hashed: hashedPass,
                });
                if (verif) {
                    throw new Error(
                        "Please set new password, inputted password is same with latest"
                    );
                }
                let new_pass = await hashPassword(password);
                const [queUp, valUp] = crud.updateItem(
                    "a_uservendor",
                    {
                        is_reset_pwd: true,
                        password: new_pass,
                    },
                    { user_id: user_id },
                    "user_id"
                );
                await client.query(queUp, valUp);
                await client.query(TRANS.COMMIT);
            } catch (error) {
                await client.query(TRANS.ROLLBACK);
                throw error;
            } finally {
                client.release();
            }
        } catch (error) {
            throw error;
        }
    },
};

module.exports = User;
