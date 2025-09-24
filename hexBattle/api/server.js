require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

/* MySQL pool */
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10
});

/* Estado en memoria */
const waitingQueue = []; // [{ socketId, username, scenario }]
const matchesInMemory = new Map(); // matchUuid -> { state, players: [socketId,...], lastUpdate }

async function saveLobbyConnection(socketId, username, scenario) {
  await pool.execute(
    `INSERT INTO lobby_connections (socket_id, username, scenario, status) VALUES (?, ?, ?, 'waiting')`,
    [socketId, username, scenario]
  );
}
async function removeLobbyConnection(socketId) {
  await pool.execute(
    `UPDATE lobby_connections SET status='disconnected' WHERE socket_id = ?`, [socketId]
  );
}
async function createMatchInDB(uuid, initialState) {
  const [res] = await pool.execute(
    `INSERT INTO matches (uuid, state, status, last_heartbeat) VALUES (?, ?, 'waiting', NOW())`,
    [uuid, JSON.stringify(initialState)]
  );
  return res.insertId;
}
async function updateMatchStateInDB(uuid, state, status='playing') {
  await pool.execute(
    `UPDATE matches SET state = ?, status = ?, last_heartbeat = NOW() WHERE uuid = ?`,
    [JSON.stringify(state), status, uuid]
  );
}
async function insertMatchAction(matchId, player_number, action_type, payload) {
  await pool.execute(
    `INSERT INTO match_actions (match_id, player_number, action_type, payload) VALUES (?, ?, ?, ?)`,
    [matchId, player_number, action_type, JSON.stringify(payload)]
  );
}

/* Helper: broadcast lobby to everyone connected */
async function broadcastLobby() {
  // get simplified list from waitingQueue
  const list = waitingQueue.map(x => ({ username: x.username, scenario: x.scenario, socketId: x.socketId }));
  io.emit('lobby:update', list);
}

/* Matching simple: toma 2 del queue con mismo escenario (o escenario vacío) */
function tryMatch() {
  for (let i = 0; i < waitingQueue.length; i++) {
    const a = waitingQueue[i];
    for (let j = i + 1; j < waitingQueue.length; j++) {
      const b = waitingQueue[j];
      // match if same scenario or if one scenario empty or both empty
      if (a.scenario === b.scenario || a.scenario === '' || b.scenario === '') {
        // remove both from queue
        waitingQueue.splice(j, 1);
        waitingQueue.splice(i, 1);
        return { a, b };
      }
    }
  }
  return null;
}

