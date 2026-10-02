// Screen-space reflections for water surfaces (custom ShaderMaterials include SSR_GLSL and
// spread ssrUniforms into their uniforms; the pipeline fills the values every frame).
//
// The water is drawn in the same pass as everything else, so it cannot read this frame's
// colour/depth. It traces against LAST frame instead: the TAA history (linear HDR scene colour,
// no bars/grain/bloom) and the half-res linear depth that the AO pass writes (render/gtao.js),
// both in last frame's camera (uSSRVP). The world is static, so a world-space ray projected with
// last frame's matrix is exact; only moving things (the rider) lag by one frame.
// Rays march with exponentially growing steps (×1.6: ≈1 m → 5 km in 18 steps) then bisect; misses,
// rays leaving the screen/picture band, and rays toward the sky fall back to the caller's
// reflection (sky PMREM / planar mirror).

import * as THREE from 'three';

export const ssrUniforms = {
  tSSRColor: { value: null },
  tSSRDepth: { value: null },
  uSSRVP: { value: new THREE.Matrix4() },
  uSSROn: { value: 0 },
  uSSRBars: { value: 0 },        // letterbox bar height (uv), nothing valid under the bars
  uSSRFrame: { value: 0 },
  uSSRFar: { value: 9000 },
  uSSRDebug: { value: 0 },       // 1: reflection = (confidence, march step / 18, 1) on hits, black on misses
};

export const SSR_GLSL = /* glsl */ `
uniform sampler2D tSSRColor, tSSRDepth;
uniform mat4 uSSRVP;
uniform float uSSROn, uSSRBars, uSSRFrame, uSSRFar, uSSRDebug;
float ssrZ(vec2 uv) { return texelFetch(tSSRDepth, ivec2(uv * vec2(textureSize(tSSRDepth, 0))), 0).g; }
// rgb = reflected scene colour, a = confidence (0 = use your own fallback)
vec4 ssrTrace(vec3 wp, vec3 R, float camDist) {
  if (uSSROn < 0.5 || R.y < -0.05) return vec4(0.0);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uSSRFrame * vec2(5.588238, 3.1764), vec2(0.06711056, 0.00583715))));
  float t = max(0.6, camDist * 0.006) * (0.75 + 0.5 * jit), tPrev = 0.0;
  vec2 res = vec2(textureSize(tSSRDepth, 0));
  vec4 c0 = uSSRVP * vec4(wp, 1.0);
  vec2 uv0 = c0.xy / c0.w * 0.5 + 0.5;
  for (int i = 0; i < 18; i++) {
    vec4 c = uSSRVP * vec4(wp + R * t, 1.0);
    if (c.w < 0.05) return vec4(0.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < uSSRBars || uv.y > 1.0 - uSSRBars) return vec4(0.0);
    // the depth buffer holds the water surface itself: no hits until the ray is a few texels away
    vec2 dpx = (uv - uv0) * res;
    if (dot(dpx, dpx) < 9.0) { tPrev = t; t *= 1.6; continue; }
    float sz = ssrZ(uv);
    float dz = c.w - sz;
    if (dz > 0.0 && sz < uSSRFar * 0.9) {
      // in front of a thick surface (mountains, houses…) = hit; far behind a thin near thing
      // (the rider, a post) = the ray passed behind it, keep marching
      if (dz < max(0.35 * sz, 1.5)) {
        float a = tPrev, b = t;
        for (int k = 0; k < 5; k++) {
          float m = 0.5 * (a + b);
          vec4 cm = uSSRVP * vec4(wp + R * m, 1.0);
          if (cm.w > ssrZ(cm.xy / cm.w * 0.5 + 0.5)) b = m; else a = m;
        }
        vec4 cb = uSSRVP * vec4(wp + R * b, 1.0);
        uv = cb.xy / cb.w * 0.5 + 0.5;
        float band = 1.0 - 2.0 * uSSRBars;
        vec2 q = vec2(uv.x, (uv.y - uSSRBars) / max(band, 0.1));
        vec2 e = smoothstep(0.0, 0.07, q) * smoothstep(0.0, 0.07, 1.0 - q);
        float conf = e.x * e.y;
        if (uSSRDebug > 0.5) return vec4(conf, float(i) / 18.0, 1.0, 1.0);
        return vec4(texture2D(tSSRColor, uv).rgb, conf);
      }
    }
    tPrev = t;
    t *= 1.6;
  }
  return uSSRDebug > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
}`;
