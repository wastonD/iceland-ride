// Procedural, tileable ground-layer textures (no external assets).
// Two DataArrayTextures share one sampler each:
//   albedo  (sRGB RGBA8)          layers: 0 mud, 1 leaf litter, 2 moss, 3 rock, 4 pebbles/sand
//   normal  (linear RGBA8)        RG = bump slope (x,y), B = height, A = roughness
// Built lazily once and shared by terrain + rocks.

import * as THREE from 'three';
import { mulberry32 } from '../../core/noise.js';

export const LAYER = { MUD: 0, LEAF: 1, MOSS: 2, ROCK: 3, BED: 4 };
const S = 512;
const NL = 5;

/* ------------------------------------------------- fast tileable value noise */
// Whole-field generators (tight loops, no per-pixel closures): each returns a
// Float32Array(S*S) ~[0,1] that tiles over the unit square.
function makeLattice(n, seed) {
  const r = mulberry32(seed), a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return a;
}
const axisCache = new Map();
function axis(period) {
  let a = axisCache.get(period);
  if (a) return a;
  const i0 = new Int32Array(S), i1 = new Int32Array(S), sm = new Float32Array(S);
  for (let x = 0; x < S; x++) {
    const f = (x * period) / S, i = Math.floor(f), t = f - i;
    i0[x] = i % period; i1[x] = (i + 1) % period; sm[x] = t * t * (3 - 2 * t);
  }
  a = { i0, i1, sm };
  axisCache.set(period, a);
  return a;
}
function addOctave(dst, period, seed, amp) {
  const lat = makeLattice(period, seed);
  const { i0, i1, sm } = axis(period);
  for (let y = 0; y < S; y++) {
    const r0 = i0[y] * period, r1 = i1[y] * period, sy = sm[y], o = y * S;
    for (let x = 0; x < S; x++) {
      const xa = i0[x], xb = i1[x], sx = sm[x];
      const a = lat[r0 + xa], b = lat[r0 + xb], c = lat[r1 + xa], d = lat[r1 + xb];
      dst[o + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
}
function fbm(period, octaves, seed) {
  const dst = new Float32Array(S * S);
  let norm = 0, amp = 0.5, p = period;
  for (let i = 0; i < octaves; i++) { norm += amp; amp *= 0.5; }
  amp = 0.5 / norm;
  for (let i = 0; i < octaves; i++) { addOctave(dst, p, seed + i * 101, amp); amp *= 0.5; p *= 2; }
  return dst;
}
const ss = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const L = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ---------------------------------------------------------------- helpers */
function newCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
}
const rgbStr = (c, k = 1) =>
  `rgb(${Math.round(clamp01(c[0] * k) * 255)},${Math.round(clamp01(c[1] * k) * 255)},${Math.round(clamp01(c[2] * k) * 255)})`;
const grey = (g) => { const v = Math.round(clamp01(g) * 255); return `rgb(${v},${v},${v})`; };

// Draw with wrap-around so the canvas tiles.
function wrapDraw(ctx, x, y, r, fn) {
  const xs = [0], ys = [0];
  if (x < r) xs.push(S); if (x > S - r) xs.push(-S);
  if (y < r) ys.push(S); if (y > S - r) ys.push(-S);
  for (const ox of xs) for (const oy of ys) { ctx.save(); ctx.translate(x + ox, y + oy); fn(); ctx.restore(); }
}

function readGrey(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) h[i] = d[i * 4] / 255;
  return h;
}
function readRGB(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const c = new Float32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) { c[i * 3] = d[i * 4] / 255; c[i * 3 + 1] = d[i * 4 + 1] / 255; c[i * 3 + 2] = d[i * 4 + 2] / 255; }
  return c;
}
function normalize01(H) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < H.length; i++) { if (H[i] < mn) mn = H[i]; if (H[i] > mx) mx = H[i]; }
  const k = 1 / (mx - mn || 1);
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - mn) * k;
  return H;
}

/* --------------------------------------------------------------- the layers */
// Each returns { col: Float32Array(S*S*3) sRGB 0..1, H: Float32Array(S*S) 0..1, rough(i) }

