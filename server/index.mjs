// SISYPHUS multiplayer server.
//
// Two kinds of rooms:
//  - Public arenas (PLAY ONLINE): always running. Rounds start on their own after a short
//    intermission, bots fill empty places, and you can drop into a round already going.
//    Rounds with enough real players are prize rounds (the prize itself is shown, and
//    winners are recorded; paying out is up to whoever runs the server).
//  - Private rooms (play with friends): a 5-letter code, the host starts the round.
//
// Physics runs on the clients (each simulates its own fighter; one player also runs the
// bots). The server owns the clock, the flag, supply drops and the result, relays state
// (batched, 20 Hz), and refuses movement no honest client could produce (guard.mjs).
//
//   node server/index.mjs        PORT (8787), DATA_DIR (./data)
//   Prize display:               PRIZE_PER_ROUND (25), PRIZE_CURRENCY ($), MIN_PRIZE_PLAYERS (4)
//   Arenas:                      ARENA_FILL (12 fighters with bots), INTERMISSION_SECONDS (30), MATCH_SECONDS (480)

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Guard, STRIKES_TO_FLAG } from './guard.mjs';
import { Stats } from './stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const CFG = {
  port: Number(env.PORT) || 8787,
  dist: path.join(ROOT, 'dist'),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  prize: Number(env.PRIZE_PER_ROUND ?? 25),
  currency: env.PRIZE_CURRENCY ?? '$',
  minPrizePlayers: Number(env.MIN_PRIZE_PLAYERS ?? 4),
  arenaFill: Number(env.ARENA_FILL ?? 12),
  intermission: Number(env.INTERMISSION_SECONDS ?? 30),
};
const MATCH_SECONDS = Number(env.MATCH_SECONDS ?? 480);
const HOLD_MS = 3000;
const COUNTDOWN_MS = 5000;
const MAX_PLAYERS = 24;
const MAX_FIGHTERS = 24;
const PRIVATE_FILL = 8;
const QUICK_START_PLAYERS = 12; // a full-ish arena doesn't wait out the whole intermission
const RESULTS_MS = 8000;
const SEND_MS = 50;
const CRATE_FIRST_MS = 12000;
const CRATE_EVERY_MS = 30000;
const CRATE_MAX = 3;
const CRATE_SPOTS = 48; // 4 per floor, floors 0-11 (see Building.crateSpots)
const RACK_SPOTS = 24; // 2 per floor, floor by floor (see Building.rackSpots)
const RACK_REFILL_MS = 25000;
const LOOT = ['knife', 'bat', 'pushgun', 'rocket', 'railgun', 'freeze'];
/** The lobby's two racks hold the big guns: the start-line rush. */
const POWER = ['rocket', 'railgun'];
const TRAPS = ['grease', 'spring', 'trapdoor', 'beartrap'];
/** Maps (src/maps). Public arenas take them in turn; a private room's host picks. */
const MAPS = ['olympus', 'tower', 'construction', 'hotel'];
let nextArenaMap = 0;

const now = () => Number(process.hrtime.bigint() / 1000000n);
const rooms = new Map(); // private rooms by code
const arenas = []; // public arenas
const stats = new Stats(CFG.dataDir);
let nextClient = 1;
let nextArena = 1;

