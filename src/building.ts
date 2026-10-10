import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Arena, FH, LEVELS, SLAB, inRect, type Ambience, type MapId, type Rect, type Waypoint } from './arena';
import { BoulderLane, FlipFloor, Ghost, LaserGate, Sweeper, Turntable, WindZone, hash01 } from './hazards';
import { OUTLINE, canvasTexture, toon, type ToonOpts } from './toon';
import type { Character } from './character';
import type { Game } from './game';

export type { RouteSeg, Waypoint } from './arena';

type Content =
  | 'lobby'
  | 'office'
  | 'cubicles'
  | 'classroom'
  | 'fans'
  | 'treadmills'
  | 'broken'
  | 'crumbles'
  | 'library'
  | 'lasers'
  | 'lifts'
  | 'beams'
  | 'boulders'
  | 'turntables'
  | 'flipfloor'
  | 'gauntlet';

interface FloorPlan {
  name: string;
  /** Obstacle course in the north and south rooms: two ways up every floor. */
  north: Content;
  south: Content;
  color: number;
  /** Railings along the rooms' atrium edges (none = you can be shoved into the atrium). */
  railing: boolean;
  /** A plank across the atrium: skips the rooms, but there's a spinning bar on it. */
  bridge?: boolean;
  /** Safety net across the atrium just below this floor. */
  net?: boolean;
  /** Floor surface (carpet, boards, tiles...): see `Pattern` in toon.ts. */
  look?: ToonOpts;
}

/** What the surfaces are made of (patterns drawn by the shader, see toon.ts). */
interface Looks {
  ground: ToonOpts;
  wall: ToonOpts;
  roomWall: ToonOpts;
  ceiling: ToonOpts;
  stairs: ToonOpts;
  column: ToonOpts;
  roof: ToonOpts;
}

/**
 * A building-style map: 12 floors around an atrium, two rooms per floor, switchback stairs.
 * Themes change the plan, the look and the extra hazards (wind, a crane, ghosts...).
 */
export interface TowerTheme {
  id: MapId;
  name: string;
  roofName: string;
  plan: FloorPlan[];
  /** Outer walls: glass curtain wall, none at all (open steel frame), or a dark hotel facade. */
  walls: 'glass' | 'open' | 'hotel';
  roomWalls: boolean;
  lamps: 'panels' | 'none' | 'sconces';
  pendulum: 'ball' | 'chandelier';
  boulder: 'rock' | 'pipe' | 'trunk';
  laser: number;
  looks: Looks;
  colors: {
    wall: number;
    trim: number;
    glass: number;
    roomWall: number;
    stairA: number;
    stairB: number;
    landing: number;
    column: number;
    ceiling: number;
    ceilingGlow: number;
    roof: number;
    railGlass: number;
    railTop: number;
    ground: number;
  };
  ambience: Ambience;
  wind?: boolean;
  crane?: boolean;
  ghosts?: boolean;
}

const DAY: Ambience = {
  skyTop: 0x2f86e8,
  skyMid: 0x8fd0ff,
  skyBottom: 0xfff1df,
  fog: 0xdfeaf5,
  hemiSky: 0xeaf4ff,
  hemiGround: 0xc9b8a6,
  hemiIntensity: 1.9,
  sun: 0xfff0dc,
  sunIntensity: 2.2,
  city: true,
  sea: false,
};

export const TOWER: TowerTheme = {
  id: 'tower',
  name: 'The Tower',
  roofName: 'Rooftop',
  plan: [
    { name: 'Lobby', north: 'lobby', south: 'lobby', color: 0xebe5d9, railing: false },
    { name: 'Offices', north: 'office', south: 'cubicles', color: 0x8fa6be, railing: true, look: { pattern: 'carpet', accent: 0x9db0c6, scale: 0.9 } },
    { name: 'Classrooms', north: 'classroom', south: 'treadmills', color: 0xd4a878, railing: true, bridge: true, look: { pattern: 'plank', scale: 1.2 } },
    { name: 'Fan Hall', north: 'fans', south: 'crumbles', color: 0xc5d6bf, railing: false, net: true, look: { pattern: 'tile', scale: 1.2 } },
    { name: 'Broken Floor', north: 'broken', south: 'boulders', color: 0xbcb5aa, railing: true, look: { pattern: 'concrete' } },
    { name: 'Library', north: 'library', south: 'lasers', color: 0x9c6d50, railing: true, bridge: true, look: { pattern: 'plank', scale: 1.1 } },
    { name: 'Cargo Lifts', north: 'lifts', south: 'turntables', color: 0xc8c3ba, railing: false, net: true, look: { pattern: 'concrete' } },
    { name: 'Boulder Run', north: 'boulders', south: 'flipfloor', color: 0xb5aed0, railing: false, look: { pattern: 'stone', scale: 1.2 } },
    { name: 'Laser Labs', north: 'lasers', south: 'fans', color: 0xa9b8cc, railing: true, bridge: true, look: { pattern: 'tile', scale: 0.6 } },
    { name: 'Spin Cycle', north: 'turntables', south: 'beams', color: 0xdcc6c6, railing: false, net: true, look: { pattern: 'tile', scale: 1 } },
    { name: 'Steel Frame', north: 'beams', south: 'lifts', color: 0xb3ada2, railing: false, bridge: true, look: { pattern: 'concrete' } },
    { name: 'The Gauntlet', north: 'gauntlet', south: 'flipfloor', color: 0xc9b8a0, railing: false, look: { pattern: 'tile', scale: 1.5 } },
  ],
  walls: 'glass',
  roomWalls: true,
  lamps: 'panels',
  pendulum: 'ball',
  boulder: 'rock',
  laser: 0xff2a4a,
  looks: {
    ground: { pattern: 'marble' },
    wall: { pattern: 'wainscot', accent: 0xb89a7a },
    roomWall: { pattern: 'wainscot', accent: 0xc29b74 },
    ceiling: { pattern: 'panel' },
    stairs: { pattern: 'marble' },
    column: { pattern: 'marble' },
    roof: { pattern: 'concrete' },
  },
  colors: {
    wall: 0xf3ead8,
    trim: 0x6a7b93,
    glass: 0x9fd8ff,
    roomWall: 0xe9e2d3,
    stairA: 0xf4f1ea,
    stairB: 0xe4ded2,
    landing: 0xd9d2c4,
    column: 0xf7f3ea,
    ceiling: 0xf4f2ee,
    ceilingGlow: 0x6f6c66,
    roof: 0xd6d9de,
    railGlass: 0xbfe6ff,
    railTop: 0xd9dde3,
    ground: 0xebe5d9,
  },
  ambience: DAY,
};

export const CONSTRUCTION: TowerTheme = {
  id: 'construction',
  name: 'Construction Site',
  roofName: 'Crane Deck',
  plan: [
    { name: 'Site Entrance', north: 'lobby', south: 'lobby', color: 0xb9a98c, railing: false },
    { name: 'Rebar Deck', north: 'crumbles', south: 'cubicles', color: 0xa9a49a, railing: false, look: { pattern: 'concrete' } },
    { name: 'Scaffolding', north: 'beams', south: 'broken', color: 0xb3ada2, railing: false, bridge: true, look: { pattern: 'concrete' } },
    { name: 'Cement Works', north: 'treadmills', south: 'fans', color: 0xa39d92, railing: false, net: true, look: { pattern: 'concrete' } },
    { name: 'Pipe Run', north: 'boulders', south: 'lasers', color: 0xaca69b, railing: false, look: { pattern: 'concrete' } },
    { name: 'Hoists', north: 'lifts', south: 'office', color: 0xa9a49a, railing: false, bridge: true, look: { pattern: 'concrete' } },
    { name: 'Girders', north: 'beams', south: 'flipfloor', color: 0xb0aa9f, railing: false, net: true, look: { pattern: 'concrete' } },
    { name: 'Wrecking Crew', north: 'gauntlet', south: 'crumbles', color: 0xa6a094, railing: false, look: { pattern: 'concrete' } },
    { name: 'Drywall Maze', north: 'office', south: 'boulders', color: 0xb5afa4, railing: false, bridge: true, look: { pattern: 'concrete' } },
    { name: 'Windy Frame', north: 'broken', south: 'lifts', color: 0xa9a49a, railing: false, net: true, look: { pattern: 'concrete' } },
    { name: 'Steel Sky', north: 'flipfloor', south: 'beams', color: 0xaea89d, railing: false, bridge: true, look: { pattern: 'concrete' } },
    { name: 'Top Deck', north: 'gauntlet', south: 'turntables', color: 0xa39d92, railing: false, look: { pattern: 'concrete' } },
  ],
  walls: 'open',
  roomWalls: false,
  lamps: 'none',
  pendulum: 'ball',
  boulder: 'pipe',
  laser: 0xff9a2a,
  looks: {
    ground: { pattern: 'concrete' },
    wall: {},
    roomWall: {},
    ceiling: { pattern: 'concrete' },
    stairs: { pattern: 'concrete' },
    column: {},
    roof: { pattern: 'concrete' },
  },
  colors: {
    wall: 0x9aa0a8,
    trim: 0xf2b632,
    glass: 0xff8a3d,
    roomWall: 0xc9c2b4,
    stairA: 0xb8bcc4,
    stairB: 0x9aa0a8,
    landing: 0x8a8f98,
    column: 0xf2b632,
    ceiling: 0x9aa0a8,
    ceilingGlow: 0x2a2a2a,
    roof: 0xa9a49a,
    railGlass: 0xff8a3d,
    railTop: 0xf2b632,
    ground: 0xb9a98c,
  },
  ambience: {
    skyTop: 0x3b7bd6,
    skyMid: 0xffc58a,
    skyBottom: 0xffe3b8,
    fog: 0xf3d9b5,
    hemiSky: 0xfff0d8,
    hemiGround: 0xb8a07e,
    hemiIntensity: 1.8,
    sun: 0xffd9a8,
    sunIntensity: 2.4,
    city: true,
    sea: false,
  },
  wind: true,
  crane: true,
};