function genMud() {
  const rnd = mulberry32(1001);
  const f1 = fbm(4, 6, 111), f2 = fbm(16, 3, 121), grain = fbm(128, 2, 131), tint = fbm(3, 3, 141);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3), wet = new Float32Array(S * S), grit = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) H[i] = f1[i] * 0.5 + f2[i] * 0.3 + grain[i] * 0.2;
  // footprint / rut-like elliptical dents (with a slightly raised rim)
  for (let k = 0; k < 34; k++) {
    const cx = rnd() * S, cy = rnd() * S, a = 30 + rnd() * 70, b = 12 + rnd() * 26, th = rnd() * Math.PI;
    const depth = 0.16 + rnd() * 0.22, ct = Math.cos(th), st = Math.sin(th), R = Math.ceil(Math.max(a, b) * 1.25);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const px = dx * ct + dy * st, py = -dx * st + dy * ct;
      const q = (px / a) ** 2 + (py / b) ** 2;
      if (q >= 1.5) continue;
      const xx = (Math.floor(cx) + dx + S * 4) % S, yy = (Math.floor(cy) + dy + S * 4) % S;
      const i = yy * S + xx;
      const t = 1 - q;
      const bowl = q < 1 ? t * t * (3 - 2 * t) : 0;
      const rim = Math.exp(-((q - 1.05) ** 2) * 12) * 0.35;
      H[i] += -depth * bowl + depth * rim;
      if (bowl > wet[i]) wet[i] = bowl;
    }
  }
  // grit specks
  for (let k = 0; k < 1300; k++) {
    const cx = Math.floor(rnd() * S), cy = Math.floor(rnd() * S), r = 0.8 + rnd() * 2.0, br = 0.12 + rnd() * 0.2;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy) / r; if (d > 1) continue;
      const i = ((cy + dy + S) % S) * S + ((cx + dx + S) % S);
      H[i] += br * (1 - d * d);
      grit[i] += (1 - d) * 0.6;
    }
  }
  const D0 = 0.12, D1 = 0.09, D2 = 0.068, L0 = 0.265, L1 = 0.205, L2 = 0.155, W0 = 0.31, W1 = 0.235, W2 = 0.17;
  for (let i = 0; i < S * S; i++) {
    const h = H[i] < 0 ? 0 : H[i] > 1.2 ? 1.2 : H[i];
    const t = ss(0.30, 0.8, h), w = ss(0.5, 0.75, tint[i]) * 0.35, dk = wet[i] * 0.55, g = grit[i];
    let r = L(D0, L0, t), gg = L(D1, L1, t), b = L(D2, L2, t);
    r = L(r, W0, w); gg = L(gg, W1, w); b = L(b, W2, w);
    r = L(r, D0, dk); gg = L(gg, D1, dk); b = L(b, D2, dk);
    col[i * 3] = r + g * 0.09; col[i * 3 + 1] = gg + g * 0.07; col[i * 3 + 2] = b + g * 0.055;
  }
  return { col, H: normalize01(H), rough: (i) => 0.82 - 0.3 * wet[i] };
}

function leafPath(ctx, len, wid) {
  ctx.beginPath();
  ctx.moveTo(-len * 0.5, 0);
  ctx.bezierCurveTo(-len * 0.25, -wid, len * 0.2, -wid * 1.05, len * 0.5, 0);
  ctx.bezierCurveTo(len * 0.2, wid * 1.05, -len * 0.25, wid, -len * 0.5, 0);
  ctx.closePath();
}

