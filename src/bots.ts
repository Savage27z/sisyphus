import RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three';
import { WEAPONS } from './combat';
import { TRAP_KINDS } from './traps';
import type { Character } from './character';
import type { Crate } from './airdrop';
import type { Waypoint } from './building';
import type { Game } from './game';

export interface BotSkill {
  speed: number;
  /** 0..1 chance to swing when someone is in range. */
  aggression: number;
  /** 0..1 chance to hop over an incoming sweeper bar. */
  reflex: number;
}

const DOWN = { x: 0, y: -1, z: 0 };

function weightedPick(weights: number[]): number {
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Waypoint-following bot that climbs, waits for platforms, fights and lays traps. */
export class Bot {
  idx = 0;
  /** This bot's way up: one alternative stitched in per route segment. */
  private path: Waypoint[] = [];
  private segStart: number[] = [];
  private choice: number[] = [];
  private bestDist = Infinity;
  private stuckT = 0;
  private thinkT = 0;
  /** Net escape: back up toward the middle, then run out and trampoline-jump over the edge. */
  private netPhase: 'backup' | 'run' = 'backup';
  private netJump = false;
  private readonly lead = new THREE.Vector3();
  /** Breather after a swing so bunched-up bots climb instead of brawling forever. */
  private restT = 0;
  private trapT = 0;
  private dodgeRoll = Math.random();

  constructor(
    readonly c: Character,
    readonly skill: BotSkill,
    private readonly game: Game,
  ) {
    c.speedMul = skill.speed;
    this.reset();
  }

  reset(): void {
    this.idx = 0;
    this.choice = this.game.tower.route.map((seg) => weightedPick(seg.weights));
    this.buildPath();
    this.bestDist = Infinity;
    this.stuckT = 0;
    this.thinkT = Math.random() * 0.3;
    this.trapT = 6 + Math.random() * 8;
  }

  private buildPath(): void {
    this.path = [];
    this.segStart = [];
    this.game.tower.route.forEach((seg, i) => {
      this.segStart.push(this.path.length);
      this.path.push(...seg.alts[Math.min(this.choice[i] ?? 0, seg.alts.length - 1)]);
    });
  }

  /** At a fork, lean toward the way with fewer fighters on it (so a full lobby spreads out). */
  private pickAlt(si: number): void {
    const seg = this.game.tower.route[si];
    if (seg.alts.length < 2) return;
    let best = this.choice[si];
    let bestScore = -1;
    seg.alts.forEach((alt, ai) => {
      const probe = alt[Math.min(3, alt.length - 1)].pos;
      let crowd = 0;
      for (const o of this.game.characters) {
        if (o !== this.c && Math.abs(o.feetY - probe.y) < 2.5 && Math.hypot(o.pos.x - probe.x, o.pos.z - probe.z) < 16) crowd++;
      }
      const score = (seg.weights[ai] / (1 + crowd)) * (0.6 + Math.random() * 0.8);
      if (score > bestScore) {
        bestScore = score;
        best = ai;
      }
    });
    if (best !== this.choice[si]) {
      this.choice[si] = best;
      this.buildPath();
    }
  }

  update(dt: number): void {
    const c = this.c;
    const game = this.game;
    const wps = this.path;
    c.input.moveX = c.input.moveZ = 0;
    c.input.jump = false;
    c.input.sprint = true;
    if (c.stun > 0) return;

    // Bounced into a safety net: head for the nearest edge and hop out.
    const netExit = this.netExit();
    // (A trampoline jump goes out of the net's range mid-air; keep the plan until we land.)
    if (!netExit && c.grounded) this.netPhase = 'backup';
    // Fell off the route? (Below both the waypoint we came from and the one we're heading to —
    // a waypoint up a staircase alone doesn't count.)
    const floorRef = Math.min(wps[this.idx].pos.y, wps[Math.max(0, this.idx - 1)].pos.y);
    if (!netExit && c.grounded && c.feetY < floorRef - 2) this.retarget();
    const wp = wps[this.idx];
    const atSummit = this.idx === wps.length - 1;
    const holder = game.flag.holder;

    // Pick what to go for: flag holder > nearby crate > next waypoint.
    let target = wp.pos;
    // Moving platforms: aim where the platform will be when we land, not where it is now.
    if (wp.platform) {
      const lead = THREE.MathUtils.clamp(Math.hypot(wp.pos.x - c.pos.x, wp.pos.z - c.pos.z) / 6 + 0.25, 0.25, 0.9);
      target = wp.platform.posAt(game.time + lead, this.lead).add(new THREE.Vector3(0, wp.platform.half.y, 0));
    }
    let jumpNeeded = !!wp.jump;
    let ready = wp.ready ? wp.ready(c) : true;
    let following = true;
    const crate = c.weapon === 'blaster' || c.melee === 'fists' ? this.nearbyCrate() : null;
    if (netExit) {
      target = netExit;
      jumpNeeded = true;
      ready = true;
      following = false;
    } else if (atSummit && holder && holder !== c) {
      target = holder.pos.clone().setY(holder.feetY);
      jumpNeeded = false;
      ready = true;
      following = false;
    } else if (crate) {
      target = crate.target;
      jumpNeeded = true;
      ready = true;
      following = false;
    }

    const dx = target.x - c.pos.x;
    const dz = target.z - c.pos.z;
    const hd = Math.hypot(dx, dz);
    const dy = target.y - c.feetY;

    // Arrival is judged against where a moving platform is now, not the lead point.
    const arriveD = wp.platform ? Math.hypot(wp.pos.x - c.pos.x, wp.pos.z - c.pos.z) : hd;
    if (following && !atSummit && c.grounded && arriveD < (wp.radius ?? 1) && Math.abs(dy) < 1) {
      this.idx++;
      const si = this.segStart.indexOf(this.idx);
      if (si >= 0) this.pickAlt(si);
      this.bestDist = Infinity;
      this.stuckT = 0;
      this.think(dt);
      return;
    }

    if (!ready) {
      c.yaw = Math.atan2(dx, dz);
      this.think(dt);
      return;
    }

    if (hd > 0.25) {
      const mx = dx / hd;
      const mz = dz / hd;
      const precise = (wp.radius ?? 1) < 0.7 && following;
      // Don't sprint into jumps, and brake in the air so we land on small targets instead of overshooting.
      c.input.sprint = netExit ? true : !(precise && hd < 2) && !(jumpNeeded && hd < 5);
      const scale = c.grounded ? 1 : THREE.MathUtils.clamp(hd / 2.2, 0.1, 1);
      c.input.moveX = mx * scale;
      c.input.moveZ = mz * scale;
      c.yaw = Math.atan2(mx, mz);

      if (c.grounded) {
        if (netExit) {
          if (this.netJump) c.input.jump = true;
        } else if (jumpNeeded && dy > -0.8 && (hd < 2.0 || this.edgeAhead(mx, mz))) c.input.jump = true;
        else if (dy > 0.55 && hd < 1.8) c.input.jump = true;
      }
    }

    this.dodgeSweepers();
    if (this.skill.reflex > 0.45) this.waitForPendulums();
    this.waitForTiles();
    this.waitForBoulders();
    this.waitForLasers();

    // Unstick: hop, then re-plan.
    if (hd < this.bestDist - 0.3) {
      this.bestDist = hd;
      this.stuckT = 0;
    } else {
      this.stuckT += dt;
    }
    if (this.stuckT > 2.5 && c.grounded) c.input.jump = true;
    if (this.stuckT > 6) {
      this.retarget();
      this.stuckT = 0;
      this.bestDist = Infinity;
    }

    this.think(dt);
  }

  /**
   * In a safety net (on it or bouncing above it)? Back off to a launch spot well
   * inside the net, then trampoline-jump out toward the nearest edge.
   */
  private netExit(): THREE.Vector3 | null {
    const c = this.c;
    this.netJump = false;
    const net = this.game.tower.netAt(c.pos.x, c.feetY, c.pos.z);
    if (!net) return null;
    let best: THREE.Vector3 | null = null;
    let bd = Infinity;
    for (const e of net.exits) {
      const d = Math.hypot(e.x - c.pos.x, e.z - c.pos.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best) return null;
    const r = Math.hypot(best.x, best.z);
    const fromCenter = (c.pos.x * best.x + c.pos.z * best.z) / r;
    if (c.grounded) {
      if (this.netPhase === 'backup' && fromCenter < 1.6) this.netPhase = 'run';
      else if (this.netPhase === 'run' && fromCenter > 5.2) this.netPhase = 'backup'; // overshot the take-off: retry
    }
    if (this.netPhase === 'backup') return best.clone().multiplyScalar(1 / r).setY(net.y);
    if (c.grounded && fromCenter > 3.6) this.netJump = true;
    return best;
  }

  /**
   * Pick up the climb from wherever we ended up: the most advanced nearby waypoint at or
   * below our height that we can actually see (rooms have walls), on any of the routes.
   */
  retarget(): void {
    const c = this.c;
    const cands: { si: number; ai: number; wi: number; score: number; pos: THREE.Vector3 }[] = [];
    this.game.tower.route.forEach((seg, si) =>
      seg.alts.forEach((alt, ai) =>
        alt.forEach((w, wi) => {
          if (w.pos.y > c.feetY + 0.8) return;
          // Later waypoints win ties, so we never walk backwards along the route.
          const score = Math.hypot(w.pos.x - c.pos.x, w.pos.z - c.pos.z) + Math.abs(c.feetY - w.pos.y) * 3 - si * 1e-3 - wi * 1e-5;
          cands.push({ si, ai, wi, score, pos: w.pos });
        }),
      ),
    );
    cands.sort((a, b) => a.score - b.score);
    const pick = cands.slice(0, 6).find((k) => this.canSee(k.pos)) ?? cands[0];
    if (!pick) return;
    this.choice[pick.si] = pick.ai;
    this.buildPath();
    this.idx = this.segStart[pick.si] + pick.wi;
    this.bestDist = Infinity;
  }

  private canSee(p: THREE.Vector3): boolean {
    const c = this.c;
    const o = { x: c.pos.x, y: c.feetY + 0.9, z: c.pos.z };
    const d = { x: p.x - o.x, y: p.y + 0.9 - o.y, z: p.z - o.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 0.5) return true;
    const ray = new RAPIER.Ray(o, { x: d.x / len, y: d.y / len, z: d.z / len });
    return !this.game.world.castRay(ray, len, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, undefined, c.collider);
  }

  private nearbyCrate(): Crate | null {
    const c = this.c;
    for (const crate of this.game.airdrops.crates) {
      if (!crate.landed) continue;
      if (Math.abs(crate.target.y - c.feetY) > 1.5) continue;
      if (Math.hypot(crate.target.x - c.pos.x, crate.target.z - c.pos.z) < 7) return crate;
    }
    return null;
  }

  private edgeAhead(mx: number, mz: number): boolean {
    const c = this.c;
    const hit = this.game.world.castRay(
      new RAPIER.Ray({ x: c.pos.x + mx * 0.75, y: c.feetY + 0.3, z: c.pos.z + mz * 0.75 }, DOWN),
      1.2,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      c.collider,
    );
    return !hit;
  }

  private dodgeSweepers(): void {
    const c = this.c;
    if (!c.grounded) return;
    for (const s of this.game.tower.sweepers) {
      if (Math.abs(c.pos.y - s.pivot.y) > 1.1) continue;
      const rx = c.pos.x - s.pivot.x;
      const rz = c.pos.z - s.pivot.z;
      const r = Math.hypot(rx, rz);
      if (r > s.halfLen + 0.6) continue;
      // Angle between us and the nearest bar arm, in the direction it's spinning.
      const ours = Math.atan2(rz, rx);
      let gap = (ours - s.angle) * Math.sign(s.speed);
      gap = ((gap % Math.PI) + Math.PI) % Math.PI;
      // Whoever holds the flag always tries to hop the bar.
      const reflex = this.game.flag.holder === c ? 1 : this.skill.reflex;
      if (gap * r < 1.1 && this.dodgeRoll < reflex) c.input.jump = true;
    }
    if (Math.random() < 0.02) this.dodgeRoll = Math.random();
  }

  private hold(): void {
    const c = this.c;
    c.input.moveX = c.input.moveZ = 0;
    c.input.jump = false;
    this.stuckT = 0;
  }

  /** Don't walk into a hole where crumbling tiles just dropped (or a flip panel is about to open). */
  private waitForTiles(): void {
    const c = this.c;
    if (!c.grounded || (c.input.moveX === 0 && c.input.moveZ === 0)) return;
    const time = this.game.time;
    for (const f of this.game.tower.flipFloors) {
      // Standing on a panel that's about to go: keep moving.
      if (f.blocked(c.pos.x, c.feetY, c.pos.z, time, 0.35)) break;
      for (const d of [0.9, 1.8]) {
        if (f.blocked(c.pos.x + c.input.moveX * d, c.feetY, c.pos.z + c.input.moveZ * d, time, 0.6)) return this.hold();
      }
    }
    for (const d of [0.8, 1.6]) {
      const x = c.pos.x + c.input.moveX * d;
      const z = c.pos.z + c.input.moveZ * d;
      for (const t of this.game.tower.crumbles) {
        if (t.state === 'fallen' && t.covers(x, c.feetY, z)) {
          c.input.moveX = c.input.moveZ = 0;
          c.input.jump = false;
          this.stuckT = 0;
          return;
        }
      }
    }
  }

  /** Wait at the edge of a boulder lane while one is coming down it. */
  private waitForBoulders(): void {
    const c = this.c;
    if (!c.grounded || (c.input.moveX === 0 && c.input.moveZ === 0)) return;
    const ax = c.pos.x + c.input.moveX * 1.8;
    const az = c.pos.z + c.input.moveZ * 1.8;
    for (const b of this.game.tower.boulders) {
      if (Math.abs(b.from.y - c.feetY) > 1.5) continue;
      const rx = ax - b.from.x;
      const rz = az - b.from.z;
      const along = rx * b.dir.x + rz * b.dir.z;
      if (along < -1 || along > b.length + 1) continue;
      if (Math.abs(rx * b.dir.z - rz * b.dir.x) > b.radius + 0.9) continue;
      // Already in the lane? Then the way out is forward.
      const hx = c.pos.x - b.from.x;
      const hz = c.pos.z - b.from.z;
      if (Math.abs(hx * b.dir.z - hz * b.dir.x) < b.radius + 0.4) continue;
      if (b.threatens(this.game.time, Math.max(0, along), 1.3)) return this.hold();
    }
  }

  /** Wait in front of a laser curtain until it's safely off. */
  private waitForLasers(): void {
    const c = this.c;
    if (!c.grounded || (c.input.moveX === 0 && c.input.moveZ === 0)) return;
    const ax = c.pos.x + c.input.moveX * 1.3;
    const az = c.pos.z + c.input.moveZ * 1.3;
    for (const g of this.game.tower.lasers) {
      if (Math.abs(g.a.y - c.feetY) > 1.5) continue;
      if (g.distTo(ax, az) > 0.9 || g.distTo(c.pos.x, c.pos.z) < 0.6) continue;
      if (g.soonOn(this.game.time, 0.55)) return this.hold();
    }
  }

  /** Hold still while a wrecking ball swings through the spot just ahead of us. */
  private waitForPendulums(): void {
    const c = this.c;
    if (!c.grounded || (c.input.moveX === 0 && c.input.moveZ === 0)) return;
    const ahead = { x: c.pos.x + c.input.moveX * 1.4, z: c.pos.z + c.input.moveZ * 1.4 };
    for (const p of this.game.tower.pendulums) {
      if (Math.abs(p.center.y - c.pos.y) > 1.6) continue;
      const lane = Math.hypot(ahead.x - p.pivot.x, ahead.z - p.pivot.z);
      if (lane > 2.6) continue;
      const toUs = { x: ahead.x - p.center.x, z: ahead.z - p.center.z };
      const d = Math.hypot(toUs.x, toUs.z);
      const approaching = (toUs.x * p.axis.x + toUs.z * p.axis.z) * p.swing > 0;
      if (d < 3.2 && (approaching || d < 1.3)) {
        c.input.moveX = c.input.moveZ = 0;
        c.input.jump = false;
        return;
      }
    }
  }

  private think(dt: number): void {
    const c = this.c;
    const game = this.game;
    this.thinkT -= dt;
    this.trapT -= dt;
    this.restT -= dt;
    if (game.time < 3) return;

    if (this.thinkT <= 0 && this.restT <= 0) {
      this.thinkT = 0.2 + Math.random() * 0.15;
      const gun = WEAPONS[c.weapon];
      const melee = WEAPONS[c.melee];
      const gunRange = Math.min(gun.range, c.weapon === 'railgun' ? 45 : 22);
      let best: Character | null = null;
      let bestScore = 0;
      let bestD = 0;
      for (const t of game.characters) {
        if (t === c || t.stun > 0.4) continue;
        const d = t.pos.distanceTo(c.pos);
        if (d > gunRange || Math.abs(t.pos.y - c.pos.y) > 6) continue;
        let score = 1 / (d + 0.5);
        if (t === game.flag.holder) score *= 6;
        if (t.feetY > c.feetY + 0.5) score *= 1.5;
        if (score > bestScore) {
          bestScore = score;
          best = t;
          bestD = d;
        }
      }
      // Mostly climb; go for it when the target is ahead of us or holding the flag.
      let urgency = 0.45;
      if (best && best.feetY > c.feetY + 0.3) urgency = 1;
      if (best && best === game.flag.holder) urgency = 3;
      if (best && Math.random() < this.skill.aggression * urgency) {
        c.yaw = Math.atan2(best.pos.x - c.pos.x, best.pos.z - c.pos.z);
        const close = bestD < melee.range + 0.3 && Math.abs(best.pos.y - c.pos.y) < 1.5;
        if (close && c.meleeCooldown <= 0) {
          game.combat.melee(c);
          this.restT = best === game.flag.holder ? 0.3 : 1.0 + Math.random() * 1.5;
        } else if (!close && c.gunCooldown <= 0 && this.canSee(best.pos)) {
          // Aim at the body, with a miss that shrinks as they get closer.
          const origin = c.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
          const dir = best.pos.clone().sub(origin);
          const err = 0.6 + bestD * 0.04;
          dir.x += (Math.random() - 0.5) * err;
          dir.y += (Math.random() - 0.5) * err * 0.6;
          dir.z += (Math.random() - 0.5) * err;
          game.combat.shoot(c, { origin, dir });
          this.restT = best === game.flag.holder ? 0.2 : gun.auto ? 0.4 + Math.random() * 0.8 : 0.9 + Math.random() * 1.2;
        }
      }
    }

    // Drop a trap behind us when someone is chasing.
    if (this.trapT <= 0 && c.grounded) {
      this.trapT = 7 + Math.random() * 9;
      const chaser = game.characters.some(
        (o) => o !== c && o.feetY < c.feetY + 0.5 && o.feetY > c.feetY - 4 && o.pos.distanceTo(c.pos) < 12,
      );
      const kinds = TRAP_KINDS.filter((k) => c.traps[k] > 0);
      if (chaser && kinds.length) {
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        game.traps.tryPlace(c, kind, c.yaw + Math.PI);
      }
    }
  }
}
