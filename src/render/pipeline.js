// Frame composition:
//   scene → mainRT (HalfFloat HDR, depth texture; MSAA only when TAA is off), jittered when TAA is on
//   TAA resolve (render/taa.js): mainRT + reprojected history → history (output resolution;
//     also upsamples when the tier renders the scene below output size)
//   GTAO (render/gtao.js): half-res AO + linear depth from mainRT depth; lit materials apply it
//     to indirect light next frame; water uses the depth + history for SSR (render/ssr.js)
//   overlay: fast thin particles (rain, userData.postAA) are drawn after TAA (they would smear)
//   volumetric pass: ray-march sun in-scattering through drifting mist, shadowed by
//     the sun's shadow map (canopy gaps become light shafts) — half resolution + depth-aware blur
//   bloom: dual-Kawase down/up chain
//   composite: sharpen, overlay, add scatter, bloom, exposure, tonemap, grading, vignette, grain → screen
// Also owns adaptive quality (pixel ratio + pass cost) driven by measured frame time.

import * as THREE from 'three';
import { HALTON, TAA_FRAG } from './taa.js';
import { aoUniforms, GTAO_FRAG, AO_BLUR_FRAG } from './gtao.js';
import { ssrUniforms } from './ssr.js';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// shadowEvery: re-render the sun shadow map every N frames. 'eco' = low + 30 fps cap (main.js).
// pr = output pixel ratio (canvas, post); rs = scene render scale relative to output (TAA upsamples).
// taa/ao/ssr: temporal AA, ambient occlusion (needs taa), water screen-space reflections (needs taa).
// MSAA (4×) is only used when TAA is off.
const TIERS = {
  high:   { pr: 1.25, rs: 1, taa: 1, ao: 1, ssr: 1, aoSteps: 4, sharp: 0.22, volSteps: 36, volScale: 0.5, bloomLevels: 4, shadow: 2048, shadowEvery: 1 },
  medium: { pr: 1.0, rs: 1, taa: 1, ao: 1, ssr: 1, aoSteps: 3, sharp: 0.22, volSteps: 24, volScale: 0.4, bloomLevels: 4, shadow: 2048, shadowEvery: 2 },
  low:    { pr: 0.85, rs: 0.75, taa: 1, ao: 0, ssr: 0, aoSteps: 3, sharp: 0.32, volSteps: 16, volScale: 0.33, bloomLevels: 3, shadow: 1024, shadowEvery: 2 },
  eco:    { pr: 0.7, rs: 1, taa: 0, ao: 0, ssr: 0, aoSteps: 3, sharp: 0, volSteps: 12, volScale: 0.33, bloomLevels: 3, shadow: 1024, shadowEvery: 3 },
};
export const POST_AA = 'postAA';   // object.userData.postAA = true → drawn after TAA (see overlay)
const ORDER = ['low', 'medium', 'high'];

// Tileable 3D value noise (2 octaves) for drifting mist density.
function makeNoise3D(S = 64) {
  const data = new Uint8Array(S * S * S);
  const lat = (n, seed) => {
    const a = new Float32Array(n * n * n);
    let s = seed >>> 0;
    for (let i = 0; i < a.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      a[i] = s / 4294967296;
    }
    return a;
  };
  const oct = [{ n: 8, w: 0.65, l: lat(8, 7) }, { n: 16, w: 0.35, l: lat(16, 11) }];
  const sm = (t) => t * t * (3 - 2 * t);
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const o of oct) {
      const fx = (x / S) * o.n, fy = (y / S) * o.n, fz = (z / S) * o.n;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      const tx = sm(fx - x0), ty = sm(fy - y0), tz = sm(fz - z0);
      const L = (i, j, k) => o.l[((k % o.n) * o.n + (j % o.n)) * o.n + (i % o.n)];
      const c00 = THREE.MathUtils.lerp(L(x0, y0, z0), L(x0 + 1, y0, z0), tx);
      const c10 = THREE.MathUtils.lerp(L(x0, y0 + 1, z0), L(x0 + 1, y0 + 1, z0), tx);
      const c01 = THREE.MathUtils.lerp(L(x0, y0, z0 + 1), L(x0 + 1, y0, z0 + 1), tx);
      const c11 = THREE.MathUtils.lerp(L(x0, y0 + 1, z0 + 1), L(x0 + 1, y0 + 1, z0 + 1), tx);
      v += o.w * THREE.MathUtils.lerp(THREE.MathUtils.lerp(c00, c10, ty), THREE.MathUtils.lerp(c01, c11, ty), tz);
    }
    data[(z * S + y) * S + x] = Math.round(v * 255);
  }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RedFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const VOL_FRAG = /* glsl */ `
precision highp sampler3D;
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform sampler3D tNoise;
uniform mat4 uProjInv, uCamWorld, uShadowMat;
uniform vec3 uCamPos, uSunDir, uSunCol, uWind;
uniform float uFogDensity, uFogFalloff, uTime, uRange, uStrength, uRain, uScatter;
uniform int uSteps;
uniform float uNoiseOff;
varying vec2 vUv;

float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

float density(vec3 p) {
  float base = uFogDensity * exp(-uFogFalloff * max(p.y, -10.0));
  vec3 drift = vec3(uWind.x, 0.12, uWind.z) * uTime * 0.35;
  float n1 = texture(tNoise, p * vec3(0.018, 0.035, 0.018) + drift * 0.018).r;
  float n2 = texture(tNoise, p * 0.06 - drift * 0.05 + vec3(0.37, 0.11, 0.73)).r;
  float n = n1 * 0.7 + n2 * 0.3;
  return base * (0.15 + 1.9 * smoothstep(0.32, 0.78, n));
}

float sunVis(vec3 p) {
  vec4 sc = uShadowMat * vec4(p, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float d = unpackRGBAToDepth(texture2D(tShadow, sc.xy));
  return step(sc.z - 0.002, d);
}

void main() {
  float d = texture2D(tDepth, vUv).x;
  vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vp.xyz /= vp.w;
  float dist = length(vp.xyz);
  vec3 rd = normalize(mat3(uCamWorld) * vp.xyz);
  float tMax = min(dist, uRange);
  // interleaved gradient noise jitter: static per pixel without TAA (no shimmer); with TAA it
  // moves every frame and the TAA resolve averages it (smoother shafts from fewer steps)
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uNoiseOff * vec2(5.588238, 3.1764), vec2(0.06711056, 0.00583715))));
  float dt = tMax / float(uSteps);
  float mu = dot(rd, uSunDir);
  float phase = mix(hg(mu, 0.55), hg(mu, -0.2), 0.25) * 12.566371; // forward peak + soft back glow
  float T = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 96; i++) {
    if (i >= uSteps) break;
    float t = (float(i) + j) * dt;
    vec3 p = uCamPos + rd * t;
    float sig = density(p);
    float vis = sunVis(p);
    acc += T * sig * vis * dt;
    T *= exp(-sig * dt * 0.6);
  }
  vec3 col = acc * phase * uSunCol * uStrength * uScatter * (1.0 - 0.35 * uRain);
  gl_FragColor = vec4(col, 1.0);
}`;