function genLeaf() {
  const rnd = mulberry32(2002);
  const cC = newCanvas(), cH = newCanvas();
  const g = cC.getContext('2d'), h = cH.getContext('2d');
  const base = fbm(6, 4, 211), baseFine = fbm(64, 3, 221);
  const img = g.createImageData(S, S), himg = h.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = base[i], f = baseFine[i], t = ss(0.3, 0.7, n) * 0.6 + f * 0.4, o = i * 4;
    img.data[o] = L(0.045, 0.13, t) * 255; img.data[o + 1] = L(0.032, 0.09, t) * 255; img.data[o + 2] = L(0.022, 0.05, t) * 255; img.data[o + 3] = 255;
    const hv = 20 + f * 40;
    himg.data[o] = himg.data[o + 1] = himg.data[o + 2] = hv; himg.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0); h.putImageData(himg, 0, 0);

  // muted, dark forest-floor palette (rain-soaked litter is never bright)
  const palette = [
    { c: [0.27, 0.13, 0.065], w: 2.4 },   // rust
    { c: [0.24, 0.165, 0.09], w: 4 },     // brown
    { c: [0.21, 0.20, 0.09], w: 2.4 },    // olive
    { c: [0.11, 0.08, 0.05], w: 3.6 },    // decayed dark
    { c: [0.32, 0.24, 0.11], w: 1.0 },    // yellow-brown
    { c: [0.15, 0.17, 0.08], w: 1.8 },    // dark olive
    { c: [0.36, 0.17, 0.08], w: 0.35 },   // rare orange
  ];
  const tot = palette.reduce((a, p) => a + p.w, 0);
  const pick = () => { let r = rnd() * tot; for (const p of palette) { r -= p.w; if (r <= 0) return p.c; } return palette[0].c; };

  const N = 1000;
  for (let k = 0; k < N; k++) {
    const x = rnd() * S, y = rnd() * S, ang = rnd() * Math.PI * 2;
    const len = 16 + rnd() * rnd() * 46 + rnd() * 10, wid = len * (0.2 + rnd() * 0.14);
    const c = pick(), shade = 0.75 + rnd() * 0.5;
    const order = 0.25 + 0.7 * (k / N) + rnd() * 0.05;
    const curl = 0.9 + rnd() * 0.2;
    const R = len * 0.6;
    const hole = rnd() < 0.3, hx = len * (rnd() - 0.5) * 0.5, hy = wid * (rnd() - 0.5) * 0.6;
    wrapDraw(g, x, y, R, () => {
      g.rotate(ang);
      leafPath(g, len, wid * curl);
      g.fillStyle = rgbStr(c, shade); g.fill();
      g.strokeStyle = rgbStr(c, shade * 0.6); g.lineWidth = Math.max(1, len * 0.04);
      g.beginPath(); g.moveTo(-len * 0.5, 0); g.lineTo(len * 0.46, 0); g.stroke();
      g.lineWidth = 0.7; g.globalAlpha = 0.5;
      g.beginPath();
      for (let v = -0.3; v <= 0.35; v += 0.16) { g.moveTo(len * v, 0); g.lineTo(len * (v + 0.13), -wid * 0.7); g.moveTo(len * v, 0); g.lineTo(len * (v + 0.13), wid * 0.7); }
      g.stroke();
      g.globalAlpha = 1;
      if (hole) { g.fillStyle = rgbStr(c, 0.4); g.beginPath(); g.arc(hx, hy, len * 0.08, 0, 7); g.fill(); }
    });
    wrapDraw(h, x, y, R, () => {
      h.rotate(ang);
      leafPath(h, len, wid * curl);
      h.fillStyle = grey(order); h.fill();
      h.strokeStyle = grey(order + 0.06); h.lineWidth = Math.max(1, len * 0.05);
      h.beginPath(); h.moveTo(-len * 0.5, 0); h.lineTo(len * 0.46, 0); h.stroke();
    });
  }
  for (let k = 0; k < 20; k++) {
    const x = rnd() * S, y = rnd() * S, ang = rnd() * Math.PI, len = 40 + rnd() * 110, w = 1.5 + rnd() * 2;
    const dk = 0.6 + rnd() * 0.5, bend = (rnd() - 0.5) * 12;
    wrapDraw(g, x, y, len * 0.5, () => {
      g.rotate(ang); g.strokeStyle = rgbStr([0.17, 0.11, 0.065], dk); g.lineWidth = w; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, bend, len / 2, 0); g.stroke();
    });
    wrapDraw(h, x, y, len * 0.5, () => {
      h.rotate(ang); h.strokeStyle = grey(0.88); h.lineWidth = w; h.lineCap = 'round';
      h.beginPath(); h.moveTo(-len / 2, 0); h.lineTo(len / 2, 0); h.stroke();
    });
  }
  const col = readRGB(cC), H = readGrey(cH);
  for (let i = 0; i < S * S; i++) { // cavity: lower leaves sit in shadow of upper ones
    const k = 0.55 + 0.55 * H[i];
    col[i * 3] *= k; col[i * 3 + 1] *= k; col[i * 3 + 2] *= k;
  }
  return { col, H, rough: () => 0.86 };
}

