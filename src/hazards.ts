import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CONFIG } from './config';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OUTLINE, toon, type StaticBatcher } from './toon';
import type { Character } from './character';
import type { Game } from './game';

/** A construction lift platform that shuttles back and forth over a hole. */
export class MovingPlatform {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly delta = new THREE.Vector3();
  /** Live top-center (feet height) of the platform. */
  readonly top = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    readonly base: THREE.Vector3,
    readonly axis: THREE.Vector3,
    readonly amp: number,
    readonly period: number,
    readonly phase: number,
    readonly half: THREE.Vector3,
  ) {
    this.posAt(0, this.pos);
    this.prevPos.copy(this.pos);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, this.pos.y, this.pos.z));
    this.collider = world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), this.body);

    const deckGeo = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
    const deck = new THREE.Mesh(deckGeo, toon(0xf2b632));
    deck.castShadow = true;
    deck.receiveShadow = true;
    const stripeGeo = new THREE.BoxGeometry(half.x * 2 + 0.02, 0.08, half.z * 2 + 0.02);
    const stripe = new THREE.Mesh(stripeGeo, toon(0x2c2633));
    stripe.position.y = -half.y + 0.06;
    const railMat = toon(0xe8e8e8);
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, half.z * 2), railMat);
      rail.position.set(sx * (half.x - 0.05), half.y + 0.9, 0);
      this.mesh.add(rail);
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.06), railMat);
        post.position.set(sx * (half.x - 0.05), half.y + 0.45, sz * (half.z - 0.05));
        this.mesh.add(post);
      }
    }
    this.mesh.add(deck, stripe, new THREE.LineSegments(new THREE.EdgesGeometry(deckGeo), OUTLINE));
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
    this.top.set(this.pos.x, this.pos.y + half.y, this.pos.z);
  }

  posAt(time: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.base).addScaledVector(this.axis, this.amp * Math.sin((2 * Math.PI * time) / this.period + this.phase));
  }

  update(time: number): void {
    this.prevPos.copy(this.pos);
    this.posAt(time, this.tmp);
    this.delta.subVectors(this.tmp, this.pos);
    this.pos.copy(this.tmp);
    this.body.setNextKinematicTranslation(this.pos);
    this.top.set(this.pos.x, this.pos.y + this.half.y, this.pos.z);
  }

  syncView(alpha: number): void {
    this.mesh.position.lerpVectors(this.prevPos, this.pos, alpha);
  }
}

/** A spinning bar (industrial fan arm) that bats anyone it touches. Analytic hit test. */
export class Sweeper {
  angle = 0;
  readonly group = new THREE.Group();
  private readonly hitUntil = new Map<Character, number>();

  constructor(scene: THREE.Scene, readonly pivot: THREE.Vector3, readonly speed: number, readonly halfLen: number, color = 0xff5a7a) {
    this.group.position.copy(pivot);
    const barGeo = new THREE.BoxGeometry(halfLen * 2, 0.26, 0.3);
    const bar = new THREE.Mesh(barGeo, toon(color));
    bar.castShadow = true;
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.34), toon(0xfff0f3));
      cap.position.x = s * (halfLen - 0.2);
      this.group.add(cap);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.42, 16), toon(0x4b4a63));
    this.group.add(bar, hub, new THREE.LineSegments(new THREE.EdgesGeometry(barGeo), OUTLINE));
    scene.add(this.group);
  }

  private readonly phase0 = this.angle;

  update(_dt: number, game: Game): void {
    this.angle = this.phase0 + this.speed * game.time;
    this.group.rotation.y = -this.angle;
    const ca = Math.cos(this.angle);
    const sa = Math.sin(this.angle);
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      if (Math.abs(c.pos.y - this.pivot.y) > 1.04) continue;
      const rx = c.pos.x - this.pivot.x;
      const rz = c.pos.z - this.pivot.z;
      const u = THREE.MathUtils.clamp(rx * ca + rz * sa, -this.halfLen, this.halfLen);
      const dist = Math.hypot(rx - u * ca, rz - u * sa);
      if (dist > CONFIG.CAPSULE_RADIUS + 0.2) continue;
      const sgn = Math.sign(u * this.speed) || 1;
      c.knock(new THREE.Vector3(-sa * sgn, 0, ca * sgn), 11, 5, 0.7, null);
      this.hitUntil.set(c, game.time + 0.8);
      game.onObstacleHit(c);
    }
  }
}

const _v = new THREE.Vector3();