export const HOTEL: TowerTheme = {
  id: 'hotel',
  name: 'Haunted Hotel',
  roofName: 'Bell Tower',
  plan: [
    { name: 'Grand Lobby', north: 'lobby', south: 'lobby', color: 0x8a2f3c, railing: false },
    { name: 'Guest Rooms', north: 'office', south: 'cubicles', color: 0x6a4060, railing: true, look: { pattern: 'carpet', accent: 0xb08a5a } },
    { name: 'Dining Hall', north: 'classroom', south: 'treadmills', color: 0x8a5a3a, railing: true, bridge: true, look: { pattern: 'plank', scale: 1 } },
    { name: 'Ballroom', north: 'fans', south: 'turntables', color: 0xa07a52, railing: false, net: true, look: { pattern: 'plank', scale: 0.7 } },
    { name: 'Luggage Hall', north: 'boulders', south: 'library', color: 0x7a3a35, railing: true, look: { pattern: 'carpet', accent: 0xc9a24a } },
    { name: 'Laundry', north: 'treadmills', south: 'lasers', color: 0x8fa0b0, railing: true, bridge: true, look: { pattern: 'tile', scale: 0.5 } },
    { name: 'Elevators', north: 'lifts', south: 'crumbles', color: 0x5a3555, railing: false, net: true, look: { pattern: 'carpet', accent: 0xc9a24a } },
    { name: 'Trapdoor Hall', north: 'flipfloor', south: 'office', color: 0x6a2f45, railing: false, look: { pattern: 'carpet', accent: 0xb8913f } },
    { name: 'Casino', north: 'turntables', south: 'boulders', color: 0x2f6a4a, railing: true, bridge: true, look: { pattern: 'carpet', accent: 0xd9b24a } },
    { name: 'Old Library', north: 'library', south: 'lasers', color: 0x6a4a35, railing: true, net: true, look: { pattern: 'plank', scale: 1.1 } },
    { name: 'Attic', north: 'beams', south: 'broken', color: 0x7a6a5a, railing: false, bridge: true, look: { pattern: 'plank', scale: 1.4 } },
    { name: 'Haunted Wing', north: 'gauntlet', south: 'flipfloor', color: 0x4a3560, railing: false, look: { pattern: 'carpet', accent: 0x9a7ab0 } },
  ],
  walls: 'hotel',
  roomWalls: true,
  lamps: 'sconces',
  pendulum: 'chandelier',
  boulder: 'trunk',
  laser: 0xb04aff,
  looks: {
    ground: { pattern: 'carpet', accent: 0xc9a24a },
    wall: { pattern: 'stone', scale: 0.35 },
    roomWall: { pattern: 'wallpaper', accent: 0x6a3f28 },
    ceiling: { pattern: 'panel', scale: 1.5 },
    stairs: { pattern: 'carpet', accent: 0xc9a24a, scale: 0.6 },
    column: { pattern: 'marble' },
    roof: { pattern: 'tile' },
  },
  colors: {
    wall: 0x8a5048,
    trim: 0xc9a24a,
    glass: 0x2a2a55,
    roomWall: 0x9a5470,
    stairA: 0x9a3442,
    stairB: 0x842c38,
    landing: 0x6e2632,
    column: 0xe9dcc0,
    ceiling: 0x5a4250,
    ceilingGlow: 0x2a1a22,
    roof: 0x5a5462,
    railGlass: 0xc9a24a,
    railTop: 0xc9a24a,
    ground: 0x8a2f3c,
  },
  ambience: {
    skyTop: 0x0d0b26,
    skyMid: 0x2a1f52,
    skyBottom: 0x5a3a6e,
    fog: 0x1d1638,
    hemiSky: 0xb0a8e8,
    hemiGround: 0x5a4060,
    hemiIntensity: 2.2,
    sun: 0xb0c0ff,
    sunIntensity: 1.4,
    city: true,
    sea: false,
  },
  ghosts: true,
};

let books: THREE.CanvasTexture | null = null;
/** Book spines on three shelves, 1.2 m wide, tiling sideways. */
function bookTexture(): THREE.CanvasTexture {
  if (books) return books;
  const colors = ['#c94a4a', '#3f7fc9', '#e3b941', '#4fa060', '#8f5fc9', '#d9774f', '#2f5f8f', '#a33a5a', '#e8e0c8', '#6a8a3a'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  books = canvasTexture(256, 448, (g) => {
    g.fillStyle = '#5a3826';
    g.fillRect(0, 0, 256, 448);
    const rows = [
      [18, 140],
      [162, 284],
      [306, 428],
    ];
    for (const [top, bottom] of rows) {
      g.fillStyle = '#3a2418';
      g.fillRect(0, top, 256, bottom - top);
      let x = 0;
      while (x < 256) {
        const w = 8 + Math.floor(rnd() * 10);
        const h = (bottom - top) * (0.7 + rnd() * 0.28);
        const c = colors[Math.floor(rnd() * colors.length)];
        g.fillStyle = c;
        g.fillRect(x, bottom - h, Math.min(w, 256 - x) - 1, h);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(x + 1, bottom - h + 6, Math.min(w, 256 - x) - 3, 3);
        g.fillRect(x + 1, bottom - 12, Math.min(w, 256 - x) - 3, 2);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x + Math.min(w, 256 - x) - 2, bottom - h, 1, h);
        x += w;
      }
      g.fillStyle = '#7a4e35';
      g.fillRect(0, bottom, 256, 8);
    }
  }, true);
  return books;
}

const IN = 32; // inner wall face (half-size of the walkable floor)
const WALL = 0.6;
const B = IN + WALL / 2; // wall centre line
const A = 9; // atrium half-size
/** Switchback stairs on the far side: flight 1 runs from the wall (|x| = ST_WALL) to ST_MID, flight 2 back. */
const ST_WALL = 28;
const ST_MID = 20;
const ST_Z = 4;
/** Room frame: u along the room from the arrival end (0..L), v from the atrium edge to the outer wall (0..W). */
const L = 2 * IN;
const W = IN - A;
/** Doors at both ends of every room. */
const DOOR = 6;
const ROOF = LEVELS;

/** Arrival side of floor k (+1 east, -1 west). The stairs up are on the other side. */
const arrivalSide = (k: number) => (k % 2 === 1 ? 1 : -1);

interface Room {
  k: number;
  y: number;
  /** +1 north room, -1 south room. */
  s: number;
  sa: number;
  content: Content;
  P: (u: number, v: number, dy?: number) => THREE.Vector3;
  R: (u0: number, u1: number, v0: number, v1: number) => Rect;
  /** World directions of +u (toward the far end) and +v (toward the outer wall). */
  du: THREE.Vector3;
  dv: THREE.Vector3;
  wps: Waypoint[];
}

export class Building extends Arena {
  readonly id: MapId;
  readonly name: string;
  readonly floorNames: string[];
  readonly ambience: Ambience;
  private readonly ceilingMat: THREE.Material | null;

  constructor(game: Game, private readonly theme: TowerTheme = TOWER) {
    super(game);
    this.id = theme.id;
    this.name = theme.name;
    this.floorNames = [...theme.plan.map((p) => p.name), theme.roofName];
    this.ambience = theme.ambience;
    this.ceilingMat = toon(theme.colors.ceiling, { emissive: theme.colors.ceilingGlow, ...theme.looks.ceiling });
    this.beginBuild();
    this.buildShell();
    this.trackLevel(0, () => this.buildLobbyAtrium());
    for (let k = 0; k < ROOF; k++) this.trackLevel(k, () => this.buildFloor(k));
    this.trackLevel(ROOF, () => this.buildRoof());
    this.endBuild();
  }

  // ------------------------------------------------------------------ helpers