function genMoss() {
  const clump = fbm(10, 4, 301), fuzz = fbm(96, 3, 311), fine = fbm(256, 1, 321), tone = fbm(4, 3, 331);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3);
  const dk = [0.06, 0.10, 0.045], md = [0.12, 0.185, 0.07], tp = [0.235, 0.30, 0.115], ol = [0.18, 0.19, 0.085];
  for (let i = 0; i < S * S; i++) {
    const h = clump[i] * 0.45 + fuzz[i] * 0.4 + fine[i] * 0.15;
    H[i] = h;
    const t1 = ss(0.32, 0.6, h), t2 = ss(0.58, 0.8, h) * (0.6 + 0.4 * fine[i]), t3 = ss(0.55, 0.75, tone[i]) * 0.5;
    let r = L(dk[0], md[0], t1), g = L(dk[1], md[1], t1), b = L(dk[2], md[2], t1);
    r = L(r, tp[0], t2); g = L(g, tp[1], t2); b = L(b, tp[2], t2);
    r = L(r, ol[0], t3); g = L(g, ol[1], t3); b = L(b, ol[2], t3);
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  }
  return { col, H: normalize01(H), rough: () => 0.92 };
}

function genRock() {
  const n1 = fbm(3, 6, 401), rid = fbm(6, 5, 411), fineN = fbm(64, 3, 421), tone = fbm(5, 3, 431), lich = fbm(24, 3, 441), stra = fbm(2, 3, 451);
  const H = new Float32Array(S * S), col = new Float32Array(S * S * 3);
  const dk = [0.16, 0.16, 0.155], lt = [0.40, 0.385, 0.35], wm = [0.37, 0.31, 0.24], cl = [0.24, 0.27, 0.255], lc = [0.42, 0.47, 0.36];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, v = y / S;
    const ridge = 1 - Math.abs(2 * rid[i] - 1);
    const crack = ss(0.92, 0.985, ridge);
    const strata = Math.sin((v + 0.12 * (stra[i] - 0.5)) * Math.PI * 2 * 6) * 0.5 + 0.5;
    const h = n1[i] * 0.5 + ridge * 0.2 + strata * 0.08 + fineN[i] * 0.22 - crack * 0.35;
    H[i] = h;
    const t = ss(0.25, 0.75, h), w = ss(0.45, 0.7, tone[i]) * 0.55;
    const j = ((y + 107) % S) * S + ((x + 190) % S);   // shifted lookup for a decorrelated second tint
    const c = ss(0.55, 0.3, tone[j]) * 0.5, lk = ss(0.66, 0.76, lich[i]) * 0.5, k = (1 - crack * 0.45) * (0.78 + 0.5 * fineN[(y * S + ((x + 97) % S))]);
    for (let ch = 0; ch < 3; ch++) {
      let v3 = L(dk[ch], lt[ch], t);
      v3 = L(v3, wm[ch], w); v3 = L(v3, cl[ch], c); v3 = L(v3, lc[ch], lk);
      col[i * 3 + ch] = v3 * k;
    }
  }
  return { col, H: normalize01(H), rough: () => 0.78 };
}