/** Hazard-striped canvas used on pusher faces. */
const STRIPES = (() => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffd23f';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2c2633';
  for (let x = -64; x < 128; x += 32) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 16, 64);
    g.lineTo(x + 80, 0);
    g.lineTo(x + 64, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

const CRACKS = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#6b5a45';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(10, 8);
  g.lineTo(26, 30);
  g.lineTo(20, 52);
  g.moveTo(26, 30);
  g.lineTo(50, 36);
  g.lineTo(58, 56);
  g.moveTo(50, 36);
  g.lineTo(54, 12);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

/**
 * Piston block that rests, then slams out along `dir` (an axis direction) and
 * shoves anyone in front. Kinematic, so it also physically blocks while out.
 */
export class Pusher {
  readonly body: RAPIER.RigidBody;
  readonly mesh = new THREE.Group();
  private readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private ext = 0;
  /** About to fire: shake as a tell. */
  private warn = false;
  private readonly hitUntil = new Map<Character, number>();

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    readonly base: THREE.Vector3,
    readonly dir: THREE.Vector3,
    readonly reach: number,
    readonly half: THREE.Vector3,
    readonly period: number,
    readonly phase: number,
  ) {
    this.pos.copy(base);
    this.prevPos.copy(base);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(base.x, base.y, base.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), this.body);
    const geo = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
    const block = new THREE.Mesh(geo, toon(0xe8455a));
    block.castShadow = true;
    const alongX = Math.abs(dir.x) > 0.5;
    const depth = alongX ? half.x : half.z;
    const face = new THREE.Mesh(new THREE.PlaneGeometry((alongX ? half.z : half.x) * 2 - 0.1, half.y * 2 - 0.1), toon(0xffffff, { map: STRIPES }));
    face.position.copy(dir).multiplyScalar(depth + 0.01);
    face.lookAt(_v.copy(dir).multiplyScalar(10));
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, reach + 0.6, 10), toon(0xc9ced6));
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    rod.position.copy(dir).multiplyScalar(-(reach + 0.6) / 2 - depth);
    this.mesh.add(block, face, rod, new THREE.LineSegments(new THREE.EdgesGeometry(geo), OUTLINE));
    this.mesh.position.copy(base);
    scene.add(this.mesh);
  }

  update(time: number, game: Game): void {
    const u = (((time / this.period + this.phase) % 1) + 1) % 1;
    let e: number;
    if (u < 0.5) e = 0;
    else if (u < 0.58) e = (u - 0.5) / 0.08;
    else if (u < 0.78) e = 1;
    else e = 1 - (u - 0.78) / 0.22;
    const extending = e > this.ext;
    if (extending && this.ext === 0 && this.pos.distanceTo(game.player.pos) < 14) game.sfx.clank();
    this.ext = e;
    this.warn = u > 0.36 && u < 0.5;
    this.prevPos.copy(this.pos);
    this.pos.copy(this.base).addScaledVector(this.dir, this.reach * e);
    this.body.setNextKinematicTranslation(this.pos);
    if (!extending) return;
    const h = this.half;
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      const dx = Math.abs(c.pos.x - this.pos.x) - h.x;
      const dz = Math.abs(c.pos.z - this.pos.z) - h.z;
      if (dx > 0.5 || dz > 0.5 || Math.abs(c.pos.y - this.pos.y) > h.y + 0.9) continue;
      c.knock(this.dir, 14, 5, 0.9, null);
      this.hitUntil.set(c, game.time + 0.8);
      game.onObstacleHit(c);
    }
  }

  syncView(alpha: number): void {
    this.mesh.position.lerpVectors(this.prevPos, this.pos, alpha);
    if (this.warn) {
      this.mesh.position.x += (Math.random() - 0.5) * 0.06;
      this.mesh.position.z += (Math.random() - 0.5) * 0.06;
    }
  }
}

/** Wrecking ball swinging from the ceiling. Analytic hit test against the capsule. */
export class Pendulum {
  readonly ball: THREE.Mesh;
  readonly rope: THREE.Mesh;
  /** Current ball centre (updated each sim step). */
  readonly center = new THREE.Vector3();
  /** Signed horizontal speed along `axis` (updated each sim step). */
  swing = 0;
  private readonly hitUntil = new Map<Character, number>();
  private readonly radius = 0.65;

