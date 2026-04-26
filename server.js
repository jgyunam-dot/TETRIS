const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');

/* ── helpers ── */
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces))
    for (const i of ifaces[n])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3001;
const LOCAL_IP = getLocalIP();

/* ── state ── */
let idCounter = 0;
const clients = {};   // id → ws
const players = {};   // id → player

const room = { phase: 'lobby', mode: 'ffa', hostId: null };

const MODE_MIN = { ffa: 2, '1v1': 2, '2v2': 4, '4v4': 8 };
const MODE_MAX = { ffa: 8, '1v1': 2, '2v2': 4, '4v4': 8 };

function newId() { return `p${++idCounter}`; }

/* ── comms ── */
function send(id, msg) {
  const ws = clients[id];
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  Object.values(clients).forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
}
function broadcastExcept(id, msg) {
  const s = JSON.stringify(msg);
  Object.entries(clients).forEach(([pid, ws]) => {
    if (pid !== id && ws.readyState === WebSocket.OPEN) ws.send(s);
  });
}

/* ── player list ── */
function playerList() {
  return Object.entries(players).map(([id, p]) => ({
    id, name: p.name, ready: p.ready, alive: p.alive,
    team: p.team, isHost: id === room.hostId,
    score: p.score, lines: p.lines, level: p.level, dead: p.dead,
  }));
}

function broadcastLobby() {
  broadcastAll({ type: 'lobby', players: playerList(), hostId: room.hostId, mode: room.mode, phase: room.phase });
}

/* ── team assignment ── */
function assignTeams() {
  const ids = Object.keys(players);
  if (room.mode === 'ffa') {
    ids.forEach(id => { players[id].team = -1; });
  } else if (room.mode === '1v1') {
    ids.slice(0,1).forEach(id => { players[id].team = 0; });
    ids.slice(1,2).forEach(id => { players[id].team = 1; });
  } else if (room.mode === '2v2') {
    ids.slice(0,2).forEach(id => { players[id].team = 0; });
    ids.slice(2,4).forEach(id => { players[id].team = 1; });
  } else if (room.mode === '4v4') {
    ids.slice(0,4).forEach(id => { players[id].team = 0; });
    ids.slice(4,8).forEach(id => { players[id].team = 1; });
  }
}

/* ── attack routing ── */
function getTargets(fromId) {
  const from = players[fromId];
  if (!from) return [];
  if (room.mode === 'ffa' || room.mode === '1v1') {
    return Object.keys(players).filter(id => id !== fromId && players[id]?.alive);
  }
  // team modes: enemies only
  return Object.keys(players).filter(id =>
    id !== fromId && players[id]?.alive && players[id]?.team !== from.team
  );
}

function pickTarget(fromId) {
  const targets = getTargets(fromId);
  if (targets.length === 0) return null;
  return targets[Math.floor(Math.random() * targets.length)];
}

/* ── win check ── */
function checkWin() {
  if (room.phase !== 'playing') return;
  const alive = Object.entries(players).filter(([, p]) => p.alive);

  if (room.mode === 'ffa' || room.mode === '1v1') {
    if (alive.length <= 1) {
      room.phase = 'ended';
      const w = alive[0];
      broadcastAll({ type: 'game_over', winnerId: w?.[0], winnerName: w?.[1]?.name, winnerTeam: -1, scores: playerList() });
    }
  } else {
    const alive0 = alive.filter(([,p]) => p.team === 0).length;
    const alive1 = alive.filter(([,p]) => p.team === 1).length;
    if (alive0 === 0 || alive1 === 0) {
      room.phase = 'ended';
      const winTeam = alive0 > 0 ? 0 : 1;
      broadcastAll({ type: 'game_over', winnerId: null, winnerName: null, winnerTeam: winTeam, scores: playerList() });
    }
  }
}

/* ── HTTP ── */
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'tetris.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end('tetris.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

