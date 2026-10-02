// Fjord water: the sea (y = 0, out to the horizon), plateau tarns, the glacial river
// down the valley floor, 7 ribbon waterfalls on the basalt terraces + their spray.
//
// All water shades with custom ShaderMaterials that sample the shared terrain textures
// (env/terrainData.js) for depth → shallow colour, alpha and shore foam, the sky PMREM
// (scene.environment) for Fresnel reflections, and the baked terrain shadow so mountain
// shadows kill the sun glitter. Everything goes through applyHeightFog.

import * as THREE from 'three';
import { FOG_PARS_GLSL, fogUniforms } from '../../render/fog.js';
import { getTerrainData } from './env/terrainData.js';
import { mulberry32, smoothstep, clamp, lerp } from '../../core/noise.js';
import { FEATURES, lakeR } from './env/features.js';
import { createMirrorLake, createHotPool, createParticles, createPlungePool } from './env/waterFx.js';
import { SSR_GLSL, ssrUniforms } from '../../render/ssr.js';   // screen-space reflections (pipeline-owned)

/* ------------------------------------------------------------ shared GLSL */
const RIPPLE_GLSL = /* glsl */ `
vec2 rainRipples(vec2 p, float t, float rain) {
  vec2 g = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 2.3 : 3.9;
    vec2 q = p * sc + float(k) * 13.7;
    vec2 cell = floor(q), f = fract(q) - 0.5;
    float h1 = tgh(cell), h2 = tgh(cell + 17.3), h3 = tgh(cell + 41.7);
    float ph = fract(t * (0.7 + 0.7 * h2) + h1);
    float on = step(h3, rain * 0.85 + 0.03);
    vec2 c = (vec2(h1, fract(h2 * 7.31)) - 0.5) * 0.26;
    vec2 d = f - c;
    float r = length(d) + 1e-4;
    float x = r - ph * 0.42;
    float env = exp(-x * x * 300.0);
    float kk = 62.0;
    float dh = env * (kk * cos(kk * x) - 600.0 * x * sin(kk * x));
    float fade = (1.0 - ph); fade *= fade;
    g += (d / r) * dh * fade * on;
  }
  return g * 0.0065;
}
`;

// Sky reflection: PMREM env (CubeUV) when available, fog-coloured sky otherwise.
const ENV_GLSL = /* glsl */ `
#ifdef ENVMAP_TYPE_CUBE_UV
uniform sampler2D envMap;
#include <cube_uv_reflection_fragment>
#endif
uniform float uEnvI;
vec3 skyRefl(vec3 R, float rough) {
#ifdef ENVMAP_TYPE_CUBE_UV
  return textureCubeUV(envMap, R, rough).rgb * uEnvI;
#else
  return fogColorDir(R) * 1.2;
#endif
}
float ggx(float NH, float a) {
  float a2 = a * a; float d = NH * NH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d);
}
`;