  private room(k: number, s: number, content: Content): Room {
    const y = k * FH;
    const sa = arrivalSide(k);
    return {
      k,
      y,
      s,
      sa,
      content,
      P: (u, v, dy = 0) => new THREE.Vector3(sa * (IN - u), y + dy, s * (A + v)),
      R: (u0, u1, v0, v1) => [sa * (IN - u0), sa * (IN - u1), s * (A + v0), s * (A + v1)],
      du: new THREE.Vector3(-sa, 0, 0),
      dv: new THREE.Vector3(0, 0, s),
      wps: [],
    };
  }

  /** Solid box in room coordinates (h0/h1 are heights above the floor). */
  private rbox(r: Room, u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, color: number | THREE.Material, opts: { walkable?: boolean; cast?: boolean; outline?: boolean } = {}) {
    const [x0, x1, z0, z1] = r.R(u0, u1, v0, v1);
    return this.solid(Math.min(x0, x1), Math.max(x0, x1), r.y + h0, r.y + h1, Math.min(z0, z1), Math.max(z0, z1), color, opts);
  }

  private rdeco(r: Room, u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, mat: THREE.Material, opts: { cast?: boolean; outline?: boolean } = {}) {
    const [x0, x1, z0, z1] = r.R(u0, u1, v0, v1);
    this.deco(Math.min(x0, x1), Math.max(x0, x1), r.y + h0, r.y + h1, Math.min(z0, z1), Math.max(z0, z1), mat, opts);
  }

  private w(r: Room, u: number, v: number, extra: Partial<Waypoint> = {}): void {
    r.wps.push({ pos: r.P(u, v), ...extra });
  }

  /** Same-every-client 0..1 value for hazard timing. */
  private ph(r: Room, i: number): number {
    return hash01(r.k * 13 + i, r.s * 7 + 3);
  }

  /** Wrecking ball (or chandelier, in the hotel). */
  private ball(p: THREE.Vector3, axis: THREE.Vector3, phase: number, speed = 1.9): void {
    this.addPendulum(p, axis, phase, speed, FH - SLAB, this.theme.pendulum);
  }

  private wallPusher(r: Room, u: number, reach: number, phase: number, period = 3.2, width = 2.4): void {
    this.addPusher(r.P(u, W - 0.6), r.dv.clone().negate(), reach, width, period, phase);
  }

  private bouldersAcross(r: Room, u: number, period: number, phase: number, speed: number): void {
    this.boulders.push(new BoulderLane(this.scene, r.P(u, W - 1.3), r.P(u, 1.0), 1.1, period, phase, speed, this.theme.boulder));
  }

  private laser(r: Room, u: number, period: number, phase: number, onFrac: number): void {
    this.lasers.push(new LaserGate(this.scene, r.P(u, 0.25), r.P(u, W - 0.25), period, phase, onFrac, this.batch, this.theme.laser));
  }

  // ------------------------------------------------------------------ build

