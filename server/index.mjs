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
//   Prize defaults:              PRIZE_PER_ROUND (25), PRIZE_CURRENCY ($), MIN_PRIZE_PLAYERS (4); after the
//                                first prize round they live in DATA_DIR/prizes.json and change from Telegram
//   Telegram bot:                TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS (see telegram.mjs)
//   Arenas:                      ARENA_FILL (12 fighters with bots), INTERMISSION_SECONDS (30), MATCH_SECONDS (480)
//
// Prize rounds pay the top places (the split, e.g. 60/25/15): the winner, then the real players
// who finished highest. Each placed player gets a private link to send a Solana wallet address,
// which arrives in the Telegram bot; the payment itself is sent by hand.
//
// The cup (cup.mjs, started from Telegram) replaces round prizes while it runs: rounds with enough
// real players give points instead, and when it ends the top of the table claim the prizes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CLIMB_POINTS, Cup, MAX_CUP_PLACES, PLACE_POINTS } from './cup.mjs';
import { Guard, STRIKES_TO_FLAG } from './guard.mjs';
import { ORDINAL, Prizes, money } from './prizes.mjs';
import { Stats } from './stats.mjs';
import { TelegramBot, esc } from './telegram.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const CFG = {
  port: Number(env.PORT) || 8787,
  dist: path.join(ROOT, 'dist'),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
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
/** Traps a fighter starts with (config START_TRAPS); each crate or rack adds one. */
const START_TRAPS = 7;
/** A paid place needs a real climb (an idle tab at the start line gets nothing). */
const MIN_PRIZE_FLOOR = 3;
/** Connections from one address (one person can't fill a prize round with tabs). */
const MAX_CONN_PER_IP = 8;
/** Maps (src/maps). Public arenas take them in turn; a private room's host picks. */
const MAPS = ['olympus', 'tower', 'construction', 'hotel'];
let nextArenaMap = 0;

const now = () => Number(process.hrtime.bigint() / 1000000n);
const rooms = new Map(); // private rooms by code
const arenas = []; // public arenas
const stats = new Stats(CFG.dataDir);
const prizes = new Prizes(CFG.dataDir, {
  amount: Number(env.PRIZE_PER_ROUND ?? 25),
  currency: env.PRIZE_CURRENCY ?? '$',
  split: [60, 25, 15],
  minPlayers: Number(env.MIN_PRIZE_PLAYERS ?? 4),
});
/** Current prize settings (the pot, currency, split, minimum real players). */
const P = () => prizes.settings;
const cup = new Cup(CFG.dataDir);
/** Everyone connected, in a room or not (cup winners hear about their prize wherever they are). */
const clients = new Set();
const MAP_NAMES = { olympus: 'Mount Olympus', tower: 'The Tower', construction: 'Construction Site', hotel: 'Haunted Hotel' };
const MEDAL = ['🥇', '🥈', '🥉'];
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
  '.gz': 'application/gzip',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.wasm']);
/** Compressed copies of text files, made once per version of the file. */
const packed = new Map();

/** Built files with a content hash in the name never change; the models change rarely. */
function cacheFor(file, ext) {
  if (ext === '.html') return 'no-cache';
  if (/-[\w-]{8,}\.(js|css)$/.test(path.basename(file))) return 'public, max-age=31536000, immutable';
  return 'public, max-age=604800, stale-while-revalidate=2592000';
}