  constructor(
    scene: THREE.Scene,
    readonly pivot: THREE.Vector3,
    readonly axis: THREE.Vector3,
    readonly length: number,
    readonly amp: number,
    readonly omega: number,
    readonly phase: number,
    style: 'ball' | 'chandelier' | 'axe' = 'ball',
  ) {
    if (style === 'chandelier') {
      // Haunted-hotel chandelier: a brass ring of candles.
      this.ball = new THREE.Mesh(new THREE.CylinderGeometry(this.radius * 0.5, this.radius * 0.9, 0.35, 12), toon(0xc9a24a, { emissive: 0x3a2a08 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(this.radius * 1.05, 0.06, 6, 20), toon(0xc9a24a));
      ring.rotation.x = Math.PI / 2;
      this.ball.add(ring);
      const flame = toon(0xffe08a, { emissive: 0xffb340 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6), toon(0xf4f1ea));
        candle.position.set(Math.cos(a) * this.radius * 1.05, 0.15, Math.sin(a) * this.radius * 1.05);
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), flame);
        f.position.y = 0.15;
        candle.add(f);
        this.ball.add(candle);
      }
    } else if (style === 'axe') {
      // Olympus: a bronze double axe.
      this.ball = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.16), toon(0x7a5a2a));
      const bronze = toon(0xd9a441, { emissive: 0x3a2a08 });
      for (const sx of [-1, 1]) {
        const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 16, 1, false, sx > 0 ? 0 : Math.PI, Math.PI), bronze);
        blade.rotation.z = Math.PI / 2;
        blade.position.set(sx * 0.08, -0.15, 0);
        this.ball.add(blade);
      }
    } else {
      this.ball = new THREE.Mesh(new THREE.IcosahedronGeometry(this.radius, 2), toon(0x4b4a63));
      const band = new THREE.Mesh(new THREE.TorusGeometry(this.radius * 0.98, 0.07, 8, 24), toon(0xffd23f));
      band.rotation.x = Math.PI / 2;
      this.ball.add(band);
    }
    this.ball.castShadow = true;
    this.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 6), toon(style === 'chandelier' ? 0xc9a24a : 0x2c2633));
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.5), toon(0x8a8fa0));
    mount.position.copy(pivot);
    scene.add(this.ball, this.rope, mount);
    this.place(0);
  }

  private place(time: number): number {
    const th = this.amp * Math.sin(this.omega * time + this.phase);
    this.center.copy(this.pivot).addScaledVector(this.axis, this.length * Math.sin(th));
    this.center.y -= this.length * Math.cos(th);
    return th;
  }

  update(time: number, game: Game): void {
    const th = this.place(time);
    const swingVel = this.amp * this.omega * Math.cos(this.omega * time + this.phase) * Math.cos(th);
    this.swing = swingVel * this.length;
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      const cy = THREE.MathUtils.clamp(this.center.y, c.pos.y - 0.5, c.pos.y + 0.5);
      const d = Math.hypot(c.pos.x - this.center.x, cy - this.center.y, c.pos.z - this.center.z);
      if (d > this.radius + CONFIG.CAPSULE_RADIUS) continue;
      const dir = this.axis.clone().multiplyScalar(Math.sign(swingVel) || 1);
      c.knock(dir, 12 + Math.abs(swingVel) * this.length * 0.6, 6, 1.0, null);
      this.hitUntil.set(c, game.time + 1);
      game.onObstacleHit(c);
    }
  }

  syncView(time: number): void {
    this.place(time);
    this.ball.position.copy(this.center);
    this.ball.rotation.z = Math.sin(time * 2) * 0.3;
    this.rope.position.copy(this.pivot).add(this.center).multiplyScalar(0.5);
    this.rope.scale.y = Math.max(0.1, this.pivot.distanceTo(this.center) - this.radius);
    this.rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(this.pivot).sub(this.center).normalize());
  }
}

/** Moving floor strip: anyone standing on it gets carried along `vel`. */
export class Conveyor {
  private readonly tex: THREE.CanvasTexture;
  private readonly alongX: boolean;

