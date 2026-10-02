// Rain: GPU-driven streaks, ground splashes, canopy drips.
// All motion is computed in vertex shaders from uTime + per-instance seeds (see rainShaders.js).
// JS per frame: a handful of uniform writes.
//
// Draw calls: streaks, splash rings, splash crowns, canopy drips = 4.

import * as THREE from 'three';
import { fogUniforms } from '../render/fog.js';
import { mulberry32, clamp } from '../core/noise.js';
import {
  STREAK_VERT, STREAK_FRAG, RING_VERT, RING_FRAG, CROWN_VERT, CROWN_FRAG, DRIP_VERT, DRIP_FRAG,
} from './rainShaders.js';

// Max instance counts (high quality). medium = 1/2, low = 1/4.
const MAX_STREAKS = 36000;
const MAX_SPLASHES = 2400;
const MAX_DRIPS = 700;

const WIND_SPEED = 5.0; // horizontal drop drift (m/s) at wind strength 1

// R = ground height, G = canopy density, B = water distance (<0 in water). Half float so it
// stays bilinearly filterable on every WebGL2 device.
function buildEnvTexture(world) {
  const N = world.gridSize, half = world.WORLD_HALF, res = world.gridRes;
  const data = new Uint16Array(N * N * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < N; j++) {
    const z = -half + j * res;
    for (let i = 0; i < N; i++) {
      const x = -half + i * res;
      const k = j * N + i, o = k * 4;
      data[o] = toHalf(world.heightGrid[k]);
      data[o + 1] = toHalf(clamp(world.canopyAt(x, z), 0, 1));
      data[o + 2] = toHalf(clamp(world.waterDistAt(x, z), -50, 500));
      data[o + 3] = toHalf(0);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function quadGeometry(yMin, seedAttr) {
  const g = new THREE.InstancedBufferGeometry();
  // 'position' carries the quad corner (x: -1..1, y: yMin..1)
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, yMin, 0, 1, yMin, 0, -1, 1, 0, 1, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute('aSeed', seedAttr);
  g.instanceCount = 0;
  return g;
}

function makeSeeds(count, seed) {
  const rnd = mulberry32(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return new THREE.InstancedBufferAttribute(a, 4);
}

export function createRain(ctx) {
  const { scene, camera, renderer, world, state, uniforms: G } = ctx;

  const envTex = buildEnvTexture(world);

  const shared = {
    uTime: G.uTime,
    uSunCol: G.uSunCol,
    uDrift: { value: new THREE.Vector2() },
    uWindVel: { value: new THREE.Vector2() },
    uRainAmt: { value: state.get('rain') },
    uPixel: { value: 0.001 },
    uEnv: { value: envTex },
    uGrid: { value: new THREE.Vector2(world.WORLD_HALF, world.gridSize) },
  };

  const mkMat = (vertexShader, fragmentShader, blending, extra = {}) => new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { ...shared, ...fogUniforms() },
    transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, blending, ...extra,
  });

  const seedStreak = makeSeeds(MAX_STREAKS, 0x5a17);
  const seedSplash = makeSeeds(MAX_SPLASHES, 0x71c3);
  const seedDrip = makeSeeds(MAX_DRIPS, 0x9d2b);

  const meshes = [];
  const add = (geo, mat, order) => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;   // vertex shader repositions everything around the camera
    m.renderOrder = order;
    m.matrixAutoUpdate = false;
    m.userData.postAA = true;  // drawn after TAA by the pipeline (thin fast streaks would smear)
    scene.add(m);
    meshes.push(m);
    return m;
  };

  // Ground splashes first (opaque-ish alpha), then additive streaks / drips on top.
  const ring = add(
    quadGeometry(-1, seedSplash),
    mkMat(RING_VERT, RING_FRAG, THREE.NormalBlending, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    100,
  );
  const crown = add(quadGeometry(0, seedSplash), mkMat(CROWN_VERT, CROWN_FRAG, THREE.NormalBlending), 101);
  const drips = add(quadGeometry(0, seedDrip), mkMat(DRIP_VERT, DRIP_FRAG, THREE.AdditiveBlending), 102);
  const streaks = add(quadGeometry(0, seedStreak), mkMat(STREAK_VERT, STREAK_FRAG, THREE.AdditiveBlending), 103);

  // Counts follow rain intensity and quality tier.
  function applyCounts() {
    const q = state.get('resolvedQuality');
    const qf = q === 'low' ? 0.25 : q === 'medium' ? 0.5 : 1;
    const r = clamp(state.get('rain') ?? 0, 0, 1);
    shared.uRainAmt.value = r;
    const set = (mesh, n) => {
      const c = Math.max(0, Math.floor(n));
      mesh.geometry.instanceCount = c;
      mesh.visible = c > 0;
    };
    set(streaks, MAX_STREAKS * qf * (0.06 + 0.94 * r));
    set(ring, MAX_SPLASHES * qf * (0.08 + 0.92 * r));
    set(crown, MAX_SPLASHES * qf * (0.08 + 0.92 * r));
    set(drips, MAX_DRIPS * qf * (0.3 + 0.7 * r));
  }
  applyCounts();
  const unsubs = [state.on('rain', applyCounts), state.on('resolvedQuality', applyCounts)];

  const dbs = new THREE.Vector2();
  let lastFov = 0, lastH = 0;

  return {
    update(dt) {
      // wind: integrate drift so gusts/strength changes never make drops jump
      const w = G.uWind.value;
      let wx = w.x, wz = w.z;
      const len = Math.hypot(wx, wz);
      if (len > 1e-4) { wx /= len; wz /= len; } else { wx = wz = 0; }
      const sp = G.uWindStrength.value * WIND_SPEED + shared.uRainAmt.value * 0.6;
      const vx = wx * sp, vz = wz * sp;
      shared.uWindVel.value.set(vx, vz);
      const d = shared.uDrift.value;
      d.x = (d.x + vx * dt) % 40;
      d.y = (d.y + vz * dt) % 40;

      // world size of one pixel at 1 m (min-width clamp for thin far streaks)
      renderer.getDrawingBufferSize(dbs);
      if (camera.fov !== lastFov || dbs.y !== lastH) {
        lastFov = camera.fov; lastH = dbs.y;
        shared.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / Math.max(1, dbs.y);
      }
    },
    dispose() {
      for (const u of unsubs) u();
      for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
      envTex.dispose();
    },
  };
}
