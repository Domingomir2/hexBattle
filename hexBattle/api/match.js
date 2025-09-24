import mysql from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB
});

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { username, scenario } = req.body;
    // Buscar otro jugador esperando
    const [rows] = await pool.query(
      "SELECT * FROM lobby_connections WHERE status='waiting' AND scenario=? LIMIT 1",
      [scenario]
    );
    if (rows.length === 0) {
      return res.status(200).json({ status: "waiting" });
    }
    const opponent = rows[0];
    const matchUuid = uuidv4();
    const initialState = { uuid: matchUuid, scenario, units: [], terrain: [], turn: 1, history: [] };

    const [resMatch] = await pool.execute(
      "INSERT INTO matches (uuid, state, status) VALUES (?, ?, 'playing')",
      [matchUuid, JSON.stringify(initialState)]
    );
    const matchId = resMatch.insertId;

    await pool.execute("UPDATE lobby_connections SET status='matched' WHERE id IN (?,?)", [opponent.id, opponent.id]);

    await pool.execute(
      "INSERT INTO match_players (match_id, username, player_number) VALUES (?,?,1),(?,?,2)",
      [matchId, username, matchId, opponent.username]
    );

    res.status(200).json({ status: "matched", uuid: matchUuid, state: initialState, players: [username, opponent.username] });
  }
}