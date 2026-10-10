import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GunKind, WeaponKind } from './combat';

export interface RigInput {
  dt: number;
  time: number;
  speed: number;
  grounded: boolean;
  vy: number;
  stunned: boolean;
  rooted: boolean;
  /** 1 → 0 over the course of an attack. */
  swing: number;
  /** The gun in hand. */
  weapon: GunKind;
  /** What the latest swing or shot was. */
  swingKind: WeaponKind;
  /** Gun raised (just fired). */
  aiming: boolean;
  happy: boolean;
  /** Seconds since last on the ground (debounces stair steps). */
  airTime: number;
  /** Fall height of a landing that happened this frame (0 otherwise). */
  landed: number;
}

export interface Clips {
  idle: THREE.AnimationClip;
  walk: THREE.AnimationClip;
  run: THREE.AnimationClip;
}

const MIXAMO_TO_VRM: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

/**
 * Retarget the Mixamo clips that ship with Soldier.glb onto a VRM's normalized
 * humanoid (the standard three-vrm technique: express each keyframe relative to
 * the source T-pose in world space).
 */
export function retargetClips(src: GLTF, vrm: VRM): Clips {
  const rig = SkeletonUtils.clone(src.scene);
  const mixer = new THREE.AnimationMixer(rig);
  const tpose = THREE.AnimationClip.findByName(src.animations, 'TPose')!;
  mixer.clipAction(tpose).play();
  mixer.update(0);
  rig.updateWorldMatrix(true, true);

  const toe = rig.getObjectByName('mixamorigLeftToeBase')!.getWorldPosition(new THREE.Vector3());
  const foot = rig.getObjectByName('mixamorigLeftFoot')!.getWorldPosition(new THREE.Vector3());
  const srcFacesNegZ = toe.z < foot.z;
  const vrmFacesNegZ = vrm.meta.metaVersion === '0';
  const flip = srcFacesNegZ !== vrmFacesNegZ;

  const srcHips = rig.getObjectByName('mixamorigHips')!;
  const srcHipsY = srcHips.getWorldPosition(new THREE.Vector3()).y;
  const vrmHips = vrm.humanoid.getNormalizedBoneNode('hips')!;
  const vrmHipsRest = vrmHips.position.clone();
  const hipsParentMatrix = srcHips.parent!.matrixWorld.clone();

  const rest = new THREE.Quaternion();
  const parentRest = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();

  const convert = (name: string): THREE.AnimationClip => {
    const clip = THREE.AnimationClip.findByName(src.animations, name)!;
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const [boneName, prop] = track.name.split('.');
      const vrmBone = MIXAMO_TO_VRM[boneName];
      const node = vrmBone ? vrm.humanoid.getNormalizedBoneNode(vrmBone) : null;
      const srcNode = rig.getObjectByName(boneName);
      if (!node || !srcNode) continue;
      srcNode.getWorldQuaternion(rest).invert();
      srcNode.parent!.getWorldQuaternion(parentRest);
      if (prop === 'quaternion') {
        const values = new Float32Array(track.values.length);
        for (let i = 0; i < track.values.length; i += 4) {
          q.fromArray(track.values, i).premultiply(parentRest).multiply(rest);
          if (flip) {
            q.x = -q.x;
            q.z = -q.z;
          }
          q.toArray(values, i);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, Array.from(track.times), Array.from(values)));
      } else if (prop === 'position' && vrmBone === 'hips') {
        // Keep the run in place; only carry the vertical bob, scaled to the VRM's hip height.
        const values: number[] = [];
        for (let i = 0; i < track.values.length; i += 3) {
          v.fromArray(track.values, i).applyMatrix4(hipsParentMatrix);
          values.push(vrmHipsRest.x, (v.y / srcHipsY) * vrmHipsRest.y, vrmHipsRest.z);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, Array.from(track.times), values));
      }
    }
    return new THREE.AnimationClip(name, clip.duration, tracks);
  };
  return { idle: convert('Idle'), walk: convert('Walk'), run: convert('Run') };
}

// ---------------------------------------------------------------------------
// Pose system. Poses are authored as *bone directions in character space*
// (+Z forward, +Y up, +X = the character's left). Each direction is turned into
// a world rotation from the VRM T-pose, so a pose looks the same on every model
// and every base clip. Layers blend by priority on top of Idle/Walk/Run.
// ---------------------------------------------------------------------------