/* ── WebSocket ── */
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  const id = newId();
  clients[id] = ws;
  const isHost = Object.keys(players).length === 0;
  players[id] = { name: '플레이어', ready: false, alive: false, dead: false, team: -1, score: 0, lines: 0, level: 1 };
  if (isHost) room.hostId = id;

  send(id, { type: 'welcome', id, isHost, phase: room.phase, mode: room.mode, players: playerList(), hostId: room.hostId });
  broadcastLobby();

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = players[id];
    if (!p) return;

    switch (msg.type) {

      case 'set_name':
        p.name = String(msg.name).slice(0, 12);
        broadcastLobby();
        break;

      case 'set_mode':
        if (id !== room.hostId || room.phase !== 'lobby') break;
        if (MODE_MIN[msg.mode]) {
          room.mode = msg.mode;
          broadcastLobby();
        }
        break;

      case 'swap_team': {
        if (room.phase !== 'lobby') break;
        const cur = p.team;
        if (cur === 0) p.team = 1;
        else if (cur === 1) p.team = 0;
        broadcastLobby();
        break;
      }

      case 'set_ready':
        if (room.phase !== 'lobby') break;
        p.ready = !!msg.ready;
        broadcastLobby();
        break;

      case 'start_game': {
        if (id !== room.hostId || room.phase !== 'lobby') break;
        const cnt = Object.keys(players).length;
        const min = MODE_MIN[room.mode] || 2;
        const max = MODE_MAX[room.mode] || 8;
        if (cnt < min) { send(id, { type: 'error', msg: `최소 ${min}명 필요해요!` }); break; }
        if (cnt > max) { send(id, { type: 'error', msg: `이 모드는 최대 ${max}명이에요!` }); break; }
        assignTeams();
        room.phase = 'playing';
        Object.values(players).forEach(p => {
          p.alive = true; p.dead = false; p.score = 0; p.lines = 0; p.level = 1;
        });
        broadcastAll({ type: 'game_start', mode: room.mode, players: playerList() });
        break;
      }

      case 'board_update':
        p.score = msg.score || 0;
        p.lines = msg.lines || 0;
        p.level = msg.level || 1;
        broadcastExcept(id, { type: 'player_board', id, board: msg.board, score: p.score, lines: p.lines, level: p.level, name: p.name, team: p.team });
        break;

      case 'attack': {
        if (room.phase !== 'playing' || !p.alive) break;
        const lines = Math.max(0, Math.min(12, msg.lines || 0));
        if (lines === 0) break;

        if (room.mode === 'ffa') {
          // FFA: send to random target
          const target = pickTarget(id);
          if (target) {
            send(target, { type: 'garbage', lines, fromName: p.name });
            send(id, { type: 'attack_sent', lines, toName: players[target]?.name });
          }
        } else {
          // Team/1v1: send to all enemies (split) or random
          const enemies = getTargets(id);
          if (enemies.length === 0) break;
          const target = enemies[Math.floor(Math.random() * enemies.length)];
          send(target, { type: 'garbage', lines, fromName: p.name });
          send(id, { type: 'attack_sent', lines, toName: players[target]?.name });
        }
        break;
      }

      case 'player_dead':
        if (!p.alive) break;
        p.alive = false;
        p.dead = true;
        p.score = msg.score || p.score;
        broadcastAll({ type: 'player_died', id, name: p.name, score: p.score });
        broadcastLobby();
        checkWin();
        break;

      case 'restart':
        if (id !== room.hostId) break;
        room.phase = 'lobby';
        Object.values(players).forEach(p => { p.ready = false; p.alive = false; p.dead = false; });
        broadcastAll({ type: 'restart' });
        broadcastLobby();
        break;
    }
  });

  ws.on('close', () => {
    delete clients[id];
    delete players[id];
    if (room.hostId === id) {
      const rem = Object.keys(players);
      room.hostId = rem[0] || null;
      if (room.hostId) send(room.hostId, { type: 'you_are_host' });
    }
    if (room.phase === 'playing') checkWin();
    broadcastLobby();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      🎮  테트리스 멀티게임 서버 실행중       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  로컬:    http://localhost:${PORT}            ║`);
  console.log(`║  네트워크: http://${LOCAL_IP}:${PORT}   ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('  모드: FFA(최대8명) / 1v1 / 2v2 / 4v4');
  console.log('  종료: Ctrl+C\n');
});