function sendFile(req, res, file) {
  const ext = path.extname(file);
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cacheFor(file, ext) };
  const accept = String(req.headers['accept-encoding'] ?? '');
  const br = /\bbr\b/.test(accept);
  if (COMPRESSIBLE.has(ext) && (br || /\bgzip\b/.test(accept))) {
    const mtime = fs.statSync(file).mtimeMs;
    let p = packed.get(file);
    if (!p || p.mtime !== mtime) {
      const raw = fs.readFileSync(file);
      p = { mtime, br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(raw, { level: 9 }) };
      packed.set(file, p);
    }
    res.writeHead(200, { ...headers, 'content-encoding': br ? 'br' : 'gzip', vary: 'accept-encoding' });
    res.end(br ? p.br : p.gz);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function publicStats() {
  const t = now();
  return {
    online: wss.clients.size,
    playing: arenas.reduce((n, a) => n + a.clients.size, 0),
    prize: P().amount,
    currency: P().currency,
    split: P().split,
    minPlayers: P().minPlayers,
    matchSeconds: MATCH_SECONDS,
    cup: cup.summary(),
    arenas: arenas.map((a) => ({
      code: a.code,
      phase: a.phase,
      map: a.map,
      humans: a.clients.size,
      startsIn: a.phase === 'lobby' && a.nextAt ? Math.max(0, Math.round((a.nextAt - t) / 1000)) : null,
      endsIn: a.phase === 'playing' ? Math.max(0, Math.round((a.at + MATCH_SECONDS * 1000 - t) / 1000)) : null,
      prizeRound: prizeRound(a),
      cupRound: cupRound(a),
    })),
  };
}

/** The cup table, and how points are earned (so the page never disagrees with the server). */
function leaderboard() {
  return {
    top: stats.leaderboard(50),
    cup: cup.view(50),
    rules: { places: PLACE_POINTS, climb: CLIMB_POINTS, minFloor: MIN_PRIZE_FLOOR, minPlayers: P().minPlayers },
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
  if (url.pathname === '/api/leaderboard') return json(res, leaderboard());
  if (url.pathname === '/api/claim') return handleClaim(req, res);
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
  sendFile(req, res, file);
});

// ------------------------------------------------------------------ prize claims

const CLAIM_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const claimHits = new Map(); // ip -> { n, at }

/**
 * POST /api/claim: a placed player sends the Solana address for their prize. Round prizes come
 * with { token, wallet }; cup prizes with { claim, secret, wallet } (the browser's own secret).
 */
function handleClaim(req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { ...CLAIM_CORS, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CLAIM_CORS);
    return res.end();
  }
  if (req.method !== 'POST') return reply(405, { error: 'POST only.' });
  const ip = clientIp(req);
  const t = now();
  const hit = claimHits.get(ip);
  if (!hit || t - hit.at > 60000) claimHits.set(ip, { n: 1, at: t });
  else if (++hit.n > 12) return reply(429, { error: 'Too many tries. Wait a minute and try again.' });
  if (claimHits.size > 5000) claimHits.clear();

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2048) req.destroy();
  });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return reply(400, { error: 'Bad request.' });
    }
    const wallet = String(msg?.wallet ?? '').trim();
    const r = msg?.secret !== undefined ? prizes.submitCup(pidOf(msg.secret), Number(msg.claim), wallet) : prizes.submit(String(msg?.token ?? ''), wallet);
    if (r.error) return reply(400, { error: r.error });
    const c = r.claim;
    if (!r.same) telegram.notify(walletMessage(c, r.updated));
    reply(200, { ok: true, place: c.place, label: money(c.amount, c.currency), wallet: c.wallet });
  });
}

function walletMessage(c, updated) {
  const when = new Date(c.at).toISOString().replace('T', ' ').slice(0, 16);
  if (c.kind === 'cup') {
    return [
      updated ? `✏️ <b>Wallet changed</b> · claim #${c.id}` : `💰 <b>Wallet in</b> · claim #${c.id}`,
      `🏆 Cup #${c.cupId}, ${MEDAL[c.place - 1] ?? ''} ${ORDINAL[c.place - 1] ?? `#${c.place}`} place: <b>${esc(c.name)}</b> (${c.points} pts)`,
      `Prize: <b>${esc(money(c.amount, c.currency))}</b>`,
      `Wallet: <code>${esc(c.wallet)}</code>`,
      `<a href="https://solscan.io/account/${esc(c.wallet)}">View on Solscan</a>`,
    ].join('\n');
  }
  return [
    updated ? `✏️ <b>Wallet changed</b> · claim #${c.id}` : `💰 <b>Wallet in</b> · claim #${c.id}`,
    `${MEDAL[c.place - 1] ?? ''} ${ORDINAL[c.place - 1] ?? c.place} place: <b>${esc(c.name)}</b>`,
    `Prize: <b>${esc(money(c.amount, c.currency))}</b> (${c.share}% of the pot)`,
    `Wallet: <code>${esc(c.wallet)}</code>`,
    `<a href="https://solscan.io/account/${esc(c.wallet)}">View on Solscan</a>`,
    `Round ${esc(c.arena)} · ${esc(MAP_NAMES[c.map] ?? c.map)} · ${when} UTC`,
  ].join('\n');
}

