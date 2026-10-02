// Fjord terrain: CDLOD quadtree over the whole world + a procedural outer ring
// (±12 km, so the 9 km view never reaches an edge). One instanced grid patch
// (32×32 cells), displaced in the vertex shader from the shared height textures
// (env/terrainData.js). Leaf nodes are 32 m → 1 m vertex spacing around the camera,
// doubling per level; vertices geomorph toward the parent grid so there are no cracks.
//
// Shading: MeshStandardMaterial + addShaderPatch. Procedural splat resolved per pixel
// (tundra grass, moss, basalt, scree, black sand, snow, road-shoulder gravel, lupine
// tint), detail textures near, macro colour far. Sun × baked terrain self-shadow,
// ambient × baked sky AO — distant mountains keep their relief beyond the ±70 m
// real-time shadow map.

import * as THREE from 'three';
import { addShaderPatch } from '../../render/shaderPatch.js';
import { getTerrainData, bakedLightChunks, T_HALF, T_RES, T_N } from './env/terrainData.js';
import { getFjordGroundTextures, groundUniforms, setGroundTextures } from './env/groundTex.js';
import { loadPhotoAssets, awaitPhotoAssets } from './env/photoAssets.js';
import { createGorgeColumns } from './env/columns.js';

const G = 32;                 // cells per patch side
const LEAF = 32;              // leaf node size (m) → 1 m spacing
const MAX_LOD = 7;            // root = 4096 m
const ROOT = LEAF * 2 ** MAX_LOD;
const EXTENT = 12288;         // roots cover [-EXTENT, EXTENT]²
const RANGE_K = 5;            // lod range = RANGE_K × node size (see morph constraint)
const FAR_CULL = 9400;
const NEAR_SHADOW = 80;      // nodes closer than this cast real-time shadows
const MAX_NODES = 3000;

/* -------------------------------------------------------------- GLSL */
const PLACE_GLSL = /* glsl */ `
attribute vec4 aNode;             // x0, z0, size, lod
uniform float uRange0;
uniform float uMaxLod;
varying vec3 vTW;
varying vec3 vTDet;
void terrPlace(vec3 gp, out vec3 wp, out vec3 wn, out vec3 det) {
  vec2 g = gp.xz;
  float lod = aNode.w;
  vec2 wxz = aNode.xy + g * aNode.z;
  float r = uRange0 * exp2(lod);
  float d = distance(uLodCam.xz, wxz);
  float k = lod >= uMaxLod ? 0.0 : clamp((d - 0.8 * r) / (0.2 * r), 0.0, 1.0);
  g -= fract(g * ${(G * 0.5).toFixed(1)}) * ${(2 / G).toFixed(6)} * k;
  wxz = aNode.xy + g * aNode.z;
  float camD = distance(uLodCam.xz, wxz);
  vec4 s = terrSurface(wxz, camD, det);
  float h = s.w;
  // push the sea bed down a little so the waterline is crisp (no z-fight at km range)
  if (h < 0.0) h = h * 1.2 - 1.0 * smoothstep(0.0, 1.0, -h);
  wp = vec3(wxz.x, h, wxz.y);
  wn = s.xyz;
}
`;

// Layer sampling helpers (fragment).
const LAYER_GLSL = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uGAlb;
uniform sampler2DArray uGNrm;
uniform float uTime;
uniform float uRain;
uniform float uDetailFar, uWallFar;
const mat2 GROT = mat2(0.8, -0.6, 0.6, 0.8);
// value noise on the two vertical planes, blended by the facing: no vertical stretching on
// walls (plain xz noise smears into streaks down a cliff)
float wallN(vec3 p, vec3 N, float f, float o) {
  vec2 w = N.xz * N.xz; w /= (w.x + w.y + 1e-4);
  return tgn(vec2(p.z * f + o, p.y * f)) * w.x + tgn(vec2(p.x * f + o, p.y * f) + 3.1) * w.y;
}
// valley floor elevation (mirror of layout.floorY) → height above the floor on the walls
float floorYg(float z) {
  if (z < -880.0) return mix(205.0, 92.0, smoothstep(-1330.0, -880.0, z));
  float run = mix(92.0, 2.0, smoothstep(-880.0, 820.0, z));
  return z < 820.0 ? run : min(run, 2.0) + mix(0.0, -45.0, smoothstep(820.0, 1250.0, z));
}

