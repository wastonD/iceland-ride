// Shared terrain data for the fjord: GPU height / normal / road-distance textures,
// the far "outer ring" heightfield, the river profile (carved into the heights),
// and GPU-baked terrain self-shadow (sun visibility) + sky AO.
//
// One instance per world (cached). Terrain, water and flora all sample the same
// GLSL functions (TERRAIN_GLSL), so grass sits exactly on the rendered ground and
// water depth matches the shoreline.
//
//   td.uniforms           — spread into any shader that includes td.GLSL
//   td.GLSL               — uniforms + baseH / terrSurface / terrNormal / terrSunVis / terrAO / lupineAt …
//   td.heightAt(x,z)      — CPU height (grid + river carve, no micro detail)
//   td.river              — { z0, z1, levelAt(z), widthAt(z) }
//   td.update(renderer)   — re-bakes the sun visibility when the sun moves
//   addBakedLight(mat,td) — patch: multiply sun by baked terrain shadow, ambient by AO

import * as THREE from 'three';
import { fbm2f as fbm2, noise2f as noise2, smoothstep, clamp, lerp } from '../../../core/noise.js';
import { addShaderPatch } from '../../../render/shaderPatch.js';
import { FEATURE_GLSL, FEATURES, featureClearJS, pastureJS, gorgeInfo as gorgeInfoJS, glacierInfo as glacierInfoJS, buildFeatureTexture } from './features.js';

export const T_HALF = 2048, T_RES = 4, T_N = 1025;
export const F_HALF = 12288, F_N = 257, F_RES = (F_HALF * 2) / (F_N - 1); // 96 m

/* ------------------------------------------------------------------ GLSL */
export const TNOISE_GLSL = /* glsl */ `
const mat2 GROT2 = mat2(0.8, -0.6, 0.6, 0.8);
float tgh(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tgn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tgh(i), tgh(i + vec2(1.0, 0.0)), f.x), mix(tgh(i + vec2(0.0, 1.0)), tgh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float tgfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * tgn(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return s / 0.9375;
}
// value noise + analytic derivatives: x = value, yz = d/dp
vec3 tgnd(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = tgh(i), b = tgh(i + vec2(1.0, 0.0)), c = tgh(i + vec2(0.0, 1.0)), d = tgh(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}
`;

