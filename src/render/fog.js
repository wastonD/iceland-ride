// Analytic exponential height fog + surface wetness, injected into built-in
// materials via addShaderPatch, and exposed as a GLSL chunk for custom shaders.
//
// Every material that goes into the scene must pass through prepareMaterial()
// (ctx.prepareMaterial in feature modules) so the whole valley shares one look.

import * as THREE from 'three';
import { globalUniforms as G } from '../core/uniforms.js';
import { addShaderPatch } from './shaderPatch.js';
import { aoUniforms, AO_MATERIAL_PARS, AO_MATERIAL_APPLY } from './gtao.js';

/* ------------------------------------------------------------------ shared tileable noise
 * RGBA8, mipmapped, repeat-wrapped. Used by the sky clouds (atmosphere.js) and the drifting
 * cloud shadows below. R = value fbm (large shapes), G = inverted Worley fbm (round billows),
 * B = second fbm seed (cirrus / variation), A = fine inverted Worley (cauliflower detail). */
function tileValue(S, cells, seed) {
  const lat = new Float32Array(cells * cells);
  let s = seed >>> 0;
  for (let i = 0; i < lat.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; lat[i] = s / 4294967296; }
  const out = new Float32Array(S * S);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < S; y++) {
    const fy = (y / S) * cells, y0 = Math.floor(fy), ty = sm(fy - y0), y1 = (y0 + 1) % cells;
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, x0 = Math.floor(fx), tx = sm(fx - x0), x1 = (x0 + 1) % cells;
      const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1], c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
      out[y * S + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}
function tileWorley(S, cells, seed) {
  const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells);
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < px.length; i++) { px[i] = r(); py[i] = r(); }
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x / S) * cells, fy = (y / S) * cells, cx = Math.floor(fx), cy = Math.floor(fy);
    let best = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
      const dx = gx + px[k] - fx, dy = gy + py[k] - fy;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    out[y * S + x] = 1 - Math.min(1, Math.sqrt(best));
  }
  return out;
}
function fbmOf(gen, S, base, oct, seed) {
  const out = new Float32Array(S * S);
  let w = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    const n = gen(S, base << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * w;
    tot += w; w *= 0.5;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) { const v = out[i] / tot; out[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn || 1);
  return out;
}
let cloudNoiseTex = null;
export function getCloudNoise() {
  if (cloudNoiseTex) return cloudNoiseTex;
  const S = 256;
  const ch = [fbmOf(tileValue, S, 4, 6, 11), fbmOf(tileWorley, S, 5, 3, 23), fbmOf(tileValue, S, 3, 6, 57), fbmOf(tileWorley, S, 14, 2, 91)];
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(ch[c][i] * 255);
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  cloudNoiseTex = t;
  return t;
}

/* ------------------------------------------------------------------ extra atmosphere uniforms
 * All default to 0 = "off", so shaders that include FOG_PARS_GLSL without binding them (and the
 * rainforest, which never sets them) keep the original look. Set by atmosphere.js from presets. */
export const atmoUniforms = {
  uFogChroma: { value: new THREE.Vector3() },   // extra extinction per channel (rgb), added to 1
  uCloudShadow: { value: 0 },                   // 0..1 how much a cloud shadow dims direct sun
  uCSParams: { value: new THREE.Vector3(1 / 4200, 0.55, 0.14) }, // 1/tile size (m), coverage threshold, edge softness
  uCSOffset: { value: new THREE.Vector2() },    // drift (uv), advanced by atmosphere.js
  tCloudNoise: { value: null },
};

// Uniform declarations + functions. Needs uCamPos, uFog*, uSunDir in scope.
export const FOG_PARS_GLSL = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uFogAmb;
uniform vec3 uFogHigh;
uniform vec3 uFogSunC;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform vec3 uFogChroma;

// Colour of fog seen along direction rd (sky-ish gradient + glow toward light).
vec3 fogColorDir(vec3 rd) {
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  float mu = max(dot(rd, uSunDir), 0.0);
  vec3 c = mix(uFogAmb, uFogHigh, smoothstep(0.45, 1.0, up));
  c += uFogSunC * (0.10 * pow(mu, 4.0) + 0.25 * pow(mu, 32.0));
  return c;
}

// Optical depth of exp height fog between camera and p.
float fogOpticalDepth(vec3 ro, vec3 p) {
  vec3 d = p - ro;
  float t = length(d);
  float dy = d.y;
  float a = uFogDensity * exp(-uFogFalloff * ro.y);
  float k = uFogFalloff * dy;
  float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  return a * t * f;
}

vec3 applyHeightFog(vec3 col, vec3 worldPos) {
  vec3 rd = normalize(worldPos - uCamPos);
  float od = fogOpticalDepth(uCamPos, worldPos);
  // per-channel extinction (Rayleigh-ish: blue goes first → distant ridges turn blue in layers)
  vec3 T = exp(-od * (1.0 + uFogChroma));
  return mix(fogColorDir(rd), col, T);
}
`;

// Drifting cumulus shadows: the cloud layer (~1.4 km up) projected along the sun onto the ground.
// Evaluated per VERTEX (the shadows are hundreds of metres across), so grass overdraw costs nothing.
const CLOUD_SHADOW_VERT = /* glsl */ `
uniform vec3 uCSSun;
uniform float uCloudShadow;
uniform vec3 uCSParams;
uniform vec2 uCSOffset;
uniform sampler2D tCloudNoise;
varying float vCloudSh;
`;
const CLOUD_SHADOW_CALC = /* glsl */ `
  vCloudSh = 1.0;
  if (uCloudShadow > 0.0) {
    vec2 csQ = vFogWorldPos.xz + uCSSun.xz / max(uCSSun.y, 0.12) * (1400.0 - vFogWorldPos.y);
    vec2 csUV = csQ * uCSParams.x + uCSOffset;
    vec4 csA = texture2D(tCloudNoise, csUV);
    float csN = csA.r * 0.6 + csA.g * 0.25 + texture2D(tCloudNoise, csUV * 3.1 + 0.37).r * 0.15;
    vCloudSh = 1.0 - uCloudShadow * smoothstep(uCSParams.y, uCSParams.y + uCSParams.z, csN);
  }
`;

function bindFogUniforms(shader) {
  shader.uniforms.uCamPos = G.uCamPos;
  shader.uniforms.uSunDir = G.uSunDir;
  shader.uniforms.uFogAmb = G.uFogAmb;
  shader.uniforms.uFogHigh = G.uFogHigh;
  shader.uniforms.uFogSunC = G.uFogSunC;
  shader.uniforms.uFogDensity = G.uFogDensity;
  shader.uniforms.uFogFalloff = G.uFogFalloff;
  shader.uniforms.uFogChroma = atmoUniforms.uFogChroma;
}

// World position varying that works for plain, instanced and skinned meshes.
const WORLDPOS_VERT = /* glsl */ `
  {
    vec4 fwp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      fwp = instanceMatrix * fwp;
    #endif
    vFogWorldPos = (modelMatrix * fwp).xyz;
  }
`;

function heightFogPatch(shader) {
  bindFogUniforms(shader);
  shader.uniforms.uCSSun = G.uSunDir;
  shader.uniforms.uCloudShadow = atmoUniforms.uCloudShadow;
  shader.uniforms.uCSParams = atmoUniforms.uCSParams;
  shader.uniforms.uCSOffset = atmoUniforms.uCSOffset;
  shader.uniforms.tCloudNoise = atmoUniforms.tCloudNoise;
  const lit = shader.fragmentShader.includes('#include <lights_fragment_end>');
  // screen-space AO on indirect light only (render/gtao.js; off = one uniform branch)
  if (lit) Object.assign(shader.uniforms, aoUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorldPos;\n' + (lit ? CLOUD_SHADOW_VERT : ''))
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERT + (lit ? CLOUD_SHADOW_CALC : ''));
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorldPos;\n' + FOG_PARS_GLSL + (lit ? 'varying float vCloudSh;\n' + AO_MATERIAL_PARS : ''))
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
    reflectedLight.directDiffuse *= vCloudSh; reflectedLight.directSpecular *= vCloudSh;
    ${AO_MATERIAL_APPLY}`)
    .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyHeightFog(gl_FragColor.rgb, vFogWorldPos);');
}

