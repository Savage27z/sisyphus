import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CONFIG } from './config';
import { BoulderLane, Conveyor, CrumbleTile, FlipFloor, Ghost, LaserGate, MovingPlatform, Pendulum, Pusher, Sweeper, Turntable, WindZone } from './hazards';
import { StaticBatcher, canvasTexture, isSharedMaterial, toon } from './toon';
import type { Character } from './character';
import type { Game } from './game';

export type MapId = 'tower' | 'construction' | 'hotel' | 'olympus';

export interface Waypoint {
  /** Feet position to reach. For moving platforms this vector is live. */
  pos: THREE.Vector3;
  jump?: boolean;
  radius?: number;
  platform?: MovingPlatform;
  /** If set, bots wait until this returns true before going for it. */
  ready?: (c: Character) => boolean;
}

/** A stretch of the climb: usually one way through, often a choice of routes. */
export interface RouteSeg {
  floor: number;
  alts: Waypoint[][];
  /** Relative odds a bot picks each alternative. */
  weights: number[];
}

/** Sky, fog and light colours for a map. */
export interface Ambience {
  skyTop: number;
  skyMid: number;
  skyBottom: number;
  fog: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sun: number;
  sunIntensity: number;
  /** Show the city skyline around the map. */
  city: boolean;
  /** An ocean instead of streets (Olympus). */
  sea: boolean;
}

export type Rect = [x0: number, x1: number, z0: number, z1: number];

export const FH = CONFIG.FLOOR_HEIGHT;
export const SLAB = 0.4;
export const LEVELS = 12;
export const inRect = (r: Rect, x: number, z: number) => x > Math.min(r[0], r[1]) && x < Math.max(r[0], r[1]) && z > Math.min(r[2], r[3]) && z < Math.max(r[2], r[3]);

/**
 * What every map provides, and the helpers maps are built with. The contract that keeps the
 * HUD, bots and server working on any map: 12 levels of 6 m with the flag at (0, 72, 0),
 * 24 spawn points, 48 supply-drop spots (4 per level) and 24 weapon racks (2 per level,
 * in level order; the first two hold the power weapons).
 */
export abstract class Arena {
  abstract readonly id: MapId;
  abstract readonly name: string;
  /** Display name per level, summit last. */
  abstract readonly floorNames: string[];
  abstract readonly ambience: Ambience;
  readonly route: RouteSeg[] = [];
  readonly platforms: MovingPlatform[] = [];
  readonly sweepers: Sweeper[] = [];
  readonly pushers: Pusher[] = [];
  readonly pendulums: Pendulum[] = [];
  readonly conveyors: Conveyor[] = [];
  readonly crumbles: CrumbleTile[] = [];
  readonly boulders: BoulderLane[] = [];
  readonly lasers: LaserGate[] = [];
  readonly turntables: Turntable[] = [];
  readonly flipFloors: FlipFloor[] = [];
  readonly ghosts: Ghost[] = [];
  readonly winds: WindZone[] = [];
  readonly platformByCollider = new Map<number, MovingPlatform>();
  /** Thin walkable slabs (trapdoors may only go on these). */
  readonly slabHandles = new Set<number>();
  /** Safety nets (bouncy). */
  readonly netHandles = new Set<number>();
  /** Safety nets: surface height, footprint and the edge points you can jump out to. */
  readonly nets: { y: number; rect: Rect; exits: THREE.Vector3[] }[] = [];
  readonly crateSpots: THREE.Vector3[] = [];
  readonly rackSpots: THREE.Vector3[] = [];
  readonly flagPos = new THREE.Vector3(0, LEVELS * FH, 0);
  readonly spawnPoints: THREE.Vector3[] = [];
  spawnYaw = Math.PI / 2;