function genBed() {
  const rnd = mulberry32(5005);
  const cC = newCanvas(), cH = newCanvas();
  const g = cC.getContext('2d'), h = cH.getContext('2d');
  const sandN = fbm(48, 3, 511), sandB = fbm(5, 3, 521);
  const img = g.createImageData(S, S), himg = h.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = sandN[i], t = ss(0.3, 0.7, sandB[i]) * 0.6 + n * 0.4, o = i * 4;
    img.data[o] = L(0.20, 0.36, t) * 255; img.data[o + 1] = L(0.175, 0.31, t) * 255; img.data[o + 2] = L(0.135, 0.235, t) * 255; img.data[o + 3] = 255;
    const hv = 25 + n * 30;
    himg.data[o] = himg.data[o + 1] = himg.data[o + 2] = hv; himg.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0); h.putImageData(himg, 0, 0);
  const pal = [
    [0.30, 0.295, 0.28], [0.34, 0.30, 0.24], [0.17, 0.19, 0.19], [0.25, 0.24, 0.17],
    [0.31, 0.24, 0.20], [0.23, 0.235, 0.23], [0.38, 0.365, 0.32],
  ];
  const N = 380;
  for (let k = 0; k < N; k++) {
    const x = rnd() * S, y = rnd() * S;
    const a = 7 + rnd() * rnd() * 30 + rnd() * 5, b = a * (0.6 + rnd() * 0.35), rot = rnd() * Math.PI;
    const c = pal[Math.floor(rnd() * pal.length)], sh = 0.75 + rnd() * 0.5;
    const top = 0.5 + rnd() * 0.5;
    wrapDraw(g, x, y, a + 2, () => {
      g.rotate(rot); g.scale(a, b);
      const gr = g.createRadialGradient(-0.25, -0.3, 0.05, 0, 0, 1);
      gr.addColorStop(0, rgbStr(c, sh * 1.2)); gr.addColorStop(0.7, rgbStr(c, sh * 0.95)); gr.addColorStop(0.94, rgbStr(c, sh * 0.72)); gr.addColorStop(1, rgbStr(c, sh * 0.5));
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, 7); g.fill();
    });
    wrapDraw(h, x, y, a + 2, () => {
      h.rotate(rot); h.scale(a, b);
      const gr = h.createRadialGradient(0, 0, 0, 0, 0, 1);
      gr.addColorStop(0, grey(top)); gr.addColorStop(0.55, grey(top * 0.92)); gr.addColorStop(0.9, grey(top * 0.55)); gr.addColorStop(1, grey(top * 0.35));
      h.fillStyle = gr; h.beginPath(); h.arc(0, 0, 1, 0, 7); h.fill();
    });
  }
  return { col: readRGB(cC), H: readGrey(cH), rough: () => 0.5 };
}

/* --------------------------------------------------------------- packing */
const BUMP = [2.6, 1.6, 2.4, 2.4, 1.4]; // bump slope gain per layer (see LAYER order)

function pack(layers) {
  const alb8 = new Uint8ClampedArray(S * S * 4 * NL), nrm8 = new Uint8ClampedArray(S * S * 4 * NL);
  layers.forEach((Lyr, li) => {
    const off = li * S * S * 4;
    const { col, H, rough } = Lyr;
    const str = BUMP[li] * 2;
    for (let y = 0; y < S; y++) {
      const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, y0 = y * S;
      for (let x = 0; x < S; x++) {
        const xm = (x - 1 + S) % S, xp = (x + 1) % S, i = y0 + x, o = off + i * 4;
        const dx = (H[y0 + xp] - H[y0 + xm]) * str;
        const dy = (H[yp + x] - H[ym + x]) * str;
        alb8[o] = col[i * 3] * 255; alb8[o + 1] = col[i * 3 + 1] * 255; alb8[o + 2] = col[i * 3 + 2] * 255; alb8[o + 3] = 255;
        nrm8[o] = (0.5 - dx * 0.5) * 255;
        nrm8[o + 1] = (0.5 - dy * 0.5) * 255;
        nrm8[o + 2] = H[i] * 255;
        nrm8[o + 3] = rough(i) * 255;
      }
    }
  });
  return { alb: new Uint8Array(alb8.buffer), nrm: new Uint8Array(nrm8.buffer) };
}

function makeArray(data, srgb) {
  const t = new THREE.DataArrayTexture(data, S, S, NL);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

let cache = null;
export function getGroundTextures() {
  if (cache) return cache;
  const t0 = performance.now();
  const T = [];
  const lap = (n, f) => { const a = performance.now(); const r = f(); T.push(`${n} ${Math.round(performance.now() - a)}`); return r; };
  const layers = [lap('mud', genMud), lap('leaf', genLeaf), lap('moss', genMoss), lap('rock', genRock), lap('bed', genBed)];
  const { alb, nrm } = lap('pack', () => pack(layers));
  cache = { albedo: makeArray(alb, true), normal: makeArray(nrm, false), size: S };
  console.info(`[ground] textures ${Math.round(performance.now() - t0)} ms (${T.join(' | ')})`);
  return cache;
}