// Rain-soaked look: darker albedo, glossier, strongest on upward-facing surfaces.
function wetnessPatch(shader) {
  shader.uniforms.uWetness = G.uWetness;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uWetness;')
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      float wetUp = clamp(normalize((vec4(normal, 0.0) * viewMatrix).xyz).y * 0.6 + 0.55, 0.0, 1.0);
      float wetK = uWetness * wetUp;
      roughnessFactor = mix(roughnessFactor, max(roughnessFactor * 0.55, 0.34), wetK);
      diffuseColor.rgb *= mix(1.0, 0.75, wetK);`,
    );
}

/**
 * Apply shared look to a built-in material (MeshStandardMaterial / MeshPhysicalMaterial /
 * MeshLambertMaterial / MeshBasicMaterial). Idempotent.
 *   opts.wet  — default true for Standard/Physical; pass false for emissive/glow things.
 */
export function prepareMaterial(material, opts = {}) {
  addShaderPatch(material, 'hfog', heightFogPatch);
  const isPBR = material.isMeshStandardMaterial || material.isMeshPhysicalMaterial;
  if (isPBR && opts.wet !== false) addShaderPatch(material, 'wet', wetnessPatch);
  material.fog = false; // we replace three's fog entirely
  return material;
}

/** Uniforms to spread into a custom ShaderMaterial that uses FOG_PARS_GLSL. */
export function fogUniforms() {
  return {
    uCamPos: G.uCamPos, uSunDir: G.uSunDir, uFogAmb: G.uFogAmb, uFogHigh: G.uFogHigh,
    uFogSunC: G.uFogSunC, uFogDensity: G.uFogDensity, uFogFalloff: G.uFogFalloff,
    uFogChroma: atmoUniforms.uFogChroma,
  };
}