  protected readonly batch = new StaticBatcher();
  protected readonly world: RAPIER.World;
  protected readonly scene: THREE.Scene;
  /** Moving parts per level, so levels far from the camera can skip drawing them. */
  protected readonly levelObjects: THREE.Object3D[][] = [];
  private shownLevel = -99;
  /** Everything this map put in the world, for swapping maps. */
  private ownedObjects: THREE.Object3D[] = [];
  private ownedColliders: number[] = [];
  private ownedBodies: number[] = [];
  private before: { objects: Set<THREE.Object3D>; colliders: Set<number>; bodies: Set<number> } | null = null;

  constructor(protected readonly game: Game) {
    this.world = game.world;
    this.scene = game.scene;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Call before building: remember what's already in the world. */
  protected beginBuild(): void {
    const colliders = new Set<number>();
    const bodies = new Set<number>();
    this.world.forEachCollider((c) => colliders.add(c.handle));
    this.world.forEachRigidBody((b) => bodies.add(b.handle));
    this.before = { objects: new Set(this.scene.children), colliders, bodies };
  }

  /** Call after building: flush the static batch, check the route, note what's ours. */
  protected endBuild(): void {
    this.batch.flush(this.scene);
    const b = this.before!;
    this.ownedObjects = this.scene.children.filter((o) => !b.objects.has(o));
    this.world.forEachCollider((c) => {
      if (!b.colliders.has(c.handle)) this.ownedColliders.push(c.handle);
    });
    this.world.forEachRigidBody((r) => {
      if (!b.bodies.has(r.handle)) this.ownedBodies.push(r.handle);
    });
    this.before = null;
    if (import.meta.env.DEV) this.validateRoute();
  }

  /** Build a level's moving parts while noting them for culling. */
  protected trackLevel(k: number, fn: () => void): void {
    const before = new Set(this.scene.children);
    fn();
    (this.levelObjects[k] ??= []).push(...this.scene.children.filter((o) => !before.has(o)));
  }

  /** Remove everything this map added to the scene and the physics world. */
  dispose(): void {
    for (const o of this.ownedObjects) {
      this.scene.remove(o);
      o.traverse((m) => {
        const mesh = m as THREE.Mesh;
        mesh.geometry?.dispose?.();
        // Materials made for this map alone (lasers, nets, belts, ghosts) go with it; the shared
        // cached ones stay for the next map. Every round loads a map, so this adds up.
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const mat of mats) {
          if (isSharedMaterial(mat)) continue;
          (mat as THREE.MeshBasicMaterial).map?.dispose();
          mat.dispose();
        }
      });
    }
    // Free-standing colliders first; then bodies, which take their own colliders with them.
    // (Removing a collider twice corrupts the physics world, so check each one still exists.)
    for (const h of this.ownedColliders) {
      if (!this.world.colliders.contains(h)) continue;
      const col = this.world.getCollider(h);
      if (col && !col.parent()) this.world.removeCollider(col, false);
    }
    for (const h of this.ownedBodies) {
      if (!this.world.bodies.contains(h)) continue;
      const body = this.world.getRigidBody(h);
      if (body) this.world.removeRigidBody(body);
    }
    this.ownedObjects = [];
    this.ownedBodies = [];
    this.ownedColliders = [];
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number, time: number): void {
    const game = this.game;
    for (const p of this.platforms) p.update(time);
    for (const s of this.sweepers) s.update(dt, game);
    for (const p of this.pushers) p.update(time, game);
    for (const p of this.pendulums) p.update(time, game);
    for (const t of this.crumbles) t.update(dt, game);
    for (const b of this.boulders) b.update(time, game);
    for (const l of this.lasers) l.update(time, game);
    for (const f of this.flipFloors) f.update(time);
    for (const g of this.ghosts) g.update(time, game);
    for (const c of game.characters) {
      c.conveyor.set(0, 0, 0);
      for (const b of this.conveyors) b.apply(c);
      for (const t of this.turntables) t.apply(c);
      for (const w of this.winds) w.apply(c, time);
    }
  }

