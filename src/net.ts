import type { Style } from './style';
import { socketUrl } from './endpoint';
import type { MapId } from './arena';

export interface RoomPlayer {
  id: number;
  name: string;
  style: Style | null;
}

export interface RoomInfo {
  code: string;
  /** Public arena (PLAY ONLINE) rather than a friends room. */
  public: boolean;
  host: number;
  phase: 'lobby' | 'playing' | 'ended';
  /** The map this round is on (or the next one, between rounds). */
  map: MapId;
  bots: boolean;
  /** Server time the next round starts (public arenas waiting), else 0. */
  nextAt: number;
  /** Server time the current round started. */
  at: number;
  matchSeconds: number;
  prize: number;
  currency: string;
  /** How the pot is shared between the top places, in percent (e.g. [60, 25, 15]). */
  split: number[];
  minPlayers: number;
  /** Enough real players for the prize to be on. */
  prizeRound: boolean;
  /** This round counts for the cup (a cup is on and there are enough real players). */
  cupRound?: boolean;
  cup?: CupSummary | null;
  players: RoomPlayer[];
}

/** The cup: a leaderboard with prizes for the top places, run for a set time. */
export interface CupSummary {
  id: number;
  /** Still taking points. */
  running: boolean;
  /** New rounds can still count (until the end time). */
  open: boolean;
  /** Seconds until it ends. */
  endsIn: number;
  /** The prize for 1st, 2nd, 3rd… */
  prizes: number[];
  currency: string;
}

/** Stable anonymous identity: a random secret kept in this browser (the server only sees a hash). */
export function playerSecret(): string {
  const KEY = 'sisyphus.secret';
  try {
    const s = localStorage.getItem(KEY);
    if (s && /^[0-9a-f]{32,64}$/.test(s)) return s;
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export interface RosterEntry {
  netId: string;
  kind: 'human' | 'bot';
  owner: number;
  name?: string;
  style?: Style | null;
  seed?: number;
  spawn: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = { t: string; [k: string]: any };
type Handler = (msg: Msg) => void;

/** WebSocket client with clock sync against the server's monotonic clock. */
export class Net {
  id = 0;
  room: RoomInfo | null = null;
  private ws: WebSocket | null = null;
  private offset = 0;
  private bestRtt = Infinity;
  private readonly handlers = new Map<string, Handler[]>();
  private pingTimer: number | null = null;

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get isHost(): boolean {
    return !!this.room && this.room.host === this.id;
  }

  on(type: string, fn: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  off(type: string, fn: Handler): void {
    const list = this.handlers.get(type);
    if (list) this.handlers.set(type, list.filter((h) => h !== fn));
  }

  /** Handle the next message of this type only. */
  once(type: string, fn: Handler): void {
    const wrap: Handler = (m) => {
      this.off(type, wrap);
      fn(m);
    };
    this.on(type, wrap);
  }

  /** Server clock (ms) estimated locally. */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    const url = socketUrl();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = () => {
        clearTimeout(timer);
        ws.onclose = null;
        ws.close();
        if (this.ws === ws) this.ws = null;
        reject(new Error("Couldn't reach the game server."));
      };
      const timer = window.setTimeout(fail, 8000);
      ws.onerror = fail;
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onerror = null;
        this.bestRtt = Infinity;
        this.ping();
        this.pingTimer = window.setInterval(() => this.ping(), 2000);
        resolve();
      };
      ws.onclose = () => {
        if (this.pingTimer !== null) clearInterval(this.pingTimer);
        this.pingTimer = null;
        this.ws = null;
        this.room = null;
        this.emit({ t: 'disconnected' });
      };
      ws.onmessage = (ev) => {
        let msg: Msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.t === 'welcome') this.id = msg.id;
        if (msg.t === 'pong') this.onPong(msg);
        if (msg.t === 'room') this.room = msg as unknown as RoomInfo;
        this.emit(msg);
      };
    });
  }

  send(msg: Msg): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  disconnect(): void {
    this.ws?.close();
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() });
  }

  private onPong(msg: Msg): void {
    const t = performance.now();
    const rtt = t - msg.c;
    // Keep the estimate from the fastest round trip (least queueing noise), but let it age.
    this.bestRtt *= 1.02;
    if (rtt <= this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = msg.s + rtt / 2 - t;
    }
  }

  private emit(msg: Msg): void {
    for (const fn of this.handlers.get(msg.t) ?? []) fn(msg);
  }
}
