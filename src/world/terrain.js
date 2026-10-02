// Valley floor: 4×4 chunks built straight from world.heightGrid, shaded by a
// procedural 5-layer splat (mud / leaf litter / moss / rock / pebble bed) that is
// resolved per pixel from design fields (trail distance, water distance, slope,
// noise) — no splat texture, so edges stay crisp at any distance.

import * as THREE from 'three';
import { addShaderPatch } from '../render/shaderPatch.js';
import { getGroundTextures } from './ground/groundTextures.js';
import { NOISE_GLSL, RIPPLE_GLSL, TEX_GLSL } from './ground/glsl.js';
import { createRocks } from './ground/rocks.js';

const CHUNKS = 4;

function buildChunk(world, ci, cj) {
  const N = world.gridSize, res = world.gridRes, half = world.WORLD_HALF;
  const cells = (N - 1) / CHUNKS;             // 80
  const vx = cells + 1;
  const pos = new Float32Array(vx * vx * 3), nor = new Float32Array(vx * vx * 3), inf = new Float32Array(vx * vx * 3);
  const H = world.heightGrid;
  const h = (i, j) => H[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  let p = 0;
  for (let j = 0; j < vx; j++) for (let i = 0; i < vx; i++) {
    const gi = ci * cells + i, gj = cj * cells + j;
    const x = -half + gi * res, z = -half + gj * res;
    const y = h(gi, gj);
    pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
    // central-difference normal
    const nx = h(gi - 1, gj) - h(gi + 1, gj), nz = h(gi, gj - 1) - h(gi, gj + 1), ny = 2 * res;
    const l = Math.hypot(nx, ny, nz);
    nor[p] = nx / l; nor[p + 1] = ny / l; nor[p + 2] = nz / l;
    inf[p] = world.trailDistAt(x, z);
    inf[p + 1] = world.waterDistAt(x, z);
    inf[p + 2] = world.canopyAt(x, z);
    p += 3;
  }
  const idx = new Uint16Array(cells * cells * 6);
  let q = 0;
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
    if ((i + j) & 1) { idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
    else { idx[q++] = a; idx[q++] = c; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aTerr', new THREE.BufferAttribute(inf, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/* ---------------------------------------------------------------- shader */
const LAYER_GLSL = /* glsl */ `
${TEX_GLSL}
uniform float uTime;
uniform float uRain;
${NOISE_GLSL}
${RIPPLE_GLSL}

// two-scale planar sample of one layer; contrast-restored blend of the scales
void sampleLayer(float L, vec2 p, float s, out vec3 alb, out vec4 nm) {
  vec2 uv1 = p / s;
  vec2 uv2 = (ROT * p) / (s * 0.31) + 0.37;
  float k = 0.3 + 0.4 * gn(p * 0.17 + L * 7.0);
  vec3 a1 = texture(uAlb, vec3(uv1, L)).rgb;
  vec3 a2 = texture(uAlb, vec3(uv2, L)).rgb;
  vec4 n1 = texture(uNrm, vec3(uv1, L));
  vec4 n2 = texture(uNrm, vec3(uv2, L));
  vec3 avg = textureLod(uAlb, vec3(0.5, 0.5, L), 8.0).rgb;
  alb = max(avg + (mix(a1, a2, k) - avg) * 1.3, 0.0);
  // second scale's slope is expressed in its own (3× denser) uv -> rotate back into world axes
  vec2 b2 = (n2.xy * 2.0 - 1.0);
  b2 = vec2(dot(b2, vec2(0.8, -0.6)), dot(b2, vec2(0.6, 0.8)));
  vec2 b1 = n1.xy * 2.0 - 1.0;
  nm = vec4(b1 * 0.85 + b2 * 0.6, mix(n1.z, n2.z, k), mix(n1.w, n2.w, k));
}
`;

const ALBEDO_GLSL = /* glsl */ `
  vec3 tWP = vTWorld;
  vec3 tN = normalize(vTNormal);
  float tTd = vTInfo.x, tWd = vTInfo.y;
  float tDist = length(tWP - cameraPosition);
  float slope = 1.0 - tN.y;
  float nLo = gfbm(tWP.xz * 0.30);
  float nMid = gfbm(tWP.xz * 0.065 + 11.0);
  float nHi = gn(tWP.xz * 2.7);
  float spray = exp(-length(tWP.xz - vec2(-0.4, -121.0)) / 15.0);

  // ---- layer weights (later stages override earlier ones)
  float wet = 1.0 - smoothstep(0.0, 9.0, tWd);
  float mossF = smoothstep(0.58, 0.74, nMid + 0.06 * wet + 0.12 * spray + 0.20 * smoothstep(0.05, 0.22, slope)
                 - 0.30 * (1.0 - smoothstep(1.4, 3.0, tTd)) + (nHi - 0.5) * 0.14);
  mossF = max(mossF, 0.5 * (1.0 - smoothstep(0.5, 2.5, tWd + (nLo - 0.5) * 2.0)) * smoothstep(0.42, 0.56, nLo));
  float mudTrail = 1.0 - smoothstep(0.75, 1.9, tTd + (nLo - 0.5) * 1.3 + (nHi - 0.5) * 0.35);
  float mudBank = 0.9 * (1.0 - smoothstep(0.25, 1.4, tWd + (nLo - 0.5) * 0.9));
  float mudPatch = smoothstep(0.62, 0.80, gfbm(tWP.xz * 0.2 + 40.0)) * 0.45;
  float mudF = max(max(mudTrail, mudBank), mudPatch);
  float rockF = smoothstep(0.26, 0.44, slope + (nLo - 0.5) * 0.10 + (nHi - 0.5) * 0.03);
  float bedF = 1.0 - smoothstep(-0.05, 0.45, tWd + (nLo - 0.5) * 0.6);

  float wMoss = mossF, wLeaf = 1.0 - mossF;
  float wMud = mudF; wLeaf *= 1.0 - mudF; wMoss *= 1.0 - mudF;
  float wRock = rockF; wLeaf *= 1.0 - rockF; wMoss *= 1.0 - rockF * 0.7; wMud *= 1.0 - rockF;
  float wBed = bedF; wLeaf *= 1.0 - bedF; wMoss *= 1.0 - bedF; wMud *= 1.0 - bedF; wRock *= 1.0 - bedF;

  // ---- sample layers
  vec3 aMud, aLeaf, aMoss, aRock, aBed; vec4 nMud, nLeaf, nMoss, nRock, nBed; vec3 rockBump = vec3(0.0);
  sampleLayer(0.0, tWP.xz, 2.2, aMud, nMud);
  sampleLayer(1.0, tWP.xz, 2.6, aLeaf, nLeaf);
  sampleLayer(2.0, tWP.xz, 1.9, aMoss, nMoss);
  sampleRock(tWP, tN, aRock, nRock, rockBump);
  sampleLayer(4.0, tWP.xz, 1.7, aBed, nBed);

  // ---- height-aware blend (pebbles poke through sand, leaves over mud …)
  float sM = wMud + nMud.z * 0.45 * step(0.001, wMud);
  float sL = wLeaf + nLeaf.z * 0.55 * step(0.001, wLeaf);
  float sS = wMoss + nMoss.z * 0.40 * step(0.001, wMoss);
  float sR = wRock + nRock.z * 0.40 * step(0.001, wRock);
  float sB = wBed + nBed.z * 0.55 * step(0.001, wBed);
  float sMax = max(max(max(sM, sL), max(sS, sR)), sB);
  float thr = sMax - 0.32;
  float bM = max(sM - thr, 0.0), bL = max(sL - thr, 0.0), bS = max(sS - thr, 0.0), bR = max(sR - thr, 0.0), bB = max(sB - thr, 0.0);
  float bSum = bM + bL + bS + bR + bB + 1e-4;
  bM /= bSum; bL /= bSum; bS /= bSum; bR /= bSum; bB /= bSum;

  vec3 tAlb = aMud * bM + aLeaf * bL + aMoss * bS + aRock * bR + aBed * bB;
  float tRoughV = nMud.w * bM + nLeaf.w * bL + nMoss.w * bS + nRock.w * bR + nBed.w * bB;
  vec3 tBump = vec3(nMud.x, 0.0, nMud.y) * bM * 0.55 + vec3(nLeaf.x, 0.0, nLeaf.y) * bL * 0.5 +
               vec3(nMoss.x, 0.0, nMoss.y) * bS * 0.5 + rockBump * bR * 0.6 + vec3(nBed.x, 0.0, nBed.y) * bB * 0.55;

  // ---- macro variation, wet banks, spray, puddles
  // outer ridges read as canopy-covered hillside rather than bare ground
  float rimM = max(abs(tWP.x), abs(tWP.z)) * 0.55 + length(tWP.xz) * 0.45;
  float canopyM = smoothstep(96.0, 128.0, rimM) * smoothstep(22.0, 48.0, length(tWP.xz - vec2(0.0, -124.0)));
  vec3 canopyC = vec3(0.028, 0.055, 0.036) * (0.55 + 1.1 * gfbm(tWP.xz * 0.13 + 2.0)) * (0.7 + 0.6 * gn(tWP.xz * 0.6));
  tAlb = mix(tAlb, canopyC, canopyM * 0.8);
  tAlb *= 0.80 + 0.40 * nMid;
  tAlb *= vec3(1.0 + 0.12 * (nMid - 0.5), 1.0, 1.0 - 0.12 * (nMid - 0.5));
  tAlb *= 1.0 - 0.30 * spray - 0.25 * (1.0 - smoothstep(0.0, 1.6, tWd));
  float pud = bM * smoothstep(0.58, 0.70, gfbm(tWP.xz * 0.5 + 3.0)) * smoothstep(0.90, 0.98, tN.y) * (1.0 - bB);
  tAlb *= 1.0 - 0.25 * pud;
  tRoughV = min(tRoughV * 1.2, 1.0);
  tRoughV = mix(tRoughV, 0.16, pud);
  tBump *= 1.0 - pud;
  tBump.xz += rainRipples(tWP.xz, uTime, uRain) * pud * (1.0 - smoothstep(8.0, 32.0, tDist)) * 1.6;
  tBump *= 1.0 - 0.75 * smoothstep(40.0, 130.0, tDist);
  diffuseColor.rgb = tAlb;
`;

function terrainPatch(shader) {
  const tex = getGroundTextures();
  shader.uniforms.uAlb = { value: tex.albedo };
  shader.uniforms.uNrm = { value: tex.normal };
  shader.uniforms.uTime = terrainPatch.U.uTime;
  shader.uniforms.uRain = terrainPatch.U.uRain;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aTerr;\nvarying vec3 vTInfo;\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTInfo = aTerr; vTWorld = position; vTNormal = normal;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTInfo;\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;\n' + LAYER_GLSL)
    .replace('#include <map_fragment>', ALBEDO_GLSL)
    .replace('#include <lights_physical_fragment>', 'roughnessFactor *= tRoughV;\n#include <lights_physical_fragment>')
    .replace(
      '#include <normal_fragment_maps>',
      `{
        vec3 nW = inverseTransformDirection(normal, viewMatrix);
        nW = normalize(nW + tBump);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      }`,
    );
}

export function createTerrain(ctx) {
  const { scene, world, prepareMaterial } = ctx;
  terrainPatch.U = ctx.uniforms;

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0 });
  addShaderPatch(mat, 'terrain', terrainPatch);
  prepareMaterial(mat);

  const group = new THREE.Group();
  group.name = 'terrain';
  const geoms = [];
  for (let cj = 0; cj < CHUNKS; cj++) for (let ci = 0; ci < CHUNKS; ci++) {
    const g = buildChunk(world, ci, cj);
    geoms.push(g);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  scene.add(group);

  const rocks = createRocks(ctx);

  return {
    group,
    rocks,
    rockTopAt: rocks.rockTopAt,
    update(dt, t) { rocks.update?.(dt, t); },
    dispose() { geoms.forEach((g) => g.dispose()); mat.dispose(); rocks.dispose?.(); scene.remove(group); },
  };
}
