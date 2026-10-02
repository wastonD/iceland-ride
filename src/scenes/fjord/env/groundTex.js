// Procedural, tileable ground textures for the fjord (fallback when the photo-scanned set in
// env/photoAssets.js is missing or still loading — both use the same layout).
//   albedo  (sRGB RGBA8 array: RGB colour, A height)   normal (linear RGBA8 array: RG bump slope
//   = -grad(height) in uv space, B roughness, A unused)
// Layers: 0 tundra grass · 1 moss · 2 basalt · 3 scree · 4 black sand · 5 snow · 6 asphalt · 7 gravel
// (procedural set: 6/7 are copies of the scree layer; the road keeps its own canvas texture).
// The terrain shader treats albedo as *detail*: it divides by the layer's mean colour and
// multiplies by a macro tint, so colours are tuned in the shader, texture gives structure.

import * as THREE from 'three';
import { mulberry32 } from '../../../core/noise.js';

export const GL = { GRASS: 0, MOSS: 1, ROCK: 2, SCREE: 3, SAND: 4, SNOW: 5, ASPHALT: 6, GRAVEL: 7 };
export const GL_LAYERS = 8;
const S = 512;
const NL = GL_LAYERS;

/* ------------------------------------------------- fast tileable value noise */
function lattice(n, seed) {
  const r = mulberry32(seed), a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return a;
}
const axes = new Map();
function axis(p) {
  let a = axes.get(p);
  if (a) return a;
  const i0 = new Int32Array(S), i1 = new Int32Array(S), sm = new Float32Array(S);
  for (let x = 0; x < S; x++) {
    const f = (x * p) / S, i = Math.floor(f), t = f - i;
    i0[x] = i % p; i1[x] = (i + 1) % p; sm[x] = t * t * (3 - 2 * t);
  }
  a = { i0, i1, sm };
  axes.set(p, a);
  return a;
}
function octave(dst, p, seed, amp) {
  const lat = lattice(p, seed), { i0, i1, sm } = axis(p);
  for (let y = 0; y < S; y++) {
    const r0 = i0[y] * p, r1 = i1[y] * p, sy = sm[y], o = y * S;
    for (let x = 0; x < S; x++) {
      const xa = i0[x], xb = i1[x], sx = sm[x];
      const a = lat[r0 + xa], b = lat[r0 + xb], c = lat[r1 + xa], d = lat[r1 + xb];
      dst[o + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
}
function fbm(p, oct, seed) {
  const dst = new Float32Array(S * S);
  let norm = 0, amp = 0.5;
  for (let i = 0; i < oct; i++) { norm += amp; amp *= 0.5; }
  amp = 0.5 / norm;
  for (let i = 0; i < oct; i++) { octave(dst, p, seed + i * 101, amp); amp *= 0.5; p *= 2; }
  return dst;
}
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const L = (a, b, t) => a + (b - a) * t;
const c01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function canvas() { const c = document.createElement('canvas'); c.width = c.height = S; return c; }
const rgb = (c, k = 1) => `rgb(${Math.round(c01(c[0] * k) * 255)},${Math.round(c01(c[1] * k) * 255)},${Math.round(c01(c[2] * k) * 255)})`;
const grey = (g) => { const v = Math.round(c01(g) * 255); return `rgb(${v},${v},${v})`; };
function wrapDraw(g, x, y, r, fn) {
  const xs = [0], ys = [0];
  if (x < r) xs.push(S); if (x > S - r) xs.push(-S);
  if (y < r) ys.push(S); if (y > S - r) ys.push(-S);
  for (const ox of xs) for (const oy of ys) { g.save(); g.translate(x + ox, y + oy); fn(); g.restore(); }
}
function readRGB(cv) {
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const c = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) { c[i * 3] = d[i * 4] / 255; c[i * 3 + 1] = d[i * 4 + 1] / 255; c[i * 3 + 2] = d[i * 4 + 2] / 255; }
  return c;
}
function readGrey(cv) {
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) h[i] = d[i * 4] / 255;
  return h;
}
function norm01(H) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < H.length; i++) { if (H[i] < mn) mn = H[i]; if (H[i] > mx) mx = H[i]; }
  const k = 1 / (mx - mn || 1);
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - mn) * k;
  return H;
}
function fillBase(g, h, colFn, hFn) {
  const img = g.createImageData(S, S), himg = h.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const c = colFn(i), o = i * 4, hv = hFn(i) * 255;
    img.data[o] = c[0] * 255; img.data[o + 1] = c[1] * 255; img.data[o + 2] = c[2] * 255; img.data[o + 3] = 255;
    himg.data[o] = himg.data[o + 1] = himg.data[o + 2] = hv; himg.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0); h.putImageData(himg, 0, 0);
}