// Ground arrays: albedo rgb + height (a), normal rg = -grad(height) in uv, b = roughness.
// uGLay[L] = (tile m, large-scale factor, bump gain, -), uGMean[L] = (linear mean rgb, mean rough).
uniform vec4 uGLay[8];
uniform vec4 uGMean[8];
uniform float uPhoto;
vec2 gHash2(float i) { return fract(sin(vec2(i * 12.9898 + 1.3, i * 78.233 + 4.1)) * 43758.5453); }
// One tile lookup with a random offset and quarter-turn picked by index i (bump rotated back).
void gTap(float L, vec2 uv, vec2 gx, vec2 gy, float i, bool wantN, out vec4 a, out vec2 b, out float r) {
  vec2 h = gHash2(i);
  float q = floor(h.x * 4.0);
  vec2 cs = q < 1.0 ? vec2(1.0, 0.0) : q < 2.0 ? vec2(0.0, 1.0) : q < 3.0 ? vec2(-1.0, 0.0) : vec2(0.0, -1.0);
  mat2 R = mat2(cs.x, cs.y, -cs.y, cs.x);
  vec2 u = R * uv + h * 7.31;
  a = textureGrad(uGAlb, vec3(u, L), R * gx, R * gy);
  b = vec2(0.0); r = uGMean[int(L)].w;
  if (wantN) {
    vec4 n = textureGrad(uGNrm, vec3(u, L), R * gx, R * gy);
    b = (n.xy * 2.0 - 1.0) * R;         // = transpose(R) * b : back to world-aligned uv
    r = n.z;
  }
}
// Planar sample with anti-tiling: (1) the base tile is looked up twice with per-region random
// offset + rotation and blended by a low-frequency index (Quilez' technique), (2) a second,
// several-times larger rotated tile adds variation and takes over with distance.
// Output: detail factor (albedo / layer mean), world-xz bump, height, roughness.
void gLayer(float L, vec2 p, float dist, out vec3 det, out vec3 bump, out float hgt, out float rough) {
  vec4 P = uGLay[int(L)];
  float s = P.x;
  vec2 uv = p / s, gx = dFdx(uv), gy = dFdy(uv);
  bool wantN = dist < 55.0;            // bump fades out by ~60 m anyway
  float k = tgn(p * (0.35 / s) + L * 7.7) * 6.0;
  float i0 = floor(k), f = fract(k);
  vec4 A; vec2 B; float Rg;
  // only the transition band between two regions needs both taps (~half the area)
  if (f < 0.26 || f > 0.74) {
    gTap(L, uv, gx, gy, i0 + step(0.5, f) + L * 13.0, wantN, A, B, Rg);
  } else {
    vec4 a1, a2; vec2 b1, b2; float r1, r2;
    gTap(L, uv, gx, gy, i0 + L * 13.0, wantN, a1, b1, r1);
    gTap(L, uv, gx, gy, i0 + 1.0 + L * 13.0, wantN, a2, b2, r2);
    float wb = smoothstep(0.35, 0.65, f + 0.06 * dot(a1.rgb - a2.rgb, vec3(1.0)));
    A = mix(a1, a2, wb); B = mix(b1, b2, wb); Rg = mix(r1, r2, wb);
  }
  // large-scale tile
  vec2 uvB = (GROT * p) / (s * P.y) + 0.37;
  vec4 aB = texture(uGAlb, vec3(uvB, L));
  float wBig = mix(0.3, 0.65, smoothstep(15.0, 160.0, dist));
  if (dist < 25.0) {
    vec4 nB = texture(uGNrm, vec3(uvB, L));
    vec2 bB = nB.xy * 2.0 - 1.0;
    bB = vec2(dot(bB, vec2(0.8, -0.6)), dot(bB, vec2(0.6, 0.8)));
    B = B * (1.0 - wBig * 0.5) + bB * 0.5 * (1.0 / P.y + wBig * 0.5);
    Rg = mix(Rg, nB.z, 0.3);
  }
  vec3 alb = mix(A.rgb, aB.rgb, wBig);
  det = alb / max(uGMean[int(L)].rgb, vec3(0.004));
  vec2 bw = B * P.z * (1.0 - smoothstep(35.0, 55.0, dist));
  bump = vec3(bw.x, 0.0, bw.y);
  hgt = mix(A.a, aB.a, wBig * 0.6);
  rough = max(Rg, P.w);
}
// Wall noise along a fixed downhill direction (angle a): x = gully ridges, y = outcrop lenses,
// z = scree-chute mask, w = d(gully)/d(contour) for groove relief.
float gullyF(float c, float f, float n1) {
  return pow(1.0 - abs(tgn(vec2(c * 0.075, f * 0.004 + n1 * 0.5)) * 2.0 - 1.0), 6.0) * 0.7
       + pow(1.0 - abs(tgn(vec2(c * 0.21 + 5.0, f * 0.012)) * 2.0 - 1.0), 6.0) * 0.5;
}
vec4 wallNoise(vec2 xz, float a, float n1) {
  vec2 d = vec2(cos(a), sin(a)), cd = vec2(-d.y, d.x);
  float c = dot(xz, cd), f = dot(xz, d);
  float g = gullyF(c, f, n1);
  float dg = (gullyF(c + 1.3, f, n1) - gullyF(c - 1.3, f, n1)) / 2.6;
  float o = tgn(vec2(c * 0.016 + 3.3, f * 0.05)) * 0.69 + tgn(vec2(c * 0.05, f * 0.12) + 9.1) * 0.31;
  float fn = tgn(vec2(c * 0.045 + 7.0, f * 0.004));
  return vec4(g, o, fn, dg);
}
// Triplanar basalt (cliffs).
void gRock(vec3 p, vec3 N, out vec3 det, out vec3 bump, out float hgt, out float rough) {
  vec3 w = pow(abs(N), vec3(4.0)); w /= (w.x + w.y + w.z);
  const float L = 2.0;
  vec4 P = uGLay[2];
  float s = P.x, s2 = s * P.y;
  vec4 aX = texture(uGAlb, vec3(p.zy / s, L)), aY = texture(uGAlb, vec3(p.xz / s, L)), aZ = texture(uGAlb, vec3(p.xy / s, L));
  vec4 bX = texture(uGAlb, vec3(p.zy / s2 + 0.31, L)), bY = texture(uGAlb, vec3(p.xz / s2 + 0.57, L)), bZ = texture(uGAlb, vec3(p.xy / s2 + 0.13, L));
  aX = mix(aX, bX, 0.45); aY = mix(aY, bY, 0.45); aZ = mix(aZ, bZ, 0.45);
  vec4 nX = texture(uGNrm, vec3(p.zy / s, L)), nY = texture(uGNrm, vec3(p.xz / s, L)), nZ = texture(uGNrm, vec3(p.xy / s, L));
  det = (aX.rgb * w.x + aY.rgb * w.y + aZ.rgb * w.z) / max(uGMean[2].rgb, vec3(0.004));
  vec2 x = (nX.xy * 2.0 - 1.0) * P.z, y = (nY.xy * 2.0 - 1.0) * P.z, z = (nZ.xy * 2.0 - 1.0) * P.z;
  bump = w.x * vec3(0.0, x.y, x.x) + w.y * vec3(y.x, 0.0, y.y) + w.z * vec3(z.x, z.y, 0.0);
  hgt = aX.a * w.x + aY.a * w.y + aZ.a * w.z;
  rough = max(nX.z * w.x + nY.z * w.y + nZ.z * w.z, P.w);
}
`;

const ALBEDO_GLSL = /* glsl */ `
  vec3 tWP = vTW;
  float tDist = length(cameraPosition - tWP);
  vec3 tN0 = terrNormal(tWP.xz);
  vec3 tN = normalize(tN0 + vec3(-vTDet.y, 0.0, -vTDet.z) * tN0.y);
  float tH = tWP.y;
  float slope0 = 1.0 - tN0.y;
  float tRd = roadDist(tWP.xz);
  float tRv = riverDist(tWP.xz);
  float n1 = terrN1(tWP.xz);
  float n2 = terrN2(tWP.xz);
  float n3 = tgn(tWP.xz * 0.21 + 2.9);
  float n4 = tgn(tWP.xz * 1.3 + 0.7);
  float plat = 1.0 - smoothstep(-1500.0, -1250.0, tWP.z);
  float north = clamp(-tN0.z, 0.0, 1.0);

  // ---- steep-wall structure (world space, so nothing tiles)
  vec2 fallD = normalize(tN0.xz + vec2(1e-4));            // local horizontal downhill direction
  // large-scale fall direction (±60 m) — grooves follow it, not every small bump
  vec2 bigG = terrBigG(tWP.xz);
  vec2 bigD = length(bigG) > 1.0 ? normalize(-bigG) : fallD;
  vec2 contD = vec2(-bigD.y, bigD.x);
  // classify by the 60 m slope, not the local one: terrace risers/treads would otherwise
  // turn every mask into contour-parallel stripes
  float gBig = length(bigG) / 120.0;
  float slopeBig = 1.0 - inversesqrt(1.0 + gBig * gBig);
  float slopeM = mix(slope0, slopeBig, 0.75);
  float steepK = smoothstep(0.15, 0.27, slopeM);            // ~32° … 43°
  float hiAlt = smoothstep(330.0, 560.0, tH + (n1 - 0.5) * 220.0);
  // Anisotropic wall noise is evaluated for the two nearest of 16 fixed directions and
  // blended. Projecting world xz onto a *rotating* frame would smear into spirals on
  // conical peaks (the lever arm is the km-scale world coordinate).
  float ang = atan(bigD.y, bigD.x) * 2.5464791;             // 16 / 2π
  float a0 = floor(ang), af = ang - a0;
  vec4 WN = vec4(0.0, 0.5, 0.0, 0.0);
  if ((steepK > 0.0 || slope0 > 0.12) && tDist < uWallFar && !TLITE) {
    vec4 W0 = wallNoise(tWP.xz, a0 * 0.39269908, n1), W1 = wallNoise(tWP.xz, (a0 + 1.0) * 0.39269908, n1);
    WN = mix(W0, W1, af);
  }
  float gully = WN.x * (1.0 - smoothstep(350.0, 1400.0, tDist) * 0.75), outcrop = WN.y * 0.8 + n3 * 0.2, fanN = WN.z;
  {
    // (real gullies are in the height field now; this only adds the finer runnels)
    float depth = 1.1 * steepK * (1.0 - smoothstep(300.0, 1400.0, tDist)) * smoothstep(12.0, 30.0, tRd) * (1.0 - smoothstep(0.45, 0.6, slope0));
    tN = normalize(tN + vec3(contD.x, 0.0, contD.y) * WN.w * depth);
  }
  // real cliffs (local slope > ~55°) are always bare rock, whatever the 60 m average says
  // Rock where the ground is genuinely steep: continuous sheets on the steepest 60 m slopes,
  // bands along terrace risers (local slope well above the average), exposed crests (high
  // sky visibility). Multi-scale noise sizes the patches; gullies cut the bands vertically.
  float tAOv = terrAO(tWP.xz);
  float rockN = n1 * 0.5 + n2 * 0.35 + n3 * 0.15;
  float relH = tH - floorYg(tWP.z);                          // height above the valley floor
  // AO also measures concavity: gullies/hollows < ~0.8, spurs and crests > ~0.9
  float hollow = smoothstep(0.86, 0.72, tAOv);
  float groove = steepK * max(smoothstep(0.3, 0.75, gully) * (1.0 - smoothstep(900.0, 2500.0, tDist) * 0.7), hollow * 0.8) * smoothstep(12.0, 30.0, tRd);
  // Icelandic basalt walls: horizontal lava layers (planar — they cut across gullies and spurs,
  // never follow the contours), each capped by a thin dark ledge that breaks up along strike.
  float layY = (tH + 16.0 * (tgn(tWP.xz * 0.0019 + 4.1) - 0.5)) / 21.0;
  float layI = floor(layY), layF = layY - layI;
  float ledgeB = smoothstep(0.64, 0.72, layF) * (1.0 - smoothstep(0.84, 0.9, layF));
  ledgeB = mix(ledgeB, 0.14, smoothstep(0.06, 0.25, fwidth(layY)));                  // AA far away
  vec2 wW = tN0.xz * tN0.xz; wW /= (wW.x + wW.y + 1e-4);
  float strike = tgn(vec2(tWP.z * 0.03 + layI * 7.13, layI * 3.7)) * wW.x + tgn(vec2(tWP.x * 0.03 + layI * 5.31, layI * 2.9)) * wW.y;
  float ledgeOn = smoothstep(0.4, 0.62, strike * 0.7 + rockN * 0.3);
  float ledge = ledgeB * ledgeOn * steepK * smoothstep(50.0, 160.0, relH) * (1.0 - groove * 0.85);
  // continuous rock only on the truly steep faces; cliffs (local), bare crests
  float sheet = smoothstep(0.4, 0.52, slopeM + (rockN - 0.5) * 0.2) * smoothstep(80.0, 250.0, relH);
  float cliff = smoothstep(0.42, 0.6, slope0 + (n3 - 0.5) * 0.14 + (n4 - 0.5) * 0.06);
  float crest = smoothstep(0.9, 0.97, tAOv) * steepK * smoothstep(0.45, 0.65, rockN) * smoothstep(200.0, 400.0, relH);
  float wRock = clamp(max(max(sheet * (1.0 - groove * 0.5), cliff), max(ledge, crest * 0.8)), 0.0, 1.0);
  // vegetation retreats upward: green lower walls, patchy heath higher up, bare scree near the
  // crest. Vegetation follows the fall line (strips down spurs and along wet gullies).
  float vegN = n2 * 0.45 + n3 * 0.25 + outcrop * 0.3;
  float vegTop = 170.0 + (vegN - 0.5) * 330.0 + (fanN - 0.5) * 90.0 + groove * 70.0 - slopeM * 220.0 + plat * 120.0;
  float veg = 1.0 - smoothstep(-40.0, 70.0, relH - vegTop) * steepK;
  veg = max(veg, (1.0 - steepK) * (1.0 - hiAlt * 0.5));
  // talus cones: scree fanning out below cliffs (look uphill for steep ground)
  vec3 nUp1 = terrNormal(tWP.xz - fallD * 16.0), nUp2 = terrNormal(tWP.xz - fallD * 42.0);
  float cliffAbove = max(smoothstep(0.3, 0.42, 1.0 - nUp1.y), smoothstep(0.32, 0.44, 1.0 - nUp2.y) * 0.75) * smoothstep(0.5, 0.7, outcrop + 0.1);
  float fan = smoothstep(0.5, 0.75, fanN + gully * 0.3);
  float scr = cliffAbove * fan * smoothstep(0.05, 0.12, slope0) * 0.7;
  // talus apron right at the foot of every cliff (hides the stepped edge of the height grid)
  scr = max(scr, smoothstep(0.34, 0.5, 1.0 - nUp1.y) * (0.55 + 0.45 * fan) * (1.0 - smoothstep(0.45, 0.6, slope0)));
  scr = max(scr, (1.0 - veg));
  scr = max(scr, hiAlt * smoothstep(0.12, 0.24, slopeM + (n2 - 0.5) * 0.15) * 0.6);
  float wScree = clamp(scr, 0.0, 1.0) * (1.0 - wRock);
  float mossN = n2 * 0.55 + n1 * 0.45 + 0.06 * plat + 0.18 * hiAlt + (n3 - 0.5) * 0.12 + (n4 - 0.5) * 0.05 + 0.1 * steepK * smoothstep(80.0, 300.0, relH);
  float wMoss = smoothstep(0.5, 0.7, mossN) * (1.0 - wRock) * (1.0 - wScree);
  float wGrass = (1.0 - wRock) * (1.0 - wScree) * (1.0 - wMoss);
  float shore = 1.0 - smoothstep(0.9, 3.4, tH + (n2 - 0.5) * 2.2 + (n3 - 0.5) * 0.8);
  float bank = 1.0 - smoothstep(9.5, 13.0, tRv + (n3 - 0.5) * 3.0 + (n4 - 0.5) * 1.0);
  float wSand = max(shore, bank);
  wGrass *= 1.0 - wSand; wMoss *= 1.0 - wSand; wScree *= 1.0 - wSand; wRock *= 1.0 - wSand * 0.7;
  float wShoulder = (1.0 - smoothstep(5.0, 6.0, tRd + (n3 - 0.5) * 0.9 + (n4 - 0.5) * 0.3));
  // late-summer snow: only high, shaded gullies (low sky AO) and north faces
  // late-summer snow: shaded gullies (low sky AO) and north faces high up; patches stretched
  // down the fall line, edges broken so they never read as blobs
  float snowS = tH - 720.0 + north * 170.0 + (0.84 - tAOv) * 520.0 + groove * 130.0 + (n2 - 0.5) * 220.0 + (n3 - 0.5) * 40.0 + (fanN - 0.5) * 190.0 * steepK + (tN0.y - 0.7) * 60.0;
  snowS += (wallN(tWP, tN0, 0.09, 5.1) - 0.5) * 50.0 * (1.0 - smoothstep(600.0, 1500.0, tDist));
  float wSnow = smoothstep(-6.0, 26.0, snowS);
  float lup = lupineAt(tWP.xz, tH, tN0.y, tRd);

  // ---- macro colours (linear)
  vec3 cGrass = terrGrassTint(tWP.xz, slopeM) * (0.92 + 0.16 * n3);
  // heath mosaic (3–40 m), plus damp hollows close by
  cGrass = heathMosaic(tWP.xz, cGrass, tDist * 0.0012);
  cGrass *= 1.0 - 0.14 * smoothstep(0.6, 0.85, 1.0 - tgn(tWP.xz * 0.17 + 8.1)) * (1.0 - smoothstep(40.0, 160.0, tDist));
  cGrass = mix(cGrass, vec3(0.13, 0.125, 0.07), hiAlt * 0.55);
  cGrass *= 1.0 - 0.15 * steepK * gully;                   // damp, shaded gully bottoms
  vec3 cMoss = mix(vec3(0.11, 0.155, 0.05), vec3(0.125, 0.14, 0.09), clamp(0.45 + plat * 0.4 + hiAlt * 0.4 + (n3 - 0.5) * 0.4, 0.0, 1.0));
  // rock tone: facing-aware noise on steep faces, map noise on gentle rock
  float rv1 = mix(wallN(tWP, tN0, 0.045, 1.3), n2, tN0.y * tN0.y);
  float rv2 = mix(wallN(tWP, tN0, 0.19, 7.7), n3, tN0.y * tN0.y);
  vec3 cRock = vec3(0.036, 0.035, 0.034) * (0.7 + 0.6 * rv1) * (0.85 + 0.3 * rv2);
  // flow banding: alternating darker / lighter lava layers (planar, 2–6 m)
  cRock *= 0.82 + 0.3 * smoothstep(0.3, 0.7, tgn(vec2(tH * 0.33 + rv1 * 1.5, layI)));
  cRock = mix(cRock, vec3(0.075, 0.058, 0.045), smoothstep(0.64, 0.8, n1) * 0.45);   // rusty scoria
  cRock = mix(cRock, vec3(0.1, 0.11, 0.08), smoothstep(0.7, 0.85, n4 * 0.5 + n2 * 0.5) * 0.3 * (1.0 - groove)); // lichen
  cRock *= 1.0 - 0.18 * groove;                              // wet, darker gully floors
  {
    // joints and weathering on rock faces (world-space, works on vertical walls too)
    float j1 = 1.0 - abs(tgn(vec2(tWP.x * 0.3 + tH * 0.21, tWP.z * 0.3 - tH * 0.17)) * 2.0 - 1.0);
    float j2 = 1.0 - abs(tgn(vec2(tWP.x * 0.11 - tH * 0.3, tWP.z * 0.11 + tH * 0.05) + 4.0) * 2.0 - 1.0);
    float rk = 1.0 - smoothstep(60.0, 260.0, tDist);
    cRock *= 1.0 - (smoothstep(0.86, 0.97, j1) * 0.45 + smoothstep(0.9, 0.98, j2) * 0.35) * rk;
    cRock *= 0.85 + 0.35 * tgn(vec2(tWP.x * 0.9 + tH * 0.4, tWP.z * 0.9)) * rk + 0.15 * (1.0 - rk);
  }
  // scree: dark grey-brown basalt debris, reddish scoria in some layers, streaked down the fall line
  vec3 cScree = mix(vec3(0.075, 0.07, 0.064), vec3(0.125, 0.112, 0.094), n3 * 0.6 + fanN * 0.4);
  cScree = mix(cScree, vec3(0.13, 0.08, 0.055), step(0.86, fract(sin(layI * 12.9898) * 43758.5)) * steepK * 0.4);
  cScree *= 0.85 + 0.3 * fan;
  cScree = mix(cScree, cScree * vec3(0.8, 0.95, 0.7), groove * 0.4);     // damp, mossy gully floors
  vec3 cSand = vec3(0.028, 0.028, 0.031) * (0.9 + 0.2 * n3);
  vec3 cSnow = vec3(0.82, 0.85, 0.9);
  vec3 cShoulder = vec3(0.17, 0.155, 0.135) * (0.9 + 0.2 * n4);
  vec3 cLupLeaf = vec3(0.07, 0.105, 0.05);
  vec3 cLupFar = vec3(0.08, 0.058, 0.23);

  // ---- detail layers (skipped far away: mipmaps converge to 1 anyway)
  vec3 dG = vec3(1.0), dM = vec3(1.0), dR = vec3(1.0), dS = vec3(1.0), dA = vec3(1.0), dW = vec3(1.0), dV = vec3(1.0);
  vec3 bG = vec3(0.0), bM = vec3(0.0), bR = vec3(0.0), bS = vec3(0.0), bA = vec3(0.0), bW = vec3(0.0), bV = vec3(0.0);
  float hG = 0.5, hM = 0.5, hR = 0.5, hS = 0.5, hA = 0.5, hW = 0.5, hV = 0.5;
  float rG = 0.9, rM = 0.95, rR = 0.9, rS = 0.85, rA = 0.75, rW = 0.6, rV = 0.9;
  float nearK = TLITE ? 0.0 : 1.0 - smoothstep(uDetailFar * 0.4, uDetailFar, tDist);
  if (nearK > 0.0) {
    if (wGrass > 0.005) gLayer(0.0, tWP.xz, tDist, dG, bG, hG, rG);
    if (wMoss > 0.005) gLayer(1.0, tWP.xz, tDist, dM, bM, hM, rM);
    if (wRock > 0.005) gRock(tWP, tN0, dR, bR, hR, rR);
    if (wScree + wShoulder > 0.005) gLayer(3.0, tWP.xz, tDist, dS, bS, hS, rS);
    if (wSand > 0.005 || beachAt(tWP.xz) > 0.0) gLayer(4.0, tWP.xz, tDist, dA, bA, hA, rA);
    if (wSnow > 0.005) gLayer(5.0, tWP.xz, tDist, dW, bW, hW, rW);
    if (wShoulder > 0.005) gLayer(7.0, tWP.xz, tDist, dV, bV, hV, rV);
  }

  // fade texture contrast with distance: kills visible tiling on the mid-distance slopes
  float detK = (1.0 - smoothstep(60.0, 320.0, tDist) * 0.85) * (1.0 + 0.45 * (1.0 - smoothstep(10.0, 45.0, tDist)));   // punchier up close
  dG = mix(vec3(1.0), dG, detK); dM = mix(vec3(1.0), dM, detK); dS = mix(vec3(1.0), dS, detK);
  dA = mix(vec3(1.0), dA, detK); dW = mix(vec3(1.0), dW, detK); dV = mix(vec3(1.0), dV, detK); dM = mix(vec3(1.0), dM, 0.65); dR = mix(vec3(1.0), dR, 0.4 + 0.6 * detK);

  // height-aware blend between the main layers
  float sGr = wGrass + hG * 0.35 * step(0.001, wGrass);
  float sMo = wMoss + hM * 0.35 * step(0.001, wMoss);
  float sRo = wRock + hR * 0.4 * step(0.001, wRock);
  float sSc = wScree + hS * 0.4 * step(0.001, wScree);
  float sSa = wSand + hA * 0.3 * step(0.001, wSand);
  float sMax = max(max(max(sGr, sMo), max(sRo, sSc)), sSa);
  float thr = sMax - 0.35;          // wider blend band: layers interleave instead of meeting at a line
  float bGr = max(sGr - thr, 0.0), bMo = max(sMo - thr, 0.0), bRo = max(sRo - thr, 0.0), bSc = max(sSc - thr, 0.0), bSa = max(sSa - thr, 0.0);
  float bSum = bGr + bMo + bRo + bSc + bSa + 1e-4;
  bGr /= bSum; bMo /= bSum; bRo /= bSum; bSc /= bSum; bSa /= bSum;

  vec3 tAlb = cGrass * dG * bGr + cMoss * dM * bMo + cRock * dR * bRo + cScree * dS * bSc + cSand * dA * bSa;
  float tRough = rG * bGr + rM * bMo + rR * bRo + rS * bSc + rA * bSa;
  vec3 tBump = bG * bGr * 0.5 + bM * bMo * 0.55 + bR * bRo * 1.1 + bS * bSc * 0.6 + bA * bSa * 0.45;

  // lupine: green leaf mat near (flowers are instanced), purple haze further out
  float lupFar = smoothstep(30.0, 150.0, tDist);
  // flowers read as a mottled violet over dark leaf green (never a flat paint)
  float lupMot = smoothstep(0.25, 0.75, tgn(tWP.xz * 0.35 + 1.7) * 0.6 + n3 * 0.4);
  vec3 cLupMix = mix(cLupLeaf, cLupFar, mix(0.35, 0.8, lupMot));
  vec3 cLup = mix(cLupLeaf * dG, cLupMix, lupFar);
  float lupW = lup * (1.0 - wRock) * mix(0.7, 0.85, lupFar);
  tAlb = mix(tAlb, cLup, lupW);

  // road shoulder gravel, then trampled verge
  tAlb = mix(tAlb, cShoulder * mix(dV, dS * dS, 0.55), wShoulder);   // fine gravel + coarser stones
  tRough = mix(tRough, mix(0.9, rV, uPhoto), wShoulder);
  tBump = mix(tBump, bV * 0.5 + bS * 0.6, wShoulder);
  float verge = (1.0 - smoothstep(6.0, 8.5, tRd + (n3 - 0.5) * 1.5)) * (1.0 - wShoulder);
  tAlb = mix(tAlb, tAlb * vec3(1.05, 0.95, 0.85), verge * 0.5);

  // snow (over everything)
  tAlb = mix(tAlb, cSnow * dW, wSnow);
  tRough = mix(tRough, rW, wSnow);
  tBump = mix(tBump, bW * 0.4, wSnow);

  // wet sand at the waterline, sea bed below
  float wetLine = 1.0 - smoothstep(0.05, 0.6, tH + (n3 - 0.5) * 0.3);
  tAlb *= 1.0 - 0.3 * wetLine;
  tRough = mix(tRough, 0.5, wetLine);
  tRough = max(tRough, 0.55 * (1.0 - wetLine));
  float under = smoothstep(0.0, 3.5, -tH);
  tAlb = mix(tAlb, vec3(0.012, 0.04, 0.045), under);

  // ================= set pieces =================
  // -- snow peaks NE of the plateau: big snowfields above ~450 m, rock ribs on the ridges
  float pkZone = smoothstep(280.0, 520.0, tWP.x) * (1.0 - smoothstep(-1250.0, -1080.0, tWP.z));
  if (pkZone > 0.0) {
    float ridge = smoothstep(0.34, 0.55, slope0 + (gully - 0.5) * 0.2 + (n2 - 0.5) * 0.12);
    float snowP = smoothstep(0.0, 35.0, tH - 460.0 + (n1 - 0.5) * 220.0 + (n2 - 0.5) * 120.0 + (n3 - 0.5) * 30.0 + north * 110.0 - max(-tN0.z, 0.0) * 0.0 + (0.8 - tAOv) * 150.0 - slope0 * 80.0) * (1.0 - ridge * 0.85);
    snowP *= pkZone;
    vec3 cSnowP = cSnow * (0.92 + 0.1 * n3) * mix(vec3(1.0), vec3(0.9, 0.95, 1.05), smoothstep(0.7, 0.4, tAOv));
    tAlb = mix(tAlb, cSnowP * mix(vec3(1.0), dW, 0.6), snowP);
    tRough = mix(tRough, 0.55, snowP);
    tBump = mix(tBump, bW * 0.3, snowP);
    tAlb = mix(tAlb, cRock * 0.9, ridge * pkZone * smoothstep(380.0, 470.0, tH) * (1.0 - snowP));
  }
  // -- valley glacier: blue-white ice, transverse crevasses, dark moraine stripes, blue ice cliff at the snout
  vec3 gi = glacierInfo(tWP.xz);
  if (gi.z < 1.7) {
    // moraine apron: grey-brown till and boulders between the ice and the heath
    float mq = gi.z + (tgn(tWP.xz * 0.04) - 0.5) * 0.3 + (n3 - 0.5) * 0.1;
    float till = smoothstep(0.8, 0.98, mq) * (1.0 - smoothstep(1.2, 1.6, mq));
    vec3 tillC = mix(vec3(0.13, 0.12, 0.1), vec3(0.2, 0.18, 0.15), tgn(tWP.xz * 0.2)) * dS;
    tAlb = mix(tAlb, tillC, till * (1.0 - wSnow));
  }
  if (gi.x > 0.0) {
    float along = dot(tWP.xz, G_DIR), across = dot(tWP.xz, vec2(-G_DIR.y, G_DIR.x));
    float q = gi.z;                                                     // 0 centre … 1 margin
    float farF = smoothstep(300.0, 1200.0, tDist);
    float firn = 1.0 - smoothstep(0.12, 0.4, gi.y + (n2 - 0.5) * 0.12); // snow-covered accumulation zone
    vec3 ice = mix(vec3(0.52, 0.66, 0.78), vec3(0.74, 0.82, 0.88), tgn(tWP.xz * 0.05) * 0.6 + n3 * 0.4);
    // icefall: steep middle reach broken into transverse crevasse bands and blue seracs
    float icefall = smoothstep(0.18, 0.3, gi.y) * (1.0 - smoothstep(0.55, 0.7, gi.y));
    float bandPh = along * 0.42 + (q * q) * 5.0 + tgn(vec2(along * 0.05, across * 0.03)) * 4.0;
    float band = smoothstep(0.55, 0.9, sin(bandPh) * 0.5 + 0.5 + (n4 - 0.5) * 0.3);
    float crevF = band * (0.35 + 0.65 * icefall + 0.5 * smoothstep(0.55, 0.95, q)) * (1.0 - firn * 0.6);
    ice = mix(ice, mix(vec3(0.1, 0.25, 0.38), vec3(0.3, 0.45, 0.56), farF), clamp(crevF, 0.0, 1.0) * mix(0.7, 0.28, farF) * (0.5 + 0.5 * tgn(vec2(across * 0.05, along * 0.02) + 7.0)));
    // ogives: curved light/dark arcs down the tongue (summer/winter bands)
    float ogPh = along * 0.05 - q * q * 2.4;
    float ogive = (sin(ogPh * 6.2831) * 0.5 + 0.5) * smoothstep(0.55, 0.75, gi.y);
    ice *= 1.0 - 0.14 * ogive;
    // dust and grit increase toward the snout
    ice = mix(ice, vec3(0.32, 0.34, 0.36), smoothstep(0.5, 1.0, gi.y) * 0.55);
    // moraines: one medial stripe (where two ice streams merged) + lateral moraines on the margins
    float medX = across - (tgn(vec2(along * 0.01, 3.0)) - 0.5) * 30.0;
    float med = exp(-pow(medX / mix(6.0, 12.0, gi.y), 2.0)) * smoothstep(0.3, 0.55, gi.y);
    float lat = smoothstep(0.72, 0.93, q + (tgn(tWP.xz * 0.08) - 0.5) * 0.12);
    float mor = max(med, lat) * (0.65 + 0.35 * tgn(tWP.xz * 0.4));
    ice = mix(ice, vec3(0.05, 0.048, 0.045) * (0.8 + 0.4 * n4), clamp(mor, 0.0, 1.0));
    ice = mix(ice, cSnow * (0.95 + 0.05 * n3), firn * 0.9);
    // blue ice cliff where the tongue ends (steep ice near t = 1)
    float snout = smoothstep(0.88, 1.0, gi.y) * smoothstep(0.2, 0.45, slope0) * (1.0 - lat);
    ice = mix(ice, vec3(0.14, 0.36, 0.56) * (0.8 + 0.4 * tgn(vec2(along * 0.3, tH * 0.5))), snout * 0.9);
    tAlb = mix(tAlb, ice, gi.x);
    tRough = mix(tRough, mix(0.3, 0.75, max(firn, mor * 0.8)), gi.x);
    tBump = mix(tBump, vec3(0.0), gi.x * 0.7);
    // relief: crevasse bands as grooves across the flow
    float dBand = cos(bandPh) * 0.42;
    tN = normalize(tN + vec3(G_DIR.x, 0.0, G_DIR.y) * dBand * crevF * 0.25 * gi.x * (1.0 - farF));
    // dust streaks along the flow (the surface of a summer glacier is never clean white)
    tAlb *= 1.0 - gi.x * (1.0 - firn) * 0.3 * smoothstep(0.45, 0.8, tgn(vec2(across * 0.06, along * 0.006) + 2.0));
  }
  // -- geothermal field: silica sinter, sulphur, rust-red and ochre clays. The colours run out
  //    of the vents as tongues that follow the fall line (hot water drains downhill), and fade
  //    into the surrounding heath through patchy, noise-broken edges.
  vec4 fq = featQ(tWP.xz);
  if (fq.g < 1.9) {
    vec2 rel = tWP.xz - GEO_C;
    float downhill = max(dot(normalize(rel + vec2(1e-3)), fallD), 0.0);
    // coordinates relative to the field centre (short lever arm → no swirling as fallD turns)
    float tongue = tgn(vec2(dot(rel, vec2(-fallD.y, fallD.x)) * 0.13, dot(rel, fallD) * 0.022) + 5.0);
    float qe = fq.g - downhill * smoothstep(0.35, 0.8, tongue) * 0.55 * smoothstep(0.02, 0.1, slope0 + 0.05)
             + (tgn(tWP.xz * 0.11) - 0.5) * 0.3 + (n4 - 0.5) * 0.08;
    float gk = 1.0 - smoothstep(0.7, 1.35, qe);
    vec3 sinter = vec3(0.72, 0.7, 0.64), sulph = vec3(0.62, 0.52, 0.18), rust = vec3(0.42, 0.14, 0.06), ochre = vec3(0.46, 0.3, 0.12), clay = vec3(0.3, 0.28, 0.26);
    vec3 gc = mix(sinter, sulph, smoothstep(0.1, 0.35, qe) * 0.7);
    gc = mix(gc, rust, smoothstep(0.3, 0.55, qe) * (0.4 + 0.6 * tgn(tWP.xz * 0.4)));
    gc = mix(gc, ochre, smoothstep(0.5, 0.85, qe));
    gc = mix(gc, clay, smoothstep(0.62, 0.8, tgn(tWP.xz * 0.25 + 3.0)) * 0.6);
    gc *= 0.85 + 0.3 * n4;
    // outer fringe: stained, dying moss rather than a colour edge
    gc = mix(gc, tAlb * vec3(1.15, 0.95, 0.6), smoothstep(0.85, 1.2, qe) * 0.6);
    float pd = geoPoolD(tWP.xz);
    gc = mix(gc, sinter * 1.05, 1.0 - smoothstep(GEO_POOL_R * 1.0, GEO_POOL_R * 1.8 + (n3 - 0.5) * 4.0, pd));   // silica rim
    tAlb = mix(tAlb, gc, gk);
    tRough = mix(tRough, mix(0.35, 0.8, smoothstep(GEO_POOL_R, GEO_POOL_R * 2.5, pd)), gk);
    tBump *= 1.0 - gk * 0.6;
  }
  // -- plateau lake: banded by height above the water, not by distance from the centre:
  //    sodden moss → gravel beach → pebbly shallows → dark weedy bed
  if (fq.r < 1.8) {
    float dep = LAKE_LEVEL - tH + (n4 - 0.5) * 0.25 + (n3 - 0.5) * 0.35;
    float lz = 1.0 - smoothstep(1.3, 1.7, fq.r);
    vec3 wetMoss = vec3(0.07, 0.1, 0.035) * (0.8 + 0.4 * n3);
    vec3 gravel = mix(vec3(0.15, 0.14, 0.12), vec3(0.11, 0.105, 0.1), n4) * dS;
    float wMossL = smoothstep(-1.8, -0.7, dep) * (1.0 - smoothstep(-0.45, -0.15, dep));
    float wGrav = smoothstep(-0.55, -0.2, dep);
    tAlb = mix(tAlb, wetMoss, wMossL * lz * 0.8);
    tAlb = mix(tAlb, gravel, wGrav * lz);
    tAlb = mix(tAlb, vec3(0.035, 0.05, 0.035) * (0.8 + 0.4 * n3), smoothstep(0.7, 2.6, dep) * lz);
    tRough = mix(tRough, 0.45, max(wMossL * 0.6, wGrav) * lz);
  }
  // -- basalt canyon: bare dark rock walls, rounded cobbles on the floor
  vec3 go = gorgeInfo(tWP.xz);
  if (go.x > 0.0) {
    tAlb = mix(tAlb, mix(cRock * 0.85, vec3(0.08, 0.075, 0.07) * (0.7 + 0.6 * n4), 1.0 - smoothstep(4.0, 7.0, go.z)), go.x);
    tRough = mix(tRough, 0.6, go.x);
  }
  // -- black-sand beach → volcanic gravel (lapilli) apron → sparse shore grass → tundra
  if (fq.b < 1.5) {
    float bch = beachAt(tWP.xz), lap = lapilliAt(tWP.xz);
    float wetB = 1.0 - smoothstep(0.1, 1.4, tH + (n3 - 0.5) * 0.3);
    vec3 blk = vec3(0.018, 0.018, 0.02) * (0.85 + 0.3 * n4) * dA;
    vec3 lapC = mix(vec3(0.045, 0.04, 0.038), vec3(0.08, 0.06, 0.05), tgn(tWP.xz * 0.6)) * dS;
    float grassy = smoothstep(0.45, 0.7, tgn(tWP.xz * 0.12 + 2.0) * 0.7 + n3 * 0.3) * smoothstep(0.3, 0.9, 1.0 - bch);
    tAlb = mix(tAlb, mix(lapC, tAlb, grassy * 0.6), lap * (1.0 - bch));
    tAlb = mix(tAlb, blk * mix(1.0, 0.7, wetB), bch);
    tRough = mix(tRough, mix(0.9, 0.22, wetB), bch);
    tRough = mix(tRough, 0.9, lap * (1.0 - bch));
  }

  tBump *= nearK * (1.0 - smoothstep(60.0, 250.0, tDist) * 0.6) * (1.0 + 0.5 * (1.0 - smoothstep(8.0, 35.0, tDist)));
  diffuseColor.rgb = tAlb;
