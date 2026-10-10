import * as THREE from 'three';
import type { Character } from './character';
import type { Game } from './game';

interface Shot {
  /** Angle around the subject relative to where they face (0 = behind, π = front). */
  yaw: number;
  pitch: number;
  dist: number;
}

const SHOTS: Shot[] = [
  { yaw: 0, pitch: 0.28, dist: 6.5 },
  { yaw: 0.7, pitch: 0.32, dist: 6 },
  { yaw: -0.7, pitch: 0.32, dist: 6 },
  { yaw: Math.PI * 0.85, pitch: 0.2, dist: 5 },
  { yaw: 0.3, pitch: 0.55, dist: 9 },
];

/**
 * Films the home-page demo like a highlight reel: follows one fighter at a time,
 * prefers whoever is highest up, and cuts to big falls and wins as they happen.
 */
export class Director {
  private subject: Character | null = null;
  private shot = SHOTS[0];
  private t = 0;
  private cutAt = 0;
  private lastDrama = -99;

  constructor(private readonly game: Game) {}

  reset(): void {
    this.subject = null;
    this.cutAt = 0;
    this.t = 0;
  }

  /** Something worth seeing just happened to `c` (a long fall, a win): cut to it. */
  notice(c: Character, hold = 3.5): void {
    if (this.t - this.lastDrama < 4 && hold < 5) return;
    this.lastDrama = this.t;
    this.cut(c, hold, SHOTS[Math.random() < 0.5 ? 1 : 2]);
  }

  private cut(c: Character, hold: number, shot: Shot): void {
    const changed = c !== this.subject;
    this.subject = c;
    this.shot = shot;
    this.cutAt = this.t + hold;
    if (changed) this.game.cam.yaw = c.yaw + shot.yaw;
  }

  private pick(): void {
    const chars = this.game.characters;
    const r = Math.random();
    let c: Character;
    if (r < 0.55) {
      // The race leader, unless we just watched them.
      const sorted = [...chars].sort((a, b) => b.feetY - a.feetY);
      c = sorted[0] === this.subject && sorted.length > 1 && Math.random() < 0.5 ? sorted[1] : sorted[0];
    } else if (r < 0.75) {
      // Someone in trouble.
      c = chars.find((x) => x.stun > 0 || !x.grounded) ?? chars[Math.floor(Math.random() * chars.length)];
    } else {
      c = chars[Math.floor(Math.random() * chars.length)];
    }
    this.cut(c, 6 + Math.random() * 3, SHOTS[Math.floor(Math.random() * SHOTS.length)]);
  }

  /** Move the camera; returns the point the sun's shadow box should follow. */
  update(dt: number): THREE.Vector3 {
    this.t += dt;
    if (!this.subject || this.t > this.cutAt || !this.game.characters.includes(this.subject)) this.pick();
    const s = this.subject!;
    const cam = this.game.cam;
    const want = s.yaw + this.shot.yaw;
    let d = want - cam.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    cam.yaw += d * Math.min(1, dt * 1.2);
    cam.pitch += (this.shot.pitch - cam.pitch) * Math.min(1, dt * 2);
    cam.dist = this.shot.dist;
    this.game.fx.shake = 0;
    cam.update(dt, s.view.position, this.game, -s.vel.y);
    return s.view.position;
  }
}