// ------------------------------------------------------------------ rooms

/**
 * The caller's address. Railway's proxy appends the real one to X-Forwarded-For, so the last
 * entry is trustworthy; earlier entries can be anything the client sent.
 */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return fwd.at(-1) || req.socket.remoteAddress || '?';
}

/** A player's stable id: a hash of the random secret their browser keeps (null if it isn't one). */
function pidOf(secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{32,64}$/.test(secret)) return null;
  return crypto.createHash('sha256').update(`pid:${secret}`).digest('hex').slice(0, 16);
}

/** A fighter's look, as small whole numbers only (the game maps each onto its own lists). */
function cleanStyle(s) {
  if (!s || typeof s !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? Math.min(63, Math.max(0, Math.floor(v))) : 0);
  return { base: n(s.base), hair: n(s.hair), outfit: n(s.outfit), eyes: n(s.eyes), hat: n(s.hat) };
}

/**
 * Hits as fast as the game can make them and no faster: the Blaster and a knife together land
 * about 7 a second on one target; a rocket's splash reaches several targets at once.
 */
function hitAllowed(room, by, target) {
  const t = now();
  const ok = (key, perSecond) => {
    const b = room.hits.get(key);
    if (!b || t - b.at > 1000) {
      room.hits.set(key, { n: 1, at: t });
      return true;
    }
    return ++b.n <= perSecond;
  };
  return ok(`${by}>${target}`, 9) && ok(by, 40);
}


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
    cupId: 0,
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
  return !cup.running && P().amount > 0 && enoughPeople(room);
}

/** Cup rounds: the same rule, while a cup is taking new rounds (points instead of a prize). */
function cupRound(room) {
  if (room.phase !== 'lobby') return !!room.cupId;
  return cup.open && enoughPeople(room);
}

function enoughPeople(room) {
  return room.public && distinctPeople(room) >= P().minPlayers;
}

/** Real players in a room, counting everyone on one address once. */
function distinctPeople(room) {
  return new Set([...room.clients.values()].map((c) => c.ip)).size;
}

/** The pot a round is playing for: fixed when it starts, so changing it mid-round waits for the next. */
function potOf(room) {
  return room.phase !== 'lobby' && room.pot ? room.pot : P();
}