  /** Exterior walls (or an open frame), atrium columns, ground, spawn. */
  private buildShell(): void {
    const t = this.theme;
    const H = ROOF * FH;
    // Ground plane under the building (lobby floor) — the city module draws the streets.
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 1, 400).setTranslation(0, -1, 0));
    this.deco(-IN, IN, -0.2, 0, -IN, IN, toon(t.colors.ground, t.looks.ground), { cast: false, outline: false });

    if (t.walls === 'open') {
      // Unfinished steel frame: no walls, just yellow columns and edge beams. Get knocked
      // off the side and it's a long way down.
      for (let k = 0; k <= ROOF; k++) {
        const y = k * FH;
        for (let a = -IN + 0.25; a <= IN; a += 8) {
          for (const [x, z] of [
            [a, -IN + 0.25],
            [a, IN - 0.25],
            [-IN + 0.25, a],
            [IN - 0.25, a],
          ]) {
            if (k < ROOF) this.solid(x - 0.25, x + 0.25, y, y + FH - SLAB, z - 0.25, z + 0.25, t.colors.column);
          }
        }
        if (k === 0) continue;
        const beam = toon(t.colors.trim);
        this.deco(-IN, IN, y - SLAB - 0.35, y - SLAB, -IN, -IN + 0.3, beam);
        this.deco(-IN, IN, y - SLAB - 0.35, y - SLAB, IN - 0.3, IN, beam);
        this.deco(-IN, -IN + 0.3, y - SLAB - 0.35, y - SLAB, -IN, IN, beam);
        this.deco(IN - 0.3, IN, y - SLAB - 0.35, y - SLAB, -IN, IN, beam);
      }
      // A dirt site around the base.
      this.deco(-60, 60, -0.25, -0.05, -60, 60, toon(0x9c8a6a, { pattern: 'sand' }), { cast: false, outline: false });
    } else {
      // Wall colliders, full height including the roof parapet.
      const top = H + 1.2;
      for (const s of [-1, 1]) {
        this.collider(new THREE.Vector3(s * B, top / 2, 0), new THREE.Vector3(WALL / 2, top / 2, B + WALL / 2));
        this.collider(new THREE.Vector3(0, top / 2, s * B), new THREE.Vector3(B + WALL / 2, top / 2, WALL / 2));
      }
      // Wall visuals per floor: sill, header, mullions and glass.
      const wallMat = toon(t.colors.wall, t.looks.wall);
      const trimMat = toon(t.colors.trim);
      const glass = toon(t.colors.glass, { opacity: t.walls === 'hotel' ? 0.85 : 0.3, emissive: t.walls === 'hotel' ? 0x1a1a3a : 0 });
      const spacing = t.walls === 'hotel' ? 4.8 : 3.2;
      for (let k = 0; k <= ROOF; k++) {
        const y = k * FH;
        const isRoof = k === ROOF;
        for (let side = 0; side < 4; side++) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (side * Math.PI) / 2);
          const m = new THREE.Matrix4();
          const put = (along0: number, along1: number, y0: number, y1: number, mat: THREE.Material, depth = WALL, outline = true) => {
            const geo = new THREE.BoxGeometry(along1 - along0, y1 - y0, depth);
            m.compose(new THREE.Vector3((along0 + along1) / 2, (y0 + y1) / 2, B).applyQuaternion(q), q, new THREE.Vector3(1, 1, 1));
            this.batch.add(geo, mat, m, { cast: false, outline });
          };
          if (isRoof) {
            put(-B - WALL / 2, B + WALL / 2, y, y + 1.2, wallMat);
            continue;
          }
          const winTop = t.walls === 'hotel' ? 3.8 : 4.3;
          const winBot = t.walls === 'hotel' ? 1.4 : 1.0;
          put(-B - WALL / 2, B + WALL / 2, y, y + winBot, wallMat);
          put(-B - WALL / 2, B + WALL / 2, y + winTop, y + FH - SLAB, wallMat);
          put(-B - WALL / 2, B + WALL / 2, y + FH - SLAB, y + FH, trimMat);
          put(-B, B, y + winBot, y + winTop, glass, 0.08, false);
          const pier = t.walls === 'hotel' ? 1.6 : 0.3;
          for (let a = -B + 1; a <= B - 1 + 0.01; a += spacing) put(a - pier / 2, a + pier / 2, y + winBot, y + winTop, wallMat, WALL);
        }
      }
    }
    // Atrium corner columns.
    for (let k = 0; k < ROOF; k++)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const cx = sx * (A + 0.45);
          const cz = sz * (A + 0.45);
          this.solid(cx - 0.4, cx + 0.4, k * FH, k * FH + FH - SLAB, cz - 0.4, cz + 0.4, toon(t.colors.column, t.looks.column));
        }
    // Spawn: the west side of the lobby, facing east. 24 places.
    for (let i = 0; i < 24; i++) this.spawnPoints.push(new THREE.Vector3(-29 + (i % 6) * 2.5, 0, -6 + Math.floor(i / 6) * 4));
    if (t.crane) this.buildCrane();
  }

  /** Construction site: a tower crane beside the building (decoration; its load swings over the roof). */
  private buildCrane(): void {
    const steel = toon(0xf2b632);
    const x = 40;
    const z = -40;
    const top = 92;
    for (let y = 0; y < top; y += 4) {
      for (const [dx, dz] of [
        [-1.2, -1.2],
        [1.2, -1.2],
        [-1.2, 1.2],
        [1.2, 1.2],
      ])
        this.deco(x + dx - 0.12, x + dx + 0.12, y, y + 4, z + dz - 0.12, z + dz + 0.12, steel, { outline: false });
      this.deco(x - 1.3, x + 1.3, y + 3.9, y + 4.1, z - 1.3, z + 1.3, steel, { outline: false });
    }
    // Jib reaching over the roof, counterweight behind.
    this.deco(x - 50, x + 12, top, top + 1.6, z - 0.8, z + 0.8, steel);
    this.deco(x + 8, x + 13, top - 2.5, top, z - 1.5, z + 1.5, toon(0x6a6f78));
    this.deco(x - 2, x + 2, top + 1.6, top + 4.5, z - 1.4, z + 1.4, toon(0x3b6ea8));
  }

  /** Ground-floor atrium: fountain and two big sweeping bars between the start and the stairs. */
  private buildLobbyAtrium(): void {
    const fountain = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.8, 0.6, 32), toon(this.theme.id === 'construction' ? 0x9aa0a8 : 0xf1ede4));
    fountain.position.set(0, 0.3, 0);
    fountain.castShadow = fountain.receiveShadow = true;
    const water = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.35, 0.05, 32), toon(this.theme.id === 'construction' ? 0x8a8478 : 0x6cc7ff, { emissive: 0x1a3a55 }));
    water.position.set(0, 0.56, 0);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 1.6, 12), toon(0xf1ede4));
    spout.position.set(0, 1.1, 0);
    this.scene.add(fountain, water, spout);
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.3, 2.8).setTranslation(0, 0.3, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.8, 0.4).setTranslation(0, 1.1, 0));
    this.addSweeper(new THREE.Vector3(-5, 0, 0), 4.4, 1.3);
    this.addSweeper(new THREE.Vector3(5, 0, 0), 4.4, -1.3);
  }

  /** Floor k: slab, two rooms, stairs up, atrium edges, net, bridge, and its stretch of the route. */
  private buildFloor(k: number): void {
    const t = this.theme;
    const plan = t.plan[k];
    const y = k * FH;
    const sa = arrivalSide(k);
    const sf = -sa;
    const rooms = [this.room(k, 1, plan.north), this.room(k, -1, plan.south)];

    const holes: Rect[] = [];
    const islands: Rect[] = [];
    const crumbles: Rect[] = [];
    if (k > 0) {
      holes.push([-A, A, -A, A]);
      holes.push([sa * (ST_MID - 1), sa * ST_WALL, -ST_Z, ST_Z]); // stairwell from below
    }
    for (const r of rooms) {
      const h = this.roomHoles(r);
      holes.push(...h.holes);
      islands.push(...h.islands);
      crumbles.push(...h.crumbles);
    }
    if (k > 0) {
      holes.push(...crumbles);
      this.slab(y, IN, holes, islands, toon(plan.color, plan.look ?? {}), this.ceilingMat);
      this.lamps(y, holes, islands);
    }
    for (const r of crumbles) this.tileCrumbles(r, y, 2);

    for (const r of rooms) {
      // Room walls toward the side areas; doors at both ends.
      if (t.roomWalls) {
        for (const [u0, u1] of [
          [DOOR, IN - A],
          [IN + A, L - DOOR],
        ]) {
          this.rbox(r, u0, u1, -0.3, 0, 0, FH - SLAB, toon(t.colors.roomWall, t.looks.roomWall), { cast: false });
          this.rdeco(r, u0, u1, -0.32, 0.02, 0, 0.18, toon(t.colors.trim), { cast: false, outline: false });
        }
      }
      this.buildRoom(r);
      if (k > 0) this.roomExtras(r);
    }

    if (k < ROOF) this.buildStairs(k, sf);
    if (k > 0) {
      this.buildAtriumEdge(k, plan);
      this.buildStairwellRails(y, sa);
    }
    if (plan.net) this.buildNet(k, holes, islands);
    if (plan.bridge) this.buildBridge(k, sa, sf);
    this.floorExtras(k, sa, sf);

    // Side areas: a little dressing, supply-drop spots and the weapon racks by the stairs.
    for (const sx of [sa, sf])
      for (const sz of [-1, 1]) {
        if (t.id === 'construction') this.siteClutter(sx * 13.5, y, sz * 8.2, k + (sx > 0 ? 1 : 0) + (sz > 0 ? 2 : 0));
        else this.plant(sx * 13.5, y, sz * 8.2);
      }
    for (const sx of [sa, sf]) for (const sz of [-1, 1]) this.crateSpots.push(new THREE.Vector3(sx * 15, y, sz * 5.5));
    for (const sz of [-1, 1]) this.rackSpots.push(new THREE.Vector3(sf * 24, y, sz * 6.6));

    // This floor's stretch of the route: pick a way through, then the stairs.
    const alts: Waypoint[][] = [];
    const weights: number[] = [];
    if (k === 0) {
      alts.push([
        { pos: new THREE.Vector3(-11, 0, 3), radius: 1.6 },
        { pos: new THREE.Vector3(0, 0, 5.6), radius: 1.6 },
        { pos: new THREE.Vector3(11, 0, 3), radius: 1.6 },
        { pos: new THREE.Vector3(15, 0, -6.5), radius: 1.3 },
        { pos: new THREE.Vector3(30, 0, -6.5), radius: 1.3 },
      ]);
      weights.push(2);
    }
    for (const r of rooms) {
      const entry: Waypoint[] =
        k === 0 ? [{ pos: r.P(3, -3.5), radius: 1.6 }, { pos: r.P(3, 2), radius: 1.3 }] : [{ pos: r.P(2, -2.5), radius: 1.3 }, { pos: r.P(3, 2), radius: 1.3 }];
      alts.push([...entry, ...r.wps, { pos: r.P(61, 2), radius: 1.3 }, { pos: r.P(62, -2.5), radius: 1.3 }]);
      weights.push(1);
    }
    if (plan.bridge) {
      const p = (x: number, z: number, radius: number) => ({ pos: new THREE.Vector3(x, y, z), radius });
      alts.push([
        p(sa * 30, 6.5, 1.3),
        p(sa * 15, 6.5, 1.3),
        p(sa * 10.6, 0, 0.8),
        p(sa * 7, 0, 0.6),
        p(sa * 2.4, 0, 0.6),
        p(0, 1.3, 0.6),
        p(sf * 2.4, 0, 0.6),
        p(sf * 7, 0, 0.6),
        p(sf * 10.6, 0, 0.8),
        p(sf * 15, -6.5, 1.3),
        p(sf * 30, -6.5, 1.3),
      ]);
      weights.push(0.6);
    }
    this.route.push({ floor: k, alts, weights });
    const st = (x: number, dy: number, z: number, radius: number) => ({ pos: new THREE.Vector3(sf * x, y + dy, z), radius });
    this.route.push({
      floor: k,
      alts: [[st(30, 0, -2, 1.2), st(24, 1.5, -2, 1.6), st(19.5, 3, 0, 1.1), st(24, 4.5, 2, 1.6), st(30, 6, 2, 1.3)]],
      weights: [1],
    });
  }

  /** Ceiling lights on the underside of floor slab y (only where there is ceiling). */
  private lamps(y: number, holes: Rect[], islands: Rect[]): void {
    const kind = this.theme.lamps;
    if (kind === 'none') return;
    const lamp = kind === 'sconces' ? toon(0xffd68a, { emissive: 0xc98a2a }) : toon(0xffffff, { emissive: 0xfff6e0 });
    const step = kind === 'sconces' ? 9 : 6;
    for (let x = -27; x <= 27; x += step)
      for (let z = -27; z <= 27; z += step) {
        if (holes.some((r) => inRect(r, x, z)) && !islands.some((r) => inRect(r, x, z))) continue;
        const s = kind === 'sconces' ? 0.35 : 0.6;
        this.deco(x - s, x + s, y - SLAB - 0.06, y - SLAB - 0.02, z - s / 2, z + s / 2, lamp, { cast: false, outline: false });
      }
  }

  /** Switchback stairs at the far wall: flight 1 toward the atrium, a landing, flight 2 back to the wall. */
  private buildStairs(k: number, sf: number): void {
    const c = this.theme.colors;
    const look = this.theme.looks.stairs;
    const stepA = toon(c.stairA, look);
    const stepB = toon(c.stairB, look);
    const y = k * FH;
    const rise = FH / 16;
    for (let i = 0; i < 8; i++) {
      const a = sf * (ST_WALL - i - 1);
      const b = sf * (ST_WALL - i);
      this.solid(Math.min(a, b), Math.max(a, b), y, y + (i + 1) * rise, -ST_Z, 0, i % 2 ? stepA : stepB);
    }
    const l0 = sf * (ST_MID - 1);
    const l1 = sf * ST_MID;
    this.solid(Math.min(l0, l1), Math.max(l0, l1), y, y + 8 * rise, -ST_Z, ST_Z, toon(c.landing, look));
    this.railing(sf * (ST_MID - 1), -ST_Z, sf * (ST_MID - 1), ST_Z, y + 8 * rise, c.railGlass, c.railTop);
    for (let j = 0; j < 8; j++) {
      const a = sf * (ST_MID + j);
      const b = sf * (ST_MID + j + 1);
      this.solid(Math.min(a, b), Math.max(a, b), y, y + (9 + j) * rise, 0, ST_Z, j % 2 ? stepA : stepB);
    }
    // Handrail along flight 2's open side (it's a 6 m drop at the top).
    const ang = Math.atan2(4 * rise * 2, 8);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sf * ang);
    const ctr = new THREE.Vector3(sf * (ST_MID + 4), y + 12 * rise + 0.7, ST_Z + 0.05);
    this.batch.box(ctr, new THREE.Vector3(4.3, 0.5, 0.03), q, toon(c.railGlass, { opacity: 0.35 }), { cast: false, outline: false });
    this.batch.box(ctr.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(4.3, 0.04, 0.05), q, toon(c.railTop));
    this.collider(ctr, new THREE.Vector3(4.3, 0.55, 0.06), q);
  }

  /** Railings round the stairwell opening on the floor the stairs arrive at. */
  private buildStairwellRails(y: number, sa: number): void {
    const c = this.theme.colors;
    this.railing(sa * (ST_MID - 1), ST_Z, sa * ST_WALL, ST_Z, y, c.railGlass, c.railTop);
    this.railing(sa * (ST_MID - 1), -ST_Z, sa * ST_WALL, -ST_Z, y, c.railGlass, c.railTop);
    this.railing(sa * (ST_MID - 1), -ST_Z, sa * (ST_MID - 1), ST_Z, y, c.railGlass, c.railTop);
    this.railing(sa * ST_WALL, -ST_Z, sa * ST_WALL, 0, y, c.railGlass, c.railTop);
  }

  private buildAtriumEdge(k: number, plan: FloorPlan): void {
    const c = this.theme.colors;
    const y = k * FH;
    // A gap by the plank, and by any net (so there's always a way out of it).
    const bridgeGap: [number, number][] = plan.bridge || plan.net ? [[-0.9, 0.9]] : [];
    // The side edges are always railed (they're by the stairs and the crowd).
    for (const sx of [-1, 1]) this.railWithGaps(sx * A, 'z', -A, A, bridgeGap, y, c.railGlass, c.railTop);
    if (!plan.railing) return;
    for (const sz of [-1, 1]) this.railWithGaps(sz * A, 'x', -A, A, [], y, c.railGlass, c.railTop);
  }

  private buildNet(k: number, holes: Rect[], islands: Rect[]): void {
    // Low enough that you can stand on it without clipping the floor lip above; jumping on it launches you back up.
    const plan = this.theme.plan[k];
    const y = k * FH - 2.3;
    const fy = k * FH;
    // Only edges you can actually get out over: no railing in the way, and floor to land on
    // (a room might have a hole right there).
    const solidAt = (x: number, z: number) => islands.some((r) => inRect(r, x, z)) || !holes.some((r) => inRect(r, x, z));
    const sides = [new THREE.Vector3(A + 1.2, fy, 0), new THREE.Vector3(-A - 1.2, fy, 0)];
    const roomExits = plan.railing ? [] : [new THREE.Vector3(0, fy, A + 1.2), new THREE.Vector3(0, fy, -A - 1.2)];
    const exits = [...sides, ...roomExits].filter((e) => solidAt(e.x, e.z));
    if (!exits.length) console.warn(`[net] ${this.id} floor ${k} net has no way out`);
    this.net(y, [-A, A, -A, A], exits);
  }

  /** Plank across the atrium with a spinning bar on a little platform in the middle; bars guard both ends. */
  private buildBridge(k: number, sa: number, sf: number): void {
    const y = k * FH;
    this.solid(-A - 0.2, A + 0.2, y - 0.25, y, -0.6, 0.6, toon(0xc98b55, { pattern: 'plank', scale: 0.9 }), { walkable: true });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.3, 32), toon(0xc98b55, { pattern: 'plank', scale: 0.9 }));
    disc.position.set(0, y - 0.15, 0);
    disc.receiveShadow = true;
    this.scene.add(disc);
    this.slabHandles.add(this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.15, 2.2).setTranslation(0, y - 0.15, 0)).handle);
    this.addSweeper(new THREE.Vector3(0, y, 0), 2.0, k % 4 === 2 ? 1.8 : -1.8);
    // Bars by both ends of the plank, so even the shortcut has to be timed.
    this.addSweeper(new THREE.Vector3(sa * 14, y, 0), 2.6, 1.5);
    this.addSweeper(new THREE.Vector3(sf * 14, y, 0), 2.6, -1.5);
  }

  /**
   * More trouble in the open stretches between the rooms and the stairs: a wrecking ball over
   * the passage to the stairs up, a piston on the landing that shoves new arrivals back down
   * the stairs, and the map's own extras (wind on the open frame, ghosts in the hotel).
   */
  private floorExtras(k: number, sa: number, sf: number): void {
    const y = k * FH;
    const t = this.theme;
    if (k >= 2) this.ball(new THREE.Vector3(sf * 30, y, 2.4), new THREE.Vector3(1, 0, 0), hash01(k, 41) * 6, 1.7);
    if (k >= 3) this.addPusher(new THREE.Vector3(sa * 31.4, y, 2), new THREE.Vector3(-sa, 0, 0), 2.5, 3.4, 3.6, hash01(k, 43));
    if (t.wind && k >= 2) {
      // Gusts across one room, out toward the open edge. Swap sides floor to floor.
      const s = k % 2 ? 1 : -1;
      const r = this.room(k, s, t.plan[k].north);
      this.winds.push(new WindZone(this.scene, r.R(8, 56, 9, W), y, r.dv.clone().multiplyScalar(4.5), 7 + (k % 3), hash01(k, 47)));
    }
  }

  /** Map extras inside the rooms: doorway wrecking balls and, in the hotel, a ghost per room. */
  private roomExtras(r: Room): void {
    const { du, dv } = r;
    // Doorways: alternate between the way in and the way out.
    if (r.k >= 2) {
      if ((r.k + (r.s > 0 ? 1 : 0)) % 2 === 0) this.ball(r.P(3, 3.5), du, this.ph(r, 21) * 6, 1.6);
      else this.ball(r.P(59, 4), dv, this.ph(r, 22) * 6, 1.6);
    }
    if (this.theme.ghosts) {
      const v = 8 + this.ph(r, 23) * 8;
      this.ghosts.push(new Ghost(this.scene, r.P(9, v), r.P(54, v), 9 + this.ph(r, 24) * 5, this.ph(r, 25)));
    }
  }

  // ------------------------------------------------------------------ rooms

  /** Holes a room cuts in the floor slab (decided before the slab is built). */
  private roomHoles(r: Room): { holes: Rect[]; islands: Rect[]; crumbles: Rect[] } {
    const out = { holes: [] as Rect[], islands: [] as Rect[], crumbles: [] as Rect[] };
    switch (r.content) {
      case 'broken':
        out.holes.push(r.R(12, 52, 0, W));
        for (let i = 0; i < 9; i++) {
          const u = 15.5 + 4.5 * i;
          const v = i % 2 ? 10 : 7;
          out.islands.push(r.R(u - 1, u + 1, v - 1, v + 1));
        }
        // A harder lane of smaller stepping stones along the wall.
        for (let i = 0; i < 9; i++) {
          const u = 15 + 4.5 * i;
          const v = i % 2 ? 19 : 16;
          out.islands.push(r.R(u - 0.75, u + 0.75, v - 0.75, v + 0.75));
        }
        break;
      case 'crumbles':
        for (const u of [18, 30, 42]) out.crumbles.push(r.R(u, u + 4, 0, W));
        break;
      case 'lifts':
        out.holes.push(r.R(14, 50, 0, W));
        break;
      case 'beams':
      case 'flipfloor':
        out.holes.push(r.R(12, 52, 0, W));
        break;
    }
    return out;
  }

  /** A room's obstacle course and the waypoints bots follow through it (from u ≈ 3 to u ≈ 61). */
  private buildRoom(r: Room): void {
    const { du, dv } = r;
    const fast = r.k > 5;
    switch (r.content) {
      case 'lobby': {
        // Lounge with a moving walkway: longer than the atrium, but the belt helps.
        this.rbox(r, 26, 37, 17, 18.4, 0, 1.1, 0xf7f3ea);
        this.rdeco(r, 26, 37, 16.9, 18.5, 1.1, 1.18, toon(0x6a7b93));
        for (const u of [13, 47]) {
          this.rbox(r, u, u + 3, 1.6, 2.6, 0, 0.5, 0x5b8fd6);
          this.rdeco(r, u, u + 3, 1.6, 1.85, 0.5, 0.95, toon(0x5b8fd6));
        }
        for (const [u, v] of [
          [8, 21.5],
          [56, 21.5],
          [31.5, 21.5],
        ]) {
          const p = r.P(u, v);
          this.plant(p.x, r.y, p.z);
        }
        this.addConveyor(r.R(16, 47, 9, 13.5), r.y, du.clone().multiplyScalar(3));
        this.addSweeper(r.P(31.5, 5), 3.2, 1.4);
        this.w(r, 8, 6, { radius: 1.4 });
        this.w(r, 16, 11.25, { radius: 1.4 });
        this.w(r, 47, 11.25, { radius: 1.4 });
        this.w(r, 55, 6, { radius: 1.4 });
        break;
      }
      case 'office': {
        // Partition slalom: gaps alternate between the wall side (piston) and the atrium side (wrecking ball).
        [14, 23, 32, 41, 50].forEach((u, i) => {
          const [v0, v1] = i % 2 ? [7.7, W] : [0, 15];
          this.rbox(r, u - 0.08, u + 0.08, v0, v1, 0, 1.6, this.theme.id === 'hotel' ? 0x7a3f52 : 0x8fa3b8);
          for (let v = v0 + 0.9; v < v1 - 0.8; v += 1.9) this.desk(r.P(u - 0.55, v), 0.4, 0.8, 0.76, this.theme.id === 'hotel' ? 0x8a5a3a : 0xf4f1ea, true);
          if (i % 2) this.ball(r.P(u, 3.8), dv, this.ph(r, i) * 6);
          else this.wallPusher(r, u + 0.2, 5, this.ph(r, i));
        });
        this.w(r, 8, 11, { radius: 1.2 });
        this.w(r, 14, 19, { radius: 1.0 });
        this.w(r, 23, 3.8, { radius: 1.0 });
        this.w(r, 32, 19, { radius: 1.0 });
        this.w(r, 41, 3.8, { radius: 1.0 });
        this.w(r, 50, 19, { radius: 1.0 });
        this.w(r, 55, 11, { radius: 1.2 });
        break;
      }
      case 'cubicles': {
        const block = this.theme.id === 'construction' ? 0x9a6a4a : this.theme.id === 'hotel' ? 0x8a5a3a : 0xb8c4d0;
        const look: ToonOpts = this.theme.id === 'construction' ? { pattern: 'plank', scale: 1.2 } : this.theme.id === 'hotel' ? { pattern: 'plank' } : { pattern: 'panel', scale: 0.7 };
        const cap = toon(this.theme.id === 'tower' ? 0x8090a4 : 0x5a4030);
        for (const u of [12, 20, 28, 36, 44, 52])
          for (const vc of [3.5, 13]) {
            this.rbox(r, u - 2, u + 2, vc - 2, vc + 2, 0, 1.25, toon(block, look));
            this.rdeco(r, u - 2.04, u + 2.04, vc - 2.04, vc + 2.04, 1.25, 1.31, cap);
            // Two screens back to back in the middle of each pod.
            if (this.theme.id !== 'construction') {
              this.rdeco(r, u - 0.32, u + 0.32, vc - 0.05, vc + 0.05, 1.31, 1.7, toon(0x2c2f3a));
              this.rdeco(r, u - 0.27, u + 0.27, vc - 0.07, vc + 0.07, 1.36, 1.65, toon(0x6fb7ff, { emissive: 0x1f4f7a }), { outline: false });
            }
          }
        // Main aisle: wrecking balls. Wall aisle: a belt running the wrong way and pistons.
        [16, 32, 48].forEach((u, i) => this.ball(r.P(u, 8.25), dv, this.ph(r, i) * 6, 2.0));
        this.addConveyor(r.R(10, 54, 16, 21.7), r.y, du.clone().multiplyScalar(-3.5));
        [24, 40].forEach((u, i) => this.wallPusher(r, u, 4, this.ph(r, i + 5)));
        this.w(r, 8, 8.25, { radius: 1.2 });
        this.w(r, 55, 8.25, { radius: 1.2 });
        break;
      }
      case 'classroom': {
        const sweepers = [21, 43];
        for (let u = 10; u <= 54; u += 2.2)
          for (const v of [2.4, 4.0, 9.4, 11.0, 16.4, 18.0]) {
            if (sweepers.some((su) => Math.hypot(u - su, v - 13.7) < 3.8)) continue;
            this.desk(r.P(u, v), 0.32, 0.24, 0.72, this.theme.id === 'hotel' ? 0xa0703a : 0xd8b088, false);
          }
        sweepers.forEach((u, i) => this.addSweeper(r.P(u, 13.7), 3.0, i ? -1.8 : 1.8));
        this.rdeco(r, 12, 52, W - 0.05, W, 1.2, 3, toon(0x2f5d4a), { cast: false });
        this.addConveyor(r.R(10, 54, 4.6, 8.8), r.y, du.clone().multiplyScalar(-3));
        [32, 52].forEach((u, i) => this.ball(r.P(u, 12.3), dv, this.ph(r, i + 7) * 6, 1.8));
        // Beside the sweepers' posts, not through them.
        this.w(r, 8, 12.3, { radius: 1.2 });
        this.w(r, 55, 12.3, { radius: 1.2 });
        break;
      }
      case 'fans': {
        const sp = fast ? 2.2 : 1.7;
        [16, 27, 38, 49].forEach((u, i) => this.addSweeper(r.P(u, 11), 4.5, i % 2 ? -sp : sp));
        [21.5, 32.5, 43.5].forEach((u, i) => this.wallPusher(r, u, 4.5, this.ph(r, i), 3.0));
        this.w(r, 8, 19, { radius: 1.2 });
        this.w(r, 55, 19, { radius: 1.2 });
        break;
      }
      case 'treadmills': {
        this.addConveyor(r.R(10, 54, 1, 6), r.y, du.clone().multiplyScalar(3));
        this.addConveyor(r.R(10, 54, 6.5, 11.5), r.y, du.clone().multiplyScalar(-4));
        this.addConveyor(r.R(10, 54, 12, 17), r.y, du.clone().multiplyScalar(3));
        this.addConveyor(r.R(10, 54, 17.5, 22.5), r.y, du.clone().multiplyScalar(-4));
        [20, 36].forEach((u, i) => this.ball(r.P(u, 3.5), dv, this.ph(r, i) * 6));
        [28, 44].forEach((u, i) => this.ball(r.P(u, 14.5), dv, this.ph(r, i + 2) * 6));
        [24, 40].forEach((u, i) => this.wallPusher(r, u, 7, this.ph(r, i + 4)));
        this.w(r, 8, 14.5, { radius: 1.2 });
        this.w(r, 55, 14.5, { radius: 1.2 });
        break;
      }
      case 'broken': {
        for (const u of [11.6, 52.4]) {
          const a = r.P(u, 6);
          this.deco(a.x - 0.2, a.x + 0.2, r.y, r.y + 0.35, a.z - 0.6, a.z + 0.6, toon(0x9a958c));
        }
        this.w(r, 8, 8.5, { radius: 1.0 });
        this.w(r, 11.4, 8.5, { radius: 0.6 });
        for (let i = 0; i < 9; i++) this.w(r, 15.5 + 4.5 * i, i % 2 ? 10 : 7, { jump: true, radius: 0.7 });
        this.w(r, 55, 8.5, { radius: 1.2 });
        break;
      }
      case 'crumbles': {
        [26, 38].forEach((u, i) => this.ball(r.P(u, 11), dv, this.ph(r, i) * 6));
        this.wallPusher(r, 14, 6, this.ph(r, 3));
        this.wallPusher(r, 50, 6, this.ph(r, 4));
        this.w(r, 8, 11, { radius: 1.2 });
        this.w(r, 55, 11, { radius: 1.2 });
        break;
      }
      case 'library': {
        [13, 20, 27, 34, 41, 48].forEach((u, i) => {
          const spans: [number, number][] = i % 2 ? [[4.7, 18]] : [
            [0, 9],
            [13.7, W],
          ];
          for (const [v0, v1] of spans) {
            const a = r.P(u - 0.25, v0);
            const b = r.P(u + 0.25, v1);
            this.shelf(a.x, b.x, r.y, a.z, b.z);
          }
        });
        this.ball(r.P(16.5, 6), dv, this.ph(r, 0) * 6);
        this.ball(r.P(30.5, 16), dv, this.ph(r, 1) * 6);
        this.ball(r.P(44.5, 6), dv, this.ph(r, 2) * 6);
        this.wallPusher(r, 23.5, 3.5, this.ph(r, 3));
        this.wallPusher(r, 37.5, 3.5, this.ph(r, 4));
        this.w(r, 8, 11.35, { radius: 1.2 });
        this.w(r, 13, 11.35, { radius: 1.0 });
        this.w(r, 20, 2.3, { radius: 1.0 });
        this.w(r, 27, 11.35, { radius: 1.0 });
        this.w(r, 34, 20.4, { radius: 1.0 });
        this.w(r, 41, 11.35, { radius: 1.0 });
        this.w(r, 48, 2.3, { radius: 1.0 });
        this.w(r, 55, 11.35, { radius: 1.2 });
        break;
      }
      case 'lasers': {
        [12, 19, 26, 33, 40, 47, 54].forEach((u, i) => this.laser(r, u, 3 + (i % 3) * 0.45, this.ph(r, i), 0.45));
        [22.5, 36.5, 50.5].forEach((u, i) => this.ball(r.P(u, 11), dv, this.ph(r, i + 9) * 6, 1.8));
        this.w(r, 8, 11, { radius: 1.2 });
        this.w(r, 55, 11, { radius: 1.2 });
        break;
      }
      case 'lifts': {
        const half = new THREE.Vector3(1.4, 0.2, 1.4);
        const l1 = this.addPlatform(r.P(23, 6, -half.y), du, 6.5, 5, 0, half);
        const l2 = this.addPlatform(r.P(41, 6, -half.y), du, 6.5, 5, Math.PI, half);
        this.addPlatform(r.P(23, 16, -half.y), du, 6.5, 6.4, 1, half);
        this.addPlatform(r.P(41, 16, -half.y), du, 6.5, 6.4, 1 + Math.PI, half);
        // u coordinate of a platform (u grows toward the far end).
        const uOf = (p: { pos: THREE.Vector3 }) => IN - r.sa * p.pos.x;
        const hd = (c: Character, p: { pos: THREE.Vector3 }) => Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
        this.w(r, 8, 6, { radius: 1.0 });
        // Wait right at the edge: the lift's nearest pass is 3 m out from here.
        this.w(r, 13.5, 6, { radius: 0.45 });
        r.wps.push({ pos: l1.top, platform: l1, jump: true, radius: 1.0, ready: (c) => hd(c, l1) < 3.7 });
        // The lifts run nose to nose, so jump across when they meet in the middle.
        r.wps.push({ pos: l2.top, platform: l2, jump: true, radius: 1.0, ready: () => Math.abs(uOf(l2) - uOf(l1)) < 5.6 });
        this.w(r, 51.2, 6, { jump: true, radius: 1.0, ready: () => uOf(l2) > 46 });
        this.w(r, 55, 6, { radius: 1.2 });
        break;
      }
      case 'beams': {
        const beam = (u0: number, v0: number, u1: number, v1: number, w: number) => {
          const ua = Math.min(u0, u1) - (v0 === v1 ? 0 : w / 2);
          const ub = Math.max(u0, u1) + (v0 === v1 ? 0 : w / 2);
          const va = Math.min(v0, v1) - (v0 === v1 ? w / 2 : 0);
          const vb = Math.max(v0, v1) + (v0 === v1 ? w / 2 : 0);
          this.rbox(r, ua, ub, va, vb, -0.4, 0, this.theme.id === 'hotel' ? 0x6a4a35 : 0xd0574a, { walkable: true });
        };
        beam(11.5, 4, 24.45, 4, 0.9);
        beam(24, 4, 24, 12, 0.9);
        beam(23.55, 12, 36.45, 12, 0.9);
        beam(36, 12, 36, 19, 0.9);
        beam(35.55, 19, 52.5, 19, 0.9);
        beam(11.5, 8.5, 52.5, 8.5, 0.5);
        [18, 30, 44].forEach((u, i) => this.ball(r.P(u, 8.5), dv, this.ph(r, i) * 6, 2.0));
        this.w(r, 8, 4, { radius: 1.0 });
        this.w(r, 11.6, 4, { radius: 0.5 });
        this.w(r, 24, 4, { radius: 0.5 });
        this.w(r, 24, 12, { radius: 0.5 });
        this.w(r, 36, 12, { radius: 0.5 });
        this.w(r, 36, 19, { radius: 0.5 });
        this.w(r, 52.6, 19, { radius: 0.6 });
        this.w(r, 55, 15, { radius: 1.2 });
        break;
      }
      case 'boulders': {
        [14, 21, 28, 35, 42, 49].forEach((u, i) => {
          this.bouldersAcross(r, u, 4.4 + (i % 2) * 0.6, this.ph(r, i), 7.5);
          // Hatch in the wall and a grate where it drops.
          this.rdeco(r, u - 1.4, u + 1.4, W - 0.06, W, 0, 2.6, toon(0x2c2633), { cast: false });
          this.rdeco(r, u - 1.55, u + 1.55, W - 0.1, W - 0.04, 2.6, 2.8, toon(0xffd23f), { cast: false });
          this.rdeco(r, u - 1.4, u + 1.4, 0, 1.9, 0.0, 0.03, toon(0x3a3f52), { cast: false, outline: false });
        });
        [17.5, 31.5, 45.5].forEach((u, i) => this.ball(r.P(u, 11), du, this.ph(r, i + 11) * 6, 1.7));
        this.w(r, 8, 11, { radius: 1.2 });
        this.w(r, 55, 11, { radius: 1.2 });
        break;
      }
      case 'turntables': {
        [15, 26.5, 38, 49.5].forEach((u, i) => {
          const c = r.P(u, 11.35);
          const om = i % 2 ? -0.9 : 0.9;
          this.turntables.push(new Turntable(this.scene, c, 4.6, om));
          this.addSweeper(c, 4.2, -om * 1.6);
        });
        this.w(r, 8, 13.4, { radius: 1.2 });
        this.w(r, 55, 13.4, { radius: 1.2 });
        break;
      }
      case 'flipfloor': {
        const [x0, x1, z0, z1] = r.R(12, 52, 0, W);
        this.flipFloors.push(new FlipFloor(this.world, this.scene, Math.min(x0, x1), Math.min(z0, z1), 16, 9, 2.5, W / 9, r.y, 4.2, 0.3, { x: du.x, z: 0 }));
        this.w(r, 8, 11.35, { radius: 1.2 });
        this.w(r, 55, 11.35, { radius: 1.2 });
        break;
      }
      case 'gauntlet': {
        this.ball(r.P(14, 11), dv, this.ph(r, 0) * 6, 2.2);
        this.ball(r.P(19, 11), dv, this.ph(r, 1) * 6, 2.2);
        this.addSweeper(r.P(27, 11), 4.5, 2.0);
        this.wallPusher(r, 34, 9, 0, 2.6);
        this.wallPusher(r, 37.5, 9, 0.5, 2.6);
        this.laser(r, 44, 2.8, this.ph(r, 2), 0.5);
        this.bouldersAcross(r, 50, 3.6, this.ph(r, 3), 8.5);
        this.rdeco(r, 48.6, 51.4, W - 0.06, W, 0, 2.6, toon(0x2c2633), { cast: false });
        this.w(r, 8, 13, { radius: 1.2 });
        this.w(r, 55, 13, { radius: 1.2 });
        break;
      }
    }
  }

  private shelf(x0: number, x1: number, y: number, z0: number, z1: number): void {
    const wood = toon(this.theme.id === 'hotel' ? 0x5a3626 : 0x7a4e35, { pattern: 'plank', scale: 0.8 });
    this.solid(Math.min(x0, x1), Math.max(x0, x1), y, y + 2.2, Math.min(z0, z1), Math.max(z0, z1), wood);
    // Both long faces: a thin skin with the books painted on, repeating every 1.2 m.
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const depth = alongX ? Math.abs(z1 - z0) : Math.abs(x1 - x0);
    for (const side of [-1, 1]) {
      const geo = new THREE.BoxGeometry(alongX ? len - 0.1 : 0.02, 2.1, alongX ? 0.02 : len - 0.1);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * ((len - 0.1) / 1.2));
      const pos = alongX ? new THREE.Vector3(cx, y + 1.08, cz + side * (depth / 2 + 0.012)) : new THREE.Vector3(cx + side * (depth / 2 + 0.012), y + 1.08, cz);
      this.batch.add(geo, toon(0xffffff, { map: bookTexture() }), new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z), { cast: false, outline: false });
    }
  }

  /** Construction site dressing where the other buildings have pot plants: a barrel and cones. */
  private siteClutter(x: number, y: number, z: number, seed: number): void {
    const barrelAt = new THREE.Vector3(x, y, z);
    this.collider(barrelAt.clone().setY(y + 0.5), new THREE.Vector3(0.32, 0.5, 0.32));
    const one = new THREE.Vector3(1, 1, 1);
    const q = new THREE.Quaternion();
    const orange = toon(0xff7a2a);
    const white = toon(0xf4f1ea);
    for (let i = 0; i < 4; i++)
      this.batch.add(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 16), i % 2 ? white : orange, new THREE.Matrix4().compose(barrelAt.clone().setY(y + 0.125 + i * 0.25), q, one), { outline: false });
    for (let j = 0; j < 2; j++) {
      const a = hash01(seed, 151 + j) * Math.PI * 2;
      const c = new THREE.Vector3(x + Math.cos(a) * 0.9, y, z + Math.sin(a) * 0.9);
      this.batch.add(new THREE.ConeGeometry(0.2, 0.6, 12), orange, new THREE.Matrix4().compose(c.clone().setY(y + 0.32), q, one), { outline: false });
      this.batch.add(new THREE.CylinderGeometry(0.15, 0.17, 0.08, 12), white, new THREE.Matrix4().compose(c.clone().setY(y + 0.3), q, one), { outline: false });
      this.batch.add(new THREE.BoxGeometry(0.42, 0.04, 0.42), toon(0x2c2633), new THREE.Matrix4().compose(c.clone().setY(y + 0.02), q, one), { outline: false });
    }
  }

  /** A desk (top, end panels, modesty panel) over a collider of the same size; maybe a monitor. */
  private desk(c: THREE.Vector3, hx: number, hz: number, h: number, color: number, monitor: boolean): void {
    const y = c.y;
    this.collider(new THREE.Vector3(c.x, y + h / 2, c.z), new THREE.Vector3(hx, h / 2, hz));
    const top = toon(color, { pattern: 'plank', scale: 0.6 });
    const legs = toon(0x5d6470);
    this.deco(c.x - hx, c.x + hx, y + h - 0.05, y + h, c.z - hz, c.z + hz, top);
    const long = hz > hx;
    // End panels at both ends of the long side.
    for (const s of [-1, 1]) {
      if (long) {
        const z = c.z + s * (hz - 0.03);
        this.deco(c.x - hx + 0.03, c.x + hx - 0.03, y, y + h - 0.05, z - 0.025, z + 0.025, legs, { outline: false });
      } else {
        const x = c.x + s * (hx - 0.03);
        this.deco(x - 0.025, x + 0.025, y, y + h - 0.05, c.z - hz + 0.03, c.z + hz - 0.03, legs, { outline: false });
      }
    }
    // Modesty panel down the middle.
    if (long) this.deco(c.x - 0.02, c.x + 0.02, y + 0.25, y + h - 0.05, c.z - hz + 0.05, c.z + hz - 0.05, top, { outline: false });
    else this.deco(c.x - hx + 0.05, c.x + hx - 0.05, y + 0.25, y + h - 0.05, c.z - 0.02, c.z + 0.02, top, { outline: false });
    if (!monitor) return;
    const mx = c.x;
    this.deco(mx - 0.05, mx + 0.05, y + h, y + h + 0.18, c.z - 0.05, c.z + 0.05, legs, { outline: false });
    if (long) {
      this.deco(mx - 0.03, mx + 0.03, y + h + 0.16, y + h + 0.5, c.z - 0.3, c.z + 0.3, toon(0x2c2f3a));
      this.deco(mx - 0.045, mx + 0.045, y + h + 0.19, y + h + 0.47, c.z - 0.27, c.z + 0.27, toon(0x6fb7ff, { emissive: 0x1f4f7a }), { outline: false });
    } else {
      this.deco(mx - 0.3, mx + 0.3, y + h + 0.16, y + h + 0.5, c.z - 0.03, c.z + 0.03, toon(0x2c2f3a));
      this.deco(mx - 0.27, mx + 0.27, y + h + 0.19, y + h + 0.47, c.z - 0.045, c.z + 0.045, toon(0x6fb7ff, { emissive: 0x1f4f7a }), { outline: false });
    }
  }

  // ------------------------------------------------------------------ roof

  /** Roof: the flag platform over the atrium on three catwalks, a spinning bar and wrecking balls. */
  private buildRoof(): void {
    const t = this.theme;
    const c = t.colors;
    const y = ROOF * FH;
    const sa = arrivalSide(ROOF);
    this.slab(y, IN, [[-A, A, -A, A], [sa * (ST_MID - 1), sa * ST_WALL, -ST_Z, ST_Z]], [], toon(c.roof, t.looks.roof), null);
    this.buildStairwellRails(y, sa);
    const gap: [number, number][] = [[-0.9, 0.9]];
    for (const sz of [-1, 1]) this.railWithGaps(sz * A, 'x', -A, A, gap, y, c.railGlass, c.railTop);
    this.railWithGaps(sa * A, 'z', -A, A, gap, y, c.railGlass, c.railTop);
    this.railWithGaps(-sa * A, 'z', -A, A, [], y, c.railGlass, c.railTop);

    // Flag platform + catwalks.
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 0.4, 48), toon(0xf2b632));
    plat.position.set(0, y - 0.2, 0);
    plat.castShadow = plat.receiveShadow = true;
    this.scene.add(plat);
    const ring = new THREE.LineSegments(new THREE.EdgesGeometry(plat.geometry, 30), OUTLINE);
    ring.position.copy(plat.position);
    this.scene.add(ring);
    this.slabHandles.add(this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.2, 4.4).setTranslation(0, y - 0.2, 0)).handle);
    for (const s of [-1, 1]) this.solid(-0.8, 0.8, y - 0.2, y, s * 4.2, s * (A + 0.1), 0xb0b6bf, { walkable: true });
    this.solid(Math.min(sa * 4.2, sa * (A + 0.1)), Math.max(sa * 4.2, sa * (A + 0.1)), y - 0.2, y, -0.8, 0.8, 0xb0b6bf, { walkable: true });

    // The flag platform spins: hold the flag and you have to hop the bar. The pole is solid,
    // so nobody can stand inside the bar's hub.
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.6, 0.3).setTranslation(0, y + 1.6, 0));
    this.sweepers.push(new Sweeper(this.scene, new THREE.Vector3(0, y + 0.95, 0), 1.15, 4.1));
    // Trusses across the atrium with a wrecking ball over the north and south catwalks.
    const truss = toon(0x8a8fa0);
    for (const s of [-1, 1]) {
      for (const gx of [-A - 0.6, A + 0.6]) this.solid(gx - 0.2, gx + 0.2, y, y + 7, s * 6.6 - 0.2, s * 6.6 + 0.2, 0x8a8fa0);
      this.deco(-A - 0.8, A + 0.8, y + 6.8, y + 7.2, s * 6.6 - 0.25, s * 6.6 + 0.25, truss);
      this.addPendulum(new THREE.Vector3(0, y, s * 6.6), new THREE.Vector3(1, 0, 0), s > 0 ? 0 : Math.PI / 2, 1.45, 6.8, t.pendulum);
    }
    // Rolling trouble across the approach to the catwalks.
    for (const [x, i] of [
      [sa * 15.5, 0],
      [sa * 12.5, 1],
    ]) {
      this.boulders.push(new BoulderLane(this.scene, new THREE.Vector3(x, y, IN - 1.2), new THREE.Vector3(x, y, -IN + 1.2), 1.2, 10 + i * 1.5, hash01(i, 61), 8, t.boulder));
    }
    if (t.crane) {
      // The crane's load: a steel beam swinging round over the west half of the roof.
      this.sweepers.push(new Sweeper(this.scene, new THREE.Vector3(sa * 20, y + 1.0, 0), 0.45, 7, 0x9aa0a8));
      this.winds.push(new WindZone(this.scene, [sa * 9, sa * 31, -31, 31], y, new THREE.Vector3(0, 0, 4), 8, 0.3));
    }
    if (t.ghosts) {
      this.ghosts.push(new Ghost(this.scene, new THREE.Vector3(sa * 26, y, -11), new THREE.Vector3(sa * 26, y, 11), 7, 0.2));
      this.ghosts.push(new Ghost(this.scene, new THREE.Vector3(sa * 13, y, 13), new THREE.Vector3(sa * 13, y, -13), 9, 0.6));
    }

    // Rooftop dressing away from the routes.
    for (const [x, z] of [
      [-24, -24],
      [24, -24],
      [-24, 24],
    ])
      this.solid(x - 2, x + 2, y, y + 1.4, z - 1.5, z + 1.5, 0xc9ced6);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 3.2, 20), toon(t.id === 'hotel' ? 0x5a4a3a : 0x7fa8d6));
    tank.position.set(24, y + 1.6, 24);
    tank.castShadow = true;
    this.scene.add(tank);
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.6, 1.8).setTranslation(24, y + 1.6, 24));

    const p = (x: number, z: number, radius: number) => ({ pos: new THREE.Vector3(x, y, z), radius });
    // Bots hold the flag from beside the pole (inside the grab radius), on their catwalk's side.
    this.route.push({
      floor: ROOF,
      alts: [
        [p(sa * 30, 6.5, 1.3), p(sa * 12, 6.5, 1.3), p(sa * 10.4, 0, 0.8), p(sa * 9.4, 0, 0.6), p(sa * 4.8, 0, 0.6), p(sa * 1.0, 0, 0.6)],
        [p(sa * 30, 6.5, 1.3), p(sa * 12, 11, 1.3), p(sa * 1.5, 11, 1.2), p(0, 9.6, 0.6), p(0, 4.8, 0.6), p(0, 1.0, 0.6)],
        [p(sa * 30, -6.5, 1.3), p(sa * 12, -11, 1.3), p(sa * 1.5, -11, 1.2), p(0, -9.6, 0.6), p(0, -4.8, 0.6), p(0, -1.0, 0.6)],
      ],
      weights: [1, 1, 1],
    });
  }
}
