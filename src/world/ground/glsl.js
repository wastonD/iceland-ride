// Shared GLSL snippets for the ground / water shaders.

export const NOISE_GLSL = /* glsl */ `
float gh(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), f.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * gn(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return s / 0.9375;
}
// value noise + analytic derivatives (xy = d/dp)
vec3 gnd(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = gh(i), b = gh(i + vec2(1.0, 0.0)), c = gh(i + vec2(0.0, 1.0)), d = gh(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y,
              du * (vec2(b - a, c - a) + k * u.yx));
}
`;

// Rain rings. Returns d(height)/d(xz) of the summed ripple field at world xz.
// rain: 0..1 intensity, t: seconds. Needs gh() from NOISE_GLSL.
export const RIPPLE_GLSL = /* glsl */ `
vec2 rainRipples(vec2 p, float t, float rain) {
  vec2 g = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 2.3 : 3.9;
    vec2 q = p * sc + float(k) * 13.7;
    vec2 cell = floor(q), f = fract(q) - 0.5;
    float h1 = gh(cell), h2 = gh(cell + 17.3), h3 = gh(cell + 41.7);
    float rate = 0.7 + 0.7 * h2;
    float ph = fract(t * rate + h1);
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

// Ground-layer texture arrays + triplanar rock sampler (shared by terrain and rocks).
// Needs NOISE_GLSL? no. Declares uAlb / uNrm.
export const TEX_GLSL = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uAlb;
uniform sampler2DArray uNrm;
const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);

void sampleRock(vec3 p, vec3 N, out vec3 alb, out vec4 nm, out vec3 bump) {
  vec3 w = pow(abs(N), vec3(4.0));
  w /= (w.x + w.y + w.z);
  float s = 2.6;
  vec3 aX = texture(uAlb, vec3(p.zy / s, 3.0)).rgb;
  vec3 aY = texture(uAlb, vec3(p.xz / s, 3.0)).rgb;
  vec3 aZ = texture(uAlb, vec3(p.xy / s, 3.0)).rgb;
  vec4 nX = texture(uNrm, vec3(p.zy / s, 3.0));
  vec4 nY = texture(uNrm, vec3(p.xz / s, 3.0));
  vec4 nZ = texture(uNrm, vec3(p.xy / s, 3.0));
  vec3 fY = texture(uAlb, vec3(ROT * p.xz / (s * 0.29) + 0.13, 3.0)).rgb;
  vec4 mY = texture(uNrm, vec3(ROT * p.xz / (s * 0.29) + 0.13, 3.0));
  alb = aX * w.x + aY * w.y + aZ * w.z;
  alb = mix(alb, alb * (fY / max(dot(fY, vec3(0.333)), 0.05)) * 0.9, 0.35 * w.y);
  vec2 x = nX.xy * 2.0 - 1.0, y = nY.xy * 2.0 - 1.0, z = nZ.xy * 2.0 - 1.0, f = mY.xy * 2.0 - 1.0;
  bump = w.x * vec3(0.0, x.y, x.x) + w.y * vec3(y.x, 0.0, y.y) + w.z * vec3(z.x, z.y, 0.0);
  bump += w.y * 0.5 * vec3(dot(f, vec2(0.8, -0.6)), 0.0, dot(f, vec2(0.6, 0.8)));
  nm = vec4(0.0, 0.0, nX.z * w.x + nY.z * w.y + nZ.z * w.z, nX.w * w.x + nY.w * w.y + nZ.w * w.z);
}
`;
