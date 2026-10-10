import * as THREE from 'three';
import { CONFIG, floorOf } from './config';
import { LOOT_WEAPONS, POWER_WEAPONS, WEAPONS, type WeaponKind } from './combat';
import { toon } from './toon';
import { TRAP_KINDS, TRAP_NAMES, type TrapKind } from './traps';
import type { Character } from './character';
import type { Game } from './game';

export interface Crate {
  id: number;
  group: THREE.Group;
  chute: THREE.Object3D;
  beam: THREE.Mesh;
  target: THREE.Vector3;
  y: number;
  landed: boolean;
  expireAt: number;
  /** A weapon rack (fixed spot, refills) rather than a supply drop. */
  rack: boolean;
  /** Index of its spot (racks: into rackSpots; drops: into crateSpots). */
  spot: number;
  /** Online: we've asked the server for it. */
  claimed?: boolean;
}

const FALL_SPEED = 4;
/** Seconds before an emptied rack refills. */
export const RACK_REFILL = 25;

/**
 * Pickups: weapon racks by the stairs on every floor (refill after a while; the ones in
 * the lobby hold the big guns everyone races for) and supply drops that parachute in.
 * First to touch one gets a weapon + a trap.
 */
export class Airdrops {
  readonly crates: Crate[] = [];
  private nextAt: number = CONFIG.AIRDROP_FIRST;
  private nextId = 1;
  private readonly refills: { spot: number; at: number }[] = [];

  constructor(private readonly game: Game) {}

  /** Take every crate off the map (map change). */
  clearAll(): void {
    for (const c of [...this.crates]) this.remove(c);
    this.refills.length = 0;
  }

  reset(): void {
    for (const c of [...this.crates]) this.remove(c);
    this.refills.length = 0;
    this.nextAt = CONFIG.AIRDROP_FIRST;
    // Online, the server places the racks.
    if (this.game.mode !== 'online') this.game.tower.rackSpots.forEach((_, i) => this.spawnRack(i));
  }

  update(dt: number): void {
    const game = this.game;
    const online = game.mode === 'online';
    // Online, the server decides when and where crates drop and when racks refill.
    if (!online) {
      if (game.time >= this.nextAt) {
        this.nextAt = game.time + CONFIG.AIRDROP_INTERVAL;
        if (this.crates.filter((c) => !c.rack).length < CONFIG.AIRDROP_MAX) this.spawn();
      }
      for (let i = this.refills.length - 1; i >= 0; i--) {
        if (game.time < this.refills[i].at) continue;
        this.spawnRack(this.refills[i].spot);
        this.refills.splice(i, 1);
      }
    }
    for (const crate of [...this.crates]) {
      if (!crate.landed) {
        crate.y -= FALL_SPEED * dt;
        if (crate.y <= crate.target.y) {
          crate.y = crate.target.y;
          crate.landed = true;
          crate.chute.visible = false;
          crate.expireAt = game.time + 45;
          if (crate.target.distanceTo(game.player.pos) < 25) game.sfx.thud(0.5);
        }
        crate.group.position.set(crate.target.x, crate.y + 0.5, crate.target.z);
        crate.group.rotation.z = Math.sin(game.time * 1.7 + crate.id) * 0.12;
        continue;
      }
      crate.group.rotation.set(0, crate.group.rotation.y + dt * 0.8, 0);
      if (!online && !crate.rack && game.time > crate.expireAt) {
        this.remove(crate);
        continue;
      }
      for (const c of game.characters) {
        if (c.stun > 0 || c.remote) continue;
        if (Math.hypot(c.pos.x - crate.target.x, c.pos.z - crate.target.z) > 1.3) continue;
        if (Math.abs(c.feetY - crate.target.y) > 1.2) continue;
        if (online) {
          if (!crate.claimed) game.net.send({ t: 'take', crate: crate.id, who: c.netId });
          crate.claimed = true;
        } else {
          this.give(c, crate.rack ? this.rackLoot(crate.spot) : undefined);
          if (crate.rack) this.refills.push({ spot: crate.spot, at: game.time + RACK_REFILL });
          this.remove(crate);
        }
        break;
      }
    }
  }

