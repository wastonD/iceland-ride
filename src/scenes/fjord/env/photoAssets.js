// Photo-scanned CC0 assets (Poly Haven, public/assets/ph/<id>/) for the fjord:
//   ground  — 8-layer albedo/normal DataArrayTextures in the same layout as groundTex.js
//             (0 grass · 1 moss/heath · 2 basalt · 3 scree · 4 black sand · 5 snow · 6 asphalt · 7 gravel)
//   rocks   — 3 scanned rock meshes (decimated on load) + a 3-layer albedo/normal array
//   grass   — blade atlas (alpha cut out of grass_medium_02's black-background photo) + blade rects
//
// Everything is fetched with *relative* URLs (the published page does not live at the site root)
// and decoded asynchronously. Any failure → that part resolves to null and the caller keeps the
// procedural look; nothing here throws into the boot sequence.
import * as THREE from 'three';
import { arrayTex, GL_LAYERS } from './groundTex.js';
import { t } from '../../../core/i18n.js';

let BASE = 'assets/ph/';   // ?phfail (debug) points it at a missing folder to exercise the fallback
const TIMEOUT_MS = 25000;
/** Load timing / outcome (debug: __rf.modules flora.photoStats). */
export const PHOTO_STATS = { ms: 0, size: 0, parts: null, cpuMs: 0 };


// Ground recipes (array layer = index). tile = metres per texture repeat, big = factor of the
// second, larger-scale sample, bump = normal gain. desat pulls each photo's own colour cast
// toward grey (the terrain shader re-tints by layer: texture = detail, palette = macro colour);
// knee compresses highlights (dark_rock's pale veins would read as quartz on basalt).
const GROUND = [
  { id: 'aerial_grass_rock', tile: 4.2, big: 3.1, bump: 1.0, rmin: 0.8, desat: 0.55, ao: 0.5 },
  { id: 'forrest_ground_01', tile: 2.3, big: 2.9, bump: 1.1, rmin: 0.85, desat: 0.5, ao: 0.6 },
  { id: 'dark_rock', tile: 5.0, big: 2.7, bump: 1.2, rmin: 0.62, desat: 0.6, ao: 0.5, knee: 1.5 },
  { id: 'rocks_ground_04', tile: 2.8, big: 3.3, bump: 1.2, rmin: 0.75, desat: 0.3, ao: 0.6 },
  { id: 'damp_beach_sand', tile: 2.4, big: 3.0, bump: 0.9, rmin: 0.45, desat: 0.5, ao: 0.4 },
  { id: 'snow_02', tile: 3.6, big: 3.0, bump: 0.8, rmin: 0.5, desat: 0.7, ao: 0.3 },
  { id: 'asphalt_02', tile: 3.0, big: 3.2, bump: 1.0, rmin: 0.7, desat: 0.4, ao: 0.4, lift: 0.55 },
  { id: 'gravel_road', tile: 1.6, big: 3.0, bump: 1.5, rmin: 0.9, desat: 0.7, ao: 0.6, contrast: 1.8 },
];
const gFiles = (id) => [`${id}/${id}_diff_1k.jpg`, `${id}/${id}_nor_gl_1k.jpg`, `${id}/${id}_arm_1k.jpg`];

// Rock models: one texture set each (array layer = index)
export const ROCK_LAYER = { MOSS: 0, PEBBLE: 1, BOULDER: 2 };
const ROCKS = [
  { id: 'rock_moss_set_01', gltf: 'rock_moss_set_01/rock_moss_set_01_1k.json', tex: ['textures/rock_moss_set_01_diff_1k.jpg', 'textures/rock_moss_set_01_nor_gl_1k.jpg', 'textures/rock_moss_set_01_rough_1k.jpg'], arm: false },
  { id: 'rock_07', gltf: 'rock_07/rock_07_1k.json', tex: ['textures/rock_07_diff_1k.jpg', 'textures/rock_07_nor_gl_1k.jpg', 'textures/rock_07_arm_1k.jpg'], arm: true },
  { id: 'namaqualand_boulder_02', gltf: 'namaqualand_boulder_02/namaqualand_boulder_02_1k.json', tex: ['textures/namaqualand_boulder_02_diff_1k.jpg', 'textures/namaqualand_boulder_02_nor_gl_1k.jpg', 'textures/namaqualand_boulder_02_arm_1k.jpg'], arm: true },
];
const GRASS_DIFF = 'grass_medium_02/textures/grass_medium_02_diff_1k.jpg';

