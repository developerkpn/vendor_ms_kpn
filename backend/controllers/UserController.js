const User = require("../models/UserModel");
const jwt = require("jsonwebtoken");
const db = require("../config/connection");
const TRANS = require("../config/transaction");
const crud = require("../helper/crudquery");
const { hashPassword } = require("../middleware/hashpass");
const PageModel = require("../models/PageModel");

const getReadableError = err => {
    const rawMessage =
        err?.message || err?.stack || (typeof err === "string" ? err : null);
    const code = err?.code;
    const message = rawMessage || "Internal server error";

    if (
        [
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EHOSTUNREACH",
            "EACCES",
        ].includes(code) ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EHOSTUNREACH") ||
        message.includes("EACCES")
    ) {
        return "Database connection failed. Check office network or VPN access, then verify the PostgreSQL host is reachable.";
    }

    return message;
};

const UserController = {
    showAll: async (req, res) => {
        try {
            // Optional pagination + search. Omit page/limit to get all rows
            // (unchanged behavior for existing callers). Aliases: pageSize, q.
            const { page, limit, pageSize, search, q } = req.query || {};
            let data = await User.showAll({
                page,
                limit: limit ?? pageSize,
                search: search ?? q,
            });
            res.status(200).send(data);
        } catch (err) {
            console.error(err);
            res.status(500).send({
                message: "Server Error",
            });
        }
    },
    loginUser: async (req, res) => {
        try {
            const logData = await User.loginUser({
                username: req.body.username,
                password: req.body.password,
            });
            const { jsonMenu, nameMenu } = await PageModel.showAll(
                logData.groupid,
                logData.username
            );

            // res.cookie("jwt", logData.refreshToken, {
            //     httpOnly: true,
            //     secure: false,
            //     sameSite: false,
            //     maxAge: 7 * 24 * 60 * 60 * 1000,
            // });
            // console.log(logData);
            res.status(200).send({
                ...logData,
                menu: jsonMenu,
            });
        } catch (err) {
            console.log(err);
            res.status(500).send({
                message: getReadableError(err),
            });
        }
    },

    GetDataUser: async (req, res) => {
        try {
            const { user_id } = req.cookies;
            const data_user = await User.GetDataUser({ user_id: user_id });
            res.status(200).send({
                ...data_user,
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({
                message: error.message,
            });
        }
    },

    getAuthorization: async (req, res) => {
        try {
            const group_id = req.body.group_id;
            const dataAuth = await User.getAuthorization(group_id);
            res.status(200).send(dataAuth);
        } catch (error) {
            console.error(error);
            res.status(500).send(error);
        }
    },

    refreshToken: async (req, res) => {
        let client;
        try {
            let headers =
                req.headers.Authorization || req.headers.authorization;
            let token = headers?.split(" ")[1];
            if (!token) {
                return res.status(401).send({
                    message: "Unauthorized",
                });
            }
            const cookies = jwt.verify(token, process.env.TOKEN_KEY, {
                ignoreExpiration: true,
            });
            client = await db.connect();
            let refToken_q = "";
            if (cookies.role == "VENDOR") {
                refToken_q = `select token from a_uservendor where user_id = '${cookies.user_id}'`;
            } else if (cookies.role !== "MGR") {
                refToken_q = `select token from mst_user where user_id = '${cookies.user_id}'`;
            } else {
                refToken_q = `select token from mst_mgr where mgr_id = '${cookies.user_id}'`;
            }
            const getrefToken = await client.query(refToken_q);
            const refToken = getrefToken.rows[0].token;
            const verif = jwt.verify(refToken, process.env.TOKEN_KEY);
            const newAct = jwt.sign(
                {
                    user_id: cookies.user_id,
                    username: cookies.username,
                    role: cookies.role,
                    emp_role_id: cookies.emp_role_id,
                    bu_id: cookies.bu_id,
                    dept_id: cookies.dept_id,
                },
                process.env.TOKEN_KEY,
                {
                    expiresIn: "15m",
                }
            );
            res.status(200).send({
                accessToken: newAct,
            });
        } catch (error) {
            console.error(error);
            res.status(401).send({
                message: "Login Expired",
            });
        } finally {
            if (client) client.release();
        }
    },

    check: (req, res) => {
        res.status(200).send({
            data: "no",
        });
    },

    showExistSecGrp: async (req, res) => {
        try {
            const existGrp = await User.showExistSecGrp();
            res.status(200).send(existGrp);
        } catch (error) {
            console.error(error);
            res.status(500).send(error);
        }
    },

    showSecurityGroup: async (req, res) => {
        const groupid = req.body.groupid;
        try {
            const pages = await User.showSecurityGroup(groupid);
            res.status(200).send(pages);
        } catch (error) {
            res.status(500).send({
                message: error.stack,
            });
        }
    },

    submitSecurityGroup: async (req, res) => {
        const groupname = req.body.groupname;
        const groupid = req.body.groupid;
        const accessmtx = req.body.accessmtx;
        try {
            const submit = await User.submitSecurityGroup(
                groupname,
                groupid,
                accessmtx
            );
            const submitted = submit.name;
            res.status(200).send({
                message: `${submitted} group has submitted`,
            });
        } catch (error) {
            console.error(error.stack);
            res.status(500).send({
                message: error.stack,
            });
        }
    },

    showRole: async (req, res) => {
        try {
            const roles = await User.showRole();
            res.status(200).send(roles);
        } catch (error) {
            res.status(500).send({
                message: error,
            });
        }
    },

    showManagers: async (req, res) => {
        try {
            const managers = await User.showManagers();
            res.status(200).send(managers);
        } catch (error) {
            res.status(500).send({
                message: error,
            });
        }
    },

    createNewUser: async (req, res) => {
        const Dt = req.body;
        console.log(Dt);
        if (req.body.hasOwnProperty("password")) {
            Dt.password = req.body.password;
        }
        try {
            let submitDt;
            if (Dt.role == "VENDOR") {
                submitDt = await User.updateVendor(Dt);
            } else if (Dt.mgr_id === "") {
                submitDt = await User.createManager(Dt);
            } else {
                submitDt = await User.createUser(Dt);
            }
            // console.log(submitDt);
            res.status(200).send({
                message: `success created ${submitDt.name}`,
            });
        } catch (error) {
            console.error(error);
            res.status(500).send(error);
        }
    },

    showUserData: async (req, res) => {
        const idUser = req.query.iduser;
        try {
            const userId = await User.showUserData(idUser);
            res.status(200).send(userId);
        } catch (error) {
            console.error(error);
            res.status(500).send({
                message: "failed to fetch data",
            });
        }
    },

    otpresetPassword: async (req, res) => {
        const client = await db.connect();
        try {
            const user_id = req.cookies.user_id;
            let vendor = false;
            const resetPwd = req.body.newpwd;
            if (resetPwd === undefined || resetPwd === "") {
                throw new Error("Please provide new password");
            }
            if (user_id === "" || user_id === undefined) {
                throw new Error("User is missing");
            }
            let pass = "";

            await client.query(TRANS.BEGIN);
            const { rows: check_who } = await client.query(
                `
                select
                        *
                    from
                        (
                        select
                            user_id,
                            username,
                            'USER' as who
                        from
                            all_users au
                    union all
                        select
                            user_id,
                            username,
                            'VENDOR' as who
                        from
                            a_uservendor uav) a
                    where
                        user_id = $1
                `,
                [user_id]
            );
            if (check_who[0].who == "VENDOR") {
                vendor = true;
            }
            const checkExist = await client.query(
                `select inserted from otp_transaction where user_id = '${user_id}'`
            );
            if (checkExist.rowCount === 0) {
                throw new Error("OTP not requested");
            }
            const isOtpValidated = checkExist.rows[0]?.inserted;
            if (isOtpValidated) {
                pass = await hashPassword(resetPwd);
            } else {
                throw new Error("OTP not validated");
            }
            const items = {
                password: pass,
            };
            let [que, val] = ["", ""];
            if (vendor) {
                [que, val] = crud.updateItem(
                    "a_uservendor",
                    { ...items, is_reset_pwd: true },
                    { user_id: user_id },
                    "username"
                );
            } else {
                [que, val] = crud.updateItem(
                    "mst_user",
                    items,
                    { user_id: user_id },
                    "username"
                );
            }
            const resetPass = await client.query(que, val);
            const otpdelete = await client.query(
                `delete from otp_transaction where user_id = '${user_id}'`
            );
            res.status(200).send({
                message: `${resetPass.rows[0].username} password have been reseted`,
            });
            await client.query(TRANS.COMMIT);
        } catch (error) {
            await client.query(TRANS.ROLLBACK);
            console.log(error);
            res.status(500).send({
                message: error.message,
            });
        } finally {
            client.release();
        }
    },

    updateStatUser: async (req, res) => {
        const id = req.body.id;
        const role = req.body.role;
        const is_active = req.body.is_active;
        const client = await db.connect();
        let query, val;
        try {
            await client.query(TRANS.BEGIN);
            if (role === "MGR") {
                [query, val] = crud.updateItem(
                    "mst_mgr",
                    { is_active: is_active },
                    { mgr_id: id },
                    "username"
                );
            } else {
                [query, val] = crud.updateItem(
                    "mst_user",
                    { is_active: is_active },
                    { user_id: id },
                    "username"
                );
            }
            const setStat = await client.query(query, val);
            await client.query(TRANS.COMMIT);
            res.status(200).send({
                message: `${setStat.rows[0].username} is updated`,
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({
                message: error.message,
            });
        } finally {
            client.release();
        }
    },

    ResetPassVendor: async (req, res) => {
        try {
            const { password } = req.body;
            const { user_id } = req.cookies;
            const reset_pass = await User.ResetPassVendor(password, user_id);
            res.status(200).send({
                message: "Password successfully reset",
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({
                message: error.message,
            });
        }
    },
};

module.exports = UserController;
