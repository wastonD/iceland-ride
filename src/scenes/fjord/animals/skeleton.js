// GPU skeleton for the animals. One merged geometry per species, drawn as ONE InstancedMesh.
// Every vertex carries a joint id (`aA.x`); the vertex shader bends legs / neck / head / ears / tail
// from a handful of per-instance pose numbers, so the CPU only writes ~12 floats per animal per frame.
//
// Per-instance attributes (all written by animals.js):
//   instanceMatrix          body transform (position, yaw/pitch/roll from the terrain, scale)
//   aCoat  (rgb, seed+patch)   coat / wool colour; a = floor(seed) + patch amount (0..0.99)
//   aMane  (rgb, pointsMix)    mane/tail (or face/legs for sheep) colour; pointsMix: legs = coat(0) .. mane colour(1)
//   aPose0 (neckPitch, headPitch, lookYaw, tailYaw)             + pitch = head down, + yaw = look left
//   aPose1 (gaitPhase, gaitAmp[rad], gaitType 0 walk/1 trot/2 gallop, bob[m])
//   aPose2 (earL, earR, tailLift, extra)     extra = grazing stance (horse) / horn scale (sheep)
//
// Joint ids: 0 body/wool | 1 neck | 2 head (+eyes, forelock) | 3/4 ear L/R | 5 mane | 7 horn |
//            10/11 FL upper/lower, 12/13 FR, 14/15 HL, 16/17 HR | 20 tail
import * as THREE from 'three';
import { addShaderPatch } from '../../../render/shaderPatch.js';
import { globalUniforms as G } from '../../../core/uniforms.js';

const v3 = (a) => `vec3(${a.map((x) => x.toFixed(4)).join(',')})`;
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

function skelPars(S, depth) {
  const horse = !S.sheep;
  return /* glsl */ `
${depth ? 'attribute vec3 color;' : ''}
attribute vec4 aA;
attribute vec3 aT;
attribute vec4 aCoat;
attribute vec4 aMane;
attribute vec4 aPose0;
attribute vec4 aPose1;
attribute vec4 aPose2;
uniform float uTime;
varying vec3 vObj;
varying vec2 vPatch;

const vec3 P_NECK = ${v3(S.neck)};
const vec3 P_POLL = ${v3(S.poll)};
const vec3 P_EARL = ${v3(S.earL)};
const vec3 P_EARR = ${v3(S.earR)};
const vec3 P_TAIL = ${v3(S.tail)};
const vec3 P_HORN = ${v3(S.horn)};
const vec3 HIP0 = ${v3(S.hip[0])}; const vec3 HIP1 = ${v3(S.hip[1])}; const vec3 HIP2 = ${v3(S.hip[2])}; const vec3 HIP3 = ${v3(S.hip[3])};
const vec3 KNE0 = ${v3(S.knee[0])}; const vec3 KNE1 = ${v3(S.knee[1])}; const vec3 KNE2 = ${v3(S.knee[2])}; const vec3 KNE3 = ${v3(S.knee[3])};

mat3 rX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

vec3 legHip(int i) { return i == 0 ? HIP0 : i == 1 ? HIP1 : i == 2 ? HIP2 : HIP3; }
vec3 legKnee(int i) { return i == 0 ? KNE0 : i == 1 ? KNE1 : i == 2 ? KNE2 : KNE3; }
float legOff(int i, float g) {
  vec4 w = vec4(0.25, 0.75, 0.0, 0.5);     // FL FR HL HR : lateral 4-beat walk / tolt
  vec4 t = vec4(0.0, 0.5, 0.5, 0.0);       // diagonal trot
  vec4 c = vec4(0.0, 0.1, 0.5, 0.6);       // bounding gallop
  vec4 o = g < 1.0 ? mix(w, t, g) : mix(t, c, g - 1.0);
  return i == 0 ? o.x : i == 1 ? o.y : i == 2 ? o.z : o.w;
}

void skeleton(inout vec3 p, inout vec3 n, vec3 root) {
  int part = int(aA.x + 0.5);
  float sw = aA.y;
  float seed = fract(floor(aCoat.a) * 0.618);
  vec3 p0 = p;
  bool lowLeg = false;
  if (part >= 10 && part < 20) {
    int li = (part - 10) / 2;
    lowLeg = (part - 10 - li * 2) == 1;
    float t = fract(aPose1.x + legOff(li, aPose1.z));
    float st = 0.55, ang, kn;
    if (t < st) { float u = t / st; ang = mix(-1.0, 1.0, mix(u, 0.5 - 0.5 * cos(3.14159 * u), 0.3)); kn = 0.0; }
    else { float u = (t - st) / (1.0 - st); ang = mix(1.0, -1.0, smoothstep(0.0, 1.0, u)); kn = sin(3.14159 * u); }
    float A = aPose1.y;
    bool fr = li < 2;
    float kg = fr ? ${f(S.kneeGainF)} + 3.0 * max(0.0, A - 0.4) : ${f(S.kneeGainH)};
    float thU = A * ang;
    ${horse ? 'thU += (li == 0 ? -0.34 : (li == 1 ? 0.12 : 0.0)) * aPose2.w;' : ''}
    float thK = A * kn * kg;
    vec3 hip = legHip(li);
    if (lowLeg) { vec3 kv = legKnee(li); mat3 Rk = rX(thK); p = kv + Rk * (p - kv); n = Rk * n; }
    mat3 Ru = rX(thU); p = hip + Ru * (p - hip); n = Ru * n;
    ${horse ? '' : `p.y += ${f(S.legLift)} * kn * (A / 0.4) * clamp((hip.y - p0.y) / ${f(S.legLen)}, 0.0, 1.0);`}
  } else if (part == 20) {
    mat3 R = rY(aPose0.w) * rX(aPose2.z);
    p = P_TAIL + R * (p - P_TAIL); n = R * n;
    p.x += sw * sw * aPose0.w * ${horse ? '0.10' : '0.02'};
  } else {
    bool inHead = part == 2 || part == 3 || part == 4 || part == 7;
    bool inNeck = inHead || part == 1 || part == 5;
    if (part == 3) { mat3 R = ${horse ? 'rX(aPose2.x)' : 'rZ(aPose2.x)'}; p = P_EARL + R * (p - P_EARL); n = R * n; }
    if (part == 4) { mat3 R = ${horse ? 'rX(aPose2.y)' : 'rZ(-aPose2.y)'}; p = P_EARR + R * (p - P_EARR); n = R * n; }
    ${horse ? '' : 'if (part == 7) { p = P_HORN + (p - P_HORN) * aPose2.w; }'}
    if (inHead) { mat3 R = rY(aPose0.z * 0.45) * rX(aPose0.y); p = P_POLL + R * (p - P_POLL); n = R * n; }
    if (inNeck) {
      mat3 R = rY(aPose0.z * 0.55) * rX(aPose0.x);
      if (part == 5) {
        // locks hang from their root (stored in the colour attribute): the root follows the neck, the lock keeps falling
        mat3 Rh = rY(aPose0.z * 0.15) * rX(aPose0.x * ${f(S.maneHang)});
        p = P_NECK + R * (root - P_NECK) + Rh * (p - root); n = Rh * n;
      } else { p = P_NECK + R * (p - P_NECK); n = R * n; }
    }
  }
  ${S.hairAmp > 0 ? `
  if (sw > 0.0) {
    float wv = uTime * 1.5 + (aA.z + seed) * 6.2832;
    float a2 = sw * sw * ${f(S.hairAmp)};
    p.x += a2 * 0.04 * sin(wv); p.z += a2 * 0.03 * sin(wv * 0.63 + 1.7);
  }` : ''}
  ${horse ? 'if (!lowLeg) p.y += aPose1.w;' : 'p.y += aPose1.w;'}
}
`;
}