type PB = 'spine' | 'neck' | 'lUpper' | 'lLower' | 'rUpper' | 'rLower' | 'lThigh' | 'lShin' | 'rThigh' | 'rShin';
type Pose = Partial<Record<PB, THREE.Vector3>>;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

const POSE_BONES: Record<PB, { bone: VRMHumanBoneName; rest: THREE.Vector3 }> = {
  spine: { bone: 'spine', rest: V(0, 1, 0) },
  neck: { bone: 'neck', rest: V(0, 1, 0) },
  lUpper: { bone: 'leftUpperArm', rest: V(1, 0, 0) },
  lLower: { bone: 'leftLowerArm', rest: V(1, 0, 0) },
  rUpper: { bone: 'rightUpperArm', rest: V(-1, 0, 0) },
  rLower: { bone: 'rightLowerArm', rest: V(-1, 0, 0) },
  lThigh: { bone: 'leftUpperLeg', rest: V(0, -1, 0) },
  lShin: { bone: 'leftLowerLeg', rest: V(0, -1, 0) },
  rThigh: { bone: 'rightUpperLeg', rest: V(0, -1, 0) },
  rShin: { bone: 'rightLowerLeg', rest: V(0, -1, 0) },
};
const ORDER: PB[] = ['spine', 'neck', 'lUpper', 'lLower', 'rUpper', 'rLower', 'lThigh', 'lShin', 'rThigh', 'rShin'];
const LEGS: PB[] = ['lThigh', 'lShin', 'rThigh', 'rShin'];

interface Action {
  dur: number;
  fadeIn: number;
  fadeOut: number;
  /** Scale on leg bones so running legs still read through upper-body actions. */
  legs: number;
  /** How far the body drops (m) at full weight — bent knees. */
  crouch: number;
  keys: { t: number; pose: Pose }[];
}

const LUNGE: Pose = { lThigh: V(0.05, -0.75, 0.65), lShin: V(0, -1, 0.1), rThigh: V(-0.05, -0.8, -0.55), rShin: V(0, -0.75, -0.65) };

const SHOVE_WIND: Pose = {
  spine: V(0, 1, -0.2),
  lUpper: V(0.35, -0.7, -0.45),
  lLower: V(0.15, 0.15, 1),
  rUpper: V(-0.35, -0.7, -0.45),
  rLower: V(-0.15, 0.15, 1),
};
const SHOVE_HIT: Pose = {
  spine: V(0, 1, 0.42),
  lUpper: V(0.15, 0.12, 1),
  lLower: V(0.05, 0.15, 1),
  rUpper: V(-0.15, 0.12, 1),
  rLower: V(-0.05, 0.15, 1),
  ...LUNGE,
};
const STAB_WIND: Pose = { spine: V(0, 1, -0.05), rUpper: V(-0.45, -0.7, -0.5), rLower: V(-0.1, 0.1, 1), lUpper: V(0.3, -0.9, 0.2), lLower: V(0.2, -0.4, 0.9) };
const STAB_HIT: Pose = { spine: V(0, 1, 0.32), rUpper: V(-0.1, 0.1, 1), rLower: V(-0.05, 0.08, 1), lUpper: V(0.45, -0.75, -0.45), lLower: V(0.35, -0.8, -0.5), ...LUNGE };
const HAMMER_UP: Pose = { spine: V(0, 1, -0.25), lUpper: V(0.1, 0.85, -0.3), lLower: V(-0.05, 0.6, -0.8), rUpper: V(-0.1, 0.85, -0.3), rLower: V(0.05, 0.6, -0.8) };
const HAMMER_HIT: Pose = { spine: V(0, 0.85, 0.55), lUpper: V(0.12, -0.35, 1), lLower: V(-0.1, -0.55, 1), rUpper: V(-0.12, -0.35, 1), rLower: V(0.1, -0.55, 1), ...LUNGE };
const LANDING: Pose = {
  spine: V(0, 1, 0.35),
  lThigh: V(0.1, -0.7, 0.7),
  lShin: V(0.05, -1, -0.15),
  rThigh: V(-0.1, -0.7, 0.7),
  rShin: V(-0.05, -1, -0.15),
  lUpper: V(0.55, -0.75, 0.3),
  rUpper: V(-0.55, -0.75, 0.3),
};

