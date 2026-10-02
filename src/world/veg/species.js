// Instanced plant species: each builder returns one geometry variant (local
// space, origin at the ground, +Y up) as { parts: [{geo, mat, cast}], bound }.
// lod = 0 (near, full detail) or 1 (far, simplified).

import * as THREE from 'three';
import { mulberry32 } from '../../core/noise.js';
import { Geo, tube, leafBlade, card } from './geo.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const dirAP = (az, pitch) => V(Math.cos(pitch) * Math.sin(az), Math.sin(pitch), Math.cos(pitch) * Math.cos(az));
const stemUV = (slot) => (u, v) => [slot.u0 + (slot.u1 - slot.u0) * u, slot.v0 + (slot.v1 - slot.v0) * Math.min(1, v)];
const jit = (R, c, k = 0.08) => { const f = 1 + (R() - 0.5) * 2 * k; return [c[0] * f, c[1] * f, c[2] * f]; };

/** A clump of foliage cards with bent normals (crowns, shrubs). */
export function clump(geo, slots, R, o) {
  const { c, rx, ry, n, size, cc, tint, bendFn } = o;
  const flutter = o.flutter ?? 0.07;
  const aoBase = o.aoBase ?? 0.45;
  const tmp = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), ref = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    let dx, dy, dz;
    do { dx = R() * 2 - 1; dy = R() * 2 - 1; dz = R() * 2 - 1; } while (dx * dx + dy * dy + dz * dz > 1 || dx * dx + dy * dy + dz * dz < 0.05);
    dy = dy * 0.85 + (o.upBias ?? 0.2);
    const rr = 0.5 + 0.5 * Math.sqrt(R());
    const dl = Math.hypot(dx, dy, dz);
    const p = V(c.x + (dx / dl) * rx * rr, c.y + (dy / dl) * ry * rr, c.z + (dz / dl) * rx * rr);
    const nOut = V(dx, dy * 1.2 + 0.3, dz).normalize();
    ref.set(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
    right.crossVectors(nOut, ref).normalize();
    up.crossVectors(right, nOut).normalize();
    if (up.y < 0) { up.negate(); right.negate(); }
    const s = size * (0.8 + 0.4 * R());
    const hw = s * 0.5, hh = s;
    const anchor = p.clone().addScaledVector(up, -hh * 0.5);
    tmp.subVectors(p, cc).normalize();
    const bent = tmp.clone().multiplyScalar(0.7).addScaledVector(nOut, 0.3).normalize();
    const hf = (p.y - c.y) / Math.max(0.1, ry);
    const ao = aoBase + (1 - aoBase) * THREE.MathUtils.clamp(0.25 + 0.45 * rr + 0.3 * hf, 0, 1);
    const colr = jit(R, [tint[0] * ao, tint[1] * ao, tint[2] * ao], 0.1);
    const lp = R();
    const slot = slots[(R() * slots.length) | 0];
    card(geo, slot, anchor, right.multiplyScalar(hw), up.multiplyScalar(hh), bent, colr,
      (y, v) => [bendFn(y), flutter * (0.3 + 0.7 * v), o.objPh || 0, lp]);
  }
}

/* ------------------------------------------------------------- mid tree */
const MID_TINTS = [[0.95, 1.0, 0.95], [1.08, 1.06, 0.86], [0.86, 0.95, 1.02], [1.0, 0.98, 0.9], [0.9, 1.02, 0.92]];

