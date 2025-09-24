import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 2
});

export default async function handler(req, res) {
  try {
    const [rows] = await pool.query("SELECT 1+1 AS ok");
    return res.status(200).json({ ok: rows[0].ok });
  } catch (err) {
    console.error('pingdb error:', err);
    return res.status(500).json({ error: err.message });
  }
}