function roomInfo(room) {
  const pot = potOf(room);
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
    prize: pot.amount,
    currency: pot.currency,
    split: pot.split,
    minPlayers: P().minPlayers,
    prizeRound: prizeRound(room),
    cupRound: cupRound(room),
    cup: room.public ? cup.summary() : null,
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
  // Real players are counted per address, so a handful of tabs can't turn a round into a prize round.
  // While a cup runs, rounds play for points instead of a prize of their own.
  room.cupId = cup.open && enoughPeople(room) ? cup.current.id : 0;
  room.prizeLocked = !cup.running && P().amount > 0 && enoughPeople(room);
  room.pot = room.prizeLocked ? { amount: P().amount, currency: P().currency, split: [...P().split] } : null;
  room.phase = 'playing';
  room.at = now() + COUNTDOWN_MS;
  room.roster = roster;
  room.flag = { holder: null, since: 0 };
  room.heights = new Map();
  room.crates = new Map();
  room.fresh = new Map();
  room.nextCrate = 1;
  room.guard = new Guard(room.map);
  room.traps = new Map();
  room.hits = new Map();
  room.lastTake = new Map();
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

/**
 * Finishing order for the prize: the winner first, then everyone else by how high they were at the
 * end (closest to the flag). Real players only, still connected, never caught by the guard.
 */
function placements(room, who, reason) {
  const out = [];
  for (const e of room.roster) {
    if (e.kind !== 'human' || !room.heights.has(e.netId)) continue;
    const client = room.clients.get(e.owner);
    if (!client || room.guard.flagged(client.id) || room.guard.suspect(e.netId)) continue;
    const y = room.heights.get(e.netId);
    if (Math.floor((y + 0.2) / 6) < MIN_PRIZE_FLOOR) continue;
    out.push({ netId: e.netId, client, name: client.name, pid: client.pid, y });
  }
  out.sort((a, b) => Number(b.netId === who) - Number(a.netId === who) || b.y - a.y);
  // One paid place per address: extra tabs or accounts from the same connection don't stack.
  const seen = new Set();
  return out
    .filter((p) => !seen.has(p.client.ip) && seen.add(p.client.ip))
    .map((p) => ({ ...p, reason: p.netId === who ? reason : 'height' }));
}

function roundMessage(room, claims) {
  const pot = room.pot;
  const lines = [
    `🏁 <b>Prize round over</b> · ${esc(MAP_NAMES[room.map] ?? room.map)} (${esc(room.code)})`,
    `Pot: <b>${esc(money(pot.amount, pot.currency))}</b> · split ${pot.split.join('/')}`,
  ];
  const why = { flag: 'held the flag', time: 'highest at the bell', height: 'closest to the top' };
  for (const c of claims) lines.push(`${MEDAL[c.place - 1] ?? ''} ${ORDINAL[c.place - 1]} <b>${esc(c.name)}</b>: ${esc(money(c.amount, c.currency))} (${why[c.reason] ?? c.reason})`);
  if (!claims.length) lines.push('No real player finished in a paid place (bots or flagged players only). Nothing to pay.');
  else if (claims.length < pot.split.length) lines.push(`Only ${claims.length} paid place${claims.length === 1 ? '' : 's'} filled; the rest of the pot stays with you.`);
  if (claims.length) lines.push('Waiting for their wallets…');
  return lines.join('\n');
}

function endMatch(room, who, reason) {
  if (room.phase !== 'playing') return;
  clearTimers(room);
  room.phase = 'ended';
  const entry = room.roster.find((e) => e.netId === who) ?? null;
  const winnerClient = entry?.kind === 'human' ? room.clients.get(entry.owner) : null;
  const flaggedClients = [...room.clients.values()].filter((c) => room.guard.flagged(c.id));
  const pot = potOf(room);
  const result = {
    t: 'win',
    who,
    reason,
    winnerName: entry ? (entry.kind === 'human' ? entry.name : null) : null,
    bot: entry?.kind === 'bot',
    prizeRound: prizeRound(room),
    prize: pot.amount,
    currency: pot.currency,
    // Anyone the guard caught moving impossibly can't take a prize round.
    disqualified: !!winnerClient && room.guard.flagged(winnerClient.id),
    places: [],
    cupRound: !!room.cupId,
    cupTop: [],
  };
  // Cup rounds: points by finishing order (same rules as paid places); each scorer hears their total.
  if (room.cupId) {
    const rows = placements(room, who, reason)
      .filter((p) => p.pid)
      .map((p, i) => ({ pid: p.pid, name: p.name, client: p.client, points: PLACE_POINTS[i] ?? CLIMB_POINTS, win: p.netId === who }));
    cup.add(room.cupId, rows);
    result.cupTop = rows.slice(0, PLACE_POINTS.length).map((r) => ({ name: r.name, points: r.points }));
    for (const r of rows) send(r.client, { t: 'cupGain', points: r.points, ...cup.standing(r.pid) });
  }
  // Prize rounds pay the top places; each placed player privately gets a link for their wallet.
  let awards = [];
  if (result.prizeRound && room.pot) {
    const placed = placements(room, who, reason);
    awards = prizes.award({ arena: room.code, map: room.map, ...room.pot }, placed).map((a, i) => ({ ...a, client: placed[i].client }));
    result.places = awards.map(({ claim }) => ({ place: claim.place, name: claim.name, share: claim.share, label: money(claim.amount, claim.currency) }));
  }
  broadcast(room, result);
  for (const { claim, token, client } of awards) {
    send(client, { t: 'prize', token, place: claim.place, share: claim.share, label: money(claim.amount, claim.currency), pot: money(room.pot.amount, room.pot.currency), map: room.map, at: claim.at });
  }
  if (result.prizeRound && room.pot) telegram.notify(roundMessage(room, awards.map((a) => a.claim)));
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
      client.style = cleanStyle(msg.style);
      // A random secret kept in the player's browser gives them a stable id across visits.
      const pid = pidOf(msg.secret);
      if (pid) {
        client.pid = pid;
        stats.seen(client.pid, client.name);
        // A cup prize still waiting for its wallet: ask for it as soon as they're back.
        if (msg.t === 'hello') for (const c of prizes.pendingFor(pid)) send(client, cupPrizeMessage(c));
      }
      if (room) sendRoom(room);
      return;
    }
    case 'me':
      return send(client, { t: 'me', ...(client.pid ? stats.me(client.pid) : { name: client.name, wins: 0, rounds: 0, recent: [] }), cup: cup.standing(client.pid) });
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
      if (!room.guard.inReach(String(msg.by), target) || !hitAllowed(room, String(msg.by), target)) return;
      const ownerId = target.startsWith('p:') ? Number(target.slice(2)) : room.botOwner;
      const owner = room.clients.get(ownerId);
      if (!owner || owner === client) return;
      const dir = Array.isArray(msg.dir) ? [num(msg.dir[0], -1, 1), num(msg.dir[1], -1, 1)] : [0, 1];
      send(owner, { t: 'hit', target, by: String(msg.by), dir, force: num(msg.force, 0, 30), up: num(msg.up, 0, 12), stun: num(msg.stun, 0, 3), dmg: num(msg.dmg, 0, 80), root: num(msg.root, 0, 3) });
      return;
    }
    case 'trap': {
      if (room.phase !== 'playing' || !owns(room, client, msg.owner)) return;
      const owner = String(msg.owner);
      const vec = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v) && Math.abs(v) < 500);
      if (!TRAPS.includes(msg.kind) || !vec(msg.pos) || !vec(msg.normal) || !vec(msg.dir) || !Number.isFinite(msg.ground)) return;
      // Only where the owner is standing, and only as many as they've actually got.
      if (!room.guard.near(owner, msg.pos[0], msg.pos[1], msg.pos[2], 8)) return;
      const used = room.traps.get(owner) ?? { placed: 0, allowance: START_TRAPS };
      if (used.placed >= used.allowance) return;
      used.placed++;
      room.traps.set(owner, used);
      const id = String(msg.id ?? '').slice(0, 40);
      broadcast(room, { t: 'trap', id, kind: msg.kind, owner, pos: msg.pos, normal: msg.normal, dir: msg.dir, ground: msg.ground }, client);
      return;
    }
    case 'trapUse':
      if (room.phase === 'playing') broadcast(room, { t: 'trapUse', id: String(msg.id ?? '').slice(0, 40) }, client);
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
      // A fighter can't vacuum up every crate on the map at once.
      const taker = String(msg.who);
      if (now() - (room.lastTake.get(taker) ?? 0) < 1000) return;
      room.lastTake.set(taker, now());
      const allowance = room.traps.get(taker) ?? { placed: 0, allowance: START_TRAPS };
      allowance.allowance++;
      room.traps.set(taker, allowance);
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
const connPerIp = new Map();
wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const open = (connPerIp.get(ip) ?? 0) + 1;
  if (open > MAX_CONN_PER_IP) return ws.close(1008, 'too many connections');
  connPerIp.set(ip, open);
  ws.on('close', () => {
    const n = (connPerIp.get(ip) ?? 1) - 1;
    if (n > 0) connPerIp.set(ip, n);
    else connPerIp.delete(ip);
  });
  const client = { id: nextClient++, ws, ip, name: 'Player', style: null, room: null, focused: true, pid: null, budget: 0, budgetAt: now() };
  clients.add(client);
  ws.on('close', () => clients.delete(client));
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
    if (!msg || typeof msg.t !== 'string') return;
    // One odd message must never take the whole server (and everyone's round) down with it.
    try {
      handle(client, msg);
    } catch (e) {
      console.warn(`message ${String(msg.t).slice(0, 20)} from ${client.name} (${client.id}) failed: ${e.message}`);
    }
  });
  ws.on('close', () => leave(client));
});

