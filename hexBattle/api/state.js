import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB
});

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { uuid } = req.query;
    const [rows] = await pool.query("SELECT state FROM matches WHERE uuid=?", [uuid]);
    if (rows.length === 0) return res.status(404).json({ error: "match not found" });
    res.status(200).json(JSON.parse(rows[0].state));
  }
}