/* ------------------------------------------------------------------ layers */
// Tundra: short dense grass + sedge, straw, tiny moss cushions. ~1.6 m tile.
function genGrass() {
  const rnd = mulberry32(11);
  const cC = canvas(), cH = canvas(), g = cC.getContext('2d'), h = cH.getContext('2d');
  const m1 = fbm(5, 4, 21), m2 = fbm(40, 3, 31);
  fillBase(g, h, (i) => {
    const t = ss(0.3, 0.7, m1[i]) * 0.6 + m2[i] * 0.4;
    return [L(0.22, 0.38, t), L(0.24, 0.40, t), L(0.09, 0.13, t)];
  }, (i) => 0.15 + m2[i] * 0.2);
  const pal = [[0.55, 0.60, 0.22], [0.45, 0.52, 0.18], [0.66, 0.66, 0.30], [0.36, 0.44, 0.16], [0.72, 0.64, 0.38], [0.30, 0.36, 0.14]];
  const W = [3, 3, 1.6, 2.4, 0.9, 1.6], tot = W.reduce((a, b) => a + b, 0);
  const pick = () => { let r = rnd() * tot; for (let k = 0; k < pal.length; k++) { r -= W[k]; if (r <= 0) return pal[k]; } return pal[0]; };
  g.lineCap = h.lineCap = 'round';
  const NB = 12000;
  for (let k = 0; k < NB; k++) {
    const x = rnd() * S, y = rnd() * S, len = 7 + rnd() * 16, ang = rnd() * Math.PI * 2;
    const c = pick(), sh = 0.75 + rnd() * 0.45, bend = (rnd() - 0.5) * len * 0.6, ord = 0.3 + 0.7 * (k / NB);
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    wrapDraw(g, x, y, len + 2, () => {
      g.strokeStyle = rgb(c, sh); g.lineWidth = 0.8 + rnd() * 1.1;
      g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(dx * 0.5 - dy * bend / len, dy * 0.5 + dx * bend / len, dx, dy); g.stroke();
    });
    wrapDraw(h, x, y, len + 2, () => {
      h.strokeStyle = grey(ord); h.lineWidth = 1.2;
      h.beginPath(); h.moveTo(0, 0); h.lineTo(dx, dy); h.stroke();
    });
  }
  const col = readRGB(cC), H = readGrey(cH);
  for (let i = 0; i < S * S; i++) { const k = 0.6 + 0.5 * H[i]; col[i * 3] *= k; col[i * 3 + 1] *= k; col[i * 3 + 2] *= k; }
  return { col, H, rough: () => 0.9 };
}

// Woolly fringe-moss / cushion moss: lumpy clumps with pale tips.
function genMoss() {
  const clump = fbm(12, 4, 301), fuzz = fbm(96, 3, 311), fine = fbm(256, 1, 321), tone = fbm(4, 3, 331);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3);
  const dk = [0.16, 0.21, 0.09], md = [0.30, 0.40, 0.14], tp = [0.42, 0.50, 0.24], gr = [0.36, 0.40, 0.26];
  for (let i = 0; i < S * S; i++) {
    const c = clump[i], hh = ss(0.35, 0.62, c) * 0.65 + fuzz[i] * 0.25 + fine[i] * 0.1;
    H[i] = hh;
    const t1 = ss(0.25, 0.6, hh), t2 = ss(0.62, 0.85, hh) * (0.5 + 0.5 * fine[i]), t3 = ss(0.5, 0.75, tone[i]) * 0.35;
    for (let ch = 0; ch < 3; ch++) {
      let v = L(dk[ch], md[ch], t1);
      v = L(v, tp[ch], t2); v = L(v, gr[ch], t3);
      col[i * 3 + ch] = v;
    }
  }
  return { col, H: norm01(H), rough: () => 0.95 };
}

