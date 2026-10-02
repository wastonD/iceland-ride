// Ground-truth-style ambient occlusion (GTAO, Jimenez 2016 / XeGTAO), half resolution.
//
// Applied to INDIRECT light only (sky / hemisphere / environment), never to direct sun, so sunlit
// surfaces keep their brightness and only creases, contact points and the undersides of things
// darken. There is no depth pre-pass: AO is computed from this frame's depth after the scene
// pass, and lit materials read it NEXT frame by projecting their world position with the
// matrix it was computed with (static world → exact; a relative-depth test rejects texels that
// belong to another surface — disocclusions just get no AO for a frame). Its per-pixel noise is
// rotated every frame and averaged away by TAA, so AO only runs together with TAA.
//
// Target RGBA16F: r = visibility (1 = open), g = linear view depth (m), used for the material
// lookup's depth test and by screen-space reflections (render/ssr.js).

import * as THREE from 'three';

/** Shared by every lit material (patched in render/fog.js) — values set by the pipeline. */
export const aoUniforms = {
  tSSAO: { value: null },
  uSSAOVP: { value: new THREE.Matrix4() },
  uSSAOOn: { value: 0 },
  uSSAOStr: { value: 0.9 },      // 0..1 how much of the computed occlusion is applied
};

// Fragment chunk injected right after <lights_fragment_end> in lit built-in materials.
export const AO_MATERIAL_PARS = /* glsl */ `
uniform sampler2D tSSAO;
uniform mat4 uSSAOVP;
uniform float uSSAOOn, uSSAOStr;
`;
export const AO_MATERIAL_APPLY = /* glsl */ `
  if (uSSAOOn > 0.5) {
    vec4 aoC = uSSAOVP * vec4(vFogWorldPos, 1.0);
    vec2 aoUV = aoC.xy / aoC.w * 0.5 + 0.5;
    if (aoC.w > 0.0 && aoUV.x > 0.0 && aoUV.x < 1.0 && aoUV.y > 0.0 && aoUV.y < 1.0) {
      vec2 aoS = texture2D(tSSAO, aoUV).rg;
      float aoOk = 1.0 - smoothstep(0.03, 0.09, abs(aoS.y - aoC.w) / aoC.w);
      float aoV = mix(1.0, aoS.x, aoOk * uSSAOStr);
      reflectedLight.indirectDiffuse *= aoV;
      reflectedLight.indirectSpecular *= mix(1.0, aoV, 0.6);
    }
  }
`;

export const GTAO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uProjInfo;     // p00, p11, e8, e9 of the (jittered) projection used for the depth
uniform vec2 uNF;           // near, far
uniform vec2 uSize;         // AO target size
uniform float uRadius, uMaxPx, uFrame, uFadeEnd, uOn, uProjScale, uPower;
uniform int uSteps;
varying vec2 vUv;
#define HALF_PI 1.5707963
#define PI 3.1415926
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - z * (uNF.y - uNF.x)); }
vec3 vpos(vec2 uv) {
  float lz = linZ(texture2D(tDepth, uv).x);
  return vec3((uv * 2.0 - 1.0 + uProjInfo.zw) * lz / uProjInfo.xy, -lz);
}
float facos(float x) { float a = abs(x); float r = (-0.156583 * a + HALF_PI) * sqrt(max(1.0 - a, 0.0)); return x >= 0.0 ? r : PI - r; }

void main() {
  float d = texture2D(tDepth, vUv).x;
  float lz = linZ(d);
  if (uOn < 0.5 || d >= 0.99999 || lz > uFadeEnd) { gl_FragColor = vec4(1.0, lz, 0.0, 1.0); return; }
  vec3 P = vec3((vUv * 2.0 - 1.0 + uProjInfo.zw) * lz / uProjInfo.xy, -lz);
  vec2 px = 1.0 / uSize;
  vec3 Pr = vpos(vUv + vec2(px.x, 0.0)), Pl = vpos(vUv - vec2(px.x, 0.0));
  vec3 Pu = vpos(vUv + vec2(0.0, px.y)), Pd = vpos(vUv - vec2(0.0, px.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  float rPx = uRadius * uProjScale / lz;
  if (rPx < 1.5) { gl_FragColor = vec4(1.0, lz, 0.0, 1.0); return; }
  rPx = min(rPx, uMaxPx);
  // per-pixel + per-frame noise (TAA averages it)
  float n1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * vec2(5.588238, 3.1764), vec2(0.06711056, 0.00583715))));
  float n2 = fract(n1 * 1.61803 + 0.317 + uFrame * 0.381966);
  float fRange = 0.6 * uRadius;
  float fMul = -1.0 / fRange, fAdd = (uRadius - fRange) / fRange + 1.0;
  float vis = 0.0;
  const int SLICES = 2;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + n1) * PI / float(SLICES);
    vec2 om = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(om, 0.0);
    vec3 ortho = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(ortho, V));
    vec3 pn = N - axis * dot(N, axis);
    float pl = length(pn) + 1e-5;
    float cosN = clamp(dot(pn, V) / pl, 0.0, 1.0);
    float n = (dot(ortho, pn) >= 0.0 ? 1.0 : -1.0) * facos(cosN);
    float lo0 = cos(n + HALF_PI), lo1 = cos(n - HALF_PI);
    float hc0 = lo0, hc1 = lo1;
    for (int k = 0; k < 8; k++) {
      if (k >= uSteps) break;
      float st = (float(k) + n2) / float(uSteps);
      st = st * st * rPx + 1.0;
      vec2 off = om * st * px;
      vec3 d0 = vpos(vUv + off) - P, d1 = vpos(vUv - off) - P;
      float l0 = length(d0), l1 = length(d1);
      float c0 = mix(lo0, dot(d0 / l0, V), clamp(l0 * fMul + fAdd, 0.0, 1.0));
      float c1 = mix(lo1, dot(d1 / l1, V), clamp(l1 * fMul + fAdd, 0.0, 1.0));
      hc0 = max(hc0, c0); hc1 = max(hc1, c1);
    }
    float h0 = -facos(clamp(hc1, -1.0, 1.0)), h1 = facos(clamp(hc0, -1.0, 1.0));
    h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
    h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
    float sn = sin(n);
    vis += pl * ((cosN + 2.0 * h0 * sn - cos(2.0 * h0 - n)) + (cosN + 2.0 * h1 * sn - cos(2.0 * h1 - n))) * 0.25;
  }
  vis = clamp(vis / float(SLICES), 0.0, 1.0);
  vis = pow(vis, uPower);
  vis = mix(vis, 1.0, smoothstep(uFadeEnd * 0.5, uFadeEnd, lz));
  gl_FragColor = vec4(vis, lz, 0.0, 1.0);
}`;

// Depth-aware separable blur of the AO (g = depth passes through untouched).
export const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tSrc, vUv).rg;
  float sum = c.r, ws = 1.0;
  for (int i = -2; i <= 2; i++) {
    if (i == 0) continue;
    vec2 s = texture2D(tSrc, vUv + uDir * float(i)).rg;
    float w = exp(-float(i * i) * 0.3) * (1.0 - smoothstep(0.02, 0.07, abs(s.g - c.g) / c.g));
    sum += s.r * w; ws += w;
  }
  gl_FragColor = vec4(sum / ws, c.g, 0.0, 1.0);
}`;
