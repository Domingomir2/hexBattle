import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB
});

export default async function handler(req, res) {
  if (req.method === "GET") {
    const [rows] = await pool.query("SELECT username, scenario FROM lobby_connections WHERE status='waiting'");
    res.status(200).json(rows);
  }
  if (req.method === "POST") {
    const { username, scenario } = req.body;
    await pool.execute(
      "INSERT INTO lobby_connections (username, scenario, status) VALUES (?, ?, 'waiting')",
      [username, scenario]
    );
    res.status(200).json({ ok: true });
  }
}