// Basalt: dark, fine-grained, horizontal flow banding, columnar joints, vesicles, lichen.
function genRock() {
  const rnd = mulberry32(401);
  const n1 = fbm(4, 6, 411), rid = fbm(8, 4, 421), fineN = fbm(96, 3, 431), tone = fbm(3, 3, 441), lich = fbm(20, 3, 451), wob = fbm(2, 3, 461);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3);
  const dk = [0.12, 0.12, 0.12], lt = [0.33, 0.32, 0.30], rust = [0.34, 0.26, 0.20], lc = [0.55, 0.58, 0.44];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, v = y / S, u = x / S;
    const band = Math.sin((v + 0.08 * (wob[i] - 0.5)) * Math.PI * 2 * 5) * 0.5 + 0.5;
    const ridge = 1 - Math.abs(2 * rid[i] - 1);
    const crackH = ss(0.93, 0.99, ridge);
    // vertical joints (columns)
    const jx = Math.abs(Math.sin((u + 0.05 * (n1[i] - 0.5)) * Math.PI * 7));
    const joint = ss(0.08, 0.0, jx) * ss(0.35, 0.6, band + n1[i] * 0.3);
    const hh = n1[i] * 0.45 + band * 0.18 + fineN[i] * 0.3 - crackH * 0.3 - joint * 0.35;
    H[i] = hh;
    const t = ss(0.2, 0.8, hh), w = ss(0.55, 0.8, tone[i]) * 0.45, lk = ss(0.64, 0.74, lich[i]) * 0.55;
    const k = (1 - crackH * 0.5 - joint * 0.5) * (0.8 + 0.4 * fineN[i]);
    for (let ch = 0; ch < 3; ch++) {
      let c = L(dk[ch], lt[ch], t);
      c = L(c, rust[ch], w); c = L(c, lc[ch], lk);
      col[i * 3 + ch] = c * k;
    }
  }
  // vesicles
  for (let k = 0; k < 600; k++) {
    const cx = Math.floor(rnd() * S), cy = Math.floor(rnd() * S), r = 0.7 + rnd() * 2.2;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy) / r; if (d > 1) continue;
      const i = ((cy + dy + S) % S) * S + ((cx + dx + S) % S);
      H[i] -= 0.15 * (1 - d); col[i * 3] *= 0.6; col[i * 3 + 1] *= 0.6; col[i * 3 + 2] *= 0.6;
    }
  }
  return { col, H: norm01(H), rough: () => 0.8 };
}

// Scree: angular grey-brown stones over fine gravel.
function genScree() {
  const rnd = mulberry32(501);
  const cC = canvas(), cH = canvas(), g = cC.getContext('2d'), h = cH.getContext('2d');
  const n = fbm(64, 3, 511), m = fbm(6, 3, 521);
  fillBase(g, h, (i) => { const t = n[i] * 0.6 + m[i] * 0.4; return [L(0.20, 0.34, t), L(0.18, 0.31, t), L(0.16, 0.27, t)]; }, (i) => 0.1 + n[i] * 0.2);
  const pal = [[0.42, 0.40, 0.37], [0.36, 0.32, 0.28], [0.22, 0.22, 0.22], [0.48, 0.44, 0.38], [0.30, 0.27, 0.25], [0.44, 0.36, 0.30]];
  for (let k = 0; k < 900; k++) {
    const x = rnd() * S, y = rnd() * S, r = 4 + rnd() * rnd() * 22, c = pal[Math.floor(rnd() * pal.length)], sh = 0.7 + rnd() * 0.5;
    const nv = 5 + Math.floor(rnd() * 3), rot = rnd() * 7, pts = [];
    for (let v = 0; v < nv; v++) { const a = rot + (v / nv) * Math.PI * 2, rr = r * (0.6 + rnd() * 0.5); pts.push([Math.cos(a) * rr, Math.sin(a) * rr * (0.6 + rnd() * 0.3)]); }
    const top = 0.4 + 0.6 * (k / 900);
    const path = (ctx) => { ctx.beginPath(); pts.forEach(([px, py], v) => (v ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); };
    wrapDraw(g, x, y, r * 1.2, () => {
      path(g); g.fillStyle = rgb(c, sh); g.fill();
      g.strokeStyle = rgb(c, sh * 0.55); g.lineWidth = 1.2; g.stroke();
      g.fillStyle = rgb(c, sh * 1.2); g.beginPath(); g.moveTo(pts[0][0] * 0.6, pts[0][1] * 0.6); g.lineTo(pts[1][0] * 0.6, pts[1][1] * 0.6); g.lineTo(0, 0); g.fill();
    });
    wrapDraw(h, x, y, r * 1.2, () => {
      path(h);
      const gr = h.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, grey(top)); gr.addColorStop(0.8, grey(top * 0.75)); gr.addColorStop(1, grey(top * 0.4));
      h.fillStyle = gr; h.fill();
    });
  }
  return { col: readRGB(cC), H: readGrey(cH), rough: () => 0.85 };
}

