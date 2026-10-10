// Shrinks VRM (GLB) files for the web: every embedded texture is downscaled to
// at most MAX px and re-encoded as WebP. Geometry, bones and VRM extensions are
// untouched. Usage: node scripts/optimize-vrm.mjs <src-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const MAX = 1024;
const [srcDir = 'assets-src/anime', outDir = 'public/assets/models/anime'] = process.argv.slice(2);

function readGlb(buf) {
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binHeader = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = buf.subarray(binHeader + 8, binHeader + 8 + binLen);
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binBuf = Buffer.concat([bin, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.write('glTF', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write('JSON', 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binBuf.length, 0);
  bh.write('BIN\0', 4);
  return Buffer.concat([head, jh, jsonBuf, bh, binBuf]);
}

async function optimize(file, out) {
  const { json, bin } = readGlb(fs.readFileSync(file));
  const views = json.bufferViews.map((v) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  for (const img of json.images ?? []) {
    if (img.bufferView === undefined) continue;
    const src = views[img.bufferView];
    const webp = await sharp(src).resize(MAX, MAX, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 100 }).toBuffer();
    views[img.bufferView] = webp;
    img.mimeType = 'image/webp';
  }
  // Re-pack the binary chunk with 4-byte alignment.
  const parts = [];
  let offset = 0;
  json.bufferViews.forEach((v, i) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    offset += pad;
    v.byteOffset = offset;
    v.byteLength = views[i].length;
    parts.push(views[i]);
    offset += views[i].length;
  });
  const newBin = Buffer.concat(parts);
  json.buffers[0].byteLength = newBin.length;
  fs.writeFileSync(out, writeGlb(json, newBin));
  return { before: fs.statSync(file).size, after: fs.statSync(out).size };
}

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith('.vrm'))) {
  const { before, after } = await optimize(path.join(srcDir, f), path.join(outDir, f));
  console.log(`${f}: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
}