const ACTIONS = {
  shove: { dur: 0.48, fadeIn: 0.04, fadeOut: 0.14, legs: 0.7, crouch: 0.08, keys: [{ t: 0, pose: SHOVE_WIND }, { t: 0.09, pose: SHOVE_WIND }, { t: 0.18, pose: SHOVE_HIT }, { t: 0.48, pose: SHOVE_HIT }] },
  stab: { dur: 0.38, fadeIn: 0.03, fadeOut: 0.12, legs: 0.6, crouch: 0.06, keys: [{ t: 0, pose: STAB_WIND }, { t: 0.11, pose: STAB_HIT }, { t: 0.38, pose: STAB_HIT }] },
  hammer: { dur: 0.62, fadeIn: 0.05, fadeOut: 0.16, legs: 0.7, crouch: 0.12, keys: [{ t: 0, pose: HAMMER_UP }, { t: 0.14, pose: HAMMER_UP }, { t: 0.26, pose: HAMMER_HIT }, { t: 0.62, pose: HAMMER_HIT }] },
  recoil: { dur: 0.25, fadeIn: 0.01, fadeOut: 0.2, legs: 0, crouch: 0, keys: [{ t: 0, pose: { spine: V(0, 1, -0.22) } }, { t: 0.25, pose: { spine: V(0, 1, -0.22) } }] },
  land: { dur: 0.3, fadeIn: 0.02, fadeOut: 0.2, legs: 1, crouch: 0.22, keys: [{ t: 0, pose: LANDING }, { t: 0.3, pose: LANDING }] },
} satisfies Record<string, Action>;
type ActionName = keyof typeof ACTIONS;

function airPose(): Pose {
  return {
    spine: V(0, 1, 0.08),
    lThigh: V(0.05, -0.35, 0.95),
    lShin: V(0, -1, -0.15),
    rThigh: V(-0.05, -0.95, -0.3),
    rShin: V(0, -0.75, -0.65),
    rUpper: V(-0.35, -0.35, 0.85),
    rLower: V(-0.15, 0.25, 0.95),
    lUpper: V(0.45, -0.55, -0.7),
    lLower: V(0.35, -0.7, -0.6),
  };
}

/** Long fall: arms up and out, legs loose, looking down at the drop. Gentle sway, not a windmill. */
function fallPose(t: number): Pose {
  const s1 = Math.sin(t * 5);
  const s2 = Math.sin(t * 5 + 1.5);
  return {
    spine: V(0, 1, -0.12),
    neck: V(0, 1, 0.3),
    lUpper: V(0.75, 0.6, 0.1 + 0.2 * s1),
    lLower: V(0.55, 0.8, 0.15 * s2),
    rUpper: V(-0.75, 0.6, 0.1 - 0.2 * s1),
    rLower: V(-0.55, 0.8, -0.15 * s2),
    lThigh: V(0.2, -0.9, 0.3 + 0.25 * s1),
    lShin: V(0.1, -1, -0.35),
    rThigh: V(-0.2, -0.9, 0.1 - 0.25 * s1),
    rShin: V(-0.1, -1, -0.45),
  };
}

/** Knocked flat (the Character tips the whole body back): limbs thrown out. */
function flopPose(t: number): Pose {
  const s = Math.sin(t * 8) * 0.12;
  return {
    neck: V(0, 1, -0.35),
    lUpper: V(0.9, 0.15 + s, -0.35),
    lLower: V(0.85, 0.45, -0.2),
    rUpper: V(-0.9, 0.15 - s, -0.35),
    rLower: V(-0.85, 0.45, -0.2),
    lThigh: V(0.12, -0.85, 0.45),
    lShin: V(0.05, -1, -0.25),
    rThigh: V(-0.1, -1, 0.08),
    rShin: V(-0.05, -1, 0),
  };
}

function rootPose(t: number): Pose {
  const s = Math.sin(t * 9) * 0.25;
  return {
    spine: V(s, 1, 0.45),
    lThigh: V(0.1, -0.65, 0.75),
    lShin: V(0.05, -1, -0.2),
    rThigh: V(-0.1, -0.65, 0.75),
    rShin: V(-0.05, -1, -0.2),
    lUpper: V(0.25, -0.8, 0.55),
    lLower: V(0.1, -0.95, 0.3),
    rUpper: V(-0.25, -0.8, 0.55),
    rLower: V(-0.1, -0.95, 0.3),
  };
}