// ------------------------------------------------------------------ the cup

/** What a cup winner's game gets: their place and prize, to claim with this browser's secret. */
function cupPrizeMessage(c) {
  return { t: 'prize', cup: true, id: c.id, cupId: c.cupId, place: c.place, points: c.points, share: c.share, label: money(c.amount, c.currency), at: c.at };
}

/** Close the cup: the top of the table get their prize claims (and a message, if they're online). */
function finishCup() {
  const c = cup.current;
  const claims = prizes.awardCup(c, cup.finish());
  telegram.notify(cupOverMessage(c, claims));
  for (const claim of claims) {
    for (const client of clients) if (client.pid === claim.pid) send(client, cupPrizeMessage(claim));
  }
  announceSettings();
}

function cupOverMessage(c, claims) {
  const lines = [`🏆 <b>Cup #${c.id} is over</b>`];
  for (const k of claims) lines.push(`${MEDAL[k.place - 1] ?? `${k.place}.`} <b>${esc(k.name)}</b> · ${k.points} pts · ${esc(money(k.amount, k.currency))}`);
  if (!claims.length) lines.push('Nobody scored a point, so there is nothing to pay.');
  else lines.push('They claim it in the game (from the browser that earned the points); their wallets arrive here.');
  return lines.join('\n');
}