  constructor(
    scene: THREE.Scene,
    readonly x0: number,
    readonly x1: number,
    readonly z0: number,
    readonly z1: number,
    readonly y: number,
    readonly vel: THREE.Vector3,
  ) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3a3f52';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#6fd6ff';
    g.beginPath();
    g.moveTo(16, 50);
    g.lineTo(32, 22);
    g.lineTo(48, 50);
    g.lineTo(40, 50);
    g.lineTo(32, 36);
    g.lineTo(24, 50);
    g.fill();
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.alongX = Math.abs(vel.x) > Math.abs(vel.z);
    const w = Math.abs(x1 - x0);
    const d = Math.abs(z1 - z0);
    // A plane whose texture "up" (+v) points along the belt's motion.
    const len = this.alongX ? w : d;
    const wid = this.alongX ? d : w;
    const geo = new THREE.PlaneGeometry(wid, len);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * wid) / 1.2, (uv.getY(i) * len) / 1.2);
    geo.rotateX(-Math.PI / 2); // plane +v now points to -z
    // Each belt scrolls its own texture, so its material is its own too (not the shared cache).
    const mesh = new THREE.Mesh(geo, toon(0xffffff, { map: this.tex, fresh: true }));
    const motion = Math.atan2(vel.x, vel.z); // yaw that maps -z to the motion direction
    mesh.rotation.y = motion + Math.PI;
    mesh.position.set((x0 + x1) / 2, y + 0.015, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  apply(c: Character): void {
    if (!c.grounded || Math.abs(c.feetY - this.y) > 0.3) return;
    const x = c.pos.x;
    const z = c.pos.z;
    if (x < Math.min(this.x0, this.x1) || x > Math.max(this.x0, this.x1) || z < Math.min(this.z0, this.z1) || z > Math.max(this.z0, this.z1)) return;
    c.conveyor.add(this.vel);
  }

  scroll(dt: number): void {
    this.tex.offset.y -= (dt * this.vel.length()) / 1.2;
  }
}

/** Floor tile that cracks, shakes and drops out from under you, then grows back. */
export class CrumbleTile {
  readonly collider: RAPIER.Collider;
  private readonly mesh: THREE.Mesh;
  state: 'solid' | 'shaking' | 'fallen' = 'solid';
  private timer = 0;
  private drop = 0;
  private readonly home: THREE.Vector3;

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    readonly cx: number,
    readonly cz: number,
    readonly top: number,
    readonly hx: number,
    readonly hz: number,
  ) {
    this.home = new THREE.Vector3(cx, top - 0.2, cz);
    this.collider = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 0.2, hz).setTranslation(cx, top - 0.2, cz));
    const geo = new THREE.BoxGeometry(hx * 2 - 0.06, 0.4, hz * 2 - 0.06);
    this.mesh = new THREE.Mesh(geo, toon(0xd9c7a8, { map: CRACKS }));
    this.mesh.position.copy(this.home);
    this.mesh.receiveShadow = true;
    this.mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), OUTLINE));
    scene.add(this.mesh);
  }

  /** Is (x, z) over this tile at roughly floor height y? */
  covers(x: number, y: number, z: number): boolean {
    return Math.abs(x - this.cx) < this.hx && Math.abs(z - this.cz) < this.hz && Math.abs(y - this.top) < 1;
  }

  update(dt: number, game: Game): void {
    if (this.state === 'solid') {
      const standing = game.characters.some(
        (c) => c.grounded && Math.abs(c.pos.x - this.cx) < this.hx && Math.abs(c.pos.z - this.cz) < this.hz && Math.abs(c.feetY - this.top) < 0.25,
      );
      if (standing) {
        this.state = 'shaking';
        this.timer = 0.7;
      }
    } else if (this.state === 'shaking') {
      this.timer -= dt;
      this.mesh.position.set(this.home.x + (Math.random() - 0.5) * 0.08, this.home.y, this.home.z + (Math.random() - 0.5) * 0.08);
      if (this.timer <= 0) {
        this.state = 'fallen';
        this.timer = 5;
        this.drop = 0;
        this.collider.setEnabled(false);
      }
    } else {
      this.timer -= dt;
      this.drop += dt;
      this.mesh.position.set(this.home.x, this.home.y - 4.9 * this.drop * this.drop, this.home.z);
      this.mesh.visible = this.drop < 0.9;
      const occupied = game.characters.some(
        (c) => Math.abs(c.pos.x - this.cx) < this.hx + 0.3 && Math.abs(c.pos.z - this.cz) < this.hz + 0.3 && Math.abs(c.feetY - this.top) < 1.9,
      );
      if (this.timer <= 0 && !occupied) {
        this.state = 'solid';
        this.collider.setEnabled(true);
        this.mesh.position.copy(this.home);
        this.mesh.visible = true;
      }
    }
  }
}

const frac = (x: number) => ((x % 1) + 1) % 1;
/** Deterministic 0..1 hash so every client builds identical patterns. */
export const hash01 = (a: number, b: number) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);

/**
 * Sisyphus' revenge: a boulder rolls out of a hatch in the outer wall, crosses the
 * room and drops through a grate on the far side. Time-based, so every client agrees.
 */
export class BoulderLane {
  readonly ball: THREE.Mesh;
  readonly pos = new THREE.Vector3();
  readonly dir: THREE.Vector3;
  readonly length: number;
  /** Rolling (dangerous) this step. */
  active = false;
  private readonly travel: number;
  private readonly axis: THREE.Vector3;
  private readonly hitUntil = new Map<Character, number>();

