// Download a fixed list of Poly Haven (CC0) assets into assets-src/polyhaven/<id>/.
// Textures: 1k Diffuse + nor_gl + arm (jpg). Models: 1k glTF + its included files.
// usage: node tools/fetch-polyhaven.mjs
import fs from 'node:fs';
import path from 'node:path';
const TEX = ['dark_rock', 'rocks_ground_04', 'aerial_grass_rock', 'forrest_ground_01', 'asphalt_02', 'gravel_road', 'damp_beach_sand', 'snow_02'];
const MOD = ['rock_moss_set_01', 'rock_07', 'namaqualand_boulder_02', 'grass_medium_02'];
const OUT = path.resolve('assets-src/polyhaven');
const H = { headers: { 'User-Agent': 'rainforest-dev' } };
const get = async (url, file) => {
  if (fs.existsSync(file)) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url, H); if (!r.ok) throw new Error(url + ' ' + r.status);
  const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, b); return b.length;
};
let n = 0, bytes = 0;
for (const id of TEX) {
  const f = await (await fetch('https://api.polyhaven.com/files/' + id, H)).json();
  for (const m of ['Diffuse', 'nor_gl', 'arm']) { const e = f[m]['1k'].jpg; bytes += await get(e.url, path.join(OUT, id, path.basename(new URL(e.url).pathname))); n++; }
}
for (const id of MOD) {
  const f = await (await fetch('https://api.polyhaven.com/files/' + id, H)).json();
  const g = f.gltf['1k'].gltf;
  bytes += await get(g.url, path.join(OUT, id, path.basename(new URL(g.url).pathname))); n++;
  for (const [rel, inc] of Object.entries(g.include || {})) { bytes += await get(inc.url, path.join(OUT, id, rel)); n++; }
}
fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), 'All assets in this folder are from Poly Haven (https://polyhaven.com) and are licensed CC0 1.0 (public domain).\n');
console.log(`files ${n}, downloaded ${(bytes / 1048576).toFixed(2)} MB`);