const GLSL = /* glsl */ `
#ifndef FJORD_TERRAIN_GLSL
#define FJORD_TERRAIN_GLSL
uniform highp sampler2D tHgt;   // R32F  ${T_N}^2, 4 m, heights (river carved)
uniform highp sampler2D tNrm;   // RGBA32F ${T_N}^2: normal.xyz, road distance
uniform highp sampler2D tFarH;  // R32F  ${F_N}^2, ${F_RES} m, outer ring macro heights
uniform sampler2D tSunIn, tSunFar, tAOIn, tAOFar;
uniform vec3 uLodCam;           // camera position used for LOD / detail fade

#define T_HALF ${T_HALF.toFixed(1)}
#define T_RES ${T_RES.toFixed(1)}
#define T_NI ${T_N}
#define F_HALF ${F_HALF.toFixed(1)}
#define F_RES ${F_RES.toFixed(1)}
#define F_NI ${F_N}
${TNOISE_GLSL}
${FEATURE_GLSL}

float fetchBil(highp sampler2D t, vec2 f, int n) {
  f = clamp(f, vec2(0.0), vec2(float(n) - 1.001));
  ivec2 i = ivec2(f); vec2 w = f - vec2(i);
  float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
  float c = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
float outDist(vec2 xz) { vec2 d = abs(xz) - T_HALF; return max(max(d.x, d.y), 0.0); }
vec2 innerUV(vec2 xz) { return ((xz + T_HALF) / T_RES + 0.5) / float(T_NI); }
vec2 farUV(vec2 xz) { return ((xz + F_HALF) / F_RES + 0.5) / float(F_NI); }

// Ridged crests on the outer mountains (the far texture is only ${F_RES} m).
float farRidge(vec2 xz, float h) {
  float r1 = 1.0 - abs(tgn(xz / 420.0 + 11.3) * 2.0 - 1.0);
  float r2 = 1.0 - abs(tgn(xz / 170.0 + 3.7) * 2.0 - 1.0);
  float amp = smoothstep(120.0, 700.0, h);
  return (r1 * r1 * 70.0 + r2 * r2 * 26.0 - 40.0) * amp;
}

float innerH(vec2 xz) { return fetchBil(tHgt, (xz + T_HALF) / T_RES, T_NI); }
float baseH(vec2 xz) {
  float hi = innerH(xz);
  float o = outDist(xz);
  if (o <= 0.0) return hi;
  float hf = fetchBil(tFarH, (xz + F_HALF) / F_RES, F_NI);
  hf += farRidge(xz, hf);
  return mix(hi, hf, smoothstep(0.0, 900.0, o));
}

vec3 terrNormal(vec2 xz) {
  vec3 ni = texture(tNrm, innerUV(xz)).xyz;
  float o = outDist(xz);
  if (o <= 0.0) return normalize(ni);
  float e = 14.0;
  vec3 nf = normalize(vec3(baseH(xz - vec2(e, 0.0)) - baseH(xz + vec2(e, 0.0)), 2.0 * e,
                           baseH(xz - vec2(0.0, e)) - baseH(xz + vec2(0.0, e))));
  return normalize(mix(ni, nf, smoothstep(0.0, 120.0, o)));
}
float roadDist(vec2 xz) { return outDist(xz) > 0.0 ? 1e4 : texture(tNrm, innerUV(xz)).w; }

float valleyX(float z) { return 120.0 * sin(z * 0.0016 + 0.6) + 60.0 * sin(z * 0.0041); }
float riverX(float z) { return valleyX(z) + 40.0 * sin(z * 0.006); }
float riverDist(vec2 xz) { return (xz.y > -900.0 && xz.y < 1000.0) ? abs(xz.x - riverX(xz.y)) : 1e4; }

float terrSunVis(vec2 xz) {
  return outDist(xz) > 0.0 ? texture(tSunFar, farUV(xz)).r : texture(tSunIn, innerUV(xz)).r;
}
float terrAO(vec2 xz) {
  return outDist(xz) > 0.0 ? texture(tAOFar, farUV(xz)).r : texture(tAOIn, innerUV(xz)).r;
}

// Micro relief (frost hummocks on the tundra, rough rock on steep ground). Faded with
// camera distance so it never aliases on coarse LODs. Returns (dh, d/dx, d/dz).
vec3 terrDetail(vec2 xz, float ny, float roadD, float h, float camD) {
  // hummocks on gentle ground only — vertical displacement on cliffs saws their edges into teeth
  float amp = 0.34 * smoothstep(0.62, 0.85, ny);
  amp *= smoothstep(6.5, 15.0, roadD);
  amp *= smoothstep(0.4, 3.5, h);
  float rv = length((xz - vec2(-40.0, 900.0)) * vec2(1.0, 1.4));
  amp *= mix(0.15, 1.0, smoothstep(110.0, 190.0, rv));
  amp *= smoothstep(9.0, 16.0, riverDist(xz));
  float f1 = amp * 0.62 * (1.0 - smoothstep(210.0, 290.0, camD));
  float f2 = amp * 0.30 * (1.0 - smoothstep(95.0, 135.0, camD));
  if (f1 <= 0.0) return vec3(0.0);
  vec3 n1 = tgnd(xz / 6.5 + 3.1);
  vec3 n2 = tgnd(xz / 3.1 + 7.7);
  // hummocks: bias the low-frequency noise into rounded mounds
  float m1 = n1.x * n1.x * 1.6 - 0.45;
  vec2 g1 = 2.0 * n1.x * 1.6 * n1.yz / 6.5;
  return vec3(m1 * f1 + (n2.x - 0.5) * f2, g1 * f1 + n2.yz / 3.1 * f2);
}

// Full rendered surface: height + world normal (macro normal tilted by the detail gradient).
// camD = horizontal distance to uLodCam.
vec4 terrSurface(vec2 xz, float camD, out vec3 detailInfo) {
  float h = baseH(xz);
  vec3 n = terrNormal(xz);
  float rd = roadDist(xz);
  vec3 d = terrDetail(xz, n.y, rd, h, camD);
  detailInfo = d;
  h += d.x;
  n = normalize(n + vec3(-d.y, 0.0, -d.z) * n.y);
  return vec4(n, h);
}

// Macro tundra-grass colour (terrain + grass instances share it so tufts melt into the ground).
vec3 terrGrassTintRaw(vec2 xz, float slope0) {
  // Icelandic summer heath: yellow-green, olive, brown-green sedge and grey-green moss
  // in big 50–200 m patches, mottled at ~15 m. Kept ~20 % below full saturation.
  float m1 = tgfbm(xz * 0.0075 + 1.3);
  float m2 = tgfbm(xz * 0.018 + vec2(7.1, 2.9));
  float m3 = tgn(xz * 0.06 + 3.3);
  vec3 yel = vec3(0.225, 0.24, 0.072), oli = vec3(0.095, 0.115, 0.045);
  vec3 brn = vec3(0.15, 0.12, 0.066), gry = vec3(0.115, 0.13, 0.088);
  vec3 c = mix(oli, yel, smoothstep(0.36, 0.64, m1 + (m3 - 0.5) * 0.12));
  c = mix(c, brn, smoothstep(0.48, 0.62, m2 + slope0 * 0.4 - m1 * 0.15) * 0.85);
  c = mix(c, gry, smoothstep(0.56, 0.7, 1.0 - m2 + (m3 - 0.5) * 0.3) * 0.6);
  c *= 0.78 + 0.44 * m3;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.92);
  // home-field pasture: lusher, fresher green (still not lawn green)
  float pa = pastureAtRaw(xz);
  vec3 lush = mix(vec3(0.13, 0.19, 0.045), vec3(0.22, 0.28, 0.06), smoothstep(0.3, 0.7, m1 * 0.6 + m3 * 0.4));
  return mix(c, lush, pa * 0.85);
}

// Mid/small-scale heath mosaic (3–40 m) over the macro tint: dark dwarf-shrub patches
// (crowberry, dwarf birch), fresh sedge, dead straw, grey woolly moss. Shared by the terrain
// and the grass tufts so both agree. fw = ground footprint of a pixel (m): features smaller
// than it fade to their mean instead of aliasing.
vec3 heathMosaic(vec2 xz, vec3 c, float fw) {
  float k2 = 1.0 - smoothstep(1.2, 3.5, fw), k3 = 1.0 - smoothstep(0.4, 1.3, fw);
  float p1 = tgn(xz * 0.043 + 1.7);
  float p2 = mix(0.5, tgn(xz * 0.117 + 5.3), k2);
  float p3 = mix(0.5, tgn(GROT2 * xz * 0.31 + 2.1), k3);
  float a = p1 * 0.62 + p2 * 0.38;
  float b = p2 * 0.45 + p3 * 0.55;
  c = mix(c, c * vec3(0.5, 0.6, 0.48), smoothstep(0.6, 0.74, a) * 0.85);                   // dark shrub heath
  c = mix(c, c * vec3(1.08, 1.2, 0.8), smoothstep(0.64, 0.8, 1.0 - a) * 0.6);              // fresh sedge
  c = mix(c, vec3(0.25, 0.215, 0.115), smoothstep(0.64, 0.8, b) * 0.5);                     // dead straw
  c = mix(c, vec3(0.13, 0.14, 0.1), smoothstep(0.7, 0.85, p2 * 0.4 + p3 * 0.6) * 0.3);   // grey moss
  return c;
}

// Lupine field density 0..1 (shared by terrain tint and the flower instances).
float lupineAtRaw(vec2 xz, float h, float ny, float roadD) {
  float n = tgfbm(xz * 0.011 + vec2(3.7, 1.3));
  float n2 = tgn(xz * 0.065 + 5.1);
  float nearRoad = 1.0 - smoothstep(25.0, 200.0, roadD);
  float midV = smoothstep(-950.0, -650.0, xz.y) * (1.0 - smoothstep(450.0, 750.0, xz.y)) * (1.0 - smoothstep(20.0, 260.0, roadD));
  float vil = 1.0 - smoothstep(130.0, 330.0, length((xz - vec2(-40.0, 870.0)) * vec2(1.0, 1.3)));
  float v = n + 0.2 * nearRoad + 0.08 * midV + 0.24 * vil + (n2 - 0.5) * 0.24;
  float d = smoothstep(0.58, 0.67, v);
  d *= smoothstep(0.82, 0.92, ny);
  d *= 1.0 - smoothstep(190.0, 290.0, h);
  d *= mix(0.1, 1.0, smoothstep(-1450.0, -1150.0, xz.y));
  d *= smoothstep(1.8, 4.5, h);
  d *= smoothstep(7.0, 9.5, roadD);
  d *= smoothstep(14.0, 22.0, riverDist(xz));
  // a purple fringe around the pasture, none on the grazed field itself
  float pa = pastureAtRaw(xz);
  d = max(d * (1.0 - pa), smoothstep(0.1, 0.35, pa) * (1.0 - smoothstep(0.45, 0.75, pa)) * smoothstep(0.45, 0.6, n) * smoothstep(7.0, 9.5, roadD));
  d *= featureClearRaw(xz);
  return d;
}

// ---- baked masks (GPU, once at load): noise-heavy fields read back as cheap texture fetches
uniform sampler2D tMaskA;   // r lupine density, g featureClear, ba 60 m height gradient
uniform sampler2D tMaskB;   // rgb heath tint, a macro noise n1
uniform sampler2D tMaskC;   // r macro noise n2, g pasture
float featureClear(vec2 xz) { return outDist(xz) > 0.0 ? 1.0 : texture(tMaskA, innerUV(xz)).g; }
float lupineAt(vec2 xz, float h, float ny, float roadD) { return outDist(xz) > 0.0 ? 0.0 : texture(tMaskA, innerUV(xz)).r; }
vec3 terrGrassTint(vec2 xz, float slope0) { return outDist(xz) > 0.0 ? terrGrassTintRaw(xz, slope0) : texture(tMaskB, innerUV(xz)).rgb; }
float pastureAt(vec2 xz) { return outDist(xz) > 0.0 ? 0.0 : texture(tMaskC, innerUV(xz)).g; }
float terrN2(vec2 xz) { return outDist(xz) > 0.0 ? tgfbm(xz * 0.029 + 7.1) : texture(tMaskC, innerUV(xz)).r; }
float terrN1(vec2 xz) { return outDist(xz) > 0.0 ? tgfbm(xz * 0.0062 + 1.3) : texture(tMaskB, innerUV(xz)).a; }
vec2 terrBigG(vec2 xz) {
  if (outDist(xz) <= 0.0) return texture(tMaskA, innerUV(xz)).ba;
  return vec2(baseH(xz + vec2(60.0, 0.0)) - baseH(xz - vec2(60.0, 0.0)), baseH(xz + vec2(0.0, 60.0)) - baseH(xz - vec2(0.0, 60.0)));
}
#endif
`;

