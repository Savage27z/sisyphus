import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 3-band ramp for cel shading. */
const gradient = (() => {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

const cache = new Map<string, THREE.MeshToonMaterial>();
/** Materials handed out from the cache: shared by every map, so never freed with one. */
const shared = new WeakSet<THREE.Material>();
export const isSharedMaterial = (m: THREE.Material): boolean => shared.has(m);

/**
 * Surface detail drawn by the shader from world position (no textures to download, and it
 * lines up across merged geometry): grout, planks, carpet, stonework and so on. Only for
 * scenery that doesn't move — the pattern is fixed to the world, not the object.
 */
export type Pattern =
  | 'tile' // square tiles with grout (scale = tile size)
  | 'plank' // wooden boards (scale ≈ board length)
  | 'carpet' // mottled pile with a diamond lattice in the accent colour
  | 'stone' // ashlar blocks / brick (scale = block height × 1.6)
  | 'rock' // cliff strata and cracks; tops take the accent colour (grass)
  | 'concrete' // mottled with formwork seams
  | 'grass' // two-tone meadow with little flowers in the accent colour
  | 'sand' // fine grain and ripples
  | 'cobble' // rounded paving stones
  | 'wallpaper' // striped walls over a wood wainscot in the accent colour
  | 'wainscot' // plain walls over a wood wainscot in the accent colour
  | 'marble' // veined stone; floors in big slabs
  | 'panel'; // ceiling tiles / wall panels (grid of seams)

export interface ToonOpts {
  emissive?: number;
  opacity?: number;
  map?: THREE.Texture;
  double?: boolean;
  pattern?: Pattern;
  /** Second colour some patterns use (carpet lattice, wainscot, flowers, grassy tops). */
  accent?: number;
  /** Pattern size in metres (default 1). */
  scale?: number;
  /** A one-off material (its own texture, say): not cached, and freed with the map that made it. */
  fresh?: boolean;
}

/** Shared cel-shaded material. */
export function toon(color: THREE.ColorRepresentation, opts: ToonOpts = {}): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHex()}|${opts.emissive ?? 0}|${opts.opacity ?? 1}|${opts.map?.uuid ?? ''}|${opts.double ? 2 : 1}|${opts.pattern ?? ''}|${opts.accent ?? ''}|${opts.scale ?? 1}`;
  let m = opts.fresh ? undefined : cache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({
      color,
      gradientMap: gradient,
      map: opts.map ?? null,
      emissive: opts.emissive ?? 0x000000,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      depthWrite: (opts.opacity ?? 1) >= 1,
      side: opts.double ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (opts.pattern) addPattern(m, opts.pattern, opts.accent ?? 0xffffff, opts.scale ?? 1);
    if (!opts.fresh) {
      cache.set(key, m);
      shared.add(m);
    }
  }
  return m;
}

const PATTERN_LIB = /* glsl */ `
varying vec3 vPatPos;
varying vec3 vPatNormal;
uniform vec3 patAccent;
uniform float patScale;
float patHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float patNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(patHash(i), patHash(i + vec2(1.0, 0.0)), u.x), mix(patHash(i + vec2(0.0, 1.0)), patHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float patFbm(vec2 p) {
  return 0.5 * patNoise(p) + 0.3 * patNoise(p * 2.03 + 17.1) + 0.2 * patNoise(p * 4.11 + 31.7);
}
// 1 on a line of half-width w around every integer value of x. Anti-aliased, and lines thinner
// than a pixel fade out instead of shimmering.
float patLine(float x, float w) {
  float fw = max(fwidth(x), 1e-4);
  float d = abs(fract(x + 0.5) - 0.5);
  return (1.0 - smoothstep(w, w + fw * 1.5, d)) * clamp(w * 2.0 / fw, 0.0, 1.0);
}
float patGrid(vec2 uv, float w) {
  return max(patLine(uv.x, w), patLine(uv.y, w));
}
// Soft two-tone stripes of period 1 (anti-aliased).
float patStripe(float x) {
  float s = sin(x * 6.2831853);
  float fw = max(fwidth(s), 1e-4);
  return smoothstep(-fw, fw, s);
}
// Floor: world xz. Walls: along the wall, and up.
vec2 patUV(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.y > 0.6) return p.xz;
  return a.x > a.z ? vec2(p.z, p.y) : vec2(p.x, p.y);
}
`;

const PATTERN_BODY: Record<Pattern, string> = {
  tile: /* glsl */ `
    col *= 0.94 + 0.1 * patHash(floor(uv));
    col *= 0.96 + 0.06 * patNoise(p.xz * 0.15 + p.y);
    col = mix(col, col * 0.74, patGrid(uv, 0.022));`,
  plank: /* glsl */ `
    float row = floor(uv.y * 5.0);
    float u = uv.x * 0.6 + patHash(vec2(row, 7.0)) * 3.0;
    col *= 0.86 + 0.2 * patHash(vec2(row, floor(u)));
    col *= 0.95 + 0.06 * sin(uv.x * 9.0 + patNoise(vec2(uv.x * 0.8, row * 3.1)) * 5.0);
    col = mix(col, col * 0.62, max(patLine(uv.y * 5.0, 0.045), patLine(u, 0.012)));`,
  carpet: /* glsl */ `
    col *= 0.9 + 0.14 * patFbm(p.xz * 0.9 + p.y);
    if (isFlat) {
      float m = max(patLine((uv.x + uv.y) * 0.5, 0.018), patLine((uv.x - uv.y) * 0.5, 0.018));
      col = mix(col, patAccent, m * 0.6);
    }`,
  stone: /* glsl */ `
    float row = floor(uv.y * 1.6);
    float bw = 1.0 + 0.7 * patHash(vec2(row, 3.0));
    float u = uv.x / bw + patHash(vec2(row, 9.0));
    col *= 0.8 + 0.28 * patHash(vec2(floor(u), row));
    col *= 0.9 + 0.15 * patFbm(uv * 1.7);
    col *= 0.94 + 0.08 * fract(uv.y * 1.6);
    col = mix(col, col * 0.58, max(patLine(uv.y * 1.6, 0.04), patLine(u, 0.04 / bw)));`,
  rock: /* glsl */ `
    // Chunky layered slabs: Voronoi cells stretched sideways, lit on top, dark cracks between.
    vec2 hz = isFlat ? p.xz : (abs(n.x) > abs(n.z) ? p.zy : p.xy);
    vec2 g = vec2(hz.x / 2.4, p.y / 1.35) / patScale;
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float f1 = 8.0;
    float f2 = 8.0;
    vec2 id = vec2(0.0);
    vec2 rel = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 b = vec2(float(x), float(y));
        vec2 r = b + vec2(patHash(gi + b), patHash(gi + b + 19.19)) * 0.85 + 0.075 - gf;
        float d = length(r);
        if (d < f1) { f2 = f1; f1 = d; id = gi + b; rel = r; } else if (d < f2) { f2 = d; }
      }
    }
    float e = f2 - f1;
    float fwe = max(fwidth(e), 1e-4);
    col *= 0.8 + 0.26 * patHash(id);
    col *= 0.92 + 0.12 * patHash(vec2(floor(p.y / 4.5), 5.0));
    col *= 1.05 - 0.2 * clamp(rel.y + 0.5, 0.0, 1.0);
    col *= 0.95 + 0.08 * patNoise(hz * 1.7 + p.y);
    float crack = (1.0 - smoothstep(0.04, 0.04 + fwe * 1.5, e)) * clamp(0.08 / fwe, 0.0, 1.0);
    col = mix(col, col * 0.55, crack);
    if (n.y > 0.6) col = patAccent * (0.82 + 0.3 * patFbm(p.xz * 0.4));`,
  concrete: /* glsl */ `
    col *= 0.88 + 0.18 * patFbm(uv * 0.35 + p.y * 0.2);
    col *= 0.97 + 0.05 * (patHash(floor(uv * 30.0)) - 0.5);
    col = mix(col, col * 0.8, patGrid(uv / 3.0, 0.004));`,
  grass: /* glsl */ `
    col *= 0.78 + 0.38 * patFbm(p.xz * 0.18);
    col *= 0.94 + 0.12 * patHash(floor(p.xz * 6.0));
    vec2 fc = floor(p.xz * 1.3);
    if (patHash(fc + 3.7) > 0.9) {
      vec2 o = vec2(patHash(fc + 1.1), patHash(fc + 2.3)) * 0.6 + 0.2;
      float dd = length(fract(p.xz * 1.3) - o);
      float fwv = max(fwidth(p.x * 1.3), 1e-4);
      col = mix(col, patAccent, (1.0 - smoothstep(0.08, 0.08 + fwv * 1.5, dd)) * clamp(0.16 / fwv, 0.0, 1.0));
    }`,
  sand: /* glsl */ `
    col *= 0.9 + 0.12 * patFbm(p.xz * 0.3);
    col *= 0.97 + 0.06 * patHash(floor(p.xz * 14.0));
    col *= 0.97 + 0.03 * sin(p.x * 2.1 + p.z * 1.3 + patNoise(p.xz * 0.2) * 6.0);`,
  cobble: /* glsl */ `
    vec2 g = uv * 1.6;
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float f1 = 8.0;
    float f2 = 8.0;
    vec2 id = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 b = vec2(float(x), float(y));
        vec2 o = vec2(patHash(gi + b), patHash(gi + b + 19.19)) * 0.8 + 0.1;
        float d = length(b + o - gf);
        if (d < f1) { f2 = f1; f1 = d; id = gi + b; } else if (d < f2) { f2 = d; }
      }
    }
    float e = f2 - f1;
    float fwe = max(fwidth(e), 1e-4);
    col *= 0.84 + 0.24 * patHash(id);
    col *= 0.94 + 0.1 * patNoise(p.xz * 0.7);
    float edge = (1.0 - smoothstep(0.07, 0.07 + fwe * 1.5, e)) * clamp(0.14 / fwe, 0.0, 1.0);
    col = mix(col, col * 0.6, edge);`,
  wallpaper: /* glsl */ `
    if (!isFlat) {
      float ly = mod(p.y + 0.001, 6.0);
      col *= mix(1.0, 0.86, patStripe(uv.x * 1.6));
      vec3 wood = patAccent * (0.9 + 0.12 * sin(uv.x * 7.0 + patNoise(vec2(uv.x, ly * 6.0)) * 4.0));
      wood = mix(wood, wood * 0.7, patLine(uv.x / 1.2, 0.012));
      col = ly < 1.1 ? wood : col;
      col = mix(col, patAccent * 1.25, 1.0 - smoothstep(0.04, 0.04 + fwidth(ly) * 1.5, abs(ly - 1.12)));
      col = ly < 0.14 ? patAccent * 0.6 : col;
    }`,
  wainscot: /* glsl */ `
    if (!isFlat) {
      float ly = mod(p.y + 0.001, 6.0);
      col *= 0.97 + 0.05 * patNoise(uv * 0.5);
      vec3 wood = patAccent * (0.92 + 0.1 * sin(uv.x * 7.0 + patNoise(vec2(uv.x, ly * 6.0)) * 4.0));
      wood = mix(wood, wood * 0.72, patLine(uv.x / 1.4, 0.01));
      col = ly < 1.0 ? wood : col;
      col = mix(col, patAccent * 1.2, 1.0 - smoothstep(0.035, 0.035 + fwidth(ly) * 1.5, abs(ly - 1.02)));
      col = ly < 0.12 ? patAccent * 0.62 : col;
    }`,
  marble: /* glsl */ `
    float vn = patFbm(vec2(p.x + p.z, p.y) * 0.35 + p.zx * 0.15);
    float vein = abs(sin(p.x * 0.45 + p.z * 0.3 + p.y * 0.35 + vn * 8.0));
    float vw = fwidth(vein) * 1.5 + 0.06;
    col *= 0.95 + 0.07 * patNoise(p.xz * 0.5 + p.y);
    col = mix(col * 0.84, col, smoothstep(0.0, vw, vein));
    if (isFlat) col = mix(col, col * 0.78, patGrid(uv / 2.0, 0.006));`,
  panel: /* glsl */ `
    col *= 0.97 + 0.04 * patHash(floor(uv / 1.2));
    col = mix(col, col * 0.8, patGrid(uv / 1.2, 0.012));`,
};

function addPattern(m: THREE.MeshToonMaterial, pattern: Pattern, accent: number, scale: number): void {
  const accentColor = new THREE.Color(accent);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.patAccent = { value: accentColor };
    shader.uniforms.patScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPatPos;\nvarying vec3 vPatNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 patWorld = vec4(transformed, 1.0);
        vec3 patN = objectNormal;
        #ifdef USE_INSTANCING
          patWorld = instanceMatrix * patWorld;
          patN = mat3(instanceMatrix) * patN;
        #endif
        vPatPos = (modelMatrix * patWorld).xyz;
        vPatNormal = mat3(modelMatrix) * patN;`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${PATTERN_LIB}`).replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec3 p = vPatPos;
        vec3 n = normalize(vPatNormal);
        bool isFlat = abs(n.y) > 0.6;
        vec2 uv = patUV(p, n) / patScale;
        vec3 col = diffuseColor.rgb;
        ${PATTERN_BODY[pattern]}
        diffuseColor.rgb = col;
      }`,
    );
  };
  m.customProgramCacheKey = () => `pattern:${pattern}`;
}

