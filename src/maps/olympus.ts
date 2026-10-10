import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Arena, FH, LEVELS, type Ambience, type MapId, type Waypoint } from '../arena';
import { BoulderLane, LaserGate, Sweeper, WindZone, hash01 } from '../hazards';
import { OUTLINE, toon } from '../toon';
import type { Game } from '../game';

/**
 * Mount Olympus: a stepped mountain on an island, with a paved road spiralling up it.
 * Three tiers, four sides each; every side climbs one level (6 m). The road's outer edge is a
 * cliff — get knocked off and you land on the switchback below (or the beach). The temple
 * on top holds the flag.
 */

/** Tier L: the mountain core is |x|,|z| ≤ C, the road runs between C (cliff face) and O (drop). */
const TIERS = [
  { C: 30, O: 38 },
  { C: 22, O: 30 },
  { C: 14, O: 22 },
];
const ROAD = 8; // road width
const LANE = 4; // where bots walk (metres out from the cliff face)

const NAMES = [
  'Foothills',
  'Olive Grove',
  'Shepherd’s Path',
  'Marble Quarry',
  'Temple of Hermes',
  'Broken Steps',
  'Winds of Aeolus',
  'Forge of Hephaestus',
  'Medusa’s Garden',
  'Rockfall Ridge',
  'Gates of Olympus',
  'Hall of the Gods',
];

const ROCK = 0xa8977c;
const MARBLE = 0xf1ece0;
const MARBLE_EDGE = 0xd9cfb8;
const PAVING = 0xe3d6b8;
const GRASS = 0x7cb35a;
const BRONZE = 0xd9a441;
const LIGHTNING = 0xffd84a;

/** Surfaces: cliffs with strata (grassy where they're flat on top), cobbled road, veined marble. */
const rock = () => toon(ROCK, { pattern: 'rock', accent: 0x8cbf5e });
/** Loose rocks: the same stone with only a little moss on top. */
const looseRock = () => toon(ROCK, { pattern: 'rock', accent: 0xa09a76 });
const road = () => toon(PAVING, { pattern: 'cobble', scale: 0.9 });
const marble = (c = MARBLE) => toon(c, { pattern: 'marble' });

interface Side {
  k: number;
  L: number;
  /** 0 west (+z), 1 north (+x), 2 east (-z), 3 south (-x). */
  i: number;
  C: number;
  O: number;
  /** Height at the start of the side's ramp, and the tier's base. */
  h0: number;
  base: number;
  along: THREE.Vector3;
  out: THREE.Vector3;
}

export class Olympus extends Arena {
  readonly id: MapId = 'olympus';
  readonly name = 'Mount Olympus';
  readonly floorNames = [...NAMES, 'The Summit'];
  readonly ambience: Ambience = {
    skyTop: 0x3a7fe0,
    skyMid: 0x9ad8ff,
    skyBottom: 0xfff3d6,
    fog: 0xd8ecff,
    hemiSky: 0xf0f6ff,
    hemiGround: 0xc8b48a,
    hemiIntensity: 1.9,
    sun: 0xfff2d8,
    sunIntensity: 2.4,
    city: false,
    sea: true,
  };

  constructor(game: Game) {
    super(game);
    this.spawnYaw = 0;
    this.beginBuild();
    this.buildIsland();
    for (let L = 0; L < 3; L++) this.buildCore(L);
    for (let L = 0; L < 3; L++) this.cornerRocks(L);
    this.baseLoop();
    for (let k = 0; k < LEVELS; k++) this.trackLevel(k, () => this.buildSide(this.side(k)));
    this.trackLevel(LEVELS, () => this.buildSummit());
    this.endBuild();
  }

  // ------------------------------------------------------------------ geometry