/* ------------------------------------------- JS mirrors of the GLSL noise */
const fract = (x) => x - Math.floor(x);
export function tgh(x, y) {
  let a = fract(x * 0.1031), b = fract(y * 0.1031), c = a;
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  return fract((a + b) * c);
}
export function tgn(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = tgh(ix, iy), b = tgh(ix + 1, iy), c = tgh(ix, iy + 1), d = tgh(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
export function tgfbm(x, y) {
  let s = 0, a = 0.5;
  for (let i = 0; i < 4; i++) { s += a * tgn(x, y); x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; a *= 0.5; }
  return s / 0.9375;
}
const riverX = (z) => 120 * Math.sin(z * 0.0016 + 0.6) + 60 * Math.sin(z * 0.0041) + 40 * Math.sin(z * 0.006);
export function riverDistJS(x, z) { return z > -900 && z < 1000 ? Math.abs(x - riverX(z)) : 1e4; }
/** Mirror of lupineAt() (GLSL) — used to cull empty flora tiles on the CPU. */
export function lupineJS(x, z, h, ny, roadD) {
  const n = tgfbm(x * 0.011 + 3.7, z * 0.011 + 1.3);
  const n2 = tgn(x * 0.065 + 5.1, z * 0.065 + 5.1);
  const nearRoad = 1 - smoothstep(25, 200, roadD);
  const midV = smoothstep(-950, -650, z) * (1 - smoothstep(450, 750, z)) * (1 - smoothstep(20, 260, roadD));
  const vil = 1 - smoothstep(130, 330, Math.hypot(x + 40, (z - 870) * 1.3));
  const v = n + 0.2 * nearRoad + 0.08 * midV + 0.24 * vil + (n2 - 0.5) * 0.24;
  let d = smoothstep(0.58, 0.67, v);
  d *= smoothstep(0.82, 0.92, ny);
  d *= 1 - smoothstep(190, 290, h);
  d *= lerp(0.1, 1, smoothstep(-1450, -1150, z));
  d *= smoothstep(1.8, 4.5, h);
  d *= smoothstep(7, 9.5, roadD);
  d *= smoothstep(14, 22, riverDistJS(x, z));
  const pa = pastureJS(x, z);
  d = Math.max(d * (1 - pa), smoothstep(0.1, 0.35, pa) * (1 - smoothstep(0.45, 0.75, pa)) * smoothstep(0.45, 0.6, n) * smoothstep(7, 9.5, roadD));
  d *= featureClearJS(x, z);
  return d;
}

/* ------------------------------------------------------- far outer ring (JS) */
function makeFarProc(world) {
  const vx = world.valleyX;
  return function farProc(x, z) {
    // mountain massif height field
    const m = 520 + 280 * fbm2(x * 0.00042 + 3.1, z * 0.00042 - 1.7, 4, 71) + 110 * fbm2(x * 0.0013, z * 0.0013, 2, 72);
    // valley / fjord trough continues south, widening into open water
    const cx = vx(Math.min(z, 3000)) * (1 - smoothstep(2500, 6000, z));
    const halfFloor = lerp(430, 2600, smoothstep(2048, 8500, z));
    const wall = smoothstep(halfFloor, halfFloor + 1150, Math.abs(x - cx));
    const floor = z > 1100 ? -55 : 3;
    let h = floor + Math.pow(wall, 1.35) * m;
    // north: open highland (≈ plateau height), distant snowy range beyond ~4 km
    const plat = 1 - smoothstep(-2300, -1500, z);
    const hill = 245 + 55 * fbm2(x * 0.0011 + 9.2, z * 0.0011, 3, 73) + 70 * smoothstep(900, 2600, Math.abs(x));
    const range = smoothstep(3600, 6200, -z) * (m * 1.25 - 100);
    h = lerp(h, hill + Math.max(range, 0), plat);
    // mountains give way to the open sea far south
    h = lerp(h, -60, smoothstep(6800, 9800, z));
    return h;
  };
}

/* ------------------------------------------------------------------ river */
function buildRiver(world) {
  const st = 4, zs = [], bottom = [], rds = [];
  for (let z = -900; z <= 1100; z += st) {
    const rx = world.riverX(z);
    let b = 1e9;
    for (let o = -6; o <= 6; o += 2) b = Math.min(b, world.heightAt(rx + o, z));
    zs.push(z); bottom.push(b); rds.push(world.roadDistAt(rx, z));
  }
  let iS = 0;
  for (let i = 0; i < zs.length; i++) if (rds[i] < 24 && zs[i] < 0) iS = i + 1;
  iS = Math.min(zs.length - 1, iS + 3);
  let iE = zs.length - 1;
  for (let i = iS; i < zs.length; i++) if (bottom[i] < -0.3) { iE = Math.min(zs.length - 1, i + 5); break; }
  const n = iE - iS + 1;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -8; k <= 8; k++) { const j = clamp(iS + i + k, 0, zs.length - 1); s += bottom[j]; c++; }
    sm[i] = s / c;
  }
  const level = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let w = sm[i] + 0.9;
    if (i > 0) w = Math.min(w, level[i - 1] - 0.004);
    level[i] = Math.max(w, 0.06);
  }
  const z0 = zs[iS], z1 = zs[iE];
  const levelAt = (z) => {
    const f = clamp((z - z0) / st, 0, n - 1.001), i = Math.floor(f), t = f - i;
    return lerp(level[i], level[i + 1], t);
  };
  // half-width of the carved channel (narrow at the source, broad lower down)
  const widthAt = (z) => lerp(0.35, 1, smoothstep(z0, z0 + 160, z)) * lerp(1, 1.35, smoothstep(0, 850, z));
  return { z0, z1, step: st, level, levelAt, widthAt, bottomAt: (z) => bottom[clamp(Math.round((z + 900) / st), 0, zs.length - 1)] };
}