export function midTree(seed, lod, atlas) {
  const R = mulberry32(seed);
  const bark = new Geo(), leaves = new Geo();
  const H = 12 + R() * 8;
  const sway = 0.3;
  const bendFn = (y) => sway * Math.pow(Math.max(0, y) / H, 2);
  const lx = (R() - 0.5) * 1.4, lz = (R() - 0.5) * 1.4, ph = R() * 6;
  const rows = lod ? 6 : 12;
  const path = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    path.push(V(lx * t * t + Math.sin(t * 5 + ph) * 0.18 * t, -0.4 + t * H * 0.92, lz * t * t + Math.cos(t * 4 + ph) * 0.18 * t));
  }
  const r0 = 0.22 + R() * 0.14;
  const circ = Math.PI * 2 * r0;
  tube(bark, path, (t, a) => {
    const y = t * H;
    return r0 * (1 - 0.7 * Math.pow(t, 0.8)) * (1 + 0.9 * Math.exp(-y / 0.7)) * (1 + 0.07 * Math.sin(a * 3 + ph));
  }, {
    radial: lod ? 5 : 9, uRep: 1, texLen: circ * 1.5,
    col: (t) => { const ao = 0.45 + 0.55 * Math.min(1, t * 5); return [ao, ao, ao]; },
    wind: (t, p) => [bendFn(p.y), 0, 0, 0],
  });
  const slotsAll = [atlas.slots.canopyA, atlas.slots.canopyC, atlas.slots.canopyB];
  const primary = slotsAll[seed % 3];
  const slots = [primary, primary, slotsAll[(seed + 1) % 3]];
  const tint = MID_TINTS[seed % MID_TINTS.length];
  const clumps = [];
  const nb = 4 + ((R() * 3) | 0);
  const pathAt = (t) => {
    const f = t * (rows - 1), i = Math.min(rows - 2, Math.floor(f));
    return path[i].clone().lerp(path[i + 1], f - i);
  };
  for (let b = 0; b < nb; b++) {
    const tb = 0.4 + (b / nb) * 0.48 + R() * 0.05;
    const base = pathAt(tb);
    const az = b * 2.4 + R() * 0.6, el = 0.45 + R() * 0.5;
    const L = (2.6 + R() * 3.0) * (1.15 - tb * 0.5);
    const d = dirAP(az, el);
    const bp = [];
    const nr = lod ? 3 : 5;
    for (let k = 0; k < nr; k++) {
      const s = k / (nr - 1);
      bp.push(base.clone().addScaledVector(d, L * s).add(V(0, s * s * L * 0.35, 0)));
    }
    const br = 0.1 * (0.7 + 0.3 * (1 - tb)) * (r0 / 0.3);
    tube(bark, bp, (t) => br * (1 - 0.6 * t), {
      radial: lod ? 4 : 5, uRep: 1, texLen: circ,
      col: () => [0.8, 0.8, 0.8], wind: (t, p) => [bendFn(p.y), 0, 0, 0],
    });
    clumps.push({ c: bp[nr - 1].clone().add(V(0, 0.5, 0)), r: 1.8 + R() * 1.2 });
    const mid = bp[Math.floor(nr / 2)];
    clumps.push({ c: mid.clone().add(V(0, 0.4, 0)), r: 1.1 + R() * 0.6 });
  }
  clumps.push({ c: path[rows - 1].clone().add(V(0, 0.6, 0)), r: 2.0 + R() * 0.8 });
  const cc = new THREE.Vector3();
  for (const c of clumps) cc.add(c.c);
  cc.divideScalar(clumps.length).y -= 1.5;
  for (const c of clumps) {
    clump(leaves, slots, R, {
      c: c.c, rx: c.r, ry: c.r * 0.6, n: Math.round(c.r * c.r * (lod ? 2.6 : 6.5)), size: (lod ? 2.5 : 1.9) * Math.sqrt(c.r / 2.2),
      cc, tint, bendFn, flutter: 0.07,
    });
  }
  // hang points for vines (world placement transforms these)
  const hang = clumps.map((c) => [c.c.x, c.c.y - c.r * 0.5, c.c.z]);
  return {
    parts: [{ geo: bark.build(), mat: 'barkMid', cast: true }, { geo: leaves.build(), mat: 'foliage', cast: true }],
    bound: { y: H * 0.65, r: H * 0.5 }, hang, H,
  };
}

