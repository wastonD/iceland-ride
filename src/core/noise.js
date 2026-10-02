// Deterministic RNG + 2D value/gradient noise + fbm. Shared by every generator
// so the valley is identical on every load.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash → [0,1)
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Gradient noise in [-1,1] (Perlin-style). Optional period (px,py) makes it tileable.
export function noise2(x, y, seed = 0, px = 0, py = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (i, p) => (p ? ((i % p) + p) % p : i);
  const g = (ix, iy, dx, dy) => {
    const a = hash2(wrap(ix, px), wrap(iy, py), seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(x0, y0, fx, fy);
  const n10 = g(x0 + 1, y0, fx - 1, fy);
  const n01 = g(x0, y0 + 1, fx, fy - 1);
  const n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const u = fade(fx), v = fade(fy);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142;
}

// Fractal sum, result roughly in [-1,1].
export function fbm2(x, y, octaves = 5, seed = 0, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 17);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Tileable fbm in [0,1] over a unit square with integer base period `period`.
export function tileFbm(u, v, period, octaves = 5, seed = 0) {
  let sum = 0, amp = 0.5, f = period, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(u * f, v * f, seed + i * 31, f, f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm * 0.5 + 0.5;
}

// Faster gradient noise: 16 precomputed gradient directions instead of per-call trig.
// Different field from noise2 (don't swap it into existing, tuned layouts).
const GX = new Float64Array(16), GY = new Float64Array(16);
for (let i = 0; i < 16; i++) { GX[i] = Math.cos((i / 16) * Math.PI * 2); GY[i] = Math.sin((i / 16) * Math.PI * 2); }
function ghash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 15;
}
export function noise2f(x, y, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const a = ghash(x0, y0, seed), b = ghash(x0 + 1, y0, seed), c = ghash(x0, y0 + 1, seed), d = ghash(x0 + 1, y0 + 1, seed);
  const n00 = GX[a] * fx + GY[a] * fy, n10 = GX[b] * (fx - 1) + GY[b] * fy;
  const n01 = GX[c] * fx + GY[c] * (fy - 1), n11 = GX[d] * (fx - 1) + GY[d] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4142;
}
export function fbm2f(x, y, octaves = 5, seed = 0) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2f(x, y, seed + i * 17);
    norm += amp; amp *= 0.5; x *= 2; y *= 2;
  }
  return sum / norm;
}
