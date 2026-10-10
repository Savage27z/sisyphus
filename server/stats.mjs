// Public-round results and the wins leaderboard, kept in DATA_DIR/stats.json.
// One process writes it; writes are atomic (temp file + rename).

import fs from 'node:fs';
import path from 'node:path';

const MAX_ROUNDS = 2000;

export class Stats {
  constructor(dir) {
    this.file = path.join(dir, 'stats.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { players: {}, rounds: [] };
    if (fs.existsSync(this.file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch (e) {
        // Never start over silently: keep the unreadable file for a human to look at.
        const bad = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, bad);
        console.error(`stats: could not read ${this.file} (${e.message}); moved it to ${bad}`);
      }
    }
    this.timer = null;
  }

  player(pid) {
    this.data.players[pid] ??= { name: '', wins: 0, rounds: 0, firstSeen: Date.now(), lastSeen: 0 };
    return this.data.players[pid];
  }

  seen(pid, name) {
    const p = this.player(pid);
    p.name = name;
    p.lastSeen = Date.now();
    this.save();
  }

  /** A public round finished. `entrants` are the humans' player ids. */
  recordRound(r) {
    for (const pid of r.entrants) this.player(pid).rounds++;
    if (r.winnerPid) this.player(r.winnerPid).wins++;
    this.data.rounds.push({
      at: Date.now(),
      arena: r.arena,
      winner: r.winnerPid,
      winnerName: r.winnerName,
      humans: r.entrants.length,
      prizeRound: r.prizeRound,
      reason: r.reason,
      flagged: r.flagged,
    });
    if (this.data.rounds.length > MAX_ROUNDS) this.data.rounds.splice(0, this.data.rounds.length - MAX_ROUNDS);
    this.save();
  }

  leaderboard(n = 50) {
    return Object.values(this.data.players)
      .filter((p) => p.wins > 0)
      .sort((a, b) => b.wins - a.wins || a.rounds - b.rounds)
      .slice(0, n)
      .map((p) => ({ name: p.name, wins: p.wins, rounds: p.rounds }));
  }

  me(pid) {
    const p = this.player(pid);
    const wins = this.data.rounds
      .filter((r) => r.winner === pid)
      .slice(-12)
      .reverse()
      .map((r) => ({ at: r.at, prizeRound: r.prizeRound, reason: r.reason }));
    return { name: p.name, wins: p.wins, rounds: p.rounds, recent: wins };
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
