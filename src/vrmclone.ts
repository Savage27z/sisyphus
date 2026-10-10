import {
  VRM,
  VRMExpression,
  VRMExpressionManager,
  VRMExpressionMorphTargetBind,
  VRMHumanoid,
  VRMSpringBoneCollider,
  VRMSpringBoneJoint,
  VRMSpringBoneManager,
  type VRMHumanBones,
  type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * An independent copy of a parsed VRM: its own bones, face and hair physics, sharing
 * geometry and textures with the source. Parsing a VRM takes ~0.8 s (texture decode,
 * material setup); a copy takes a few milliseconds, which is what makes 24-fighter
 * rounds load instantly. The source must be untouched (never animated or attached to).
 */
export function cloneVRM(src: VRM): VRM {
  // The library hangs helper objects off the scene graph (normalized rig, expression
  // tracks, spring-bone colliders). Those are rebuilt for the copy, not cloned.
  const detached: { o: THREE.Object3D; parent: THREE.Object3D }[] = [];
  src.scene.traverse((o) => {
    if (o === src.humanoid.normalizedHumanBonesRoot || o instanceof VRMExpression || o instanceof VRMSpringBoneCollider) {
      detached.push({ o, parent: o.parent! });
    }
  });
  for (const d of detached) d.o.removeFromParent();
  const scene = cloneSkinned(src.scene) as THREE.Group;
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  const back = new Map<THREE.Object3D, THREE.Object3D>();
  const pair = (a: THREE.Object3D, b: THREE.Object3D) => {
    map.set(a, b);
    back.set(b, a);
    a.children.forEach((child, i) => pair(child, b.children[i]));
  };
  pair(src.scene, scene);
  for (const d of detached) d.parent.add(d.o);
  // SkeletonUtils gives every mesh its own skeleton; share them like the source does, or the
  // bone texture gets rebuilt and re-uploaded once per mesh per frame.
  const skeletons = new Map<THREE.Skeleton, THREE.Skeleton>();
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const srcSkel = (back.get(m) as THREE.SkinnedMesh).skeleton;
    let sk = skeletons.get(srcSkel);
    if (!sk) {
      sk = new THREE.Skeleton(
        srcSkel.bones.map((b) => map.get(b) as THREE.Bone),
        srcSkel.boneInverses.map((inv) => inv.clone()),
      );
      skeletons.set(srcSkel, sk);
    }
    m.bind(sk, m.bindMatrix);
  });
  // Object3D.clone JSON-copies userData; the spring-bone matrix cache must be rebuilt live.
  scene.traverse((o) => delete o.userData.inverseCacheProxy);

  // Build the rigs in the neutral orientation the loader saw (VRM 0.x models get turned afterwards).
  // The turn can be stored as any Euler triple (e.g. x = z = π), so save the whole rotation.
  const turned = scene.quaternion.clone();
  scene.quaternion.identity();
  scene.updateMatrixWorld(true);

  const bones = {} as VRMHumanBones;
  for (const [name, bone] of Object.entries(src.humanoid.rawHumanBones)) {
    if (bone) (bones as Record<string, { node: THREE.Object3D }>)[name] = { node: map.get(bone.node)! };
  }
  const humanoid = new VRMHumanoid(bones, { autoUpdateHumanBones: src.humanoid.autoUpdateHumanBones });
  scene.add(humanoid.normalizedHumanBonesRoot);

  let expressionManager: VRMExpressionManager | undefined;
  const em = src.expressionManager;
  if (em) {
    expressionManager = new VRMExpressionManager();
    expressionManager.blinkExpressionNames = [...em.blinkExpressionNames];
    expressionManager.lookAtExpressionNames = [...em.lookAtExpressionNames];
    expressionManager.mouthExpressionNames = [...em.mouthExpressionNames];
    for (const ex of em.expressions) {
      const e = new VRMExpression(ex.expressionName);
      e.isBinary = ex.isBinary;
      e.overrideBlink = ex.overrideBlink;
      e.overrideLookAt = ex.overrideLookAt;
      e.overrideMouth = ex.overrideMouth;
      for (const bind of ex.binds) {
        if (!(bind instanceof VRMExpressionMorphTargetBind)) continue;
        const primitives = bind.primitives.map((p) => map.get(p) as THREE.Mesh).filter(Boolean);
        e.addBind(new VRMExpressionMorphTargetBind({ primitives, index: bind.index, weight: bind.weight }));
      }
      scene.add(e);
      expressionManager.registerExpression(e);
    }
  }

  let springBoneManager: VRMSpringBoneManager | undefined;
  const sbm = src.springBoneManager;
  if (sbm) {
    springBoneManager = new VRMSpringBoneManager();
    const colliders = new Map<VRMSpringBoneCollider, VRMSpringBoneCollider>();
    for (const col of sbm.colliders) {
      const c = new VRMSpringBoneCollider(col.shape);
      c.name = col.name;
      c.position.copy(col.position);
      c.quaternion.copy(col.quaternion);
      c.scale.copy(col.scale);
      const parent = detached.find((d) => d.o === col)?.parent;
      (parent ? map.get(parent) ?? scene : scene).add(c);
      colliders.set(col, c);
    }
    const groups = new Map<VRMSpringBoneColliderGroup, VRMSpringBoneColliderGroup>();
    for (const g of sbm.colliderGroups) groups.set(g, { name: g.name, colliders: g.colliders.map((c) => colliders.get(c)!).filter(Boolean) });
    scene.updateMatrixWorld(true);
    for (const j of sbm.joints) {
      const joint = new VRMSpringBoneJoint(
        map.get(j.bone)!,
        j.child ? map.get(j.child) ?? null : null,
        { ...j.settings, gravityDir: j.settings.gravityDir.clone() },
        j.colliderGroups.map((g) => groups.get(g)!).filter(Boolean),
      );
      if (j.center) joint.center = map.get(j.center) ?? null;
      springBoneManager.addJoint(joint);
    }
  }

  scene.quaternion.copy(turned);
  scene.updateMatrixWorld(true);
  springBoneManager?.reset();
  return new VRM({ scene, meta: src.meta, humanoid, expressionManager, springBoneManager });
}