/* ----------------------------------------------------------------- palm */
export function palm(seed, lod, atlas) {
  const R = mulberry32(seed);
  const bark = new Geo(), leaves = new Geo();
  const H = 6 + R() * 7;
  const sway = 0.45;
  const bendFn = (y) => sway * Math.pow(Math.max(0, y) / H, 2);
  const az0 = R() * 6.28, bow = 0.6 + R() * 1.4;
  const rows = lod ? 5 : 10;
  const path = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    path.push(V(Math.sin(az0) * bow * Math.pow(t, 1.6), -0.3 + t * H, Math.cos(az0) * bow * Math.pow(t, 1.6)));
  }
  const r0 = 0.14 + R() * 0.05;
  tube(bark, path, (t) => r0 * (1 - 0.25 * t) * (1 + 0.6 * Math.exp(-t * H / 0.5)), {
    radial: lod ? 5 : 8, uRep: 1, texLen: 2.6,
    col: (t) => { const ao = 0.5 + 0.5 * Math.min(1, t * 4); return [ao, ao, ao]; },
    wind: (t, p) => [bendFn(p.y), 0, 0, 0],
  });
  const top = path[rows - 1];
  // crown shaft
  tube(leaves, [top.clone().add(V(0, -0.6, 0)), top.clone().add(V(0, 0.25, 0))], (t) => r0 * (1.15 - 0.4 * t), {
    radial: 5, uvMap: stemUV(atlas.slots.stem), col: () => [0.8, 0.9, 0.7], wind: (t, p) => [bendFn(p.y), 0, 0, 0],
  });
  const tint = [[0.95, 1.0, 0.9], [1.05, 1.04, 0.85], [0.9, 0.98, 0.95]][seed % 3];
  const nF = lod ? 7 : 13;
  for (let f = 0; f < nF; f++) {
    const az = f * 2.39996 + R() * 0.3;
    const pitch = 0.2 + R() * 0.8;
    const L = 3.0 + R() * 1.6;
    leafBlade(leaves, atlas.slots.palm, {
      origin: top.clone().add(V(0, 0.2, 0)), dir: dirAP(az, pitch), length: L, width: L * 0.48,
      segL: lod ? 4 : 8, segW: 1, droop: 1.6 + R() * 0.9, fold: 0.22, attach: 0,
      col: jit(R, tint, 0.1), ao: 0.4, bendFn, flutter: 0.22, leafPh: R(), twist: (R() - 0.5) * 0.7,
    });
  }
  if (!lod) {
    for (let f = 0; f < 2; f++) {
      leafBlade(leaves, atlas.slots.palm, {
        origin: top.clone().add(V(0, -0.1, 0)), dir: dirAP(R() * 6.28, -1.0 - R() * 0.3), length: 2.4, width: 1.0,
        segL: 4, segW: 1, droop: 0.2, fold: 0.1, col: [1.25, 0.92, 0.62], ao: 0.2, bendFn, flutter: 0.05, leafPh: R(),
      });
    }
  }
  return {
    parts: [{ geo: bark.build(), mat: 'barkPalm', cast: true }, { geo: leaves.build(), mat: 'broadleaf', cast: true }],
    bound: { y: H * 0.8, r: H * 0.55 }, H,
  };
}