  syncView(alpha: number, dt: number): void {
    const t = this.game.time;
    for (const p of this.platforms) p.syncView(alpha);
    for (const p of this.pushers) p.syncView(alpha);
    for (const p of this.pendulums) p.syncView(t);
    for (const b of this.conveyors) b.scroll(dt);
    for (const b of this.boulders) b.syncView(t);
    for (const l of this.lasers) l.syncView(t);
    for (const s of this.turntables) s.syncView(t);
    for (const f of this.flipFloors) f.syncView(t);
    for (const g of this.ghosts) g.syncView(t);
    for (const w of this.winds) w.syncView(t, dt);
  }

  /**
   * Hide the moving obstacles on levels more than one away from the camera. They're mostly
   * behind floors and walls, but each still costs draw calls on a laptop GPU.
   */
  cullFloors(cameraY: number): void {
    const cf = Math.floor((cameraY + 1) / FH);
    if (cf === this.shownLevel) return;
    this.shownLevel = cf;
    this.levelObjects.forEach((objs, k) => {
      const show = Math.abs(k - cf) <= 1 || (k === LEVELS && cf >= LEVELS - 1);
      for (const o of objs) o.visible = show;
    });
  }

  isNet(handle: number): boolean {
    return this.netHandles.has(handle);
  }

  /** The net a point is in or bouncing above, if any. */
  netAt(x: number, feetY: number, z: number): { y: number; exits: THREE.Vector3[] } | null {
    // Up to the top of a trampoline jump (~4 m).
    return this.nets.find((n) => inRect(n.rect, x, z) && feetY > n.y - 0.3 && feetY < n.y + 4.5) ?? null;
  }

  // ------------------------------------------------------------------ helpers

