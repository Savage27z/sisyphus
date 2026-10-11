// Drops the facial-expression morph targets the game never uses from VRM (0.x) files, which
// roughly halves their size: the sample avatars carry ~60 blend shapes per face, the game drives
// five expressions (see AnimeRig: aa, blink, happy, sad, angry). Expression groups are all kept
// (the unused ones just stop moving anything), so nothing asks for a missing expression.
// Usage: node scripts/trim-vrm.mjs <in.vrm> <out.vrm>   (or a directory in, a directory out)

import fs from 'node:fs';
import path from 'node:path';

/** VRM 0.x preset names whose morph targets stay (blink_l/blink_r for blinking, a for talking). */
const KEEP = new Set(['a', 'blink', 'blink_l', 'blink_r', 'joy', 'sorrow', 'angry', 'lookup', 'lookdown', 'lookleft', 'lookright']);

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

function writeGlb(json, bin) {
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
  const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const b = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const chunk = (data, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(j, 0x4e4f534a), chunk(b, 0x004e4942)]);
}

export function trim(buf) {
  const { json, bin } = readGlb(buf);
  const vrm = json.extensions?.VRM;
  if (!vrm?.blendShapeMaster) return buf; // not a VRM 0.x avatar: leave it alone

  // Which morph targets (per mesh) the kept expressions use.
  const keep = new Map(); // mesh index -> Set of target indices
  for (const g of vrm.blendShapeMaster.blendShapeGroups) {
    if (!KEEP.has(String(g.presetName).toLowerCase())) continue;
    for (const b of g.binds ?? []) {
      if (!keep.has(b.mesh)) keep.set(b.mesh, new Set());
      keep.get(b.mesh).add(b.index);
    }
  }
  // Drop the rest from each mesh, renumbering what stays.
  const remap = new Map(); // mesh index -> Map(old target -> new target)
  json.meshes.forEach((mesh, mi) => {
    const n = mesh.primitives[0]?.targets?.length ?? 0;
    if (!n) return;
    const kept = [...Array(n).keys()].filter((t) => keep.get(mi)?.has(t));
    remap.set(mi, new Map(kept.map((t, i) => [t, i])));
    for (const p of mesh.primitives) if (p.targets) p.targets = kept.map((t) => p.targets[t]);
    if (mesh.weights) mesh.weights = kept.map((t) => mesh.weights[t]);
    if (mesh.extras?.targetNames) mesh.extras.targetNames = kept.map((t) => mesh.extras.targetNames[t]);
    for (const p of mesh.primitives) if (p.extras?.targetNames) p.extras.targetNames = kept.map((t) => p.extras.targetNames[t]);
  });
  for (const g of vrm.blendShapeMaster.blendShapeGroups) {
    g.binds = (g.binds ?? []).filter((b) => remap.get(b.mesh)?.has(b.index)).map((b) => ({ ...b, index: remap.get(b.mesh).get(b.index) }));
  }

  // Garbage-collect accessors and buffer views nothing points at any more, and repack the binary.
  const usedAcc = new Set();
  const useAcc = (i) => i != null && usedAcc.add(i);
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      Object.values(p.attributes).forEach(useAcc);
      useAcc(p.indices);
      for (const t of p.targets ?? []) Object.values(t).forEach(useAcc);
    }
  }
  for (const s of json.skins ?? []) useAcc(s.inverseBindMatrices);
  for (const a of json.animations ?? []) for (const s of a.samplers) useAcc(s.input), useAcc(s.output);
  const accMap = new Map();
  const accessors = [];
  json.accessors.forEach((a, i) => {
    if (!usedAcc.has(i)) return;
    accMap.set(i, accessors.length);
    accessors.push(a);
  });
  const ra = (i) => (i == null ? i : accMap.get(i));
  for (const m of json.meshes) {
    for (const p of m.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = ra(p.attributes[k]);
      if (p.indices != null) p.indices = ra(p.indices);
      p.targets = p.targets?.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, ra(v)])));
    }
  }
  for (const s of json.skins ?? []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = ra(s.inverseBindMatrices);
  for (const a of json.animations ?? []) for (const s of a.samplers) (s.input = ra(s.input)), (s.output = ra(s.output));
  json.accessors = accessors;

  const usedView = new Set();
  for (const a of accessors) {
    if (a.bufferView != null) usedView.add(a.bufferView);
    if (a.sparse) usedView.add(a.sparse.indices.bufferView), usedView.add(a.sparse.values.bufferView);
  }
  for (const im of json.images ?? []) if (im.bufferView != null) usedView.add(im.bufferView);
  const viewMap = new Map();
  const views = [];
  const parts = [];
  let length = 0;
  json.bufferViews.forEach((v, i) => {
    if (!usedView.has(i)) return;
    const data = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    const padBy = (4 - (length % 4)) % 4;
    if (padBy) parts.push(Buffer.alloc(padBy)), (length += padBy);
    viewMap.set(i, views.length);
    views.push({ ...v, buffer: 0, byteOffset: length });
    parts.push(data);
    length += data.length;
  });
  for (const a of accessors) {
    if (a.bufferView != null) a.bufferView = viewMap.get(a.bufferView);
    if (a.sparse) (a.sparse.indices.bufferView = viewMap.get(a.sparse.indices.bufferView)), (a.sparse.values.bufferView = viewMap.get(a.sparse.values.bufferView));
  }
  for (const im of json.images ?? []) if (im.bufferView != null) im.bufferView = viewMap.get(im.bufferView);
  json.bufferViews = views;
  const out = Buffer.concat(parts);
  json.buffers = [{ byteLength: out.length }];
  return writeGlb(json, out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const [src, dst] = process.argv.slice(2);
  const files = fs.statSync(src).isDirectory() ? fs.readdirSync(src).filter((f) => f.endsWith('.vrm')).map((f) => [path.join(src, f), path.join(dst, f)]) : [[src, dst]];
  for (const [a, b] of files) {
    const before = fs.statSync(a).size;
    const out = trim(fs.readFileSync(a));
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(b, out);
    console.log(`${path.basename(a)}: ${(before / 1048576).toFixed(2)} MB -> ${(out.length / 1048576).toFixed(2)} MB`);
  }
}