const SURF_VERT = /* glsl */ `
attribute vec4 aFlow;      // river: lateral (m), arc (m), slope, half-width
varying vec3 vWP;
varying vec4 vFlow;
void main() {
  vFlow = aFlow;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWP = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/* ---------------------------------------------------------------- sea / lakes */
function seaFrag(td) {
  return /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
${RIPPLE_GLSL}
${ENV_GLSL}
${SSR_GLSL}
uniform float uTime, uRain, uCalm;
uniform vec3 uSunCol, uWind;
varying vec3 vWP;

vec2 waveGrad(vec2 p, float t, float dist) {
  vec2 wd = normalize(uWind.xz + vec2(1e-4));
  mat2 rot = mat2(wd.x, -wd.y, wd.y, wd.x);
  vec2 q = rot * p;
  vec2 g = vec2(0.0);
  // (scale m, height m, speed m/s)
  vec3 O[5];
  O[0] = vec3(41.0, 0.55, 1.6); O[1] = vec3(14.0, 0.22, 1.0); O[2] = vec3(4.7, 0.07, 0.6);
  O[3] = vec3(1.7, 0.022, 0.35); O[4] = vec3(0.63, 0.007, 0.22);
  for (int i = 0; i < 5; i++) {
    float s = O[i].x;
    float fade = 1.0 - smoothstep(s * 35.0, s * 110.0, dist);
    if (fade <= 0.0) continue;
    vec2 qq = q / s + vec2(float(i) * 7.31, float(i) * 3.17);
    vec3 a = tgnd(qq + vec2(t * O[i].z / s, 0.0));
    vec3 b = tgnd(qq * 1.37 + vec2(-t * O[i].z * 0.7 / s, t * O[i].z * 0.4 / s) + 11.0);
    g += (a.yz + b.yz * 0.7) * O[i].y / s * fade;
  }
  return (transpose(rot) * g) * mix(1.0, 0.25, uCalm);
}

void main() {
  vec3 wp = vWP;
  float tH = baseH(wp.xz);
  float depth = wp.y - tH;
  if (depth < -0.02) discard;
  vec3 toC = cameraPosition - wp;
  float dist = length(toC);
  vec3 V = toC / dist;
  float t = uTime;

  vec2 g = waveGrad(wp.xz, t, dist);
  g += rainRipples(wp.xz, t, uRain) * (1.0 - smoothstep(12.0, 50.0, dist)) * 2.0;
  g *= smoothstep(0.0, 1.5, depth) * 0.7 + 0.3;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NV = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.015; R = normalize(R);
  float rough = 0.035 + 0.09 * smoothstep(60.0, 2500.0, dist) + 0.18 * uRain;
  vec3 refl = skyRefl(R, rough * 2.0);
  // mountains, shore, houses mirrored (SSR; falls back to the sky where the ray misses)
  if (F > 0.03) { vec4 ssr = ssrTrace(wp, R, dist); refl = mix(refl, ssr.rgb, ssr.a * (1.0 - smoothstep(0.1, 0.3, rough))); }

  // body colour: deep fjord blue ↔ green-teal shallows over black sand
  float sunVis = terrSunVis(wp.xz);
  float ao = terrAO(wp.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  float dk = 1.0 - exp(-max(depth, 0.0) * 0.28);
  vec3 absorb = mix(vec3(0.06, 0.26, 0.22), vec3(0.006, 0.035, 0.06), dk);
  vec3 light = skyUp * 0.55 * ao + uSunCol * max(uSunDir.y, 0.0) * 0.12 * sunVis;
  vec3 body = absorb * light;
  // forward-scatter glow through wave crests toward the sun
  float sss = pow(max(dot(-V, uSunDir) * 0.5 + 0.5, 0.0), 4.0) * max(g.x * uSunDir.x + g.y * uSunDir.z, 0.0);
  body += vec3(0.03, 0.12, 0.1) * uSunCol * sss * 0.6 * sunVis;

  vec3 col = mix(body, refl, F);

  // sun glitter (GGX; roughness grows with distance → a glittering path toward the sun)
  vec3 L = uSunDir;
  vec3 Hh = normalize(L + V);
  float NL = max(dot(N, L), 0.0);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(Hh, V), 0.0), 5.0);
  float spec = ggx(max(dot(N, Hh), 0.0), rough) * Fs / (4.0 * NV + 0.05) * NL;
  col += uSunCol * min(spec, 60.0) * sunVis * (1.0 - 0.8 * uRain);

  // shore foam (lapping lace)
  // a thin swash line that runs up and back, plus lacy remnants just behind it
  float lap = sin(t * 0.9 + tgn(wp.xz * 0.05) * 6.0) * 0.5 + 0.5;
  float line = exp(-pow((depth - 0.06 - lap * 0.22) / 0.05, 2.0));
  float lace = smoothstep(0.55, 0.85, tgn(wp.xz * 2.3 + vec2(t * 0.2, 0.0)) * 0.55 + tgn(wp.xz * 7.1 - t * 0.1) * 0.45);
  float foam = (line * (0.5 + 0.5 * lace) + lace * (1.0 - smoothstep(0.0, 0.5, depth)) * 0.5) * (1.0 - uCalm * 0.7);
  // surf: successive foam lines rolling in over the shelf and dying on the sand
  for (int k = 0; k < 3; k++) {
    float ph = fract(t * 0.09 + float(k) / 3.0 + tgn(wp.xz * 0.01) * 0.3);
    float dline = mix(2.4, 0.03, ph);
    float w = exp(-pow((depth - dline) / mix(0.12, 0.05, ph), 2.0)) * smoothstep(0.0, 0.25, ph) * (1.0 - smoothstep(0.85, 1.0, ph));
    foam = max(foam, w * (0.45 + 0.55 * lace) * (1.0 - uCalm));
  }
  foam *= 1.0 - smoothstep(150.0, 600.0, dist);
  vec3 foamCol = (uSunCol * 0.3 * max(uSunDir.y, 0.1) * sunVis + skyUp * 0.8) * 0.85;
  col = mix(col, foamCol, foam * 0.85);

  float alpha = mix(0.3, 0.97, smoothstep(0.0, 4.0, depth));
  alpha = max(alpha, F);
  alpha = max(alpha, foam);
  alpha *= smoothstep(-0.02, 0.1, depth);

  col = applyHeightFog(col, wp);
  col = mix(col, fogColorDir(-V), smoothstep(7200.0, 8800.0, dist));
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

/* ----------------------------------------------------------------- river */
function riverFrag(td) {
  return /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
${RIPPLE_GLSL}
${ENV_GLSL}
${SSR_GLSL}
uniform float uTime, uRain, uZEnd;
uniform vec3 uSunCol;
varying vec3 vWP;
varying vec4 vFlow;
void main() {
  vec3 wp = vWP;
  float depth = wp.y - baseH(wp.xz);
  if (depth < -0.02) discard;
  float lat = vFlow.x, arc = vFlow.y, slope = vFlow.z, hw = vFlow.w;
  vec3 toC = cameraPosition - wp;
  float dist = length(toC);
  vec3 V = toC / dist;
  float t = uTime;
  float speed = 1.4 + clamp(slope * 25.0, 0.0, 1.0) * 2.2;
  vec2 f1 = vec2(0.9, 0.25), f2 = vec2(2.4, 0.7), f3 = vec2(6.0, 1.9);
  vec3 n1 = tgnd(vec2(lat, arc - t * speed) * f1);
  vec3 n2 = tgnd(vec2(lat, arc - t * speed * 1.4) * f2 + 4.3);
  vec3 n3 = tgnd(vec2(lat, arc - t * speed * 1.9) * f3 + 9.1);
  float fade = 1.0 - smoothstep(40.0, 260.0, dist);
  float amp = (0.5 + clamp(slope * 25.0, 0.0, 1.0) * 0.8) * clamp(depth * 2.0, 0.2, 1.0);
  vec2 gl = vec2(n1.y * f1.x * 0.2 + n2.y * f2.x * 0.08 + n3.y * f3.x * 0.03 * fade,
                 n1.z * f1.y * 0.2 + n2.z * f2.y * 0.08 + n3.z * f3.y * 0.03 * fade) * amp;
  // local frame: flow is roughly +z (south)
  vec2 g = vec2(gl.x, gl.y);
  g += rainRipples(wp.xz, t, uRain) * (1.0 - smoothstep(10.0, 45.0, dist)) * 1.8;
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float NV = max(dot(N, V), 1e-3);
  float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.02; R = normalize(R);
  float rough = 0.06 + 0.1 * smoothstep(50.0, 1500.0, dist);
  // in a deep canyon most of the reflected hemisphere is dark rock, not sky
  vec3 refl = skyRefl(R, rough * 2.0) * mix(0.25, 1.0, smoothstep(0.35, 0.8, terrAO(wp.xz)));
  if (F > 0.03) { vec4 ssr = ssrTrace(wp, R, dist); refl = mix(refl, ssr.rgb, ssr.a); }
  float sunVis = terrSunVis(wp.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  // glacial melt water: milky blue-green
  float dk = 1.0 - exp(-max(depth, 0.0) * 0.9);
  vec3 absorb = mix(vec3(0.16, 0.30, 0.28), vec3(0.035, 0.11, 0.13), dk);
  vec3 body = absorb * (skyUp * 0.55 + uSunCol * max(uSunDir.y, 0.0) * 0.14 * sunVis);
  vec3 col = mix(body, refl, F);
  vec3 L = uSunDir, Hh = normalize(L + V);
  float spec = ggx(max(dot(N, Hh), 0.0), rough) * F / (4.0 * NV + 0.05) * max(dot(N, L), 0.0);
  col += uSunCol * min(spec, 40.0) * sunVis;
  // white water: riffles on steeper reaches, lace along the banks
  // foam streaks stretched along the current, finer where it's fast
  float rif = tgn(vec2(lat * 2.4, (arc - t * speed * 1.2) * 0.28)) * 0.55 + tgn(vec2(lat * 6.5, (arc - t * speed * 1.5) * 0.7) + 3.0) * 0.3 + tgn(vec2(lat * 15.0, (arc - t * speed * 1.8) * 2.0) + 7.0) * 0.15;
  float sl = clamp(slope * 25.0, 0.0, 1.0);          // 0 = lazy reach … 1 = rapids (~4 % grade)
  float white = smoothstep(0.66 - sl * 0.14, 0.86 - sl * 0.1, rif) * mix(0.25, 1.0, sl);
  white += (1.0 - smoothstep(0.05, 0.35, depth)) * smoothstep(0.45, 0.75, rif) * 0.8;
  white = clamp(white, 0.0, 1.0) * (1.0 - smoothstep(300.0, 900.0, dist) * 0.6);
  vec3 foamCol = (uSunCol * 0.3 * max(uSunDir.y, 0.1) * sunVis + skyUp * 0.85) * 0.85;
  col = mix(col, foamCol, white * 0.8);
  float alpha = mix(0.5, 0.95, smoothstep(0.0, 1.2, depth));
  alpha = max(max(alpha, F), white);
  alpha *= smoothstep(-0.02, 0.08, depth);
  alpha *= 1.0 - smoothstep(uZEnd - 60.0, uZEnd, wp.z);   // hand over to the sea
  col = applyHeightFog(col, wp);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

function addRibbon(pos, flow, idx, pts, across = 5) {
  // pts: [{x, y, z, hw}] — a shallow stream ribbon following the given centre line
  const base0 = pos.length / 3;
  let arc = 0, rows = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = tz, nz = -tx;
    if (i > 0) arc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    const slope = Math.max(0, (a.y - b.y) / (Math.hypot(b.x - a.x, b.z - a.z) || 1));
    for (let k = 0; k < across; k++) {
      const l = (k / (across - 1) * 2 - 1) * p.hw;
      pos.push(p.x + nx * l, p.y, p.z + nz * l);
      flow.push(l, arc, slope, p.hw);
    }
    if (rows > 0) {
      const bb = base0 + (rows - 1) * across;
      for (let k = 0; k < across - 1; k++) { const a0 = bb + k, a1 = a0 + 1, c0 = a0 + across, c1 = c0 + 1; idx.push(a0, c0, a1, a1, c0, c1); }
    }
    rows++;
  }
}

function buildRiverGeo(world, td, extras = []) {
  const R = td.river, pos = [], flow = [], idx = [];
  const ACROSS = 9;
  let arc = 0, prev = null, rows = 0;
  for (let z = R.z0; z <= R.z1; z += 3) {
    const x = world.riverX(z), y = R.levelAt(z);
    const dxdz = (world.riverX(z + 1) - world.riverX(z - 1)) / 2;
    const tl = Math.hypot(dxdz, 1), tx = dxdz / tl, tz = 1 / tl;
    const nx = tz, nz = -tx;                          // right-hand normal
    if (prev) arc += Math.hypot(x - prev[0], z - prev[1]);
    prev = [x, z];
    const slope = Math.max(0, (R.levelAt(z - 12) - R.levelAt(z + 12)) / 24);
    const hw = 14 * R.widthAt(z);
    for (let k = 0; k < ACROSS; k++) {
      const l = (k / (ACROSS - 1) * 2 - 1) * hw;
      pos.push(x + nx * l, y, z + nz * l);
      flow.push(l, arc, slope, hw);
    }
    if (rows > 0) {
      const b = (rows - 1) * ACROSS;
      for (let k = 0; k < ACROSS - 1; k++) {
        const a0 = b + k, a1 = a0 + 1, c0 = a0 + ACROSS, c1 = c0 + 1;
        idx.push(a0, c0, a1, a1, c0, c1);
      }
    }
    rows++;
  }
  for (const e of extras) addRibbon(pos, flow, idx, e.pts, e.across || 5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* -------------------------------------------------- set-piece streams */
function traceStream(world, td, x, z, maxLen = 260) {
  const h = td.heightAt, out = [];
  const grad = (x, z) => { const e = 2; return [(h(x + e, z) - h(x - e, z)) / (2 * e), (h(x, z + e) - h(x, z - e)) / (2 * e)]; };
  let px = 0, pz = 0, flat = 0;
  for (let k = 0; k < maxLen / 2; k++) {
    let [gx, gz] = grad(x, z); let g = Math.hypot(gx, gz);
    // keep some momentum so the stream doesn't dither on flats
    if (k > 0) { gx = gx * 0.7 - px * 0.3 * Math.max(g, 0.05); gz = gz * 0.7 - pz * 0.3 * Math.max(g, 0.05); g = Math.hypot(gx, gz); }
    if (g < 1e-4) break;
    px = -gx / g; pz = -gz / g;
    out.push({ x, z, y: h(x, z) + 0.18, rd: world.roadDistAt(x, z) });
    x += px * 2; z += pz * 2;
    if (Math.hypot(...grad(x, z)) < 0.015) { if (++flat > 12) break; } else flat = 0;
    if (Math.abs(x - world.riverX(z)) < 12 && z > -900) break;
  }
  return out;
}
function streamRibbons(world, td, pts, hw, minRoad = 7.5) {
  // split where the stream passes under the road (culvert)
  const out = []; let cur = [];
  for (const p of pts) {
    if (p.rd < minRoad) { if (cur.length > 3) out.push({ pts: cur }); cur = []; continue; }
    cur.push({ x: p.x, y: p.y, z: p.z, hw });
  }
  if (cur.length > 3) out.push({ pts: cur });
  return out;
}

/* --------------------------------------------------------------- tarns */
// Priority-flood the plateau heights; keep a few decent-sized depressions away from the road.
function findLakes(world, td) {
  const H = td.heights, N = world.gridSize, RES = world.gridRes, HALF = world.WORLD_HALF;
  const i0 = Math.floor((-1400 + HALF) / RES), i1 = Math.floor((1000 + HALF) / RES);
  const j0 = Math.floor((-2000 + HALF) / RES), j1 = Math.floor((-1320 + HALF) / RES);
  const W = i1 - i0 + 1, Hh = j1 - j0 + 1, F = new Float32Array(W * Hh), done = new Uint8Array(W * Hh);
  const hg = (i, j) => H[(j0 + j) * N + i0 + i];
  // binary heap on (value, index)
  const hv = [], hk = [];
  const push = (v, k) => { hv.push(v); hk.push(k); let i = hv.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hv[p] <= hv[i]) break; [hv[p], hv[i]] = [hv[i], hv[p]]; [hk[p], hk[i]] = [hk[i], hk[p]]; i = p; } };
  const pop = () => {
    const v = hv[0], k = hk[0], lv = hv.pop(), lk = hk.pop();
    if (hv.length) { hv[0] = lv; hk[0] = lk; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < hv.length && hv[a] < hv[m]) m = a; if (b < hv.length && hv[b] < hv[m]) m = b; if (m === i) break; [hv[m], hv[i]] = [hv[i], hv[m]]; [hk[m], hk[i]] = [hk[i], hk[m]]; i = m; } }
    return [v, k];
  };
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) if (i === 0 || j === 0 || i === W - 1 || j === Hh - 1) { const k = j * W + i; F[k] = hg(i, j); done[k] = 1; push(F[k], k); }
  const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (hv.length) {
    const [v, k] = pop(); const i = k % W, j = (k / W) | 0;
    for (const [di, dj] of D4) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= W || b >= Hh) continue; const kk = b * W + a; if (done[kk]) continue; done[kk] = 1; F[kk] = Math.max(hg(a, b), v); push(F[kk], kk); }
  }
  const lab = new Int32Array(W * Hh).fill(-1), comps = [];
  for (let k = 0; k < W * Hh; k++) {
    const i = k % W, j = (k / W) | 0;
    if (lab[k] >= 0 || F[k] - hg(i, j) < 0.3) continue;
    const st = [k], cells = []; lab[k] = comps.length; let minRd = 1e9;
    while (st.length) {
      const q = st.pop(), a = q % W, b = (q / W) | 0; cells.push(q);
      minRd = Math.min(minRd, world.roadDistAt(-HALF + (i0 + a) * RES, -HALF + (j0 + b) * RES));
      for (const [di, dj] of D4) { const aa = a + di, bb = b + dj; if (aa < 0 || bb < 0 || aa >= W || bb >= Hh) continue; const kk = bb * W + aa; if (lab[kk] >= 0 || F[kk] - hg(aa, bb) < 0.05) continue; lab[kk] = comps.length; st.push(kk); }
    }
    comps.push({ cells, level: F[k] - 0.12, minRd });
  }
  const cx = (c) => -HALF + (i0 + (c.cells[0] % W)) * RES, cz = (c) => -HALF + (j0 + ((c.cells[0] / W) | 0)) * RES;
  const clearOf = (c) => lakeR(cx(c), cz(c)) > 1.6 && Math.hypot(cx(c) - FEATURES.geothermal.x, cz(c) - FEATURES.geothermal.z) > 90;
  const lakes = comps.filter((c) => c.cells.length * RES * RES > 4000 && c.minRd > 45 && clearOf(c)).sort((a, b) => b.cells.length - a.cells.length).slice(0, 3);
  // one quad per flooded cell (+1 cell margin), merged
  const pos = [], idx = [];
  for (const L of lakes) {
    const set = new Set(L.cells);
    const grow = new Set();
    for (const q of set) { const a = q % W, b = (q / W) | 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) grow.add((b + dj) * W + a + di); }
    for (const q of grow) {
      const a = q % W, b = (q / W) | 0;
      const x = -HALF + (i0 + a) * RES - RES / 2, z = -HALF + (j0 + b) * RES - RES / 2;
      const base = pos.length / 3;
      pos.push(x, L.level, z, x + RES, L.level, z, x, L.level, z + RES, x + RES, L.level, z + RES);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return { geo: g, lakes: lakes.map((l) => ({ level: +l.level.toFixed(2), area: l.cells.length * RES * RES })) };
}

/* ------------------------------------------------------------ waterfalls */
// Big falls: long cascades from the crest (seen from 1–2 km). Near falls: medium drops
// from a wall terrace within ~400 m of the road, facing it, so the rider passes close by.
export function findWaterfalls(world, td, { big = 6, near = 2 } = {}) {
  const h = td.heightAt;
  const grad = (x, z) => { const e = 2; return [(h(x + e, z) - h(x - e, z)) / (2 * e), (h(x, z + e) - h(x, z - e)) / (2 * e)]; };
  const roadY = (x, z) => world.path.pointAt(world.path.nearestS(x, z)).y;
  function trace(x, z) {
    const pts = [[x, h(x, z), z]]; let steep = 0, flatRun = 0;
    for (let k = 0; k < 500; k++) {
      const [gx, gz] = grad(x, z), g = Math.hypot(gx, gz);
      if (g < 0.04) break;
      x -= (gx / g) * 3; z -= (gz / g) * 3;
      const y = h(x, z), dy = pts[pts.length - 1][1] - y;
      if (dy / 3 > 0.6) steep += dy;
      flatRun = dy / 3 < 0.3 ? flatRun + 3 : 0;
      pts.push([x, y, z]);
      if (flatRun > 30 && steep > 40) break;
      if (y < world.floorY(clamp(z, -1500, 1000)) + 14) break;
      if (world.roadDistAt(x, z) < 45) break;
    }
    return { pts, steep };
  }
  const cands = [];
  for (let z = -1050; z <= 740; z += 16) for (let x = -1350; x <= 1500; x += 16) {
    const y = h(x, z); if (y < 110 || y > 720) continue;
    const rd = world.roadDistAt(x, z);
    if (rd < 220 || rd > 1500) continue;
    const [gx, gz] = grad(x, z), g = Math.hypot(gx, gz);
    if (g > (rd < 420 ? 1.4 : 0.9)) continue;               // big: start at a terrace lip; near: anywhere on the wall
    const x2 = x - (gx / (g || 1)) * 10, z2 = z - (gz / (g || 1)) * 10;
    const [gx2, gz2] = grad(x2, z2);
    if (Math.hypot(gx2, gz2) < 0.75) continue;
    const t = trace(x, z);
    if (t.steep < 55) continue;
    const e = t.pts[t.pts.length - 1];
    const toRoad = world.roadDistAt(e[0], e[2]) < rd - 60;   // flows toward the road
    cands.push({ x, z, y, rd, above: y - roadY(x, z), toRoad, steep: t.steep, pts: t.pts, side: x > world.valleyX(z) ? 1 : -1 });
  }
  const pick = [];
  const HFp = FEATURES.hairpinFall, GOp = FEATURES.gorge;
  const far = (c, d) => pick.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > d) && Math.hypot(c.x - HFp.x, c.z - HFp.z) > 350 && Math.hypot(c.x - GOp.ax, c.z - GOp.az) > 300;
  // near-road falls first (they are the rarer kind)
  const nearC = cands.filter((c) => c.rd < 400 && c.above > 70 && c.above < 260 && c.toRoad && c.z > -900 && c.z < 650)
    .sort((a, b) => b.steep - a.steep);
  for (const c of nearC) { if (pick.length >= near) break; if (far(c, 700)) pick.push({ ...c, kind: 'near' }); }
  const bigC = cands.filter((c) => c.y > 420 && c.steep > 180).sort((a, b) => (b.steep - b.rd * 0.05) - (a.steep - a.rd * 0.05));
  const nNear = pick.length;
  for (const c of bigC) {
    if (pick.length >= nNear + big) break;
    if (!far(c, 420)) continue;
    if (pick.filter((p) => p.kind === 'big' && p.side === c.side).length >= Math.ceil(big / 2) + 1) continue;
    pick.push({ ...c, kind: 'big' });
  }
  return pick;
}

function buildFallGeo(world, td, falls) {
  const pos = [], nrm = [], dat = [], dat2 = [], off = [], idx = [];
  const mist = [];
  const rnd = mulberry32(77);
  const n = new THREE.Vector3();
  falls.forEach((f, fi) => {
    const P = f.pts, total = P.length;
    const bigF = f.kind === 'big';
    // mountain falls are threads: ~1 m at the lip, spreading to a few metres of spray lower down
    const WK = { big: [0.9 + rnd() * 0.6, 3.2 + rnd() * 1.6], near: [1.2 + rnd() * 0.6, 3.5 + rnd() * 1.5], hairpin: [8, 12], gorge: [3.6, 5.5] }[f.kind] || [4, 8];
    const w0 = WK[0], w1 = WK[1];
    // two ribbons: the water curtain, and a wide soft spray halo around the steep parts
    for (const halo of f.kind === 'big' ? [false, true] : [false]) {
      let arc = 0;
      const base = pos.length / 3;
      for (let i = 0; i < total; i++) {
        const p = P[i], pa = P[Math.max(0, i - 1)], pb = P[Math.min(total - 1, i + 1)];
        let dx = pb[0] - pa[0], dz = pb[2] - pa[2]; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const lx = -dz, lz = dx;
        if (i > 0) arc += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1], p[2] - P[i - 1][2]);
        const steep = clamp(((pa[1] - pb[1]) / (Math.hypot(pb[0] - pa[0], pb[2] - pa[2]) || 1) - 0.35) / 0.6, 0, 1);
        td.normalAt(p[0], p[2], n);
        const t = i / (total - 1);
        const thread = bigF || f.kind === 'near';
        let w = thread ? lerp(w0, w1, smoothstep(0, 1, t)) * lerp(0.7, 1, steep) : lerp(w0, w1, smoothstep(0, 0.4, t)) * lerp(0.28, 1, steep);
        if (halo) w *= 3.2;
        for (let s = -1; s <= 1; s += 2) {
          pos.push(p[0] + lx * w * 0.5 * s, p[1], p[2] + lz * w * 0.5 * s);
          off.push(lx * w * 0.5 * s, 0, lz * w * 0.5 * s);
          nrm.push(n.x, n.y, n.z);
          dat.push(s, arc, steep, halo ? -(fi + 1) * 17.31 : (fi + 1) * 17.31);
          dat2.push(t, thread ? 1 : 0);
        }
        if (i > 0) { const a = base + (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        if (!halo) {
          const nextSteep = i + 2 < total ? (P[i][1] - P[i + 2][1]) / 6 : 0;
          if (steep > 0.6 && nextSteep < 0.3 && i > 3) mist.push([p[0], p[1], p[2], w * 3.2, 0.8]);
        }
      }
    }
    const e = P[total - 1];
    for (let k = 0; k < 3; k++) mist.push([e[0] + (rnd() - 0.5) * w1, e[1] + k * w1 * 0.5, e[2] + (rnd() - 0.5) * w1, w1 * (3.4 - k * 0.6), 1.4 - k * 0.3]);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFall', new THREE.Float32BufferAttribute(dat, 4));
  g.setAttribute('aFallT', new THREE.Float32BufferAttribute(dat2, 2));
  g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const M = [];
  for (const m of mist) if (M.every((q) => Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2]) > 12)) M.push(m);
  return { geo: g, mist: M };
}

const FALL_VERT = /* glsl */ `
attribute vec4 aFall;   // side (-1/1), arc (m), steepness 0..1, seed
attribute vec2 aFallT;  // progress down the fall 0..1, thread (1 = thin mountain fall)
attribute vec3 aOff;    // lateral offset of this vertex from the centre line
varying vec4 vFall;
varying vec3 vFallT;
varying vec3 vWP;
varying vec3 vN;
void main() {
  vFall = aFall;
  vec3 p = position;
  float d = distance(cameraPosition, p);
  // thin threads never get thinner than ~1.5 px: widen far away, fade alpha by the same factor
  float wm = length(aOff) * 2.0 + 1e-3;
  float k = aFallT.y > 0.5 ? max(1.0, d * 0.0011 / wm) : 1.0;
  p += aOff * (k - 1.0);
  vFallT = vec3(aFallT, 1.0 / k);
  // stand off the wall: more on steep drops (free fall) and at distance (coarse terrain LOD)
  p += normal * (0.9 + aFall.z * 1.6 + d * 0.0045 + (aFall.w < 0.0 ? 1.2 : 0.0));
  vN = normal;
  vWP = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

function fallFrag(td) {
  return /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
uniform float uTime;
uniform vec3 uSunCol;
varying vec4 vFall;
varying vec3 vFallT;
varying vec3 vWP;
varying vec3 vN;
void main() {
  float u = vFall.x, arc = vFall.y, steep = vFall.z, seed = abs(vFall.w);
  float tt = vFallT.x;
  bool thread = vFallT.y > 0.5;
  bool halo = vFall.w < 0.0;
  float t = uTime;
  float spd = mix(2.5, 9.0, steep);
  float s1 = tgn(vec2(u * 3.2 + seed, arc * 0.05 - t * spd * 0.05));
  float s2 = tgn(vec2(u * 9.0 + seed * 1.7, arc * 0.16 - t * spd * 0.16));
  float s3 = tgn(vec2(u * 22.0 + seed * 0.3, arc * 0.5 - t * spd * 0.5));
  float streak = s1 * 0.45 + s2 * 0.35 + s3 * 0.2;
  float dist = length(cameraPosition - vWP);
  float fall = smoothstep(0.12, 0.55, steep);
  float body = smoothstep(0.2, 0.65, streak);
  float a;
  if (halo) {
    // soft white spray veil around the falling water
    float r = abs(u);
    a = pow(1.0 - r, 2.0) * fall * (0.16 + 0.1 * tgn(vec2(u * 2.0 + seed, arc * 0.03 - t * 0.4)));
    a *= mix(1.0, 1.6, smoothstep(400.0, 1800.0, dist));
    if (thread) a *= (0.25 + 0.75 * smoothstep(0.25, 0.9, tt)) * vFallT.z;
  } else if (thread) {
    // Mountain fall seen across the valley: white only where it leaps down a step or a steep
    // chute; in between it hides in its gully as a faint wet line. A narrow jet at the lip that
    // frays into streaks and drifting spray lower down.
    float seg = tgn(vec2(arc * 0.024 + seed, seed * 0.7)) * 0.7 + tgn(vec2(arc * 0.07 + seed * 1.3, 2.0)) * 0.3;
    float cascade = smoothstep(0.42, 0.62, seg * 0.75 + steep * 0.3) * smoothstep(0.15, 0.4, steep);
    float edge = 1.0 - smoothstep(0.2, 1.0, abs(u) * (1.0 + 0.6 * smoothstep(0.3, 1.0, tt)) + (s2 - 0.5) * 0.55);
    float fray = mix(1.0, 0.35 + 0.65 * body, smoothstep(0.15, 0.8, tt));
    a = edge * cascade * fray * mix(0.9, 0.5, smoothstep(0.55, 1.0, tt));
    a = max(a, edge * 0.1 * (1.0 - cascade));
    a *= mix(1.0, vFallT.z, 0.85);
  } else {
    // Big set-piece falls: aerated white streaks with see-through gaps (the wet rock shows
    // between them), a glassier, more coherent sheet at the lip, dissolving into spray below.
    float wmod = 0.62 + 0.38 * tgn(vec2(arc * 0.025 + seed, seed * 0.3));
    float edge = 1.0 - smoothstep(0.35 * wmod, wmod, abs(u) + (s2 - 0.5) * 0.5);
    float s4 = tgn(vec2(u * 46.0 + seed * 2.1, arc * 0.9 - t * spd * 0.9));
    float strk = smoothstep(0.25, 0.8, streak * 0.75 + s4 * 0.25);
    float lip = 1.0 - smoothstep(0.02, 0.14, tt);
    float foot = smoothstep(0.7, 1.0, tt);
    a = edge * mix(mix(0.5, 0.85, strk), mix(0.28, 0.97, strk), fall);
    a = mix(a, edge * 0.9, lip * 0.6);
    a *= 1.0 - foot * (0.55 - 0.35 * strk);
    a = mix(a, edge * mix(0.6, 0.95, fall) * (0.8 + 0.2 * body), smoothstep(350.0, 1400.0, dist));   // solid when far
  }
  if (a < 0.01) discard;
  float vis = terrSunVis(vWP.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  float lam = max(dot(normalize(vN), uSunDir), 0.0);
  vec3 alb = mix(vec3(0.12, 0.18, 0.21) + vec3(0.55) * smoothstep(0.6, 0.9, streak), vec3(0.95, 0.97, 0.98) * mix(0.85, 1.05, body), halo ? 1.0 : fall);
  // falling water scatters light in all directions: mostly view independent, never dark
  if (thread) alb *= 0.82;
  else if (!halo) {
    float strk2 = smoothstep(0.3, 0.85, streak);
    alb = mix(vec3(0.3, 0.36, 0.37), vec3(0.96, 0.97, 0.98), mix(0.35, 1.0, strk2) * mix(0.55, 1.0, fall));
    alb = mix(alb, vec3(0.42, 0.5, 0.46), (1.0 - smoothstep(0.02, 0.12, tt)) * 0.45);    // glassy green lip
  }
  vec3 col = alb * (uSunCol * vis * (0.45 + 0.55 * lam) * 0.3 + skyUp * 1.15);
  col = applyHeightFog(col, vWP);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

const MIST_VERT = /* glsl */ `
attribute vec4 aMist;   // xyz base, size
attribute float aK;     // strength
uniform float uTime;
varying vec2 vUv;
varying vec3 vWP;
varying float vK;
void main() {
  vUv = uv;
  vK = aK;
  float s = aMist.w * (1.0 + 0.15 * sin(uTime * 0.7 + aMist.x));
  vec3 c = aMist.xyz + vec3(0.0, s * 0.35, 0.0);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = c + (camR * position.x + camU * position.y) * s;
  vWP = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
function mistFrag(td) {
  return /* glsl */ `
${FOG_PARS_GLSL}
${td.GLSL}
uniform float uTime;
uniform vec3 uSunCol;
varying vec2 vUv;
varying vec3 vWP;
varying float vK;
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float n = tgn(q * 4.0 + vec2(uTime * 0.15, -uTime * 0.3) + vWP.xz * 0.1) * 0.6 + tgn(q * 9.0 - uTime * 0.4) * 0.4;
  float a = pow(1.0 - smoothstep(0.0, 1.0, r + (n - 0.5) * 0.6), 1.5) * 0.26 * vK;
  if (a < 0.005) discard;
  float vis = terrSunVis(vWP.xz);
  vec3 skyUp = fogColorDir(vec3(0.0, 1.0, 0.0));
  vec3 col = vec3(0.9) * (uSunCol * vis * 0.22 + skyUp * 0.9);
  col = applyHeightFog(col, vWP);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
}

/* ================================================================ module */
export function createFjordWater(ctx) {
  const { scene, world, uniforms: U, camera } = ctx;
  const t0 = performance.now();
  const td = getTerrainData(ctx);
  const group = new THREE.Group();
  group.name = 'fjordWater';
  const mats = [], geos = [];

  const envDefines = (tex) => {
    const hgt = tex?.image?.height || 1024;
    const maxMip = Math.log2(hgt) - 2;
    return {
      ENVMAP_TYPE_CUBE_UV: '',
      CUBEUV_TEXEL_WIDTH: (1 / (3 * Math.max(2 ** maxMip, 7 * 16))).toFixed(8),
      CUBEUV_TEXEL_HEIGHT: (1 / hgt).toFixed(8),
      CUBEUV_MAX_MIP: maxMip.toFixed(1),
    };
  };
  const envU = { envMap: { value: null }, uEnvI: { value: 1 } };
  const envMats = [];
  const common = () => ({ ...fogUniforms(), ...td.uniforms, ...envU, ...ssrUniforms, uTime: U.uTime, uRain: U.uRain, uSunCol: U.uSunCol, uWind: U.uWind });

  /* ---- sea (disc that follows the camera) */
  const seaMat = new THREE.ShaderMaterial({
    vertexShader: SURF_VERT, fragmentShader: seaFrag(td), uniforms: { ...common(), uCalm: { value: 0 } },
    transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const seaGeo = new THREE.CircleGeometry(8900, 96).rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.frustumCulled = false;
  sea.renderOrder = 1;
  sea.name = 'sea';
  seaGeo.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array(seaGeo.attributes.position.count * 4), 4));
  group.add(sea);
  mats.push(seaMat); envMats.push(seaMat); geos.push(seaGeo);

  /* ---- tarns on the plateau */
  const lk = findLakes(world, td);
  let lakes = null;
  if (lk) {
    const lakeMat = new THREE.ShaderMaterial({
      vertexShader: SURF_VERT, fragmentShader: seaFrag(td), uniforms: { ...common(), uCalm: { value: 1 } },
      transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    lakes = new THREE.Mesh(lk.geo, lakeMat);
    lakes.renderOrder = 1;
    lakes.name = 'tarns';
    group.add(lakes);
    mats.push(lakeMat); envMats.push(lakeMat); geos.push(lk.geo);
  }

  /* ---- set-piece streams: canyon stream, hairpin-fall outflow (under the road) */
  const F = FEATURES, GO = F.gorge, HF = F.hairpinFall;
  const extras = [];
  {
    const L = Math.hypot(GO.bx - GO.ax, GO.bz - GO.az), pts = [];
    for (let s = 3; s <= L; s += 3) {
      const t = s / L;
      pts.push({ x: GO.ax + (GO.bx - GO.ax) * t, z: GO.az + (GO.bz - GO.az) * t, y: td.gorge.levelAt(t), hw: lerp(2.6, 3.4, t) });
    }
    extras.push({ pts, across: 7 });
    // plunge pool at the canyon head
    const pl = [];
    for (let k = -3; k <= 3; k++) pl.push({ x: GO.ax + k * 1.4 * (GO.bx - GO.ax) / L, z: GO.az + k * 1.4 * (GO.bz - GO.az) / L, y: td.gorge.levelAt(0) + 0.05, hw: 4.8 });
    extras.push({ pts: pl, across: 7 });
    // outflow of the hairpin plunge pool: from the lip (lowest rim point) down past the road
    const PP = td.hairpinPool;
    let best = null;
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      const x = PP.x + Math.cos(a) * (PP.r + 3), z = PP.z + Math.sin(a) * (PP.r + 3), h = td.heightAt(x, z);
      if (!best || h < best.h) best = { x, z, h };
    }
    // (no outflow ribbon: a flat ribbon cannot follow the talus slope convincingly)
    void best;
  }

  /* ---- river */
  const rGeo = buildRiverGeo(world, td, extras);
  const riverMat = new THREE.ShaderMaterial({
    vertexShader: SURF_VERT, fragmentShader: riverFrag(td), uniforms: { ...common(), uZEnd: { value: td.river.z1 } },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const river = new THREE.Mesh(rGeo, riverMat);
  river.renderOrder = 2;
  river.name = 'river';
  group.add(river);
  mats.push(riverMat); envMats.push(riverMat); geos.push(rGeo);

  /* ---- waterfalls + spray */
  const falls = findWaterfalls(world, td, { big: 6, near: 2 });
  // designed falls: the 111 m hairpin fall and the Svartifoss-style canyon-head fall
  const linePts = (a, b, n, lift = 0) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      out.push([x, Math.max(td.heightAt(x, z), b.y) + lift * (1 - t), z]);
    }
    return out;
  };
  {
    // the water finds its own way: steepest descent from the lip — a free drop down the
    // basalt face, then cascades over the talus into the plunge pool
    const hp = [];
    {
      const PP = td.hairpinPool, h = td.heightAt;
      // lip: the point on the basalt wall above the pool with the biggest sheer drop toward
      // the road (so the fall faces the hairpin), searched along the cliff top
      let x = HF.top.x, z = HF.top.z, bestScore = -1e9;
      for (let zz = HF.top.z; zz <= PP.z + 25; zz += 3) for (let xx = PP.x + 15; xx <= PP.x + 80; xx += 2) {
        const top = h(xx, zz), foot = h(xx - 12, zz);
        const drop = top - foot;
        if (drop < 40 || h(xx + 6, zz) < top - 3) continue;       // must be the lip, not mid-face
        const score = drop - Math.abs(zz - PP.z) * 1.2 - Math.abs(xx - PP.x) * 0.3;
        if (score > bestScore) { bestScore = score; x = xx + 1; z = zz; }
      }
      for (let i = 0; i < 120; i++) {
        hp.push([x, h(x, z), z]);
        if (Math.hypot(x - PP.x, z - PP.z) < PP.r * 0.9) break;
        const e = 2, gx = (h(x + e, z) - h(x - e, z)) / (2 * e), gz = (h(x, z + e) - h(x, z - e)) / (2 * e), gl = Math.hypot(gx, gz);
        // steer gently toward the pool so the path cannot wander off the talus
        let dx = -gx / (gl || 1), dz = -gz / (gl || 1);
        const px = PP.x - x, pz = PP.z - z, pl = Math.hypot(px, pz) || 1;
        const k = gl < 0.3 ? 0.8 : 0.25;
        dx = dx * (1 - k) + (px / pl) * k; dz = dz * (1 - k) + (pz / pl) * k;
        const dl = Math.hypot(dx, dz) || 1;
        x += (dx / dl) * 1.5; z += (dz / dl) * 1.5;
      }
    }
    falls.push({ kind: 'hairpin', x: HF.top.x, z: HF.top.z, y: HF.top.y, rd: world.roadDistAt(HF.top.x, HF.top.z), pts: hp });
    const L = Math.hypot(GO.bx - GO.ax, GO.bz - GO.az), ux = (GO.bx - GO.ax) / L, uz = (GO.bz - GO.az) / L;
    const lip = { x: GO.ax - ux * 25, z: GO.az - uz * 25 };
    const gp = linePts(lip, { x: GO.ax + ux * 2, y: td.gorge.levelAt(0), z: GO.az + uz * 2 }, 40);
    falls.push({ kind: 'gorge', x: lip.x, z: lip.z, y: GO.headTop, rd: world.roadDistAt(lip.x, lip.z), pts: gp });
  }
  const fb = buildFallGeo(world, td, falls);
  const fallMat = new THREE.ShaderMaterial({
    vertexShader: FALL_VERT, fragmentShader: fallFrag(td), uniforms: { ...fogUniforms(), ...td.uniforms, uTime: U.uTime, uSunCol: U.uSunCol },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const fallMesh = new THREE.Mesh(fb.geo, fallMat);
  fallMesh.renderOrder = 3;
  fallMesh.name = 'waterfalls';
  group.add(fallMesh);
  mats.push(fallMat); geos.push(fb.geo);

  const mq = new THREE.PlaneGeometry(1, 1);
  const mistGeo = new THREE.InstancedBufferGeometry();
  mistGeo.index = mq.index;
  mistGeo.setAttribute('position', mq.attributes.position);
  mistGeo.setAttribute('uv', mq.attributes.uv);
  const md = new Float32Array(fb.mist.length * 4), mk = new Float32Array(fb.mist.length);
  fb.mist.forEach((m, i) => { md.set([m[0], m[1], m[2], m[3]], i * 4); mk[i] = m[4]; });
  mistGeo.setAttribute('aMist', new THREE.InstancedBufferAttribute(md, 4));
  mistGeo.setAttribute('aK', new THREE.InstancedBufferAttribute(mk, 1));
  mistGeo.instanceCount = fb.mist.length;
  const mistMat = new THREE.ShaderMaterial({
    vertexShader: MIST_VERT, fragmentShader: mistFrag(td), uniforms: { ...fogUniforms(), ...td.uniforms, uTime: U.uTime, uSunCol: U.uSunCol },
    transparent: true, depthWrite: false,
  });
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.frustumCulled = false;
  mist.renderOrder = 4;
  group.add(mist);
  mats.push(mistMat); geos.push(mistGeo, mq);

  /* ---- mirror lake, hot spring, steam / spray particles */
  const lake = createMirrorLake(ctx, td, common(), ENV_GLSL, RIPPLE_GLSL);
  group.add(lake.mesh);
  mats.push(lake.mat); envMats.push(lake.mat);
  const hot = createHotPool(ctx, td, common(), ENV_GLSL);
  const hfLip = falls.find((f) => f.kind === 'hairpin').pts[0];
  // water surface sits below the lowest point of the rim, so no edge ever hangs in the air
  const PPool = td.hairpinPool;
  let rimMin = Infinity;
  for (let a = 0; a < Math.PI * 2; a += 0.05) for (const k of [0.9, 1.0, 1.1]) rimMin = Math.min(rimMin, td.heightAt(PPool.x + Math.cos(a) * PPool.r * k, PPool.z + Math.sin(a) * PPool.r * k));
  const poolLevel = Math.min(PPool.level, rimMin - 0.25);
  const plunge = createPlungePool(ctx, td, common(), ENV_GLSL, { ...PPool, level: poolLevel, r: PPool.r * 0.92 }, hfLip);
  group.add(plunge.mesh); envMats.push(plunge.mesh.material);
  for (const m of hot.meshes) { group.add(m); envMats.push(m.material); }
  const roadNear = world.path.pointAt(world.path.nearestS(td.hairpinPool.x, td.hairpinPool.z));
  const toRoad = [roadNear.x - td.hairpinPool.x, roadNear.z - td.hairpinPool.z], trl = Math.hypot(...toRoad);
  // where the free drop hits the talus (first point below the cliff foot)
  const hfFall = falls.find((f) => f.kind === 'hairpin');
  const hairpinImpact = hfFall.pts.find((p, i) => i > 2 && hfFall.pts[i - 1][1] - p[1] < 1.2) || hfFall.pts[Math.floor(hfFall.pts.length / 2)];
  const Lg = Math.hypot(GO.bx - GO.ax, GO.bz - GO.az);
  const emitters = [
    ...hot.vents.map((v) => ({
      count: v.big ? 15 : 8, kind: 0, rise: v.big ? 22 : 13, life: v.big ? 8 : 6, size0: v.big ? 2.5 : 1.5, size1: v.big ? 11 : 7, alpha: v.big ? 0.32 : 0.26,
      spawn: (r) => [v.x + (r() - 0.5) * 1.2, v.y + 0.3, v.z + (r() - 0.5) * 1.2],
    })),
    { count: 16, kind: 0, rise: 4, life: 6, size0: 2, size1: 6, alpha: 0.2,
      spawn: (r) => { const a = r() * 6.283, d = Math.sqrt(r()) * F.geothermal.pool.r; return [F.geothermal.pool.x + Math.cos(a) * d, F.geothermal.pool.level + 0.3, F.geothermal.pool.z + Math.sin(a) * d]; } },
    // hairpin fall: spray billowing out of the pool and drifting across the road (rainbow)
    { count: 46, kind: 1, rise: 6, life: 9, size0: 3, size1: 8, alpha: 0.055,
      spawn: (r) => { const a = r() * 6.283, d = Math.sqrt(r()) * 7; return [td.hairpinPool.x + Math.cos(a) * d, td.hairpinPool.level + 0.5 + r() * 3, td.hairpinPool.z + Math.sin(a) * d]; },
      drift: (r) => { const k = 12 + r() * 26; return [(toRoad[0] / trl) * k + (r() - 0.5) * 10, (toRoad[1] / trl) * k + (r() - 0.5) * 10]; } },
    { count: 18, kind: 1, rise: 8, life: 8, size0: 3, size1: 9, alpha: 0.05,
      spawn: (r) => { const p = hairpinImpact; return [p[0] + (r() - 0.5) * 6, p[1] + r() * 4, p[2] + (r() - 0.5) * 6]; },
      drift: (r) => [(toRoad[0] / trl) * 6, (toRoad[1] / trl) * 6] },
    // canyon-head fall spray
    { count: 24, kind: 1, rise: 10, life: 8, size0: 3, size1: 8, alpha: 0.2,
      spawn: (r) => [GO.ax + (r() - 0.5) * 6, td.gorge.levelAt(0) + r() * 3, GO.az + (r() - 0.5) * 6],
      drift: (r) => { const k = 6 + r() * 14; return [((GO.bx - GO.ax) / Lg) * k, ((GO.bz - GO.az) / Lg) * k]; } },
  ];
  const parts = createParticles(ctx, td, emitters);
  group.add(parts.mesh);

  scene.add(group);

  const info = {
    waterfalls: falls.map((f) => ({ kind: f.kind, x: Math.round(f.x), z: Math.round(f.z), top: Math.round(f.y), drop: Math.round(f.pts[0][1] - f.pts[f.pts.length - 1][1]), roadDist: Math.round(f.rd) })),
    lakes: lk?.lakes || [],
    particles: parts.count,
    river: { z0: td.river.z0, z1: td.river.z1 },
  };
  console.info(`[fjord water] ${Math.round(performance.now() - t0)} ms`, info);

  let envTex = null;
  return {
    group, info,
    update() {
      sea.position.set(Math.round(camera.position.x / 64) * 64, 0, Math.round(camera.position.z / 64) * 64);
      sea.updateMatrixWorld();
      const env = scene.environment;
      if (env && env !== envTex) {
        const first = !envTex || env.image?.height !== envTex.image?.height;
        envTex = env;
        envU.envMap.value = env;
        if (first) for (const m of envMats) { m.defines = { ...m.defines, ...envDefines(env) }; m.needsUpdate = true; }
      }
      envU.uEnvI.value = scene.environmentIntensity ?? 1;
    },
    dispose() {
      scene.remove(group);
      mats.forEach((m) => m.dispose());
      geos.forEach((g) => g.dispose());
      lake.dispose(); hot.dispose(); parts.dispose(); plunge.dispose();
    },
  };
}
