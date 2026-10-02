// GLSL for the rain system (WebGL2 / GLSL ES 3.00 via three's ShaderMaterial).
// Everything is driven by uTime + per-instance seeds in the vertex shader:
// no per-frame JS work per drop.
import { FOG_PARS_GLSL } from '../render/fog.js';

/* ------------------------------------------------------------------ common */
// Prepended to every vertex shader. Needs: aSeed (instanced vec4 random), position.xy = quad corner.
const VERT_COMMON = /* glsl */ `
${FOG_PARS_GLSL}
uniform float uTime;
uniform vec2 uDrift;      // integrated wind displacement (m), wrapped to 40 m
uniform vec2 uWindVel;    // horizontal drop drift velocity (m/s)
uniform float uRainAmt;   // 0..1
uniform float uPixel;     // world size of one pixel at distance 1 m
uniform vec3 uSunCol;
uniform sampler2D uEnv;   // RGBA16F: r = ground height, g = canopy density, b = water distance
uniform vec2 uGrid;       // x = half extent (m), y = texels per side
attribute vec4 aSeed;

vec4 envAt(vec2 xz) {
  // grid covers [-half, half]² with uGrid.y texels per side (any spacing)
  return texture2D(uEnv, ((xz + uGrid.x) * (uGrid.y - 1.0) / (2.0 * uGrid.x) + 0.5) / uGrid.y);
}

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
vec3 hash3(uint k) {
  uint a = pcg(k);
  uint b = pcg(a ^ 0x9e3779b9u);
  uint c = pcg(b ^ 0x85ebca6bu);
  return vec3(float(a), float(b), float(c)) * (1.0 / 4294967296.0);
}
uint cycleKey(uint k, float n) {
  return k ^ (uint(n) * 2654435761u + 1013904223u);
}
`;

/* ------------------------------------------------------------ rain streaks */
export const STREAK_VERT = /* glsl */ `
${VERT_COMMON}
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;

const vec3 VSIZE = vec3(40.0, 28.0, 40.0);
const vec3 VLO = vec3(-20.0, -12.0, -20.0);

void hideVertex() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(0.0); vCol = vec3(0.0); vAlpha = 0.0;
}

void main() {
  vec2 cn = position.xy;                       // x: -1..1 across, y: 0 (head) .. 1 (tail)
  uint k = floatBitsToUint(aSeed.w);
  vec3 h = hash3(k);
  vec3 g = hash3(k + 7u);

  float fall = 8.0 + 3.5 * h.x + 1.5 * uRainAmt;
  vec3 vel = vec3(uWindVel.x, -fall, uWindVel.y);
  vec3 dn = normalize(vel);                    // direction of motion (downwards)

  // world-anchored lattice of drops wrapped around the camera
  vec3 pw = aSeed.xyz * VSIZE + vec3(uDrift.x, -fall * uTime, uDrift.y);
  vec3 rel = mod(pw - cameraPosition - VLO, VSIZE) + VLO;
  vec3 P = cameraPosition + rel;
  float dist = max(length(rel), 1e-3);

  vec4 env = envAt(P.xz);
  float canopy = env.g;

  float L = 0.30 + 0.34 * h.y;
  bool blur = h.z > 0.90 && dist < 8.0;        // near motion-blurred streaks
  if (blur) L *= 2.3;

  vec3 head = P + dn * (0.5 * L);
  // hidden below ground, or intercepted by canopy
  if (head.y < env.r + 0.02 || g.x > 1.0 - 0.8 * canopy) { hideVertex(); return; }

  // width with a one-pixel floor; thin far drops fade instead of aliasing
  float w0 = 0.0042 + 0.003 * h.x;
  float w = max(w0, uPixel * dist * 1.1);
  float cov = w0 / w;

  vec3 q = (rel - VLO) / VSIZE;
  float edge = smoothstep(0.0, 0.15, q.x) * smoothstep(1.0, 0.85, q.x)
             * smoothstep(0.0, 0.15, q.z) * smoothstep(1.0, 0.85, q.z)
             * smoothstep(0.0, 0.12, q.y) * smoothstep(1.0, 0.88, q.y);
  float nearFade = smoothstep(0.35, 1.6, dist);
  float T = exp(-fogOpticalDepth(uCamPos, P));
  float amt = mix(0.55, 1.0, uRainAmt);
  vAlpha = 0.34 * cov * edge * nearFade * T * amt * (blur ? 0.55 : 1.0);

  // back-lit: bright when looking toward the light
  vec3 rd = rel / dist;
  float mu = max(dot(rd, uSunDir), 0.0);
  vec3 col = mix(fogColorDir(rd), uFogHigh, 0.5) * 1.1 + uSunCol * (0.16 * pow(mu, 10.0) + 0.02 * pow(mu, 3.0));
  vCol = col * mix(1.0, 0.65, canopy);

  vec3 toCam = -rel / dist;
  vec3 side = cross(dn, toCam);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
  vec3 pos = P + side * (cn.x * 0.5 * w) - dn * ((cn.y - 0.5) * L);
  vUv = cn;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

export const STREAK_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  float across = max(1.0 - vUv.x * vUv.x, 0.0); // MSAA can extrapolate |x|>1 → keep sqrt finite
  float along = smoothstep(0.0, 0.10, vUv.y) * max(1.0 - 0.85 * vUv.y, 0.0);
  float a = across * sqrt(across) * along * vAlpha;
  gl_FragColor = vec4(vCol, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ----------------------------------------------------------- ground splash */
// Shared by the ring (flat quad) and crown (vertical billboard) shaders.
const SPLASH_FN = /* glsl */ `
const float SPLASH_DUR = 0.30;
const float SPLASH_SIZE = 30.0;

