// Emergent buttressed giants (unique, built directly in world space and merged
// into chunk meshes) + the hollow landmark tree.

import * as THREE from 'three';
import { mulberry32, smoothstep, clamp, lerp } from '../../core/noise.js';
import { tube, emitGrid, leafBlade, card } from './geo.js';
import { clump } from './species.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const dirAP = (az, pitch) => V(Math.cos(pitch) * Math.sin(az), Math.sin(pitch), Math.cos(pitch) * Math.cos(az));
const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

const CROWN_TINTS = [
  [0.9, 1.0, 0.92], [1.08, 1.06, 0.84], [0.84, 0.94, 1.0], [1.0, 1.0, 0.9], [1.12, 1.0, 0.82], [0.92, 1.02, 0.96],
];

/**
 * Build one emergent tree.
 * G: { bark, leaf, liana, broad } Geo accumulators (world space)
 * opt: { giant, hollowDir }
 * Returns { colliders: [[x,z,r]], hang: [Vector3], crownTop, H }
 */
export function buildEmergent(G, world, atlas, x, z, seed, opt = {}) {
  const R = mulberry32(seed);
  const giant = !!opt.giant;
  const H = giant ? 50 : 32 + R() * 12;
  const rTop = giant ? 1.1 : 0.45 + R() * 0.15;
  const rBase = giant ? 2.35 : 0.8 + R() * 0.4;
  const objPh = R();
  // ground: lowest point around the base so nothing floats
  let y0 = Infinity;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    y0 = Math.min(y0, world.heightAt(x + Math.cos(a) * rBase * 1.3, z + Math.sin(a) * rBase * 1.3));
  }
  y0 = Math.min(y0, world.heightAt(x, z));
  const sway = giant ? 0.18 : 0.35;
  const bendFn = (y) => sway * Math.pow(clamp((y - y0) / H, 0, 1.3), 2.5);
  const windT = (t, p) => [bendFn(p.y), 0, objPh, 0];

  // buttress fin layout
  const hollowAz = opt.hollowDir ?? 0;
  const nFins = giant ? 7 : 3 + ((R() * 4) | 0);
  const fins = [];
  let tries = 0;
  while (fins.length < nFins && tries++ < 200) {
    const a = R() * TAU;
    if (fins.some((f) => Math.abs(angDiff(f.a, a)) < (giant ? 0.62 : 0.85))) continue;
    if (giant && Math.abs(angDiff(a, hollowAz)) < 0.75) continue;
    fins.push({ a, L: giant ? 4.5 + R() * 2.5 : 2.2 + R() * 2.2, h: giant ? 5.5 + R() * 3 : 2.6 + R() * 2.4, w: (R() - 0.5) * 2, th: giant ? 0.42 : 0.26 + R() * 0.08 });
  }
  const lobe = (y, a) => {
    let s = 0;
    const hy = Math.max(0, y);
    for (const f of fins) {
      const d = angDiff(a, f.a);
      // narrow ridge that climbs the trunk up to the fin's top
      s += Math.exp(-(d * d) / 0.018) * (f.L / 3.2) * Math.exp(-hy / (f.h * 0.55));
    }
    return s;
  };

  // trunk path
  const lean = V((R() - 0.5) * 1.6, 0, (R() - 0.5) * 1.6);
  const rows = giant ? 26 : 18;
  const trunkTopY = H * 0.8;
  const path = [];
  const hs = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const hh = -1.2 + Math.pow(t, 1.5) * (trunkTopY + 1.2);
    hs.push(hh);
    const tt = Math.max(0, hh) / H;
    path.push(V(x + lean.x * tt * tt + Math.sin(tt * 7 + seed) * 0.25 * tt, y0 + hh, z + lean.z * tt * tt + Math.cos(tt * 6 + seed) * 0.25 * tt));
  }
  const radiusAt = (hh, a) => {
    const t = clamp(hh / trunkTopY, 0, 1);
    const core = lerp(rBase, rTop, Math.pow(t, 0.7)) * (1 + 0.28 * Math.exp(-Math.max(0, hh) / 1.6));
    const bumps = 1 + 0.035 * Math.sin(a * 5 + hh * 0.4 + seed) + 0.025 * Math.sin(a * 9 - hh * 0.9);
    return core * bumps + lobe(hh, a) * 0.9;
  };
  const circ = TAU * rBase;
  const uRep = Math.max(2, Math.round(circ / 2.6));
  const texLen = circ / uRep;
  const mossSide = R() * TAU;
  const trunkCol = (hh, a, p) => {
    const ao = 0.42 + 0.58 * smoothstep(-0.5, 5, hh);
    const deep = 1 - 0.35 * lobe(hh, a) / (1 + lobe(hh, a)); // crevices between fins
    const moss = smoothstep(0.2, 1, Math.cos(a - mossSide)) * (1 - smoothstep(4, 18, hh)) * 0.7 + (1 - smoothstep(0, 2.5, hh)) * 0.3;
    const up = smoothstep(trunkTopY * 0.6, trunkTopY, hh) * 0.12;
    const k = ao * deep;
    return [k * lerp(1, 0.72, moss) * (1 + up), k * lerp(1, 0.9, moss) * (1 + up), k * lerp(1, 0.55, moss) * (1 + up)];
  };

  const colliders = [];
  if (giant) {
    buildHollowTrunk(G, world, { x, z, y0, rows, hs, path, radiusAt, trunkCol, windT, uRep, texLen, hollowAz, colliders, rBase });
  } else {
    tube(G.bark, path, (t, a, i) => radiusAt(hs[i], a), {
      radial: 18, uRep, texLen,
      col: (t, a, p, i) => trunkCol(hs[i], a, p), wind: windT,
    });
    colliders.push([x, z, rBase * 1.25]);
  }

  // buttress fins
  for (const f of fins) {
    buildFin(G, world, { x, z, y0, f, rBase, radiusAt, texLen, windT, colliders, giant });
  }

  // limbs
  const pathAt = (t) => {
    const fI = t * (rows - 1), i = Math.min(rows - 2, Math.floor(fI));
    return path[i].clone().lerp(path[i + 1], fI - i);
  };
  const top = path[rows - 1];
  const nLimbs = giant ? 7 : 4 + ((R() * 3) | 0);
  const clumps = [];
  const hang = [];
  const crownR = giant ? 16 : 9 + R() * 5;
  for (let b = 0; b < nLimbs; b++) {
    const tb = 0.86 + (b / nLimbs) * 0.14 * R();
    const base = pathAt(Math.min(0.995, tb));
    const az = b * (TAU / nLimbs) + R() * 0.5;
    const el = 0.35 + R() * 0.45;
    const L = crownR * (0.55 + R() * 0.35);
    const d = dirAP(az, el);
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const s = k / 6;
      pts.push(base.clone().addScaledVector(d, L * s).add(V(0, s * s * L * 0.25 - s * (1 - s) * 1.0, 0)));
    }
    const r0 = rTop * (giant ? 0.75 : 0.8);
    tube(G.bark, pts, (t) => r0 * (1 - 0.72 * t), {
      radial: 8, uRep: 1, texLen: TAU * r0 * 1.2,
      col: (t) => { const k = 0.85 + 0.15 * t; return [k, k * 1.02, k * 0.95]; }, wind: windT,
    });
    const end = pts[6];
    clumps.push({ c: end.clone().add(V(0, 1.2, 0)), r: 3.2 + R() * 2.2 });
    // sub-branches
    const nSub = 2 + ((R() * 2) | 0);
    for (let sb = 0; sb < nSub; sb++) {
      const ts = 0.45 + R() * 0.4;
      const sp = pts[Math.round(ts * 6)];
      const saz = az + (R() < 0.5 ? -1 : 1) * (0.6 + R() * 0.7);
      const sd = dirAP(saz, 0.3 + R() * 0.5);
      const sL = 3 + R() * 4;
      const spts = [sp, sp.clone().addScaledVector(sd, sL * 0.5).add(V(0, 0.3, 0)), sp.clone().addScaledVector(sd, sL).add(V(0, sL * 0.35, 0))];
      tube(G.bark, spts, (t) => r0 * 0.4 * (1 - 0.7 * t), {
        radial: 5, uRep: 1, texLen: 1.5, col: () => [0.9, 0.9, 0.86], wind: windT,
      });
      clumps.push({ c: spts[2].clone().add(V(0, 0.9, 0)), r: 2.6 + R() * 1.6 });
      hang.push(spts[1].clone());
    }
    hang.push(pts[4].clone(), pts[5].clone());
    // epiphyte on the limb (bird's-nest fern / bromeliad)
    if (R() < 0.75) epiphyte(G.broad, atlas, R, pts[2].clone().add(V(0, r0 * 0.7, 0)), bendFn, objPh);
  }
  clumps.push({ c: top.clone().add(V(0, 2.5, 0)), r: 3.5 + R() * 1.5 });

  // crown foliage
  const cc = new THREE.Vector3();
  for (const c of clumps) cc.add(c.c);
  cc.divideScalar(clumps.length).y -= 3;
  const tint = CROWN_TINTS[(seed >>> 3) % CROWN_TINTS.length];
  const s = atlas.slots;
  const slots = [[s.canopyA, s.canopyA, s.canopyC], [s.canopyC, s.canopyC, s.canopyA], [s.canopyB, s.canopyA, s.canopyB]][seed % 3];
  for (const c of clumps) {
    clump(G.leaf, slots, R, {
      c: c.c, rx: c.r, ry: c.r * 0.5, n: Math.round(c.r * c.r * 2.6), size: 3.0, cc, tint, bendFn,
      flutter: 0.09, objPh, aoBase: 0.35, upBias: 0.3,
    });
  }

  // climbing philodendron on the trunk
  if (R() < 0.6 || giant) {
    const a0 = R() * TAU, turns = 0.6 + R() * 0.8, hTop = 6 + R() * (giant ? 16 : 12);
    const n = giant ? 90 : 50;
    const vinePts = [];
    for (let k = 0; k < n; k++) {
      const q = k / (n - 1);
      const hh = 0.3 + q * hTop;
      const a = a0 + q * turns * TAU + Math.sin(q * 20) * 0.1;
      const r = radiusAt(hh, a) + 0.06;
      const cp = pathAt(clamp((hh + 1.2) / (trunkTopY + 1.2), 0, 1) ** (1 / 1.5));
      const px = cp.x + Math.cos(a) * r, pz = cp.z + Math.sin(a) * r, py = y0 + hh;
      vinePts.push(V(px, py, pz));
      // leaves pressed to the bark
      if (k % 2 === 0) {
        const out = V(Math.cos(a), 0, Math.sin(a));
        const sz = 0.35 + R() * 0.3 + (giant ? 0.15 : 0);
        const side = V(-Math.sin(a), 0, Math.cos(a)).multiplyScalar((R() - 0.5) * 0.6);
        const upv = V(0, 1, 0).add(side).normalize();
        const anchor = V(px, py, pz).addScaledVector(out, 0.05);
        const right = new THREE.Vector3().crossVectors(upv, out).normalize();
        const nrm = out.clone().add(V(0, 0.3, 0)).normalize();
        const cc2 = jitC(R, [0.95, 1.0, 0.9]);
        card(G.broad, s.heart, anchor, right.multiplyScalar(sz * 0.45), upv.clone().multiplyScalar(sz).addScaledVector(out, sz * 0.5), nrm, cc2,
          (y) => [bendFn(y), 0.03, objPh, R()]);
      }
    }
    tube(G.liana, vinePts.filter((_, k) => k % 3 === 0), () => 0.035, {
      radial: 3, col: () => [0.16, 0.15, 0.1], wind: windT,
    });
  }
  return { colliders, hang, H, y0, top, crownR, objPh, bendFn };
}