/* ------------------------------------------------------------ tree fern */
export function treeFern(seed, lod, atlas) {
  const R = mulberry32(seed);
  const bark = new Geo(), leaves = new Geo();
  const H = 1.6 + R() * 3.4;
  const bendFn = (y) => 0.1 * Math.pow(Math.max(0, y) / H, 2) + 0.03 * Math.max(0, y - H);
  const rows = lod ? 4 : 7;
  const lx = (R() - 0.5) * 0.6, lz = (R() - 0.5) * 0.6;
  const path = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    path.push(V(lx * t * t, -0.2 + t * H, lz * t * t));
  }
  const r0 = 0.12 + R() * 0.06;
  tube(bark, path, (t, a) => r0 * (1 + 0.9 * Math.exp(-t * H / 0.35)) * (1 + 0.12 * t) * (1 + 0.08 * Math.sin(a * 5 + t * 20)), {
    radial: lod ? 5 : 8, uRep: 1, texLen: 1.3,
    col: (t) => { const ao = 0.55 + 0.45 * t; return [ao, ao, ao]; },
    wind: (t, p) => [bendFn(p.y), 0, 0, 0],
  });
  const top = path[rows - 1].clone().add(V(0, 0.08, 0));
  const tint = [[1, 1, 1], [0.92, 1.0, 0.92], [1.06, 1.04, 0.88]][seed % 3];
  const nF = lod ? 10 : 19;
  for (let f = 0; f < nF; f++) {
    const az = f * 2.39996 + R() * 0.3;
    const L = 2.2 + R() * 1.3;
    leafBlade(leaves, R() < 0.6 ? atlas.slots.fern : atlas.slots.fernB, {
      origin: top, dir: dirAP(az, 0.35 + R() * 0.55), length: L, width: L * 0.55,
      segL: lod ? 4 : 7, segW: 1, droop: 1.6 + R() * 0.9, fold: -0.1, attach: 0,
      col: jit(R, tint, 0.12), ao: 0.35, bendFn, flutter: 0.14, leafPh: R(), twist: (R() - 0.5) * 0.5,
    });
  }
  if (!lod) {
    // dead skirt
    const nd = 3 + ((R() * 4) | 0);
    for (let f = 0; f < nd; f++) {
      leafBlade(leaves, atlas.slots.fernDead, {
        origin: top.clone().add(V(0, -0.1, 0)), dir: dirAP(R() * 6.28, -1.25 - R() * 0.25), length: 1.2 + R() * 0.7, width: 0.6,
        segL: 3, segW: 1, droop: 0.15, fold: -0.05, col: [0.9, 0.9, 0.9], ao: 0.3, bendFn, flutter: 0.03, leafPh: R(),
      });
    }
    // unfurling crosiers
    for (let f = 0; f < 3; f++) {
      leafBlade(leaves, atlas.slots.fernB, {
        origin: top, dir: dirAP(R() * 6.28, 1.3), length: 0.5, width: 0.18, segL: 3, segW: 1,
        droop: 3.2, fold: 0, col: [1.1, 1.08, 0.9], ao: 0.2, bendFn, flutter: 0.02, leafPh: R(),
      });
    }
  }
  return {
    parts: [{ geo: bark.build(), mat: 'barkFern', cast: true }, { geo: leaves.build(), mat: 'broadleaf', cast: true }],
    bound: { y: H * 0.8, r: H * 0.5 + 2.2 }, H,
  };
}