const COLOR_VERT = /* glsl */ `
{
  float seedI = floor(aCoat.a);
  vec3 ptsC = mix(aCoat.rgb, aMane.rgb, aMane.a);
  float wS = max(0.0, 1.0 - aT.x - aT.y - aT.z);
  vColor = (aCoat.rgb * aT.x + aMane.rgb * aT.y + ptsC * aT.z + color * wS) * aA.w;
  vObj = position;
  vPatch = vec2((aCoat.a - seedI) * aT.x, seedI * 0.137);
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vObj;
varying vec2 vPatch;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

function fragBody(S) {
  return /* glsl */ `
{
  float fn = vnoise(vObj * 13.0);
  diffuseColor.rgb *= (1.0 - ${f(S.fur)}) + ${f(S.fur)} * 2.0 * fn;
  diffuseColor.rgb *= mix(${f(S.aoMin)}, 1.0, smoothstep(${f(S.aoLo)}, ${f(S.aoHi)}, vObj.y));
  if (vPatch.x > 0.001) {
    float pn = vnoise(vObj * vec3(1.6, 2.2, 1.6) + vPatch.y) * 0.65 + vnoise(vObj * 4.3 + vPatch.y * 3.1) * 0.35;
    float m = smoothstep(0.0, 0.07, pn - (0.6 - 0.2 * vPatch.x));
    diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(S.patchCol)}, m);
  }
}
`;
}

export function makeAnimalMaterials(S, prepareMaterial) {
  const key = 'animal-' + S.name;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  prepareMaterial(mat);
  addShaderPatch(mat, key, (shader) => {
    shader.uniforms.uTime = G.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + skelPars(S, false))
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec3 skP = position; vec3 skN = objectNormal; skeleton(skP, skN, color); objectNormal = skN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = skP;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n' + COLOR_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + fragBody(S));
  });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  addShaderPatch(depth, key + '-depth', (shader) => {
    shader.uniforms.uTime = G.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + skelPars(S, true).replace('varying vec3 vObj;', '').replace('varying vec2 vPatch;', ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec3 skP = position; vec3 skN = vec3(0.0, 1.0, 0.0); skeleton(skP, skN, color); transformed = skP;');
  });
  return { mat, depth };
}

/** InstancedMesh with all per-instance attributes allocated. */
export function makeAnimalMesh(geometry, S, count, prepareMaterial) {
  const { mat, depth } = makeAnimalMaterials(S, prepareMaterial);
  const mesh = new THREE.InstancedMesh(geometry, mat, count);
  mesh.customDepthMaterial = depth;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const attrs = {};
  for (const name of ['aCoat', 'aMane', 'aPose0', 'aPose1', 'aPose2']) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    a.setUsage(name.startsWith('aPose') ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    geometry.setAttribute(name, a);
    attrs[name] = a;
  }
  return { mesh, attrs };
}
