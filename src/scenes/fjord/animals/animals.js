// Fjord pasture animals: Icelandic horses + sheep flocks.
//   createAnimals(ctx) -> { update(dt, t), dispose(), sim, meshes }
// Two InstancedMeshes (one draw call each, +1 each in the shadow pass), GPU skeleton animation,
// CPU behaviour for ~50 animals (< 0.5 ms / frame, distant animals are stepped less often).
import * as THREE from 'three';
import { mulberry32 } from '../../../core/noise.js';
import { buildHorse } from './horseGeo.js';
import { buildSheep } from './sheepGeo.js';
import { makeAnimalMesh } from './skeleton.js';
import { Ground, Sim } from './agents.js';

const _c = new THREE.Color();
const rgb = (hex) => { _c.setHex(hex); return [_c.r, _c.g, _c.b]; };

// coat, mane/tail, pointsMix (legs: 0 = coat colour, 1 = mane colour), pinto patch amount
const HORSE_COATS = [
  [0x9c4a20, 0x7a3616, 0, 0], [0xa4521f, 0xe6c58a, 0, 0], [0x8b4020, 0xc79a60, 0, 0],
  [0x322d2b, 0x1a1616, 1, 0], [0x3d3532, 0x22191a, 1, 0],
  [0xc4c6c4, 0xe9e9e4, 0.4, 0], [0xdcdcd6, 0xf2f0ea, 0.2, 0],
  [0xd8ad5e, 0xf6eed8, 0, 0], [0xcfa055, 0xf0e2c0, 0, 0],
  [0x6e3a1f, 0x18110d, 1, 0], [0x7d4525, 0x1c130f, 1, 0],
  [0xb39566, 0x2e2318, 1, 0],
  [0x8f4522, 0xe8d9b8, 0, 0.42], [0x211e1e, 0x1a1616, 1, 0.4], [0x7a4022, 0xe6d8bc, 0, 0.36],
];
// wool, face/legs, patch, weight
const SHEEP_LOOKS = [
  [0xeae5d7, 0x1a1615, 0, 0.30], [0xeae5d7, 0x4a3020, 0, 0.14], [0xe2dccb, 0xcfc4b0, 0, 0.10],
  [0xeae5d7, 0x1a1615, 0.4, 0.10], [0x2a2624, 0x191412, 0, 0.08], [0x6b4a33, 0x3a281c, 0, 0.08],
  [0x8c877e, 0x2a2422, 0, 0.06], [0xd9c9a4, 0x6a4a34, 0, 0.08], [0xf0ece0, 0x8a6a4a, 0, 0.06],
];

