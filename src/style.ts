import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { toon } from './toon';

// Character style catalog — everything a fighter can look like. Modelled on the
// INKWAVE locker (github.com/jaydendavisnc/inkwave, MIT): every table is
// APPEND-ONLY because saved profiles and bots store indices, and each has a
// parallel *_NAMES list for the locker UI. Index 0 of each colour table means
// "the model's original colours".

export const BASES = ['shino', 'shibu', 'bibi', 'vita', 'victoria', 'kenji', 'ryo'] as const;
export const BASE_NAMES = ['Shino', 'Shibu', 'Bibi', 'Vita', 'Victoria', 'Kenji', 'Ryo'];
/** The boys (the rest are girls). */
export const MALE_BASES = [5, 6];

export const HAIR_COLORS: (string | null)[] = [null, '#ff8fc0', '#7fc8ff', '#7be0b0', '#b79cff', '#ffd25c', '#e8ecf2', '#e2485a', '#27304f', '#ff9a4d'];
export const HAIR_NAMES = ['Natural', 'Sakura', 'Sky', 'Mint', 'Lilac', 'Gold', 'Silver', 'Crimson', 'Midnight', 'Tangerine'];

/** Outfit colourways: [top / dress, bottoms, shoes]. */
export const OUTFITS: ([string, string, string] | null)[] = [
  null,
  ['#f4f2ec', '#27304a', '#272b34'],
  ['#2b2e36', '#e2485a', '#f3f2ee'],
  ['#ffc2d9', '#ffffff', '#ff7aa8'],
  ['#9fd0ff', '#2c4a7a', '#f4f4f4'],
  ['#5f6446', '#b5a37f', '#6a5238'],
  ['#1f2a44', '#1f2a44', '#f2f1ec'],
  ['#ffe27a', '#3a3f4b', '#ff8a3d'],
  ['#b79cff', '#3b2d5a', '#f3efe4'],
];
export const OUTFIT_NAMES = ['Original', 'Sailor', 'Street', 'Sakura', 'Sky Prep', 'Camo', 'Track', 'Sunshine', 'Lilac Night'];

export const EYE_COLORS: (string | null)[] = [null, '#ffb02e', '#2ec8d8', '#9b6bff', '#6fe05a', '#ff5fa2', '#b7d8ff', '#ff4b3a'];
export const EYE_NAMES = ['Natural', 'Amber', 'Lagoon', 'Violet', 'Lime', 'Rose', 'Frost', 'Ember'];

export const HATS = ['none', 'cap', 'beanie', 'cat', 'phones', 'bucket'] as const;
export const HAT_NAMES = ['None', 'Snapback', 'Beanie', 'Cat Ears', 'Headphones', 'Bucket Hat'];

export interface Style {
  base: number;
  hair: number;
  outfit: number;
  eyes: number;
  hat: number;
}

export const PRESETS: { name: string; blurb: string; style: Style }[] = [
  { name: 'Rookie', blurb: 'First day on the tower. Already plotting.', style: { base: 0, hair: 0, outfit: 0, eyes: 0, hat: 0 } },
  { name: 'Sakura', blurb: 'Pink from head to toe, shoves like a truck.', style: { base: 2, hair: 1, outfit: 3, eyes: 5, hat: 3 } },
  { name: 'Ronin', blurb: 'Street fit, crimson streak, zero patience.', style: { base: 1, hair: 7, outfit: 2, eyes: 7, hat: 1 } },
  { name: 'Frost', blurb: 'Silver hair, ice-cold flag holds.', style: { base: 3, hair: 6, outfit: 4, eyes: 6, hat: 4 } },
  { name: 'Moss', blurb: 'Camo and a bucket hat. Sets traps, waits.', style: { base: 4, hair: 3, outfit: 5, eyes: 4, hat: 5 } },
  { name: 'Nova', blurb: 'Gold hair, sunshine fit, loudest in the lobby.', style: { base: 0, hair: 5, outfit: 7, eyes: 1, hat: 2 } },
  { name: 'Kenji', blurb: 'Class rep. Shoves politely, then very hard.', style: { base: 5, hair: 0, outfit: 0, eyes: 2, hat: 0 } },
  { name: 'Blaze', blurb: 'Crimson hair, street fit, never looks down.', style: { base: 6, hair: 7, outfit: 2, eyes: 7, hat: 4 } },
  { name: 'Ghost', blurb: 'Silver hair, midnight track suit. Silent climber.', style: { base: 6, hair: 6, outfit: 6, eyes: 6, hat: 2 } },
];

/** Any value (even junk from the network) onto 0..n-1. */
const wrap = (v: unknown, n: number) => {
  const i = Math.round(Number(v));
  return Number.isFinite(i) ? ((i % n) + n) % n : 0;
};

export function resolveStyle(s: Partial<Style> = {}): Style {
  return {
    base: wrap(s.base ?? 0, BASES.length),
    hair: wrap(s.hair ?? 0, HAIR_COLORS.length),
    outfit: wrap(s.outfit ?? 0, OUTFITS.length),
    eyes: wrap(s.eyes ?? 0, EYE_COLORS.length),
    hat: wrap(s.hat ?? 0, HATS.length),
  };
}