// Returns false when this instance is idle / hidden this cycle.
bool splashAt(out vec3 gp, out float u, out vec3 rr, out vec3 r2, out float big, out float fade) {
  uint k = floatBitsToUint(aSeed.w);
  vec3 h = hash3(k);
  float per = 0.5 + 0.7 * h.x;
  float ph = uTime / per + h.y * 64.0;
  float n = floor(ph);
  u = (ph - n) * per / SPLASH_DUR;
  if (u >= 1.0) return false;
  uint ck = cycleKey(k, n);
  rr = hash3(ck);
  r2 = hash3(ck + 11u);
  vec2 rel = mod(rr.xy * SPLASH_SIZE - cameraPosition.xz + 0.5 * SPLASH_SIZE, SPLASH_SIZE) - 0.5 * SPLASH_SIZE;
  fade = smoothstep(15.0, 9.0, length(rel));
  vec2 xz = cameraPosition.xz + rel;
  vec4 env = envAt(xz);
  if (env.b < 0.05) return false;               // water surface: the water module owns ripples
  float c = env.g;
  if (rr.z > 1.0 - 0.6 * c) return false;       // canopy intercepts part of the rain
  big = c * (0.4 + 0.6 * r2.z);                 // under trees: fewer but larger drops
  gp = vec3(xz, env.r);
  return fade > 0.002;
}
`;

export const RING_VERT = /* glsl */ `
${VERT_COMMON}
${SPLASH_FN}
varying vec2 vUv;
varying float vU;
varying float vFade;
varying vec3 vWorld;