// At the end time no new cup rounds start; rounds already running finish and count, then it closes.
setInterval(() => {
  const c = cup.current;
  if (!cup.running || Date.now() < c.endsAt) return;
  const busy = arenas.some((a) => a.phase === 'playing' && a.cupId === c.id);
  if (busy && Date.now() < c.endsAt + (MATCH_SECONDS + 60) * 1000) return;
  finishCup();
}, 5000);

// ------------------------------------------------------------------ telegram

/** Push changed prize settings to everyone waiting in a lobby (rounds in progress keep theirs). */
function announceSettings() {
  for (const r of [...arenas, ...rooms.values()]) sendRoom(r);
}

function settingsText() {
  const s = P();
  const shares = s.split.map((p, i) => `${ORDINAL[i]} ${p}% (${money((s.amount * p) / 100, s.currency)})`).join(', ');
  return [
    cup.running ? '🏆 <b>A cup is running</b>, so rounds play for cup points, not the pot below. /cup for the table.' : '',
    `<b>Prize pot:</b> ${esc(money(s.amount, s.currency))} per prize round`,
    `<b>Split:</b> ${esc(shares)}`,
    `<b>Prize and cup rounds need:</b> ${s.minPlayers} real players`,
  ]
    .filter(Boolean)
    .join('\n');
}

const HELP = [
  '<b>SISYPHUS prize bot</b>',
  '<b>The cup</b> (a leaderboard with prizes for the top places):',
  '/cup: the cup and its top 5',
  '/cup start 7d 100 100 100 USDC: start one (ends in 7 days, or 48h, or on a date like 2026-10-30; then the prize for each place)',
  '/cup prizes 150 100 50: change the prizes while it runs',
  '/cup ends 3d: change when it ends',
  '/cup top: the top 15',
  '/cup end: close it now and pay the top places · /cup cancel: call it off, no prizes',
  '',
  '<b>Round prizes</b> (when no cup is running):',
  '/pool: show the pot and split',
  '/pool 50 $: set the pot per prize round (or /pool 0 to turn prizes off)',
  '/split 60 25 15: how the pot is shared between the top places (1 to 3 numbers adding to 100)',
  '/minplayers 4: real players a round needs to count',
  '',
  '/claims: the latest winners and their wallets',
  '/status: who is playing right now',
].join('\n');