  /** Lobby racks hold the power weapons (the start-line rush); the rest anything. */
  private rackLoot(spot: number): WeaponKind {
    const pool = this.game.tower.rackSpots[spot]?.y < 1 ? POWER_WEAPONS : LOOT_WEAPONS;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Online: the server put crate `id` at `spot` (a weapon rack if `rack`). */
  spawnAt(id: number, spot: number, rack = false): void {
    if (this.crates.some((c) => c.id === id)) return;
    if (rack) {
      this.spawnRack(spot, id);
      return;
    }
    const spots = this.game.tower.crateSpots;
    this.spawn(spots[((spot % spots.length) + spots.length) % spots.length], id, spot);
  }

  /** Online: crate `id` went to `who` with this loot. */
  taken(id: number, who: Character | null, weapon: string, trap: string): void {
    const crate = this.crates.find((c) => c.id === id);
    if (crate) this.remove(crate);
    if (who && !who.remote) this.give(who, weapon as WeaponKind, trap as TrapKind);
    else if (who) this.game.hud.feed(`${who.name} grabbed a ${WEAPONS[weapon as WeaponKind]?.name ?? 'supply drop'}`);
  }

  private makeCrate(color: number): { group: THREE.Group; chute: THREE.Group } {
    const group = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), toon(color));
    box.castShadow = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)), new THREE.LineBasicMaterial({ color: 0x1d2a44 }));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.2, 1.04), toon(0xffd23f, { emissive: 0x443300 }));
    group.add(box, edges, stripe);
    const chute = new THREE.Group();
    group.add(chute);
    return { group, chute };
  }

  private beamAt(target: THREE.Vector3, color: number, height: number): THREE.Mesh {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.9, height, 16, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.set(target.x, target.y + height / 2, target.z);
    return beam;
  }

  /** A weapon rack: already there, no fanfare. */
  private spawnRack(spot: number, fixedId?: number): void {
    const target = this.game.tower.rackSpots[spot];
    if (!target) return;
    const { group, chute } = this.makeCrate(0xff8a3d);
    group.position.set(target.x, target.y + 0.5, target.z);
    const beam = this.beamAt(target, 0xff9a4d, 2.6);
    this.game.scene.add(group, beam);
    this.crates.push({ id: fixedId ?? this.nextId++, group, chute, beam, target, y: target.y, landed: true, expireAt: Infinity, rack: true, spot });
  }

  private spawn(fixedTarget?: THREE.Vector3, fixedId?: number, spotIndex = -1): void {
    const game = this.game;
    const taken = new Set(this.crates.map((c) => c.target));
    const options = game.tower.crateSpots.filter((b) => !taken.has(b));
    if (!fixedTarget && !options.length) return;
    const target = fixedTarget ?? options[Math.floor(Math.random() * options.length)];

    const { group, chute } = this.makeCrate(0x58c4ff);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), toon(0xff6a3d, { double: true }));
    canopy.position.y = 2.6;
    canopy.scale.y = 0.6;
    const pts: THREE.Vector3[] = [];
    for (const [x, z] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      pts.push(new THREE.Vector3(x * 0.45, 0.5, z * 0.45), new THREE.Vector3(x * 1.1, 2.6, z * 1.1));
    }
    chute.add(canopy, new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff })));
    const beam = this.beamAt(target, 0xffe066, 5.4);

    const startY = target.y + 4.6;
    group.position.set(target.x, startY + 0.5, target.z);
    game.scene.add(group, beam);
    this.crates.push({ id: fixedId ?? this.nextId++, group, chute, beam, target, y: startY, landed: false, expireAt: Infinity, rack: false, spot: spotIndex });
    game.hud.feed(`Supply drop on floor ${floorOf(target.y)}!`);
    game.hud.popup('SUPPLY DROP', '#ffe066', true);
  }

  private give(c: Character, fixedWeapon?: WeaponKind, fixedTrap?: TrapKind): void {
    const game = this.game;
    const weapon = fixedWeapon ?? LOOT_WEAPONS[Math.floor(Math.random() * LOOT_WEAPONS.length)];
    const trap = fixedTrap ?? TRAP_KINDS[Math.floor(Math.random() * TRAP_KINDS.length)];
    c.setWeapon(weapon);
    c.traps[trap]++;
    game.hud.feed(`${c.name} grabbed a ${WEAPONS[weapon].name}`);
    if (c.isPlayer) {
      game.hud.popup(`${WEAPONS[weapon].name.toUpperCase()} + ${TRAP_NAMES[trap].toUpperCase()}`, '#ffe066');
      game.sfx.pickup();
    }
  }

  private remove(crate: Crate): void {
    this.game.scene.remove(crate.group, crate.beam);
    const i = this.crates.indexOf(crate);
    if (i >= 0) this.crates.splice(i, 1);
  }
}
