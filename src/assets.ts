import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AnimeRig, retargetClips } from './rig';
import { BASES, applyStyle, cloneMaterials, type Style } from './style';
import { cloneVRM, mergeSkinnedMeshes } from './vrmclone';

export interface Assets {
  /** Source of the Mixamo Idle/Walk/Run clips (the model itself isn't shown). */
  anim: GLTF;
  /** A base character's VRM file; downloads it the first time it's asked for. */
  vrmFile(base: number): Promise<ArrayBuffer>;
  /** Download the characters nobody's using yet, one at a time, in the background. */
  prefetchAll(): void;
}

const BASE = import.meta.env.BASE_URL + 'assets/models/';

async function fetchWithProgress(url: string, onBytes?: (n: number) => void, onSize?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to load ${url}: ${res.status}`);
  onSize?.(Number(res.headers.get('content-length')) || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes?.(value.length);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

const isGlb = (b: ArrayBuffer) => {
  const h = new Uint8Array(b, 0, Math.min(4, b.byteLength));
  return h[0] === 0x67 && h[1] === 0x6c && h[2] === 0x54 && h[3] === 0x46; // "glTF"
};

/**
 * A model file. The build ships gzipped copies (static hosts compress code but not 3D models,
 * and these shrink to under a third), unpacked here; the plain file is the fallback (dev server,
 * older browsers).
 */
async function fetchModel(url: string, onBytes?: (n: number) => void, onSize?: (n: number) => void): Promise<ArrayBuffer> {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const packed = await fetchWithProgress(`${url}.gz`, onBytes, onSize);
      const h = new Uint8Array(packed, 0, Math.min(2, packed.byteLength));
      if (h[0] === 0x1f && h[1] === 0x8b) {
        return await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      if (isGlb(packed)) return packed; // the host unpacked it already
    } catch {
      /* no packed copy: use the plain file */
    }
  }
  return fetchWithProgress(url, onBytes, onSize);
}

/**
 * Downloads what the first screen needs: the animations and the base characters in `bases`.
 * The rest come later (on demand, or via prefetchAll). `onProgress` gets 0..1.
 */
export async function loadAssets(bases: number[], onProgress: (fraction: number) => void): Promise<Assets> {
  const files = bases.length + 1;
  let bytes = 0;
  let known = 0;
  let sized = 0;
  // Until every file has reported its size, assume the rest are about average.
  const tick = (n: number) => {
    bytes += n;
    const total = sized ? (known / sized) * files : files * 1.4e6;
    onProgress(Math.min(1, bytes / Math.max(total, bytes)));
  };
  const size = (n: number) => {
    if (!n) return;
    known += n;
    sized++;
  };
  const vrm = new Map<number, Promise<ArrayBuffer>>();
  const vrmFile = (base: number, track = false): Promise<ArrayBuffer> => {
    let p = vrm.get(base);
    if (!p) {
      p = fetchModel(`${BASE}anime/${BASES[base]}.vrm`, track ? tick : undefined, track ? size : undefined);
      // A failed download can be retried next time it's needed.
      p.catch(() => vrm.delete(base));
      vrm.set(base, p);
    }
    return p;
  };
  const animP = fetchModel(BASE + 'Soldier.glb', tick, size).then((buf) => new GLTFLoader().parseAsync(buf, BASE));
  const [anim] = await Promise.all([animP, ...[...new Set(bases)].map((b) => vrmFile(b, true))]);
  let prefetching = false;
  return {
    anim,
    vrmFile: (base) => vrmFile(base),
    prefetchAll() {
      if (prefetching) return;
      prefetching = true;
      void (async () => {
        for (let b = 0; b < BASES.length; b++) await vrmFile(b).catch(() => undefined);
      })();
    },
  };
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

/** One pristine parse per base fighter; every rig is a cheap copy of it. */
const templates = new Map<number, Promise<{ vrm: VRM; clips: ReturnType<typeof retargetClips> }>>();

function template(assets: Assets, base: number) {
  let t = templates.get(base);
  if (!t) {
    t = assets.vrmFile(base).then((file) => loader.parseAsync(file.slice(0), BASE)).then((gltf) => {
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      mergeSkinnedMeshes(vrm);
      VRMUtils.rotateVRM0(vrm);
      // Clips target bones by name, so every copy of this base can share them.
      return { vrm, clips: retargetClips(assets.anim, vrm) };
    });
    t.catch(() => templates.delete(base));
    templates.set(base, t);
  }
  return t;
}

/** Is this base fighter already parsed (so a rig for it is instant)? */
export function hasTemplate(base: number): boolean {
  return templates.has(base);
}

/** Build a styled, animated rig. The first rig of a base parses its VRM; the rest are copies. */
export async function createRig(assets: Assets, style: Style): Promise<AnimeRig> {
  const t = await template(assets, style.base);
  const vrm = cloneVRM(t.vrm);
  cloneMaterials(vrm);
  const rig = new AnimeRig(vrm, t.clips);
  rig.base = style.base;
  applyStyle(vrm, style, rig.headSocket);
  return rig;
}
