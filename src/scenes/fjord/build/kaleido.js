// Kaleidoscope light-tunnel shaders (tunnel lining + glowing road strip).
// uv = (arc-length from the crown | lateral offset, metres from the tunnel start).
import * as THREE from 'three';
import { FOG_PARS_GLSL, fogUniforms } from '../../../render/fog.js';

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const COMMON = /* glsl */ `
${FOG_PARS_GLSL}
uniform float uTime, uFlow, uRot, uLen, uSpeed;
varying vec2 vUv;
varying vec3 vWorld;
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
// saturated palette: cyan -> violet -> pink -> gold -> (back to cyan)
vec3 pal(float t) {
  float x = fract(t) * 4.0; int i = int(floor(x)); float f = smoothstep(0.0, 1.0, fract(x));
  vec3 c0 = vec3(0.02, 0.62, 0.95), c1 = vec3(0.42, 0.12, 0.92), c2 = vec3(0.95, 0.14, 0.55), c3 = vec3(0.98, 0.62, 0.06);
  vec3 a = i == 0 ? c0 : (i == 1 ? c1 : (i == 2 ? c2 : c3));
  vec3 b = i == 0 ? c1 : (i == 1 ? c2 : (i == 2 ? c3 : c0));
  return mix(a, b, f);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// p.x: position around the tube (metres), p.y: distance along it (metres). 8-fold mirror symmetry.
// Output is linear HDR: peak <= ~1.2, average ~0.4.
vec3 kaleido(vec2 p) {
  const float PER = 3.7306;                       // 2*pi*R/8 for R = 4.75
  float a = abs(mod(p.x + uRot * 4.75, PER) - PER * 0.5) / (PER * 0.5);   // 0..1 mirrored
  float z = p.y + uFlow;                          // flows backwards (toward the entrance) as uFlow grows
  float n = fbm(vec2(a * 1.6, z * 0.07) + vec2(0.0, uTime * 0.05));
  vec3 col = pal(0.22 * a + 0.02 * z + 0.35 * n + 0.04 * sin(uTime * 0.3)) * (0.10 + 0.30 * n);
  // layer 1: diamonds
  vec2 c1 = fract(vec2(a * 1.6, z * 0.36)) - 0.5;
  float l1 = 1.0 - smoothstep(0.0, 0.10, abs(abs(c1.x) + abs(c1.y) - 0.34));
  // layer 2: rotating petals
  vec2 r2 = rot(uTime * 0.11 + z * 0.02) * vec2(a - 0.5, fract(z * 0.115) - 0.5);
  float l2 = 1.0 - smoothstep(0.0, 0.09, abs(length(r2 * vec2(1.0, 0.75)) - 0.27));
  // layer 3: travelling rings
  float l3 = (1.0 - smoothstep(0.0, 0.07, 0.5 - abs(fract(z * 0.06) - 0.5))) * (0.55 + 0.45 * sin(a * 9.0 + z * 0.15));
  // layer 4: sparkle lattice
  vec2 c4 = fract(vec2(a * 5.0, z * 1.1)) - 0.5;
  float l4 = (1.0 - smoothstep(0.0, 0.16, length(c4))) * (0.4 + 0.6 * vnoise(vec2(a * 9.0, z * 0.6 + uTime)));
  vec3 acc = pal(0.55 + 0.05 * z + 0.3 * a) * l1 * 0.55 + pal(0.12 + 0.04 * z - 0.3 * a) * l2 * 0.5 + vec3(0.98, 0.62, 0.08) * l3 * 0.42 + vec3(0.2, 0.7, 1.0) * l4 * 0.2;
  vec3 o = col + acc;
  o = pow(max(o, vec3(0.0)), vec3(1.12));                       // deepen the mid-tones: saturated, not milky
  return min(o, vec3(1.1)) * (1.0 + 0.06 * uSpeed);
}
`;

const WALL_FRAG = /* glsl */ `
${COMMON}
void main() {
  float dEnd = min(vUv.y, uLen - vUv.y);
  vec3 k = kaleido(vUv);
  // plain dark rock near the mouths, lit by daylight falling in
  float nr = fbm(vUv * vec2(0.9, 0.9));
  vec3 rock = vec3(0.09, 0.088, 0.095) * (0.55 + 1.1 * nr);
  rock *= 1.0 + 3.0 * exp(-dEnd * 0.22);
  float m = smoothstep(4.0, 22.0, dEnd);
  vec3 col = mix(rock, k, m);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ROAD_FRAG = /* glsl */ `
${COMMON}
void main() {
  float dEnd = min(vUv.y, uLen - vUv.y);
  vec3 k = kaleido(vec2(vUv.x * 1.2, vUv.y));
  float edge = 1.0 - smoothstep(3.2, 4.3, abs(vUv.x));
  float m = smoothstep(6.0, 26.0, dEnd);
  float a = m * (0.32 + 0.30 * edge);
  vec3 col = k;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createKaleidoMaterials(length) {
  const uniforms = () => ({ ...fogUniforms(), uTime: { value: 0 }, uFlow: { value: 0 }, uRot: { value: 0 }, uLen: { value: length }, uSpeed: { value: 0 } });
  const shared = uniforms();
  const wall = new THREE.ShaderMaterial({ uniforms: shared, vertexShader: VERT, fragmentShader: WALL_FRAG, side: THREE.DoubleSide });
  const road = new THREE.ShaderMaterial({ uniforms: shared, vertexShader: VERT, fragmentShader: ROAD_FRAG, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
  return { wall, road, uniforms: shared };
}