  constructor(
    scene: THREE.Scene,
    readonly from: THREE.Vector3,
    readonly to: THREE.Vector3,
    readonly radius: number,
    readonly period: number,
    readonly phase: number,
    readonly speed: number,
    style: 'rock' | 'pipe' | 'trunk' = 'rock',
  ) {
    this.dir = to.clone().sub(from).setY(0).normalize();
    this.length = from.distanceTo(to);
    this.travel = this.length / speed;
    this.axis = new THREE.Vector3(0, 1, 0).cross(this.dir).normalize();
    let geo: THREE.BufferGeometry;
    let color = 0x9aa0ad;
    if (style === 'pipe') {
      // A big concrete pipe rolling on its side (its axis stays across the roll).
      geo = new THREE.CylinderGeometry(radius, radius, radius * 2.4, 16, 1, true).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.axis));
      color = 0xb8b2a6;
    } else if (style === 'trunk') {
      geo = new THREE.BoxGeometry(radius * 1.7, radius * 1.4, radius * 1.4);
      color = 0x8a4a2a;
    } else {
      geo = new THREE.IcosahedronGeometry(radius, 1);
    }
    this.ball = new THREE.Mesh(geo, toon(color, { double: style === 'pipe' }));
    this.ball.castShadow = true;
    this.ball.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), OUTLINE));
    this.ball.visible = false;
    scene.add(this.ball);
  }

  /** Where the boulder is at time t: rolling, sinking into the grate, or waiting in the hatch. */
  at(t: number, out: THREE.Vector3): 'roll' | 'sink' | null {
    const tt = frac(t / this.period + this.phase) * this.period;
    if (tt < this.travel) {
      out.copy(this.from).addScaledVector(this.dir, this.speed * tt);
      out.y += this.radius;
      return 'roll';
    }
    const s = tt - this.travel;
    if (s < 0.7) {
      out.copy(this.to).addScaledVector(this.dir, this.speed * s * 0.3);
      out.y += this.radius - 14.7 * s * s;
      return 'sink';
    }
    return null;
  }

  /** Is the boulder at distance `d` down its lane now, or will it be within `lead` seconds? */
  threatens(t: number, d: number, lead: number): boolean {
    const arrive = d / this.speed;
    if (arrive > this.travel) return false;
    const tt = frac(t / this.period + this.phase) * this.period;
    const clear = (this.radius + 1) / this.speed;
    for (const cycle of [0, this.period]) {
      const dt = arrive + cycle - tt;
      if (dt > -clear && dt < lead) return true;
    }
    return false;
  }

  update(time: number, game: Game): void {
    this.active = this.at(time, this.pos) === 'roll';
    if (!this.active) return;
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      if (Math.abs(c.pos.y - this.pos.y) > this.radius + 0.6) continue;
      if (Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) > this.radius + CONFIG.CAPSULE_RADIUS + 0.05) continue;
      c.knock(this.dir, 15, 6, 1.1, null);
      this.hitUntil.set(c, game.time + 1);
      game.onObstacleHit(c);
    }
  }

  syncView(time: number): void {
    const st = this.at(time, _v);
    this.ball.visible = st !== null;
    if (!st) return;
    this.ball.position.copy(_v);
    const rolled = Math.min(this.length, Math.hypot(_v.x - this.from.x, _v.z - this.from.z));
    this.ball.quaternion.setFromAxisAngle(this.axis, rolled / this.radius);
  }
}

/** Laser curtain across a room: blinks on and off on a fixed rhythm and bounces you back. */
export class LaserGate {
  on = false;
  readonly normal: THREE.Vector3;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly hitUntil = new Map<Character, number>();

  constructor(
    scene: THREE.Scene,
    readonly a: THREE.Vector3,
    readonly b: THREE.Vector3,
    readonly period: number,
    readonly phase: number,
    readonly onFrac: number,
    batch: StaticBatcher,
    color = 0xff2a4a,
  ) {
    const along = b.clone().sub(a).setY(0);
    const len = along.length();
    along.normalize();
    this.normal = new THREE.Vector3(-along.z, 0, along.x);
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const beams = mergeGeometries([0.25, 0.65, 1.05, 1.45, 1.85].map((h) => new THREE.BoxGeometry(0.05, 0.05, len).translate(0, h, 0)));
    const g = new THREE.Mesh(beams, this.mat);
    g.position.copy(a).add(b).multiplyScalar(0.5);
    g.rotation.y = Math.atan2(along.x, along.z);
    scene.add(g);
    const postMat = toon(0x3a3f52);
    const lampMat = toon(color, { emissive: new THREE.Color(color).multiplyScalar(0.5).getHex() });
    const q = new THREE.Quaternion();
    for (const p of [a, b]) {
      batch.box(new THREE.Vector3(p.x, p.y + 1.1, p.z), new THREE.Vector3(0.17, 1.1, 0.17), q, postMat);
      batch.box(new THREE.Vector3(p.x, p.y + 2.26, p.z), new THREE.Vector3(0.18, 0.06, 0.18), q, lampMat, { cast: false });
    }
  }