/* Socket.IO events */
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('lobby:join', async (payload) => {
    // payload: { username, scenario }
    const username = (payload.username || 'anon').substr(0,64);
    const scenario = (payload.scenario || '').substr(0,8);
    socket.data.username = username;
    socket.data.scenario = scenario;
    socket.data.player_number = null;
    socket.data.match_uuid = null;

    // add to waitingQueue
    waitingQueue.push({ socketId: socket.id, username, scenario });
    await saveLobbyConnection(socket.id, username, scenario);
    await broadcastLobby();

    // try to match
    const pair = tryMatch();
    if (pair) {
      // create match
      const uuid = uuidv4();
      // initial state minimal: you should produce the same shape your client expects
      const initialState = {
        uuid,
        scenario: pair.a.scenario || pair.b.scenario || '1',
        units: [], terrain: [], turn: 1, history: []
      };
      // create row in DB
      const matchId = await createMatchInDB(uuid, initialState);

      // fill players in DB
      const insertPlayers = async (socketInfo, player_number) => {
        await pool.execute(
          `INSERT INTO match_players (match_id, user_socket_id, username, player_number, reconnect_token) VALUES (?, ?, ?, ?, ?)`,
          [matchId, socketInfo.socketId, socketInfo.username, player_number, uuidv4()]
        );
      };
      await insertPlayers(pair.a, 1);
      await insertPlayers(pair.b, 2);

      // in-memory state
      matchesInMemory.set(uuid, {
        id: matchId,
        uuid,
        state: initialState,
        players: [pair.a.socketId, pair.b.socketId],
        lastUpdate: Date.now()
      });

      // notify both sockets with match created and role (player number)
      io.to(pair.a.socketId).emit('match:found', { uuid, playerNumber: 1, initialState });
      io.to(pair.b.socketId).emit('match:found', { uuid, playerNumber: 2, initialState });

      // update lobby in DB
      await pool.execute(`UPDATE lobby_connections SET status='matched' WHERE socket_id IN (?,?)`, [pair.a.socketId, pair.b.socketId]);
      await broadcastLobby();
    }
  });

  socket.on('match:accept', async (payload) => {
    // payload: { uuid, playerNumber }
    const uuid = payload.uuid;
    const match = matchesInMemory.get(uuid);
    if (!match) {
      socket.emit('error', { msg: 'match not found' });
      return;
    }
    // mark player as ready in memory (optional)
    // we let first message from a client with 'game:init' set up the full scenario
    // For simplicity we'll send back the current state.
    socket.emit('match:accepted', { uuid, state: match.state });
  });

  /* Client sends actions: move, attack, endTurn, etc.
     Payload: { uuid, playerNumber, actionType, payload (object) }
     Server applies validation (basic), stores action, updates DB and forwards to opponent.
  */
  socket.on('match:action', async (data) => {
    try {
      const { uuid, playerNumber, actionType, payload } = data;
      const match = matchesInMemory.get(uuid);
      if (!match) {
        socket.emit('error', { msg: 'match not found' });
        return;
      }

      // basic authorization: check socket is one of players
      if (!match.players.includes(socket.id)) {
        socket.emit('error', { msg: 'no autorizado' });
        return;
      }

      // Persist action row
      await insertMatchAction(match.id, playerNumber, actionType, payload);

      // Apply action to in-memory state (we assume client provides authoritative minimal diffs)
      // For reliability, clients can send the whole state after each action; server overwrites the state and persists.
      // Here: if actionType === 'state:update' -> payload.state contains full state
      if (actionType === 'state:update' && payload && payload.state) {
        match.state = payload.state;
        match.lastUpdate = Date.now();
        await updateMatchStateInDB(uuid, match.state, 'playing');
      } else {
        // For other actions you could implement server-side rules. For now we just append to history
        if (!match.state.history) match.state.history = [];
        match.state.history.push({ player: playerNumber, actionType, payload, when: new Date() });
        match.lastUpdate = Date.now();
        await updateMatchStateInDB(uuid, match.state, 'playing');
      }

      // Forward to opponent(s)
      match.players.forEach(pid => {
        if (pid !== socket.id) {
          io.to(pid).emit('match:action:recv', { playerNumber, actionType, payload });
        }
      });

    } catch (err) {
      console.error('match:action error', err);
      socket.emit('error', { msg: 'server error' });
    }
  });

  socket.on('match:heartbeat', async (data) => {
    // keep-alive for match
    try {
      const { uuid } = data;
      const match = matchesInMemory.get(uuid);
      if (match) {
        match.lastUpdate = Date.now();
        await pool.execute(`UPDATE matches SET last_heartbeat = NOW() WHERE uuid = ?`, [uuid]);
      }
    } catch (e) { /* ignore */ }
  });

  socket.on('disconnect', async (reason) => {
    console.log('disconnect', socket.id, reason);
    // remove from waitingQueue if present
    const idx = waitingQueue.findIndex(x => x.socketId === socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    await removeLobbyConnection(socket.id);
    await broadcastLobby();

    // If socket was in a match, mark player disconnected in DB and in memory
    matchesInMemory.forEach((match, uuid) => {
      const i = match.players.indexOf(socket.id);
      if (i !== -1) {
        // mark in DB
        (async () => {
          await pool.execute(`UPDATE match_players SET disconnected=1, last_seen = NOW() WHERE match_id = ? AND user_socket_id = ?`, [match.id, socket.id]);
        })();
        // keep match in memory for reconnection window
      }
    });
  });
});

/* Periodic cleanup: persist matches, expire stale matches, heartbeat */
setInterval(async () => {
  const now = Date.now();
  for (const [uuid, match] of matchesInMemory.entries()) {
    // If lastUpdate older than 30 minutes => abort
    if (now - match.lastUpdate > 30 * 60 * 1000) {
      // set DB status aborted
      await pool.execute(`UPDATE matches SET status='aborted' WHERE uuid = ?`, [uuid]);
      matchesInMemory.delete(uuid);
      continue;
    }
    // Persist state to DB every X seconds
    await updateMatchStateInDB(uuid, match.state, 'playing');
  }
}, 15 * 1000);

app.get('/', (req, res) => res.send('HexBattle server running'));
server.listen(PORT, () => console.log('Server listening on', PORT));