function cheerPose(t: number): Pose {
  const b = Math.sin(t * 8) * 0.12;
  return { rUpper: V(-0.25, 0.95, 0.1), rLower: V(-0.1, 1, 0.15), lUpper: V(0.35 + b, 0.9, 0.1), lLower: V(0.2, 1, 0.1) };
}

const AIM: Pose = { rUpper: V(-0.3, -0.12, 1), rLower: V(0.35, 0.06, 1), lUpper: V(0.22, -0.18, 1), lLower: V(-0.4, 0, 1) };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _hq = new THREE.Quaternion();
const _sq = new THREE.Quaternion();
const clamp = THREE.MathUtils.clamp;
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Animated anime character (VRM): retargeted Idle/Walk/Run for locomotion, plus
 * authored pose layers (jump, fall, knockdown, bear trap, cheer, shotgun aim) and
 * one-shot actions (shove, stab, hammer, recoil, landing). Also drives the face.
 */
export class AnimeRig {
  /** Which base fighter this rig was built from (see style.ts BASES). */
  base = 0;
  /** Character-space root: +Z is forward. */
  readonly object = new THREE.Group();
  /** Weapon attach point (meters, +Z = blade/barrel direction). */
  readonly socket = new THREE.Group();
  /** Attach point for headgear (on the head bone). */
  readonly headSocket = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly idle: THREE.AnimationAction;
  private readonly walk: THREE.AnimationAction;
  private readonly run: THREE.AnimationAction;
  private readonly nodes = {} as Record<PB, THREE.Object3D>;
  private readonly rawHand: THREE.Object3D;
  private readonly frameQuat = new THREE.Quaternion();
  private readonly grip = new THREE.Quaternion();
  private readonly w = { idle: 1, walk: 0, run: 0, air: 0, fall: 0, flop: 0, aim: 0, root: 0, cheer: 0 };
  private action: { def: Action; t: number } | null = null;
  private prevSwing = 0;
  private blinkT = 2 + Math.random() * 3;
  private readonly face = { aa: 0, angry: 0, sad: 0, happy: 0 };
  private readonly acc = new Map<PB, { dir: THREE.Vector3; w: number }>();
  private readonly outlines: THREE.Material[] = [];
  private detailed = true;

