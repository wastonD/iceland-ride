// Nitro exhaust for the electric longboard: two small additive cone flames (outer + core), a
// thin short light trail and a billboard mesh (nozzle glints + a few sparks). Deliberately
// small and dim:
// flame 0.3–0.6 m, HDR peak ~1.5–2.5 only in a few-cm core so bloom/halation don't turn it
// into a blob; nothing big enough to block a first-person or chase view. Board space.
//
//   const nitro = createNitro();  board.group.add(nitro.group);
//   nitro.update(dt, throttle01, speed, timeSeconds);   // throttle 0 = extinguished

import * as THREE from 'three';
import { mulberry32, smoothstep, clamp } from '../core/noise.js';

export const NOZZLE_X = 0.028;
export const NOZZLE_Y = -0.02;
export const NOZZLE_Z = -0.488;

const FLAME_VERT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vRim;
varying float vPh;
void main() {
  vUv = uv;
  float t = uv.x;
  float ph = instanceMatrix[3].x * 60.0;
  vPh = ph;
  vec3 p = position;
  // flicker: the tail whips sideways, length breathes
  float w = t * t;
  p.x += w * 0.30 * sin(uTime * 41.0 + t * 8.0 + ph);
  p.y += w * 0.30 * sin(uTime * 33.0 + t * 6.0 + ph * 1.7);
  p.z *= 1.0 + 0.07 * sin(uTime * 53.0 + ph);
  mat4 M = modelMatrix * instanceMatrix;
  vec4 wp = M * vec4(p, 1.0);
  vec3 rd = normalize(mat3(M) * vec3(position.xy, 0.0) + 1e-5);
  vRim = abs(dot(rd, normalize(cameraPosition - wp.xyz)));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FLAME_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
uniform float uIgnite;
uniform float uFall;
uniform float uGain;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
varying vec2 vUv;
varying float vRim;
varying float vPh;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float t = vUv.x;
  float a = vUv.y;
  float n1 = vnoise(vec2(a * 6.0 + vPh, t * 6.0 - uTime * 22.0));
  float n2 = vnoise(vec2(a * 13.0, t * 15.0 - uTime * 40.0));
  float streak = 0.45 + 0.75 * n1 + 0.35 * n2;
  float body = pow(max(1.0 - t, 0.0), uFall);
  float rim = 0.35 + 0.65 * vRim;
  float I = body * rim * streak;
  vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.55, t));
  col = mix(col, uColC, smoothstep(0.35, 1.0, t));
  col *= I * uPower * (1.0 + 0.9 * uIgnite) * uGain;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPARK_VERT = /* glsl */ `
varying vec3 vC;
varying vec2 vQ;
varying float vK;
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(vec3(instanceMatrix[0]));
  mv.xy += position.xy * s;
  vC = instanceColor;
  vQ = position.xy;
  vK = instanceMatrix[1].x;
  gl_Position = projectionMatrix * mv;
}
`;
const SPARK_FRAG = /* glsl */ `
varying vec3 vC;
varying vec2 vQ;
varying float vK;
void main() {
  float d = length(vQ);
  float g;
  if (vK > 0.5) { float x = (d - 0.72) / 0.14; g = exp(-x * x) * smoothstep(1.0, 0.88, d); }
  else { g = max(1.0 - d, 0.0); g = g * g * (0.35 + 0.65 * g); }
  gl_FragColor = vec4(vC * g, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Long, camera-facing light trail: a ribbon along the board's -Z axis that always turns its face to the camera.
const TRAIL_VERT = /* glsl */ `
uniform float uLen;
uniform float uWidth;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 ax = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, -1.0));
  vec3 p = c + ax * uv.x * uLen;
  vec3 tc = normalize(cameraPosition - p + vec3(0.0, 0.7, 0.0));
  vec3 side = normalize(cross(ax, tc));
  float w = uWidth * (1.0 - 0.75 * uv.x);
  p += side * (uv.y * 2.0 - 1.0) * w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const TRAIL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float u = vUv.x;
  float v = abs(vUv.y * 2.0 - 1.0);
  float across = pow(max(1.0 - v, 0.0), 1.6);
  float fade = pow(max(1.0 - u, 0.0), 1.8) * smoothstep(0.0, 0.03, u);
  float n = vnoise(vec2(u * 10.0 - uTime * 7.0, vUv.y * 4.0));
  float I = across * fade * (0.55 + 0.8 * n) * uPower;
  vec3 col = mix(vec3(0.15, 0.85, 1.0), vec3(0.45, 0.12, 1.0), smoothstep(0.05, 0.9, u));
  gl_FragColor = vec4(col * I, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// unit flame: axis +Z (0 = nozzle, 1 = tip), radius profile baked in, uv = (t, angle/2π)
function flameGeometry(seg = 10, rad = 12) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= seg; j++) {
    const t = j / seg;
    const r = Math.pow(1 - t, 0.8) * (1 + 0.3 * Math.sin(Math.min(t * 3.0, Math.PI)));
    for (let i = 0; i <= rad; i++) {
      const a = (i / rad) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, t);
      uv.push(t, i / rad);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < rad; i++) {
      const a = j * (rad + 1) + i, b = a + rad + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), 2);
  return g;
}

