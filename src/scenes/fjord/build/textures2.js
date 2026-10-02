// Extra procedural textures for tunnel / bridge / farm / lighthouse (Canvas 2D, no assets).
import * as THREE from 'three';
import { mulberry32 } from '../../../core/noise.js';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function tex(canvas, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
function lattice(period, rnd) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1;
  return (u, v) => {
    const x = u * period, y = v * period, x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const i0 = x0 % period, i1 = (x0 + 1) % period, j0 = y0 % period, j1 = (y0 + 1) % period;
    const a = g[j0 * period + i0], b = g[j0 * period + i1], c = g[j1 * period + i0], d = g[j1 * period + i1];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };
}
const c255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Grey sprayed-concrete / shotcrete tile (multiplied by vertex colours). */
export function shotcreteTexture() {
  const S = 512, rnd = mulberry32(4242), cv = mk(S, S), g = cv.getContext('2d');
  const img = g.createImageData(S, S), d = img.data, n1 = lattice(8, rnd), n2 = lattice(32, rnd);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let val = 0.8 + 0.09 * n1(u, v) + 0.07 * n2(u, v) + (rnd() - 0.5) * 0.18;
    if (rnd() < 0.004) val -= 0.3;
    const k = (y * S + x) * 4; d[k] = d[k + 1] = c255(val * 255); d[k + 2] = c255(val * 252); d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // form-work joints
  g.fillStyle = 'rgba(40,40,40,0.18)';
  g.fillRect(0, 0, S, 2); g.fillRect(0, S / 2, S, 2); g.fillRect(0, 0, 2, S);
  return tex(cv);
}

/** Dry-stone masonry: courses of irregular stones with dark joints. */
export function stoneTexture() {
  const S = 512, rnd = mulberry32(8080), cv = mk(S, S), g = cv.getContext('2d');
  g.fillStyle = '#4b4741'; g.fillRect(0, 0, S, S);
  const rows = 8, rh = S / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * 60;
    while (x < S) {
      const w = 60 + rnd() * 80, h = rh - 4 - rnd() * 6, y = r * rh + 2 + rnd() * 3;
      const l = 118 + rnd() * 70, warm = rnd() * 14;
      const draw = (dx) => {
        const gr = g.createLinearGradient(x + dx, y, x + dx, y + h);
        gr.addColorStop(0, `rgb(${l + 18 + warm},${l + 14},${l + 6})`); gr.addColorStop(1, `rgb(${l - 22 + warm},${l - 24},${l - 30})`);
        g.fillStyle = gr;
        const rr = 9 + rnd() * 6;
        g.beginPath();
        g.moveTo(x + dx + rr, y); g.arcTo(x + dx + w, y, x + dx + w, y + h, rr); g.arcTo(x + dx + w, y + h, x + dx, y + h, rr); g.arcTo(x + dx, y + h, x + dx, y, rr); g.arcTo(x + dx, y, x + dx + w, y, rr);
        g.closePath(); g.fill();
        for (let k = 0; k < 14; k++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '20,20,20' : '230,225,215'},${0.05 + rnd() * 0.08})`; g.fillRect(x + dx + rnd() * w, y + rnd() * h, 2 + rnd() * 5, 2 + rnd() * 4); }
      };
      draw(0); if (x + w > S) draw(-S);
      x += w + 3 + rnd() * 3;
    }
  }
  return tex(cv);
}

/** Lumpy grass-sod. */
export function turfTexture() {
  const S = 256, rnd = mulberry32(6161), cv = mk(S, S), g = cv.getContext('2d');
  const img = g.createImageData(S, S), d = img.data, n1 = lattice(6, rnd), n2 = lattice(24, rnd);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, n = 0.5 + 0.28 * n1(u, v) + 0.22 * n2(u, v) + (rnd() - 0.5) * 0.3;
    let r = 62 + 78 * n, gg = 92 + 66 * n, b = 36 + 24 * n;
    if (rnd() < 0.03) { r += 50; gg += 34; b += 10; }         // straw
    if (rnd() < 0.03) { r -= 25; gg -= 25; b -= 12; }
    const k = (y * S + x) * 4; d[k] = c255(r); d[k + 1] = c255(gg); d[k + 2] = c255(b); d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(cv);
}

/** Painted vertical boards (white / tar-black facades via vertex tint). */
export function boardsTexture() {
  const S = 256, rnd = mulberry32(1357), cv = mk(S, S), g = cv.getContext('2d');
  const P = 8, pw = S / P;
  for (let i = 0; i < P; i++) {
    const l = 226 + rnd() * 24; g.fillStyle = `rgb(${l},${l},${l - 3})`; g.fillRect(i * pw, 0, pw, S);
    for (let k = 0; k < 8; k++) { g.fillStyle = `rgba(90,80,70,${0.03 + rnd() * 0.05})`; g.fillRect(i * pw + rnd() * pw, 0, 1, S); }
    g.fillStyle = 'rgba(30,25,20,0.55)'; g.fillRect(i * pw, 0, 2, S);
    g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(i * pw + 2, 0, 2, S);
  }
  return tex(cv);
}

/** Soft radial light pool (intensity in RGB, for additive blending). */
export function lightPoolTexture() {
  const S = 128, cv = mk(S, S), g = cv.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgb(255,255,255)'); gr.addColorStop(0.35, 'rgb(150,150,150)'); gr.addColorStop(0.7, 'rgb(36,36,36)'); gr.addColorStop(1, 'rgb(0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = tex(cv); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}