/* ------------------------------------------------------------- utilities */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) { const l = i / 4096; SRGB[i] = Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)); }
const enc = (l) => SRGB[l <= 0 ? 0 : l >= 1 ? 4096 : (l * 4096) | 0];
const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

let progress = { done: 0, total: 1, phase: '' };
function report() {
  const el = typeof document !== 'undefined' && document.getElementById('loading');
  if (!el || el.classList.contains('done')) return;
  el.textContent = progress.phase || t('load.photo', { pct: Math.round((100 * progress.done) / progress.total) });
}
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
}
async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}
async function bitmap(path) {
  const r = await fetchOk(BASE + path);
  const b = await r.blob();
  const bmp = await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  progress.done++; report();
  return bmp;
}
let cv = null;
function pixels(bmp, S) {
  if (!cv || cv.width !== S) { cv = document.createElement('canvas'); cv.width = cv.height = S; }
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.clearRect(0, 0, S, S);
  g.drawImage(bmp, 0, 0, S, S);
  return g.getImageData(0, 0, S, S).data;
}

/* --------------------------------------------------------- ground layers */
// d diff, n normal (OpenGL), a arm → alb (sRGB rgb + height), nrm (bump rg, rough, ao)
function packGroundLayer(d, n, a, S, rec, alb, nrm, li) {
  const N = S * S, off = li * N * 4;
  const lum = new Float32Array(N), lin = new Float32Array(N * 3);
  let sl = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4, ao = a[o] / 255, k = 1 - rec.ao * (1 - ao);
    let r = LIN[d[o]] * k, g = LIN[d[o + 1]] * k, b = LIN[d[o + 2]] * k;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, s = 1 - rec.desat;
    r = L + (r - L) * s; g = L + (g - L) * s; b = L + (b - L) * s;
    lin[i * 3] = r; lin[i * 3 + 1] = g; lin[i * 3 + 2] = b; lum[i] = L; sl += L;
  }
  const mL = sl / N;
  if (rec.contrast) {
    for (let i = 0; i < N; i++) {
      const L = lum[i], k = Math.max(0.15, (mL + (L - mL) * rec.contrast) / Math.max(L, 1e-4));
      lin[i * 3] *= k; lin[i * 3 + 1] *= k; lin[i * 3 + 2] *= k; lum[i] = L * k;
    }
  }
  if (rec.lift) {
    // soften the darkest marks (asphalt_02's tar-filled cracks would repeat every tile)
    const t = mL * rec.lift;
    for (let i = 0; i < N; i++) {
      const L = lum[i];
      if (L < t) { const k = (t - (t - L) * 0.35) / Math.max(L, 1e-4); lin[i * 3] *= k; lin[i * 3 + 1] *= k; lin[i * 3 + 2] *= k; lum[i] = L * k; }
    }
  }
  if (rec.knee) {
    const t = mL * rec.knee;
    for (let i = 0; i < N; i++) {
      const L = lum[i];
      if (L > t) { const k = (t + (L - t) * 0.25) / L; lin[i * 3] *= k; lin[i * 3 + 1] *= k; lin[i * 3 + 2] *= k; lum[i] = L * k; }
    }
  }
  // height proxy: cavity (AO) + brightness (stones / tufts are lighter than the gaps)
  const H = new Float32Array(N);
  let hMin = 1e9, hMax = -1e9;
  for (let i = 0; i < N; i++) {
    const h = 0.6 * (a[i * 4] / 255) + 0.4 * Math.min(lum[i] / (2 * mL + 1e-5), 1);
    H[i] = h; if (h < hMin) hMin = h; if (h > hMax) hMax = h;
  }
  const hk = 1 / Math.max(hMax - hMin, 1e-4);
  let mr = 0, mg = 0, mb = 0, rs = 0;
  for (let i = 0; i < N; i++) {
    const o = off + i * 4, r = lin[i * 3], g = lin[i * 3 + 1], b = lin[i * 3 + 2];
    alb[o] = enc(r); alb[o + 1] = enc(g); alb[o + 2] = enc(b); alb[o + 3] = ((H[i] - hMin) * hk * 255) | 0;
    mr += r; mg += g; mb += b;
    // OpenGL normal (+G = image up). Our uv rows run top→bottom, so flip G to get -dH/dv.
    nrm[o] = n[i * 4]; nrm[o + 1] = 255 - n[i * 4 + 1]; nrm[o + 2] = a[i * 4 + 1]; nrm[o + 3] = a[i * 4];
    rs += a[i * 4 + 1] / 255;
  }
  return [mr / N, mg / N, mb / N, rs / N];
}