// Depth-aware separable blur for the half-res scatter buffer.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc, tDepth;
uniform vec2 uDir;
uniform float uNear, uFar;
varying vec2 vUv;
float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  float d0 = lin(texture2D(tDepth, vUv).x);
  vec3 sum = vec3(0.0); float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float di = lin(texture2D(tDepth, uv).x);
    float w = exp(-float(i * i) * 0.18) * exp(-abs(di - d0) / max(d0 * 0.08, 0.05));
    sum += texture2D(tSrc, uv).rgb * w; wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter;
varying vec2 vUv;
vec3 pf(vec3 c) {
  // soft knee: keep bright things, let the rest through faintly (misty glow)
  float b = max(c.r, max(c.g, c.b));
  float k = smoothstep(0.6, 2.2, b);
  return c * mix(0.18, 1.0, k);
}
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;
  c /= 8.0;
  if (uPrefilter > 0.5) c = pf(min(c, vec3(40.0)));
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  gl_FragColor = vec4(c, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc, tPrev; uniform vec2 uTexel; uniform float uHasPrev;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  c /= 12.0;
  if (uHasPrev > 0.5) c += texture2D(tPrev, vUv).rgb;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tColor, tVol, tBloom, tOverlay, tDebug;
uniform float uExposure, uBloom, uTime, uVignette, uSat, uSpeed, uSharp, uOverlay, uDebug, uVolAdd;
uniform vec2 uFocus;
uniform vec3 uLift, uGain, uGammaV;
// film look (uFilm = 0 → legacy ACES path, used by the rainforest grades)
uniform float uFilm, uCross, uContrast, uGrain, uHalation, uCA, uGreenSat, uBars, uWarmSat;
uniform vec4 uCurve;                 // Lottes curve: a (contrast), d (shoulder), b, c
uniform vec3 uShadowTint, uHighTint;  // split toning offsets (display space)
varying vec2 vUv;

vec3 aces(vec3 x) {
  // Narkowicz fit, with a slight shoulder softening
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// Film-like tonemap (Lottes 2016): curve on the max channel keeps hue; bright colours bleach
// toward white through a crosstalk term like dye layers saturating.
vec3 lottes(vec3 x) { vec3 p = pow(max(x, 0.0), vec3(uCurve.x)); return clamp(p / (pow(p, vec3(uCurve.y)) * uCurve.z + uCurve.w), 0.0, 1.0); }
vec3 filmTone(vec3 c) {
  float peak = max(max(c.r, c.g), max(c.b, 1e-5));
  vec3 ratio = c / peak;
  float tp = lottes(vec3(peak)).x;
  ratio = pow(ratio, vec3(0.5));
  ratio = mix(ratio, vec3(1.0), pow(tp, uCross));
  ratio = ratio * ratio;
  // blend with the per-channel curve: bright warm/cool tints bleach to white like real film
  return mix(lottes(c), tp * ratio, 0.5);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  // letterbox: nothing to shade under the bars
  float by = min(vUv.y, 1.0 - vUv.y);
  if (uBars > 0.0 && by < uBars - 0.002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // Speed: radial blur toward the direction of travel, strongest at the screen edges
  vec2 toF = vUv - uFocus;
  float edge = smoothstep(0.08, 0.75, length(toF * vec2(1.6, 1.0)));
  float amt = uSpeed * edge * 0.055;
  vec3 col = texture2D(tColor, vUv).rgb;
  vec3 c0 = col;
  // gentle sharpen after TAA (unsharp mask clamped to the 4-neighbourhood: no halos/ringing)
  if (uSharp > 0.0) {
    vec2 tx = 1.0 / vec2(textureSize(tColor, 0));
    vec3 sa = texture2D(tColor, vUv + vec2(tx.x, 0.0)).rgb, sb = texture2D(tColor, vUv - vec2(tx.x, 0.0)).rgb;
    vec3 sc = texture2D(tColor, vUv + vec2(0.0, tx.y)).rgb, sd = texture2D(tColor, vUv - vec2(0.0, tx.y)).rgb;
    vec3 mn = min(col, min(min(sa, sb), min(sc, sd))), mx = max(col, max(max(sa, sb), max(sc, sd)));
    col = clamp(col + (col - 0.25 * (sa + sb + sc + sd)) * uSharp * 2.0, mn, mx);
  }
  if (amt > 0.0005) {
    float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float k = (float(i) + j) / 8.0;
      col += texture2D(tColor, vUv - toF * amt * k).rgb;
    }
    col /= 8.0;
  }
  // lateral chromatic aberration (lens edges only; skipped near the centre)
  vec2 qc = vUv - 0.5;
  float r2 = dot(qc, qc);
  if (uCA > 0.0 && r2 > 0.04) {
    vec2 off = qc * r2 * uCA;
    col.r = max(col.r + texture2D(tColor, vUv + off).r - c0.r, 0.0);
    col.b = max(col.b + texture2D(tColor, vUv - off).b - c0.b, 0.0);
  }
  // particles drawn after TAA (premultiplied over)
  if (uOverlay > 0.5) { vec4 ov = texture2D(tOverlay, vUv); col = col * (1.0 - clamp(ov.a, 0.0, 1.0)) + max(ov.rgb, 0.0); }
  if (uVolAdd > 0.5) col += texture2D(tVol, vUv).rgb;   // with TAA it is already in tColor
  // faint wind streaks at the edges at high speed
  if (uSpeed > 0.05) {
    float ang = atan(toF.y, toF.x);
    float lane = fract(sin(floor(ang * 90.0) * 91.7) * 4375.85);
    float run = fract(length(toF) * 3.0 - uTime * (2.0 + 3.0 * lane) - lane * 7.0);
    float streak = step(0.93, lane) * smoothstep(0.0, 0.25, run) * smoothstep(0.6, 0.25, run);
    col += vec3(0.9, 0.95, 1.0) * streak * edge * edge * uSpeed * 0.06 * uExposure;
  }
  if (any(isnan(col))) col = vec3(0.0);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  col = mix(col, bloom, uBloom);
  // halation: the red layer of film glows around bright highlights
  // (only the glow spilling *around* a bright source, not the source itself)
  if (uHalation > 0.0) {
    float bl = dot(bloom, vec3(0.3, 0.5, 0.2));
    float spill = max(bl - dot(col, vec3(0.3, 0.5, 0.2)), 0.0);
    col += vec3(1.0, 0.3, 0.1) * spill * smoothstep(0.6, 2.5, bl) * uHalation;
  }
  col *= uExposure;
  vec2 q = vUv - 0.5;
  q.y *= 1.0 / max(1.0 - 2.0 * uBars, 0.3);  // vignette follows the picture area, not the bars
  float vig = 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);

  if (uFilm > 0.5) {
    col *= vig;                                   // optical falloff before the film curve
    col = toSRGB(filmTone(col));
    // grade in display (sRGB) space: gain (white balance) / lift / gamma
    col = col * uGain + uLift * (1.0 - col);
    col = pow(max(col, 0.0), 1.0 / uGammaV);
    // gentle S-curve
    col = clamp(col, 0.0, 1.0);
    col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
    // split toning: cool shadows, warm highlights
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col += uShadowTint * (1.0 - smoothstep(0.0, 0.5, l)) + uHighTint * smoothstep(0.45, 1.0, l);
    // saturation: global, calmer greens, keep warm tones (skin, red roofs, the orange helmet)
    l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float green = clamp((col.g - max(col.r, col.b)) * 5.0, 0.0, 1.0) * clamp((col.g - col.b) * 4.0, 0.0, 1.0);
    float warm = clamp((col.r - col.b) * 3.0, 0.0, 1.0) * (1.0 - green) * (1.0 - smoothstep(0.6, 0.95, l));
    col = mix(vec3(l), col, uSat - uGreenSat * green + uWarmSat * warm);
    // grain (also dithers): re-seeded 24× per second, strongest in the mid-tones
    float hg = h12(gl_FragCoord.xy + fract(floor(uTime * 24.0) * 0.1234) * 997.0);
    float g = hg - 0.5, gc = fract(hg * 17.31) - 0.5;
    float amp = uGrain * (0.3 + 2.4 * l * (1.0 - l));
    col += vec3(g + gc * 0.2, g, g - gc * 0.2) * amp;
    col = clamp(col, 0.0, 1.0);
  } else {
    col = aces(col);
    // grade (display-referred): lift / gamma / gain + saturation
    col = pow(max(col, 0.0), 1.0 / uGammaV);
    col = col * uGain + uLift * (1.0 - col);
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    col *= vig;
    col = toSRGB(clamp(col, 0.0, 1.0));
    // dither (kills banding in fog gradients)
    float n = h12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
    col += n * (1.5 / 255.0);
  }
  // anti-aliased bar edge
  if (uBars > 0.0) col *= smoothstep(uBars - 0.002, uBars + 0.0005, by);
  if (uDebug > 0.5) col = vec3(texture2D(tDebug, vUv).r);   // pipeline.debugView = 'ao'
  gl_FragColor = vec4(col, 1.0);
}`;

// Per time-of-day grading (display-referred). Blended by atmosphere via ctx.grade.
export const GRADES = {
  day:   { lift: [0.025, 0.03, 0.022], gamma: [1.02, 1.05, 1.0], gain: [1.03, 1.05, 0.97], sat: 1.25, vignette: 0.12, bloom: 0.07,
           sunny: { lift: [0.016, 0.02, 0.016], gain: [1.03, 1.04, 0.99] } },   // fair weather: less milky lift
  dusk:  { lift: [0.02, 0.014, 0.006], gamma: [1.04, 1.0, 0.95], gain: [1.06, 1.0, 0.9], sat: 1.15, vignette: 0.2, bloom: 0.08 },
  night: { lift: [0.01, 0.015, 0.03], gamma: [0.98, 1.0, 1.06], gain: [0.96, 1.0, 1.08], sat: 0.95, vignette: 0.3, bloom: 0.1 },
};

// Film-look keys a scene grade may add (sceneDef.grades). Missing keys → these (= legacy look, film off).
//   film 1 = Lottes film curve + display-space grade; curve {contrast, shoulder, midIn, midOut, hdrMax};
//   cross = highlight bleach exponent; contrast = S-curve 0..1; shadowTint/highTint = split toning offsets;
//   greenSat/warmSat = hue-selective saturation; grain/halation/ca = film & lens texture.
const FILM_DEFAULTS = {
  film: 0, curve: [1.3, 0.97, 0.18, 0.24, 14], cross: 4, contrast: 0, shadowTint: [0, 0, 0], highTint: [0, 0, 0],
  greenSat: 0, warmSat: 0, grain: 0, halation: 0, ca: 0,
};
// Lottes 2016: solve b, c so that midIn → midOut and hdrMax → 1.
function lottesBC([a, d, midIn, midOut, hdrMax]) {
  const ad = a * d;
  const b = (-Math.pow(midIn, a) + Math.pow(hdrMax, a) * midOut) / ((Math.pow(hdrMax, ad) - Math.pow(midIn, ad)) * midOut);
  const c = (Math.pow(hdrMax, ad) * Math.pow(midIn, a) - Math.pow(hdrMax, a) * Math.pow(midIn, ad) * midOut) / ((Math.pow(hdrMax, ad) - Math.pow(midIn, ad)) * midOut);
  return [a, d, b, c];
}
// 2.39:1 bars (fraction of the screen height, each side) for a given viewport aspect.
const barsFor = (aspect) => (aspect > 1.2 ? Math.max(0, (1 - aspect / 2.39) / 2) : 0);

export function createPipeline(ctx, canvas) {
  const { state } = ctx;
  const U = ctx.uniforms;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // refreshed every tier.shadowEvery frames
  let frameNo = 0;
  ctx.renderer = renderer;

  /* ---------------- sun + shadow (follows camera, texel-snapped) */
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  const S = 70;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 420 });
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  ctx.scene.add(sun, sun.target);
  ctx.sun = sun;

  function updateSun() {
    const cam = ctx.camera.position;
    const dir = U.uSunDir.value;
    const texel = (S * 2) / sun.shadow.mapSize.x;
    // snap in light space so the shadow doesn't swim while walking
    const lightRot = new THREE.Matrix4().lookAt(dir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const c = cam.clone().applyMatrix4(inv);
    c.x = Math.round(c.x / texel) * texel;
    c.y = Math.round(c.y / texel) * texel;
    c.applyMatrix4(lightRot);
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(dir, 220);
    sun.target.updateMatrixWorld();
  }

  /* ---------------- targets */
  const maxSamples = renderer.capabilities.maxSamples || 0;
  const hdr = { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace };
  const mainRT = new THREE.WebGLRenderTarget(4, 4, { ...hdr, samples: Math.min(4, maxSamples), depthTexture: new THREE.DepthTexture(4, 4) });
  // TAA history ping-pong (output resolution, linear HDR); hi = the one written last frame
  const histRT = [0, 1].map(() => new THREE.WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: false }));
  let hi = 0;
  // AO: aoA = final (r = visibility, g = linear depth), read next frame by materials + SSR; aoB = blur temp
  const aoA = new THREE.WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: false });
  const aoB = new THREE.WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: false });
  const volA = new THREE.WebGLRenderTarget(4, 4, hdr);
  const volB = new THREE.WebGLRenderTarget(4, 4, hdr);
  const bloomDown = [], bloomUp = [];
  for (let i = 0; i < 6; i++) {
    bloomDown.push(new THREE.WebGLRenderTarget(4, 4, hdr));
    bloomUp.push(new THREE.WebGLRenderTarget(4, 4, hdr));
  }
  // Fast, thin particles (rain streaks/splashes/drips) are drawn after TAA: accumulated they
  // would fade into faint smears. Modules flag them with object.userData.postAA = true.
  const overlay = new THREE.Scene();
  function collectOverlay() {
    for (const o of [...ctx.scene.children]) if (o.userData?.[POST_AA]) overlay.add(o);
  }

  /* ---------------- fullscreen passes */
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  quadGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function makePass(fragmentShader, uniforms) {
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: FS_VERT, fragmentShader, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(quadGeo, material);
    mesh.frustumCulled = false;
    const s = new THREE.Scene();
    s.add(mesh);
    return { material, u: uniforms, run(target) { renderer.setRenderTarget(target); renderer.render(s, quadCam); } };
  }

  const volPass = makePass(VOL_FRAG, {
    tDepth: { value: mainRT.depthTexture }, tShadow: { value: null }, tNoise: { value: makeNoise3D() },
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uShadowMat: { value: new THREE.Matrix4() },
    uCamPos: U.uCamPos, uSunDir: U.uSunDir, uSunCol: U.uSunCol, uWind: U.uWind, uRain: U.uRain,
    uFogDensity: U.uFogDensity, uFogFalloff: U.uFogFalloff, uTime: U.uTime,
    uRange: { value: 78 }, uStrength: { value: 1 }, uSteps: { value: 48 }, uScatter: { value: 0.12 }, uNoiseOff: { value: 0 },
  });
  const blurPass = makePass(BLUR_FRAG, {
    tSrc: { value: null }, tDepth: { value: mainRT.depthTexture }, uDir: { value: new THREE.Vector2() },
    uNear: { value: 0.1 }, uFar: { value: 900 },
  });
  const downPass = makePass(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } });
  const upPass = makePass(UP_FRAG, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uHasPrev: { value: 0 } });
  const compPass = makePass(COMPOSITE_FRAG, {
    tColor: { value: mainRT.texture }, tVol: { value: volB.texture }, tBloom: { value: null }, tOverlay: { value: null }, tDebug: { value: null }, uDebug: { value: 0 }, uVolAdd: { value: 1 },
    uExposure: { value: 1 }, uBloom: { value: 0.05 }, uTime: U.uTime, uVignette: { value: 0.35 }, uSat: { value: 0.95 },
    uSpeed: { value: 0 }, uFocus: { value: new THREE.Vector2(0.5, 0.52) }, uSharp: { value: 0 }, uOverlay: { value: 0 },
    uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uGammaV: { value: new THREE.Vector3(1, 1, 1) },
    uFilm: { value: 0 }, uCurve: { value: new THREE.Vector4(1, 1, 1, 0) }, uCross: { value: 4 }, uContrast: { value: 0 },
    uShadowTint: { value: new THREE.Vector3() }, uHighTint: { value: new THREE.Vector3() },
    uGreenSat: { value: 0 }, uWarmSat: { value: 0 }, uGrain: { value: 0 }, uHalation: { value: 0 }, uCA: { value: 0 }, uBars: { value: 0 },
  });
  const taaPass = makePass(TAA_FRAG, {
    tCur: { value: mainRT.texture }, tDepth: { value: mainRT.depthTexture }, tHist: { value: null },
    uCurToPrev: { value: new THREE.Matrix4() }, uInvVPRel: { value: new THREE.Matrix4() },
    uRiderRel: { value: new THREE.Vector3() }, uRiderClipDelta: { value: new THREE.Vector4() }, uRiderR: { value: 0 },
    uJitter: { value: new THREE.Vector2() }, uRenderSize: { value: new THREE.Vector2(1, 1) }, uOutSize: { value: new THREE.Vector2(1, 1) },
    uAlpha: { value: 0.1 }, uReset: { value: 1 }, uBars: { value: 0 }, uGamma: { value: 1.25 }, tVol: { value: null }, uVolOn: { value: 0 },
  });
  const aoPass = makePass(GTAO_FRAG, {
    tDepth: { value: mainRT.depthTexture }, uProjInfo: { value: new THREE.Vector4() }, uNF: { value: new THREE.Vector2() },
    uSize: { value: new THREE.Vector2(1, 1) }, uRadius: { value: 1.5 }, uMaxPx: { value: 40 }, uFrame: { value: 0 },
    uFadeEnd: { value: 160 }, uOn: { value: 1 }, uProjScale: { value: 1 }, uPower: { value: 1 }, uSteps: { value: 3 },
  });
  const aoBlurPass = makePass(AO_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  // per-scene AO look: forest = soft overcast light, so less; fjord = big open scale
  // (tuned on the lupine meadow: ≈ −2.5 % mean brightness; forest ≈ −0.7 %; sunlit areas untouched)
  const AO_CFG = { rainforest: { radius: 0.8, fade: 50, str: 0.65, power: 1.0 }, fjord: { radius: 1.0, fade: 110, str: 0.6, power: 1.0 } };
  const aoCfg = { ...(AO_CFG[ctx.sceneId] || AO_CFG.fjord), ...(ctx.sceneDef?.ao || {}) };

  /* ---------------- feature switches: tier default, overridable (?taa=0 &ao=0 &ssr=0, or pipeline.setFeature) */
  const FEAT = { taa: null, ao: null, ssr: null };
  for (const k of Object.keys(FEAT)) { const v = ctx.params?.get(k); if (v != null) FEAT[k] = v !== '0'; }
  const on = (k) => (FEAT[k] ?? !!tier[k]) && (k === 'taa' || (FEAT.taa ?? !!tier.taa));

  /* ---------------- sizing + quality */
  let tierName = 'high', tier = TIERS.high, pixelRatio = Math.min(devicePixelRatio || 1, tier.pr);
  let W = 1, H = 1, outW = 1, outH = 1, rw = 1, rh = 1, renderScale = 1, fineScale = 1, taaWas = null;
  let histValid = false, aoValid = false;
  function resizeTargets() {
    const taa = on('taa');
    taaWas = taa;
    // auto fine-scaling: with TAA lower the scene resolution (TAA upsamples), else the canvas
    pixelRatio = Math.min(devicePixelRatio || 1, tier.pr) * (taa ? 1 : fineScale);
    renderScale = taa ? tier.rs * fineScale : 1;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(W, H, false);
    outW = Math.max(1, Math.floor(W * pixelRatio)); outH = Math.max(1, Math.floor(H * pixelRatio));
    rw = Math.max(1, Math.floor(outW * renderScale)); rh = Math.max(1, Math.floor(outH * renderScale));
    const samples = taa ? 0 : Math.min(4, maxSamples);
    if (mainRT.samples !== samples) { mainRT.dispose(); mainRT.samples = samples; }
    mainRT.setSize(rw, rh);
    for (const r of histRT) r.setSize(outW, outH);
    const aw = Math.max(1, rw >> 1), ah = Math.max(1, rh >> 1);
    aoA.setSize(aw, ah); aoB.setSize(aw, ah);
    const vw = Math.max(1, Math.floor(rw * tier.volScale)), vh = Math.max(1, Math.floor(rh * tier.volScale));
    volA.setSize(vw, vh);
    volB.setSize(vw, vh);
    let bw = outW, bh = outH;
    for (let i = 0; i < 6; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      bloomDown[i].setSize(bw, bh);
      bloomUp[i].setSize(bw, bh);
    }
    histValid = false; aoValid = false;
  }
  function applyTier(name) {
    tierName = name;
    tier = TIERS[name];
    volPass.u.uSteps.value = tier.volSteps;
    if (sun.shadow.mapSize.x !== tier.shadow) {
      sun.shadow.mapSize.set(tier.shadow, tier.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    resizeTargets();
    const resolved = name === 'eco' ? 'low' : name;
    if (state.get('resolvedQuality') !== resolved) state.set('resolvedQuality', resolved);
  }
  W = innerWidth; H = innerHeight;
  const q0 = state.get('quality');
  applyTier(q0 === 'auto' ? 'medium' : q0); // auto starts mid and climbs only if the GPU has headroom
  state.on('quality', (q) => { autoCooldown = 3; fineScale = 1; applyTier(q === 'auto' ? tierName : q); });

  // Adaptive: average frame time over ~2 s windows. Target ≥ 55 fps on high.
  let frames = 0, acc = 0, autoCooldown = 2.5;
  // GPU time per frame (EXT_disjoint_timer_query_webgl2); falls back to frame time.
  const gl = renderer.getContext();
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let query = null, queryOpen = false, gpuMs = 0;
  function gpuBegin() {
    if (!tq || query) return;
    query = gl.createQuery();
    gl.beginQuery(tq.TIME_ELAPSED_EXT, query);
    queryOpen = true;
  }
  function gpuEnd() {
    if (queryOpen) { gl.endQuery(tq.TIME_ELAPSED_EXT); queryOpen = false; return; }
    if (!query) return;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) {
      const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gpuMs = gpuMs ? gpuMs * 0.9 + ms * 0.1 : ms;
    }
    gl.deleteQuery(query);
    query = null;
  }

  // Optional per-pass GPU profiler (api.profile = true; read api.prof): TIME_ELAPSED queries per
  // section, replaces the whole-frame query while on. ms are running averages.
  const prof = { on: false, cur: null, pending: [], sum: {}, n: {} };
  function pBegin(name) {
    if (!prof.on || !tq) return;
    const q = gl.createQuery();
    gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    prof.cur = { name, q };
  }
  function pEnd() {
    if (!prof.cur) return;
    gl.endQuery(tq.TIME_ELAPSED_EXT);
    prof.pending.push(prof.cur);
    prof.cur = null;
  }
  function pPoll() {
    for (let i = 0; i < prof.pending.length;) {
      const p = prof.pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { i++; continue; }
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) {
        prof.sum[p.name] = (prof.sum[p.name] || 0) + gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        prof.n[p.name] = (prof.n[p.name] || 0) + 1;
      }
      gl.deleteQuery(p.q);
      prof.pending.splice(i, 1);
    }
  }

  // Adaptive: keep the GPU well under the 60 fps budget (≈ 16.7 ms) so laptops stay cool.
  function adapt(dt) {
    if (state.get('quality') !== 'auto') return;
    if (autoCooldown > 0) { autoCooldown -= dt; return; }
    frames++; acc += dt;
    if (acc < 2) return;
    const frameMs = (acc / frames) * 1000;
    frames = 0; acc = 0;
    const ms = gpuMs || frameMs * 0.8;
    const idx = ORDER.indexOf(tierName);
    if (ms > 11 && fineScale > 0.8) { fineScale -= 0.1; resizeTargets(); autoCooldown = 1.5; }
    else if (ms > 11 && idx > 0) { fineScale = 1; applyTier(ORDER[idx - 1]); autoCooldown = 2; }
    else if (ms < 5 && fineScale < 1) { fineScale = Math.min(1, fineScale + 0.1); resizeTargets(); autoCooldown = 3; }
    else if (ms < 4.5 && idx < ORDER.length - 1) { fineScale = 1; applyTier(ORDER[idx + 1]); autoCooldown = 4; }
  }

  /* ---------------- grading blend */
  const G = ctx.sceneDef?.grades || GRADES;
  // look (colour variant) + letterbox: URL > saved state > scene default
  const P = ctx.params;
  if (P?.get('look')) state.set('look', P.get('look'));
  if (state.get('look') == null) state.set('look', ctx.sceneDef?.looks?.[0]?.id ?? null);
  if (P?.get('letterbox')) state.set('letterbox', P.get('letterbox') !== '0');
  if (state.get('letterbox') == null) state.set('letterbox', !!ctx.sceneDef?.letterbox);
  // A grade may carry `sunny: {...}` overrides for fair weather; they fade in by ctx.sunny (0..1,
  // eased by atmosphere.js from state.rain) so the rain grade itself stays exactly as authored.
  const gradeFor = (tod, sunny) => {
    const { sunny: S, ...g } = G[`${tod}.${state.get('look')}`] || G[tod] || G.day;
    return JSON.parse(JSON.stringify({ ...FILM_DEFAULTS, ...g, ...(sunny && S ? S : {}) }));
  };
  const gradeW = gradeFor(state.get('timeOfDay')), gradeS = gradeFor(state.get('timeOfDay'), true);
  const grade = JSON.parse(JSON.stringify(gradeW));          // effective = mix(gradeW, gradeS, ctx.sunny)
  let gFrom = null, gTo = null, gFromS = null, gToS = null, gT = 1;
  const regrade = () => {
    gFrom = JSON.parse(JSON.stringify(gradeW)); gTo = gradeFor(state.get('timeOfDay'));
    gFromS = JSON.parse(JSON.stringify(gradeS)); gToS = gradeFor(state.get('timeOfDay'), true);
    gT = 0;
  };
  state.on('timeOfDay', regrade);
  state.on('look', regrade);
  let bars = state.get('letterbox') ? 1 : 0;   // animated 0..1 (bars slide in/out)
  const lerpInto = (out, a, b, t) => {
    for (const k of Object.keys(b)) {
      out[k] = Array.isArray(b[k]) ? b[k].map((v, i) => THREE.MathUtils.lerp(a[k][i], v, t)) : THREE.MathUtils.lerp(a[k], b[k], t);
    }
  };
  function blendGrade(dt) {
    if (gT < 1 && gTo) {
      gT = Math.min(1, gT + dt / 4);
      const t = gT * gT * (3 - 2 * gT);
      lerpInto(gradeW, gFrom, gTo, t);
      lerpInto(gradeS, gFromS, gToS, t);
    }
    lerpInto(grade, gradeW, gradeS, THREE.MathUtils.clamp(ctx.sunny ?? 0, 0, 1));
  }

  /* ---------------- temporal state */
  const curVP = new THREE.Matrix4(), prevVP = new THREE.Matrix4(), jitVP = new THREE.Matrix4(), aoVP = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4(), tmpV4 = new THREE.Vector4();
  const prevCamPos = new THREE.Vector3(), prevCamDir = new THREE.Vector3(0, 0, -1), camDir = new THREE.Vector3();
  const riderC = new THREE.Vector3(), prevRiderC = new THREE.Vector3();
  let prevRider = false, prevBars = 0;
  const savedClear = new THREE.Color();
  function bindMain(bandPx) {
    if (bandPx > 0) { mainRT.scissor.set(0, bandPx, mainRT.width, mainRT.height - 2 * bandPx); mainRT.scissorTest = true; }
    else mainRT.scissorTest = false;
    renderer.setRenderTarget(mainRT);
  }
  function unbindMain() { if (mainRT.scissorTest) { mainRT.scissorTest = false; renderer.setRenderTarget(null); } }

  /* ---------------- frame */
  function render(dt) {
    adapt(dt);
    blendGrade(dt);
    bars += ((state.get('letterbox') ? 1 : 0) - bars) * Math.min(1, dt * 3);
    if (Math.abs(bars - (state.get('letterbox') ? 1 : 0)) < 0.002) bars = state.get('letterbox') ? 1 : 0;
    const barF = barsFor(W / H) * bars;
    updateSun();
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    if ((frameNo & 31) === 0) collectOverlay();
    const taa = on('taa'), ao = on('ao'), ssr = on('ssr');
    if (taa !== taaWas) resizeTargets();   // MSAA ↔ TAA, render scale

    if (prof.on && tq) { if (queryOpen) { gl.endQuery(tq.TIME_ELAPSED_EXT); queryOpen = false; } pPoll(); } else { gpuEnd(); gpuBegin(); }
    frameNo++;
    renderer.shadowMap.needsUpdate = frameNo % tier.shadowEvery === 0;

    // camera cut (respawn, scene jump) → drop the history
    curVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    cam.getWorldDirection(camDir);
    if (cam.position.distanceToSquared(prevCamPos) > 64 || camDir.dot(prevCamDir) < 0.85) { histValid = false; aoValid = false; }

    // inputs that read LAST frame: SSR (history colour + AO depth), AO in lit materials
    ssrUniforms.uSSROn.value = ssr && histValid && aoValid ? 1 : 0;
    ssrUniforms.tSSRColor.value = histRT[hi].texture;
    ssrUniforms.tSSRDepth.value = aoA.texture;
    ssrUniforms.uSSRVP.value.copy(prevVP);
    ssrUniforms.uSSRBars.value = prevBars;
    ssrUniforms.uSSRFrame.value = frameNo % 64;
    ssrUniforms.uSSRFar.value = cam.far;
    aoUniforms.uSSAOOn.value = ao && aoValid ? 1 : 0;
    aoUniforms.tSSAO.value = aoA.texture;
    aoUniforms.uSSAOVP.value.copy(aoVP);
    aoUniforms.uSSAOStr.value = aoCfg.str;

    // 1. scene → HDR (under 2.39:1 bars only the picture band is shaded: ~25 % fewer pixels)
    const pe = cam.projectionMatrix.elements, e8 = pe[8], e9 = pe[9];
    let jx = 0, jy = 0;
    if (taa) {
      [jx, jy] = HALTON[frameNo % HALTON.length];
      pe[8] += (2 * jx) / rw; pe[9] += (2 * jy) / rh;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    jitVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const pj8 = pe[8], pj9 = pe[9];
    const bandPx = Math.floor(mainRT.height * barF) - 1;
    pBegin('scene');
    bindMain(bandPx);
    renderer.clear();
    renderer.render(ctx.scene, cam);
    if (!taa && overlay.children.length) {
      renderer.autoClear = false;
      renderer.render(overlay, cam);
      renderer.autoClear = true;
    }
    unbindMain();
    pEnd();
    if (taa) { pe[8] = e8; pe[9] = e9; cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert(); }

    pBegin('vol');
    // 2. volumetric scatter (half res) + depth-aware blur — before TAA so it gets anti-aliased too
    const shadowTex = sun.shadow.map?.texture;
    let volOn = 0;
    const vw = volA.width, vh = volA.height;
    if (shadowTex) {
      volPass.u.tShadow.value = shadowTex;
      volPass.u.uShadowMat.value.copy(sun.shadow.matrix);
      volPass.u.uProjInv.value.copy(cam.projectionMatrixInverse);
      volPass.u.uCamWorld.value.copy(cam.matrixWorld);
      volPass.u.uStrength.value = ctx.volStrength ?? 1;
      volPass.u.uNoiseOff.value = taa ? frameNo % 64 : 0;
      volPass.u.uSteps.value = taa ? Math.max(8, Math.round(tier.volSteps * 0.75)) : tier.volSteps;
      volPass.run(volA);
      blurPass.u.uNear.value = cam.near; blurPass.u.uFar.value = cam.far;
      blurPass.u.tSrc.value = volA.texture; blurPass.u.uDir.value.set(1.5 / vw, 0); blurPass.run(volB);
      blurPass.u.tSrc.value = volB.texture; blurPass.u.uDir.value.set(0, 1.5 / vh); blurPass.run(volA);
      compPass.u.tVol.value = volA.texture;
      volOn = 1;
    }
    pEnd();

    // 3. TAA resolve → history
    let colorTex = mainRT.texture, cw = rw, ch = rh;
    if (taa) {
      const u = taaPass.u, src = histRT[hi], dst = histRT[1 - hi];
      u.tHist.value = src.texture;
      tmpM.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);       // inverse(curVP)
      u.uCurToPrev.value.multiplyMatrices(prevVP, tmpM);
      tmpM.copy(cam.matrixWorld).setPosition(0, 0, 0);
      u.uInvVPRel.value.multiplyMatrices(tmpM, cam.projectionMatrixInverse);
      const rs = ctx.skate?.enabled ? ctx.skate.state : null;
      u.uRiderR.value = 0;
      if (rs?.position) {
        riderC.copy(rs.position);
        if (rs.up) riderC.addScaledVector(rs.up, 0.85); else riderC.y += 0.85;
        if (prevRider && riderC.distanceToSquared(prevRiderC) < 9) {
          u.uRiderRel.value.copy(riderC).sub(cam.position);
          tmpV4.set(riderC.x - prevRiderC.x, riderC.y - prevRiderC.y, riderC.z - prevRiderC.z, 0).applyMatrix4(prevVP);
          u.uRiderClipDelta.value.copy(tmpV4);
          u.uRiderR.value = 1.5;
        }
        prevRiderC.copy(riderC); prevRider = true;
      } else prevRider = false;
      u.tVol.value = volA.texture;
      u.uVolOn.value = volOn;
      u.uJitter.value.set(jx, jy);
      u.uRenderSize.value.set(rw, rh);
      u.uOutSize.value.set(outW, outH);
      u.uAlpha.value = api.taaCfg.alpha;
      u.uGamma.value = api.taaCfg.gamma;
      u.uReset.value = histValid ? 0 : 1;
      u.uBars.value = barF;
      pBegin('taa');
      taaPass.run(dst);
      pEnd();
      hi = 1 - hi;
      histValid = true;
      colorTex = dst.texture; cw = outW; ch = outH;
    }

    // 4. AO (+ linear depth for next frame's SSR), half resolution
    if (ao || ssr) {
      const u = aoPass.u, aw = aoA.width, ah = aoA.height;
      u.uProjInfo.value.set(pe[0], pe[5], pj8, pj9);
      u.uNF.value.set(cam.near, cam.far);
      u.uSize.value.set(aw, ah);
      u.uRadius.value = aoCfg.radius;
      u.uMaxPx.value = Math.max(8, ah * 0.08);
      u.uProjScale.value = 0.5 * ah * pe[5];
      u.uFadeEnd.value = aoCfg.fade;
      u.uPower.value = aoCfg.power;
      u.uFrame.value = frameNo % 64;
      u.uSteps.value = tier.aoSteps;
      u.uOn.value = ao ? 1 : 0;
      pBegin('ao');
      aoPass.run(aoA);
      if (ao) {
        aoBlurPass.u.tSrc.value = aoA.texture; aoBlurPass.u.uDir.value.set(1 / aw, 0); aoBlurPass.run(aoB);
        aoBlurPass.u.tSrc.value = aoB.texture; aoBlurPass.u.uDir.value.set(0, 1 / ah); aoBlurPass.run(aoA);
      }
      pEnd();
      aoVP.copy(jitVP);
      aoValid = true;
    } else aoValid = false;

    // 5. post-TAA particles: mainRT colour is free now → clear it (keep depth) and draw them
    let ovOn = 0;
    if (taa && overlay.children.some((o) => o.visible)) {
      pBegin('overlay');
      bindMain(bandPx);
      renderer.getClearColor(savedClear);
      const ca = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.autoClear = false;
      renderer.render(overlay, cam);
      renderer.autoClear = true;
      renderer.setClearColor(savedClear, ca);
      unbindMain();
      pEnd();
      ovOn = 1;
    }

    pBegin('post');
    // 6. bloom chain (from the anti-aliased image: no flickering speckles)
    const L = tier.bloomLevels;
    let src = colorTex, sw = cw, sh = ch;
    for (let i = 0; i < L; i++) {
      downPass.u.tSrc.value = src;
      downPass.u.uTexel.value.set(1 / sw, 1 / sh);
      downPass.u.uPrefilter.value = i === 0 ? 1 : 0;
      downPass.run(bloomDown[i]);
      src = bloomDown[i].texture; sw = bloomDown[i].width; sh = bloomDown[i].height;
    }
    let prev = null;
    for (let i = L - 1; i >= 1; i--) {
      upPass.u.tSrc.value = i === L - 1 ? bloomDown[i].texture : prev;
      upPass.u.uTexel.value.set(1 / bloomDown[i].width, 1 / bloomDown[i].height);
      upPass.u.tPrev.value = bloomDown[i - 1].texture;
      upPass.u.uHasPrev.value = 1;
      upPass.run(bloomUp[i - 1]);
      prev = bloomUp[i - 1].texture;
    }
    compPass.u.tBloom.value = prev || bloomDown[0].texture;

    // 7. composite → screen
    // speed feel: 0 below 7 m/s → 1 at 18 m/s (skate only, off while tumbling)
    const rs = ctx.skate?.enabled ? ctx.skate.state : null;
    const sp = rs && !rs.fallen ? THREE.MathUtils.clamp((rs.speed - 7) / 11, 0, 1) : 0;
    compPass.u.uSpeed.value += (sp * sp - compPass.u.uSpeed.value) * Math.min(1, dt * 4);
    compPass.u.tColor.value = colorTex;
    compPass.u.tOverlay.value = mainRT.texture;
    compPass.u.uOverlay.value = ovOn;
    compPass.u.uSharp.value = taa ? tier.sharp * api.taaCfg.sharp : 0;
    compPass.u.uVolAdd.value = taa ? 0 : 1;
    compPass.u.uExposure.value = ctx.exposure ?? 1;
    compPass.u.uBloom.value = grade.bloom;
    compPass.u.uVignette.value = grade.vignette;
    compPass.u.uSat.value = grade.sat;
    compPass.u.uLift.value.fromArray(grade.lift);
    compPass.u.uGain.value.fromArray(grade.gain);
    compPass.u.uGammaV.value.fromArray(grade.gamma);
    compPass.u.uFilm.value = grade.film;
    compPass.u.uCurve.value.fromArray(lottesBC(grade.curve));
    compPass.u.uCross.value = grade.cross;
    compPass.u.uContrast.value = grade.contrast;
    compPass.u.uShadowTint.value.fromArray(grade.shadowTint);
    compPass.u.uHighTint.value.fromArray(grade.highTint);
    compPass.u.uGreenSat.value = grade.greenSat;
    compPass.u.uWarmSat.value = grade.warmSat;
    compPass.u.uGrain.value = grade.grain;
    compPass.u.uHalation.value = grade.halation;
    compPass.u.uCA.value = grade.ca;
    compPass.u.uBars.value = barF;
    compPass.u.uDebug.value = api.debugView === 'ao' && aoValid ? 1 : 0;
    compPass.u.tDebug.value = aoA.texture;
    compPass.run(null);
    pEnd();

    prevVP.copy(curVP);
    prevCamPos.copy(cam.position);
    prevCamDir.copy(camDir);
    prevBars = barF;
  }

  const api = {
    debugView: null,
    taaCfg: { alpha: 0.1, gamma: 1.25, sharp: 0.7 },   // blend weight of the new frame, static clip-box size, sharpen multiplier
    /** GPU profiling: set profile = true, render some frames, read prof (ms per section). */
    set profile(v) { prof.on = !!v; prof.sum = {}; prof.n = {}; },
    get prof() { const o = {}; for (const k in prof.sum) o[k] = +(prof.sum[k] / prof.n[k]).toFixed(3); return o; },
    aoCfg,
    ssr: ssrUniforms,
    renderer,
    render,
    setSize(w, h) { W = w; H = h; resizeTargets(); },
    warmup() { renderer.compile(ctx.scene, ctx.camera); },
    passes: { volPass, compPass, taaPass, aoPass },
    grade,
    /** Force a feature on/off (true/false) or back to the tier default (null): 'taa' | 'ao' | 'ssr'. */
    setFeature(k, v) { FEAT[k] = v; resizeTargets(); },
    get features() { return { taa: on('taa'), ao: on('ao'), ssr: on('ssr'), msaa: mainRT.samples, renderScale, out: [outW, outH], render: [rw, rh] }; },
    get tier() { return tierName; },
    get gpuMs() { return gpuMs; },
    get pixelRatio() { return pixelRatio; },
  };
  return api;
}
