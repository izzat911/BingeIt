const mysql = require("mysql2/promise");
require("dotenv").config();

const useSSL = process.env.DB_SSL === "true" || process.env.MYSQL_SSL === "true";

let pool;
if (process.env.DATABASE_URL || process.env.MYSQL_URL) {
    pool = mysql.createPool(process.env.DATABASE_URL || process.env.MYSQL_URL);
} else {
    pool = mysql.createPool({
        host: process.env.DB_HOST || process.env.MYSQLHOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
        user: process.env.DB_USER || process.env.MYSQLUSER || "root",
        password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
        database: process.env.DB_NAME || process.env.MYSQLDATABASE || "bingeit",
        waitForConnections: true,
        connectionLimit: 10,
        ssl: useSSL ? { rejectUnauthorized: false } : undefined
    });
}

module.exports = pool;