// ------------------------------------------------------------------ http

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.vrm': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function publicStats() {
  const t = now();
  return {
    online: wss.clients.size,
    playing: arenas.reduce((n, a) => n + a.clients.size, 0),
    prize: CFG.prize,
    currency: CFG.currency,
    minPlayers: CFG.minPrizePlayers,
    matchSeconds: MATCH_SECONDS,
    arenas: arenas.map((a) => ({
      code: a.code,
      phase: a.phase,
      map: a.map,
      humans: a.clients.size,
      startsIn: a.phase === 'lobby' && a.nextAt ? Math.max(0, Math.round((a.nextAt - t) / 1000)) : null,
      endsIn: a.phase === 'playing' ? Math.max(0, Math.round((a.at + MATCH_SECONDS * 1000 - t) / 1000)) : null,
      prizeRound: prizeRound(a),
    })),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${rooms.size} rooms ${arenas.length} arenas`);
    return;
  }
  if (url.pathname === '/api/stats') return json(res, publicStats());
  if (url.pathname === '/api/leaderboard') return json(res, { top: stats.leaderboard(50) });
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    rel = '/';
  }
  let file = path.join(CFG.dist, rel);
  if (file !== CFG.dist && !file.startsWith(CFG.dist + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(CFG.dist, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Build the game first: npm run build');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------------ rooms

function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (rooms.has(c));
  return c;
}

function newRoom(isPublic, host) {
  return {
    code: isPublic ? `A${nextArena++}` : code(),
    public: isPublic,
    clients: new Map(),
    host,
    botOwner: host,
    phase: 'lobby',
    // Each new arena starts somewhere else in the rotation so they don't all match.
    map: isPublic ? MAPS[nextArenaMap++ % MAPS.length] : MAPS[0],
    fillBots: true,
    timers: [],
    startTimer: null,
    sendTimer: null,
    nextAt: 0,
    at: 0,
    roster: [],
    nextSpawn: 0,
    flag: { holder: null, since: 0 },
    heights: new Map(),
    crates: new Map(),
    nextCrate: 1,
    fresh: new Map(),
    prizeLocked: false,
    guard: new Guard(),
    entrants: new Set(),
  };
}

function send(client, msg) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
}

/**
 * Prize rounds: public, with enough real people in it. Decided when the round starts —
 * people dropping in later don't turn a warm-up into a prize round (or back).
 */
function prizeRound(room) {
  if (room.phase !== 'lobby') return room.prizeLocked;
  return room.public && CFG.prize > 0 && room.clients.size >= CFG.minPrizePlayers;
}

function roomInfo(room) {
  return {
    t: 'room',
    code: room.code,
    public: room.public,
    host: room.host,
    phase: room.phase,
    map: room.map,
    bots: room.fillBots,
    nextAt: room.phase === 'lobby' ? room.nextAt : 0,
    at: room.at,
    matchSeconds: MATCH_SECONDS,
    prize: CFG.prize,
    currency: CFG.currency,
    minPlayers: CFG.minPrizePlayers,
    prizeRound: prizeRound(room),
    players: [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, style: c.style })),
  };
}

function sendRoom(room) {
  broadcast(room, roomInfo(room));
}

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
  clearInterval(room.sendTimer);
  room.sendTimer = null;
}

/** Bots run on one player's machine; keep that a player whose tab is actually ticking. */
function pickBotOwner(room) {
  const cur = room.clients.get(room.botOwner);
  if (cur && cur.focused) return;
  const next = [...room.clients.values()].find((c) => c.focused) ?? cur ?? room.clients.values().next().value;
  if (!next || next.id === room.botOwner) return;
  room.botOwner = next.id;
  if (room.phase === 'playing') broadcast(room, { t: 'botOwner', id: next.id });
}

function humanEntry(room, c) {
  return { netId: `p:${c.id}`, kind: 'human', owner: c.id, name: c.name, style: c.style, spawn: room.nextSpawn++ % MAX_FIGHTERS };
}

function startMatch(room) {
  clearTimers(room);
  clearTimeout(room.startTimer);
  room.nextAt = 0;
  if (room.clients.size === 0) return;
  pickBotOwner(room);
  room.nextSpawn = 0;
  const roster = [...room.clients.values()].map((c) => humanEntry(room, c));
  const fill = room.public ? CFG.arenaFill : room.fillBots ? PRIVATE_FILL : 0;
  for (let i = roster.length; i < Math.min(MAX_FIGHTERS, fill); i++) {
    roster.push({ netId: `b:${i}`, kind: 'bot', owner: room.botOwner, seed: Math.floor(Math.random() * 2 ** 31), spawn: room.nextSpawn++ });
  }
  room.prizeLocked = room.public && CFG.prize > 0 && roster.filter((e) => e.kind === 'human').length >= CFG.minPrizePlayers;
  room.phase = 'playing';
  room.at = now() + COUNTDOWN_MS;
  room.roster = roster;
  room.flag = { holder: null, since: 0 };
  room.heights = new Map();
  room.crates = new Map();
  room.fresh = new Map();
  room.nextCrate = 1;
  room.guard = new Guard(room.map);
  room.entrants = new Set([...room.clients.values()].map((c) => c.pid).filter(Boolean));
  broadcast(room, { t: 'start', at: room.at, roster, map: room.map });
  sendRoom(room);
  for (let spot = 0; spot < RACK_SPOTS; spot++) spawnRack(room, spot);
  room.timers.push(setTimeout(() => crateTick(room), COUNTDOWN_MS + CRATE_FIRST_MS));
  room.timers.push(setTimeout(() => timeUp(room), COUNTDOWN_MS + MATCH_SECONDS * 1000));
  room.sendTimer = setInterval(() => flushState(room), SEND_MS);
}

/** One batched state packet per tick instead of every client's packet to every client. */
function flushState(room) {
  if (!room.fresh.size) return;
  const d = [];
  const w = [];
  for (const { e, t } of room.fresh.values()) {
    d.push(e);
    w.push(t);
  }
  room.fresh.clear();
  broadcast(room, { t: 's', ts: now(), d, w });
}

/** A late arrival drops straight into the round in progress (a bot makes room if needed). */
function dropIn(room, client) {
  const entry = humanEntry(room, client);
  room.roster.push(entry);
  if (client.pid) room.entrants.add(client.pid);
  if (room.roster.length > MAX_FIGHTERS) {
    const bot = [...room.roster].reverse().find((e) => e.kind === 'bot');
    if (bot) {
      room.roster.splice(room.roster.indexOf(bot), 1);
      broadcast(room, { t: 'drop', netId: bot.netId }, client);
    }
  }
  send(client, { t: 'start', at: room.at, roster: room.roster, map: room.map, flag: room.flag, crates: [...room.crates.entries()] });
  broadcast(room, { t: 'joined', entry }, client);
}

function spawnRack(room, spot) {
  if (room.phase !== 'playing') return;
  const id = room.nextCrate++;
  room.crates.set(id, { spot, rack: true });
  broadcast(room, { t: 'crate', id, spot, rack: 1 });
}

function crateTick(room) {
  if (room.phase !== 'playing') return;
  if ([...room.crates.values()].filter((c) => !c.rack).length < CRATE_MAX) {
    const id = room.nextCrate++;
    const spot = Math.floor(Math.random() * CRATE_SPOTS);
    room.crates.set(id, { spot, rack: false });
    broadcast(room, { t: 'crate', id, spot });
  }
  room.timers.push(setTimeout(() => crateTick(room), CRATE_EVERY_MS));
}

function endMatch(room, who, reason) {
  if (room.phase !== 'playing') return;
  clearTimers(room);
  room.phase = 'ended';
  const entry = room.roster.find((e) => e.netId === who) ?? null;
  const winnerClient = entry?.kind === 'human' ? room.clients.get(entry.owner) : null;
  const flaggedClients = [...room.clients.values()].filter((c) => room.guard.flagged(c.id));
  const result = {
    t: 'win',
    who,
    reason,
    winnerName: entry ? (entry.kind === 'human' ? entry.name : null) : null,
    bot: entry?.kind === 'bot',
    prizeRound: prizeRound(room),
    prize: CFG.prize,
    currency: CFG.currency,
    // Anyone the guard caught moving impossibly can't take a prize round.
    disqualified: !!winnerClient && room.guard.flagged(winnerClient.id),
  };
  broadcast(room, result);
  if (room.public) {
    stats.recordRound({
      arena: room.code,
      winnerPid: winnerClient && !result.disqualified ? winnerClient.pid : null,
      winnerName: result.winnerName,
      entrants: [...room.entrants],
      prizeRound: result.prizeRound,
      reason,
      flagged: flaggedClients.map((c) => c.pid).filter(Boolean),
    });
  }
  sendRoom(room);
  room.timers.push(
    setTimeout(() => {
      room.phase = 'lobby';
      room.roster = [];
      // Arenas move on to the next map; friends keep theirs until the host changes it.
      if (room.public) room.map = MAPS[(MAPS.indexOf(room.map) + 1) % MAPS.length];
      sendRoom(room);
      if (room.public) scheduleArena(room);
    }, RESULTS_MS),
  );
}

function timeUp(room) {
  let best = null;
  let bestY = -Infinity;
  for (const [id, y] of room.heights) {
    if (y > bestY) {
      bestY = y;
      best = id;
    }
  }
  endMatch(room, best, 'time');
}

/** Public arenas start on their own: a countdown once someone's waiting, shorter when it's busy. */
function scheduleArena(room) {
  if (!room.public || room.phase !== 'lobby' || room.clients.size === 0) return;
  const wait = room.clients.size >= QUICK_START_PLAYERS ? 8000 : CFG.intermission * 1000;
  const at = now() + wait;
  if (room.nextAt && room.nextAt <= at) return;
  room.nextAt = at;
  clearTimeout(room.startTimer);
  room.startTimer = setTimeout(() => startMatch(room), wait);
  sendRoom(room);
}

function leave(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  client.room = null;
  if (room.clients.size === 0) {
    clearTimers(room);
    clearTimeout(room.startTimer);
    if (room.public) arenas.splice(arenas.indexOf(room), 1);
    else rooms.delete(room.code);
    return;
  }
  if (room.host === client.id) room.host = room.clients.keys().next().value;
  const netId = `p:${client.id}`;
  if (room.flag?.holder === netId) {
    room.flag = { holder: null, since: 0 };
    broadcast(room, { t: 'flag', holder: null, since: 0 });
  }
  room.roster = room.roster.filter((e) => e.netId !== netId);
  broadcast(room, { t: 'left', id: client.id, host: room.host });
  pickBotOwner(room);
  sendRoom(room);
}

function join(client, room) {
  if (client.room) leave(client);
  if (room.clients.size >= MAX_PLAYERS) return send(client, { t: 'error', msg: 'That room is full.' });
  client.room = room;
  room.clients.set(client.id, client);
  sendRoom(room);
  if (room.public) {
    if (room.phase === 'playing') dropIn(room, client);
    else scheduleArena(room);
  }
  // Private rooms: late joiners wait in the room for the next round.
}

/** PLAY ONLINE: the busiest public arena with space, or a new one. */
function quickJoin(client) {
  const open = arenas.filter((a) => a.clients.size < MAX_PLAYERS).sort((a, b) => b.clients.size - a.clients.size);
  let room = open[0];
  if (!room) {
    room = newRoom(true, client.id);
    arenas.push(room);
  }
  join(client, room);
}

// ------------------------------------------------------------------ messages

/** Does this client simulate that fighter (its own, or the bots it runs)? */
function owns(room, client, netId) {
  const id = String(netId);
  return id === `p:${client.id}` || (id.startsWith('b:') && room.botOwner === client.id);
}

const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

function handle(client, msg) {
  const room = client.room;
  switch (msg.t) {
    case 'ping':
      return send(client, { t: 'pong', c: msg.c, s: now() });
    case 'hello':
    case 'profile': {
      client.name = String(msg.name ?? 'Player').replace(/[\u0000-\u001f]/g, '').slice(0, 14).trim() || 'Player';
      client.style = msg.style && typeof msg.style === 'object' ? msg.style : null;
      // A random secret kept in the player's browser gives them a stable id across visits.
      if (typeof msg.secret === 'string' && /^[0-9a-f]{32,64}$/.test(msg.secret)) {
        client.pid = crypto.createHash('sha256').update(`pid:${msg.secret}`).digest('hex').slice(0, 16);
        stats.seen(client.pid, client.name);
      }
      if (room) sendRoom(room);
      return;
    }
    case 'me':
      return send(client, { t: 'me', ...(client.pid ? stats.me(client.pid) : { name: client.name, wins: 0, rounds: 0, recent: [] }) });
    case 'quick':
      return quickJoin(client);
    case 'create': {
      const r = newRoom(false, client.id);
      rooms.set(r.code, r);
      return join(client, r);
    }
    case 'join': {
      const r = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!r) return send(client, { t: 'error', msg: 'No room with that code.' });
      return join(client, r);
    }
    case 'leave':
      return leave(client);
    case 'focus':
      client.focused = !!msg.on;
      if (room) pickBotOwner(room);
      return;
  }
  if (!room) return;
  const isHost = room.host === client.id && !room.public;
  switch (msg.t) {
    case 'bots':
      if (isHost && room.phase === 'lobby') {
        room.fillBots = !!msg.on;
        sendRoom(room);
      }
      return;
    case 'map':
      if (isHost && room.phase === 'lobby' && MAPS.includes(msg.map)) {
        room.map = msg.map;
        sendRoom(room);
      }
      return;
    case 'start':
      if (isHost && room.phase === 'lobby') startMatch(room);
      return;
    case 's': {
      if (room.phase !== 'playing' || !Array.isArray(msg.d) || msg.d.length > MAX_FIGHTERS) return;
      const t = now();
      for (const e of msg.d) {
        if (!Array.isArray(e) || e.length > 20 || !owns(room, client, e[0])) continue;
        const [netId, x, y, z] = e;
        if (!room.guard.move(String(netId), x, y, z, t)) {
          // Not relayed: everyone else keeps seeing the last believable position. Only your own
          // fighter counts against you (bots can't win, and the bot runner shouldn't pay for them).
          if (String(netId) !== `p:${client.id}`) continue;
          const n = room.guard.strike(client.id);
          if (n <= 3 || n === STRIKES_TO_FLAG) console.warn(`guard: ${client.name} strike ${n}: ${room.guard.why}`);
          if (n === STRIKES_TO_FLAG) console.warn(`guard: flagged ${client.name} (${client.id}) in ${room.code}`);
          continue;
        }
        room.heights.set(String(netId), y);
        room.fresh.set(String(netId), { e, t });
      }
      return;
    }
    case 'hit': {
      if (room.phase !== 'playing' || !owns(room, client, msg.by)) return;
      const target = String(msg.target ?? '');
      if (!room.guard.inReach(String(msg.by), target)) return;
      const ownerId = target.startsWith('p:') ? Number(target.slice(2)) : room.botOwner;
      const owner = room.clients.get(ownerId);
      if (!owner || owner === client) return;
      const dir = Array.isArray(msg.dir) ? [num(msg.dir[0], -1, 1), num(msg.dir[1], -1, 1)] : [0, 1];
      send(owner, { t: 'hit', target, by: String(msg.by), dir, force: num(msg.force, 0, 30), up: num(msg.up, 0, 12), stun: num(msg.stun, 0, 3), dmg: num(msg.dmg, 0, 80), root: num(msg.root, 0, 3) });
      return;
    }
    case 'trap':
      if (room.phase === 'playing' && owns(room, client, msg.owner)) broadcast(room, msg, client);
      return;
    case 'trapUse':
      if (room.phase === 'playing') broadcast(room, { t: 'trapUse', id: String(msg.id ?? '') }, client);
      return;
    case 'flagTry': {
      const who = String(msg.who);
      if (room.phase !== 'playing' || room.flag.holder || !owns(room, client, who) || !room.guard.atFlag(who)) return;
      room.flag = { holder: who, since: now() };
      broadcast(room, { t: 'flag', holder: who, since: room.flag.since });
      const since = room.flag.since;
      room.timers.push(
        setTimeout(() => {
          if (room.flag.holder === who && room.flag.since === since) endMatch(room, who, 'flag');
        }, HOLD_MS),
      );
      return;
    }
    case 'flagDrop':
      if (room.flag?.holder === String(msg.who) && owns(room, client, msg.who)) {
        room.flag = { holder: null, since: 0 };
        broadcast(room, { t: 'flag', holder: null, since: 0 });
      }
      return;
    case 'take': {
      if (room.phase !== 'playing' || !room.crates.has(msg.crate) || !owns(room, client, msg.who)) return;
      const crate = room.crates.get(msg.crate);
      room.crates.delete(msg.crate);
      const pool = crate.rack && crate.spot < 2 ? POWER : LOOT;
      broadcast(room, {
        t: 'gone',
        id: msg.crate,
        who: String(msg.who),
        weapon: pool[Math.floor(Math.random() * pool.length)],
        trap: TRAPS[Math.floor(Math.random() * TRAPS.length)],
      });
      if (crate.rack) room.timers.push(setTimeout(() => spawnRack(room, crate.spot), RACK_REFILL_MS));
      return;
    }
  }
}

// ------------------------------------------------------------------ sockets

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const client = { id: nextClient++, ws, name: 'Player', style: null, room: null, focused: true, pid: null, budget: 0, budgetAt: now() };
  send(client, { t: 'welcome', id: client.id });
  ws.on('message', (raw) => {
    // Flood guard: ~60 state packets/s is normal; far beyond that is someone misbehaving.
    const t = now();
    if (t - client.budgetAt > 1000) {
      client.budget = 0;
      client.budgetAt = t;
    }
    if (++client.budget > 400) return ws.close(1008, 'too many messages');
    if (client.budget > 150) return;
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') handle(client, msg);
  });
  ws.on('close', () => leave(client));
});

server.listen(CFG.port, () => console.log(`SISYPHUS server on :${CFG.port} (ws /ws, stats ${CFG.dataDir})`));
