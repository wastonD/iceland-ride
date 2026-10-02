// Temporal anti-aliasing (+ temporal upsampling when the scene is rendered below output size).
//
//   scene is rendered with a sub-pixel jittered projection (Halton 2,3; 16 phases)
//   resolve: reconstruct the current frame at the output pixel from the 3×3 jittered samples
//            (Blackman-Harris-like weights → this is also the TAAU upsampler), reproject the
//            history with depth + last frame's camera (closest depth of a 5-tap cross, so
//            silhouettes move with the foreground), clip the history to the YCoCg variance box
//            of the neighbourhood (kills ghosting from wind-blown grass, animals, the rider),
//            blend in a tonemapped space (bright speckles can't flicker).
//   The rider moves with the camera: pixels inside its bounding sphere are reprojected with
//   the rider's own motion instead of assuming a static world.
// The history is linear HDR and feeds bloom + composite; grain / dither / bars come after.

export const HALTON = (() => {
  const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const out = [];
  for (let i = 1; i <= 16; i++) out.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
  return out;
})();

export const TAA_FRAG = /* glsl */ `
uniform sampler2D tCur, tDepth, tHist, tVol;   // tVol: half-res volumetric scatter, added to the scene here
uniform mat4 uCurToPrev;     // prevVP · inverse(curVP), unjittered: current NDC → previous clip
uniform mat4 uInvVPRel;      // inverse(proj · camera rotation): NDC → camera-relative world (homogeneous)
uniform vec3 uRiderRel;      // rider centre relative to the camera (m)
uniform vec4 uRiderClipDelta;// prevVP · (riderMotion, 0)
uniform float uRiderR;       // 0 = no rider
uniform vec2 uJitter;        // render pixels: a sample at pixel centre c shows the unjittered point c + uJitter
uniform vec2 uRenderSize, uOutSize;
uniform float uAlpha, uReset, uBars, uGamma, uVolOn;
varying vec2 vUv;

vec3 rgb2y(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 y2rgb(vec3 y) { return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
// reversible tonemap: blending/clipping here makes HDR highlights behave like LDR ones
vec3 tm(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }

vec3 fetchCur(vec2 uv) {
  vec3 c = texture2D(tCur, uv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  if (uVolOn > 0.5) c += texture2D(tVol, uv).rgb;
  return rgb2y(tm(min(c, vec3(60.0))));
}

// Catmull-Rom history, 5 bilinear taps (corners dropped)
vec3 histCR(vec2 uv) {
  vec2 sp = uv * uOutSize, tc = floor(sp - 0.5) + 0.5, f = sp - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t12 = (tc + w2 / w12) / uOutSize, t0 = (tc - 1.0) / uOutSize, t3 = (tc + 2.0) / uOutSize;
  float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
  vec3 r = texture2D(tHist, vec2(t12.x, t0.y)).rgb * a + texture2D(tHist, vec2(t0.x, t12.y)).rgb * b
         + texture2D(tHist, t12).rgb * c + texture2D(tHist, vec2(t3.x, t12.y)).rgb * d
         + texture2D(tHist, vec2(t12.x, t3.y)).rgb * e;
  return max(r / (a + b + c + d + e), 0.0);
}

vec3 clipBox(vec3 mn, vec3 mx, vec3 h) {
  vec3 c = 0.5 * (mx + mn), e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = h - c, a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? c + v / m : h;
}

void main() {
  float by = min(vUv.y, 1.0 - vUv.y);
  if (uBars > 0.0 && by < uBars - 0.004) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 rTex = 1.0 / uRenderSize;
  vec2 rp = vUv * uRenderSize;               // this output pixel in render pixels
  vec2 rc = floor(rp) + 0.5;                 // centre of the render pixel it falls in
  vec2 toOut = uOutSize / uRenderSize;
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), mn = vec3(1e9), mx = vec3(-1e9), cur = vec3(0.0);
  float wsum = 0.0, wmax = 0.0, dmin = 1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 uv = (rc + o) * rTex;
    vec3 y = fetchCur(uv);
    m1 += y; m2 += y * y; mn = min(mn, y); mx = max(mx, y);
    vec2 d = (rc + o + uJitter - rp) * toOut;
    float w = exp(-2.29 * dot(d, d));
    cur += y * w; wsum += w; wmax = max(wmax, w);
    if (i == 0 || j == 0) dmin = min(dmin, texture2D(tDepth, uv).x);
  }
  cur /= wsum;
  vec3 mean = m1 / 9.0, sig = sqrt(max(m2 / 9.0 - mean * mean, 0.0));

  // reprojection (closest depth of the cross → edges follow the foreground)
  vec4 ndc = vec4(vUv * 2.0 - 1.0, dmin * 2.0 - 1.0, 1.0);
  vec4 pc = uCurToPrev * ndc;
  if (uRiderR > 0.0) {
    vec4 wr = uInvVPRel * ndc;
    float k = 1.0 - smoothstep(uRiderR * 0.75, uRiderR, length(wr.xyz / wr.w - uRiderRel));
    pc -= wr.w * k * uRiderClipDelta;
  }
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool off = pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)));
  float velPx = length((vUv - puv) * uOutSize);

  vec3 hist = rgb2y(tm(histCR(puv)));
  // variance box (tighter while moving: fewer ghosts), intersected with the min/max box
  float g = mix(uGamma, 0.9, clamp(velPx / 8.0, 0.0, 1.0));
  vec3 bmn = max(mn, mean - g * sig), bmx = min(mx, mean + g * sig);
  hist = clipBox(bmn, bmx, hist);

  // current-frame weight: base, more when a jittered sample lands right on this pixel (TAAU),
  // more while moving fast (history resampling would otherwise blur)
  float alpha = uAlpha * mix(0.55, 1.0, wmax);
  alpha = mix(alpha, 0.3, clamp((velPx - 2.0) / 40.0, 0.0, 1.0));
  if (off || uReset > 0.5) alpha = 1.0;
  vec3 res = mix(hist, cur, alpha);
  gl_FragColor = vec4(itm(y2rgb(res)), 1.0);
}`;