  constructor(readonly vrm: VRM, clips: Clips) {
    this.object.add(vrm.scene);
    vrm.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // Only solid parts cast shadows; cut-out/transparent cards would shadow as full quads.
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.castShadow = mats.every((mt) => !mt.transparent && !(mt.alphaTest > 0));
      m.userData.canCast = m.castShadow;
      m.frustumCulled = false;
      // MToon outlines are a second material on the same mesh (an extra draw call).
      if (Array.isArray(m.material)) for (const mt of m.material.slice(1)) this.outlines.push(mt);
    });
    for (const pb of ORDER) {
      const n = vrm.humanoid.getNormalizedBoneNode(POSE_BONES[pb].bone);
      if (!n) throw new Error(`VRM missing bone ${POSE_BONES[pb].bone}`);
      this.nodes[pb] = n;
      this.acc.set(pb, { dir: new THREE.Vector3(), w: 0 });
    }
    this.rawHand = vrm.humanoid.getRawBoneNode('rightHand')!;
    vrm.humanoid.getRawBoneNode('head')!.add(this.headSocket);
    // VRM 0.x bones are authored facing -Z; turn headgear around to match.
    if (vrm.meta.metaVersion === '0') this.headSocket.rotation.y = Math.PI;

    // Grip: with the right arm pointing straight forward, the socket faces forward.
    this.object.updateWorldMatrix(true, true);
    this.applyPose({ rUpper: V(0, 0, 1), rLower: V(0, 0, 1) }, 1);
    vrm.humanoid.update();
    this.object.updateWorldMatrix(true, true);
    this.rawHand.getWorldQuaternion(_hq);
    this.grip.copy(_hq.invert());
    this.nodes.rUpper.quaternion.identity();
    this.nodes.rLower.quaternion.identity();
    vrm.humanoid.update();
    this.rawHand.add(this.socket);
    this.socket.quaternion.copy(this.grip);

    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.idle = this.mixer.clipAction(clips.idle);
    this.walk = this.mixer.clipAction(clips.walk);
    this.run = this.mixer.clipAction(clips.run);
    for (const a of [this.idle, this.walk, this.run]) {
      a.play();
      a.setEffectiveWeight(0);
    }
    this.idle.setEffectiveWeight(1);
    this.mixer.update(Math.random() * 2);
  }

  /**
   * Near the camera: shadows, outlines, hair physics and the face. Further out those are
   * dropped (they cost a lot of draw calls and CPU for 24 fighters on a laptop GPU).
   */
  setDetail(full: boolean): void {
    if (full === this.detailed) return;
    this.detailed = full;
    this.vrm.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = full && !!m.userData.canCast;
    });
    for (const mt of this.outlines) mt.visible = full;
    // Hair has been frozen while we were far away; settle it where it is now.
    if (full) this.vrm.springBoneManager?.reset();
  }

  /** Write a pose straight onto the bones (used for the grip setup). */
  private applyPose(pose: Pose, w: number): void {
    this.acc.forEach((a) => (a.w = 0));
    for (const pb of ORDER) {
      const d = pose[pb];
      if (d) this.acc.set(pb, { dir: d.clone(), w });
    }
    this.solve();
  }

  /** Turn the accumulated per-bone directions into local rotations, parents first. */
  private solve(): void {
    this.object.updateWorldMatrix(true, false);
    this.object.getWorldQuaternion(this.frameQuat);
    this.vrm.scene.getWorldQuaternion(_sq);
    for (const pb of ORDER) {
      const a = this.acc.get(pb)!;
      if (a.w < 0.001) continue;
      const node = this.nodes[pb];
      node.parent!.updateWorldMatrix(true, false);
      _a.copy(POSE_BONES[pb].rest).applyQuaternion(this.frameQuat);
      _b.copy(a.dir).applyQuaternion(this.frameQuat);
      _q.setFromUnitVectors(_a, _b).multiply(_sq);
      node.parent!.getWorldQuaternion(_pq);
      _q.premultiply(_pq.invert());
      node.quaternion.slerp(_q, Math.min(1, a.w));
      node.updateMatrixWorld(true);
    }
  }

  /** Blend a layer under everything already accumulated (higher priority first). */
  private layer(pose: Pose, weight: number, legScale = 1): void {
    if (weight < 0.001) return;
    for (const pb of ORDER) {
      const d = pose[pb];
      if (!d) continue;
      const a = this.acc.get(pb)!;
      const lw = weight * (LEGS.includes(pb) ? legScale : 1) * (1 - Math.min(1, a.w));
      if (lw <= 0) continue;
      a.dir.multiplyScalar(a.w).addScaledVector(d, lw);
      a.w += lw;
      a.dir.normalize();
    }
  }

  private samplePose(def: Action, t: number): Pose {
    const keys = def.keys;
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
    const k0 = keys[i];
    const k1 = keys[Math.min(i + 1, keys.length - 1)];
    const span = Math.max(1e-4, k1.t - k0.t);
    const s = smooth(clamp((t - k0.t) / span, 0, 1));
    const out: Pose = {};
    for (const pb of ORDER) {
      const a = k0.pose[pb];
      const b = k1.pose[pb];
      if (!a && !b) continue;
      out[pb] = (a ?? b)!.clone().lerp((b ?? a)!, s).normalize();
    }
    return out;
  }

  private play(name: ActionName): void {
    this.action = { def: ACTIONS[name], t: 0 };
  }

  update(inp: RigInput): void {
    const { dt, time: t } = inp;
    const w = this.w;
    const ease = (rate: number) => 1 - Math.exp(-rate * dt);
    const sp = inp.speed;
    const airborne = !inp.grounded && inp.airTime > 0.12;
    const onFeet = !airborne && !inp.stunned;

    // Locomotion blend.
    let ti = 1;
    let tw = 0;
    let tr = 0;
    if (onFeet && !inp.rooted) {
      ti = clamp(1 - sp / 1.5, 0, 1);
      tr = clamp((sp - 3.5) / 3.5, 0, 1);
      tw = Math.max(0, 1 - ti - tr);
    }
    w.idle += (ti - w.idle) * ease(10);
    w.walk += (tw - w.walk) * ease(10);
    w.run += (tr - w.run) * ease(10);
    this.idle.setEffectiveWeight(w.idle);
    this.walk.setEffectiveWeight(w.walk);
    this.run.setEffectiveWeight(w.run);
    this.walk.timeScale = clamp(sp / 1.4, 0.6, 2.4);
    this.run.timeScale = clamp(sp / 5, 0.7, 1.9);

    const falling = airborne && inp.vy < -8 && inp.airTime > 0.3;
    w.fall += (+(falling && !inp.stunned) - w.fall) * ease(6);
    w.air += (+(airborne && !falling && !inp.stunned) - w.air) * ease(12);
    w.flop += (+(inp.stunned && !inp.rooted) - w.flop) * ease(10);
    w.root += (+inp.rooted - w.root) * ease(10);
    w.aim += (+(inp.aiming && !inp.stunned) - w.aim) * ease(10);
    w.cheer += (+(inp.happy && onFeet) - w.cheer) * ease(6);

    // Start one-shot actions.
    if (inp.swing > this.prevSwing + 0.5 && !inp.stunned) {
      const k = inp.swingKind;
      this.play(k === 'knife' ? 'stab' : k === 'bat' ? 'hammer' : k === 'fists' ? 'shove' : 'recoil');
    }
    this.prevSwing = inp.swing;
    if (inp.landed > 1.5 && !inp.stunned) this.play('land');
    if (inp.stunned && this.action && this.action.def !== ACTIONS.land) this.action = null;

    this.mixer.update(dt);

    // Layers, highest priority first.
    this.acc.forEach((a) => {
      a.w = 0;
      a.dir.set(0, 0, 0);
    });
    let crouch = 0;
    this.layer(fallPose(t), w.fall);
    this.layer(flopPose(t), w.flop);
    if (this.action) {
      const { def } = this.action;
      this.action.t += dt;
      const at = this.action.t;
      if (at >= def.dur) this.action = null;
      else {
        const env = Math.min(1, at / def.fadeIn, (def.dur - at) / def.fadeOut);
        this.layer(this.samplePose(def, at), env, def.legs);
        crouch += def.crouch * env;
      }
    }
    this.layer(rootPose(t), w.root);
    crouch += 0.22 * w.root;
    this.layer(airPose(), w.air);
    this.layer(cheerPose(t), w.cheer);
    this.layer(AIM, w.aim);
    this.solve();
    this.object.position.y = -crouch;

    // Face: scream while falling, wince when knocked down, grit teeth when swinging.
    const fc = this.face;
    const k = ease(12);
    fc.aa += (Math.max(w.fall, w.flop * 0.6) - fc.aa) * k;
    fc.sad += (Math.max(w.flop, w.root, w.fall * 0.5) - fc.sad) * k;
    fc.angry += ((this.action && this.action.def !== ACTIONS.land ? 1 : 0) * (1 - w.flop) - fc.angry) * k;
    fc.happy += ((inp.happy ? 1 : 0) * (1 - w.flop) - fc.happy) * k;
    this.blinkT -= dt;
    if (this.blinkT < 0) this.blinkT = 2 + Math.random() * 4;
    const blink = this.blinkT < 0.12 ? 1 : 0;
    const em = this.vrm.expressionManager;
    if (em) {
      em.setValue('aa', fc.aa);
      em.setValue('sad', fc.sad * 0.8);
      em.setValue('angry', fc.angry * 0.7);
      em.setValue('happy', fc.happy);
      em.setValue('blink', Math.max(blink, w.flop > 0.6 ? 1 : 0) * (1 - fc.happy));
    }

    if (this.detailed) this.vrm.update(dt);
    else this.vrm.humanoid.update();

    // Keep the gun pointed where the character faces, whatever the elbows are doing.
    if (inp.aiming) {
      this.rawHand.updateWorldMatrix(true, false);
      this.rawHand.getWorldQuaternion(_hq);
      this.socket.quaternion.copy(_hq.invert().multiply(this.frameQuat));
    } else {
      this.socket.quaternion.copy(this.grip);
    }
  }
}
