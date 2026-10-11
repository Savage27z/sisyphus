import RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three';
import { toon } from './toon';
import type { Character } from './character';
import type { Game } from './game';

/** Melee: on its own button, always available (Shove unless you've picked up a blade or hammer). */
export type MeleeKind = 'fists' | 'knife' | 'bat';
/** Guns: everyone always has one (the Blaster unless you've picked up something better). */
export type GunKind = 'blaster' | 'pushgun' | 'rocket' | 'railgun' | 'freeze';
export type WeaponKind = MeleeKind | GunKind;

export interface WeaponDef {
  name: string;
  cooldown: number;
  range: number;
  /** Full cone angle for melee, radians. */
  cone: number;
  force: number;
  up: number;
  stun: number;
  damage: number;
  uses: number;
  ranged: boolean;
  /** Hold the button to keep firing. */
  auto?: boolean;
  /** Shotgun pellets: `damage` is per pellet, the push is per shot. */
  pellets?: number;
  /** Explosion radius: everyone nearby gets thrown, the shooter too (rocket jumps). */
  splash?: number;
  /** Seconds the target is frozen in place. */
  freeze?: number;
  /** Shot colour, and a thick beam instead of a thin tracer. */
  tracer?: number;
  beam?: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;

export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  // Hits to knock out a fighter at full health (100 HP): Shove 8, Knife 3, Sledgehammer 3,
  // Blaster 6, Shotgun 2 up close, Rocket 2 direct, Railgun 2, Freeze Ray 10 (it's for freezing).
  fists: { name: 'Shove', cooldown: 0.55, range: 1.9, cone: deg(75), force: 10, up: 4.5, stun: 0.8, damage: 13, uses: Infinity, ranged: false },
  knife: { name: 'Combat Knife', cooldown: 0.3, range: 1.8, cone: deg(60), force: 5, up: 2.5, stun: 1.1, damage: 35, uses: 15, ranged: false },
  bat: { name: 'Sledgehammer', cooldown: 0.9, range: 2.5, cone: deg(110), force: 17, up: 7, stun: 1.3, damage: 40, uses: 8, ranged: false },
  blaster: { name: 'Blaster', cooldown: 0.25, range: 30, cone: 0, force: 6, up: 2.5, stun: 0.3, damage: 17, uses: Infinity, ranged: true, auto: true, tracer: 0x7fdcff },
  pushgun: { name: 'Shotgun', cooldown: 0.75, range: 24, cone: 0, force: 13, up: 5, stun: 1.0, damage: 10, uses: 10, ranged: true, pellets: 6, tracer: 0xffd9a0 },
  rocket: { name: 'Rocket Launcher', cooldown: 1.2, range: 60, cone: 0, force: 16, up: 9, stun: 1.3, damage: 55, uses: 5, ranged: true, splash: 3.4, tracer: 0xff8a3d, beam: true },
  railgun: { name: 'Railgun', cooldown: 1.6, range: 90, cone: 0, force: 20, up: 6, stun: 1.4, damage: 60, uses: 5, ranged: true, tracer: 0xc77dff, beam: true },
  freeze: { name: 'Freeze Ray', cooldown: 0.9, range: 26, cone: 0, force: 1.5, up: 0, stun: 0, damage: 10, uses: 6, ranged: true, freeze: 2.2, tracer: 0x9ff3ff, beam: true },
};

export const GUN_IDS: GunKind[] = ['blaster', 'pushgun', 'rocket', 'railgun', 'freeze'];
export const MELEE_IDS: MeleeKind[] = ['fists', 'knife', 'bat'];
export const isGun = (k: WeaponKind): k is GunKind => WEAPONS[k].ranged;
/** What supply drops and weapon racks can hold. */
export const LOOT_WEAPONS: WeaponKind[] = ['knife', 'bat', 'pushgun', 'rocket', 'railgun', 'freeze'];
/** The racks by the start line: the big guns everyone races for. */
export const POWER_WEAPONS: WeaponKind[] = ['rocket', 'railgun'];