  private side(k: number): Side {
    const L = Math.floor(k / 4);
    const i = k % 4;
    const { C, O } = TIERS[L];
    const along = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)][i];
    const out = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)][i];
    return { k, L, i, C, O, h0: k * FH, base: L * 4 * FH, along, out };
  }

  /** Point on side s: t from the start (0) to the end (1) of its ramp, v metres out from the cliff face. */
  private S(s: Side, t: number, v: number, dy = 0): THREE.Vector3 {
    const start = s.along.clone().multiplyScalar(-s.C).addScaledVector(s.out, s.C + v);
    return start.addScaledVector(s.along, 2 * s.C * t).setY(s.h0 + FH * t + dy);
  }

  /** The flat corner square at the end of side s: [x0, x1, z0, z1] and its centre. */
  private endCorner(s: Side): { r: [number, number, number, number]; c: THREE.Vector3 } {
    const sx = [-1, 1, 1, -1][s.i];
    const sz = [1, 1, -1, -1][s.i];
    const r: [number, number, number, number] = [sx * s.C, sx * s.O, sz * s.C, sz * s.O];
    return { r, c: new THREE.Vector3((sx * (s.C + s.O)) / 2, s.h0 + FH, (sz * (s.C + s.O)) / 2) };
  }

  // ------------------------------------------------------------------ build

  private buildIsland(): void {
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 1, 400).setTranslation(0, -1, 0));
    // Beach and meadow around the mountain's foot.
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(78, 84, 1.2, 64), toon(0xf0dfb0, { pattern: 'sand' }));
    sand.position.y = -0.62;
    sand.receiveShadow = true;
    const meadow = new THREE.Mesh(new THREE.CylinderGeometry(58, 62, 0.4, 64), toon(GRASS, { pattern: 'grass', accent: 0xfff2a8 }));
    meadow.position.y = -0.18;
    meadow.receiveShadow = true;
    // Wet sand and surf where the beach meets the sea.
    const wet = new THREE.Mesh(new THREE.RingGeometry(82.6, 86.5, 96).rotateX(-Math.PI / 2), toon(0xc9b48a, { pattern: 'sand' }));
    wet.position.y = -0.97;
    const surf = new THREE.Mesh(new THREE.RingGeometry(85.6, 87.4, 96).rotateX(-Math.PI / 2), toon(0xffffff, { opacity: 0.75 }));
    surf.position.y = -0.94;
    this.scene.add(sand, meadow, wet, surf);
    // Start plaza at the foot of the road (south-west): marble slabs with a kerb.
    this.deco(-48, -30, -0.02, 0.03, -48, -30, marble(), { cast: false, outline: false });
    for (const [x0, x1, z0, z1] of [
      [-48.4, -48, -48.4, -29.6],
      [-48.4, -29.6, -48.4, -48],
    ])
      this.deco(x0, x1, -0.02, 0.18, z0, z1, marble(MARBLE_EDGE), { cast: false, outline: false });
    for (let i = 0; i < 24; i++) this.spawnPoints.push(new THREE.Vector3(-46 + (i % 6) * 2.5, 0, -46 + Math.floor(i / 6) * 3));
    this.dressIsland();
  }

  /**
   * Olive trees and cypresses round the mountain's foot, boulders on the beach. Kept clear of the
   * start plaza and of the paths round the meadow (|x| or |z| ≈ 44) that lead back to it.
   */
  private dressIsland(): void {
    const clear = (x: number, z: number) => {
      if (x < -26 && z < -26) return false; // the plaza
      if (Math.abs(Math.abs(x) - 44) < 3.5 && Math.abs(z) < 47.5) return false;
      if (Math.abs(Math.abs(z) - 44) < 3.5 && Math.abs(x) < 47.5) return false;
      return Math.max(Math.abs(x), Math.abs(z)) > 40.5;
    };
    let placed = 0;
    for (let i = 0; i < 140 && placed < 34; i++) {
      const a = hash01(i, 71) * Math.PI * 2;
      const r = 42 + hash01(i, 72) * 18;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!clear(x, z)) continue;
      placed++;
      if (hash01(i, 73) < 0.6) this.olive(new THREE.Vector3(x, 0, z), hash01(i, 74));
      else this.cypress(new THREE.Vector3(x, 0, z), hash01(i, 74));
    }
    for (let i = 0; i < 26; i++) {
      const a = hash01(i, 81) * Math.PI * 2;
      const r = 66 + hash01(i, 82) * 12;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (x < -20 && z < -20 && r < 72) continue;
      this.boulder(new THREE.Vector3(x, -0.4, z), 0.9 + hash01(i, 83) * 1.8, i);
    }
  }

  private olive(p: THREE.Vector3, h: number): void {
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.2, 0.35).setTranslation(p.x, p.y + 1.2, p.z));
    const trunk = toon(0x7a5f45);
    this.decoGeo(new THREE.CylinderGeometry(0.22, 0.38, 2.2, 7), trunk, p.clone().setY(p.y + 1.1), h * 6, new THREE.Vector3(1, 1, 1), { cast: true });
    const leaves = [toon(0x8aa05a), toon(0x9bb36b), toon(0x7a9450)];
    for (let j = 0; j < 4; j++) {
      const a = h * 9 + j * 1.7;
      const off = new THREE.Vector3(Math.cos(a) * 0.8, 2.6 + (j % 2) * 0.5, Math.sin(a) * 0.8);
      const sc = 1.05 + ((j * 37 + Math.round(h * 100)) % 5) * 0.08;
      this.decoGeo(new THREE.IcosahedronGeometry(1, 1), leaves[j % 3], p.clone().add(off), a, new THREE.Vector3(sc * 1.15, sc * 0.75, sc * 1.15), { cast: true });
    }
  }

  private cypress(p: THREE.Vector3, h: number): void {
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.45).setTranslation(p.x, p.y + 1.5, p.z));
    const tall = 5.5 + h * 2.5;
    this.decoGeo(new THREE.CylinderGeometry(0.12, 0.18, 1, 6), toon(0x6a4e38), p.clone().setY(p.y + 0.5));
    this.decoGeo(new THREE.ConeGeometry(0.95, tall, 9), toon(0x4f7d45), p.clone().setY(p.y + 0.6 + tall / 2), h * 4, new THREE.Vector3(1, 1, 1), { cast: true });
    this.decoGeo(new THREE.ConeGeometry(0.75, tall * 0.6, 9), toon(0x5d8f4f), p.clone().setY(p.y + 1.6 + tall * 0.45), h * 4 + 1, new THREE.Vector3(1, 1, 1), { cast: true });
  }

  /** A faceted rock: solid if it's somewhere people can walk. */
  private boulder(p: THREE.Vector3, size: number, seed: number, solid = true): void {
    const sc = new THREE.Vector3(size * (1 + hash01(seed, 91) * 0.5), size * (0.6 + hash01(seed, 92) * 0.4), size * (1 + hash01(seed, 93) * 0.5));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(hash01(seed, 94) * 0.6, hash01(seed, 95) * 6.3, hash01(seed, 96) * 0.6));
    this.batch.add(new THREE.IcosahedronGeometry(1, 0), looseRock(), new THREE.Matrix4().compose(p, q, sc), { outline: false });
    if (solid) this.world.createCollider(RAPIER.ColliderDesc.ball(Math.min(sc.x, sc.y, sc.z) * 0.95).setTranslation(p.x, p.y, p.z));
  }

  /**
   * Rock bulging out of a cliff face above head height (never into the road's headroom), so the
   * mountain stops looking like stacked boxes.
   */
  private outcrops(s: Side): void {
    const top = s.base + 4 * FH;
    for (let j = 0; j < 9; j++) {
      const t = (j + 0.5) / 9 + (hash01(s.k * 31 + j, 101) - 0.5) * 0.06;
      const roadY = s.h0 + FH * t;
      const size = 1.1 + hash01(s.k * 31 + j, 103) * 1.4;
      // Its underside stays at least 4 m above the road.
      const lo = roadY + 4.2 + size;
      if (lo > top - 1) continue;
      const y = lo + hash01(s.k * 31 + j, 102) * (top - 1 - lo);
      const p = this.S(s, t, -size * 0.8, 0).setY(y);
      this.boulder(p, size, s.k * 31 + j, false);
    }
  }

  /**
   * Start of the route: the plaza. Knocked off the lowest road, you land on the meadow round the
   * mountain's foot: these extra ways (never picked at the start) walk you back round to it.
   */
  private baseLoop(): void {
    const g = (x: number, z: number, radius = 2.2) => ({ pos: new THREE.Vector3(x, 0, z), radius });
    const plaza = g(-34, -34);
    this.route.push({
      floor: 0,
      alts: [[plaza], [g(44, 44), g(-44, 44), g(-44, -44), plaza], [g(44, -44), g(-44, -44), plaza], [g(-44, 0), g(-44, -44), plaza]],
      weights: [1, 0, 0, 0],
    });
  }

  /** The mountain mass of tier L: cliffs from its base up to where the next tier's road starts. */
  private buildCore(L: number): void {
    const { C } = TIERS[L];
    const y0 = L * 4 * FH;
    const y1 = (L + 1) * 4 * FH;
    this.solid(-C, C, y0, y1, -C, C, rock(), { cast: false, outline: false });
    if (L === 2) this.deco(-C, C, y1, y1 + 0.05, -C, C, marble(), { cast: false, outline: false });
    // The mountain's foot: rocks heaped against the bottom of the lowest cliffs.
    if (L === 0) {
      for (let i = 0; i < 40; i++) {
        const side = i % 4;
        const t = (Math.floor(i / 4) + 0.5) / 10;
        const along = -38 + 76 * t;
        const size = 0.9 + hash01(i, 111) * 0.9;
        const out = 38 + size * 0.2;
        const x = [along, out, -along, -out][side];
        const z = [out, -along, -out, along][side];
        if (x < -26 && z < -26) continue;
        this.boulder(new THREE.Vector3(x, size * 0.3, z), size, 500 + i);
      }
    }
  }

  /** One side of the road: ramp, fill, corner, hazards, pickups and its stretch of the route. */
  private buildSide(s: Side): void {
    const k = s.k;
    const gaps = k === 5 ? [0.35, 0.65] : k === 10 ? [0.5] : [];
    this.ramp(s, gaps);
    const corner = this.endCorner(s);
    // The last side of a tier doesn't get a corner: that square is where the tier began, lower
    // down. The road turns uphill onto the next tier just before it.
    const lastOfTier = s.i === 3;
    if (!lastOfTier) {
      this.solid(Math.min(corner.r[0], corner.r[1]), Math.max(corner.r[0], corner.r[1]), s.base, s.h0 + FH, Math.min(corner.r[2], corner.r[3]), Math.max(corner.r[2], corner.r[3]), rock(), { walkable: true, cast: false, outline: false });
      this.deco(Math.min(corner.r[0], corner.r[1]), Math.max(corner.r[0], corner.r[1]), s.h0 + FH, s.h0 + FH + 0.04, Math.min(corner.r[2], corner.r[3]), Math.max(corner.r[2], corner.r[3]), marble(), { cast: false, outline: false });
    }

    // Pickups.
    this.rackSpots.push(this.S(s, 0.35, 1.6), this.S(s, 0.35, ROAD - 1.6));
    [0.15, 0.55, 0.75, 0.9].forEach((t, j) => this.crateSpots.push(this.S(s, t, j % 2 ? 6 : 2)));

    // Route: up the middle of the road, jumping the trenches.
    const lead: Waypoint[] = [];
    const wps: Waypoint[] = [];
    const w = (t: number, extra: Partial<Waypoint> = {}, v = LANE) => wps.push({ pos: this.S(s, t, v), radius: 1.6, ...extra });
    if (s.i === 0 && k > 0) {
      // New tier: up off the end of the last road onto this tier's first corner.
      const st = s.C + ROAD / 2;
      lead.push({ pos: new THREE.Vector3(-st, s.h0, -st), radius: 1.8 });
    }
    const pts = lastOfTier ? [0.04, 0.2, 0.36, 0.52, 0.68, 0.84, 0.93] : [0.04, 0.2, 0.36, 0.52, 0.68, 0.84, 0.97];
    for (const t of pts) {
      const gap = gaps.find((g) => t > g - 0.1 && t < g + 0.1);
      if (gap !== undefined) continue;
      w(t);
    }
    for (const g of gaps) {
      // Run up to the lip, then jump to the far side.
      const half = 1.4 / (2 * s.C);
      w(g - half - 0.04, { radius: 0.9 });
      w(g + half + 0.06, { jump: true, radius: 1.2 });
    }
    wps.sort((a, b) => a.pos.distanceTo(this.S(s, 0, LANE)) - b.pos.distanceTo(this.S(s, 0, LANE)));
    if (!lastOfTier) wps.push({ pos: corner.c.clone(), radius: 1.8 });
    this.route.push({ floor: k, alts: [[...lead, ...wps]], weights: [1] });

    this.hazards(s);
    this.outcrops(s);
    this.fringe(s, gaps);
  }

  /** Bushes tucked under the road's outer edge: a green lip instead of a hard line. */
  private fringe(s: Side, gaps: number[]): void {
    const greens = [toon(0x6f9e4c), toon(0x82b058), toon(0x5d8a42)];
    for (let j = 0; j < 22; j++) {
      const t = (j + 0.5) / 22;
      if (gaps.some((g) => Math.abs(t - g) < 0.06)) continue;
      const seed = s.k * 53 + j;
      const size = 0.45 + hash01(seed, 121) * 0.35;
      // Mostly inside the rock under the road edge: only a tuft pokes out.
      const p = this.S(s, t, ROAD - size * 0.2, -0.45 - size * 0.5);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(seed, 122) * 6.3);
      this.batch.add(new THREE.IcosahedronGeometry(1, 1), greens[j % 3], new THREE.Matrix4().compose(p, q, new THREE.Vector3(size * 1.1, size * 0.7, size * 1.1)), { outline: false });
    }
  }

  /**
   * Rock piled up the mountain's vertical corners above the corner landings, so the tiers
   * stop looking like boxes. Kept below the next tier's road and away from the landings' headroom.
   */
  private cornerRocks(L: number): void {
    const { C } = TIERS[L];
    const base = L * 4 * FH;
    const top = base + 4 * FH;
    const corners: [number, number, number][] = [
      [-1, 1, base + FH],
      [1, 1, base + 2 * FH],
      [1, -1, base + 3 * FH],
      [-1, -1, base],
    ];
    corners.forEach(([sx, sz, floor], ci) => {
      for (let j = 0; j < 7; j++) {
        const seed = L * 101 + ci * 13 + j;
        const size = 1.4 + hash01(seed, 131) * 1.4;
        const y = floor + 5 + size + j * 2.6 + hash01(seed, 132) * 1.2;
        if (y > top - size * 0.8) break;
        const off = size * 0.35;
        this.boulder(new THREE.Vector3(sx * (C + off), y, sz * (C + off)), size, seed, false);
      }
    });
  }

  /** The paved ramp (in pieces around jump trenches) with solid rock filled in underneath. */
  private ramp(s: Side, gaps: number[]): void {
    const len = 2 * s.C;
    const gapLen = 2.8;
    const cuts: [number, number][] = [];
    let a = 0;
    for (const g of [...gaps].sort()) {
      const half = gapLen / 2 / len;
      cuts.push([a, g - half]);
      a = g + half;
    }
    cuts.push([a, 1]);
    const slope = Math.atan2(FH, len);
    for (const [t0, t1] of cuts) {
      const segLen = (t1 - t0) * len;
      const hyp = segLen / Math.cos(slope);
      const mid = this.S(s, (t0 + t1) / 2, ROAD / 2, -0.2 * Math.cos(slope));
      const d = s.along.clone().multiplyScalar(Math.cos(slope)).setY(Math.sin(slope)).normalize();
      const lat = s.out.clone();
      const n = d.clone().cross(lat).normalize();
      if (n.y < 0) n.negate();
      const z = d.clone().cross(n).normalize();
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(d, n, z));
      this.solidRot(mid, new THREE.Vector3(hyp / 2, 0.2, ROAD / 2), q, road(), { walkable: true, cast: false, outline: false });
      // Kerbs on both edges, so the road reads against the cliff and the drop.
      for (const v of [0.15, ROAD - 0.15]) this.batch.box(this.S(s, (t0 + t1) / 2, v, 0.05), new THREE.Vector3(hyp / 2, 0.08, 0.15), q, marble(MARBLE_EDGE), { cast: false, outline: false });
    }
    // Rock under the ramp in steps (stops anyone walking about underneath it).
    const N = 10;
    for (let j = 0; j < N; j++) {
      const t0 = j / N;
      const t1 = (j + 1) / N;
      const inGap = gaps.some((g) => {
        const half = gapLen / 2 / len;
        return t1 > g - half && t0 < g + half;
      });
      const top = s.h0 + FH * t0 - 0.3 - (inGap ? FH : 0);
      if (top <= s.base + 0.05) continue;
      const p0 = this.S(s, t0, 0);
      const p1 = this.S(s, t1, ROAD);
      this.solid(Math.min(p0.x, p1.x), Math.max(p0.x, p1.x), s.base, top, Math.min(p0.z, p1.z), Math.max(p0.z, p1.z), rock(), { cast: false, outline: false });
    }
  }

  // ------------------------------------------------------------------ hazards

  private ph(s: Side, i: number): number {
    return hash01(s.k * 17 + i, 5);
  }

  /** A boulder tumbling out of the cliff face, across the road and over the edge. */
  private rockfall(s: Side, t: number, period: number, speed = 7.5): void {
    const from = this.S(s, t, 0.9);
    const to = this.S(s, t, ROAD + 0.6);
    from.y = to.y = s.h0 + FH * t;
    this.boulders.push(new BoulderLane(this.scene, from, to, 1.15, period, this.ph(s, Math.round(t * 100)), speed));
    // A dark cave mouth where it comes from.
    const c = this.S(s, t, -0.05, 1.3);
    const half = s.along.x !== 0 ? new THREE.Vector3(1.5, 1.3, 0.08) : new THREE.Vector3(0.08, 1.3, 1.5);
    this.deco(c.x - half.x, c.x + half.x, c.y - half.y, c.y + half.y, c.z - half.z, c.z + half.z, toon(0x2a221c), { cast: false, outline: false });
    const seed = s.k * 97 + Math.round(t * 100);
    this.boulder(this.S(s, t, -0.5, 2.85), 0.9, seed, false);
    this.boulder(this.S(s, t - 1.9 / (2 * s.C), -0.45, 1.6), 0.75, seed + 1, false);
    this.boulder(this.S(s, t + 1.9 / (2 * s.C), -0.45, 1.6), 0.75, seed + 2, false);
  }

  /** A stone block that slides out of the cliff face and shoves you toward the drop. */
  private shover(s: Side, t: number, phase: number, reach = 4.5): void {
    this.addPusher(this.S(s, t, 0.6), s.out, reach, 2.4, 3.4, phase);
  }

  /** A bronze double axe swinging across the road from a marble arch. */
  private axe(s: Side, t: number, speed = 1.8): void {
    for (const v of [0.35, ROAD - 0.35]) this.column(this.S(s, t, v), 6.3, 0.35);
    const top = this.S(s, t, ROAD / 2, 6.3);
    const half = s.along.x !== 0 ? new THREE.Vector3(0.45, 0.32, ROAD / 2 + 0.4) : new THREE.Vector3(ROAD / 2 + 0.4, 0.32, 0.45);
    this.deco(top.x - half.x, top.x + half.x, top.y, top.y + 2 * half.y, top.z - half.z, top.z + half.z, marble(), { cast: false });
    this.deco(top.x - half.x * 1.08, top.x + half.x * 1.08, top.y + 2 * half.y, top.y + 2 * half.y + 0.16, top.z - half.z * 1.08, top.z + half.z * 1.08, toon(BRONZE), { cast: false, outline: false });
    this.addPendulum(this.S(s, t, ROAD / 2), s.out, this.ph(s, Math.round(t * 50)) * 6, speed, 6.3, 'axe');
  }

  /** Zeus' lightning: a gate across the road that crackles on and off. */
  private lightning(s: Side, t: number, period = 3.2): void {
    this.lasers.push(new LaserGate(this.scene, this.S(s, t, 0.3), this.S(s, t, ROAD - 0.3), period, this.ph(s, Math.round(t * 70)), 0.45, this.batch, LIGHTNING));
  }

  /** A spinning hammer on a post at the cliff edge, sweeping across the road. */
  private hammer(s: Side, t: number, speed: number): void {
    this.addSweeper(this.S(s, t, ROAD - 0.6), 5.4, speed);
  }

  private column(p: THREE.Vector3, h: number, r: number): void {
    const m = new THREE.Matrix4().makeTranslation(p.x, p.y + h / 2, p.z);
    this.batch.add(new THREE.CylinderGeometry(r, r * 1.1, h, 16), marble(), m, { outline: false });
    // Capital and base.
    this.batch.add(new THREE.BoxGeometry(r * 2.6, 0.3, r * 2.6), marble(MARBLE_EDGE), new THREE.Matrix4().makeTranslation(p.x, p.y + h - 0.15, p.z), { outline: false });
    this.batch.add(new THREE.CylinderGeometry(r * 1.25, r * 1.05, 0.25, 16), marble(MARBLE_EDGE), new THREE.Matrix4().makeTranslation(p.x, p.y + h - 0.42, p.z), { outline: false });
    this.batch.add(new THREE.CylinderGeometry(r * 1.3, r * 1.4, 0.3, 16), marble(MARBLE_EDGE), new THREE.Matrix4().makeTranslation(p.x, p.y + 0.15, p.z), { outline: false });
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(p.x, p.y + h / 2, p.z));
  }

  private tree(p: THREE.Vector3): void {
    this.olive(p, hash01(Math.round(p.x * 10), Math.round(p.z * 10)));
  }

  private statue(p: THREE.Vector3): void {
    this.solid(p.x - 0.6, p.x + 0.6, p.y, p.y + 0.7, p.z - 0.6, p.z + 0.6, marble(MARBLE_EDGE));
    // Turned to stone mid-step (Medusa's garden): body, head, a raised arm.
    const stone = toon(0xd8d2c4, { pattern: 'marble' });
    this.decoGeo(new THREE.CapsuleGeometry(0.4, 1.2, 4, 10), stone, p.clone().setY(p.y + 1.6));
    this.decoGeo(new THREE.SphereGeometry(0.32, 12, 10), stone, p.clone().setY(p.y + 2.65));
    this.batch.add(new THREE.CapsuleGeometry(0.11, 0.7, 3, 6), stone, new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(0.42, 2.35, 0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6), new THREE.Vector3(1, 1, 1)), { outline: false });
    this.batch.add(new THREE.CapsuleGeometry(0.11, 0.6, 3, 6), stone, new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(-0.42, 1.75, 0)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.25), new THREE.Vector3(1, 1, 1)), { outline: false });
  }

  private hazards(s: Side): void {
    const k = s.k;
    switch (k) {
      case 0: // Foothills
        [0.22, 0.6].forEach((t, i) => this.rockfall(s, t, 4.6 + i * 0.7));
        [0.45, 0.8].forEach((t, i) => this.shover(s, t, this.ph(s, i)));
        break;
      case 1: // Olive Grove
        for (let t = 0.12; t < 0.95; t += 0.12) this.tree(this.S(s, t, (Math.round(t * 100) % 2 ? 1.2 : ROAD - 1.2)));
        [0.3, 0.55, 0.8].forEach((t) => this.axe(s, t));
        this.rockfall(s, 0.68, 5);
        break;
      case 2: // Shepherd's Path
        [0.2, 0.4, 0.6, 0.8].forEach((t, i) => this.rockfall(s, t, 4 + (i % 3) * 0.6, 8));
        this.cornerHammer(s);
        break;
      case 3: // Marble Quarry
        [0.25, 0.5, 0.75].forEach((t, i) => this.shover(s, t, this.ph(s, i + 3)));
        this.lightning(s, 0.62);
        this.solid(...this.boxAt(this.S(s, 0.4, 1.5), 1.2, 1.2), MARBLE_EDGE);
        this.solid(...this.boxAt(this.S(s, 0.86, ROAD - 1.5), 1.2, 1.2), MARBLE_EDGE);
        break;
      case 4: // Temple of Hermes
        [0.2, 0.4, 0.6, 0.8].forEach((t, i) => this.lightning(s, t, 2.8 + (i % 2) * 0.5));
        for (let t = 0.1; t < 0.95; t += 0.1) for (const v of [0.6, ROAD - 0.6]) this.column(this.S(s, t, v), 4.5, 0.4);
        break;
      case 5: // Broken Steps (trenches at 0.35 and 0.65)
        [0.15, 0.85].forEach((t) => this.axe(s, t, 2));
        this.cornerHammer(s);
        break;
      case 6: // Winds of Aeolus
        this.windOver(s, 5);
        [0.3, 0.7].forEach((t, i) => this.rockfall(s, t, 5 + i * 0.6));
        break;
      case 7: // Forge of Hephaestus
        [0.33, 0.66].forEach((t, i) => this.hammer(s, t, i ? -1.6 : 1.6));
        this.shover(s, 0.5, this.ph(s, 7));
        break;
      case 8: // Medusa's Garden
        for (const [t, v] of [
          [0.15, 1.4],
          [0.42, ROAD - 1.4],
          [0.7, 1.4],
          [0.9, ROAD - 1.4],
        ])
          this.statue(this.S(s, t, v));
        [0.28, 0.56, 0.82].forEach((t, i) => this.shover(s, t, this.ph(s, i + 8), 5.5));
        this.lightning(s, 0.5, 2.6);
        break;
      case 9: // Rockfall Ridge
        [0.15, 0.32, 0.5, 0.68, 0.85].forEach((t, i) => this.rockfall(s, t, 3.6 + (i % 3) * 0.5, 9));
        this.cornerHammer(s);
        break;
      case 10: // Gates of Olympus (trench at 0.5)
        [0.2, 0.8].forEach((t) => this.axe(s, t, 2.1));
        [0.35, 0.65].forEach((t) => this.lightning(s, t, 2.6));
        break;
      case 11: // Hall of the Gods
        this.rockfall(s, 0.15, 3.8, 9);
        this.axe(s, 0.3, 2.2);
        this.hammer(s, 0.48, 2);
        this.shover(s, 0.62, this.ph(s, 11), 5.5);
        this.lightning(s, 0.78, 2.4);
        this.windOver(s, 4);
        break;
    }
  }

  private boxAt(p: THREE.Vector3, hx: number, h: number): [number, number, number, number, number, number] {
    return [p.x - hx, p.x + hx, p.y, p.y + h, p.z - hx, p.z + hx];
  }

  /** A spinning hammer at the outer corner where the road turns. */
  private cornerHammer(s: Side): void {
    const sx = [-1, 1, 1, -1][s.i];
    const sz = [1, 1, -1, -1][s.i];
    this.addSweeper(new THREE.Vector3(sx * (s.O - 0.8), s.h0 + FH, sz * (s.O - 0.8)), 5, 1.4);
  }

  private windOver(s: Side, strength: number): void {
    const a = this.S(s, 0.05, 0);
    const b = this.S(s, 0.95, ROAD);
    this.winds.push(new WindZone(this.scene, [a.x, b.x, a.z, b.z], s.h0, s.out.clone().multiplyScalar(strength), 6.5, this.ph(s, 31)));
  }

  // ------------------------------------------------------------------ summit

  private buildSummit(): void {
    const y = LEVELS * FH;
    // Temple: a ring of columns with a way in from the road (south-west), and the golden dais.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const deg = ((a * 180) / Math.PI) % 360;
      if (deg > 200 && deg < 250) continue;
      this.column(new THREE.Vector3(Math.cos(a) * 11, y, Math.sin(a) * 11), 7, 0.55);
    }
    // Entablature: a stone ring on the capitals with a bronze band.
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 0.7, 48, 1, true), toon(MARBLE, { pattern: 'marble', double: true }));
    ring.position.y = y + 7.35;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(10.1, 10.1, 0.7, 48, 1, true), toon(MARBLE_EDGE, { pattern: 'marble', double: true }));
    inner.position.y = y + 7.35;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(12.05, 12.05, 0.14, 48, 1, true), toon(BRONZE, { double: true }));
    band.position.y = y + 7.62;
    const cap = new THREE.Mesh(new THREE.RingGeometry(10.1, 12, 48).rotateX(-Math.PI / 2), toon(MARBLE_EDGE, { double: true }));
    cap.position.y = y + 7.7;
    this.scene.add(ring, inner, band, cap);
    // A round marble floor inside the columns.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(12.6, 64).rotateX(-Math.PI / 2), toon(MARBLE, { pattern: 'marble' }));
    floor.position.y = y + 0.055;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const dais = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 0.4, 48), toon(BRONZE, { emissive: 0x3a2a08 }));
    dais.position.set(0, y - 0.18, 0);
    dais.receiveShadow = true;
    this.scene.add(dais);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(dais.geometry, 30), OUTLINE);
    edge.position.copy(dais.position);
    this.scene.add(edge);
    // Solid flag pole, a spinning bar on the dais, and the guarded way in.
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.6, 0.3).setTranslation(0, y + 1.6, 0));
    this.sweepers.push(new Sweeper(this.scene, new THREE.Vector3(0, y + 0.95, 0), 1.15, 4.1, BRONZE));
    const approach = (d: number) => new THREE.Vector3(-d, y, -d);
    // Two axes hung from the temple ring over the way in, and a lightning gate.
    for (const d of [7.5, 13]) {
      const p = approach(d);
      this.addPendulum(p, new THREE.Vector3(1, 0, -1).normalize(), d / 3, 1.7, 6.8, 'axe');
    }
    this.lasers.push(new LaserGate(this.scene, new THREE.Vector3(-14, y, -9), new THREE.Vector3(-9, y, -14), 3, 0.3, 0.45, this.batch, LIGHTNING));
    const p = (x: number, z: number, radius: number) => ({ pos: new THREE.Vector3(x, y, z), radius });
    // Up off the end of the last road onto the temple top, in through the gap in the columns.
    this.route.push({ floor: LEVELS, alts: [[p(-11, -12.5, 1.2), p(-6, -6, 0.8), p(-0.7, -0.7, 0.6)]], weights: [1] });
  }
}