const CUP_POINTS = `${PLACE_POINTS.map((p, i) => `${ORDINAL[i]} ${p}`).join(', ')}, everyone else above floor ${MIN_PRIZE_FLOOR}: ${CLIMB_POINTS}`;
const utc = (t) => `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

function countdown(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

function cupTable(n) {
  const rows = cup.standings().slice(0, n);
  if (!rows.length) return '<i>Nobody has scored yet.</i>';
  return rows.map((s, i) => `${i + 1}. <b>${esc(s.name)}</b> · ${s.points} pts (${s.wins} win${s.wins === 1 ? '' : 's'}, ${s.rounds} round${s.rounds === 1 ? '' : 's'})`).join('\n');
}

function cupText() {
  const c = cup.current;
  if (!c) return 'No cup yet. Start one with /cup start 7d 100 100 100 USDC';
  const total = c.prizes.reduce((a, b) => a + b, 0);
  const state = !c.finishedAt
    ? Date.now() < c.endsAt
      ? `running, ends ${utc(c.endsAt)} (in ${countdown(c.endsAt - Date.now())})`
      : 'closing (waiting for the last rounds to finish)'
    : `over since ${utc(c.finishedAt)}`;
  return [
    `🏆 <b>Cup #${c.id}</b> · ${state}`,
    `<b>Prizes:</b> ${c.prizes.map((p, i) => `${ORDINAL[i] ?? `${i + 1}th`} ${esc(money(p, c.currency))}`).join(', ')} (total ${esc(money(total, c.currency))})`,
    `<b>Points per round:</b> ${CUP_POINTS}. Rounds need ${P().minPlayers} real players to count.`,
    '',
    cupTable(5),
  ].join('\n');
}

/** "7d", "48h", "2026-10-30" (the end of that day, UTC) or "2026-10-30T18:00" (UTC). */
function parseEnd(s) {
  const v = String(s ?? '').trim();
  let t = NaN;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)d$/i.exec(v))) t = Date.now() + Number(m[1]) * 86400000;
  else if ((m = /^(\d+(?:\.\d+)?)h$/i.exec(v))) t = Date.now() + Number(m[1]) * 3600000;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v))) t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(t) || t <= Date.now() + 60000 || t > Date.now() + 120 * 86400000) return null;
  return t;
}

/** "100 100 100 USDC" or "$150 $100 $50": the prize for each place, then the currency (else `fallback`). */
function parsePrizes(args, fallback) {
  const nums = [];
  let currency = null;
  for (const a of args) {
    const n = Number(String(a).replace(/^\$/, ''));
    if (Number.isFinite(n) && String(a).trim() !== '') {
      if (n < 0 || n > 1e9) return null;
      nums.push(n);
      if (String(a).startsWith('$')) currency ??= '$';
    } else if (currency === null || currency === '$') currency = String(a).slice(0, 8);
    else return null;
  }
  if (!nums.length || nums.length > MAX_CUP_PLACES) return null;
  return { prizes: nums, currency: currency ?? fallback };
}

async function onCupCommand(args) {
  const [sub = '', ...rest] = args;
  switch (sub.toLowerCase()) {
    case '':
    case 'status':
      return cupText();
    case 'top':
      return cup.current ? `🏆 <b>Cup #${cup.current.id}</b>\n${cupTable(15)}` : 'No cup yet.';
    case 'start': {
      if (cup.running) return 'A cup is already running. Change it with /cup prizes or /cup ends, or close it with /cup end.';
      const endsAt = parseEnd(rest[0]);
      const p = parsePrizes(rest.slice(1), P().currency);
      if (!endsAt || !p) return 'Usage: /cup start 7d 100 100 100 USDC\n(when it ends: 7d, 48h or 2026-10-30; then the prize for 1st, 2nd, 3rd…)';
      cup.start({ endsAt, ...p });
      // The cup replaces round prizes; zero the pot so they don't quietly come back when it ends.
      const hadPot = P().amount > 0;
      if (hadPot) prizes.update({ amount: 0 });
      announceSettings();
      return `✅ Cup started. Everyone starts from 0 points.${hadPot ? '\nRound prizes are off now (pot set to 0); /pool turns them back on after the cup.' : ''}\n\n${cupText()}`;
    }
    case 'prizes': {
      if (!cup.running) return 'No cup is running. Start one with /cup start.';
      const p = parsePrizes(rest, cup.current.currency);
      if (!p) return 'Usage: /cup prizes 150 100 50 (the prize for 1st, 2nd, 3rd…, then the currency if it changes)';
      cup.update(p);
      announceSettings();
      return `✅ Prizes changed.\n\n${cupText()}`;
    }
    case 'ends': {
      if (!cup.running) return 'No cup is running.';
      const endsAt = parseEnd(rest[0]);
      if (!endsAt) return 'Usage: /cup ends 3d (or 48h, or 2026-10-30, or 2026-10-30T18:00 in UTC)';
      cup.update({ endsAt });
      announceSettings();
      return `✅ End time changed.\n\n${cupText()}`;
    }
    case 'end': {
      if (!cup.running) return 'No cup is running.';
      finishCup();
      return 'Cup closed. The results are on their way.';
    }
    case 'cancel': {
      if (!cup.current || cup.current.finishedAt) return 'No cup is running.';
      cup.cancel();
      announceSettings();
      return 'Cup called off. Nobody gets a prize and it no longer shows in the game.';
    }
    default:
      return HELP;
  }
}

