import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AnimeRig, retargetClips } from './rig';
import { BASES, applyStyle, cloneMaterials, type Style } from './style';
import { cloneVRM, mergeSkinnedMeshes } from './vrmclone';

export interface Assets {
  /** Source of the Mixamo Idle/Walk/Run clips (the model itself isn't shown). */
  anim: GLTF;
  /** Raw VRM files per base character, parsed on demand into fresh instances. */
  vrmFiles: ArrayBuffer[];
}

const BASE = import.meta.env.BASE_URL + 'assets/models/';

async function fetchWithProgress(url: string, onBytes: (n: number) => void, onSize: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to load ${url}: ${res.status}`);
  onSize(Number(res.headers.get('content-length')) || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** Downloads everything; `onProgress` gets 0..1. */
export async function loadAssets(onProgress: (fraction: number) => void): Promise<Assets> {
  const files = BASES.length + 1;
  let bytes = 0;
  let known = 0;
  let sized = 0;
  // Until every file has reported its size, assume the rest are about average.
  const tick = (n: number) => {
    bytes += n;
    const total = sized ? (known / sized) * files : 36e6;
    onProgress(Math.min(1, bytes / Math.max(total, bytes)));
  };
  const size = (n: number) => {
    if (!n) return;
    known += n;
    sized++;
  };
  const animP = fetchWithProgress(BASE + 'Soldier.glb', tick, size).then((buf) => new GLTFLoader().parseAsync(buf, BASE));
  const vrmP = Promise.all(BASES.map((b) => fetchWithProgress(`${BASE}anime/${b}.vrm`, tick, size)));
  const [anim, vrmFiles] = await Promise.all([animP, vrmP]);
  return { anim, vrmFiles };
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

/** One pristine parse per base fighter; every rig is a cheap copy of it. */
const templates = new Map<number, Promise<{ vrm: VRM; clips: ReturnType<typeof retargetClips> }>>();

function template(assets: Assets, base: number) {
  let t = templates.get(base);
  if (!t) {
    t = loader.parseAsync(assets.vrmFiles[base].slice(0), BASE).then((gltf) => {
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      mergeSkinnedMeshes(vrm);
      VRMUtils.rotateVRM0(vrm);
      // Clips target bones by name, so every copy of this base can share them.
      return { vrm, clips: retargetClips(assets.anim, vrm) };
    });
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
