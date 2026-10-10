// Writes a gzipped copy (name.vrm.gz, name.glb.gz) next to every model in a folder. Static
// hosts compress code but not 3D models, and these shrink to under a third; the game unpacks
// them in the browser (see fetchModel in src/assets.ts) and falls back to the plain files.
// Usage: node scripts/compress-models.mjs <dir>   (run on the build output)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2] ?? 'dist/assets/models';
let before = 0;
let after = 0;
const walk = (d) => {
  for (const name of fs.readdirSync(d)) {
    const file = path.join(d, name);
    if (fs.statSync(file).isDirectory()) walk(file);
    else if (/\.(vrm|glb)$/i.test(name)) {
      const raw = fs.readFileSync(file);
      const gz = zlib.gzipSync(raw, { level: 9 });
      fs.writeFileSync(`${file}.gz`, gz);
      before += raw.length;
      after += gz.length;
    }
  }
};
walk(dir);
console.log(`models: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB gzipped`);