async function loadGround(S) {
  const bmps = await Promise.all(GROUND.map((r) => Promise.all(gFiles(r.id).map(bitmap))));
  progress.phase = t('load.photoProc'); report();
  await yieldFrame();
  const alb = new Uint8Array(S * S * 4 * GL_LAYERS), nrm = new Uint8Array(S * S * 4 * GL_LAYERS);
  const mean = [];
  for (let li = 0; li < GROUND.length; li++) {
    const c0 = performance.now();
    const [d, n, a] = bmps[li].map((b) => pixels(b, S));
    mean.push(packGroundLayer(d, n, a, S, GROUND[li], alb, nrm, li));
    PHOTO_STATS.cpuMs += performance.now() - c0;
    bmps[li].forEach((b) => b.close?.());
    await yieldFrame();
  }
  return {
    albedo: arrayTex(alb, true, S, GL_LAYERS), normal: arrayTex(nrm, false, S, GL_LAYERS),
    meanLinear: mean, params: GROUND.map((r) => [r.tile, r.big, r.bump, r.rmin]), photo: true, size: S,
  };
}

/* ------------------------------------------------------------ glTF (mini) */
const COMP = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
async function loadGltf(path) {
  const json = await (await fetchOk(BASE + path)).json();
  progress.done++; report();
  const dir = path.replace(/[^/]+$/, '');
  // packed as <id>_1k.json with the buffer embedded as a data: URI (artifact hosting serves no .gltf/.bin)
  const uri = json.buffers[0].uri;
  const bin = await (await (uri.startsWith('data:') ? fetch(uri) : fetchOk(BASE + dir + uri))).arrayBuffer();
  progress.done++; report();
  const acc = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const C = COMP[a.componentType], nc = NCOMP[a.type], es = C.BYTES_PER_ELEMENT;
    const stride = bv.byteStride || nc * es, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new C(a.count * nc), dv = new DataView(bin);
    if (stride === nc * es && base % es === 0) { out.set(new C(bin, base, a.count * nc)); return out; }
    const get = { 5126: 'getFloat32', 5125: 'getUint32', 5123: 'getUint16', 5121: 'getUint8' }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < nc; c++) out[k * nc + c] = dv[get](base + k * stride + c * es, true);
    return out;
  };
  return json.meshes.map((m) => {
    const p = m.primitives[0];
    return { name: m.name, pos: acc(p.attributes.POSITION), nrm: acc(p.attributes.NORMAL), uv: acc(p.attributes.TEXCOORD_0), idx: acc(p.indices) };
  });
}

