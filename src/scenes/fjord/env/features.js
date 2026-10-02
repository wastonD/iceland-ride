// Scenic set pieces from layout.features → GLSL masks (shared by terrain, water, flora)
// plus JS mirrors for CPU-side placement / culling.
//
// The layout distorts the lake, geothermal field, bay and glacier outlines with low-frequency
// noise. Those exact shape parameters are baked here on the CPU (only inside each feature's
// bounding box) into one RGBA8 texture, so every shader agrees with the real terrain shape.
// All transitions on top of that are soft and noise-broken — never a clean ring.

import { features as F } from '../layout.js';
import { clamp, smoothstep, lerp, fbm2f } from '../../../core/noise.js';

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const v2 = (x, z) => `vec2(${f(x)}, ${f(z)})`;
const G = F.glacier, L = F.lake, GT = F.geothermal, HF = F.hairpinFall, GO = F.gorge, PA = F.pasture, B = F.bay, LH = F.lighthouse, FM = F.farm;
const Q_SCALE = 2.5;   // texture stores q / Q_SCALE

export const FEATURES = F;

/* ------------------------------------------------ exact (layout) shape params */
function seg(x, z, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
  return { d: Math.hypot(ax + abx * t - x, az + abz * t - z), t };
}
export const lakeR = (x, z) => Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz) * (1 + 0.16 * fbm2f(x * 0.012, z * 0.012, 3, 66));
export const geoQ = (x, z) => (Math.hypot(x - GT.x, z - GT.z) * (1 + 0.3 * fbm2f(x * 0.03, z * 0.03, 3, 67))) / GT.r;
export const bayR = (x, z) => Math.hypot((x - B.x) / B.rx, (z - B.z) / B.rz) * (1 + 0.1 * fbm2f(x * 0.01, z * 0.01, 3, 70));
export function glacierInfo(x, z) {
  const { d, t } = seg(x, z, G.ax, G.az, G.bx, G.bz);
  const w = lerp(G.wTop, G.wEnd, t) * (1 + 0.18 * fbm2f(x * 0.008, z * 0.008, 2, 71));
  return { mask: 1 - smoothstep(w * 0.7, w * 1.05, d), t, d, w, q: d / w };
}
export function gorgeInfo(x, z) {
  const { d, t } = seg(x, z, GO.ax, GO.az, GO.bx, GO.bz);
  const w = lerp(GO.wTopHead, GO.wTopMouth, t);
  return { mask: 1 - smoothstep(w * 0.8, w * 1.3, d), t, d, w };
}