/* ---------------------------------------------------------- cliff edges */
// A 4 m heightfield cannot hold a vertical wall: where the drop between neighbours exceeds
// ~2.2 m per metre the bilinear surface zig-zags along the grid (saw teeth at the cliff
// foot and lip). Relax those cells toward their neighbourhood mean so the face spans 2–3
// cells: still a steep basalt wall (~65–70°), but with clean edges.
function softenCliffs(H, N) {
  const lim = 2.2 * T_RES;
  for (let pass = 0; pass < 3; pass++) {
    const src = new Float32Array(H);
    for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
      const k = j * N + i, h = src[k];
      const m = Math.max(Math.abs(src[k + 1] - h), Math.abs(src[k - 1] - h), Math.abs(src[k + N] - h), Math.abs(src[k - N] - h));
      if (m < lim) continue;
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += src[k + dj * N + di];
      H[k] = lerp(h, sum / 9, 0.6);
    }
  }
}

/* --------------------------------------------------- hairpin plunge pool */
// The designed pool sits on a slope; give it a real basin with a rock lip on the downhill
// side so the water surface is contained instead of floating over the hillside.
function carvePlungePool(H, N) {
  const P = FEATURES.hairpinFall.pool, R = 6, level = 98.6;
  const i0 = Math.floor((P.x - 20 + T_HALF) / T_RES), i1 = Math.ceil((P.x + 20 + T_HALF) / T_RES);
  const j0 = Math.floor((P.z - 20 + T_HALF) / T_RES), j1 = Math.ceil((P.z + 20 + T_HALF) / T_RES);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = -T_HALF + i * T_RES, z = -T_HALF + j * T_RES, d = Math.hypot(x - P.x, z - P.z), k = j * N + i;
    // basin, then a talus-angle bank (no vertical cut) where the slope rises above the pool
    if (d < R) H[k] = Math.min(H[k], level - 1.5 * (1 - (d / R) ** 2) - 0.2);
    else H[k] = Math.min(H[k], level + 0.2 + (d - R) * 0.9);
    // low rock lip on the downhill side
    if (d >= R - 0.5 && d < R + 5) {
      const berm = level + 0.3 - Math.max(0, d - R - 1) * 0.6;
      H[k] = lerp(Math.max(H[k], berm), H[k], smoothstep(R + 1.5, R + 4.5, d));
    }
  }
  return { x: P.x, z: P.z, r: R, level };
}

