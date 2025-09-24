import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB
});

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { uuid, player, actionType, payload, newState } = req.body;
    const [rows] = await pool.query("SELECT id FROM matches WHERE uuid=?", [uuid]);
    if (rows.length === 0) return res.status(404).json({ error: "match not found" });
    const matchId = rows[0].id;
    await pool.execute(
      "INSERT INTO match_actions (match_id, player_number, action_type, payload) VALUES (?,?,?,?)",
      [matchId, player, actionType, JSON.stringify(payload)]
    );
    if (newState) {
      await pool.execute("UPDATE matches SET state=? WHERE id=?", [JSON.stringify(newState), matchId]);
    }
    res.status(200).json({ ok: true });
  }
}