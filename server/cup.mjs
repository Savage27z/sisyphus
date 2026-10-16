// The cup: a leaderboard that runs until a set time, started from the Telegram bot. Every ranked
// round (public, enough real players) gives points to the players who placed; when the cup ends,
// the top places each get a prize claim (paid by hand, like round prizes). While a cup runs,
// rounds pay no prize of their own. Kept in DATA_DIR/cup.json, written atomically.

import fs from 'node:fs';
import path from 'node:path';

/** Points for 1st, 2nd and 3rd in a ranked round (real players only, in finishing order). */
export const PLACE_POINTS = [10, 6, 4];
/** Everyone else who finishes the round high enough to place at all. */
export const CLIMB_POINTS = 1;
/** Most prize places a cup can have. */
export const MAX_CUP_PLACES = 10;
const MAX_PAST = 20;

export class Cup {
  constructor(dir) {
    this.file = path.join(dir, 'cup.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { cup: null, scores: {}, past: [], nextId: 1 };
    if (fs.existsSync(this.file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (e) {
        const bad = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, bad);
        console.error(`cup: could not read ${this.file} (${e.message}); moved it to ${bad}`);
      }
    }
    this.timer = null;
  }

  /** The latest cup (running, or over and still showing its results), or null. */
  get current() {
    const c = this.data.cup;
    return c && !c.cancelled ? c : null;
  }

  /** Taking points: started and not closed yet (rounds already under way at the end time still count). */
  get running() {
    return !!this.current && !this.current.finishedAt;
  }

  /** New rounds can still become cup rounds (until the end time). */
  get open() {
    return this.running && Date.now() < this.current.endsAt;
  }

  /** A new cup: everyone starts again from zero. */
  start({ endsAt, prizes, currency }) {
    this.data.cup = { id: this.data.nextId++, startedAt: Date.now(), endsAt, prizes, currency, finishedAt: 0, winners: [] };
    this.data.scores = {};
    this.save();
    return this.data.cup;
  }

  /** Change the prizes or the end time of the running cup. */
  update(patch) {
    Object.assign(this.data.cup, patch);
    this.save();
    return this.data.cup;
  }

  /** Points from one ranked round, `rows` in finishing order: [{ pid, name, points, win }]. */
  add(cupId, rows) {
    if (!this.running || this.current.id !== cupId) return;
    const t = Date.now();
    for (const r of rows) {
      if (!r.pid || !(r.points > 0)) continue;
      const s = (this.data.scores[r.pid] ??= { name: r.name, points: 0, wins: 0, rounds: 0, at: t });
      s.name = r.name;
      s.points += r.points;
      if (r.win) s.wins++;
      s.rounds++;
      // When they reached this total: of two players on the same points, the one there first is ahead.
      s.at = t;
    }
    this.save();
  }

  /** Highest first; a tie goes to whoever got there first. */
  standings() {
    return Object.entries(this.data.scores)
      .map(([pid, s]) => ({ pid, ...s }))
      .sort((a, b) => b.points - a.points || a.at - b.at);
  }

  /** One player's place: { rank, points, wins }, or null if they haven't scored. */
  standing(pid) {
    if (!pid || !this.data.scores[pid]) return null;
    const list = this.standings();
    const i = list.findIndex((s) => s.pid === pid);
    return { rank: i + 1, points: list[i].points, wins: list[i].wins };
  }

  /** Close the cup. Returns the players in the prize places, in order. */
  finish() {
    const c = this.current;
    const top = this.standings().slice(0, c.prizes.length);
    c.finishedAt = Date.now();
    c.winners = top.map((s) => ({ pid: s.pid, name: s.name, points: s.points }));
    this.data.past.push({ id: c.id, startedAt: c.startedAt, endsAt: c.endsAt, finishedAt: c.finishedAt, prizes: c.prizes, currency: c.currency, winners: c.winners });
    if (this.data.past.length > MAX_PAST) this.data.past.splice(0, this.data.past.length - MAX_PAST);
    this.save();
    return top;
  }

  /** Called off: no prizes, and it stops showing. */
  cancel() {
    this.data.cup.cancelled = true;
    this.data.cup.finishedAt ||= Date.now();
    this.save();
  }

  /** What players see about the cup (no player ids). */
  summary() {
    const c = this.current;
    if (!c) return null;
    return {
      id: c.id,
      running: !c.finishedAt,
      open: this.open,
      endsIn: Math.max(0, Math.round((c.endsAt - Date.now()) / 1000)),
      prizes: c.prizes,
      currency: c.currency,
    };
  }

  /** The summary plus the table (and the winners, once it's over). */
  view(n = 50) {
    const s = this.summary();
    if (!s) return null;
    return {
      ...s,
      rows: this.standings().slice(0, n).map((p) => ({ name: p.name, points: p.points, wins: p.wins })),
      winners: s.running ? [] : this.current.winners.map((w) => ({ name: w.name, points: w.points })),
    };
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