export function createAnimals(ctx) {
  const { world, scene } = ctx;
  const prep = ctx.prepareMaterial || ((m) => m);
  const rnd = mulberry32(20241);
  const ground = new Ground(world);
  const sim = new Sim(ctx, ground);
  const P = world.features.pasture;
  const spanZ = P.z1 - P.z0;

  const horse = buildHorse(), sheep = buildSheep();
  const HERDS = [4, 3, 3, 3, 2], FLOCKS = [6, 5, 5, 5, 4, 4, 3, 3];
  const NH = HERDS.reduce((a, b) => a + b, 0), NS = FLOCKS.reduce((a, b) => a + b, 0);
  const H = makeAnimalMesh(horse.geometry, horse.S, NH, prep);
  const S = makeAnimalMesh(sheep.geometry, sheep.S, NS, prep);
  H.mesh.name = 'horses'; S.mesh.name = 'sheep';
  scene.add(H.mesh, S.mesh);

  const centers = [];
  const pickCenter = (zA, zB, xA, xB, minSep, canFn) => {
    for (let pass = 0; pass < 3; pass++) for (let tries = 0; tries < 300; tries++) {
      const x = xA + rnd() * (xB - xA), z = zA + rnd() * (zB - zA);
      if (!canFn(x, z) || !canFn(x + 5, z) || !canFn(x - 5, z) || !canFn(x, z + 5) || !canFn(x, z - 5)) continue;
      if (centers.every((c) => Math.hypot(c.x - x, c.z - z) > minSep * (1 - pass * 0.3))) { centers.push({ x, z }); return { x, z }; }
    }
    return null;
  };
  const scatter = (c, n, spread, spacing, canFn) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 60; tries++) {
        const ang = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * spread * (1 + tries * 0.03);
        const x = c.x + Math.sin(ang) * r, z = c.z + Math.cos(ang) * r;
        if (canFn(x, z) && out.every((o) => Math.hypot(o.x - x, o.z - z) > spacing)) { out.push({ x, z }); break; }
      }
    }
    return out;
  };

  // ---- horses: herds along the road side of the pasture (most visible from the road)
  const coatPool = HORSE_COATS.map((c, i) => i).sort(() => rnd() - 0.5);
  let hi = 0, ci = 0;
  const hCan = (x, z) => ground.can(x, z) && x < sim.horseZoneX;
  HERDS.forEach((n, k) => {
    const c = pickCenter(P.z0 + (k / HERDS.length) * spanZ + 8, P.z0 + ((k + 1) / HERDS.length) * spanZ - 8, P.x0 + 8, P.x0 + 32, 34, hCan)
      || pickCenter(P.z0 + 10, P.z1 - 10, P.x0 + 8, P.x0 + 45, 30, hCan);
    if (!c) return;
    const herd = { members: [], ax: c.x, az: c.z, next: 25 + rnd() * 70 + k * 20 };
    sim.herds.push(herd);
    for (const p of scatter(c, n, 6, 2.4, hCan)) {
      if (hi >= NH) break;
      const a = sim.addAgent({ kind: 'horse', i: hi++, x: p.x, z: p.z, h: rnd() * Math.PI * 2, sc: 1.0 + rnd() * 0.1, herd });
      herd.members.push(a);
      const look = HORSE_COATS[coatPool[ci++ % coatPool.length]];
      const o = a.i * 4, seed = Math.floor(rnd() * 250) + 1;
      H.attrs.aCoat.array.set([...rgb(look[0]), seed + Math.min(0.99, look[3])], o);
      H.attrs.aMane.array.set([...rgb(look[1]), look[2]], o);
    }
  });

  // ---- sheep flocks: half near the road side, the rest deeper in the pasture
  const sCan = (x, z) => ground.can(x, z);
  const totalW = SHEEP_LOOKS.reduce((s, l) => s + l[3], 0);
  const pickLook = () => { let r = rnd() * totalW; for (const l of SHEEP_LOOKS) { r -= l[3]; if (r <= 0) return l; } return SHEEP_LOOKS[0]; };
  let si = 0;
  FLOCKS.forEach((n, k) => {
    const near = k % 2 === 0 || k === 3;
    const zA = P.z0 + (k / FLOCKS.length) * spanZ + 6, zB = P.z0 + ((k + 1) / FLOCKS.length) * spanZ - 6;
    const c = pickCenter(zA, zB, near ? P.x0 + 8 : P.x0 + 90, near ? P.x0 + 60 : P.x1 - 20, 28, sCan)
      || pickCenter(P.z0 + 10, P.z1 - 10, P.x0 + 10, P.x1 - 20, 24, sCan);
    if (!c) return;
    const flock = { members: [], ax: c.x, az: c.z, cx: c.x, cz: c.z, R: 3.2 + 0.25 * n, next: 30 + rnd() * 90, sinceMove: 99 };
    sim.flocks.push(flock);
    for (const p of scatter(c, n, 3.2, 1.0, sCan)) {
      if (si >= NS) break;
      const look = pickLook();
      const horned = rnd() < 0.3 ? 0.9 + rnd() * 0.2 : rnd() < 0.08 ? 0.5 : 0;
      const a = sim.addAgent({ kind: 'sheep', i: si++, x: p.x, z: p.z, h: rnd() * Math.PI * 2, sc: 0.95 + rnd() * 0.24, flock, horn: horned });
      flock.members.push(a);
      const o = a.i * 4, seed = Math.floor(rnd() * 250) + 1;
      S.attrs.aCoat.array.set([...rgb(look[0]), seed + Math.min(0.99, look[2])], o);
      S.attrs.aMane.array.set([...rgb(look[1]), 1], o);
    }
  });
  // agents that could not be placed keep instances off-screen
  const nH = hi, nS = si;
  H.mesh.count = nH; S.mesh.count = nS;
  // static culling sphere over the whole pasture: nothing is drawn (or shadow-cast) while the pasture is out of view
  {
    let y0 = 1e9, y1 = -1e9;
    for (let x = P.x0; x <= P.x1; x += 20) for (let z = P.z0; z <= P.z1; z += 20) { const y = world.heightAt(x, z); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cc = new THREE.Vector3((P.x0 + P.x1) / 2, (y0 + y1) / 2 + 1, (P.z0 + P.z1) / 2);
    const r = Math.hypot((P.x1 - P.x0) / 2, (P.z1 - P.z0) / 2, (y1 - y0) / 2) + 6;
    for (const m of [H.mesh, S.mesh]) { m.frustumCulled = true; m.boundingSphere = new THREE.Sphere(cc, r); }
  }
  H.attrs.aCoat.needsUpdate = H.attrs.aMane.needsUpdate = true;
  S.attrs.aCoat.needsUpdate = S.attrs.aMane.needsUpdate = true;

  // settle overlaps once
  for (let i = 0; i < 12; i++) sim.separate();

  const buf = {
    horse: { matrix: H.mesh.instanceMatrix, p0: H.attrs.aPose0.array, p1: H.attrs.aPose1.array, p2: H.attrs.aPose2.array },
    sheep: { matrix: S.mesh.instanceMatrix, p0: S.attrs.aPose0.array, p1: S.attrs.aPose1.array, p2: S.attrs.aPose2.array },
  };
  // prime poses so the first frame is already a grazing animal
  for (const a of sim.agents) { a.neck = a.neckT = a.kind === 'horse' ? 1.36 : 0.85; a.head = a.headT = a.kind === 'horse' ? -0.78 : 0.62; a.stance = a.stanceT = a.kind === 'horse' ? 1 : 0; }
  for (let i = 0; i < 12; i++) sim.update(0.016);   // every animal gets stepped once (LOD periods <= 10)
  sim.writeAll(buf);
  for (const k of ['horse', 'sheep']) { buf[k].matrix.needsUpdate = true; }
  for (const at of [H.attrs.aPose0, H.attrs.aPose1, H.attrs.aPose2, S.attrs.aPose0, S.attrs.aPose1, S.attrs.aPose2]) at.needsUpdate = true;

  // ---- quality: fewer animals on weaker settings
  const setQuality = (q) => {
    const fh = q === 'low' ? 0.6 : q === 'medium' ? 0.8 : 1, fs = q === 'low' ? 0.5 : q === 'medium' ? 0.8 : 1;
    const ch = Math.max(1, Math.round(nH * fh)), cs = Math.max(1, Math.round(nS * fs));
    for (const a of sim.horses) a.active = a.i < ch;
    for (const a of sim.sheep) a.active = a.i < cs;
    H.mesh.count = ch; S.mesh.count = cs;
  };
  const unsub = ctx.state?.on ? ctx.state.on('resolvedQuality', setQuality) : null;
  if (ctx.state?.get) setQuality(ctx.state.get('resolvedQuality'));

  return {
    sim, meshes: { horses: H.mesh, sheep: S.mesh },
    update(dt) {
      if (!(dt > 0)) return;
      sim.update(Math.min(dt, 0.1));
      sim.writeAll(buf);
      if (buf.horse.matrixDirty) { H.mesh.instanceMatrix.needsUpdate = true; buf.horse.matrixDirty = false; }
      if (buf.sheep.matrixDirty) { S.mesh.instanceMatrix.needsUpdate = true; buf.sheep.matrixDirty = false; }
      if (buf.horse.poseDirty) { H.attrs.aPose0.needsUpdate = H.attrs.aPose1.needsUpdate = H.attrs.aPose2.needsUpdate = true; buf.horse.poseDirty = false; }
      if (buf.sheep.poseDirty) { S.attrs.aPose0.needsUpdate = S.attrs.aPose1.needsUpdate = S.attrs.aPose2.needsUpdate = true; buf.sheep.poseDirty = false; }
    },
    dispose() {
      if (unsub) unsub();
      scene.remove(H.mesh, S.mesh);
      for (const m of [H.mesh, S.mesh]) { m.geometry.dispose(); m.material.dispose(); m.customDepthMaterial?.dispose(); m.dispose?.(); }
    },
  };
}