  isOn(t: number): boolean {
    return frac(t / this.period + this.phase) < this.onFrac;
  }

  /** On now, or switching on within `lead` seconds. */
  soonOn(t: number, lead: number): boolean {
    const f = frac(t / this.period + this.phase);
    return f < this.onFrac || f > 1 - lead / this.period;
  }

  /** Horizontal distance from a point to the curtain. */
  distTo(x: number, z: number): number {
    const ax = this.b.x - this.a.x;
    const az = this.b.z - this.a.z;
    const t = THREE.MathUtils.clamp(((x - this.a.x) * ax + (z - this.a.z) * az) / (ax * ax + az * az), 0, 1);
    return Math.hypot(x - (this.a.x + ax * t), z - (this.a.z + az * t));
  }

  update(time: number, game: Game): void {
    this.on = this.isOn(time);
    if (!this.on) return;
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      if (c.feetY < this.a.y - 0.5 || c.feetY > this.a.y + 2.0) continue;
      if (this.distTo(c.pos.x, c.pos.z) > CONFIG.CAPSULE_RADIUS + 0.1) continue;
      const side = Math.sign((c.pos.x - this.a.x) * this.normal.x + (c.pos.z - this.a.z) * this.normal.z) || 1;
      c.knock(this.normal.clone().multiplyScalar(side), 10, 4, 0.8, null);
      this.hitUntil.set(c, game.time + 0.8);
      game.onObstacleHit(c);
    }
  }

  syncView(time: number): void {
    const f = frac(time / this.period + this.phase);
    if (f < this.onFrac) this.mat.opacity = 0.9;
    else if (f > 1 - 0.6 / this.period) this.mat.opacity = Math.sin(time * 40) > 0 ? 0.55 : 0.15;
    else this.mat.opacity = 0.08;
  }
}

const TURNTABLE_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? '#ffd23f' : '#3a3f52';
    g.beginPath();
    g.moveTo(64, 64);
    g.arc(64, 64, 64, (i / 12) * Math.PI * 2, ((i + 1) / 12) * Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#f4f1ea';
  g.beginPath();
  g.arc(64, 64, 10, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

/** Spinning floor disc: whoever stands on it gets carried round. */
export class Turntable {
  private readonly disc: THREE.Mesh;

  constructor(
    scene: THREE.Scene,
    readonly center: THREE.Vector3,
    readonly radius: number,
    readonly omega: number,
  ) {
    const geo = new THREE.CylinderGeometry(radius, radius, 0.06, 48);
    const top = toon(0xffffff, { map: TURNTABLE_TEX });
    this.disc = new THREE.Mesh(geo, [toon(0x3a3f52), top, top]);
    this.disc.position.set(center.x, center.y + 0.03, center.z);
    this.disc.receiveShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.06, 6, 48).rotateX(Math.PI / 2), toon(0x2c2633));
    rim.position.set(center.x, center.y + 0.05, center.z);
    scene.add(this.disc, rim);
  }

  apply(c: Character): void {
    if (!c.grounded || Math.abs(c.feetY - this.center.y) > 0.3) return;
    const rx = c.pos.x - this.center.x;
    const rz = c.pos.z - this.center.z;
    if (rx * rx + rz * rz > this.radius * this.radius) return;
    c.conveyor.x += this.omega * rz;
    c.conveyor.z -= this.omega * rx;
  }

  syncView(time: number): void {
    this.disc.rotation.y = this.omega * time;
  }
}