// Black volcanic sand with ripples and a few rounded pebbles.
function genSand() {
  const rnd = mulberry32(601);
  const cC = canvas(), cH = canvas(), g = cC.getContext('2d'), h = cH.getContext('2d');
  const grain = fbm(256, 2, 611), m = fbm(4, 3, 621), w = fbm(3, 2, 631);
  fillBase(g, h, (i) => {
    const y = Math.floor(i / S), rip = Math.sin((y / S + 0.1 * w[i]) * Math.PI * 2 * 14) * 0.5 + 0.5;
    const t = grain[i] * 0.6 + m[i] * 0.25 + rip * 0.15;
    return [L(0.07, 0.2, t), L(0.07, 0.195, t), L(0.075, 0.2, t)];
  }, (i) => { const y = Math.floor(i / S); return 0.3 + 0.35 * (Math.sin((y / S + 0.1 * w[i]) * Math.PI * 2 * 14) * 0.5 + 0.5) + grain[i] * 0.2; });
  for (let k = 0; k < 160; k++) {
    const x = rnd() * S, y = rnd() * S, a = 3 + rnd() * rnd() * 16, b = a * (0.6 + rnd() * 0.35), rot = rnd() * 3.14;
    const gv = 0.13 + rnd() * 0.1, c = [gv, gv * 0.985, gv * 0.975];
    wrapDraw(g, x, y, a + 2, () => { g.rotate(rot); g.scale(a, b); const gr = g.createRadialGradient(-0.3, -0.3, 0.05, 0, 0, 1); gr.addColorStop(0, rgb(c, 1.4)); gr.addColorStop(1, rgb(c, 0.5)); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, 7); g.fill(); });
    wrapDraw(h, x, y, a + 2, () => { h.rotate(rot); h.scale(a, b); const gr = h.createRadialGradient(0, 0, 0, 0, 0, 1); gr.addColorStop(0, grey(0.95)); gr.addColorStop(1, grey(0.45)); h.fillStyle = gr; h.beginPath(); h.arc(0, 0, 1, 0, 7); h.fill(); });
  }
  return { col: readRGB(cC), H: readGrey(cH), rough: (i) => 0.93 };
}

// Old summer snow: soft, slightly dirty, sun-cupped.
function genSnow() {
  const a = fbm(6, 5, 701), b = fbm(32, 3, 711), cup = fbm(24, 2, 721);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    const c = 1 - Math.abs(cup[i] * 2 - 1);
    const hh = a[i] * 0.5 + b[i] * 0.2 + c * 0.3;
    H[i] = hh;
    const t = 0.82 + 0.18 * hh, dirt = ss(0.62, 0.8, a[i]) * 0.12;
    col[i * 3] = t - dirt * 0.8; col[i * 3 + 1] = t - dirt * 0.85; col[i * 3 + 2] = t * 1.02 - dirt;
  }
  return { col, H: norm01(H), rough: () => 0.6 };
}