  protected collider(center: THREE.Vector3, half: THREE.Vector3, quat = new THREE.Quaternion()): RAPIER.Collider {
    return this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
    );
  }

  /** Axis-aligned solid box: visual + collider. y0 = bottom. */
  protected solid(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number | THREE.Material, opts: { walkable?: boolean; cast?: boolean; outline?: boolean } = {}) {
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const h = new THREE.Vector3(Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
    this.batch.box(c, h, new THREE.Quaternion(), typeof color === 'number' ? toon(color) : color, { cast: opts.cast, outline: opts.outline });
    const col = this.collider(c, h);
    if (opts.walkable) this.slabHandles.add(col.handle);
    return col;
  }

  /** A rotated solid box (ramps, girders): centre, half-extents, rotation. */
  protected solidRot(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion, color: number | THREE.Material, opts: { walkable?: boolean; cast?: boolean; outline?: boolean } = {}) {
    this.batch.box(center, half, quat, typeof color === 'number' ? toon(color) : color, { cast: opts.cast, outline: opts.outline });
    const col = this.collider(center, half, quat);
    if (opts.walkable) this.slabHandles.add(col.handle);
    return col;
  }

  /** Visual-only box. */
  protected deco(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; outline?: boolean } = {}) {
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const h = new THREE.Vector3(Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
    this.batch.box(c, h, new THREE.Quaternion(), mat, opts);
  }

  /** Any geometry into the static batch (visual only). */
  protected decoGeo(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3, rotY = 0, scale = new THREE.Vector3(1, 1, 1), opts: { cast?: boolean; outline?: boolean } = {}) {
    const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), scale);
    this.batch.add(geo, mat, m, { cast: opts.cast, outline: opts.outline ?? false });
  }

  /**
   * Floor slab with its top at height y over the square [-half, half]², with holes;
   * `islands` re-fill parts of holes. Greedy-merged into as few boxes as possible.
   */
  protected slab(y: number, half: number, holes: Rect[], islands: Rect[], color: number | THREE.Material, ceiling: THREE.Material | null, thickness = SLAB): void {
    const step = 0.5;
    const n = Math.round((2 * half) / step);
    const solidAt = (i: number, j: number) => {
      const x = -half + (i + 0.5) * step;
      const z = -half + (j + 0.5) * step;
      return islands.some((r) => inRect(r, x, z)) || !holes.some((r) => inRect(r, x, z));
    };
    const used = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (used[j * n + i] || !solidAt(i, j)) continue;
        let w = 1;
        while (i + w < n && !used[j * n + i + w] && solidAt(i + w, j)) w++;
        let d = 1;
        outer: while (j + d < n) {
          for (let t = 0; t < w; t++) if (used[(j + d) * n + i + t] || !solidAt(i + t, j + d)) break outer;
          d++;
        }
        for (let dj = 0; dj < d; dj++) for (let t = 0; t < w; t++) used[(j + dj) * n + i + t] = 1;
        const x0 = -half + i * step;
        const z0 = -half + j * step;
        this.solid(x0, x0 + w * step, y - thickness, y, z0, z0 + d * step, color, { walkable: true, cast: false, outline: false });
        // Clean, softly self-lit ceiling under the slab (it faces away from the sun).
        if (ceiling) this.deco(x0, x0 + w * step, y - thickness - 0.02, y - thickness, z0, z0 + d * step, ceiling, { cast: false, receive: false, outline: false });
      }
    }
  }

  /** Thin railing with a top rail. */
  protected railing(x0: number, z0: number, x1: number, z1: number, y: number, glass = 0xbfe6ff, rail = 0xd9dde3): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.3) return;
    const c = new THREE.Vector3((x0 + x1) / 2, y + 0.55, (z0 + z1) / 2);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(z1 - z0, x1 - x0));
    this.batch.box(c, new THREE.Vector3(len / 2, 0.5, 0.03), q, toon(glass, { opacity: 0.35 }), { cast: false, outline: false });
    this.batch.box(c.clone().setY(y + 1.08), new THREE.Vector3(len / 2, 0.04, 0.06), q, toon(rail));
    this.collider(c, new THREE.Vector3(len / 2, 0.55, 0.06), q);
  }

  /** Railing along a line with gaps (each gap = [from, to] along the line). */
  protected railWithGaps(fixed: number, axis: 'x' | 'z', from: number, to: number, gaps: [number, number][], y: number, glass?: number, rail?: number): void {
    let a = from;
    const segs: [number, number][] = [];
    for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
      segs.push([a, g0]);
      a = g1;
    }
    segs.push([a, to]);
    for (const [s0, s1] of segs) {
      if (s1 - s0 < 0.3) continue;
      if (axis === 'x') this.railing(s0, fixed, s1, fixed, y, glass, rail);
      else this.railing(fixed, s0, fixed, s1, y, glass, rail);
    }
  }

  /** A trampoline net over a rectangle; jumping on it launches you back up. */
  protected net(y: number, rect: Rect, exits: THREE.Vector3[], frame = 0xff6f91): void {
    const x0 = Math.min(rect[0], rect[1]);
    const x1 = Math.max(rect[0], rect[1]);
    const z0 = Math.min(rect[2], rect[3]);
    const z1 = Math.max(rect[2], rect[3]);
    const col = this.collider(new THREE.Vector3((x0 + x1) / 2, y - 0.05, (z0 + z1) / 2), new THREE.Vector3((x1 - x0) / 2, 0.05, (z1 - z0) / 2));
    this.netHandles.add(col.handle);
    const tex = canvasTexture(
      64,
      64,
      (g) => {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 4;
        g.strokeRect(0, 0, 64, 64);
      },
      true,
    );
    tex.repeat.set((x1 - x0) * 1.45, (z1 - z0) * 1.45);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.scene.add(mesh);
    const fm = toon(frame);
    this.deco(x0, x1, y - 0.12, y + 0.05, z0 - 0.1, z0 + 0.1, fm, { cast: false });
    this.deco(x0, x1, y - 0.12, y + 0.05, z1 - 0.1, z1 + 0.1, fm, { cast: false });
    this.deco(x0 - 0.1, x0 + 0.1, y - 0.12, y + 0.05, z0, z1, fm, { cast: false });
    this.deco(x1 - 0.1, x1 + 0.1, y - 0.12, y + 0.05, z0, z1, fm, { cast: false });
    this.nets.push({ y, rect, exits });
  }

  protected tileCrumbles(r: Rect, y: number, size: number): void {
    const x0 = Math.min(r[0], r[1]);
    const x1 = Math.max(r[0], r[1]);
    const z0 = Math.min(r[2], r[3]);
    const z1 = Math.max(r[2], r[3]);
    const nx = Math.max(1, Math.round((x1 - x0) / size));
    const nz = Math.max(1, Math.round((z1 - z0) / size));
    const sx = (x1 - x0) / nx;
    const sz = (z1 - z0) / nz;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        this.crumbles.push(new CrumbleTile(this.world, this.scene, x0 + (i + 0.5) * sx, z0 + (j + 0.5) * sz, y, sx / 2, sz / 2));
      }
  }

  protected addPusher(base: THREE.Vector3, dir: THREE.Vector3, reach: number, width: number, period: number, phase: number): void {
    const alongX = Math.abs(dir.x) > 0.5;
    const half = new THREE.Vector3(alongX ? 0.55 : width / 2, 0.85, alongX ? width / 2 : 0.55);
    const center = base.clone();
    center.y += half.y + 0.02;
    this.pushers.push(new Pusher(this.world, this.scene, center, dir.clone().normalize(), reach, half, period, phase));
  }

  /** Wrecking ball hung `ceiling` above floor point p, swinging along axis. */
  protected addPendulum(p: THREE.Vector3, axis: THREE.Vector3, phase: number, speed = 1.9, ceiling = FH - SLAB, style?: 'ball' | 'chandelier' | 'axe'): Pendulum {
    const pivot = new THREE.Vector3(p.x, p.y + ceiling, p.z);
    const pd = new Pendulum(this.scene, pivot, axis.clone().normalize(), ceiling - 1.2, 0.95, speed, phase, style);
    this.pendulums.push(pd);
    return pd;
  }

  protected addConveyor(r: Rect, y: number, vel: THREE.Vector3): void {
    this.conveyors.push(new Conveyor(this.scene, r[0], r[1], r[2], r[3], y, vel));
  }

  /** Spinning bar on a post (the post goes into the static batch). */
  protected addSweeper(base: THREE.Vector3, halfLen: number, speed: number, post = true): void {
    if (post) {
      const m = new THREE.Matrix4().makeTranslation(base.x, base.y + 0.5, base.z);
      this.batch.add(new THREE.CylinderGeometry(0.22, 0.28, 1.0, 12), toon(0x4b4a63), m, { outline: false });
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.5, 0.25).setTranslation(base.x, base.y + 0.5, base.z));
    }
    this.sweepers.push(new Sweeper(this.scene, new THREE.Vector3(base.x, base.y + 0.95, base.z), speed, halfLen));
  }

  protected addPlatform(base: THREE.Vector3, axis: THREE.Vector3, amp: number, period: number, phase: number, half: THREE.Vector3): MovingPlatform {
    const p = new MovingPlatform(this.world, this.scene, base, axis, amp, period, phase, half);
    this.platforms.push(p);
    this.platformByCollider.set(p.collider.handle, p);
    return p;
  }

  protected plant(x: number, y: number, z: number): void {
    // Tapered pot with a rim and soil, and a bushy top in two greens.
    this.collider(new THREE.Vector3(x, y + 0.275, z), new THREE.Vector3(0.3, 0.275, 0.3));
    const at = (dx: number, dy: number, dz: number) => new THREE.Vector3(x + dx, y + dy, z + dz);
    const one = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    this.batch.add(new THREE.CylinderGeometry(0.32, 0.24, 0.5, 14), toon(0xd9774f), new THREE.Matrix4().compose(at(0, 0.25, 0), q, one), { outline: false });
    this.batch.add(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 14), toon(0xc0643f), new THREE.Matrix4().compose(at(0, 0.52, 0), q, one), { outline: false });
    this.batch.add(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 14), toon(0x5a4030), new THREE.Matrix4().compose(at(0, 0.56, 0), q, one), { outline: false });
    const greens = [toon(0x59b36b), toon(0x4a9a5c), toon(0x6cc27a)];
    const blobs: [number, number, number, number][] = [
      [0, 1.0, 0, 0.5],
      [0.2, 0.82, 0.12, 0.36],
      [-0.18, 0.86, -0.1, 0.38],
      [0.05, 1.32, -0.05, 0.32],
    ];
    blobs.forEach(([dx, dy, dz, r], i) =>
      this.batch.add(new THREE.IcosahedronGeometry(r, 1), greens[i % 3], new THREE.Matrix4().compose(at(dx, dy, dz), q, new THREE.Vector3(1, 1.15, 1)), { outline: false }),
    );
  }

  // ------------------------------------------------------------------ dev check

  /** Dev check: warn about route segments that cross holes or walls. */
  private validateRoute(): void {
    // Colliders are queryable only after the broad-phase has seen them.
    this.world.step();
    const down = { x: 0, y: -1, z: 0 };
    const warn: string[] = [];
    const check = (a: Waypoint, b: Waypoint, label: string) => {
      if (b.jump || b.platform || a.platform) return;
      const len = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
      // Knee-height sweep for furniture on flat-ish segments.
      if (Math.abs(b.pos.y - a.pos.y) < 0.5 && len > 0.5) {
        const dir = { x: (b.pos.x - a.pos.x) / len, y: 0, z: (b.pos.z - a.pos.z) / len };
        for (const off of [-0.35, 0, 0.35]) {
          const o = { x: a.pos.x - dir.z * off, y: a.pos.y + 0.5, z: a.pos.z + dir.x * off };
          const hit = this.world.castRay(new RAPIER.Ray(o, dir), len, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
          if (hit) {
            warn.push(`${label}: blocked at ${hit.timeOfImpact.toFixed(1)}m from (${a.pos.x.toFixed(1)}, ${a.pos.y.toFixed(1)}, ${a.pos.z.toFixed(1)}) offset ${off}`);
            return;
          }
        }
      }
      for (let t = 0.5; t < len; t += 0.5) {
        const f = t / len;
        const pt = { x: a.pos.x + (b.pos.x - a.pos.x) * f, y: a.pos.y + (b.pos.y - a.pos.y) * f + 1.5, z: a.pos.z + (b.pos.z - a.pos.z) * f };
        const hit = this.world.castRay(new RAPIER.Ray(pt, down), 2.7, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
        if (!hit) {
          warn.push(`${label}: no floor at (${pt.x.toFixed(1)}, ${(pt.y - 1.5).toFixed(1)}, ${pt.z.toFixed(1)})`);
          return;
        }
        if (hit.timeOfImpact < 0.3) {
          warn.push(`${label}: obstacle at (${pt.x.toFixed(1)}, ${(pt.y - 1.5).toFixed(1)}, ${pt.z.toFixed(1)})`);
          return;
        }
      }
    };
    this.route.forEach((seg, si) => {
      seg.alts.forEach((alt, ai) => {
        for (let i = 0; i + 1 < alt.length; i++) check(alt[i], alt[i + 1], `seg ${si} (level ${seg.floor}) alt ${ai} wp ${i}→${i + 1}`);
        const next = this.route[si + 1];
        if (next) next.alts.forEach((n, ni) => check(alt[alt.length - 1], n[0], `seg ${si} alt ${ai} → seg ${si + 1} alt ${ni}`));
      });
    });
    const counts = `${this.spawnPoints.length} spawns, ${this.crateSpots.length} drop spots, ${this.rackSpots.length} racks`;
    if (this.spawnPoints.length !== 24 || this.crateSpots.length !== 48 || this.rackSpots.length !== 24) warn.push(`map contract broken: ${counts}`);
    const total = this.route.reduce((n, s) => n + s.alts.reduce((m, a) => m + a.length, 0), 0);
    if (warn.length) console.warn(`[route ${this.id}]`, warn.join('\n'));
    else console.info(`[route ${this.id}] ${this.route.length} segments, ${total} waypoints OK (${counts})`);
  }
}