/** Grid of floor panels that flip open in waves, dropping whoever stands there a floor. */
export class FlipFloor {
  readonly hx: number;
  readonly hz: number;
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly phases: number[] = [];
  private readonly isOpen: boolean[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    readonly x0: number,
    readonly z0: number,
    readonly nx: number,
    readonly nz: number,
    readonly sx: number,
    readonly sz: number,
    readonly top: number,
    readonly period: number,
    readonly openFrac: number,
    wave: { x: number; z: number },
  ) {
    this.hx = sx / 2;
    this.hz = sz / 2;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(sx - 0.1, 0.3, sz - 0.1), toon(0xffffff), nx * nz);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const ca = new THREE.Color(0xf2b632);
    const cb = new THREE.Color(0xd9dde3);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        const k = i * nz + j;
        const cx = x0 + (i + 0.5) * sx;
        const cz = z0 + (j + 0.5) * sz;
        this.colliders.push(world.createCollider(RAPIER.ColliderDesc.cuboid(this.hx, 0.15, this.hz).setTranslation(cx, top - 0.15, cz)));
        // A wave sweeps across the grid, with a little per-panel jitter.
        this.phases.push(frac((cx * wave.x + cz * wave.z) * 0.045 + hash01(i, j) * 0.12));
        this.isOpen.push(false);
        this.mesh.setColorAt(k, (i + j) % 2 ? ca : cb);
      }
    scene.add(this.mesh);
    this.syncView(0);
  }

  private f(k: number, t: number): number {
    return frac(t / this.period + this.phases[k]);
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.sx);
    const j = Math.floor((z - this.z0) / this.sz);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return i * this.nz + j;
  }

  update(time: number): void {
    for (let k = 0; k < this.colliders.length; k++) {
      const open = this.f(k, time) < this.openFrac;
      if (open !== this.isOpen[k]) {
        this.isOpen[k] = open;
        this.colliders[k].setEnabled(!open);
      }
    }
  }

  /** Is the panel under (x, z) open now or opening within `lead` seconds? */
  blocked(x: number, feetY: number, z: number, time: number, lead: number): boolean {
    if (Math.abs(feetY - this.top) > 1) return false;
    const k = this.index(x, z);
    if (k < 0) return false;
    const f = this.f(k, time);
    return f < this.openFrac + 0.03 || f > 1 - lead / this.period;
  }

  syncView(time: number): void {
    for (let i = 0; i < this.nx; i++)
      for (let j = 0; j < this.nz; j++) {
        const k = i * this.nz + j;
        const f = this.f(k, time);
        const cx = this.x0 + (i + 0.5) * this.sx;
        const cz = this.z0 + (j + 0.5) * this.sz;
        let angle = 0;
        let jitter = 0;
        if (f < this.openFrac) angle = Math.min(1, f / 0.05, (this.openFrac - f) / 0.06) * 1.45;
        else if (f > 1 - 0.7 / this.period) jitter = Math.sin(time * 50 + k) * 0.035;
        // Hinged on the panel's -x edge.
        this.q.setFromAxisAngle(_zAxis, -angle);
        _v.set(this.hx * (1 - Math.cos(angle)) + cx + jitter, -this.hx * Math.sin(angle) + this.top - 0.15, cz);
        this.m4.compose(_v, this.q, _one);
        this.mesh.setMatrixAt(k, this.m4);
      }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _zAxis = new THREE.Vector3(0, 0, 1);
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Haunted-hotel ghost: drifts back and forth along a corridor, bobbing, and shoves anyone
 * it passes through. Time-based, so every client sees it in the same place.
 */
export class Ghost {
  readonly pos = new THREE.Vector3();
  private readonly group = new THREE.Group();
  private readonly mat: THREE.MeshToonMaterial;
  private readonly hitUntil = new Map<Character, number>();
  private readonly dir = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    readonly a: THREE.Vector3,
    readonly b: THREE.Vector3,
    readonly period: number,
    readonly phase: number,
  ) {
    this.mat = new THREE.MeshToonMaterial({ color: 0xe8f4ff, emissive: 0x6fa8ff, emissiveIntensity: 0.6, transparent: true, opacity: 0.75, depthWrite: false });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 4, 10), this.mat);
    body.position.y = 1.15;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.6, 10), this.mat);
    tail.rotation.x = Math.PI;
    tail.position.y = 0.45;
    const eyeMat = toon(0x1c1a3a);
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), eyeMat);
    mouth.scale.set(1, 1.4, 0.5);
    mouth.position.set(0, 1.12, 0.4);
    this.group.add(body, tail, mouth);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), eyeMat);
      eye.position.set(sx * 0.15, 1.38, 0.38);
      this.group.add(eye);
    }
    scene.add(this.group);
    this.place(0);
  }

  private place(t: number): void {
    // Smooth back-and-forth along the corridor.
    const f = 0.5 - 0.5 * Math.cos(((t / this.period + this.phase) % 1) * Math.PI * 2);
    this.pos.lerpVectors(this.a, this.b, f);
    const forward = Math.sin(((t / this.period + this.phase) % 1) * Math.PI * 2) >= 0;
    this.dir.subVectors(this.b, this.a).setY(0).normalize();
    if (!forward) this.dir.negate();
  }

  update(time: number, game: Game): void {
    this.place(time);
    for (const c of game.characters) {
      if (c.remote || (this.hitUntil.get(c) ?? 0) > game.time) continue;
      if (Math.abs(c.feetY - this.pos.y) > 1.6) continue;
      if (Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) > 0.95) continue;
      // Shoved along the way it's drifting, a little off to the side.
      const side = new THREE.Vector3(-this.dir.z, 0, this.dir.x).multiplyScalar(Math.sign((c.pos.x - this.pos.x) * -this.dir.z + (c.pos.z - this.pos.z) * this.dir.x) || 1);
      c.knock(this.dir.clone().add(side.multiplyScalar(0.6)).normalize(), 11, 4, 0.8, null);
      this.hitUntil.set(c, game.time + 1.2);
      game.onObstacleHit(c);
    }
  }

  syncView(time: number): void {
    this.place(time);
    this.group.position.set(this.pos.x, this.pos.y + Math.sin(time * 2.4 + this.phase * 9) * 0.18, this.pos.z);
    this.group.rotation.y = Math.atan2(this.dir.x, this.dir.z);
    this.mat.opacity = 0.55 + 0.25 * Math.sin(time * 3.1 + this.phase * 5);
  }
}