/** RGBA8 1025² (4 m): r lakeR, g geothermal d/r, b bayR, a glacier d/w — each / 2.5. */
export function buildFeatureTexture(N, HALF, RES) {
  const data = new Uint8Array(N * N * 4).fill(255);
  const enc = (v) => Math.round(clamp(v / Q_SCALE, 0, 1) * 255);
  const box = (x0, x1, z0, z1, ch, fn) => {
    const i0 = Math.max(0, Math.floor((x0 + HALF) / RES)), i1 = Math.min(N - 1, Math.ceil((x1 + HALF) / RES));
    const j0 = Math.max(0, Math.floor((z0 + HALF) / RES)), j1 = Math.min(N - 1, Math.ceil((z1 + HALF) / RES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) data[(j * N + i) * 4 + ch] = enc(fn(-HALF + i * RES, -HALF + j * RES));
  };
  box(L.x - L.rx * 2.6, L.x + L.rx * 2.6, L.z - L.rz * 2.6, L.z + L.rz * 2.6, 0, lakeR);
  box(GT.x - GT.r * 2.6, GT.x + GT.r * 2.6, GT.z - GT.r * 2.6, GT.z + GT.r * 2.6, 1, geoQ);
  box(B.x - B.rx * 2.6, B.x + B.rx * 2.6, B.z - B.rz * 2.6, B.z + B.rz * 2.6, 2, bayR);
  const gp = G.wTop * 2.6;
  box(Math.min(G.ax, G.bx) - gp, Math.max(G.ax, G.bx) + gp, Math.min(G.az, G.bz) - gp, Math.max(G.az, G.bz) + gp, 3, (x, z) => glacierInfo(x, z).q);
  return data;
}

export const FEATURE_GLSL = /* glsl */ `
// ---- set pieces (layout.features; outlines baked in tFeat)
uniform sampler2D tFeat;
vec4 featQ(vec2 xz) {
  vec2 d = abs(xz) - 2048.0;
  if (max(d.x, d.y) > 0.0) return vec4(${f(Q_SCALE)});
  return texture(tFeat, ((xz + 2048.0) / 4.0 + 0.5) / 1025.0) * ${f(Q_SCALE)};
}
vec2 fSeg(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return vec2(length(a + ab * t - p), t);
}
// glacier: x = ice mask 0..1, y = t along the ice (0 = head, 1 = tongue), z = d / width
vec3 glacierInfo(vec2 xz) {
  float q = featQ(xz).a;
  float t = fSeg(xz, ${v2(G.ax, G.az)}, ${v2(G.bx, G.bz)}).y;
  return vec3(1.0 - smoothstep(0.7, 1.05, q), t, q);
}
const vec2 G_DIR = ${(() => { const l = Math.hypot(G.bx - G.ax, G.bz - G.az); return v2((G.bx - G.ax) / l, (G.bz - G.az) / l); })()};
float lakeR(vec2 xz) { return featQ(xz).r; }
#define LAKE_LEVEL ${f(L.level)}
#define GEO_R ${f(GT.r)}
#define GEO_C ${v2(GT.x, GT.z)}
float geoD(vec2 xz) { return featQ(xz).g * GEO_R; }
float geoPoolD(vec2 xz) { return length(xz - ${v2(GT.pool.x, GT.pool.z)}); }
#define GEO_POOL_R ${f(GT.pool.r)}
float hfPoolD(vec2 xz) { return length(xz - ${v2(HF.pool.x, HF.pool.z)}); }
// gorge: x = mask, y = t (0 head … 1 mouth), z = distance from the axis
vec3 gorgeInfo(vec2 xz) {
  vec2 s = fSeg(xz, ${v2(GO.ax, GO.az)}, ${v2(GO.bx, GO.bz)});
  float w = mix(${f(GO.wTopHead)}, ${f(GO.wTopMouth)}, s.y);
  return vec3(1.0 - smoothstep(w * 0.8, w * 1.3, s.x), s.y, s.x);
}
// home fields: the rectangle's edge wanders ±60 m and fades over ~70 m
float pastureAtRaw(vec2 xz) {
  vec2 lo = ${v2(PA.x0, PA.z0)}, hi = ${v2(PA.x1, PA.z1)};
  vec2 d = max(lo - xz, xz - hi);
  float o = max(d.x, d.y);
  float n = tgfbm(xz * 0.009 + 4.2) - 0.5;
  return 1.0 - smoothstep(-35.0, 40.0, o + n * 120.0 + (tgn(xz * 0.05) - 0.5) * 18.0);
}
float bayR(vec2 xz) { return featQ(xz).b; }
// black-sand band along the bay shore (r ~0.9–1.0), wobbling a little
float beachAt(vec2 xz) {
  float r = bayR(xz) + (tgn(xz * 0.03) - 0.5) * 0.05;
  return smoothstep(0.86, 0.92, r) * (1.0 - smoothstep(0.99, 1.05, r));
}
// volcanic gravel apron inland of the sand, breaking up into tundra
float lapilliAt(vec2 xz) {
  float r = bayR(xz) + (tgn(xz * 0.022 + 3.0) - 0.5) * 0.12 + (tgn(xz * 0.09) - 0.5) * 0.04;
  return smoothstep(0.92, 1.0, r) * (1.0 - smoothstep(1.08, 1.24, r));
}
float lighthouseD(vec2 xz) { return length(xz - ${v2(LH.x, LH.z)}); }
float farmD(vec2 xz) { return length(xz - ${v2(FM.x, FM.z)}); }
// 1 where ordinary vegetation may grow, 0 in lakes / hot ground / ice / canyon / beach / pools.
// Edges are wide and noise-broken so plant density fades in patches, not along a ring.
float featureClearRaw(vec2 xz) {
  vec4 q = featQ(xz);
  float n = tgn(xz * 0.07 + 1.9) - 0.5, n2 = tgn(xz * 0.021 + 7.3) - 0.5;
  float c = smoothstep(0.92, 1.3, q.r + n * 0.2 + n2 * 0.15);
  c *= smoothstep(0.55, 1.25, q.g + n * 0.35 + n2 * 0.3);
  c *= smoothstep(0.85, 1.35, q.a + n * 0.25 + n2 * 0.2);
  c *= 1.0 - gorgeInfo(xz).x;
  c *= 1.0 - (1.0 - smoothstep(1.0, 1.2, q.b + n * 0.1 + n2 * 0.12)) * step(q.b, 1.5) * 0.85;
  c *= smoothstep(${f(HF.pool.r)} * 1.1, ${f(HF.pool.r)} * 2.2, hfPoolD(xz) + n * 6.0);
  return c;
}
`;

/* ---------------------------------------------------------------- JS mirrors */
// Conservative (no small-scale noise): used to keep static props out of the set pieces.
export function featureClearJS(x, z) {
  let c = smoothstep(0.95, 1.25, lakeR(x, z));
  c *= smoothstep(0.6, 1.2, geoQ(x, z));
  c *= smoothstep(0.9, 1.3, glacierInfo(x, z).q);
  c *= 1 - gorgeInfo(x, z).mask;
  const r = bayR(x, z);
  c *= 1 - (1 - smoothstep(1.0, 1.2, r)) * (r <= 1.5 ? 0.85 : 0);
  c *= smoothstep(HF.pool.r * 1.1, HF.pool.r * 2.2, Math.hypot(x - HF.pool.x, z - HF.pool.z));
  return c;
}
export function pastureJS(x, z) {
  const o = Math.max(PA.x0 - x, x - PA.x1, PA.z0 - z, z - PA.z1);
  return 1 - smoothstep(-35, 100, o);
}