/**
 * Merge a parsed VRM's plain skinned meshes that share a material and skeleton (VRoid hair
 * comes as dozens of strands on one material). Meshes with expressions (morph targets) or
 * outline material pairs are left alone. Cuts each fighter from ~70-130 draws to ~30.
 */
export function mergeSkinnedMeshes(vrm: VRM): void {
  vrm.scene.updateMatrixWorld(true);
  const groups = new Map<string, THREE.SkinnedMesh[]>();
  vrm.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || Array.isArray(m.material) || m.morphTargetInfluences?.length) return;
    const attrs = Object.keys(m.geometry.attributes).sort().join(',');
    const key = `${m.material.uuid}|${m.skeleton.uuid}|${m.parent?.uuid}|${attrs}|${m.geometry.index ? 1 : 0}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  });
  for (const list of groups.values()) {
    const first = list[0];
    // Only merge meshes in the same space with the same bind (true for VRoid exports).
    const same = list.filter((m) => m.matrix.equals(first.matrix) && m.bindMatrix.equals(first.bindMatrix));
    if (same.length < 2) continue;
    const geo = mergeGeometries(same.map((m) => m.geometry));
    if (!geo) continue;
    const merged = new THREE.SkinnedMesh(geo, first.material);
    merged.name = `${first.name}_merged`;
    merged.matrix.copy(first.matrix);
    merged.matrix.decompose(merged.position, merged.quaternion, merged.scale);
    merged.bind(first.skeleton, first.bindMatrix);
    merged.renderOrder = first.renderOrder;
    first.parent!.add(merged);
    for (const m of same) m.removeFromParent();
  }
}
