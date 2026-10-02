// Photo-scanned rocks (env/photoAssets.js) for the fjord.
//   photoRockMaterial()  — MeshStandardMaterial sampling the 3-layer rock arrays (layer per vertex,
//                          aRL), re-tinted toward dark basalt, optional moss on top faces.
//   createPhotoRocks()   — CPU-placed InstancedMeshes, one per rock shape (3 draw calls): roadside,
//                          scree, pasture, canyon and shore rocks plus the big boulders, which take
//                          over from the procedural boulders inside `swapR` (cross-shrink, no pop).
//                          Instances are re-selected around the camera (grid + frustum), sorted so
//                          that only the near ones are drawn into the shadow map.
import * as THREE from 'three';
import { addShaderPatch } from '../../../render/shaderPatch.js';
import { addBakedLight, tgn, riverDistJS } from './terrainData.js';
import { groundUniforms } from './groundTex.js';
import { featureClearJS, pastureJS, gorgeInfo, bayR, FEATURES } from './features.js';
import { mulberry32, smoothstep, lerp } from '../../../core/noise.js';

const ROCK_PARS_V = /* glsl */ `
attribute float aRL;
varying float vRL; varying vec2 vRUv; varying vec3 vRWN; varying vec3 vRWP;
#ifdef PH_MOSS
attribute vec2 aRk;
varying vec2 vRk;
#endif
`;
const ROCK_PARS_F = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uRAlb, uRNrm, uGAlb, uGNrm;
uniform vec4 uRMean[3];
uniform vec4 uGMean[8];
uniform float uRRecol[3];
uniform vec3 uRTint;
uniform float uRNStr;
varying float vRL; varying vec2 vRUv; varying vec3 vRWN; varying vec3 vRWP;
#ifdef PH_MOSS
varying vec2 vRk;
#endif
float phH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float phN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(phH(i), phH(i + vec2(1, 0)), f.x), mix(phH(i + vec2(0, 1)), phH(i + vec2(1, 1)), f.x), f.y); }
`;
const ROCK_MAP = /* glsl */ `
  int rLi = int(vRL + 0.5);
  vec4 rA, rN;
  vec3 rDet, rBumpW = vec3(0.0);
  bool rTri = rLi == 2;
  if (rTri) {
    // big boulder: its scan atlas has many tiny UV islands that a 20x decimation smears into the
    // padding — shade it with world-space triplanar basalt (ground layer 2) instead
    vec3 tw = pow(abs(vRWN), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
    vec3 tp = vRWP / 2.4;
    vec4 ax = texture(uGAlb, vec3(tp.zy, 2.0)), ay = texture(uGAlb, vec3(tp.xz, 2.0)), az = texture(uGAlb, vec3(tp.xy, 2.0));
    vec4 nx = texture(uGNrm, vec3(tp.zy, 2.0)), ny = texture(uGNrm, vec3(tp.xz, 2.0)), nz = texture(uGNrm, vec3(tp.xy, 2.0));
    rA = ax * tw.x + ay * tw.y + az * tw.z;
    rN = nx * tw.x + ny * tw.y + nz * tw.z;
    vec2 bx = nx.xy * 2.0 - 1.0, by = ny.xy * 2.0 - 1.0, bz = nz.xy * 2.0 - 1.0;
    rBumpW = tw.x * vec3(0.0, bx.y, bx.x) + tw.y * vec3(by.x, 0.0, by.y) + tw.z * vec3(bz.x, bz.y, 0.0);
    rDet = rA.rgb / max(uGMean[2].rgb, vec3(0.003));
  } else {
    rA = texture(uRAlb, vec3(vRUv, float(rLi)));
    rN = texture(uRNrm, vec3(vRUv, float(rLi)));
    rDet = rA.rgb / max(uRMean[rLi].rgb, vec3(0.003));
  }
#ifdef PH_DETAIL_ONLY
  diffuseColor.rgb *= rDet;
#else
  float rRc = uRRecol[rLi];
  #ifdef PH_MOSS
  rRc = max(rRc, vRk.y);
  #endif
  // re-tinted toward basalt; the photo's own contrast (lichen/moss blotches) is compressed with it
  diffuseColor.rgb *= mix(rA.rgb, pow(rDet, vec3(0.65)) * uRTint, rRc);
  #ifdef PH_MOSS
  {
    // moss / lichen cushions on the up-facing parts (world-space, never stretched)
    float mn = phN(vRWP.xz * 2.3 + vRWP.y) * 0.6 + phN(vRWP.xz * 7.1 - vRWP.y * 3.0) * 0.4;
    float mk = smoothstep(0.35, 0.8, vRWN.y + (mn - 0.5) * 0.9) * vRk.x;
    vec3 mc = texture(uGAlb, vec3(vRWP.xz / 1.4, 0.0)).rgb / max(uGMean[0].rgb, vec3(0.004));
    mc = pow(mc, vec3(0.7)) * mix(vec3(0.06, 0.09, 0.025), vec3(0.11, 0.12, 0.06), phN(vRWP.xz * 0.7));
    diffuseColor.rgb = mix(diffuseColor.rgb, mc, mk * 0.9);
  }
  #endif
#endif
`;
const ROCK_NORMAL = /* glsl */ `
  if (rTri) {
    vec3 N0 = normal;
    normal = normalize(N0 + mat3(viewMatrix) * rBumpW * 0.9);
  } else {
    // cotangent frame from the model uv (no tangent attribute); G is stored flipped (glTF uv)
    vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
    vec2 st0 = dFdx(vRUv), st1 = dFdy(vRUv);
    vec3 N0 = normal;
    vec3 q1p = cross(q1, N0), q0p = cross(N0, q0);
    vec3 T = q1p * st0.x + q0p * st1.x, B = q1p * st0.y + q0p * st1.y;
    float d2 = max(dot(T, T), dot(B, B));
    float sc = d2 == 0.0 ? 0.0 : inversesqrt(d2);
    vec2 nb = rN.xy * 2.0 - 1.0;
    normal = normalize(N0 + (T * nb.x + B * nb.y) * sc * uRNStr);
    float nd = dot(normal, N0);              // never tilt past ~70° (scan normal maps on a decimated mesh)
    if (nd < 0.35) normal = normalize(normal + N0 * (0.35 - nd) * 1.5);
  }
`;

let RU = null;
function rockUniforms(R) {
  if (RU && RU._src === R) return RU;
  RU = {
    _src: R,
    uRAlb: { value: R.albedo }, uRNrm: { value: R.normal },
    uRMean: { value: R.mean.map((m) => new THREE.Vector4(m[0], m[1], m[2], m[3])) },
    // per model: how far its own photo colour is pulled toward basalt (moss set keeps its moss)
    uRRecol: { value: [0.85, 0.7, 0.88] },
    uRTint: { value: new THREE.Vector3(0.062, 0.058, 0.053) },
    uRNStr: { value: 0.8 },
  };
  return RU;
}

/** detailOnly: albedo = photo / mean (colour comes from vertex/instance colour, e.g. field tint). */
export function photoRockMaterial(ctx, td, R, { detailOnly = false, moss = false, vertexColors = false } = {}) {
  const GU = groundUniforms(), U = rockUniforms(R);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors });
  // decimated scans + low sun: front-face shadow casting gives faceted self-shadow acne along the
  // terminator; casting from back faces keeps the lit side clean
  m.shadowSide = THREE.BackSide;
  m.defines = { ...(m.defines || {}) };
  if (detailOnly) m.defines.PH_DETAIL_ONLY = '';
  if (moss) m.defines.PH_MOSS = '';
  addShaderPatch(m, 'photoRock' + (detailOnly ? 'D' : '') + (moss ? 'M' : ''), (shader) => {
    Object.assign(shader.uniforms, U, { uGAlb: GU.uGAlb, uGNrm: GU.uGNrm, uGMean: GU.uGMean });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS_V)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      vRL = aRL; vRUv = uv;
      #ifdef PH_MOSS
      vRk = aRk;
      #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
      {
        mat4 rm = modelMatrix;
        #ifdef USE_INSTANCING
          rm = modelMatrix * instanceMatrix;
        #endif
        vRWP = (rm * vec4(transformed, 1.0)).xyz;
        vRWN = normalize(mat3(rm) * objectNormal);
      }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS_F)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + ROCK_MAP)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(rN.z, 0.3, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + ROCK_NORMAL);
  });
  addBakedLight(m, td, { aoStrength: 0.75 });
  ctx.prepareMaterial(m);
  return m;
}

/* ------------------------------------------------------------ placement */
// JS mirror of terrDetail() (the vertex shader's hummocks) so rocks sit on the rendered ground
function detailH(world, x, z, ny, h) {
  let amp = 0.34 * smoothstep(0.62, 0.85, ny) * smoothstep(6.5, 15, world.roadDistAt(x, z)) * smoothstep(0.4, 3.5, h);
  if (amp <= 0) return 0;
  amp *= lerp(0.15, 1, smoothstep(110, 190, Math.hypot(x + 40, (z - 900) * 1.4)));
  amp *= smoothstep(9, 16, riverDistJS(x, z));
  if (amp <= 0) return 0;
  const n1 = tgn(x / 6.5 + 3.1, z / 6.5 + 3.1), n2 = tgn(x / 3.1 + 7.7, z / 3.1 + 7.7);
  return (n1 * n1 * 1.6 - 0.45) * amp * 0.62 + (n2 - 0.5) * amp * 0.3;
}

const T_BOULDER = 0, T_TALL = 1, T_FLAT = 2;
const CELL = 64;
// visibility radius (m) per class and quality; big boulders use the swap radius
const RAD = { high: 190, medium: 140, low: 95, eco: 70 };
const SWAP = { high: 300, medium: 210, low: 140, eco: 110 };
const SHADOW = { high: 55, medium: 38, low: 0, eco: 0 };

export function createPhotoRocks(ctx, td, R, { boulders = [], reef = [] } = {}) {
  const { world, camera } = ctx;
  const rnd = mulberry32(5150);
  const items = [];
  const nv = new THREE.Vector3();
  const geos = [R.geos.boulder, R.geos.mossTall, R.geos.mossFlat];
  const village = world.landmarks.village;
  function add(x, z, size, type, moss, tint, recol, opt = {}) {
    const h = td.heightAt(x, z);
    td.normalAt(x, z, nv);
    const g = geos[type], hr = g.userData.height;
    const y = h + detailH(world, x, z, nv.y, h);
    const slope = 1 - nv.y;
    const sy = size * (opt.flat ?? (0.75 + rnd() * 0.5));
    const bury = (opt.bury ?? (0.12 + rnd() * 0.2)) * hr * sy + slope * size * 0.35 + 0.04;
    items.push({
      x, y: y - bury, z, s: size, sy, sx: size * (0.85 + rnd() * 0.3), yaw: rnd() * Math.PI * 2,
      tx: (rnd() - 0.5) * 0.25 + nv.z * 0.5, tz: (rnd() - 0.5) * 0.25 - nv.x * 0.5,
      type, moss, tint: tint * (0.85 + rnd() * 0.3), recol, big: !!opt.big, keep: opt.keep ?? (() => true),
      r: size * 0.8 + 0.5,
    });
  }
  const okGround = (x, z, h, ny) => h > 1.2 && ny > 0.6 && Math.hypot(x - village.x, (z - village.z) * 1.3) > 170;

  // 1. the procedural boulder population (same positions/sizes), swapped in near the camera
  boulders.forEach((b) => {
    const type = b.size > 2.3 ? T_BOULDER : b.r < 0.5 ? T_TALL : T_FLAT;
    add(b.x, b.z, b.size * 1.15, type, 0.55, 1.0, 0, { big: true, keep: b.keep, bury: 0.16 });
  });
  // 1b. black basalt reef rocks on the beach (procedural ones collapse inside swapR as well)
  reef.forEach((b) => add(b.x, b.z, b.size * 1.1, b.r < 0.6 ? T_BOULDER : T_FLAT, 0, 0.42, 1, { big: true, bury: 0.22 }));
  // 2. roadside rocks (outside the shoulder; ≤ 0.45 m within 3 m of the asphalt edge)
  const P = world.path, pt = new THREE.Vector3(), tan = new THREE.Vector3();
  for (let s = 20; s < P.length - 20; s += 3.2) {
    if (rnd() > 0.32 || P.isTunnel?.(s) || P.isBridge?.(s)) continue;
    P.pointAt(s, pt); P.tangentAt(s, tan);
    const side = rnd() < 0.5 ? -1 : 1, off = 6.6 + Math.pow(rnd(), 1.7) * 26;
    const x = pt.x - tan.z * off * side, z = pt.z + tan.x * off * side;
    const h = td.heightAt(x, z); td.normalAt(x, z, nv);
    if (!okGround(x, z, h, nv.y) || world.roadDistAt(x, z) < 6.3 || riverDistJS(x, z) < 12 || featureClearJS(x, z) < 0.5) continue;
    let size = 0.3 + Math.pow(rnd(), 2.2) * 1.3;
    if (world.roadDistAt(x, z) < 7.5) size = Math.min(size, 0.5);
    add(x, z, size, rnd() < 0.45 ? T_TALL : rnd() < 0.8 ? T_FLAT : T_BOULDER, 0.35 + rnd() * 0.3, 1, 0);
  }
  // 3. scree slopes / plateau / pasture / canyon / shore
  for (let k = 0; k < 9000 && items.length < boulders.length + 2600; k++) {
    let x, z;
    if (rnd() < 0.6) {
      const s = rnd() * P.length; P.pointAt(s, pt); P.tangentAt(s, tan);
      const side = rnd() < 0.5 ? -1 : 1, off = 30 + Math.pow(rnd(), 1.5) * 420;
      x = pt.x - tan.z * off * side; z = pt.z + tan.x * off * side;
    } else { z = -1600 + rnd() * 2500; x = world.valleyX(Math.max(z, -1400)) + (rnd() * 2 - 1) * 900; }
    if (Math.abs(x) > 2000 || Math.abs(z) > 2000) continue;
    const h = td.heightAt(x, z); td.normalAt(x, z, nv);
    const rd = world.roadDistAt(x, z);
    if (rd < 9 || h < 0.4) continue;
    const go = gorgeInfo(x, z), br = bayR(x, z), pa = pastureJS(x, z);
    const slope = 1 - nv.y;
    if (go.mask > 0.5 && go.d < go.w * 0.55) {                  // canyon floor: rounded cobbles & blocks
      if (rnd() < 0.5) add(x, z, 0.5 + Math.pow(rnd(), 2) * 2.2, rnd() < 0.6 ? T_BOULDER : T_FLAT, 0.2, 0.8, 0.6);
    } else if (br > 0.85 && br < 1.12 && h < 4) {               // black-sand shore: dark, wet, no moss
      if (rnd() < 0.6) add(x, z, 0.35 + Math.pow(rnd(), 2) * 1.6, rnd() < 0.7 ? T_BOULDER : T_FLAT, 0.0, 0.45, 1.0, { bury: 0.25 });
    } else if (pa > 0.4) {                                      // home field: few, half-sunk, mossy
      if (rnd() < 0.1 && nv.y > 0.85) add(x, z, 0.4 + rnd() * 0.7, rnd() < 0.5 ? T_TALL : T_FLAT, 0.9, 1, 0, { bury: 0.35 });
    } else if (slope > 0.12 && slope < 0.45 && h > 50) {        // scree slopes
      if (rnd() < 0.55 && featureClearJS(x, z) > 0.5) add(x, z, 0.5 + Math.pow(rnd(), 2) * 1.9, rnd() < 0.55 ? T_FLAT : T_BOULDER, 0.15, 0.9, 0.3);
    } else if (okGround(x, z, h, nv.y) && featureClearJS(x, z) > 0.7 && rnd() < 0.18) {
      add(x, z, 0.4 + Math.pow(rnd(), 2.4) * 1.4, rnd() < 0.5 ? T_TALL : T_FLAT, 0.5, 1, 0);
    }
  }

  // spatial grid
  const grid = new Map();
  items.forEach((it, i) => {
    const k = Math.floor(it.x / CELL) * 4096 + Math.floor(it.z / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  // meshes
  const mat = photoRockMaterial(ctx, td, R, { moss: true });
  const CAP = 1500;
  const meshes = geos.map((g, t) => {
    const mesh = new THREE.InstancedMesh(g, mat, CAP);
    const rk = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2);
    rk.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aRk', rk);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'photoRocks' + t;
    mesh.userData.nShadow = 0;
    mesh.onBeforeShadow = function () { this.userData.nMain = this.count; this.count = this.userData.nShadow; };
    mesh.onAfterShadow = function () { this.count = this.userData.nMain; };
    return mesh;
  });
  const group = new THREE.Group();
  group.name = 'photoRocks';
  group.add(...meshes);

  let qn = '';
  // footprint mask for the GPU flora fields (grass / lupine / pebbles skip cells under a rock)
  const OCC_N = 2048, occ = new Uint8Array(OCC_N * OCC_N);
  const occTex = new THREE.DataTexture(occ, OCC_N, OCC_N, THREE.RedFormat, THREE.UnsignedByteType);
  occTex.minFilter = occTex.magFilter = THREE.LinearFilter; occTex.generateMipmaps = false;
  function stampOcc() {
    occ.fill(0);
    const res = 4096 / OCC_N;
    for (const it of items) {
      if (it.big && !it.keep(qn || 'medium')) continue;
      const r = Math.min(it.sx, it.s) * 0.42;                     // inner part of the footprint
      if (r < 0.5) continue;
      const cx = (it.x + 2048) / res, cz = (it.z + 2048) / res, rr = r / res + 0.5;
      for (let j = Math.floor(cz - rr); j <= Math.ceil(cz + rr); j++) for (let i = Math.floor(cx - rr); i <= Math.ceil(cx + rr); i++) {
        if (i < 0 || j < 0 || i >= OCC_N || j >= OCC_N) continue;
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) * res;
        const v = Math.round(255 * Math.min(1, Math.max(0, (r - d) / (r * 0.4))));
        const k = j * OCC_N + i;
        if (v > occ[k]) occ[k] = v;
      }
    }
    occTex.needsUpdate = true;
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p3 = new THREE.Vector3(), col = new THREE.Color();
  const sph = new THREE.Sphere();
  const near = [[], [], []], rest = [[], [], []];
  const lastPos = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3();
  let frames = 0;
  const stats = { instances: 0, ms: 0 };

  function write(mesh, list, start, rkA) {
    let n = start;
    for (const [it, k] of list) {
      if (n >= CAP) break;
      q.setFromEuler(e.set(it.tx, it.yaw, it.tz));
      sc.set(it.sx * k, it.sy * k, it.s * k);
      m4.compose(p3.set(it.x, it.y, it.z), q, sc);
      mesh.setMatrixAt(n, m4);
      mesh.setColorAt(n, col.setRGB(it.tint, it.tint * 0.98, it.tint * 0.96));
      rkA[n * 2] = it.moss; rkA[n * 2 + 1] = it.recol;
      n++;
    }
    return n;
  }

  return {
    group, items, stats,
    occTex,
    setQuality(q) { if (q !== qn) { qn = q; stampOcc(); } lastPos.set(1e9, 0, 0); },
    get swapR() { return SWAP[qn] ?? 200; },
    update(cam, frustum, force = false) {
      cam.getWorldDirection(dir);
      frames++;
      if (!force && cam.position.distanceToSquared(lastPos) < 0.36 && dir.dot(lastDir) > 0.9995 && frames % 8) return;
      const a = performance.now();
      lastPos.copy(cam.position); lastDir.copy(dir);
      const rad = RAD[qn] ?? 140, swap = SWAP[qn] ?? 200, shD = SHADOW[qn] ?? 0;
      const reach = Math.max(rad, swap);
      const cx = cam.position.x, cz = cam.position.z;
      for (let t = 0; t < 3; t++) { near[t].length = 0; rest[t].length = 0; }
      const i0 = Math.floor((cx - reach) / CELL), i1 = Math.floor((cx + reach) / CELL);
      const j0 = Math.floor((cz - reach) / CELL), j1 = Math.floor((cz + reach) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const cell = grid.get(i * 4096 + j);
        if (!cell) continue;
        for (const idx of cell) {
          const it = items[idx];
          const d = Math.hypot(it.x - cx, it.z - cz);
          let k;
          if (it.big) { if (!it.keep(qn)) continue; k = 1 - smoothstep(swap - 25, swap, d); }
          else k = 1 - smoothstep(rad * 0.75, rad, d * (it.s > 1.2 ? 0.7 : 1));
          if (k <= 0.001) continue;
          const inShadow = d < shD + it.r;
          if (!inShadow) {
            sph.center.set(it.x, it.y + it.s * 0.3, it.z); sph.radius = it.r * 1.5 + 2 + d * 0.04;
            if (!frustum.intersectsSphere(sph)) continue;
          }
          (inShadow ? near : rest)[it.type].push([it, k]);
        }
      }
      let total = 0;
      meshes.forEach((mesh, t) => {
        const rkA = mesh.geometry.attributes.aRk;
        const nN = write(mesh, near[t], 0, rkA.array);
        const n = write(mesh, rest[t], nN, rkA.array);
        mesh.count = n; mesh.userData.nShadow = shD > 0 ? nN : 0;
        mesh.castShadow = shD > 0 && nN > 0;
        for (const at of [mesh.instanceMatrix, mesh.instanceColor, rkA]) {
          at.clearUpdateRanges(); at.addUpdateRange(0, Math.max(1, n) * at.itemSize); at.needsUpdate = true;
        }
        total += n;
      });
      stats.instances = total;
      stats.ms = performance.now() - a;
    },
    dispose() {
      meshes.forEach((m) => m.dispose());
      mat.dispose();
    },
  };
}