/** Weapon models in meters. Origin = grip, +Z = blade/barrel direction, +Y = up. */
export function makeWeaponMesh(kind: WeaponKind): THREE.Object3D | null {
  if (kind === 'fists') return null;
  const g = new THREE.Group();
  const steel = toon(0xd5dae0);
  const blackMetal = toon(0x2a2d31);
  const polymer = toon(0x2a2e26);
  const wood = toon(0x8a5530);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    return m;
  };
  const tube = (r: number, len: number, mat: THREE.Material, y: number, z: number, seg = 12) => add(new THREE.CylinderGeometry(r, r, len, seg), mat, 0, y, z, Math.PI / 2);
  switch (kind) {
    case 'knife': {
      add(new THREE.CylinderGeometry(0.016, 0.018, 0.12, 10), polymer, 0, 0, 0, Math.PI / 2);
      add(new THREE.BoxGeometry(0.07, 0.014, 0.012), blackMetal, 0, 0, 0.066);
      const blade = new THREE.Shape();
      blade.moveTo(0, -0.012);
      blade.lineTo(0.15, -0.012);
      blade.quadraticCurveTo(0.19, -0.01, 0.2, 0.012);
      blade.lineTo(0.14, 0.016);
      blade.lineTo(0, 0.018);
      blade.closePath();
      const bg = new THREE.ExtrudeGeometry(blade, { depth: 0.004, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.001, bevelSegments: 1 });
      bg.rotateY(-Math.PI / 2);
      bg.translate(0.002, 0, 0.07);
      add(bg, steel, 0, 0, 0);
      break;
    }
    case 'bat':
      add(new THREE.CylinderGeometry(0.018, 0.021, 0.85, 10), wood, 0, 0, 0.3, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.023, 0.023, 0.14, 10), polymer, 0, 0, -0.06, Math.PI / 2);
      add(new THREE.BoxGeometry(0.1, 0.24, 0.1), blackMetal, 0, 0.02, 0.72);
      add(new THREE.BoxGeometry(0.105, 0.03, 0.105), steel, 0, 0.135, 0.72);
      add(new THREE.BoxGeometry(0.105, 0.03, 0.105), steel, 0, -0.095, 0.72);
      break;
    case 'blaster': {
      // Chunky toy-like pistol with a glowing muzzle.
      add(new THREE.BoxGeometry(0.05, 0.07, 0.2), toon(0xf4f1ea), 0, 0.045, 0.08);
      add(new THREE.BoxGeometry(0.052, 0.025, 0.21), toon(0x3b9be0), 0, 0.09, 0.08);
      tube(0.018, 0.08, blackMetal, 0.05, 0.21);
      add(new THREE.SphereGeometry(0.02, 10, 8), toon(0x7fdcff, { emissive: 0x2a8fbf }), 0, 0.05, 0.255);
      add(new THREE.BoxGeometry(0.04, 0.09, 0.05), polymer, 0, -0.02, 0).rotation.x = -0.25;
      break;
    }
    case 'pushgun': {
      add(new THREE.BoxGeometry(0.045, 0.075, 0.26), blackMetal, 0, 0.04, 0.12);
      tube(0.012, 0.52, blackMetal, 0.065, 0.5);
      tube(0.011, 0.42, blackMetal, 0.035, 0.44, 10);
      const pump = tube(0.02, 0.16, polymer, 0.035, 0.36);
      pump.scale.x = 1.2;
      add(new THREE.BoxGeometry(0.035, 0.09, 0.05), polymer, 0, -0.02, 0.0).rotation.x = -0.3;
      const stock = new THREE.Shape();
      stock.moveTo(0, 0.07);
      stock.lineTo(0.26, 0.06);
      stock.lineTo(0.27, -0.08);
      stock.lineTo(0.2, -0.08);
      stock.lineTo(0.02, 0.01);
      stock.closePath();
      const sg = new THREE.ExtrudeGeometry(stock, { depth: 0.035, bevelEnabled: false });
      sg.rotateY(Math.PI / 2);
      sg.translate(-0.0175, 0.01, 0);
      add(sg, polymer, 0, 0, -0.01);
      add(new THREE.BoxGeometry(0.006, 0.012, 0.012), steel, 0, 0.083, 0.75);
      break;
    }
    case 'rocket': {
      // Over-the-shoulder tube with a warhead poking out.
      tube(0.065, 0.95, toon(0x6b7a3a), 0.11, 0.18, 16);
      tube(0.072, 0.08, blackMetal, 0.11, 0.64, 16);
      tube(0.072, 0.08, blackMetal, 0.11, -0.28, 16);
      add(new THREE.ConeGeometry(0.05, 0.14, 12), toon(0xe8455a), 0, 0.11, 0.72, Math.PI / 2);
      add(new THREE.BoxGeometry(0.035, 0.09, 0.05), polymer, 0, 0.0, 0.0).rotation.x = -0.25;
      add(new THREE.BoxGeometry(0.03, 0.05, 0.08), polymer, 0, 0.03, 0.3);
      break;
    }
    case 'railgun': {
      // Long rails with glowing coils.
      add(new THREE.BoxGeometry(0.05, 0.08, 0.3), toon(0x3a2f52), 0, 0.045, 0.1);
      for (const x of [-0.022, 0.022]) add(new THREE.BoxGeometry(0.012, 0.02, 0.62), steel, x, 0.06, 0.52);
      const coil = toon(0xc77dff, { emissive: 0x6a2ba8 });
      for (let i = 0; i < 4; i++) add(new THREE.TorusGeometry(0.038, 0.009, 6, 16), coil, 0, 0.06, 0.32 + i * 0.12);
      add(new THREE.BoxGeometry(0.035, 0.09, 0.05), polymer, 0, -0.02, 0).rotation.x = -0.25;
      add(new THREE.BoxGeometry(0.04, 0.06, 0.18), toon(0x3a2f52), 0, 0.03, -0.12);
      break;
    }
    case 'freeze': {
      // Bulky sci-fi sprayer with a frosty tank.
      add(new THREE.BoxGeometry(0.07, 0.08, 0.22), toon(0xe9f6ff), 0, 0.05, 0.08);
      add(new THREE.SphereGeometry(0.05, 12, 10), toon(0x9ff3ff, { opacity: 0.75, emissive: 0x2a8fbf }), 0, 0.12, 0.05);
      tube(0.03, 0.16, toon(0x5aa9d6), 0.05, 0.26);
      add(new THREE.TorusGeometry(0.034, 0.008, 6, 16), toon(0x9ff3ff, { emissive: 0x2a8fbf }), 0, 0.05, 0.34);
      add(new THREE.BoxGeometry(0.04, 0.09, 0.05), polymer, 0, -0.02, 0).rotation.x = -0.25;
      break;
    }
  }
  g.traverse((o) => (o.castShadow = true));
  // Seat the grip in the palm rather than at the wrist. A hammer is held with the
  // handle running up out of the fist; the knife is angled slightly up for stabbing.
  const holder = new THREE.Group();
  holder.add(g);
  holder.position.set(0, -0.015, 0.075);
  if (kind === 'bat') g.rotation.x = -Math.PI / 2;
  else if (kind === 'knife') g.rotation.x = -0.5;
  return holder;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class Combat {
  constructor(private readonly game: Game) {}

  /** Fire the gun in hand. `aim`: the camera ray for the player, a line to the target for bots. */
  shoot(a: Character, aim?: { origin: THREE.Vector3; dir: THREE.Vector3 }): boolean {
    if (a.stun > 0 || a.gunCooldown > 0) return false;
    const w = WEAPONS[a.weapon];
    a.gunCooldown = w.cooldown;
    a.swingT = 1;
    a.swingKind = a.weapon;
    a.aimT = 0.9;
    this.fire(a, w, aim);
    a.useGun();
    return true;
  }

  /** Swing the melee weapon (Shove, knife or sledgehammer). */
  melee(a: Character): boolean {
    if (a.stun > 0 || a.meleeCooldown > 0) return false;
    const w = WEAPONS[a.melee];
    a.meleeCooldown = w.cooldown;
    a.swingT = 1;
    a.swingKind = a.melee;
    this.swing(a, w);
    a.useMelee();
    return true;
  }

  private swing(a: Character, w: WeaponDef): void {
    const fwd = a.forward(tmpA);
    if (a.grounded) {
      a.vel.x += fwd.x * 3.5;
      a.vel.z += fwd.z * 3.5;
    }
    const minDot = Math.cos(w.cone / 2);
    let best: Character | null = null;
    let bestD = Infinity;
    for (const t of this.game.characters) {
      if (t === a) continue;
      const dx = t.pos.x - a.pos.x;
      const dz = t.pos.z - a.pos.z;
      if (Math.abs(t.pos.y - a.pos.y) > 1.6) continue;
      const h = Math.hypot(dx, dz);
      if (h > w.range + 0.4) continue;
      if (h > 0.3 && (dx * fwd.x + dz * fwd.z) / h < minDot) continue;
      if (h < bestD) {
        bestD = h;
        best = t;
      }
    }
    if (this.near(a, 15)) this.game.sfx.swing();
    if (!best) return;
    const dir = tmpB.set(best.pos.x - a.pos.x, 0, best.pos.z - a.pos.z);
    if (dir.lengthSq() < 1e-4) dir.copy(fwd);
    dir.normalize().add(fwd).normalize();
    this.hit(a, best, w, dir);
  }

  private near(a: Character, d: number): boolean {
    return a.isPlayer || a.pos.distanceTo(this.game.player.pos) < d;
  }

  private fire(a: Character, w: WeaponDef, aim?: { origin: THREE.Vector3; dir: THREE.Vector3 }): void {
    const game = this.game;
    const origin = aim ? aim.origin.clone() : a.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
    const aimDir = aim ? aim.dir.clone().normalize() : a.forward(new THREE.Vector3());
    const muzzle = a.handWorldPos(new THREE.Vector3());
    game.fx.muzzle(muzzle);
    if (this.near(a, 40)) game.sfx.gun(a.weapon as GunKind);
    const color = w.tracer ?? 0xffd9a0;
    // Pellets that found each target (the shotgun hurts more the more of it lands).
    const struck = new Map<Character, { n: number; dir: THREE.Vector3 }>();
    const pellets = w.pellets ?? 1;
    for (let i = 0; i < pellets; i++) {
      const dir = aimDir.clone();
      if (pellets > 1) {
        dir.x += (Math.random() - 0.5) * 0.12;
        dir.y += (Math.random() - 0.5) * 0.07;
        dir.z += (Math.random() - 0.5) * 0.12;
        dir.normalize();
      }
      const hit = game.world.castRay(new RAPIER.Ray(origin, dir), w.range, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, a.collider);
      const end = origin.clone().addScaledVector(dir, hit ? hit.timeOfImpact : w.range);
      if (w.beam) game.fx.beam(muzzle, end, color, w.freeze ? 0.05 : 0.07);
      else game.fx.tracer(muzzle, end, color);
      if (w.splash) {
        // Rockets: the blast does the work, wherever it lands (walls and floors included).
        if (hit) this.explode(a, end, w);
        continue;
      }
      const target = hit ? game.charByCollider.get(hit.collider.handle) : undefined;
      if (!target || target === a) {
        if (hit) game.fx.burst(end, w.freeze ? 0x9ff3ff : 0x8a7a66, 5, 3);
        continue;
      }
      const prev = struck.get(target);
      if (prev) {
        prev.n++;
        continue;
      }
      const kdir = new THREE.Vector3(dir.x, 0, dir.z);
      if (kdir.lengthSq() < 1e-4) a.forward(kdir);
      struck.set(target, { n: 1, dir: kdir.normalize() });
    }
    for (const [target, s] of struck) this.hit(a, target, w, s.dir, 1, s.n);
  }

  private explode(a: Character, center: THREE.Vector3, w: WeaponDef): void {
    const game = this.game;
    const r = w.splash ?? 3;
    game.fx.burst(center, 0xff8a3d, 26, 9);
    game.fx.burst(center, 0x5b5560, 14, 4);
    if (center.distanceTo(game.player.pos) < 30) {
      game.sfx.boom();
      game.fx.addShake(Math.max(0, 0.6 - center.distanceTo(game.player.pos) / 30));
    }
    for (const t of game.characters) {
      const d = t.pos.distanceTo(center);
      if (d > r) continue;
      const k = 1 - (d / r) * 0.6;
      const dir = new THREE.Vector3(t.pos.x - center.x, 0, t.pos.z - center.z);
      if (dir.lengthSq() < 0.01) a.forward(dir);
      dir.normalize();
      if (t === a) {
        // Rocket jump: you fly, but you don't get hurt or stunned by your own rocket.
        if (!t.remote) t.knock(dir, w.force * 0.6 * k, w.up * k, 0, null);
        continue;
      }
      this.hit(a, t, w, dir, k);
    }
  }

  /** `scale` weakens the whole hit (the edge of a blast); `pellets` multiplies the damage only. */
  private hit(a: Character, t: Character, w: WeaponDef, dir: THREE.Vector3, scale = 1, pellets = 1): void {
    const game = this.game;
    const force = w.force * scale;
    const up = w.up * scale;
    const damage = w.damage * scale * pellets;
    const root = w.freeze ?? 0;
    if (t.remote) {
      // Someone else simulates them: send the hit and just show it here.
      game.net.send({ t: 'hit', target: t.netId, by: a.netId, dir: [dir.x, dir.z], force, up, stun: w.stun, dmg: damage, root });
      game.fx.burst(t.pos, root ? 0x9ff3ff : 0x9a8b78, 10, 5);
      if (a.isPlayer) {
        game.fx.addShake(0.25);
        game.sfx.hit(0.7);
      }
      return;
    }
    this.applyHit(t, a, dir, force, up, w.stun, damage, root);
  }

  /** Apply a hit to a fighter we simulate (local, or arriving over the network). */
  applyHit(t: Character, a: Character | null, dir: THREE.Vector3, force: number, up: number, stun: number, damage: number, root = 0): void {
    const game = this.game;
    const ko = t.damage(damage);
    if (ko) {
      force *= 1.3;
      stun = Math.max(stun, 2.5);
      // Getting knocked out costs you your pickups.
      t.setWeapon('blaster');
      t.setWeapon('fists');
      game.hud.feed(`${a?.name ?? 'Someone'} KO'd ${t.name}`);
      if (t.isPlayer) game.hud.popup('KNOCKED OUT!', '#ff5050');
      else if (a?.isPlayer) game.hud.popup(`KO! ${t.name}`, '#ffd23f');
    }
    t.knock(dir.clone().normalize(), force, up, stun, a);
    if (root > 0 && !ko) {
      t.rootT = Math.max(t.rootT, root);
      t.frozenT = root;
      if (t.isPlayer) game.hud.popup('FROZEN!', '#9ff3ff');
    }
    game.fx.burst(t.pos, ko ? 0xffd23f : root ? 0x9ff3ff : 0x9a8b78, ko ? 20 : 10, ko ? 8 : 5);
    if (t.isPlayer) game.input.pad.rumble(ko ? 1 : 0.55, ko ? 0.8 : 0.4, ko ? 450 : 160);
    if (a?.isPlayer || t.isPlayer) {
      game.fx.addShake(t.isPlayer ? 0.5 : 0.25);
      game.sfx.hit(t.isPlayer ? 1 : 0.7);
    } else if (t.pos.distanceTo(game.player.pos) < 25) {
      game.sfx.hit(0.3);
    }
  }
}