`;

// per-quality shading reach (shared by both terrain materials)
const QU = { uDetailFar: { value: 420 }, uWallFar: { value: 1200 } };
function patchTerrain(td, tex, U, isDepth) {
  return (shader) => {
    Object.assign(shader.uniforms, td.uniforms);
    shader.uniforms.uRange0 = { value: RANGE_K * LEAF };
    shader.uniforms.uMaxLod = { value: MAX_LOD };
    shader.uniforms.uDetailFar = QU.uDetailFar;
    shader.uniforms.uWallFar = QU.uWallFar;
    const pre = td.GLSL + PLACE_GLSL;
    if (isDepth) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + pre)
        .replace('#include <begin_vertex>', 'vec3 transformed; { vec3 tn, td; terrPlace(position, transformed, tn, td); }');
      return;
    }
    // live objects: swapping procedural → photo textures needs no recompile
    shader.uniforms.uGAlb = tex.uGAlb; shader.uniforms.uGNrm = tex.uGNrm; shader.uniforms.uPhoto = tex.uPhoto;
    shader.uniforms.uGMean = tex.uGMean; shader.uniforms.uGLay = tex.uGLay;
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uRain = U.uRain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + pre)
      .replace('#include <beginnormal_vertex>', 'vec3 tPlaceWP, tPlaceN, tPlaceD;\nterrPlace(position, tPlaceWP, tPlaceN, tPlaceD);\nvec3 objectNormal = tPlaceN;')
      .replace('#include <begin_vertex>', 'vec3 transformed = tPlaceWP;\nvTW = tPlaceWP; vTDet = tPlaceD;');
    const lights = bakedLightChunks('vTW');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW;\nvarying vec3 vTDet;\n' + td.GLSL + LAYER_GLSL)
      .replace('#include <map_fragment>', ALBEDO_GLSL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= tRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec3 nW = normalize(tN + tBump);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      }`)
      .replace('#include <lights_fragment_begin>', lights.begin)
      .replace('#include <aomap_fragment>', lights.ao)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
      // beyond ~8 km dissolve fully into the horizon haze (the far plane is 9 km)
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColorDir(normalize(tWP - cameraPosition)), smoothstep(7200.0, 8800.0, tDist));`);
  };
}

/* ------------------------------------------------------------ geometry */
function makePatchGeometry() {
  const V = G + 1;
  const pos = new Float32Array(V * V * 3);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const o = (j * V + i) * 3;
    pos[o] = i / G; pos[o + 1] = 0; pos[o + 2] = j / G;
  }
  const idx = new Uint16Array(G * G * 6);
  let q = 0;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    // alternate diagonals (better silhouettes on ridges)
    if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
    else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
  }
  return { pos: new THREE.BufferAttribute(pos, 3), index: new THREE.BufferAttribute(idx, 1) };
}

function makeInstancedGeo(base) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', base.pos);
  g.setIndex(base.index);
  const buf = new Float32Array(MAX_NODES * 4);
  const attr = new THREE.InstancedBufferAttribute(buf, 4);
  attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aNode', attr);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  return { g, attr, buf, n: 0 };
}

/* ------------------------------------------------ min/max height pyramid */
function buildMinMax(H) {
  // level 0 = 32 m cells over the inner world (128²), then halve.
  const levels = [];
  let n = (T_HALF * 2) / LEAF; // 128
  const cells = LEAF / T_RES;  // 8 grid cells per leaf
  let mn = new Float32Array(n * n), mx = new Float32Array(n * n);
  for (let cj = 0; cj < n; cj++) for (let ci = 0; ci < n; ci++) {
    let a = Infinity, b = -Infinity;
    for (let j = cj * cells; j <= (cj + 1) * cells; j++) for (let i = ci * cells; i <= (ci + 1) * cells; i++) {
      const v = H[Math.min(j, T_N - 1) * T_N + Math.min(i, T_N - 1)];
      if (v < a) a = v; if (v > b) b = v;
    }
    mn[cj * n + ci] = a; mx[cj * n + ci] = b;
  }
  levels.push({ n, mn, mx });
  while (n > 1) {
    const m = n >> 1, mn2 = new Float32Array(m * m), mx2 = new Float32Array(m * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const k = 2 * j * n + 2 * i;
      mn2[j * m + i] = Math.min(mn[k], mn[k + 1], mn[k + n], mn[k + n + 1]);
      mx2[j * m + i] = Math.max(mx[k], mx[k + 1], mx[k + n], mx[k + n + 1]);
    }
    n = m; mn = mn2; mx = mx2;
    levels.push({ n, mn, mx });
  }
  return levels;
}

/* ================================================================ module */
export async function createFjordTerrain(ctx) {
  const { scene, camera, prepareMaterial, uniforms: U, renderer } = ctx;
  const t0 = performance.now();
  // photo-scanned ground textures: start fetching now (they decode while the height data builds)
  loadPhotoAssets(ctx);
  const td = getTerrainData(ctx);
  const ph = await awaitPhotoAssets(ctx);
  setGroundTextures(ph?.ground || getFjordGroundTextures());
  if (!ph) loadPhotoAssets(ctx).then((a) => { if (a.ground) setGroundTextures(a.ground); });   // late arrival
  const tex = groundUniforms();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.defines = { TLITE: 'false' };
  addShaderPatch(mat, 'fjordTerrain', patchTerrain(td, tex, U, false));
  prepareMaterial(mat);
  // cheaper variant for the half-res lake reflection (no detail layers, no wall noise)
  const matLite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  matLite.defines = { TLITE: 'true' };
  addShaderPatch(matLite, 'fjordTerrainLite', patchTerrain(td, tex, U, false));
  prepareMaterial(matLite);
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  addShaderPatch(depthMat, 'fjordTerrainDepth', patchTerrain(td, tex, U, true));

  const base = makePatchGeometry();
  const near = makeInstancedGeo(base), far = makeInstancedGeo(base), refl = makeInstancedGeo(base);
  const meshNear = new THREE.Mesh(near.g, mat), meshFar = new THREE.Mesh(far.g, mat);
  for (const m of [meshNear, meshFar]) {
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.customDepthMaterial = depthMat;
  }
  meshNear.castShadow = true;
  meshNear.name = 'terrainNear'; meshFar.name = 'terrainFar';
  const group = new THREE.Group();
  group.name = 'fjordTerrain';
  // mirror-lake reflection: same terrain, own node list, only on layer 5 (see water.js)
  const meshRefl = new THREE.Mesh(refl.g, matLite);
  meshRefl.frustumCulled = false; meshRefl.matrixAutoUpdate = false; meshRefl.layers.set(5); meshRefl.name = 'terrainReflect';
  group.add(meshNear, meshFar, meshRefl);
  const columns = createGorgeColumns(ctx, td);
  group.add(columns.mesh);
  scene.add(group);
  // every tier keeps the near-ground detail; lower tiers just shorten how far it reaches
  const applyQ = (q) => {
    QU.uDetailFar.value = q === 'low' ? 110 : q === 'medium' ? 260 : 420;
    QU.uWallFar.value = q === 'low' ? 450 : q === 'medium' ? 800 : 1200;
    meshNear.castShadow = q !== 'low';
  };
  applyQ(ctx.state.get('resolvedQuality'));
  const offQ = ctx.state.on('resolvedQuality', applyQ);

  /* ---- quadtree selection */
  const pyr = buildMinMax(td.heights);
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  const ranges = [];
  for (let l = 0; l <= MAX_LOD; l++) ranges.push(RANGE_K * LEAF * 2 ** l);
  let cx = 0, cz = 0;
  const stats = { nodes: 0, near: 0 };

  let ry0 = 0, ry1 = 0;   // yRange output (no per-node allocation)
  function yRange(x0, z0, size, lod) {
    // inner nodes: exact pyramid; outer ring: conservative
    if (x0 >= -T_HALF && z0 >= -T_HALF && x0 + size <= T_HALF && z0 + size <= T_HALF) {
      const P = pyr[lod];
      if (P) {
        const i = Math.floor((x0 + T_HALF) / size), j = Math.floor((z0 + T_HALF) / size);
        const k = j * P.n + i;
        ry0 = Math.min(P.mn[k], 0) * 1.25 - 3; ry1 = P.mx[k] + 3;
        return;
      }
    }
    ry0 = -120; ry1 = 1500;
  }
  function push(target, x0, z0, size, lod) {
    if (target.n >= MAX_NODES) return;
    const o = target.n * 4;
    target.buf[o] = x0; target.buf[o + 1] = z0; target.buf[o + 2] = size; target.buf[o + 3] = lod;
    target.n++;
  }
  function select(x0, z0, size, lod) {
    const dx = Math.max(x0 - cx, 0, cx - (x0 + size)), dz = Math.max(z0 - cz, 0, cz - (z0 + size));
    const d = Math.hypot(dx, dz);
    if (d > FAR_CULL) return;
    yRange(x0, z0, size, lod);
    box.min.set(x0, ry0, z0); box.max.set(x0 + size, ry1, z0 + size);
    if (!frustum.intersectsBox(box)) return;
    if (lod === 0 || d > ranges[lod - 1]) {
      push(reflMode ? refl : d < NEAR_SHADOW ? near : far, x0, z0, size, lod);
      return;
    }
    const h = size / 2;
    select(x0, z0, h, lod - 1); select(x0 + h, z0, h, lod - 1);
    select(x0, z0 + h, h, lod - 1); select(x0 + h, z0 + h, h, lod - 1);
  }
  let reflMode = false;
  // Node list for a mirrored camera (same xz as the main camera, so LOD ranges/morph agree).
  td.prepareReflection = (cam) => {
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    cx = cam.position.x; cz = cam.position.z;
    refl.n = 0; reflMode = true;
    for (let z0 = -EXTENT; z0 < EXTENT; z0 += ROOT) for (let x0 = -EXTENT; x0 < EXTENT; x0 += ROOT) select(x0, z0, ROOT, MAX_LOD);
    reflMode = false;
    refl.g.instanceCount = refl.n;
    refl.attr.clearUpdateRanges(); refl.attr.addUpdateRange(0, Math.max(4, refl.n * 4)); refl.attr.needsUpdate = true;
    return refl.n;
  };
  function selectAll(cam) {
    cam.updateMatrixWorld();
    cx = cam.position.x; cz = cam.position.z;
    td.uniforms.uLodCam.value.copy(cam.position);
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    near.n = 0; far.n = 0;
    for (let z0 = -EXTENT; z0 < EXTENT; z0 += ROOT) for (let x0 = -EXTENT; x0 < EXTENT; x0 += ROOT) select(x0, z0, ROOT, MAX_LOD);
    for (const t of [near, far]) {
      t.g.instanceCount = t.n;
      t.attr.clearUpdateRanges();
      t.attr.addUpdateRange(0, Math.max(4, t.n * 4));
      t.attr.needsUpdate = true;
    }
    stats.nodes = near.n + far.n; stats.near = near.n;
  }
  // Select right before the main render (camera already moved by the controllers this frame).
  // (If another module later replaces scene.onBeforeRender without chaining, update()
  // notices and falls back to selecting there, one frame behind.)
  let updates = 0, obrSeen = 0;
  const prevOBR = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam, rt) {
    if (prevOBR) prevOBR.call(this, r, s, cam, rt);
    if (cam === camera) { selectAll(cam); obrSeen = updates; }
  };
  selectAll(camera);
  td.update(renderer, 0);

  let ms = performance.now() - t0;
  console.info(`[fjord terrain] ready ${Math.round(ms)} ms (basalt columns ${columns.count})`);

  return {
    group, td, stats,
    heightAt: td.heightAt,
    update(dt) {
      td.update(renderer, dt);
      // columns only cast real-time shadows when the canyon is right next to the camera
      const cs = columns.mesh.boundingSphere;
      columns.mesh.castShadow = ctx.state.get('resolvedQuality') === 'high' && camera.position.distanceTo(cs.center) - cs.radius < 60;
      if (++updates - obrSeen > 2) selectAll(camera);
    },
    dispose() {
      offQ?.();
      scene.onBeforeRender = prevOBR || (() => {});
      scene.remove(group);
      near.g.dispose(); far.g.dispose(); refl.g.dispose(); mat.dispose(); matLite.dispose(); depthMat.dispose(); columns.dispose();
      td.dispose();
    },
  };
}