// Vertex-clustering decimation. Clusters are keyed on (position cell, uv cell) so UV seams stay
// split; triangles whose corners collapse into the same position cell are dropped.
function clusterOnce(m, cell, uvCell) {
  const { pos, nrm, uv, idx } = m, nv = pos.length / 3;
  const map = new Map(), remap = new Int32Array(nv), pcell = new Array(nv);
  const acc = [];
  for (let i = 0; i < nv; i++) {
    const qx = Math.floor(pos[i * 3] / cell), qy = Math.floor(pos[i * 3 + 1] / cell), qz = Math.floor(pos[i * 3 + 2] / cell);
    const pk = qx + ',' + qy + ',' + qz;
    const key = pk + '|' + Math.floor(uv[i * 2] / uvCell) + ',' + Math.floor(uv[i * 2 + 1] / uvCell);
    let c = map.get(key);
    if (c === undefined) { c = acc.length; map.set(key, c); acc.push([0, 0, 0, 0, 0, 0, 0, 0, 0, -1, pk]); }
    const A = acc[c];
    A[0] += pos[i * 3]; A[1] += pos[i * 3 + 1]; A[2] += pos[i * 3 + 2];
    A[3] += nrm[i * 3]; A[4] += nrm[i * 3 + 1]; A[5] += nrm[i * 3 + 2];
    A[6] += uv[i * 2]; A[7] += uv[i * 2 + 1]; A[8]++;
    remap[i] = c; pcell[i] = pk;
  }
  // position + normal per *position cell* (shared by the uv-split clusters of that cell), so both
  // sides of a uv seam land on the same point — otherwise the seams open into see-through cracks
  const cellSum = new Map();
  for (let i = 0; i < nv; i++) {
    let S = cellSum.get(pcell[i]);
    if (!S) { S = [0, 0, 0, 0, 0, 0, 0]; cellSum.set(pcell[i], S); }
    S[0] += pos[i * 3]; S[1] += pos[i * 3 + 1]; S[2] += pos[i * 3 + 2];
    S[3] += nrm[i * 3]; S[4] += nrm[i * 3 + 1]; S[5] += nrm[i * 3 + 2]; S[6]++;
  }
  // uv of the member nearest the cluster centre: averaged uvs drift into the atlas padding
  const best = new Float64Array(acc.length).fill(1e9);
  for (let i = 0; i < nv; i++) {
    const A = acc[remap[i]], c = A[8];
    const d = (pos[i * 3] - A[0] / c) ** 2 + (pos[i * 3 + 1] - A[1] / c) ** 2 + (pos[i * 3 + 2] - A[2] / c) ** 2;
    if (d < best[remap[i]]) { best[remap[i]] = d; A[9] = i; }
  }
  for (const A of acc) {
    const S = cellSum.get(A[10]), k = A[8] / S[6];
    A[0] = S[0] * k; A[1] = S[1] * k; A[2] = S[2] * k; A[3] = S[3]; A[4] = S[4]; A[5] = S[5];
  }
  // collapsed triangles are dropped; triangles the clustering folded over get their winding
  // fixed (else back-face culling punches see-through holes into the rock)
  const tri = [], cp = (k, j) => acc[k][j] / acc[k][8];
  const fn = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (pcell[a] === pcell[b] || pcell[b] === pcell[c] || pcell[a] === pcell[c]) continue;
    const A = remap[a], B = remap[b], Cc = remap[c];
    const n0 = fn(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2], pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
    const n1 = fn(cp(A, 0), cp(A, 1), cp(A, 2), cp(B, 0), cp(B, 1), cp(B, 2), cp(Cc, 0), cp(Cc, 1), cp(Cc, 2));
    if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0) tri.push(A, Cc, B); else tri.push(A, B, Cc);
  }
  return { acc, tri };
}
function simplify(m, target) {
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], m.pos[i + k]); mx[k] = Math.max(mx[k], m.pos[i + k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  let res = null;
  if (m.idx.length / 3 <= target) res = { acc: null, tri: null };
  else {
    let cell = diag / Math.sqrt(target * 0.5);
    for (let it = 0; it < 10; it++) {
      res = clusterOnce(m, cell, Math.min(0.125, Math.max(1 / 96, (cell / diag) * 0.9)));
      const n = res.tri.length / 3;
      if (n > target * 1.15) cell *= 1.18; else if (n < target * 0.7) cell /= 1.12; else break;
    }
  }
  const g = new THREE.BufferGeometry();
  if (!res.acc) {
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setIndex(new THREE.BufferAttribute(m.idx.length > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx), 1));
  } else {
    const n = res.acc.length, P = new Float32Array(n * 3), Nn = new Float32Array(n * 3), U = new Float32Array(n * 2);
    res.acc.forEach((A, i) => {
      const c = A[8];
      P[i * 3] = A[0] / c; P[i * 3 + 1] = A[1] / c; P[i * 3 + 2] = A[2] / c;
      const l = Math.hypot(A[3], A[4], A[5]) || 1;
      Nn[i * 3] = A[3] / l; Nn[i * 3 + 1] = A[4] / l; Nn[i * 3 + 2] = A[5] / l;
      U[i * 2] = m.uv[A[9] * 2]; U[i * 2 + 1] = m.uv[A[9] * 2 + 1];
    });
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(res.tri) : new Uint16Array(res.tri), 1));
  }
  // normalise: base at y = 0, xz centred, max horizontal extent = 1 m (instance scale = size)
  g.computeBoundingBox();
  const bb = g.boundingBox, w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  g.scale(1 / w, 1 / w, 1 / w);
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData.height = g.boundingBox.max.y;
  return g;
}