void main() {
  vec3 gp, rr, r2; float u, big, fade;
  if (!splashAt(gp, u, rr, r2, big, fade)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vU = 1.0; vFade = 0.0; vWorld = vec3(0.0); return; }
  vec2 cn = position.xy;                         // -1..1
  float R = (0.13 + 0.10 * r2.x) * (1.0 + 0.8 * big) * (0.75 + 0.5 * uRainAmt);
  vec2 d = cn * R;
  // tilt the quad onto the local ground plane
  float hx = envAt(gp.xz + vec2(0.5, 0.0)).r - envAt(gp.xz - vec2(0.5, 0.0)).r;
  float hz = envAt(gp.xz + vec2(0.0, 0.5)).r - envAt(gp.xz - vec2(0.0, 0.5)).r;
  vec3 pos = vec3(gp.x + d.x, gp.y + 0.04 + hx * d.x + hz * d.y, gp.z + d.y);
  vUv = cn; vU = u; vFade = fade; vWorld = pos;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

export const RING_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
uniform vec3 uSunCol;
varying vec2 vUv;
varying float vU;
varying float vFade;
varying vec3 vWorld;
void main() {
  float d = length(vUv);
  float r = 0.10 + 0.90 * (1.0 - (1.0 - vU) * (1.0 - vU));
  float thick = mix(0.13, 0.07, vU);
  float rq = (d - r) / thick;
  float ring = exp(-rq * rq) * smoothstep(1.0, 0.8, d);
  float life = pow(max(1.0 - vU, 0.0), 1.3);
  float a = ring * life * 0.50;
  a += exp(-d * d * 70.0) * max(0.0, 1.0 - vU * 3.5) * 0.45;   // impact flash
  a *= vFade;
  if (a < 0.003) discard;

  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 refl = normalize(vec3(rd.x, abs(rd.y) + 0.05, rd.z));    // ripples mirror the sky
  float mu = max(dot(refl, uSunDir), 0.0);
  vec3 col = fogColorDir(refl) * 0.95 + uSunCol * 0.10 * pow(mu, 12.0);
  col = applyHeightFog(col, vWorld);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CROWN_VERT = /* glsl */ `
${VERT_COMMON}
${SPLASH_FN}
varying vec2 vUv;
varying float vU;
varying float vFade;
varying vec3 vWorld;
varying vec2 vRnd;
varying vec2 vSize;

void main() {
  vec3 gp, rr, r2; float u, big, fade;
  if (!splashAt(gp, u, rr, r2, big, fade)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vU = 1.0; vFade = 0.0; vWorld = vec3(0.0); vRnd = vec2(0.0); vSize = vec2(1.0); return; }
  vec2 cn = position.xy;                         // x -1..1, y 0..1
  float s = (0.8 + 0.5 * r2.y) * (1.0 + 0.6 * big) * (0.8 + 0.4 * uRainAmt);
  float hw = 0.15 * s, hh = 0.24 * s;
  vec3 toCam = cameraPosition - gp;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
  vec3 pos = gp + right * (cn.x * hw) + vec3(0.0, 0.02 + cn.y * hh, 0.0);
  vUv = cn; vU = u; vFade = fade; vWorld = pos; vRnd = r2.xz; vSize = vec2(hw, hh);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

export const CROWN_FRAG = /* glsl */ `
${FOG_PARS_GLSL}
uniform vec3 uSunCol;
uniform float uPixel;
varying vec2 vUv;
varying float vU;
varying float vFade;
varying vec3 vWorld;
varying vec2 vRnd;
varying vec2 vSize;
void main() {
  float dist = length(vWorld - cameraPosition);
  float rad = max(0.0065 * (1.0 - 0.45 * vU), uPixel * dist * 0.7);
  float cov = min(1.0, 0.0065 / rad);
  float a = 0.0;
  for (int i = 0; i < 7; i++) {
    float f = float(i);
    float rk = fract(sin((f + 1.0) * 12.9898 + vRnd.x * 78.233) * 43758.5453);
    float ang = (f / 6.0 - 0.5) * 1.7 + (rk - 0.5) * 0.35;
    float sp = 0.6 + 0.6 * fract(rk * 7.31 + vRnd.y);
    vec2 pos = vec2(sin(ang) * sp * 0.85 * vU, cos(ang) * sp * 1.3 * vU * (1.0 - vU));
    float dd = length((vUv - pos) * vSize);
    a += smoothstep(rad, rad * 0.35, dd);
  }
  a = min(a, 1.0) * cov * pow(max(1.0 - vU, 0.0), 0.6) * 0.8 * vFade;
  if (a < 0.004) discard;

  vec3 rd = normalize(vWorld - cameraPosition);
  float mu = max(dot(rd, uSunDir), 0.0);
  vec3 col = fogColorDir(rd) * 1.1 + uSunCol * (0.30 * pow(mu, 6.0) + 0.03);
  col = applyHeightFog(col, vWorld);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------- canopy drip drops */
export const DRIP_VERT = /* glsl */ `
${VERT_COMMON}
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;

const float VT = 6.5;    // terminal speed (m/s)
const float GR = 9.8;
const float DRIP_SIZE = 36.0;

void main() {
  vec2 cn = position.xy;                         // x -1..1, y 0 (head) .. 1 (tail)
  vUv = cn; vCol = vec3(0.0); vAlpha = 0.0;
  uint k = floatBitsToUint(aSeed.w);
  vec3 h = hash3(k);
  float per = 4.6 + 3.4 * h.x;
  float ph = uTime / per + h.y * 64.0;
  float n = floor(ph);
  float age = (ph - n) * per;
  uint ck = cycleKey(k, n);
  vec3 rr = hash3(ck);
  vec3 r2 = hash3(ck + 11u);

  vec2 rel = mod(rr.xy * DRIP_SIZE - cameraPosition.xz + 0.5 * DRIP_SIZE, DRIP_SIZE) - 0.5 * DRIP_SIZE;
  vec2 xz = cameraPosition.xz + rel;
  vec4 env = envAt(xz);
  float c = env.g;
  // drips only form under dense canopy
  if (rr.z > smoothstep(0.30, 0.65, c) * 0.9) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float H = 9.0 + 14.0 * r2.x;                   // release height above ground
  float tau = VT / GR;
  float Tf = tau * acosh(exp(H * GR / (VT * VT)));
  if (age > Tf) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float y = env.r + H - (VT * VT / GR) * log(cosh(age / tau));
  float v = VT * tanh(age / tau);
  vec3 P = vec3(xz, y);
  vec3 toCamV = cameraPosition - P;
  float dist = max(length(toCamV), 1e-3);

  float L = 0.05 + 0.11 * (v / VT);
  float w0 = 0.026 + 0.012 * r2.y;
  float w = max(w0, uPixel * dist * 1.0);
  float cov = w0 / w;
  float radial = smoothstep(18.0, 11.0, length(rel));
  float nearFade = smoothstep(0.4, 1.8, dist);
  float T = exp(-fogOpticalDepth(uCamPos, P));
  float amt = mix(0.35, 1.0, uRainAmt);
  vAlpha = 0.85 * cov * radial * nearFade * T * amt * smoothstep(0.0, 0.15, age);

  vec3 rd = -toCamV / dist;
  float mu = max(dot(rd, uSunDir), 0.0);
  vCol = fogColorDir(rd) * 1.15 + uSunCol * (0.55 * pow(mu, 5.0) + 0.05);

  vec3 dn = vec3(uWindVel.x * 0.2, -1.0, uWindVel.y * 0.2);
  dn = normalize(dn);
  vec3 side = cross(dn, toCamV / dist);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
  vec3 pos = P + side * (cn.x * 0.5 * w) - dn * ((cn.y - 0.5) * L);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

export const DRIP_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vAlpha;
void main() {
  // teardrop: round head (y = 0), tapering tail
  vec2 e = vec2(vUv.x * (0.75 + 1.2 * vUv.y), (vUv.y - 0.5) * 2.0);
  float d = length(e);
  float body = smoothstep(1.0, 0.55, d);
  vec2 hp = e - vec2(-0.25, -0.45);
  float glint = exp(-dot(hp, hp) * 14.0);
  gl_FragColor = vec4(vCol * (0.8 + 2.2 * glint), vAlpha * body);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