export const OUTLINE = new THREE.LineBasicMaterial({ color: 0x2c2633, transparent: true, opacity: 0.55 });

interface Bucket {
  mat: THREE.Material;
  cast: boolean;
  receive: boolean;
  geos: THREE.BufferGeometry[];
}

interface AddOpts {
  cast?: boolean;
  receive?: boolean;
  outline?: boolean;
}

/**
 * Collects static scenery and merges it into one mesh per material, plus one
 * outline mesh — keeps a 10-floor building to a handful of draw calls.
 */
/** One unit box (and its outline) that every batched box is a scaled copy of. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const UNIT_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1), 30);

export class StaticBatcher {
  private readonly buckets = new Map<string, Bucket>();
  private readonly edges: THREE.BufferGeometry[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly size = new THREE.Vector3();

  add(geo: THREE.BufferGeometry, mat: THREE.Material, matrix: THREE.Matrix4, opts: AddOpts = {}, edges?: THREE.BufferGeometry): void {
    const cast = opts.cast ?? true;
    const receive = opts.receive ?? true;
    const key = `${mat.uuid}|${cast}|${receive}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, cast, receive, geos: [] };
      this.buckets.set(key, b);
    }
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    b.geos.push(g);
    if (opts.outline ?? true) this.edges.push((edges ? edges.clone() : new THREE.EdgesGeometry(geo, 30)).applyMatrix4(matrix));
  }

  box(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion, mat: THREE.Material, opts: AddOpts = {}): void {
    // (A zero-thickness box would make a singular normal matrix.)
    this.size.set(Math.max(half.x * 2, 1e-4), Math.max(half.y * 2, 1e-4), Math.max(half.z * 2, 1e-4));
    this.add(UNIT_BOX, mat, this.m.compose(center, quat, this.size), opts, UNIT_EDGES);
  }

  flush(scene: THREE.Object3D): void {
    for (const b of this.buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(b.geos), b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      scene.add(mesh);
    }
    if (this.edges.length) scene.add(new THREE.LineSegments(mergeGeometries(this.edges), OUTLINE));
    this.buckets.clear();
    this.edges.length = 0;
  }
}

/** Canvas texture helper. */
export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