function jitC(R, c) { const f = 0.88 + R() * 0.24; return [c[0] * f, c[1] * f, c[2] * f]; }

function epiphyte(geo, atlas, R, p, bendFn, objPh) {
  const n = 7 + ((R() * 5) | 0);
  const slot = R() < 0.5 ? atlas.slots.strap : atlas.slots.fernB;
  for (let k = 0; k < n; k++) {
    const L = 0.7 + R() * 0.6;
    leafBlade(geo, slot, {
      origin: p, dir: dirAP(k * 2.39996, 0.8 + R() * 0.5), length: L, width: slot === atlas.slots.strap ? 0.35 : L * 0.4,
      segL: 3, segW: 1, droop: 1.2 + R() * 0.8, fold: 0.03, attach: 0,
      col: jitC(R, [1.0, 1.02, 0.88]), ao: 0.4, bendFn, flutter: 0.06, objPh, leafPh: R(),
    });
  }
}

/* ------------------------------------------------------------------ fins */
function buildFin(G, world, o) {
  const { x, z, y0, f, rBase, radiusAt, texLen, windT, colliders, giant } = o;
  const rowsN = 14, colsN = 10;
  const dir = V(Math.cos(f.a), 0, Math.sin(f.a));
  const perp = V(-dir.z, 0, dir.x);
  const P = new Float32Array(rowsN * colsN * 3);
  const Y = new Float32Array(rowsN * colsN);
  const S = new Float32Array(rowsN * colsN);
  const rIn = radiusAt(f.h * 0.6, f.a) * 0.55;
  const topAt = rBase * 0.5;
  for (let i = 0; i < rowsN; i++) {
    const s = i / (rowsN - 1);
    const reach = rIn + s * (f.L + topAt);
    const wig = Math.sin(s * Math.PI * 1.4 + f.w * 2) * 0.35 * f.w * s;
    const cx = x + dir.x * reach + perp.x * wig, cz = z + dir.z * reach + perp.z * wig;
    const gy = world.heightAt(cx, cz);
    // top edge falls in a concave curve to the ground
    const q = clamp(s, 0, 1);
    const top = lerp(y0 + f.h, gy, 1 - Math.pow(1 - q, 2.2)) + (1 - q) * 0.2;
    const bot = gy - 0.8;
    const mid = (top + bot) / 2, hh = Math.max(0.05, (top - bot) / 2);
    const th = lerp(f.th, f.th * 0.3, q) * (0.9 + 0.2 * Math.sin(s * 9 + f.a));
    for (let j = 0; j < colsN; j++) {
      const a = (j / colsN) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const vy = Math.sign(ca) * Math.pow(Math.abs(ca), 0.55) * hh;
      // flat sides, flared foot near the ground
      const foot = 1 + 0.9 * smoothstep(0.1, -0.9, ca);
      const vx = Math.sign(sa) * Math.pow(Math.abs(sa), 0.7) * th * foot;
      // frame: T = dir, N = up, B = T × N = (-dir.z, 0, dir.x)?  dir × up = (dir.y*0 - dir.z*1, dir.z*0 - dir.x*0, dir.x*1 - 0) = (-dir.z, 0, dir.x)
      const k = (i * colsN + j) * 3;
      P[k] = cx + (-dir.z) * vx;
      P[k + 1] = mid + vy;
      P[k + 2] = cz + dir.x * vx;
      Y[i * colsN + j] = mid + vy - gy;
      S[i * colsN + j] = reach;
    }
    if (i % 3 === 1 && s > 0.15 && s < 0.85) colliders.push([cx, cz, Math.max(0.35, th * 1.4)]);
  }
  emitGrid(G.bark, P, rowsN, colsN, true, {
    uv: (i, jj) => {
      const j = jj % colsN;
      const k = (i * colsN + j) * 3;
      const side = Math.sin((jj / colsN) * TAU) >= 0 ? 1 : 0;
      return [S[i * colsN + j] / texLen + side * 0.37, (P[k + 1]) / texLen];
    },
    col: (i, j) => {
      const yy = Y[i * colsN + j];
      const s = i / (rowsN - 1);
      const ao = (0.4 + 0.6 * smoothstep(-0.3, 2.2, yy)) * (0.75 + 0.25 * s);
      const topMoss = smoothstep(0.6, 1, Math.cos((j / colsN) * TAU)) * 0.5 + (1 - smoothstep(0, 1, yy)) * 0.35;
      return [ao * lerp(1, 0.7, topMoss), ao * lerp(1, 0.92, topMoss), ao * lerp(1, 0.52, topMoss)];
    },
    wind: () => [0, 0, 0, 0],
  });
}