/* ------------------------------------------------------------- glacier */
// The designed ice valley has knife-edged margins; blur the margin band (±20 m) so the
// tongue lies convex in its valley with soft lateral moraine slopes and a rounded snout.
function softenGlacier(H, N) {
  const G = FEATURES.glacier, pad = G.wTop * 2;
  const i0 = Math.max(0, Math.floor((Math.min(G.ax, G.bx) - pad + T_HALF) / T_RES)), i1 = Math.min(N - 1, Math.ceil((Math.max(G.ax, G.bx) + pad + T_HALF) / T_RES));
  const j0 = Math.max(0, Math.floor((Math.min(G.az, G.bz) - pad + T_HALF) / T_RES)), j1 = Math.min(N - 1, Math.ceil((Math.max(G.az, G.bz) + pad + T_HALF) / T_RES));
  const W = i1 - i0 + 1, Hh = j1 - j0 + 1, R = 5;
  let a = new Float32Array(W * Hh), b = new Float32Array(W * Hh);
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) a[j * W + i] = H[(j0 + j) * N + i0 + i];
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { let s = 0, c = 0; for (let k = -R; k <= R; k++) { const ii = i + k; if (ii >= 0 && ii < W) { s += a[j * W + ii]; c++; } } b[j * W + i] = s / c; }
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { let s = 0, c = 0; for (let k = -R; k <= R; k++) { const jj = j + k; if (jj >= 0 && jj < Hh) { s += b[jj * W + i]; c++; } } a[j * W + i] = s / c; }
  }
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
    const x = -T_HALF + (i0 + i) * T_RES, z = -T_HALF + (j0 + j) * T_RES;
    const gi = glacierInfoJS(x, z), q = gi.d / gi.w;
    const wgt = smoothstep(0.35, 0.75, q) * (1 - smoothstep(1.4, 2.0, q));
    if (wgt <= 0) continue;
    const k = (j0 + j) * N + i0 + i;
    H[k] = lerp(H[k], a[j * W + i], wgt);
  }
}