/* ------------------------------------------------- aroids (alocasia / monstera) */
export function aroid(seed, lod, atlas, kind) {
  const R = mulberry32(seed);
  const g = new Geo();
  const mon = kind === 'monstera';
  const slot = mon ? atlas.slots.monstera : atlas.slots.alocasia;
  const n0 = mon ? 3 + ((R() * 4) | 0) : 4 + ((R() * 4) | 0);
  const n = lod ? Math.min(n0, 4) : n0;
  const size = mon ? 1.0 + R() * 0.5 : 0.8 + R() * 0.5;
  const bendFn = (y) => 0.04 * Math.max(0, y);
  const tint = mon ? [0.92, 1.0, 0.95] : [[1, 1, 1], [0.94, 1.02, 0.98], [1.06, 1.05, 0.9]][seed % 3];
  let maxR = 0, maxY = 0;
  for (let k = 0; k < n; k++) {
    const az = k * 2.39996 + R() * 0.5;
    const petL = (mon ? 0.6 + R() * 0.9 : 0.5 + R() * 0.8) * (0.8 + size * 0.3);
    const pp = 1.0 + R() * 0.4;
    const d = dirAP(az, pp);
    const base = V((R() - 0.5) * 0.1, -0.05, (R() - 0.5) * 0.1);
    const pts = [];
    const nr = lod ? 3 : 5;
    for (let i = 0; i < nr; i++) {
      const s = i / (nr - 1);
      // petioles arch outward
      pts.push(base.clone().addScaledVector(d, petL * s).add(V(Math.sin(az) * s * s * petL * 0.3, -s * s * 0.12 * petL, Math.cos(az) * s * s * petL * 0.3)));
    }
    tube(g, pts, (t) => 0.024 * size * (1 - 0.35 * t), {
      radial: lod ? 3 : 4, uvMap: stemUV(atlas.slots.stem),
      col: () => [0.85, 0.9, 0.8], wind: (t, p) => [bendFn(p.y), 0, 0, 0],
    });
    const top = pts[nr - 1];
    const L = size * (0.75 + R() * 0.45);
    leafBlade(g, slot, {
      origin: top, dir: dirAP(az + (R() - 0.5) * 0.4, (mon ? 0.1 : 0.25) + R() * 0.35), length: L, width: L * 0.98,
      segL: lod ? 3 : 6, segW: lod ? 1 : 2, droop: (mon ? 0.7 : 0.9) + R() * 0.6, fold: 0.07 * L,
      attach: mon ? 0.14 : 0.26, col: jit(R, tint, 0.1), ao: 0.35, bendFn, flutter: 0.05, leafPh: R(),
      twist: (R() - 0.5) * 0.5, uFlip: R() < 0.5,
    });
    maxR = Math.max(maxR, Math.hypot(top.x, top.z) + L);
    maxY = Math.max(maxY, top.y + L * 0.4);
  }
  return { parts: [{ geo: g.build(), mat: 'broadleaf', cast: true }], bound: { y: maxY * 0.5, r: Math.max(maxR, maxY) }, reach: maxR };
}

/* --------------------------------------------------------------- banana */
export function banana(seed, lod, atlas) {
  const R = mulberry32(seed);
  const g = new Geo();
  const Hs = 1.3 + R() * 1.7;
  const bendFn = (y) => 0.08 * Math.pow(Math.max(0, y) / Hs, 2) + 0.02 * Math.max(0, y - Hs);
  const stem = [V(0, -0.2, 0), V(0.02, Hs * 0.5, 0.01), V(0.05, Hs, 0.03)];
  tube(g, stem, (t) => (0.13 + (seed % 3) * 0.02) * (1 - 0.3 * t), {
    radial: lod ? 5 : 7, uvMap: stemUV(atlas.slots.stem), col: () => [0.75, 0.72, 0.62],
    wind: (t, p) => [bendFn(p.y), 0, 0, 0],
  });
  const top = stem[2];
  const nL = lod ? 5 : 8;
  let reach = 0;
  for (let k = 0; k < nL; k++) {
    const az = k * 2.39996 + R() * 0.4;
    const old = !lod && k >= nL - 2;
    const L = 1.5 + R() * 1.2;
    leafBlade(g, atlas.slots.banana, {
      origin: top.clone().add(V(0, -k * 0.04, 0)), dir: dirAP(az, old ? -0.7 : 0.7 + R() * 0.6), length: L, width: L * 0.44,
      segL: lod ? 4 : 8, segW: 1, droop: old ? 0.6 : 1.1 + R() * 0.9, fold: 0.06, attach: 0,
      col: old ? [1.22, 0.92, 0.6] : jit(R, [0.95, 1.0, 0.92], 0.1), ao: 0.3, bendFn, flutter: 0.16, leafPh: R(),
      twist: (R() - 0.5) * 0.9, uFlip: R() < 0.5,
    });
    reach = Math.max(reach, L * 0.8);
  }
  return { parts: [{ geo: g.build(), mat: 'broadleaf', cast: true }], bound: { y: Hs, r: Hs + 1.5 }, reach, H: Hs };
}