/* --------------------------------------------------------------- hollow */
function buildHollowTrunk(G, world, o) {
  const { x, z, y0, rows, hs, path, radiusAt, trunkCol, windT, uRep, texLen, hollowAz, colliders, rBase } = o;
  const hOpen = 4.2, wBase = 0.46, wall = 0.5;
  const halfW = (hh) => (hh < 0 ? wBase : wBase * Math.sqrt(Math.max(0, 1 - Math.pow(hh / hOpen, 2.2))));
  // split rows: lower (C-shaped) up to hOpen, upper tube from hOpen - 0.4
  const lowRows = 12;
  const cols = 30;
  const lowH = (i) => -1.2 + (i / (lowRows - 1)) * (hOpen + 1.2);
  const Pout = new Float32Array(lowRows * cols * 3);
  const Pin = new Float32Array(lowRows * cols * 3);
  const Aout = new Float32Array(lowRows * cols);
  const inR = (hh) => Math.max(0.8, rBase * (1 + 0.28 * Math.exp(-Math.max(0, hh) / 1.6)) * 0.95 - wall - 0.25 * smoothstep(0, hOpen, hh));
  for (let i = 0; i < lowRows; i++) {
    const hh = lowH(i);
    const w = Math.max(0.0005, halfW(hh));
    const cy = y0 + hh;
    for (let j = 0; j < cols; j++) {
      const a = hollowAz + w + (j / (cols - 1)) * (TAU - 2 * w);
      Aout[i * cols + j] = a;
      const ro = radiusAt(hh, a);
      const ri = inR(hh) * (1 + 0.05 * Math.sin(a * 4 + hh));
      const k = (i * cols + j) * 3;
      Pout[k] = x + Math.cos(a) * ro; Pout[k + 1] = cy; Pout[k + 2] = z + Math.sin(a) * ro;
      Pin[k] = x + Math.cos(a) * ri; Pin[k + 1] = cy; Pin[k + 2] = z + Math.sin(a) * ri;
    }
  }
  // Outer: our parameterisation runs with increasing angle in the XZ plane (x=cos, z=sin),
  // which viewed from +Y is clockwise → normals from cross(dCol,dRow) point inward; flip.
  emitGrid(G.bark, Pout, lowRows, cols, false, {
    uv: (i, j) => [(Aout[i * cols + j] / TAU) * uRep, (Pout[(i * cols + j) * 3 + 1] - y0) / texLen],
    col: (i, j) => trunkCol(lowH(i), Aout[i * cols + j]),
    wind: () => [0, 0, 0, 0],
  }, true);
  const dark = (i, j) => {
    const hh = lowH(i);
    const a = Aout[i * cols + j];
    const nearEdge = Math.min(Math.abs(angDiff(a, hollowAz)), Math.PI) / Math.PI; // 0 at opening
    const k = 0.12 + 0.22 * (1 - nearEdge) * (1 - smoothstep(0, hOpen, hh));
    return [k * 1.1, k * 0.85, k * 0.7];
  };
  emitGrid(G.bark, Pin, lowRows, cols, false, {
    uv: (i, j) => [(Aout[i * cols + j] / TAU) * uRep * 0.7, (Pin[(i * cols + j) * 3 + 1] - y0) / texLen],
    col: dark, wind: () => [0, 0, 0, 0],
  }, false);
  // rims joining outer and inner along both opening edges
  for (const jEdge of [0, cols - 1]) {
    const base = G.bark.nv;
    for (let i = 0; i < lowRows; i++) {
      const k = (i * cols + jEdge) * 3;
      const a = Aout[i * cols + jEdge];
      const tn = jEdge === 0 ? V(Math.sin(a), 0, -Math.cos(a)) : V(-Math.sin(a), 0, Math.cos(a));
      const c = 0.35;
      G.bark.v(Pout[k], Pout[k + 1], Pout[k + 2], tn.x, tn.y, tn.z, 0, lowH(i) / texLen, c * 1.1, c * 0.9, c * 0.75, 0, 0, 0, 0);
      G.bark.v(Pin[k], Pin[k + 1], Pin[k + 2], tn.x, tn.y, tn.z, 0.25, lowH(i) / texLen, c * 0.7, c * 0.55, c * 0.45, 0, 0, 0, 0);
    }
    for (let i = 0; i < lowRows - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 3, d = a + 2;
      G.bark.quad(a, d, c, b); G.bark.quad(a, b, c, d);
    }
  }
  // inner chimney closing above the opening: cone to a point
  {
    const hTop = hOpen + 3.5;
    const nR = 5, nC = 16;
    const P = new Float32Array(nR * nC * 3);
    for (let i = 0; i < nR; i++) {
      const q = i / (nR - 1);
      const hh = hOpen - 0.3 + q * (hTop - hOpen + 0.3);
      const r = inR(hOpen) * Math.cos(q * Math.PI * 0.5) + 0.02;
      for (let j = 0; j < nC; j++) {
        const a = (j / nC) * TAU;
        const k = (i * nC + j) * 3;
        P[k] = x + Math.cos(a) * r; P[k + 1] = y0 + hh; P[k + 2] = z + Math.sin(a) * r;
      }
    }
    emitGrid(G.bark, P, nR, nC, true, {
      uv: (i, jj) => [jj / nC, i * 0.3], col: () => [0.08, 0.065, 0.05], wind: () => [0, 0, 0, 0],
    }, false);
  }
  // upper trunk
  let i0 = 0;
  while (i0 < rows - 1 && hs[i0 + 1] < hOpen - 0.4) i0++;
  const upPath = path.slice(i0);
  const upHs = hs.slice(i0);
  upPath[0] = upPath[0].clone(); upPath[0].y = y0 + hOpen - 0.4; upHs[0] = hOpen - 0.4;
  tube(G.bark, upPath, (t, a, i) => radiusAt(upHs[i], a), {
    radial: 24, uRep, texLen, vOff: (hOpen - 0.4) / texLen,
    col: (t, a, p, i) => trunkCol(upHs[i], a, p), wind: windT,
  });
  // colliders: ring of circles along the wall, leaving the doorway open
  const rWall = rBase * 1.4;
  const n = Math.ceil((TAU * rWall) / 0.7);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    if (Math.abs(angDiff(a, hollowAz)) < wBase + 0.12) continue;
    const r = radiusAt(1.0, a) - 0.35;
    colliders.push([x + Math.cos(a) * r, z + Math.sin(a) * r, 0.5]);
  }
}
