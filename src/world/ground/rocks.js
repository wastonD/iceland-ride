// Procedural boulders (InstancedMesh, subdivided icosahedron + noise + soft plane cuts),
// bank/pool/cliff scatter, and walkable flat-topped stepping stones at the two crossings.
//
//   createRocks(ctx) → { rockTopAt(x,z), stepStones, update, dispose }
// Stepping stones are NOT colliders — the player stands on them via rockTopAt.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addShaderPatch } from '../../render/shaderPatch.js';
import { mulberry32, smoothstep, clamp, lerp } from '../../core/noise.js';
import { getGroundTextures } from './groundTextures.js';
import { NOISE_GLSL, TEX_GLSL } from './glsl.js';

/* ------------------------------------------------------------ 3D value noise */
function h3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vn3(x, y, z, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (i, j, k) => h3(x0 + i, y0 + j, z0 + k, s);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm3(x, y, z, s, oct = 3) {
  let a = 0.5, f = 1, sum = 0, n = 0;
  for (let i = 0; i < oct; i++) { sum += a * vn3(x * f, y * f, z * f, s + i * 7); n += a; a *= 0.5; f *= 2.07; }
  return sum / n;
}

/* ----------------------------------------------------------------- geometry */
const softMin = (a, b, k) => 0.5 * (a + b - Math.sqrt((a - b) * (a - b) + k * k));

function makeRockGeometry({ seed, detail, squash = [1, 0.75, 0.9], lump = 0.3, planes = 5, slab = false }) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g, 1e-4);
  const rnd = mulberry32(seed);
  const cuts = [];
  for (let k = 0; k < planes; k++) {
    const n = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.7 + (slab ? 0 : 0.15), rnd() * 2 - 1).normalize();
    if (slab) n.y = Math.abs(n.y) * 0.3 - 0.1; // side cuts only (top is cut separately)
    n.normalize();
    cuts.push({ n, o: 0.68 + rnd() * 0.22 });
  }
  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  const ox = rnd() * 50, oy = rnd() * 50, oz = rnd() * 50;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const l = Math.hypot(dx, dy, dz) || 1;
    const d = new THREE.Vector3(dx / l, dy / l, dz / l);
    let r = 1 + lump * (fbm3(d.x * 1.4 + ox, d.y * 1.4 + oy, d.z * 1.4 + oz, seed, 3) - 0.5) * 2
      + 0.055 * (fbm3(d.x * 4.3 + oy, d.y * 4.3 + oz, d.z * 4.3 + ox, seed + 3, 2) - 0.5) * 2
      + 0.012 * (vn3(d.x * 14, d.y * 14, d.z * 14, seed + 5) - 0.5) * 2;
    p.copy(d).multiplyScalar(r);
    p.x *= squash[0]; p.y *= squash[1]; p.z *= squash[2];
    for (const c of cuts) {
      const dist = p.dot(c.n) - c.o;
      const s = 0.5 * (dist + Math.sqrt(dist * dist + 0.004));
      p.addScaledVector(c.n, -s * 0.92);
    }
    if (slab) {
      const cutY = 0.5 * squash[1];
      p.y = softMin(p.y, cutY, 0.10) - cutY; // flat top at y = 0
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/* ------------------------------------------------------------------ material */
const ROCK_GLSL = /* glsl */ `
${TEX_GLSL}
${NOISE_GLSL}
varying vec3 vRW;
varying vec3 vRN;
`;

function rockPatch(shader) {
  const tex = getGroundTextures();
  shader.uniforms.uAlb = { value: tex.albedo };
  shader.uniforms.uNrm = { value: tex.normal };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRW;\nvarying vec3 vRN;')
    .replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 rq = vec4(transformed, 1.0);
        vec3 rn = normal;
        #ifdef USE_INSTANCING
          rq = instanceMatrix * rq;
          rn = mat3(instanceMatrix) * rn;
        #endif
        vRW = (modelMatrix * rq).xyz;
        vRN = normalize(mat3(modelMatrix) * rn);
      }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + ROCK_GLSL)
    .replace('#include <map_fragment>', `
      vec3 rWP = vRW;
      vec3 rN = normalize(vRN);
      vec3 rA; vec4 rNm; vec3 tBump;
      sampleRock(rWP, rN, rA, rNm, tBump);
      float rn1 = gfbm(rWP.xz * 0.8 + rWP.y * 0.6);
      float rn2 = gn(rWP.xz * 3.1 + rWP.y * 1.7);
      // moss: creeps over up-facing surfaces, fuzzy edge from the moss height map
      vec2 mUv = rWP.xz / 1.9;
      vec4 mN = texture(uNrm, vec3(mUv, 2.0));
      vec3 mA = texture(uAlb, vec3(mUv, 2.0)).rgb;
      float top = rN.y + (rn1 - 0.5) * 0.7 + (rn2 - 0.5) * 0.15;
      float mossW = smoothstep(0.32, 0.62, top);
      mossW = smoothstep(0.35, 0.7, mossW * 1.15 + (mN.z - 0.5) * 0.7 * mossW);
      // damp, dark lower band (splash zone)
      float dampB = 1.0 - smoothstep(0.0, 0.9, rN.y + 0.6);
      vec3 rockA = rA * (0.8 + 0.4 * rn1) * (1.0 - 0.3 * dampB);
      vec3 mossA = mA * (0.85 + 0.3 * rn2);
      diffuseColor.rgb = mix(rockA, mossA, mossW);
      tBump = mix(tBump * 0.7, vec3(mN.x * 2.0 - 1.0, 0.0, mN.y * 2.0 - 1.0) * 0.5, mossW);
      float tRoughV = mix(rNm.w, mN.w, mossW);
    `)
    .replace('#include <lights_physical_fragment>', 'roughnessFactor *= tRoughV;\n#include <lights_physical_fragment>')
    .replace('#include <normal_fragment_maps>', `{
        vec3 nW = inverseTransformDirection(normal, viewMatrix);
        nW = normalize(nW + tBump * 0.6);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      }`);
}