function packRockLayer(d, n, r, S, arm, alb, nrm, li) {
  const N = S * S, off = li * N * 4;
  let mr = 0, mg = 0, mb = 0, rs = 0;
  for (let i = 0; i < N; i++) {
    const o = i * 4, ao = arm ? r[o] / 255 : 1, k = 1 - 0.5 * (1 - ao);
    const R = LIN[d[o]] * k, G = LIN[d[o + 1]] * k, B = LIN[d[o + 2]] * k;
    alb[off + o] = enc(R); alb[off + o + 1] = enc(G); alb[off + o + 2] = enc(B); alb[off + o + 3] = 255;
    mr += R; mg += G; mb += B;
    const rough = arm ? r[o + 1] : r[o];
    nrm[off + o] = n[o]; nrm[off + o + 1] = 255 - n[o + 1]; nrm[off + o + 2] = rough; nrm[off + o + 3] = 255;
    rs += rough / 255;
  }
  return [mr / N, mg / N, mb / N, rs / N];
}

// target triangle counts per use
const ROCK_GEOS = [
  { model: 2, mesh: 0, tris: 4800, key: 'boulder' },     // namaqualand_boulder_02 (98k → ~5k)
  { model: 0, mesh: 3, tris: 2800, key: 'mossTall' },    // rock_moss_set rock04
  { model: 0, mesh: 0, tris: 2600, key: 'mossFlat' },    // rock_moss_set rock01
  { model: 1, mesh: 0, tris: 150, key: 'pebble' },       // rock_07 (14.8k → ~150, GPU stone field: per-vertex placement is costly)
];
async function loadRocks(S) {
  const parts = await Promise.all(ROCKS.map(async (R) => {
    const [meshes, bmps] = await Promise.all([loadGltf(R.gltf), Promise.all(R.tex.map((t) => bitmap(R.gltf.replace(/[^/]+$/, '') + t)))]);
    return { meshes, bmps };
  }));
  await yieldFrame();
  const alb = new Uint8Array(S * S * 4 * ROCKS.length), nrm = new Uint8Array(S * S * 4 * ROCKS.length);
  const mean = [];
  for (let li = 0; li < ROCKS.length; li++) {
    const c0 = performance.now();
    const [d, n, r] = parts[li].bmps.map((b) => pixels(b, S));
    mean.push(packRockLayer(d, n, r, S, ROCKS[li].arm, alb, nrm, li));
    PHOTO_STATS.cpuMs += performance.now() - c0;
    parts[li].bmps.forEach((b) => b.close?.());
    await yieldFrame();
  }
  const geos = {};
  for (const G of ROCK_GEOS) {
    const c0 = performance.now();
    const g = simplify(parts[G.model].meshes[G.mesh], G.tris);
    PHOTO_STATS.cpuMs += performance.now() - c0;
    g.setAttribute('aRL', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(G.model), 1));
    g.userData.layer = G.model;
    geos[G.key] = g;
    await yieldFrame();
  }
  return { albedo: arrayTex(alb, true, S, ROCKS.length), normal: arrayTex(nrm, false, S, ROCKS.length), mean, geos };
}