/* ----------------------------------------------------------- ground fern */
export function groundFern(seed, lod, atlas) {
  const R = mulberry32(seed);
  const g = new Geo();
  const nF = lod ? 6 : 12 + ((R() * 5) | 0);
  const size = 0.7 + R() * 0.6;
  const bendFn = (y) => 0.03 * Math.max(0, y);
  const tint = [[1, 1, 1], [0.9, 0.98, 0.94], [1.08, 1.05, 0.86]][seed % 3];
  for (let k = 0; k < nF; k++) {
    const az = k * 2.39996 + R() * 0.4;
    const L = size * (0.8 + R() * 0.5);
    leafBlade(g, R() < 0.5 ? atlas.slots.fern : atlas.slots.fernB, {
      origin: V((R() - 0.5) * 0.1, 0.0, (R() - 0.5) * 0.1), dir: dirAP(az, 0.7 + R() * 0.6), length: L, width: L * 0.5,
      segL: lod ? 3 : 6, segW: 1, droop: 1.4 + R() * 1.0, fold: -0.03, attach: 0,
      col: jit(R, tint, 0.12), ao: 0.45, bendFn, flutter: 0.08, leafPh: R(), twist: (R() - 0.5) * 0.4,
    });
  }
  return { parts: [{ geo: g.build(), mat: 'broadleaf', cast: false }], bound: { y: size * 0.4, r: size * 1.1 }, reach: size };
}

/* ------------------------------------------------------ sedge / strap clump */
export function sedge(seed, lod, atlas) {
  const R = mulberry32(seed);
  const g = new Geo();
  const n = lod ? 5 : 10;
  const bendFn = (y) => 0.05 * Math.max(0, y);
  for (let k = 0; k < n; k++) {
    const L = 0.45 + R() * 0.55;
    leafBlade(g, atlas.slots.strap, {
      origin: V((R() - 0.5) * 0.12, -0.02, (R() - 0.5) * 0.12), dir: dirAP(k * 2.39996, 0.9 + R() * 0.5), length: L, width: 0.3,
      segL: lod ? 2 : 4, segW: 1, droop: 1.0 + R() * 0.8, fold: 0, attach: 0,
      col: jit(R, [0.95, 1.0, 0.9], 0.12), ao: 0.5, bendFn, flutter: 0.06, leafPh: R(), twist: (R() - 0.5) * 1.2,
    });
  }
  return { parts: [{ geo: g.build(), mat: 'broadleaf', cast: false }], bound: { y: 0.3, r: 0.8 }, reach: 0.6 };
}

/* --------------------------------------------------------------- shrub */
export function shrub(seed, lod, atlas) {
  const R = mulberry32(seed);
  const g = new Geo();
  const Hs = 1.0 + R() * 1.4;
  const bendFn = (y) => 0.05 * Math.max(0, y);
  const tint = [[1, 1, 1], [1.05, 1.04, 0.88], [0.9, 0.98, 1.0]][seed % 3];
  const tiers = 2 + ((R() * 2) | 0);
  const cc = V(0, Hs * 0.4, 0);
  for (let k = 0; k < tiers; k++) {
    const y = Hs * (0.35 + 0.65 * (k / Math.max(1, tiers - 1)));
    const r = (0.55 + R() * 0.35) * (1.1 - 0.3 * (k / tiers));
    clump(g, [atlas.slots.shrub, atlas.slots.shrub, atlas.slots.canopyB], R, {
      c: V((R() - 0.5) * 0.3, y, (R() - 0.5) * 0.3), rx: r, ry: r * 0.45, n: lod ? 4 : 8, size: lod ? 1.0 : 0.8,
      cc, tint, bendFn, flutter: 0.05, aoBase: 0.4, upBias: 0.35,
    });
  }
  return { parts: [{ geo: g.build(), mat: 'foliage', cast: true }], bound: { y: Hs * 0.5, r: Hs * 0.8 }, reach: 0.9 };
}
