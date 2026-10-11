import RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three';
import { toon } from './toon';
import type { Character } from './character';
import type { Game } from './game';

export type TrapKind = 'grease' | 'spring' | 'trapdoor' | 'beartrap';
export const TRAP_KINDS: TrapKind[] = ['grease', 'spring', 'trapdoor', 'beartrap'];
export const TRAP_NAMES: Record<TrapKind, string> = {
  grease: 'Grease',
  spring: 'Spring',
  trapdoor: 'Trapdoor',
  beartrap: 'Bear Trap',
};

const RADIUS: Record<TrapKind, number> = { grease: 1.4, spring: 0.8, trapdoor: 0.85, beartrap: 0.55 };
const LIFETIME: Record<TrapKind, number> = { grease: 40, spring: 40, trapdoor: 60, beartrap: 60 };
/** How long a used trap lingers for its animation before vanishing. */
const LINGER: Record<TrapKind, number> = { grease: 0, spring: 0, trapdoor: 1.2, beartrap: 2.2 };

interface Trap {
  id: string;
  kind: TrapKind;
  owner: Character;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  dir: THREE.Vector3;
  groundHandle: number;
  armAt: number;
  expireAt: number;
  used: boolean;
  usedAt: number;
  mesh: THREE.Group;
  anim: THREE.Object3D;
}

const DOWN = { x: 0, y: -1, z: 0 };

export class Traps {
  readonly list: Trap[] = [];

  private nextId = 1;

  constructor(private readonly game: Game) {}

  /** Place a trap ~2m in front of `c` (or along `yaw` if given). */
  tryPlace(c: Character, kind: TrapKind, yaw = c.yaw): boolean {
    const game = this.game;
    if (c.traps[kind] <= 0 || c.stun > 0) return false;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const origin = new THREE.Vector3(c.pos.x + fwd.x * 2, c.pos.y + 0.8, c.pos.z + fwd.z * 2);
    const hit = game.world.castRayAndGetNormal(
      new RAPIER.Ray(origin, DOWN),
      4,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const fail = (msg: string) => {
      if (c.isPlayer) game.hud.popup(msg, '#ff9090', true);
      return false;
    };
    if (!hit || hit.timeOfImpact < 0.05 || hit.normal.y < 0.6) return fail("CAN'T PLACE THERE");
    const pos = origin.clone().addScaledVector(new THREE.Vector3(0, -1, 0), hit.timeOfImpact);
    if (kind === 'trapdoor' && !game.tower.slabHandles.has(hit.collider.handle)) return fail('TRAPDOORS NEED A PLATFORM');
    if (this.list.some((t) => t.pos.distanceTo(pos) < 1.3)) return fail('TOO CLOSE TO ANOTHER TRAP');

    c.traps[kind]--;
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
    const id = `${c.netId}-${this.nextId++}`;
    this.create(id, kind, c, pos, normal, fwd, hit.collider.handle);
    if (game.mode === 'online') {
      game.net.send({ t: 'trap', id, kind, owner: c.netId, pos: pos.toArray(), normal: normal.toArray(), dir: fwd.toArray(), ground: hit.collider.handle });
    }
    if (c.isPlayer || c.pos.distanceTo(game.player.pos) < 15) game.sfx.place();
    return true;
  }

  private create(id: string, kind: TrapKind, owner: Character | null, pos: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, groundHandle: number): void {
    const game = this.game;
    const { mesh, anim } = makeTrapMesh(kind);
    mesh.position.copy(pos).addScaledVector(normal, 0.02);
    mesh.quaternion
      .setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z)));
    game.scene.add(mesh);
    this.list.push({
      id,
      kind,
      owner: owner as Character,
      pos,
      normal,
      dir,
      groundHandle,
      armAt: game.time + 0.6,
      expireAt: game.time + LIFETIME[kind],
      used: false,
      usedAt: 0,
      mesh,
      anim,
    });
  }

  /** Online: someone else placed a trap. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addRemote(m: any, owner: Character | null): void {
    if (this.list.some((t) => t.id === m.id)) return;
    // From another player's machine: ignore anything malformed rather than crash on it.
    const ok = (a: unknown) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));
    if (!TRAP_KINDS.includes(m.kind) || !ok(m.pos) || !ok(m.normal) || !ok(m.dir)) return;
    const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
    this.create(String(m.id), m.kind as TrapKind, owner, v(m.pos), v(m.normal).normalize(), v(m.dir), Number(m.ground));
  }

  /** Online: a single-use trap was sprung on someone else's machine. */
  markUsed(id: string): void {
    const t = this.list.find((x) => x.id === id);
    if (t && !t.used) {
      t.used = true;
      t.usedAt = this.game.time;
    }
  }

  update(dt: number): void {
    const game = this.game;
    const time = game.time;
    for (const c of game.characters) c.slippery = false;
    const rel = new THREE.Vector3();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      if (time > t.expireAt || (t.used && time - t.usedAt > LINGER[t.kind])) {
        this.remove(i);
        continue;
      }
      this.animate(t, dt);
      if (t.used || time < t.armAt) continue;
      for (const c of game.characters) {
        // Remote fighters get trapped on their own machine.
        if (c.remote) continue;
        // Owners are immune to their own traps — except springs, which double as a boost.
        if (c === t.owner && t.kind !== 'spring') continue;
        rel.set(c.pos.x - t.pos.x, c.feetY - t.pos.y, c.pos.z - t.pos.z);
        const along = rel.dot(t.normal);
        if (along < -0.35 || along > 0.45) continue;
        if (rel.addScaledVector(t.normal, -along).length() > RADIUS[t.kind] + 0.15) continue;
        this.trigger(t, c);
        if (t.used) break;
      }
    }
  }

  private trigger(t: Trap, c: Character): void {
    const game = this.game;
    const by = t.owner === c ? null : t.owner;
    const near = c.isPlayer || c.pos.distanceTo(game.player.pos) < 20;
    switch (t.kind) {
      case 'grease':
        c.slippery = true;
        if (by) {
          c.lastHitBy = by;
          c.lastHitAt = game.time;
        }
        return;
      case 'spring':
        if (c.springCooldown > 0) return;
        c.springCooldown = 0.6;
        c.knock(t.dir, 7, 17, 0.25, by);
        (t.anim.userData as { bounce: number }).bounce = 1;
        if (near) game.sfx.boing();
        if (c.isPlayer) game.hud.popup('BOING!', '#ff8a3d', true);
        return;
      case 'trapdoor':
        c.ignoreHandle = t.groundHandle;
        c.ignoreTimer = 0.6;
        c.vel.y = Math.min(c.vel.y, -3);
        c.stun = Math.max(c.stun, 0.6);
        c.grounded = false;
        break;
      case 'beartrap':
        c.rootT = 2;
        c.vel.set(0, Math.min(c.vel.y, 0), 0);
        if (near) game.sfx.clank();
        if (c.isPlayer) game.hud.popup('BEAR TRAP!', '#ff5050', true);
        break;
    }
    if (by) {
      c.lastHitBy = by;
      c.lastHitAt = game.time;
      game.hud.feed(`${by.name}'s ${TRAP_NAMES[t.kind].toLowerCase()} got ${c.name}`);
    }
    t.used = true;
    t.usedAt = game.time;
    if (game.mode === 'online') game.net.send({ t: 'trapUse', id: t.id });
  }

  private animate(t: Trap, dt: number): void {
    const ud = t.anim.userData as { bounce?: number };
    if (t.kind === 'spring' && ud.bounce) {
      ud.bounce = Math.max(0, ud.bounce - dt * 3);
      t.anim.position.y = 0.32 + Math.sin(ud.bounce * Math.PI * 3) * 0.25 * ud.bounce;
    }
    if (!t.used) return;
    const k = Math.min(1, (this.game.time - t.usedAt) / 0.2);
    if (t.kind === 'trapdoor') t.anim.rotation.x = -k * Math.PI * 0.55;
    if (t.kind === 'beartrap') t.anim.scale.set(1 - 0.45 * k, 1 + 0.8 * k, 1 - 0.45 * k);
  }

  private remove(i: number): void {
    const t = this.list[i];
    this.game.scene.remove(t.mesh);
    this.list.splice(i, 1);
  }

  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
  }
}