/* ------------------------------------------------------------------ the module */
export function createRocks(ctx) {
  const { scene, world, prepareMaterial } = ctx;
  const rnd = mulberry32(8080);
  const R = (a, b) => a + (b - a) * rnd();

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  addShaderPatch(mat, 'rocks', rockPatch);
  prepareMaterial(mat);

  // variants: 0..3 big rounded boulders, 4..5 small stones, 6..7 stepping slabs
  const variants = [
    makeRockGeometry({ seed: 11, detail: 6, squash: [1.0, 0.72, 0.9], lump: 0.26, planes: 5 }),
    makeRockGeometry({ seed: 22, detail: 6, squash: [1.1, 0.8, 0.85], lump: 0.32, planes: 4 }),
    makeRockGeometry({ seed: 33, detail: 6, squash: [0.9, 0.95, 1.0], lump: 0.22, planes: 6 }),
    makeRockGeometry({ seed: 44, detail: 6, squash: [1.2, 0.62, 0.95], lump: 0.3, planes: 4 }),
    makeRockGeometry({ seed: 55, detail: 4, squash: [1.0, 0.7, 0.85], lump: 0.3, planes: 4 }),
    makeRockGeometry({ seed: 66, detail: 4, squash: [1.0, 0.8, 1.0], lump: 0.28, planes: 5 }),
    makeRockGeometry({ seed: 77, detail: 6, squash: [1.0, 1.2, 1.0], lump: 0.12, planes: 3, slab: true }),
    makeRockGeometry({ seed: 88, detail: 6, squash: [1.05, 1.2, 0.95], lump: 0.14, planes: 3, slab: true }),
  ];
  const buckets = variants.map(() => []);

  const placed = []; // {x,z,r} to keep scatter from overlapping
  const near = (x, z, r) => placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r);
  const nrm = new THREE.Vector3();

  function addRock(v, x, z, s, opts = {}) {
    const sx = s * (opts.sx ?? R(0.85, 1.25)), sy = s * (opts.sy ?? R(0.75, 1.1)), sz = s * (opts.sz ?? R(0.85, 1.25));
    const yaw = R(0, Math.PI * 2);
    let y;
    if (opts.y != null) y = opts.y;
    else {
      const rr = 0.7 * s;
      const hmin = Math.min(world.heightAt(x, z), world.heightAt(x + rr, z), world.heightAt(x - rr, z), world.heightAt(x, z + rr), world.heightAt(x, z - rr));
      y = hmin + (opts.bury ?? 0.42) * sy;
    }
    const tilt = opts.tilt ?? 0.18;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(R(-tilt, tilt), yaw, R(-tilt, tilt), 'YXZ'));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
    const k = R(0.82, 1.12), warm = R(-0.05, 0.05);
    buckets[v].push({ m, c: new THREE.Color(k * (1 + warm), k, k * (1 - warm)) });
    const r = 0.8 * Math.max(sx, sz);
    if (!opts.noCollide && r >= 0.5) world.addCollider(x, z, r * 0.92);
    placed.push({ x, z, r: r * 0.7 });
  }

  /* ---- stepping stones across the two crossings ------------------------ */
  const stepStones = [];
  const waterSurfaceAt = (x, z) => {
    const s = world.streamSAt(x, z);
    const zc = world.streamPoints[Math.round(clamp(s, 0, 1) * (world.streamPoints.length - 1))].z;
    return world.streamYAtZ(zc) - 0.25;
  };
  function crossingFor(L) {
    const tp = world.trailPoints;
    let first = -1, last = -1;
    for (let i = 0; i < tp.length; i++) {
      if (Math.hypot(tp[i].x - L.x, tp[i].z - L.z) < 18 && world.waterDistAt(tp[i].x, tp[i].z) < 0.6) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0 && last - first >= 1) {
      const a = tp[first], b = tp[last];
      const d = new THREE.Vector2(b.x - a.x, b.z - a.z).normalize();
      return { a: new THREE.Vector2(a.x, a.z), b: new THREE.Vector2(b.x, b.z), d };
    }
    // fallback: straight across the stream through the landmark
    const s = world.streamSAt(L.x, L.z), i = Math.round(s * 700);
    const p0 = world.streamPoints[Math.max(0, i - 2)], p1 = world.streamPoints[Math.min(700, i + 2)];
    const t = new THREE.Vector2(p1.x - p0.x, p1.z - p0.z).normalize();
    const d = new THREE.Vector2(-t.y, t.x);
    const c = new THREE.Vector2(L.x, L.z);
    return { a: c.clone().addScaledVector(d, -3), b: c.clone().addScaledVector(d, 3), d };
  }
  for (const key of ['poolStones', 'streamStones']) {
    const L = world.landmarks[key];
    const { a, b, d } = crossingFor(L);
    const A = a.clone().addScaledVector(d, -1.8), B = b.clone().addScaledVector(d, 1.8);
    const len = A.distanceTo(B), n = Math.max(3, Math.round(len / 1.35) + 1);
    const perp = new THREE.Vector2(-d.y, d.x);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const p = A.clone().lerp(B, t).addScaledVector(perp, R(-0.16, 0.16)).addScaledVector(d, R(-0.12, 0.12));
      const s = R(0.56, 0.7);
      const ground = world.heightAt(p.x, p.y);
      const top = Math.max(waterSurfaceAt(p.x, p.y) + R(0.16, 0.26), ground + R(0.06, 0.14));
      const sy = R(0.9, 1.1);
      addRock(6 + (i & 1), p.x, p.y, s, { sx: 1, sz: R(0.9, 1.05), sy, y: top, tilt: 0.02, noCollide: true });
      stepStones.push({ x: p.x, z: p.y, r: 0.82 * s, top });
    }
  }
  world.stepStones = stepStones;
  const noStoneZone = (x, z, r) => stepStones.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + r + 1.5);

  /* ---- stream banks ------------------------------------------------------ */
  const sp = world.streamPoints;
  for (let i = 6; i < sp.length - 6; i += 1) {
    if (rnd() > 0.2) continue;
    const p = sp[i], q = sp[i + 1];
    const tx = q.x - p.x, tz = q.z - p.z, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    const side = rnd() < 0.5 ? -1 : 1;
    // half-width from the design: distance from centreline to edge where waterDist = 0
    let half = 2;
    for (let e = 1; e < 14; e += 0.5) { if (world.waterDistAt(p.x + nx * side * e, p.z + nz * side * e) > 0) { half = e; break; } }
    const off = half + R(-0.4, 2.6) * (rnd() < 0.7 ? 1 : 1.8);
    const x = p.x + nx * side * off + R(-0.6, 0.6), z = p.z + nz * side * off + R(-0.6, 0.6);
    if (!world.inBounds(x, z)) continue;
    if (Math.abs(z - world.waterfallZ) < 4.5 && Math.abs(x) < 20) continue;
    if (world.trailDistAt(x, z) < 2.4 || noStoneZone(x, z, 1.5)) continue;
    const big = rnd() < 0.22;
    const s = big ? R(0.9, 1.7) : R(0.28, 0.75);
    if (near(x, z, s * 0.6)) continue;
    addRock(big ? Math.floor(R(0, 4)) : 4 + Math.floor(R(0, 2)), x, z, s);
  }

  /* ---- plunge pool ring -------------------------------------------------- */
  const wf = world.landmarks.waterfall;
  let poolRocks = 0;
  for (let tries = 0; tries < 400 && poolRocks < 20; tries++) {
    const a = R(0, Math.PI * 2), rad = R(4.5, 17);
    const x = wf.x + Math.cos(a) * rad, z = wf.z + Math.sin(a) * rad * 0.9;
    if (z < world.waterfallZ + 1.5 && Math.abs(x) < 6) continue;
    const wd = world.waterDistAt(x, z);
    if (wd < -0.6 || wd > 6) continue;
    if (world.trailDistAt(x, z) < 2.6 || noStoneZone(x, z, 2)) continue;
    const s = wd < 0.2 ? R(0.7, 1.5) : R(1.2, 2.6);
    if (near(x, z, s * 0.7)) continue;
    addRock(Math.floor(R(0, 4)), x, z, s);
    poolRocks++;
  }

  /* ---- cliff face inlays ------------------------------------------------- */
  let cliffRocks = 0;
  for (let tries = 0; tries < 900 && cliffRocks < 30; tries++) {
    const x = R(-17, 17), z = R(world.waterfallZ - 3.2, world.waterfallZ + 1.8);
    world.normalAt(x, z, nrm);
    if (nrm.y > 0.82) continue;
    if (Math.abs(x + 0.4) < 4.6) continue; // keep the water curtain clear
    const s = R(0.8, 2.4);
    if (near(x, z, s * 0.5)) continue;
    // sink into the face, nudge outward along the normal so it reads as inlaid
    const px = x + nrm.x * 0.12 * s, pz = z + nrm.z * 0.12 * s;
    addRock(Math.floor(R(0, 4)), px, pz, s, { y: world.heightAt(x, z) + 0.05 * s, tilt: 0.5 });
    cliffRocks++;
  }

  /* ---- build the instanced meshes --------------------------------------- */
  const meshes = [];
  variants.forEach((geo, v) => {
    const list = buckets[v];
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => { im.setMatrixAt(i, it.m); im.setColorAt(i, it.c); });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    scene.add(im);
    meshes.push(im);
  });

  const total = buckets.reduce((a, b) => a + b.length, 0);
  console.info(`[rocks] ${total} instances, ${stepStones.length} stepping stones`);

  function rockTopAt(x, z) {
    let best = null;
    for (const s of stepStones) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r && (best === null || s.top > best)) best = s.top;
    }
    return best;
  }

  return {
    stepStones,
    rockTopAt,
    update() {},
    dispose() { meshes.forEach((m) => { scene.remove(m); m.dispose(); }); variants.forEach((g) => g.dispose()); mat.dispose(); },
  };
}