/**
 * Construction-site wind: gusts that blow across an open floor toward the edge. Pushes like
 * a conveyor while it's blowing (stronger in the air), with streaks to warn you.
 */
export class WindZone {
  private readonly streaks: THREE.Mesh[] = [];
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly x0: number;
  private readonly x1: number;
  private readonly z0: number;
  private readonly z1: number;

  constructor(
    scene: THREE.Scene,
    rect: [number, number, number, number],
    readonly y: number,
    readonly vel: THREE.Vector3,
    readonly period: number,
    readonly phase: number,
    readonly onFrac = 0.45,
  ) {
    this.x0 = Math.min(rect[0], rect[1]);
    this.x1 = Math.max(rect[0], rect[1]);
    this.z0 = Math.min(rect[2], rect[3]);
    this.z1 = Math.max(rect[2], rect[3]);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const geo = new THREE.BoxGeometry(0.04, 0.04, 2.4);
    const yaw = Math.atan2(vel.x, vel.z);
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.rotation.y = yaw;
      m.userData.seed = hash01(i, rect[0] + rect[2]);
      m.userData.h = 0.4 + hash01(rect[1], i) * 2.4;
      this.streaks.push(m);
      scene.add(m);
    }
  }

  /** 0 when calm, ramping to 1 in a gust. */
  gust(t: number): number {
    const f = frac(t / this.period + this.phase);
    if (f > this.onFrac) return 0;
    return Math.min(1, f / 0.08, (this.onFrac - f) / 0.08);
  }

  apply(c: Character, time: number): void {
    const g = this.gust(time);
    if (g <= 0 || c.pos.x < this.x0 || c.pos.x > this.x1 || c.pos.z < this.z0 || c.pos.z > this.z1) return;
    if (c.feetY < this.y - 0.5 || c.feetY > this.y + 3) return;
    c.conveyor.addScaledVector(this.vel, g * (c.grounded ? 1 : 1.6));
  }

  syncView(time: number, _dt: number): void {
    const g = this.gust(time);
    const f = frac(time / this.period + this.phase);
    // A flicker of streaks just before a gust, full streaks during it.
    this.mat.opacity = g > 0 ? 0.45 * g : f > 1 - 0.6 / this.period ? 0.12 : 0;
    const dir = this.vel.clone().normalize();
    const span = dir.x !== 0 ? this.x1 - this.x0 : this.z1 - this.z0;
    for (const m of this.streaks) {
      const s = m.userData.seed as number;
      const travel = frac(time * 0.9 + s) * span;
      const across = s * (dir.x !== 0 ? this.z1 - this.z0 : this.x1 - this.x0);
      const startX = dir.x > 0 ? this.x0 : this.x1;
      const startZ = dir.z > 0 ? this.z0 : this.z1;
      if (dir.x !== 0) m.position.set(startX + Math.sign(dir.x) * travel, this.y + (m.userData.h as number), this.z0 + across);
      else m.position.set(this.x0 + across, this.y + (m.userData.h as number), startZ + Math.sign(dir.z) * travel);
      m.visible = this.mat.opacity > 0;
    }
  }
}