/* ---------------------------------------------------------------- gorge */
function buildGorge(world, H, N) {
  const G = FEATURES.gorge;
  const len = Math.hypot(G.bx - G.ax, G.bz - G.az), n = Math.ceil(len / 4);
  const hAt = (x, z) => {
    const fx = clamp((x + T_HALF) / T_RES, 0, N - 1.001), fz = clamp((z + T_HALF) / T_RES, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
    return lerp(lerp(H[k], H[k + 1], tx), lerp(H[k + N], H[k + N + 1], tx), tz);
  };
  const lvl = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = G.ax + (G.bx - G.ax) * t, z = G.az + (G.bz - G.az) * t;
    let b = hAt(x, z) + 0.45;
    if (i > 0) b = Math.min(b, lvl[i - 1] - 0.03);
    lvl[i] = b;
  }
  const levelAt = (t) => { const fI = clamp(t * n, 0, n - 0.001), i = Math.floor(fI); return lerp(lvl[i], lvl[i + 1], fI - i); };
  // Reshape into a box canyon: flat floor, near-vertical walls at wallAt(t) (the basalt
  // colonnade stands in front of them), level rim beyond.
  const wallAt = (t) => lerp(8.5, 6.5, t);
  const H0 = new Float32Array(H);
  const h0At = (x, z) => {
    const fx = clamp((x + T_HALF) / T_RES, 0, N - 1.001), fz = clamp((z + T_HALF) / T_RES, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
    return lerp(lerp(H0[k], H0[k + 1], tx), lerp(H0[k + N], H0[k + N + 1], tx), tz);
  };
  const ux = (G.bx - G.ax) / len, uz = (G.bz - G.az) / len;
  for (let j = 0; j < N; j++) {
    const z = -T_HALF + j * T_RES;
    if (z < Math.min(G.az, G.bz) - 40 || z > Math.max(G.az, G.bz) + 40) continue;
    for (let i = 0; i < N; i++) {
      const x = -T_HALF + i * T_RES;
      const gi = gorgeInfoJS(x, z);
      if (gi.d > gi.w * 1.3) continue;
      // outward direction: radial around the head, perpendicular along the canyon
      const ox = x - (G.ax + ux * gi.t * len), oz = z - (G.az + uz * gi.t * len), ol = Math.hypot(ox, oz) || 1;
      const rim = h0At(x + (ox / ol) * (gi.w + 3 - gi.d), z + (oz / ol) * (gi.w + 3 - gi.d));
      const wall = wallAt(gi.t);
      const floor = levelAt(gi.t) - 0.55 + 0.6 * smoothstep(wall - 3.5, wall, gi.d);
      let nh;
      if (gi.d < wall) nh = floor;
      else if (gi.d <= gi.w) nh = Math.max(rim, floor);
      else nh = lerp(Math.max(rim, floor), H0[j * N + i], smoothstep(gi.w, gi.w * 1.3, gi.d));
      H[j * N + i] = nh;
    }
  }
  return { levelAt, wallAt, n, ux, uz, len };
}

/* ------------------------------------------------------------------ bake */
const BAKE_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_FRAG = /* glsl */ `
${GLSL}
uniform vec3 uSun;
uniform float uHalf, uRes, uStep0, uMode; // mode 0 = sun visibility, 1 = sky AO, 2/3 = masks
void main() {
  vec2 p = -uHalf + floor(gl_FragCoord.xy) * uRes;
  float h0 = baseH(p);
  if (uMode > 1.5) {
    vec4 nr = texture(tNrm, innerUV(p));
    if (uMode < 2.5) {
      vec2 bg = vec2(baseH(p + vec2(60.0, 0.0)) - baseH(p - vec2(60.0, 0.0)), baseH(p + vec2(0.0, 60.0)) - baseH(p - vec2(0.0, 60.0)));
      gl_FragColor = vec4(lupineAtRaw(p, h0, nr.y, nr.w), featureClearRaw(p), bg);
    } else if (uMode < 3.5) {
      gl_FragColor = vec4(terrGrassTintRaw(p, 1.0 - nr.y), tgfbm(p * 0.0062 + 1.3));
    } else {
      gl_FragColor = vec4(tgfbm(p * 0.029 + 7.1), pastureAtRaw(p), 0.0, 1.0);
    }
    return;
  }
  if (uMode < 0.5) {
    vec2 d = normalize(uSun.xz + vec2(1e-5));
    float sinE = uSun.y;
    float tanS = uSun.y / max(length(uSun.xz), 1e-4);
    float maxT = -10.0, t = uStep0;
    h0 += 0.6;
    for (int i = 0; i < 60; i++) {
      float dh = baseH(p + d * t) - h0;
      maxT = max(maxT, dh / t);
      t *= 1.13;
      if (t > 7000.0) break;
    }
    // soft penumbra in angle space
    float a = atan(maxT) - asin(clamp(sinE, -1.0, 1.0));
    float vis = 1.0 - smoothstep(-0.035, 0.02, a);
    gl_FragColor = vec4(vis, vis, vis, 1.0);
  } else {
    float acc = 0.0;
    h0 += 0.3;
    for (int k = 0; k < 12; k++) {
      float ang = (float(k) + 0.37) * 0.5235988;
      vec2 d = vec2(cos(ang), sin(ang));
      float maxT = 0.0, t = uStep0;
      for (int i = 0; i < 14; i++) {
        maxT = max(maxT, (baseH(p + d * t) - h0) / t);
        t *= 1.55;
      }
      float s = maxT / sqrt(1.0 + maxT * maxT);   // sin(horizon elevation)
      acc += 1.0 - s;
    }
    float ao = acc / 12.0;
    gl_FragColor = vec4(ao, ao, ao, 1.0);
  }
}`;

/* --------------------------------------------------------------- builder */
const cache = new WeakMap();

export function getTerrainData(ctx) {
  const world = ctx.world;
  if (cache.has(world)) return cache.get(world);
  const t0 = performance.now();
  const N = world.gridSize;
  if (N !== T_N || world.gridRes !== T_RES || world.WORLD_HALF !== T_HALF) console.warn('[fjord terrain] unexpected grid', N, world.gridRes);

  /* heights (+ river carve) */
  const H = new Float32Array(world.heightGrid);
  const river = buildRiver(world);
  for (let j = 0; j < N; j++) {
    const z = -T_HALF + j * T_RES;
    if (z < river.z0 - 20 || z > river.z1) continue;
    const rx = world.riverX(z), W = river.levelAt(z), wk = river.widthAt(z);
    const kz = smoothstep(river.z0 - 16, river.z0 + 40, z);
    const i0 = Math.max(0, Math.floor((rx - 24 + T_HALF) / T_RES)), i1 = Math.min(N - 1, Math.ceil((rx + 24 + T_HALF) / T_RES));
    for (let i = i0; i <= i1; i++) {
      const x = -T_HALF + i * T_RES;
      const rd = Math.abs(x - rx) / wk;
      if (rd > 17) continue;
      if (world.roadDistAt(x, z) < 12) continue;
      const bed = W - 1.15 + 1.55 * smoothstep(4.5, 11, rd);
      const k = (1 - smoothstep(11, 17, rd)) * kz;
      const idx = j * N + i;
      H[idx] = lerp(H[idx], Math.min(H[idx], bed), k);
    }
  }
  /* canyon floor: make the stream bed run monotonically from the head-fall pool to the mouth */
  const gorge = buildGorge(world, H, N);
  softenGlacier(H, N);
  const hairpinPool = carvePlungePool(H, N);
  softenCliffs(H, N);
  const sampleH = (x, z) => {
    const fx = clamp((x + T_HALF) / T_RES, 0, N - 1.001), fz = clamp((z + T_HALF) / T_RES, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
    return lerp(lerp(H[k], H[k + 1], tx), lerp(H[k + N], H[k + N + 1], tx), tz);
  };

  /* normals + road distance */
  const NR = new Float32Array(N * N * 4);
  const hAt = (i, j) => H[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  for (let j = 0; j < N; j++) {
    const z = -T_HALF + j * T_RES;
    for (let i = 0; i < N; i++) {
      const nx = hAt(i - 1, j) - hAt(i + 1, j), nz = hAt(i, j - 1) - hAt(i, j + 1), ny = 2 * T_RES;
      const l = Math.hypot(nx, ny, nz), o = (j * N + i) * 4;
      NR[o] = nx / l; NR[o + 1] = ny / l; NR[o + 2] = nz / l;
      NR[o + 3] = world.roadDistAt(-T_HALF + i * T_RES, z);
    }
  }

  /* far ring macro heights */
  const farProc = makeFarProc(world);
  const FH = new Float32Array(F_N * F_N);
  for (let j = 0; j < F_N; j++) {
    const z = -F_HALF + j * F_RES;
    for (let i = 0; i < F_N; i++) FH[j * F_N + i] = farProc(-F_HALF + i * F_RES, z);
  }

  const dataTex = (data, n, format, filter) => {
    const t = new THREE.DataTexture(data, n, n, format, THREE.FloatType);
    t.minFilter = t.magFilter = filter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const hTex = dataTex(H, N, THREE.RedFormat, THREE.NearestFilter);
  const nTex = dataTex(NR, N, THREE.RGBAFormat, THREE.LinearFilter);
  const fTex = dataTex(FH, F_N, THREE.RedFormat, THREE.NearestFilter);

  const rtOpts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
  const sunIn = new THREE.WebGLRenderTarget(N, N, rtOpts), sunFar = new THREE.WebGLRenderTarget(F_N, F_N, rtOpts);
  const aoIn = new THREE.WebGLRenderTarget(N, N, rtOpts), aoFar = new THREE.WebGLRenderTarget(F_N, F_N, rtOpts);
  const maskOpts = { ...rtOpts, type: THREE.HalfFloatType };
  const maskA = new THREE.WebGLRenderTarget(N, N, maskOpts), maskB = new THREE.WebGLRenderTarget(N, N, maskOpts), maskC = new THREE.WebGLRenderTarget(N, N, rtOpts);
  const featTex = new THREE.DataTexture(buildFeatureTexture(N, T_HALF, T_RES), N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  featTex.minFilter = featTex.magFilter = THREE.LinearFilter; featTex.generateMipmaps = false; featTex.needsUpdate = true;

  const uniforms = {
    tHgt: { value: hTex }, tNrm: { value: nTex }, tFarH: { value: fTex },
    tSunIn: { value: sunIn.texture }, tSunFar: { value: sunFar.texture },
    tAOIn: { value: aoIn.texture }, tAOFar: { value: aoFar.texture },
    tMaskA: { value: maskA.texture }, tMaskB: { value: maskB.texture }, tMaskC: { value: maskC.texture }, tFeat: { value: featTex },
    uLodCam: { value: new THREE.Vector3(world.spawn.x, 200, world.spawn.z) },
  };

  /* GPU bake */
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, depthTest: false, depthWrite: false,
    uniforms: { ...uniforms, tSunIn: { value: null }, tSunFar: { value: null }, tAOIn: { value: null }, tAOFar: { value: null }, tMaskA: { value: null }, tMaskB: { value: null }, tMaskC: { value: null }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uHalf: { value: 0 }, uRes: { value: 0 }, uStep0: { value: 0 }, uMode: { value: 0 } },
  });
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(quadGeo, bakeMat);
  quad.frustumCulled = false;
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function bakeInto(renderer, rt, mode, half, res, step0) {
    const u = bakeMat.uniforms;
    u.uMode.value = mode; u.uHalf.value = half; u.uRes.value = res; u.uStep0.value = step0;
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
  }

  const bakedSun = new THREE.Vector3(0, -2, 0);
  let aoDone = false, sinceBake = 1e9;
  const sunDir = ctx.uniforms.uSunDir.value;
  function bakeSun(renderer) {
    bakeMat.uniforms.uSun.value.copy(sunDir).normalize();
    bakeInto(renderer, sunIn, 0, T_HALF, T_RES, 3);
    bakeInto(renderer, sunFar, 0, F_HALF, F_RES, 60);
    bakedSun.copy(sunDir);
    sinceBake = 0;
  }

  const td = {
    GLSL,
    uniforms,
    hTex, nTex, fTex,
    heights: H,
    heightAt: sampleH,
    normalAt(x, z, out = new THREE.Vector3()) {
      const e = T_RES;
      return out.set(sampleH(x - e, z) - sampleH(x + e, z), 2 * e, sampleH(x, z - e) - sampleH(x, z + e)).normalize();
    },
    farProc,
    river,
    gorge,
    hairpinPool,
    /** Call once per frame (before rendering). Cheap unless the sun moved. */
    update(renderer, dt = 0.016) {
      sinceBake += dt;
      if (!aoDone) {
        bakeInto(renderer, aoIn, 1, T_HALF, T_RES, 4);
        bakeInto(renderer, aoFar, 1, F_HALF, F_RES, 96);
        bakeInto(renderer, maskA, 2, T_HALF, T_RES, 0);
        bakeInto(renderer, maskB, 3, T_HALF, T_RES, 0);
        bakeInto(renderer, maskC, 4, T_HALF, T_RES, 0);
        aoDone = true;
      }
      const moved = bakedSun.angleTo(sunDir);
      if (moved > 0.02 || (moved > 0.0005 && sinceBake > 0.2)) bakeSun(renderer);
    },
    dispose() {
      [hTex, nTex, fTex].forEach((t) => t.dispose());
      [sunIn, sunFar, aoIn, aoFar, maskA, maskB, maskC].forEach((r) => r.dispose()); featTex.dispose();
      bakeMat.dispose(); quadGeo.dispose();
      cache.delete(world);
    },
  };
  cache.set(world, td);
  console.info(`[fjord terrain] data ${Math.round(performance.now() - t0)} ms (river z ${river.z0}…${river.z1})`);
  return td;
}

/* ------------------------------------------------------ baked light patch */
// Direct sun × baked terrain visibility, indirect × baked sky AO. For meshes that sit
// on the terrain (flora, rocks, buildings) so distant mountain shadows fall on them too.
export function bakedLightChunks(wpExpr) {
  const begin = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= terrSunVis( ${wpExpr}.xz );`,
  );
  const ao = `#include <aomap_fragment>
  { float bAO = terrAO( ${wpExpr}.xz ); bAO = bAO * bAO;
    reflectedLight.indirectDiffuse *= bAO; reflectedLight.indirectSpecular *= mix(bAO, 1.0, 0.3); }`;
  return { begin, ao };
}

export function addBakedLight(mat, td, { aoStrength = 1 } = {}) {
  const { begin, ao } = bakedLightChunks('vBakeWP');
  addShaderPatch(mat, 'fjordBake', (shader) => {
    Object.assign(shader.uniforms, td.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBakeWP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 bw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bw = instanceMatrix * bw;
        #endif
        vBakeWP = (modelMatrix * bw).xyz; }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBakeWP;\n' + GLSL)
      .replace('#include <lights_fragment_begin>', begin)
      .replace('#include <aomap_fragment>', aoStrength === 1 ? ao : ao.replace('bAO = bAO * bAO;', `bAO = mix(1.0, bAO * bAO, ${aoStrength.toFixed(2)});`));
  });
  return mat;
}