function makeTrapMesh(kind: TrapKind): { mesh: THREE.Group; anim: THREE.Object3D } {
  const g = new THREE.Group();
  let anim: THREE.Object3D = g;
  const std = (color: number, extra: { opacity?: number; roughness?: number; metalness?: number; transparent?: boolean } = {}) => toon(color, { opacity: extra.opacity });

  if (kind === 'grease') {
    const puddle = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS.grease, 28).rotateX(-Math.PI / 2),
      std(0xc8e030, { roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.85 }),
    );
    puddle.receiveShadow = true;
    g.add(puddle);
    for (let i = 0; i < 5; i++) {
      const blob = new THREE.Mesh(new THREE.SphereGeometry(0.18 + Math.random() * 0.15, 10, 6), std(0xa8c020, { roughness: 0.05 }));
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.9;
      blob.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      blob.scale.y = 0.25;
      g.add(blob);
    }
  } else if (kind === 'spring') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 0.12, 20), std(0x333333, { metalness: 0.6 }));
    base.position.y = 0.06;
    const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.22, 16, 1, true), std(0xffd23f, { metalness: 0.5 }));
    coil.position.y = 0.2;
    const top = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.1, 20), std(0xff5a2a));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 3), std(0xffffff));
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.09, 0.15);
    arrow.scale.y = 1.2;
    top.add(plate, arrow);
    top.position.y = 0.32;
    g.add(base, coil, top);
    anim = top;
  } else if (kind === 'trapdoor') {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 1.9), std(0x2a1a0e));
    frame.position.y = 0.01;
    const hinge = new THREE.Group();
    hinge.position.set(0, 0.04, -0.8);
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.6), std(0x7a4f2a));
    hatch.position.z = 0.8;
    const x1 = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.07, 0.12), std(0x3a2412));
    x1.rotation.y = Math.PI / 4;
    x1.position.z = 0.8;
    const x2 = x1.clone();
    x2.rotation.y = -Math.PI / 4;
    hinge.add(hatch, x1, x2);
    g.add(frame, hinge);
    anim = hinge;
  } else {
    const jaws = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.06, 8, 24).rotateX(Math.PI / 2), std(0x8a8f99, { metalness: 0.8, roughness: 0.3 }));
    ring.position.y = 0.06;
    jaws.add(ring);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 4), std(0xcfd3da, { metalness: 0.8 }));
      tooth.position.set(Math.cos(a) * 0.45, 0.16, Math.sin(a) * 0.45);
      jaws.add(tooth);
    }
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 12), std(0x555a63));
    plate.position.y = 0.02;
    g.add(jaws, plate);
    anim = jaws;
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return { mesh: g, anim };
}
