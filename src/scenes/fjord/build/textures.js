// Procedural Canvas textures for the road and the village (zero external assets).
import * as THREE from 'three';
import { mulberry32 } from '../../../core/noise.js';
import { SIGN_ATLAS, SIGN_DEFS } from './signLayout.js';
import { TEX_W } from './roadGeo.js';
export { WIN_CELLS } from './cellIds.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

function tex(canvas, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Periodic value-noise lattice sampler (period cells, bilinear smooth). */
function lattice(period, rnd) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1;
  return (u, v) => { // u,v in [0,1)
    const x = u * period, y = v * period, x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const i0 = x0 % period, i1 = (x0 + 1) % period, j0 = y0 % period, j1 = (y0 + 1) % period;
    const a = g[j0 * period + i0], b = g[j0 * period + i1], c = g[j1 * period + i0], d = g[j1 * period + i1];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };
}

/* ================================================================= asphalt */
export function asphaltTextures(aniso = 8) {
  const S = 1024, R = 512;
  const rnd = mulberry32(90210);
  const cv = mk(S, S), g = cv.getContext('2d');
  const rv = mk(R, R), rg = rv.getContext('2d');
  const n1 = lattice(6, rnd), n2 = lattice(18, rnd), n3 = lattice(48, rnd);

  // --- per-pixel base: warm dark grey, mottled, coarse aggregate speckle
  const img = g.createImageData(S, S), d = img.data;
  const base = [116, 112, 107];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let val = 1 + 0.025 * n1(u, v) + 0.02 * n2(u, v) + 0.04 * n3(u, v) + (rnd() - 0.5) * 0.2;
    const r = rnd();
    if (r < 0.012) val += 0.32; else if (r > 0.99) val -= 0.26;
    const k = (y * S + x) * 4;
    d[k] = base[0] * val; d[k + 1] = base[1] * val; d[k + 2] = base[2] * val * 0.99; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  rg.fillStyle = 'rgb(226,226,226)'; rg.fillRect(0, 0, R, R);

  const pxPerM = S / TEX_W;
  const X = (lat) => (lat / TEX_W + 0.5) * S;
  const wrap = (fn) => { for (const dy of [-S, 0, S]) fn(dy); };
  const both = (fa, fr) => { wrap((dy) => { g.save(); g.translate(0, dy); fa(g, 1); g.restore(); rg.save(); rg.translate(0, dy * 0.5); rg.scale(0.5, 0.5); fr(rg, 1); rg.restore(); }); };

  // wheel tracks: polished, slightly lighter; oil ridge between them
  for (const lc of [-1.875, 1.875]) {
    for (const off of [-0.82, 0.82]) {
      const cx = X(lc + off), hw = 0.42 * pxPerM;
      both((c) => { const gr = c.createLinearGradient(cx - hw, 0, cx + hw, 0); gr.addColorStop(0, 'rgba(150,143,134,0)'); gr.addColorStop(0.5, 'rgba(160,154,146,0.10)'); gr.addColorStop(1, 'rgba(150,143,134,0)'); c.fillStyle = gr; c.fillRect(cx - hw, 0, hw * 2, S); },
        (c) => { const gr = c.createLinearGradient(cx - hw, 0, cx + hw, 0); gr.addColorStop(0, 'rgba(190,190,190,0)'); gr.addColorStop(0.5, 'rgba(190,190,190,0.7)'); gr.addColorStop(1, 'rgba(190,190,190,0)'); c.fillStyle = gr; c.fillRect(cx - hw, 0, hw * 2, S); });
    }
    const cx = X(lc), hw = 0.32 * pxPerM;
    both((c) => { const gr = c.createLinearGradient(cx - hw, 0, cx + hw, 0); gr.addColorStop(0, 'rgba(28,26,24,0)'); gr.addColorStop(0.5, 'rgba(28,26,24,0.07)'); gr.addColorStop(1, 'rgba(28,26,24,0)'); c.fillStyle = gr; c.fillRect(cx - hw, 0, hw * 2, S); }, () => {});
  }

  // repair patches: very few, long irregular blobs, barely different from the surroundings (no outlines)
  for (let i = 0; i < 1; i++) {
    const lat = (rnd() - 0.5) * 5, len = (3.5 + rnd() * 2.5) * pxPerM, wid = (0.7 + rnd() * 0.7) * pxPerM;
    const cx = X(lat), cy = rnd() * S, dark = rnd() < 0.5, ang = (rnd() - 0.5) * 0.12;
    const pts = [];
    const N = 28, ph = [rnd() * 6, rnd() * 6, rnd() * 6];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const jit = 1 + 0.16 * Math.sin(a * 3 + ph[0]) + 0.1 * Math.sin(a * 7 + ph[1]) + 0.06 * Math.sin(a * 13 + ph[2]);
      const lx = Math.cos(a) * wid * jit, ly = Math.sin(a) * len * jit;
      pts.push([cx + lx * Math.cos(ang) - ly * Math.sin(ang), cy + lx * Math.sin(ang) + ly * Math.cos(ang)]);
    }
    const path = (c) => { c.beginPath(); pts.forEach((p, k) => (k ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath(); };
    both((c) => { c.fillStyle = dark ? 'rgba(60,58,56,0.07)' : 'rgba(170,165,158,0.07)'; path(c); c.fill(); }, (c) => { c.fillStyle = 'rgb(236,236,236)'; path(c); c.fill(); });
  }

  // a few fine hairline cracks (thin, faint; mip-mapping fades them with distance)
  for (let i = 0; i < 6; i++) {
    let x = X((rnd() - 0.5) * 7), y = rnd() * S;
    const len = 60 + rnd() * 160; let a = Math.PI / 2 + (rnd() - 0.5) * 0.6;
    const pts = [[x, y]];
    for (let s = 0; s < len; s += 7) {
      a += (rnd() - 0.5) * 0.7 + (Math.PI / 2 - a) * 0.15;
      x += Math.cos(a) * 7; y += Math.sin(a) * 7; pts.push([x, y]);
    }
    both((c) => { c.strokeStyle = 'rgba(30,28,27,0.32)'; c.lineWidth = 0.9; c.beginPath(); pts.forEach((p, k) => (k ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.stroke(); }, () => {});
  }

  // oil stains
  for (let i = 0; i < 6; i++) {
    const x = X((rnd() < 0.5 ? -1 : 1) * 1.875 + (rnd() - 0.5) * 0.3), y = rnd() * S, r = (18 + rnd() * 26);
    both((c) => { const gr = c.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(22,21,22,0.14)'); gr.addColorStop(1, 'rgba(22,21,22,0)'); c.fillStyle = gr; c.fillRect(x - r, y - r, r * 2, r * 2); }, () => {});
  }

  // dusty / gravelly edges (beyond ±3.75 the strip is the bevel, so keep it earthy)
  for (const sd of [-1, 1]) {
    const xe = X(sd * 3.75), xo = X(sd * 4.3), xi = X(sd * 3.15);
    both((c) => {
      let gr = c.createLinearGradient(xi, 0, xe, 0); gr.addColorStop(0, 'rgba(140,124,100,0)'); gr.addColorStop(1, 'rgba(140,124,100,0.32)');
      c.fillStyle = gr; c.fillRect(Math.min(xi, xe), 0, Math.abs(xe - xi), S);
      c.fillStyle = 'rgba(122,108,88,0.75)'; c.fillRect(Math.min(xe, xo), 0, Math.abs(xo - xe), S);
    }, (c) => { c.fillStyle = 'rgb(245,245,245)'; c.fillRect(Math.min(xi, xo), 0, Math.abs(xo - xi), S); });
    for (let i = 0; i < 420; i++) {
      const x = X(sd * (3.0 + rnd() * 1.0)), y = rnd() * S, r = 0.7 + rnd() * 1.6, l = 110 + rnd() * 90;
      both((c) => { c.fillStyle = `rgba(${l},${l * 0.94},${l * 0.82},0.8)`; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }, () => {});
    }
  }

  return { map: tex(cv, { aniso }), roughnessMap: tex(rv, { srgb: false, aniso }) };
}

/* ============================================================ marking wear */
export function markingWearTexture() {
  const S = 256, rnd = mulberry32(777), cv = mk(S, S), g = cv.getContext('2d');
  const img = g.createImageData(S, S), d = img.data, n1 = lattice(8, rnd), n2 = lattice(32, rnd);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, k = (y * S + x) * 4;
    const w = 0.55 * n1(u, v) + 0.35 * n2(u, v) + (rnd() - 0.5) * 0.9;
    const hole = w > 0.78;
    const lum = 236 + rnd() * 19;
    d[k] = d[k + 1] = d[k + 2] = lum;
    d[k + 3] = hole ? 0 : 255;
  }
  g.putImageData(img, 0, 0);
  return tex(cv, { aniso: 8 });
}

/* ================================================================== signs */
export function signAtlas(info) {
  const { w: W, h: H } = SIGN_ATLAS, cv = mk(W, H), g = cv.getContext('2d');
  const BLUE = '#0a5aa6', RED = '#c8151d';
  const font = (px, weight = 'bold') => `${weight} ${px}px "Segoe UI", Arial, "Helvetica Neue", sans-serif`;
  const km = (v) => (v < 0.95 ? `${Math.round(v * 10) / 10}`.replace('.', ',') + ' km' : `${Math.round(v * 10) / 10}`.replace('.', ',') + ' km');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const blueSign = ([x, y, w, h]) => {
    g.fillStyle = BLUE; rr(x, y, w, h, 16); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 6; rr(x + 8, y + 8, w - 16, h - 16, 10); g.stroke();
  };
  g.textBaseline = 'middle';

  // place-name signs
  const fit = (str, px, maxW, weight = 'bold') => { let p = px; g.font = font(p, weight); while (g.measureText(str).width > maxW && p > 20) { p -= 2; g.font = font(p, weight); } };
  const arrow = (x, y, w) => {
    const ax = x + w - 56;
    g.fillStyle = '#fff'; g.beginPath();
    [[ax - 9, y + 165], [ax - 9, y + 104], [ax - 28, y + 104], [ax, y + 62], [ax + 28, y + 104], [ax + 9, y + 104], [ax + 9, y + 165]].forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath(); g.fill();
  };
  let [x, y, w, h] = SIGN_DEFS.place.rect;
  blueSign(SIGN_DEFS.place.rect);
  g.fillStyle = '#fff'; g.textAlign = 'left';
  fit('Seyðisfjörður', 60, w - 130); g.fillText('Seyðisfjörður', x + 30, y + 66);
  g.font = font(46, '600'); g.fillText(km(info.placeKm), x + 30, y + 140);
  arrow(x, y, w);

  [x, y, w, h] = SIGN_DEFS.placeEnd.rect;
  blueSign(SIGN_DEFS.placeEnd.rect);
  g.fillStyle = '#fff';
  fit('Seyðisfjörður', 60, w - 130); g.fillText('Seyðisfjörður', x + 30, y + 66);
  g.font = font(44, '600'); g.fillText('Miðbær  ' + km(info.endKm), x + 30, y + 140);
  arrow(x, y, w);

  // warning triangles
  const triangle = ([x, y, w, h]) => {
    const p = [[x + w / 2, y + 8], [x + w - 6, y + h - 10], [x + 6, y + h - 10]];
    g.lineJoin = 'round';
    g.beginPath(); p.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath();
    g.fillStyle = RED; g.fill();
    const c = [x + w / 2, y + h * 0.62], k = 0.72;
    g.beginPath(); p.forEach((q, i) => { const px = c[0] + (q[0] - c[0]) * k, py = c[1] + (q[1] - c[1]) * k; i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    return c;
  };
  let c = triangle(SIGN_DEFS.hill.rect);
  [x, y, w, h] = SIGN_DEFS.hill.rect;
  g.fillStyle = '#111'; g.textAlign = 'center'; g.font = font(70);
  g.fillText('8%', c[0] + 14, c[1] + 44);
  g.beginPath(); g.moveTo(c[0] - 78, c[1] - 30); g.lineTo(c[0] + 62, c[1] + 20); g.lineTo(c[0] - 78, c[1] + 20); g.closePath(); g.fill(); // ramp

  c = triangle(SIGN_DEFS.bend.rect);
  [x, y, w, h] = SIGN_DEFS.bend.rect;
  g.strokeStyle = '#111'; g.lineWidth = 14; g.lineCap = 'butt';
  g.beginPath(); g.moveTo(c[0] - 22, c[1] + 64); g.lineTo(c[0] - 22, c[1] + 16); g.quadraticCurveTo(c[0] - 22, c[1] - 26, c[0] + 22, c[1] - 26); g.stroke();
  g.fillStyle = '#111'; g.beginPath(); g.moveTo(c[0] + 18, c[1] - 62); g.lineTo(c[0] + 62, c[1] - 26); g.lineTo(c[0] + 18, c[1] + 10); g.closePath(); g.fill();

  // viewpoint / parking sign
  [x, y, w, h] = SIGN_DEFS.view.rect;
  blueSign(SIGN_DEFS.view.rect);
  g.fillStyle = '#fff'; rr(x + 34, y + 34, 130, 130, 14); g.fill();
  g.fillStyle = BLUE; g.font = font(120); g.textAlign = 'center'; g.fillText('P', x + 99, y + 102);
  g.fillStyle = '#fff'; g.font = font(48); g.textAlign = 'left'; g.fillText('Útsýnis-', x + 178, y + 78); g.fillText('staður', x + 178, y + 126);
  g.font = font(38, '600'); g.textAlign = 'center'; g.fillText('Seyðisfjörður  ▸', x + w / 2, y + h - 62);
  // little camera icon
  g.fillStyle = '#fff'; rr(x + w / 2 - 34, y + h - 130 + 0, 68, 44, 8); g.fill(); g.fillStyle = BLUE; g.beginPath(); g.arc(x + w / 2, y + h - 108, 13, 0, 7); g.fill();

  // yellow sharp-bend boards
  for (const dir of [-1, 1]) {
    const key = dir < 0 ? 'warnL' : 'warnR';
    const [bx, by, bw, bh] = SIGN_DEFS[key].rect;
    g.fillStyle = '#f4c400'; rr(bx, by, bw, bh, 20); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = 8; rr(bx + 6, by + 6, bw - 12, bh - 12, 14); g.stroke();
    const cx = bx + bw / 2 - dir * 4, cy = by + bh / 2 - 10;
    g.strokeStyle = '#111'; g.lineWidth = 26; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(cx - dir * 30, cy + 76); g.lineTo(cx - dir * 30, cy + 20); g.quadraticCurveTo(cx - dir * 30, cy - 30, cx + dir * 30, cy - 30); g.stroke();
    g.fillStyle = '#111'; g.beginPath(); g.moveTo(cx + dir * 22, cy - 82); g.lineTo(cx + dir * 84, cy - 30); g.lineTo(cx + dir * 22, cy + 22); g.closePath(); g.fill();
    g.fillStyle = '#111'; g.textAlign = 'center'; g.font = font(30); g.fillText('Kröpp beygja', bx + bw / 2, by + bh - 34);
  }
  // tunnel sign
  {
    const [tx, ty, tw, th] = SIGN_DEFS.tunnel.rect;
    blueSign(SIGN_DEFS.tunnel.rect);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(tx + 60, ty + th - 40); g.lineTo(tx + 60, ty + 100); g.arc(tx + 120, ty + 100, 60, Math.PI, 0); g.lineTo(tx + 180, ty + th - 40); g.closePath(); g.fill();
    g.fillStyle = BLUE; g.beginPath(); g.moveTo(tx + 84, ty + th - 40); g.lineTo(tx + 84, ty + 104); g.arc(tx + 120, ty + 104, 36, Math.PI, 0); g.lineTo(tx + 156, ty + th - 40); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = font(78); g.fillText('Göng', tx + 210, ty + 92);
    g.font = font(38, '600'); g.fillText('Ljós kveikt', tx + 210, ty + 170);
  }

  // neutral grey texel block for the panel backs
  g.fillStyle = '#8c9096'; g.fillRect(W - 40, H - 40, 40, 40);

  return tex(cv, { repeat: false, aniso: 8 });
}

/* ====================================================== corrugated iron */
export function corrugationTextures() {
  const W = 220, H = 128, rnd = mulberry32(555);
  const cv = mk(W, H), g = cv.getContext('2d');
  const nv = mk(W, H), ng = nv.getContext('2d');
  const img = g.createImageData(W, H), d = img.data, nimg = ng.createImageData(W, H), nd = nimg.data;
  const colJit = new Float32Array(W); for (let x = 0; x < W; x++) colJit[x] = (rnd() - 0.5) * 0.04;
  const n = lattice(8, rnd);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ph = (x / 20) * Math.PI * 2, k = (y * W + x) * 4;
    const rib = 0.5 + 0.5 * Math.cos(ph);
    let v = 0.76 + 0.22 * rib + colJit[x] + 0.05 * n(x / W, y / H) + (rnd() - 0.5) * 0.03;
    if (y % H < 2) v *= 0.93; // panel lap
    d[k] = d[k + 1] = d[k + 2] = clamp255(v * 255); d[k + 3] = 255;
    const nx = 0.7 * Math.sin(ph), nz = Math.sqrt(1 - nx * nx * 0.5);
    const l = Math.hypot(nx, nz);
    nd[k] = clamp255(((nx / l) * 0.5 + 0.5) * 255); nd[k + 1] = 128; nd[k + 2] = clamp255(((nz / l) * 0.5 + 0.5) * 255); nd[k + 3] = 255;
  }
  g.putImageData(img, 0, 0); ng.putImageData(nimg, 0, 0);
  // faint rust / dirt streaks
  g.globalAlpha = 0.14;
  for (let i = 0; i < 26; i++) { const x = Math.floor(rnd() * W), y = rnd() * H, l = 10 + rnd() * 40; g.fillStyle = rnd() < 0.6 ? '#3a2a20' : '#fff'; g.fillRect(x, y, 2, l); }
  g.globalAlpha = 1;
  return { map: tex(cv, { aniso: 8 }), normalMap: tex(nv, { srgb: false, aniso: 8 }) };
}
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/* ===================================================== window / door atlas */
// 8 columns x 2 rows of 128 px cells: row 0 unlit, row 1 lit. Same layout for the emissive map.

export function windowAtlas() {
  const C = 128, cv = mk(C * 8, C * 2), g = cv.getContext('2d');
  const ev = mk(C * 8, C * 2), e = ev.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, C * 8, C * 2);
  g.fillStyle = '#fff'; g.fillRect(0, 0, C * 8, C * 2);
  const WHITE = '#eeede6', SHADE = '#c9c8c0';

  const glass = (x, y, w, h, lit, kind) => {
    if (w <= 0 || h <= 0) return;
    const gr = g.createLinearGradient(x, y, x + w * 0.4, y + h);
    gr.addColorStop(0, '#7f9db4'); gr.addColorStop(0.55, '#3f586d'); gr.addColorStop(1, '#2b3c4b');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.20)'; g.beginPath(); g.moveTo(x + w * 0.1, y + h); g.lineTo(x + w * 0.5, y); g.lineTo(x + w * 0.72, y); g.lineTo(x + w * 0.32, y + h); g.fill();
    if (lit) { // emissive only: warm room light with curtain edges
      e.fillStyle = '#ffbb66'; e.fillRect(x, y, w, h);
      e.fillStyle = 'rgba(255,238,200,0.5)'; e.fillRect(x, y, w * 0.2, h); e.fillRect(x + w * 0.8, y, w * 0.2, h);
      e.fillStyle = 'rgba(0,0,0,0.35)'; e.fillRect(x, y + h * 0.72, w, h * 0.28);
    }
  };
  const bars = (x, y, w, h, cols, rows, t) => {
    g.fillStyle = WHITE;
    for (let i = 1; i < cols; i++) g.fillRect(x + (w * i) / cols - t / 2, y, t, h);
    for (let j = 1; j < rows; j++) g.fillRect(x, y + (h * j) / rows - t / 2, w, t);
  };
  const frame = (ox, oy, m, cols, rows, lit, sill = true) => {
    g.fillStyle = WHITE; g.fillRect(ox, oy, C, C);
    g.fillStyle = SHADE; g.fillRect(ox, oy + C - 6, C, 6);
    glass(ox + m, oy + m, C - 2 * m, C - 2 * m - (sill ? 6 : 0), lit);
    bars(ox + m, oy + m, C - 2 * m, C - 2 * m - (sill ? 6 : 0), cols, rows, 6);
  };
  for (let row = 0; row < 2; row++) {
    const lit = row === 1, oy = row * C;
    // 0 win2 : two tall panes
    let ox = 0 * C; frame(ox, oy, 12, 2, 1, lit);
    // 1 win6
    ox = 1 * C; frame(ox, oy, 12, 2, 3, lit);
    // 2 door
    ox = 2 * C; g.fillStyle = WHITE; g.fillRect(ox, oy, C, C);
    g.fillStyle = '#7b2c25'; g.fillRect(ox + 12, oy + 8, C - 24, C - 8);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(ox + 22, oy + 66, C - 44, 50); g.fillRect(ox + 22, oy + 18, C - 44, 40);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(ox + 24, oy + 68, C - 48, 6);
    glass(ox + 30, oy + 22, C - 60, 30, lit);
    g.fillStyle = '#d8c48a'; g.beginPath(); g.arc(ox + C - 26, oy + 74, 4, 0, 7); g.fill();
    // 3 church arched window
    ox = 3 * C; g.fillStyle = WHITE; g.fillRect(ox, oy, C, C);
    g.save(); g.beginPath(); g.moveTo(ox + 22, oy + C - 6); g.lineTo(ox + 22, oy + 46); g.arc(ox + C / 2, oy + 46, C / 2 - 22, Math.PI, 0); g.lineTo(ox + C - 22, oy + C - 6); g.closePath(); g.clip();
    if (lit) { e.save(); e.beginPath(); e.moveTo(ox + 22, oy + C - 6); e.lineTo(ox + 22, oy + 46); e.arc(ox + C / 2, oy + 46, C / 2 - 22, Math.PI, 0); e.lineTo(ox + C - 22, oy + C - 6); e.closePath(); e.fillStyle = '#ffae4a'; e.fill(); e.restore(); }
    { const gr = g.createLinearGradient(ox, oy, ox + C, oy + C); gr.addColorStop(0, '#5d7f9f'); gr.addColorStop(1, '#2a3f57'); g.fillStyle = gr; g.fillRect(ox, oy, C, C); }
    g.fillStyle = WHITE; g.fillRect(ox + C / 2 - 3, oy, 6, C); g.fillRect(ox, oy + 62, C, 5);
    g.restore();
    g.fillStyle = SHADE; g.fillRect(ox + 14, oy + C - 6, C - 28, 6);
    // 4 church door (double, arched)
    ox = 4 * C; g.fillStyle = WHITE; g.fillRect(ox, oy, C, C);
    g.save(); g.beginPath(); g.moveTo(ox + 14, oy + C); g.lineTo(ox + 14, oy + 54); g.arc(ox + C / 2, oy + 54, C / 2 - 14, Math.PI, 0); g.lineTo(ox + C - 14, oy + C); g.closePath(); g.clip();
    g.fillStyle = '#3d2c2a'; g.fillRect(ox, oy, C, C);
    g.fillStyle = 'rgba(255,255,255,0.08)'; for (let i = 0; i < 6; i++) g.fillRect(ox + 16 + i * 16, oy + 20, 3, C);
    g.fillStyle = WHITE; g.fillRect(ox + C / 2 - 2, oy, 4, C);
    g.restore();
    g.fillStyle = '#d8c48a'; g.beginPath(); g.arc(ox + C / 2 - 10, oy + 84, 3.5, 0, 7); g.arc(ox + C / 2 + 10, oy + 84, 3.5, 0, 7); g.fill();
    // 5 attic small window
    ox = 5 * C; frame(ox, oy, 14, 2, 2, lit, false);
    // 6 shop wide window
    ox = 6 * C; frame(ox, oy, 10, 3, 1, lit);
    // 7 louvre opening
    ox = 7 * C; g.fillStyle = WHITE; g.fillRect(ox, oy, C, C);
    g.save(); g.beginPath(); g.moveTo(ox + 24, oy + C - 6); g.lineTo(ox + 24, oy + 50); g.arc(ox + C / 2, oy + 50, C / 2 - 24, Math.PI, 0); g.lineTo(ox + C - 24, oy + C - 6); g.closePath(); g.clip();
    g.fillStyle = '#231c1a'; g.fillRect(ox, oy, C, C);
    g.fillStyle = 'rgba(220,215,200,0.55)'; for (let i = 0; i < 9; i++) g.fillRect(ox, oy + 20 + i * 12, C, 4);
    g.restore();
  }
  return { map: tex(cv, { repeat: false, aniso: 8 }), emissiveMap: tex(ev, { repeat: false, aniso: 4 }) };
}

/* ========================================================== weathered wood */
export function woodTexture() {
  const S = 256, rnd = mulberry32(31337), cv = mk(S, S), g = cv.getContext('2d');
  const P = 5, pw = S / P;
  for (let i = 0; i < P; i++) {
    const l = 96 + rnd() * 26, x = i * pw;
    g.fillStyle = `rgb(${l * 1.04},${l * 0.94},${l * 0.82})`; g.fillRect(x, 0, pw, S);
    for (let k = 0; k < 22; k++) { g.fillStyle = `rgba(30,22,14,${0.05 + rnd() * 0.10})`; g.fillRect(x + rnd() * pw, 0, 1, S); }
    for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(200,190,170,${0.05 + rnd() * 0.08})`; g.fillRect(x + rnd() * pw, rnd() * S, 1, 20 + rnd() * 60); }
    const seam = rnd() * S; g.fillStyle = 'rgba(20,14,8,0.65)'; g.fillRect(x, seam, pw, 2);
    if (rnd() < 0.7) { const kx = x + 10 + rnd() * (pw - 20), ky = rnd() * S; g.fillStyle = 'rgba(40,28,18,0.45)'; g.beginPath(); g.ellipse(kx, ky, 4, 7, 0, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(15,11,7,0.7)'; g.fillRect(x, 0, 2, S);
  }
  return tex(cv, { aniso: 8 });
}

/* ==================================================== light paint speckle */
export function paintTexture() {
  const S = 128, rnd = mulberry32(2024), cv = mk(S, S), g = cv.getContext('2d');
  const img = g.createImageData(S, S), d = img.data, n = lattice(6, rnd);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = (y * S + x) * 4, v = 0.9 + 0.04 * n(x / S, y / S) + (rnd() - 0.5) * 0.1 - (rnd() < 0.02 ? 0.12 : 0);
    d[k] = d[k + 1] = d[k + 2] = clamp255(v * 255); d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(cv, { aniso: 8 });
}
