// Rainforest vegetation: emergent buttressed giants + hollow landmark tree,
// mid-storey trees, palms, tree ferns, understory (aroids, bananas, ferns,
// sedges, shrubs), hanging roots / lianas / vine curtains.
// Everything procedural (Canvas / DataTexture), deterministic seeds.
//
// Sub-modules live in ./veg/.

import * as THREE from 'three';
import { mulberry32, fbm2, smoothstep, clamp } from '../core/noise.js';
import { makeLeafAtlas, makeBark } from './veg/textures.js';
import { createVegMaterials } from './veg/materials.js';
import { Geo } from './veg/geo.js';
import { InstanceField } from './veg/scatter.js';
import * as SP from './veg/species.js';
import { buildEmergent } from './veg/emergent.js';
import { hangingRoot, catenary, vineCurtain } from './veg/vines.js';

const QUALITY = {
  high: { keep: 1.0, dist: 1.0 },
  medium: { keep: 0.68, dist: 0.85 },
  low: { keep: 0.42, dist: 0.65 },
};

export function createVegetation(ctx) {
  const t0 = performance.now();
  const { scene, world, state, renderer } = ctx;
  const aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  const timings = {};
  const mark = (k, s) => (timings[k] = Math.round(performance.now() - s));

  /* ------------------------------------------------------- textures */
  let s = performance.now();
  const tex = {
    atlas: makeLeafAtlas(aniso),
    barkEmergent: makeBark(renderer, 'emergent', 1024, 1024, 101, aniso),
    barkMid: makeBark(renderer, 'mid', 512, 512, 202, aniso),
    barkPalm: makeBark(renderer, 'palm', 512, 512, 303, aniso),
    barkFern: makeBark(renderer, 'fern', 512, 512, 404, aniso),
  };
  mark('textures', s);
  const mats = createVegMaterials(ctx, tex);
  const atlas = tex.atlas;

  const rimOf = (x, z) => Math.max(Math.abs(x), Math.abs(z)) * 0.55 + Math.hypot(x, z) * 0.45;
  const L = world.landmarks;
  const nearLandmark = (x, z, pad) => {
    for (const k in L) { const l = L[k]; if (Math.hypot(x - l.x, z - l.z) < l.radius + pad) return true; }
    return false;
  };
  const spawn = world.spawn;

  // trunk occupancy (spatial hash) so trunks never interpenetrate
  const occ = new Map();
  const OC = 6;
  const occAdd = (x, z, r) => {
    const k = Math.floor(x / OC) * 1000 + Math.floor(z / OC);
    if (!occ.has(k)) occ.set(k, []);
    occ.get(k).push([x, z, r]);
  };
  const occFree = (x, z, r) => {
    const i0 = Math.floor(x / OC), j0 = Math.floor(z / OC);
    for (let i = i0 - 2; i <= i0 + 2; i++) for (let j = j0 - 2; j <= j0 + 2; j++) {
      const l = occ.get(i * 1000 + j);
      if (l) for (const [ox, oz, orr] of l) if (Math.hypot(x - ox, z - oz) < r + orr) return false;
    }
    return true;
  };

  /* ------------------------------------------------ emergent giants */
  s = performance.now();
  const CH = 165;
  const chunks = new Map();
  const chunkG = (x, z) => {
    const k = Math.floor((x + 165) / CH) * 10 + Math.floor((z + 165) / CH);
    if (!chunks.has(k)) { const leaf = new Geo(); chunks.set(k, { bark: new Geo(), leaf, liana: new Geo(), broad: leaf }); }
    return chunks.get(k);
  };
  const R = mulberry32(90210);
  const emergents = [];
  const gt = L.giantTree;
  // hollow opens toward the trail / south-east
  const hollowDir = Math.atan2(-14 - gt.z, -36 - gt.x);
  {
    const G = chunkG(gt.x, gt.z);
    const e = buildEmergent(G, world, atlas, gt.x, gt.z, 777, { giant: true, hollowDir });
    emergents.push({ x: gt.x, z: gt.z, ...e, giant: true });
    occAdd(gt.x, gt.z, 7);
  }
  for (let gz = -150; gz <= 150; gz += 14) {
    for (let gx = -150; gx <= 150; gx += 14) {
      const x = gx + (R() - 0.5) * 12, z = gz + (R() - 0.5) * 12;
      const r1 = R(), seed = (R() * 1e9) | 0;
      if (rimOf(x, z) > 140) continue;
      const c = world.canopyAt(x, z);
      if (r1 > smoothstep(0.3, 0.75, c) * 0.62) continue;
      if (world.waterDistAt(x, z) < 5 || world.trailDistAt(x, z) < 6.5) continue;
      if (nearLandmark(x, z, 5) || Math.hypot(x - spawn.x, z - spawn.z) < 7) continue;
      if (emergents.some((e) => Math.hypot(e.x - x, e.z - z) < 22)) continue;
      const G = chunkG(x, z);
      const e = buildEmergent(G, world, atlas, x, z, seed);
      emergents.push({ x, z, ...e });
      occAdd(x, z, 4.5);
    }
  }
  // colliders + vines for emergents
  for (const e of emergents) {
    for (const [cx, cz, r] of e.colliders) world.addCollider(cx, cz, r);
    const G = chunkG(e.x, e.z);
    for (const hp of e.hang) {
      const b = e.bendFn(hp.y);
      const u = R();
      if (u < 0.45) {
        // aerial roots: some reach the ground, some hang mid-air
        const gy = world.heightAt(hp.x, hp.z);
        const full = R() < 0.5;
        const len = full ? hp.y - gy + 0.3 : (hp.y - gy) * (0.3 + R() * 0.5);
        const nR = 1 + ((R() * 3) | 0);
        for (let k = 0; k < nR; k++) {
          hangingRoot(G.liana, R, hp.clone().add(new THREE.Vector3((R() - 0.5) * 0.8, 0, (R() - 0.5) * 0.8)), len * (0.8 + R() * 0.2), b, e.objPh, 0.02 + R() * 0.03);
        }
      } else if (u < 0.8) {
        vineCurtain(G.leaf, atlas.slots.vine, R, hp, 3 + R() * 7, b, e.objPh);
      }
    }
  }
  // lianas between neighbouring crowns and from the ground up into limbs
  for (let i = 0; i < emergents.length; i++) {
    const a = emergents[i];
    for (let j = i + 1; j < emergents.length; j++) {
      const b = emergents[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 32 || R() > 0.55) continue;
      const pa = a.hang[(R() * a.hang.length) | 0], pb = b.hang[(R() * b.hang.length) | 0];
      if (!pa || !pb) continue;
      const G = chunkG((a.x + b.x) / 2, (a.z + b.z) / 2);
      catenary(G.liana, R, pa, pb, 5 + R() * 10, 0.05 + R() * 0.05, a.bendFn(pa.y), b.bendFn(pb.y), a.objPh);
    }
    const nUp = a.giant ? 4 : (R() < 0.6 ? 1 + ((R() * 2) | 0) : 0);
    for (let k = 0; k < nUp; k++) {
      const hp = a.hang[(R() * a.hang.length) | 0];
      if (!hp) continue;
      const ang = R() * Math.PI * 2, dist = 3 + R() * 5;
      const gx = a.x + Math.cos(ang) * dist, gz = a.z + Math.sin(ang) * dist;
      if (world.trailDistAt(gx, gz) < 2) continue;
      const gp = new THREE.Vector3(gx, world.heightAt(gx, gz) - 0.2, gz);
      const G = chunkG(a.x, a.z);
      catenary(G.liana, R, gp, hp, 2 + R() * 4, 0.06 + R() * 0.06, 0, a.bendFn(hp.y), a.objPh);
    }
  }
  mark('emergent', s);

  /* ----------------------------------------------------- instanced */
  s = performance.now();
  const mkVariants = (fn, seeds) => seeds.map((sd) => [fn(sd, 0, atlas), fn(sd, 1, atlas)]);
  const V = {
    mid: mkVariants(SP.midTree, [11, 12, 13, 14]),
    palm: mkVariants(SP.palm, [21, 22]),
    fern: mkVariants(SP.treeFern, [31, 32, 33]),
    alocasia: mkVariants((sd, l, a) => SP.aroid(sd, l, a, 'alocasia'), [41, 42]),
    monstera: mkVariants((sd, l, a) => SP.aroid(sd, l, a, 'monstera'), [51, 52]),
    banana: mkVariants(SP.banana, [61, 62]),
    gfern: mkVariants(SP.groundFern, [71, 72]),
    sedge: mkVariants(SP.sedge, [81]),
    shrub: mkVariants(SP.shrub, [91, 92]),
  };
  mark('variants', s);

  s = performance.now();
  const F = {
    mid: new InstanceField('midTree', V.mid, mats, { maxDist: 230, lodDist: 42, shadowDist: 48, fade: 0.1 }),
    palm: new InstanceField('palm', V.palm, mats, { maxDist: 170, lodDist: 38, shadowDist: 40 }),
    fern: new InstanceField('treeFern', V.fern, mats, { maxDist: 110, lodDist: 28, shadowDist: 30 }),
    under: null,
  };
  // understory: one field per species (variants differ in mats/cast), merged into a single list
  const U = {
    alocasia: new InstanceField('alocasia', V.alocasia, mats, { maxDist: 70, lodDist: 20, shadowDist: 16 }),
    monstera: new InstanceField('monstera', V.monstera, mats, { maxDist: 70, lodDist: 20, shadowDist: 16 }),
    banana: new InstanceField('banana', V.banana, mats, { maxDist: 90, lodDist: 26, shadowDist: 22 }),
    gfern: new InstanceField('groundFern', V.gfern, mats, { maxDist: 55, lodDist: 16, shadowDist: 0 }),
    sedge: new InstanceField('sedge', V.sedge, mats, { maxDist: 45, lodDist: 14, shadowDist: 0 }),
    shrub: new InstanceField('shrub', V.shrub, mats, { maxDist: 60, lodDist: 18, shadowDist: 12 }),
  };

  const tintFor = (Rr, x, z, k = 1) => {
    const b = (0.86 + Rr() * 0.26) * (1 - 0.18 * world.canopyAt(x, z));
    const h = (Rr() - 0.5) * 2 * 0.07 * k;
    return [b * (1 + h), b * (1 + h * 0.3), b * (1 - h)];
  };

  // mid-storey trees
  const R2 = mulberry32(4242), Rv = mulberry32(999);
  const _m4 = new THREE.Matrix4(), _v3 = new THREE.Vector3(), _qq = new THREE.Quaternion(), _eu = new THREE.Euler(), _sv = new THREE.Vector3();
  for (let gz = -158; gz <= 158; gz += 5.6) for (let gx = -158; gx <= 158; gx += 5.6) {
    const x = gx + (R2() - 0.5) * 5.2, z = gz + (R2() - 0.5) * 5.2;
    const r1 = R2(), v = (R2() * V.mid.length) | 0, sc = 0.75 + R2() * 0.5, rot = R2() * 6.283, imp = R2();
    const rim = rimOf(x, z);
    if (rim > 150) continue;
    const c = world.canopyAt(x, z);
    const out = rim > 122; // backdrop on the ridge
    if (r1 > smoothstep(0.15, 0.8, c) * (out ? 0.9 : 0.75)) continue;
    if (world.waterDistAt(x, z) < 2.5 || world.trailDistAt(x, z) < 3.2) continue;
    if (nearLandmark(x, z, 1) || Math.hypot(x - spawn.x, z - spawn.z) < 4) continue;
    if (!occFree(x, z, 1.9)) continue;
    occAdd(x, z, 1.1);
    const y = world.heightAt(x, z);
    const tX = (R2() - 0.5) * 0.06, tZ = (R2() - 0.5) * 0.06;
    F.mid.add(x, y, z, rot, sc, tintFor(R2, x, z), v, out ? 0.3 + imp * 0.7 : imp, tX, tZ);
    if (!out) world.addCollider(x, z, 0.35 * sc);
    // aerial roots / vine curtains from some mid-storey crowns (eye-level depth)
    if (!out && Rv() < 0.4) {
      const vd = V.mid[v][0];
      _m4.compose(_v3.set(x, y, z), _qq.setFromEuler(_eu.set(tX, rot, tZ, 'YXZ')), _sv.setScalar(sc));
      const nH = 1 + (Rv() < 0.45 ? 1 : 0);
      for (let k = 0; k < nH; k++) {
        const h = vd.hang[(Rv() * vd.hang.length) | 0];
        const hp = new THREE.Vector3(h[0] + (Rv() - 0.5) * 1.2, h[1], h[2] + (Rv() - 0.5) * 1.2).applyMatrix4(_m4);
        const gy = world.heightAt(hp.x, hp.z);
        const clear = world.trailDistAt(hp.x, hp.z) < 2.6 ? 3.3 : 0.6;
        const room = hp.y - gy - clear;
        if (room < 1.5) continue;
        const bend = 0.3 * sc * Math.pow(Math.min(1, (hp.y - y) / (vd.H * sc)), 2) * 0.6;
        const G = chunkG(hp.x, hp.z);
        if (Rv() < 0.55) {
          const n = 1 + ((Rv() * 3) | 0);
          for (let q = 0; q < n; q++) {
            hangingRoot(G.liana, Rv, hp.clone().add(new THREE.Vector3((Rv() - 0.5) * 0.5, 0, (Rv() - 0.5) * 0.5)),
              room * (0.5 + Rv() * 0.5), bend, 0, 0.01 + Rv() * 0.018);
          }
        } else {
          vineCurtain(G.leaf, atlas.slots.vine, Rv, hp, Math.min(room, 2 + Rv() * 5), bend, 0);
        }
      }
    }
  }
  const staticMeshes = [];
  for (const G of chunks.values()) {
    const add = (geo, mat, cast) => {
      if (!geo.nv) return;
      const m = new THREE.Mesh(geo.build(), mat);
      m.castShadow = cast; m.receiveShadow = true;
      if (cast) m.customDepthMaterial = mats.depthFor(mat);
      m.matrixAutoUpdate = false;
      scene.add(m);
      staticMeshes.push(m);
    };
    add(G.bark, mats.barkEmergent, true);
    add(G.leaf, mats.foliage, true);
    add(G.liana, mats.liana, false);
  }

  // palms: love the stream banks and gaps
  const R3 = mulberry32(5151);
  for (let gz = -140; gz <= 140; gz += 7) for (let gx = -140; gx <= 140; gx += 7) {
    const x = gx + (R3() - 0.5) * 6.5, z = gz + (R3() - 0.5) * 6.5;
    const r1 = R3(), v = (R3() * V.palm.length) | 0, sc = 0.8 + R3() * 0.45, rot = R3() * 6.283, imp = R3();
    if (rimOf(x, z) > 135) continue;
    const wd = world.waterDistAt(x, z);
    const p = 0.55 * smoothstep(14, 2.5, wd) + 0.12 * (1 - world.canopyAt(x, z)) + 0.06;
    if (r1 > p) continue;
    if (wd < 1.2 || world.trailDistAt(x, z) < 2.6) continue;
    if (nearLandmark(x, z, 0) || Math.hypot(x - spawn.x, z - spawn.z) < 3) continue;
    if (!occFree(x, z, 1.4)) continue;
    occAdd(x, z, 0.6);
    F.palm.add(x, world.heightAt(x, z), z, rot, sc, tintFor(R3, x, z), v, imp);
    world.addCollider(x, z, 0.2 * sc);
  }
  // tree ferns: moist understory, near water, along the trail
  const R4 = mulberry32(6161);
  for (let gz = -135; gz <= 135; gz += 4.2) for (let gx = -135; gx <= 135; gx += 4.2) {
    const x = gx + (R4() - 0.5) * 4, z = gz + (R4() - 0.5) * 4;
    const r1 = R4(), v = (R4() * V.fern.length) | 0, sc = 0.8 + R4() * 0.45, rot = R4() * 6.283, imp = R4();
    if (rimOf(x, z) > 130) continue;
    const wd = world.waterDistAt(x, z), td = world.trailDistAt(x, z);
    const u = world.understoryAt(x, z);
    const p = (0.18 + 0.4 * smoothstep(16, 2, wd) + 0.25 * smoothstep(7, 3, td)) * (0.4 + 0.6 * u);
    if (r1 > p) continue;
    if (wd < 0.8 || td < 2.4) continue;
    if (nearLandmark(x, z, -2) || Math.hypot(x - spawn.x, z - spawn.z) < 2.5 || Math.hypot(x - gt.x, z - gt.z) < 11) continue;
    if (!occFree(x, z, 1.0)) continue;
    occAdd(x, z, 0.4);
    F.fern.add(x, world.heightAt(x, z) - 0.05, z, rot, sc, tintFor(R4, x, z), v, imp, (R4() - 0.5) * 0.12, (R4() - 0.5) * 0.12);
    world.addCollider(x, z, 0.16 * sc);
  }
  // understory
  const R5 = mulberry32(7373);
  const reach = {
    alocasia: V.alocasia.map((v) => v[0].reach), monstera: V.monstera.map((v) => v[0].reach),
    banana: V.banana.map((v) => v[0].reach), gfern: V.gfern.map((v) => v[0].reach),
    sedge: V.sedge.map((v) => v[0].reach), shrub: V.shrub.map((v) => v[0].reach),
  };
  const STEP = 1.05;
  for (let gz = -132; gz <= 132; gz += STEP) for (let gx = -132; gx <= 132; gx += STEP) {
    const x = gx + (R5() - 0.5) * STEP * 1.1, z = gz + (R5() - 0.5) * STEP * 1.1;
    const r1 = R5(), r2 = R5(), sc = 0.75 + R5() * 0.5, rot = R5() * 6.283, imp = R5();
    if (rimOf(x, z) > 126) continue;
    const u = world.understoryAt(x, z);
    if (u < 0.02) continue;
    const td = world.trailDistAt(x, z), wd = world.waterDistAt(x, z);
    const edge = smoothstep(1.5, 2.6, td) * smoothstep(8, 3.5, td) * 0.9 + smoothstep(0.2, 1, wd) * smoothstep(6, 1.5, wd) * 0.5;
    const p = u * 0.5 + edge * Math.max(u, 0.55);
    if (r1 > p) continue;
    if (Math.hypot(x - gt.x, z - gt.z) < 4.2) continue;
    // species by patchy zones
    const n1 = fbm2(x * 0.06, z * 0.06, 2, 31), n2 = fbm2(x * 0.09, z * 0.09, 2, 32), n3 = fbm2(x * 0.05, z * 0.05, 2, 33);
    let w;
    if (wd < 3) w = { sedge: 0.35, gfern: 0.3, alocasia: 0.28, banana: td > 4 ? 0.07 : 0, shrub: 0.0, monstera: 0.0 };
    else w = {
      gfern: 0.3 + 0.3 * n1, alocasia: Math.max(0, 0.14 + 0.3 * n2), monstera: Math.max(0, 0.04 + 0.2 * n3),
      shrub: Math.max(0, 0.1 - 0.2 * n1), banana: Math.max(0, 0.03 + 0.12 * n2), sedge: 0.1,
    };
    let tot = 0; for (const k in w) tot += w[k];
    let pick = r2 * tot, sp = 'gfern';
    for (const k in w) { pick -= w[k]; if (pick <= 0) { sp = k; break; } }
    const f = U[sp];
    const v = (R5() * f.variants.length) | 0;
    if (reach[sp][v] * sc * 0.8 > td - 1.3) continue; // keep the trail clear
    const tall = sp === 'banana' || sp === 'monstera' || sp === 'alocasia' || sp === 'shrub';
    if ((sp === 'banana' || sp === 'monstera') && td < 4.5) continue;
    // view corridor from the trail to the hollow tree's doorway: low plants only
    const gdx = x - gt.x, gdz = z - gt.z, gd = Math.hypot(gdx, gdz);
    let gAng = Math.abs(Math.atan2(gdz, gdx) - hollowDir); if (gAng > Math.PI) gAng = 2 * Math.PI - gAng;
    if (tall && (gd < 12 || (gd < 22 && gAng < 0.7))) continue;
    if (gd < 9 && gAng < 0.5 && sp !== 'sedge') continue;
    if (sp === 'banana' && !occFree(x, z, 0.8)) continue;
    const y = world.heightAt(x, z) - 0.04;
    f.add(x, y, z, rot, sc, tintFor(R5, x, z, 1.4), v, imp, (R5() - 0.5) * 0.1, (R5() - 0.5) * 0.1);
    if (sp === 'banana') world.addCollider(x, z, 0.14 * sc);
  }
  const fields = [F.mid, F.palm, F.fern, ...Object.values(U)];
  for (const f of fields) f.finalize(scene, mats.depthFor);
  mark('scatter', s);

  /* ------------------------------------------------------- quality */
  const applyQ = (q) => {
    const Q = QUALITY[q] || QUALITY.high;
    for (const f of fields) f.setQuality(Q.keep, Q.dist);
  };
  applyQ(state.get('resolvedQuality'));
  const offQ = state.on('resolvedQuality', applyQ);

  timings.total = Math.round(performance.now() - t0);
  const counts = {
    emergent: emergents.length,
    ...Object.fromEntries(fields.map((f) => [f.name, f.cells.reduce((a, c) => a + c.end - c.start, 0)])),
  };
  console.info('[vegetation] built', timings, counts);

  // Culling uses a widened frustum so fields only need refreshing after a real
  // move/turn; refreshes are spread over frames (max ~2 fields per frame).
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const cullCam = new THREE.PerspectiveCamera();
  const lastPos = new THREE.Vector3(1e9, 0, 0), lastQ = new THREE.Quaternion();
  let first = true, queue = [];
  return {
    timings, counts, fields, staticMeshes, mats, tex,
    update(dt, t) {
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      const moved = cam.position.distanceToSquared(lastPos) > 1.0 || Math.abs(cam.quaternion.dot(lastQ)) < 0.9955;
      if (!first && !moved) {
        for (const f of fields) if (f.dirty && !queue.includes(f)) queue.push(f);
      } else {
        lastPos.copy(cam.position); lastQ.copy(cam.quaternion);
        cullCam.fov = Math.min(150, cam.fov + 34);
        cullCam.aspect = cam.aspect * 1.25;
        cullCam.near = cam.near; cullCam.far = cam.far;
        cullCam.updateProjectionMatrix();
        pm.multiplyMatrices(cullCam.projectionMatrix, cam.matrixWorldInverse);
        frustum.setFromProjectionMatrix(pm);
        if (first) { for (const f of fields) f.update(cam, frustum.planes, true); queue = []; }
        else queue = fields.slice().sort((a, b) => a.o.maxDist - b.o.maxDist); // near stuff first
      }
      first = false;
      for (let k = 0; k < 2 && queue.length; k++) queue.shift().update(cam, frustum.planes, true);
    },
    stats() {
      const o = {};
      for (const f of fields) o[f.name] = f.stats();
      return o;
    },
    dispose() {
      offQ();
      for (const m of staticMeshes) { scene.remove(m); m.geometry.dispose(); }
      for (const f of fields) for (const m of f.meshes) { scene.remove(m); }
    },
  };
}