/** Small seeded PRNG: same seed, same bot look on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomStyle(rng = Math.random): Style {
  const pick = (n: number) => Math.min(n - 1, Math.floor(rng() * n));
  return {
    base: pick(BASES.length),
    hair: rng() < 0.4 ? 0 : pick(HAIR_COLORS.length),
    outfit: rng() < 0.3 ? 0 : pick(OUTFITS.length),
    eyes: pick(EYE_COLORS.length),
    hat: rng() < 0.45 ? 0 : 1 + pick(HATS.length - 1),
  };
}

const STORAGE_KEY = 'flagtower.profile.v1';

export interface Profile {
  name: string;
  style: Style;
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile>;
      return { name: (p.name || 'You').slice(0, 14), style: resolveStyle(p.style) };
    }
  } catch {
    /* storage unavailable */
  }
  return { name: 'You', style: resolveStyle(PRESETS[0].style) };
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ applying

type MToonish = THREE.Material & {
  color?: THREE.Color;
  shadeColorFactor?: THREE.Color;
  userData: { origColor?: THREE.Color; origShade?: THREE.Color };
};

/** Recolour a material, remembering its original colours so "Natural" restores them. */
function tint(mat: MToonish, hex: string | null): void {
  if (!mat.color) return;
  mat.userData.origColor ??= mat.color.clone();
  if (mat.shadeColorFactor) mat.userData.origShade ??= mat.shadeColorFactor.clone();
  if (!hex) {
    mat.color.copy(mat.userData.origColor);
    if (mat.shadeColorFactor && mat.userData.origShade) mat.shadeColorFactor.copy(mat.userData.origShade);
    return;
  }
  // The textures carry the shading detail; normalise them toward white, then tint.
  const c = new THREE.Color(hex);
  const o = mat.userData.origColor;
  const lum = Math.max(0.25, 0.3 * o.r + 0.59 * o.g + 0.11 * o.b);
  mat.color.copy(c).multiplyScalar(Math.min(2.2, 0.85 / lum));
  if (mat.shadeColorFactor) mat.shadeColorFactor.copy(c).multiplyScalar(0.7);
}

/** Apply hair/outfit/eye colours and headgear to a VRM. Materials are cloned per character first. */
export function applyStyle(vrm: VRM, style: Style, headSocket: THREE.Object3D): void {
  const s = resolveStyle(style);
  const outfit = OUTFITS[s.outfit];
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => {
      const mat = m as MToonish;
      const n = mat.name;
      if (/_HAIR/.test(n)) tint(mat, HAIR_COLORS[s.hair]);
      else if (/EyeIris/.test(n)) tint(mat, EYE_COLORS[s.eyes]);
      else if (/Tops|Onepice/.test(n)) tint(mat, outfit ? outfit[0] : null);
      else if (/Bottoms/.test(n)) tint(mat, outfit ? outfit[1] : null);
      else if (/Shoes/.test(n)) tint(mat, outfit ? outfit[2] : null);
    });
  });
  headSocket.clear();
  const hat = makeHat(HATS[s.hat], HAIR_COLORS[s.hair] ?? '#3a3f4b');
  if (hat) headSocket.add(hat);
}

/** Give a freshly-parsed VRM its own material instances so tints don't leak between characters. */
export function cloneMaterials(vrm: VRM): void {
  const seen = new Map<THREE.Material, THREE.Material>();
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const clone = (m: THREE.Material) => {
      let c = seen.get(m);
      if (!c) {
        c = m.clone();
        seen.set(m, c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
  });
}

/** Procedural headgear, positioned on the head bone (y up, +z forward). */
function makeHat(kind: (typeof HATS)[number], accent: string): THREE.Object3D | null {
  if (kind === 'none') return null;
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, toon(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  switch (kind) {
    case 'cap': {
      const dome = add(new THREE.SphereGeometry(0.115, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), '#e2485a', 0, 0.105, -0.005);
      dome.scale.set(1.05, 0.85, 1.12);
      const brim = add(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 20, 1, false, -Math.PI / 2, Math.PI), '#f4f2ec', 0, 0.11, 0.06);
      brim.scale.set(1, 1, 1.25);
      break;
    }
    case 'beanie': {
      const b = add(new THREE.SphereGeometry(0.118, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), '#3a5683', 0, 0.09, -0.01);
      b.scale.set(1.04, 1.05, 1.1);
      add(new THREE.TorusGeometry(0.112, 0.018, 8, 24).rotateX(Math.PI / 2), '#f4f2ec', 0, 0.1, -0.01);
      add(new THREE.SphereGeometry(0.03, 10, 8), '#f4f2ec', 0, 0.225, -0.01);
      break;
    }
    case 'cat': {
      for (const s of [-1, 1]) {
        const ear = add(new THREE.ConeGeometry(0.045, 0.09, 4), accent, s * 0.07, 0.2, -0.01);
        ear.rotation.z = -s * 0.35;
        const inner = add(new THREE.ConeGeometry(0.026, 0.06, 4), '#ffc2d9', s * 0.068, 0.195, 0.012);
        inner.rotation.z = -s * 0.35;
      }
      break;
    }
    case 'phones': {
      const band = add(new THREE.TorusGeometry(0.12, 0.012, 8, 24, Math.PI), '#2b2e36', 0, 0.08, 0);
      band.rotation.y = Math.PI / 2;
      for (const s of [-1, 1]) {
        const cup = add(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 18), '#ff8fc0', s * 0.12, 0.06, 0);
        cup.rotation.z = Math.PI / 2;
      }
      break;
    }
    case 'bucket': {
      add(new THREE.CylinderGeometry(0.1, 0.12, 0.09, 20), '#cfbb92', 0, 0.16, -0.005);
      add(new THREE.CylinderGeometry(0.17, 0.17, 0.012, 24), '#cfbb92', 0, 0.115, -0.005);
      break;
    }
  }
  return g;
}