/* ---------------------------------------------------------------- grass */
// Blade atlas: the photo is blades on pure black → alpha from brightness; background RGB is
// filled with the mean blade colour so mipmaps don't grow dark fringes. Blades are found as
// connected components on a coarse mask (rect + orientation).
async function loadGrass() {
  const bmp = await bitmap(GRASS_DIFF);
  const S = 512, d = pixels(bmp, S);
  bmp.close?.();
  const N = S * S, out = new Uint8Array(N * 4);
  let mr = 0, mg = 0, mb = 0, mw = 0;
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * 4, m = Math.max(d[o], d[o + 1], d[o + 2]) / 255;
    const al = Math.min(1, Math.max(0, (m - 0.045) / 0.07));
    alpha[i] = al;
    if (al > 0.9) { mr += LIN[d[o]]; mg += LIN[d[o + 1]]; mb += LIN[d[o + 2]]; mw++; }
  }
  const mean = [mr / mw, mg / mw, mb / mw];
  for (let i = 0; i < N; i++) {
    const o = i * 4, al = alpha[i];
    // un-blend the black matte at the edges: colour / coverage, then fill the background
    const k = al > 0.05 ? 1 / Math.max(al, 0.35) : 0;
    const r = al > 0.05 ? Math.min(1, LIN[d[o]] * k) : mean[0], g = al > 0.05 ? Math.min(1, LIN[d[o + 1]] * k) : mean[1], b = al > 0.05 ? Math.min(1, LIN[d[o + 2]] * k) : mean[2];
    out[o] = enc(r); out[o + 1] = enc(g); out[o + 2] = enc(b); out[o + 3] = Math.round(al * 255);
  }
  // components on a 128² mask
  const C = 128, f = S / C, mask = new Uint8Array(C * C), lab = new Int32Array(C * C).fill(-1);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (alpha[y * S + x] > 0.5) mask[((y / f) | 0) * C + ((x / f) | 0)] = 1;
  const rects = [];
  for (let s = 0; s < C * C; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    let x0 = C, y0 = C, x1 = -1, y1 = -1, cnt = 0;
    const st = [s]; lab[s] = rects.length;
    while (st.length) {
      const q = st.pop(), qx = q % C, qy = (q / C) | 0;
      cnt++; x0 = Math.min(x0, qx); x1 = Math.max(x1, qx); y0 = Math.min(y0, qy); y1 = Math.max(y1, qy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= C || ny >= C) continue;
        const nq = ny * C + nx;
        if (mask[nq] && lab[nq] < 0) { lab[nq] = rects.length; st.push(nq); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (Math.max(w, h) >= 24 && cnt >= 20) {
      rects.push({ u0: (x0 - 0.5) / C, u1: (x1 + 1.5) / C, v0: (y0 - 0.5) / C, v1: (y1 + 1.5) / C, horiz: w > h * 1.5, len: Math.max(w, h) / C, aspect: Math.min(w, h) / Math.max(w, h) });
    } else rects.push(null);
  }
  const blades = rects.filter(Boolean);
  if (blades.length < 3) throw new Error('grass atlas: blades not found');
  const tex = new THREE.DataTexture(out, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;
  return { tex, blades, mean, size: S };
}

/* ------------------------------------------------------------------ API */
let promise = null;
/**
 * Start (once) loading every photo asset. Resolves to { ground, rocks, grass } where any part
 * may be null (failed → procedural fallback). Never rejects.
 */
export function loadPhotoAssets(ctx) {
  if (promise) return promise;
  if (ctx?.params?.has?.('nophoto') || typeof createImageBitmap === 'undefined' || typeof fetch === 'undefined') {
    promise = Promise.resolve({ ground: null, rocks: null, grass: null });
    return promise;
  }
  if (ctx?.params?.has?.('phfail')) BASE = 'assets/ph_missing/';
  const q = ctx?.state?.get?.('quality');
  const S = q === 'low' || q === 'eco' ? 512 : 1024;
  progress = { done: 0, total: GROUND.length * 3 + ROCKS.length * 5 + 1, phase: '' };
  report();
  const t0 = performance.now();
  const guard = (p, what) => withTimeout(p, TIMEOUT_MS * 2, what).catch((e) => { console.warn(`[photo assets] ${what} unavailable → procedural fallback:`, e.message || e); return null; });
  const ground = guard(loadGround(S), 'ground textures');
  const rocks = guard(loadRocks(S), 'rock models');
  const grass = guard(loadGrass(), 'grass atlas');
  promise = Promise.all([ground, rocks, grass]).then(([g, r, gr]) => {
    progress.phase = '';
    console.info(`[photo assets] ${Math.round(performance.now() - t0)} ms (ground ${!!g}, rocks ${!!r}, grass ${!!gr}, ${S}px)`);
    PHOTO_STATS.ms = Math.round(performance.now() - t0); PHOTO_STATS.size = S; PHOTO_STATS.parts = { ground: !!g, rocks: !!r, grass: !!gr };
    return { ground: g, rocks: r, grass: gr };
  });
  return promise;
}
/** Wait for the assets, but give up (resolve null) after `ms` — late arrivals can still be applied by `.then`. */
export function awaitPhotoAssets(ctx, ms = TIMEOUT_MS) {
  const p = loadPhotoAssets(ctx);
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}