async function onTelegramCommand(name, args) {
  switch (name) {
    case 'start':
    case 'help':
      return `${HELP}\n\n${settingsText()}`;
    case 'cup':
      return onCupCommand(args);
    case 'pool': {
      if (!args.length) return settingsText();
      const amount = Number(String(args[0]).replace(/^\$/, ''));
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return 'Usage: /pool 2.5 SOL (a number, then the currency)';
      const currency = String(args[1] ?? (String(args[0]).startsWith('$') ? '$' : P().currency)).slice(0, 8);
      prizes.update({ amount, currency });
      announceSettings();
      return `✅ Pot set. ${cup.running ? 'It applies once the cup is over.' : 'Rounds starting from now play for it.'}\n\n${settingsText()}`;
    }
    case 'split': {
      const split = args.map(Number);
      if (!split.length || split.length > 3 || split.some((p) => !Number.isFinite(p) || p <= 0) || Math.abs(split.reduce((a, b) => a + b, 0) - 100) > 0.001) {
        return 'Usage: /split 60 25 15 (1 to 3 numbers that add up to 100)';
      }
      prizes.update({ split });
      announceSettings();
      return `✅ Split set.\n\n${settingsText()}`;
    }
    case 'minplayers': {
      const n = Math.floor(Number(args[0]));
      if (!Number.isFinite(n) || n < 1 || n > MAX_PLAYERS) return `Usage: /minplayers 4 (1 to ${MAX_PLAYERS})`;
      prizes.update({ minPlayers: n });
      announceSettings();
      return `✅ Prize rounds now need ${n} real player${n === 1 ? '' : 's'}.`;
    }
    case 'claims': {
      const list = prizes.recent(10);
      if (!list.length) return 'No prize winners yet.';
      return list
        .map((c) => `#${c.id} ${MEDAL[c.place - 1] ?? ''} <b>${esc(c.name)}</b> ${esc(money(c.amount, c.currency))}\n${c.wallet ? `<code>${esc(c.wallet)}</code>` : '<i>waiting for wallet</i>'}`)
        .join('\n\n');
    }
    case 'status': {
      const lines = arenas.map((a) => `${esc(a.code)} · ${esc(MAP_NAMES[a.map] ?? a.map)} · ${a.phase} · ${a.clients.size} player${a.clients.size === 1 ? '' : 's'}${prizeRound(a) ? ' · prize round' : cupRound(a) ? ' · cup round' : ''}`);
      return `<b>${wss.clients.size} online</b>\n${lines.join('\n') || 'No public rounds running.'}`;
    }
    default:
      return HELP;
  }
}

const telegram = new TelegramBot({
  token: env.TELEGRAM_BOT_TOKEN,
  admins: String(env.TELEGRAM_ADMIN_IDS ?? '').split(',').map((s) => s.trim()),
  onCommand: onTelegramCommand,
  commands: [
    { command: 'cup', description: 'The cup: start, prizes, ends, top, end' },
    { command: 'pool', description: 'Show or set the prize pot' },
    { command: 'split', description: 'How the pot is shared (e.g. 60 25 15)' },
    { command: 'minplayers', description: 'Real players a prize round needs' },
    { command: 'claims', description: 'Latest winners and their wallets' },
    { command: 'status', description: 'Who is playing right now' },
    { command: 'help', description: 'All commands' },
  ],
});
telegram.start();

server.listen(CFG.port, () => console.log(`SISYPHUS server on :${CFG.port} (ws /ws, stats ${CFG.dataDir})`));