/* ------------------------------------------------------------------ pack */
const BUMP = [2.2, 2.4, 2.6, 2.4, 1.6, 0.8];
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function pack(layers) {
  const alb = new Uint8Array(S * S * 4 * NL), nrm = new Uint8Array(S * S * 4 * NL);
  const mean = [];
  layers.forEach((Ly, li) => {
    const off = li * S * S * 4, { col, H, rough } = Ly, k = BUMP[li] * 2;
    let mr = 0, mg = 0, mb = 0, rs = 0;
    for (let y = 0; y < S; y++) {
      const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
      for (let x = 0; x < S; x++) {
        const xm = (x - 1 + S) % S, xp = (x + 1) % S, i = y0 + x, o = off + i * 4;
        const dx = (H[y0 + xp] - H[y0 + xm]) * k, dy = (H[yp + x] - H[ym + x]) * k;
        const r = c01(col[i * 3]), gg = c01(col[i * 3 + 1]), b = c01(col[i * 3 + 2]);
        alb[o] = r * 255; alb[o + 1] = gg * 255; alb[o + 2] = b * 255; alb[o + 3] = H[i] * 255;
        mr += toLin(r); mg += toLin(gg); mb += toLin(b);
        const ro = rough(i); rs += ro;
        nrm[o] = c01(0.5 - dx * 0.5) * 255; nrm[o + 1] = c01(0.5 - dy * 0.5) * 255;
        nrm[o + 2] = ro * 255; nrm[o + 3] = 255;
      }
    }
    mean.push([mr / (S * S), mg / (S * S), mb / (S * S), rs / (S * S)]);
  });
  // 6 asphalt / 7 gravel: copies of the scree layer
  for (const li of [6, 7]) {
    alb.copyWithin(li * S * S * 4, 3 * S * S * 4, 4 * S * S * 4);
    nrm.copyWithin(li * S * S * 4, 3 * S * S * 4, 4 * S * S * 4);
    mean.push(mean[3].slice());
  }
  return { alb, nrm, mean };
}
export function arrayTex(data, srgb, size = S, layers = NL) {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

// Per-layer sampling parameters: x = tile size (m), y = large-scale factor, z = bump gain, w = min roughness
export const PROC_LAYER_PARAMS = [
  [1.7, 2.9, 1.0, 0], [1.9, 2.9, 1.0, 0], [6.5, 2.7, 1.0, 0], [2.3, 3.1, 1.0, 0],
  [2.2, 3.0, 1.0, 0], [7.0, 3.0, 1.0, 0], [2.3, 3.1, 1.0, 0], [2.3, 3.1, 1.0, 0],
];

let cache = null;
export function getFjordGroundTextures() {
  if (cache) return cache;
  const t0 = performance.now();
  const layers = [genGrass(), genMoss(), genRock(), genScree(), genSand(), genSnow()];
  const { alb, nrm, mean } = pack(layers);
  cache = { albedo: arrayTex(alb, true), normal: arrayTex(nrm, false), meanLinear: mean, params: PROC_LAYER_PARAMS, photo: false };
  console.info(`[fjord ground] textures ${Math.round(performance.now() - t0)} ms`);
  return cache;
}

/* ---------------------------------------------------- shared live uniforms */
// Every material that samples the ground arrays (terrain, road, rocks) holds these exact
// objects, so swapping procedural → photo textures is just a .value change (no recompile).
const GU = {
  uGAlb: { value: null }, uGNrm: { value: null }, uPhoto: { value: 0 },
  uGMean: { value: Array.from({ length: NL }, () => new THREE.Vector4(0.2, 0.2, 0.2, 0.85)) },
  uGLay: { value: Array.from({ length: NL }, () => new THREE.Vector4(2, 3, 1, 0)) },
};
let guSet = null;
export function setGroundTextures(t) {
  if (guSet === t) return;
  const prev = guSet;
  guSet = t;
  GU.uGAlb.value = t.albedo; GU.uGNrm.value = t.normal; GU.uPhoto.value = t.photo ? 1 : 0;
  t.meanLinear.forEach((m, i) => GU.uGMean.value[i].set(m[0], m[1], m[2], m[3] ?? 0.85));
  t.params.forEach((p, i) => GU.uGLay.value[i].set(p[0], p[1], p[2], p[3] ?? 0));
  // the photo set replaces the procedural one for good: free its VRAM
  if (prev && prev === cache && t.photo) { prev.albedo.dispose(); prev.normal.dispose(); cache = null; }
}
/** Live uniforms for the ground arrays (initialised with whatever set is available). */
export function groundUniforms() {
  if (!guSet) setGroundTextures(getFjordGroundTextures());
  return GU;
}
export const groundTexturesReady = () => !!guSet;