function flameMaterial(colA, colB, colC, fall, gain) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uPower: { value: 0 }, uIgnite: { value: 0 }, uFall: { value: fall }, uGain: { value: gain },
      uColA: { value: new THREE.Color(...colA) },
      uColB: { value: new THREE.Color(...colB) },
      uColC: { value: new THREE.Color(...colC) },
    },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const N_SPARK = 6;
const B_HALO = 0, B_RING = 1, B_NOZ = 2, B_SPARK = 4;   // billboard instance layout

export function createNitro() {
  const group = new THREE.Group();
  group.name = 'nitro';
  group.position.set(0, NOZZLE_Y, NOZZLE_Z);

  const geo = flameGeometry();
  const outerMat = flameMaterial([0.04, 0.55, 1.0], [0.03, 0.28, 1.0], [0.48, 0.07, 1.0], 1.0, 0.75);
  const coreMat = flameMaterial([0.8, 1.0, 1.2], [0.25, 0.85, 1.0], [0.1, 0.5, 1.0], 1.6, 1.9);
  const outer = new THREE.InstancedMesh(geo, outerMat, 2);
  const core = new THREE.InstancedMesh(geo, coreMat, 2);
  for (const m of [outer, core]) {
    m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.renderOrder = 20;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }

  // camera-facing light trail
  const trailGeo = (() => {
    const seg = 28, pos = [], uv = [], idx = [];
    for (let j = 0; j <= seg; j++) {
      const u = j / seg;
      pos.push(0, 0, 0, 0, 0, 0);
      uv.push(u, 0, u, 1);
    }
    for (let j = 0; j < seg; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  })();
  const trailMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uLen: { value: 3 }, uWidth: { value: 0.2 } },
    vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false; trail.castShadow = false; trail.receiveShadow = false; trail.renderOrder = 19;
  trail.visible = false;
  group.add(trail);

  // billboards: halo, ignition ring, nozzle halos, sparks
  const quad = new THREE.PlaneGeometry(2, 2);
  const sparkMat = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const nb = B_SPARK + N_SPARK;
  const bill = new THREE.InstancedMesh(quad, sparkMat, nb);
  bill.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nb * 3), 3);
  bill.frustumCulled = false; bill.castShadow = false; bill.receiveShadow = false; bill.renderOrder = 21;
  bill.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(bill);

  const rng = mulberry32(777);
  const sp = { age: new Float32Array(N_SPARK), life: new Float32Array(N_SPARK), p: new Float32Array(N_SPARK * 3), v: new Float32Array(N_SPARK * 3), size: new Float32Array(N_SPARK) };
  sp.age.fill(1); sp.life.fill(1);
  let next = 0;
  function spawn(life, size, speed) {
    const k = next; next = (next + 1) % N_SPARK;
    sp.age[k] = 0; sp.life[k] = life; sp.size[k] = size;
    sp.p[k * 3] = (rng() < 0.5 ? -1 : 1) * NOZZLE_X + (rng() - 0.5) * 0.02;
    sp.p[k * 3 + 1] = (rng() - 0.5) * 0.02;
    sp.p[k * 3 + 2] = -0.02 - rng() * 0.15;
    sp.v[k * 3] = (rng() - 0.5) * 0.5;
    sp.v[k * 3 + 1] = 0.05 + rng() * 0.25;
    sp.v[k * 3 + 2] = -(0.8 + speed * 0.22 + rng() * 0.8);
  }

  const S = { n: 0, ign: 0, ring: 1, prevOn: false, spawnT: 0, wasBurning: false };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const pos = new THREE.Vector3(), sc = new THREE.Vector3(), qi = new THREE.Quaternion();
  const setBill = (i, kind) => { m.compose(pos, qi, sc); m.elements[4] = kind; bill.setMatrixAt(i, m); };

  function update(dt, thr, speed, T) {
    const on = thr > 0.05;
    if (on && !S.prevOn) { S.ign = 1; S.ring = 0; }      // ignition flash + shock ring
    S.prevOn = on;
    if (on) S.n += (thr - S.n) * (1 - Math.exp(-18 * dt));
    else S.n *= Math.exp(-16 * dt);                      // snaps back when released
    S.ign *= Math.exp(-dt / 0.11);
    S.ring = Math.min(1, S.ring + dt / 0.25);
    if (S.n < 0.01) S.n = 0;

    const burning = S.n > 0.02;
    if (S.wasBurning && !burning) { spawn(0.4, 0.014, speed); spawn(0.3, 0.011, speed); }
    S.wasBurning = burning;
    if (burning && S.n > 0.35) {
      S.spawnT -= dt;
      if (S.spawnT <= 0) { S.spawnT = 0.07 + rng() * 0.07; spawn(0.18 + rng() * 0.12, 0.007 + rng() * 0.005, speed); }
    }

    outer.visible = core.visible = trail.visible = burning;
    const fast = smoothstep(6, 16, speed);
    const ig = S.ign, n = S.n;
    if (burning) {
      const L = (0.16 + 0.26 * n) * (1 + 0.3 * fast) * (1 + 0.12 * ig);           // 0.42 m full throttle, ~0.55 m fast
      const R = 0.03 * (0.6 + 0.4 * n) * (1 - 0.2 * fast) * (1 + 0.3 * ig);
      for (let i = 0; i < 2; i++) {
        const sx = i === 0 ? -1 : 1;
        pos.set(sx * NOZZLE_X, 0, 0);
        sc.set(R, R, L);
        outer.setMatrixAt(i, m.compose(pos, q, sc));
        sc.set(R * 0.4, R * 0.4, L * 0.42);
        core.setMatrixAt(i, m.compose(pos, q, sc));
      }
      outer.instanceMatrix.needsUpdate = true; core.instanceMatrix.needsUpdate = true;
      const pw = (0.35 + 0.65 * n) * (1 + 0.35 * ig);
      outerMat.uniforms.uPower.value = pw; coreMat.uniforms.uPower.value = pw;
      outerMat.uniforms.uIgnite.value = coreMat.uniforms.uIgnite.value = ig;
      outerMat.uniforms.uTime.value = coreMat.uniforms.uTime.value = T;
      // light trail: thin and short — 0.4 m at rest, ~0.85 m when fast
      trailMat.uniforms.uLen.value = n * (0.4 + 0.45 * fast) * (1 + 0.15 * ig);
      trailMat.uniforms.uWidth.value = 0.025 + 0.01 * n + 0.008 * ig;
      trailMat.uniforms.uPower.value = n * (0.32 + 0.18 * fast) * (1 + 0.4 * ig);
      trailMat.uniforms.uTime.value = T;
    }

    // billboards: big soft halo, ignition ring, nozzle halos, sparks
    const ic = bill.instanceColor;
    const hR = burning ? 0.10 * (0.6 + 0.4 * n) * (1 + 0.3 * ig) : 0;
    const hb = burning ? n * (0.22 + 0.3 * ig) : 0;
    pos.set(0, 0.06, -0.06); sc.set(hR, hR, hR); setBill(B_HALO, 0);
    ic.setXYZ(B_HALO, 0.10 * hb, 0.55 * hb, 1.0 * hb);
    const rr = S.ring;
    const ringOn = rr < 1 ? 1 : 0;
    const rs = 0.03 + 0.13 * (1 - (1 - rr) * (1 - rr));
    pos.set(0, 0.02, -0.08); sc.set(rs * ringOn, rs * ringOn, rs * ringOn); setBill(B_RING, 1);
    const rb = 1.1 * (1 - rr) * (1 - rr) * ringOn;
    ic.setXYZ(B_RING, 0.35 * rb, 1.0 * rb, 1.5 * rb);
    const halo = burning ? (0.028 + 0.012 * n + 0.012 * ig) : 0;
    const nb2 = burning ? (0.45 + 0.6 * n + 0.6 * ig) : 0;
    for (let i = 0; i < 2; i++) {
      pos.set((i === 0 ? -1 : 1) * NOZZLE_X, 0, -0.012);
      sc.set(halo, halo, halo);
      setBill(B_NOZ + i, 0);
      ic.setXYZ(B_NOZ + i, 0.25 * nb2, 0.85 * nb2, 1.2 * nb2);
    }
    for (let k = 0; k < N_SPARK; k++) {
      const i = B_SPARK + k;
      if (sp.age[k] >= sp.life[k]) { sc.set(0, 0, 0); pos.set(0, 0, 0); setBill(i, 0); ic.setXYZ(i, 0, 0, 0); continue; }
      sp.age[k] += dt;
      const u = sp.age[k] / sp.life[k];
      const damp = Math.exp(-2.2 * dt);
      sp.v[k * 3] *= damp; sp.v[k * 3 + 1] = sp.v[k * 3 + 1] * damp - 0.3 * dt; sp.v[k * 3 + 2] *= damp;
      for (let a = 0; a < 3; a++) sp.p[k * 3 + a] += sp.v[k * 3 + a] * dt;
      pos.set(sp.p[k * 3], sp.p[k * 3 + 1], sp.p[k * 3 + 2]);
      const s = sp.size[k] * (1 - 0.6 * u);
      sc.set(s, s, s);
      setBill(i, 0);
      const b = 2.2 * (1 - u) * (1 - u);
      ic.setXYZ(i, 0.35 * b, 1.0 * b, 1.3 * b);
    }
    bill.instanceMatrix.needsUpdate = true; ic.needsUpdate = true;
    return S.n;
  }

  function dispose() {
    geo.dispose(); quad.dispose(); trailGeo.dispose(); outerMat.dispose(); coreMat.dispose(); sparkMat.dispose(); trailMat.dispose();
  }
  update(0, 0, 0, 0);
  return { group, update, dispose, state: S };
}
