// Tunnel through the rock ridge: inner lining (kaleidoscope shader surface), buried outer
// shell, rough basalt arch rings at both mouths, dark mouth discs and a glowing road strip.
// Pure geometry (node-testable).
import * as THREE from 'three';
import { MeshBuilder, lin } from './builder.js';
import { computeFrames, StripAcc, camber } from './roadGeo.js';
import { localPoint, frameAtIndex } from './util.js';
import { mulberry32 } from '../../../core/noise.js';

export const TUN = { R: 4.75, spring: 1.25, crown: 6.0, ringT: 0.95 };

const terrAbove = (world, F, i, l) => world.heightAt(F[i].x + F[i].rx * l, F[i].z + F[i].rz * l) - F[i].y;

/** Mouth planes: first / last station where terrain fully closes over the bore (natural cliff face). */
export function planTunnel(world, F) {
  const T = world.path.tunnels[0];
  const maxBore = (i) => { let m = -1e9; for (let l = -TUN.R; l <= TUN.R; l += 0.5) m = Math.max(m, terrAbove(world, F, i, l)); return m; };
  let iE = T.s0; while (iE < T.s1 && maxBore(iE) < 0.3) iE++;
  let iX = T.s1; while (iX > T.s0 && maxBore(iX) < 0.3) iX--;
  return { sE: iE - 1, sX: iX + 1, T };
}

/** Half profile of the arch as [l, y] points: floor gutter, wall, springing, arch, wall, floor. */
export function archProfile(R, spring, seg = 16) {
  const pts = [[-4.3, -0.08], [-R, -0.08], [-R, 0.85], [-R, 1.15], [-R, spring]];
  for (let k = 1; k <= seg; k++) { const th = Math.PI - (k / seg) * Math.PI; pts.push([R * Math.cos(th), spring + R * Math.sin(th)]); }
  pts.push([R, 1.15], [R, 0.85], [R, -0.08], [4.3, -0.08]);
  return pts;
}
const CROWN_IDX = 5 + 8;

export function buildTunnel(world) {
  const F = computeFrames(world.path.points, 2);
  const plan = planTunnel(world, F);
  const { sE, sX } = plan;
  const inner = new MeshBuilder(), outer = new MeshBuilder();
  const R = TUN.R, prof = archProfile(R, TUN.spring), profOut = archProfile(R + 0.6, TUN.spring);
  const st = [];
  for (let s = sE; s < sX; s += 2) st.push(s);
  st.push(sX);
  const frames = st.map((s) => frameAtIndex(F, s));
  const wp = (f, l, y) => localPoint(f, l, y, 0);
  const per = [0]; for (let j = 1; j < prof.length; j++) per.push(per[j - 1] + Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]));
  const arcX = (j) => per[j] - per[CROWN_IDX];                 // arc length measured from the crown
  const rockDark = [0.055, 0.055, 0.06];
  for (let k = 0; k < st.length - 1; k++) {
    const fa = frames[k], fb = frames[k + 1];
    for (let j = 0; j < prof.length - 1; j++) {
      const p0 = prof[j], p1 = prof[j + 1], my = (p0[1] + p1[1]) / 2, ml = (p0[0] + p1[0]) / 2;
      const isFloor = p0[1] < 0 && p1[1] < 0;
      const hint = isFloor ? [0, 1, 0] : [fa.rx * -ml, my > TUN.spring ? TUN.spring - my : 0, fa.rz * -ml];
      const A = wp(fa, p0[0], p0[1]), B = wp(fa, p1[0], p1[1]), C = wp(fb, p1[0], p1[1]), D = wp(fb, p0[0], p0[1]);
      const v0 = st[k] - sE, v1 = st[k + 1] - sE;
      inner.quadU(A, B, C, D, hint, { color: [1, 1, 1], uvs: [[arcX(j), v0], [arcX(j + 1), v0], [arcX(j + 1), v1], [arcX(j), v1]] });
      if (!isFloor) {
        const q0 = profOut[j], q1 = profOut[j + 1];
        outer.quadU(wp(fa, q0[0], q0[1]), wp(fa, q1[0], q1[1]), wp(fb, q1[0], q1[1]), wp(fb, q0[0], q0[1]), [-hint[0], -hint[1], -hint[2]], { color: rockDark, su: 0.3, sv: 0.3, v0: st[k] * 0.3 });
      }
    }
  }

  // ------------------------------------------------ mouths: rock arch ring + dark disc
  const rocks = new MeshBuilder(), discs = new MeshBuilder();
  const portals = [];
  for (const end of ['entry', 'exit']) {
    const s = end === 'entry' ? sE : sX, f0 = frameAtIndex(F, s), dirIn = end === 'entry' ? 1 : -1;
    const g = { x: f0.x, y: f0.y, z: f0.z, tx: f0.tx * dirIn, tz: f0.tz * dirIn, rx: -f0.tz * dirIn, rz: f0.tx * dirIn };
    // how deep the shell stays exposed before the natural cliff covers it -> ring depth
    const cover = coverDepth(world, g);
    portals.push({ end, s, g, cover });
    buildMouth(rocks, discs, g, world, cover, end === 'entry' ? 11 : 23);
  }

  // ------------------------------------------------ glowing road strip inside the tunnel
  const glow = new StripAcc();
  const rows = [];
  for (let k = 0; k < st.length; k++) {
    const f = frames[k], row = [];
    for (const l of [-4.3, -3.2, -2.1, -1.0, 0, 1.0, 2.1, 3.2, 4.3]) row.push({ x: f.x + f.rx * l, y: f.y + camber(l, 7.5) + 0.03, z: f.z + f.rz * l, u: l, v: st[k] - sE });
    rows.push(row);
  }
  glow.add(rows);
  return { F, plan, length: sX - sE, inner: inner.toGeometry(), outer: outer.toGeometry(), rocks: rocks.toGeometry(), discs: discs.toGeometry(), glow: glow.toGeometry(), portals };
}

/** Depth (m, into the hill) at which natural terrain covers the whole outer shell. */
export function coverDepth(world, g) {
  const R = TUN.R + 0.6;
  for (let d = 0; d <= 12; d += 0.25) {
    let ok = true;
    for (let a = 0; a <= 1.0001 && ok; a += 0.125) {
      const l = -R + a * 2 * R, y = TUN.spring + Math.sqrt(Math.max(0, R * R - l * l)) * (Math.abs(l) > R - 0.05 ? 0.2 : 1);
      const [x, , z] = localPoint(g, l, 0, d);
      if (world.heightAt(x, z) - g.y < y + 0.15) ok = false;
    }
    if (ok) return d;
  }
  return 12;
}

/* ------------------------------------------------------------- rock helpers */
const BASALT = ['#2b2b2e', '#333336', '#3b3b3e', '#29292c', '#454548'], MOSS = ['#48562f', '#3d4b2a'];
function rock(mb, c, ax, ay, az, hx, hy, hz, rnd, color, jit = 0.34) {
  const corner = (sx, sy, sz) => {
    const j = () => 1 + (rnd() - 0.5) * 2 * jit;
    return [c[0] + ax[0] * hx * sx * j() + ay[0] * hy * sy * j() + az[0] * hz * sz * j(), c[1] + ax[1] * hx * sx * j() + ay[1] * hy * sy * j() + az[1] * hz * sz * j(), c[2] + ax[2] * hx * sx * j() + ay[2] * hy * sy * j() + az[2] * hz * sz * j()];
  };
  const V = {}; for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) V[`${sx}${sy}${sz}`] = corner(sx, sy, sz);
  const k = (sx, sy, sz) => V[`${sx}${sy}${sz}`];
  const faces = [
    [k(-1, -1, 1), k(1, -1, 1), k(1, 1, 1), k(-1, 1, 1), az], [k(1, -1, -1), k(-1, -1, -1), k(-1, 1, -1), k(1, 1, -1), [-az[0], -az[1], -az[2]]],
    [k(1, -1, 1), k(1, -1, -1), k(1, 1, -1), k(1, 1, 1), ax], [k(-1, -1, -1), k(-1, -1, 1), k(-1, 1, 1), k(-1, 1, -1), [-ax[0], -ax[1], -ax[2]]],
    [k(-1, 1, 1), k(1, 1, 1), k(1, 1, -1), k(-1, 1, -1), ay], [k(-1, -1, -1), k(1, -1, -1), k(1, -1, 1), k(-1, -1, 1), [-ay[0], -ay[1], -ay[2]]],
  ];
  for (const [a, b, c2, d, out] of faces) {
    const shade = 0.85 + rnd() * 0.3;
    mb.quadU(a, b, c2, d, out, { color: color.map((v) => v * shade), su: 1 / 2.2, sv: 1 / 2.2, u0: rnd() * 3, v0: rnd() * 3 });
  }
}

/** Rough basalt arch ring, jambs, boulders and scree + a dark disc filling the opening. */
function buildMouth(rocks, discs, g, world, cover, seed) {
  const rnd = mulberry32(seed * 977 + 13), R = TUN.R, sp = TUN.spring, th0 = TUN.ringT;
  const W = (l, y, d) => localPoint(g, l, y, d);
  const right = [g.rx, 0, g.rz], up = [0, 1, 0], into = [g.tx, 0, g.tz];
  const col = () => { const m = rnd() < 0.12 ? MOSS : BASALT; return lin(m[Math.floor(rnd() * m.length)]); };
  const depth = Math.max(3, cover + 1.4);
  // lintel + arch blocks, stacked in depth layers so the throat reads as rough rock, not one long log
  const n = 22, LAY = 1.5, layers = Math.ceil(depth / LAY);
  for (let k = 0; k < layers; k++) {
    const dc = -0.85 + (k + 0.5) * LAY, dh = LAY * 0.55;
    for (let i = 0; i < n; i++) {
      const phi = ((i + 0.5 + (rnd() - 0.5) * 0.5) / n) * Math.PI + (k % 2 ? 0.5 / n * Math.PI : 0), th = th0 * (0.55 + rnd() * 0.9) * (k ? 1.1 : 1);
      const rc = R + 0.04 + th / 2, w = ((Math.PI * (R + th)) / n) * (0.9 + rnd() * 0.6);
      const cl = rc * Math.cos(phi), cy = sp + rc * Math.sin(phi);
      const rad = [right[0] * Math.cos(phi), Math.sin(phi), right[2] * Math.cos(phi)];
      const tan = [-right[0] * Math.sin(phi), Math.cos(phi), -right[2] * Math.sin(phi)];
      rock(rocks, W(cl, cy, dc + (rnd() - 0.5) * 0.3), rad, tan, into, th / 2, w / 2, dh, rnd, col());
    }
    // jambs (both sides), sunk below road level
    for (const sg of [-1, 1]) for (let y = -0.4; y < sp + 0.2; y += 0.85 + rnd() * 0.2) {
      const th = th0 * (0.55 + rnd() * 0.9), h = 0.9 + rnd() * 0.6;
      rock(rocks, W(sg * (R + 0.04 + th / 2), y + h / 2 - 0.1, dc + (rnd() - 0.5) * 0.3), [sg * right[0], 0, sg * right[2]], up, into, th / 2, h / 2, dh, rnd, col());
    }
  }
  // ragged outer boulders around the arch (mostly sunk into the cliff face)
  for (let i = 0; i < 30; i++) {
    const phi = -0.25 + rnd() * (Math.PI + 0.5), rr = R + th0 + 0.2 + rnd() * 1.7, s = 0.3 + rnd() * 0.65;
    const cl = rr * Math.cos(phi), cy = Math.max(-0.2, sp + rr * Math.sin(phi));
    const dc = 0.4 + rnd() * 1.2, ang = rnd() * Math.PI;
    const ex = [Math.cos(ang) * right[0], Math.sin(ang), Math.cos(ang) * right[2]], ey = [-Math.sin(ang) * right[0], Math.cos(ang), -Math.sin(ang) * right[2]];
    rock(rocks, W(cl, cy, dc), ex, ey, into, s * (0.8 + rnd() * 0.5), s * (0.7 + rnd() * 0.5), s * (0.9 + rnd()), rnd, col(), 0.3);
  }
  // scree and stones beside the road in front of the mouth
  for (let i = 0; i < 26; i++) {
    const l = (rnd() < 0.5 ? -1 : 1) * (4.9 + rnd() * 4.5), d = -0.8 - rnd() * 6.5, s = 0.12 + rnd() * 0.34;
    const [x, , z] = W(l, 0, d), y = world.heightAt(x, z) + s * 0.3 - g.y;
    const ang = rnd() * 6.28, ex = [Math.cos(ang), 0, Math.sin(ang)], ez = [-Math.sin(ang), 0, Math.cos(ang)];
    rock(rocks, [x, g.y + y, z], ex, up, ez, s * 1.2, s * 0.7, s * 0.9, rnd, col(), 0.3);
  }
  // dark disc closing the natural cliff behind the opening (front-face only)
  const pts = [[-R, -0.3]]; for (let k = 0; k <= 16; k++) { const th = Math.PI - (k / 16) * Math.PI; pts.push([R * Math.cos(th), sp + R * Math.sin(th)]); } pts.push([R, -0.3]);
  const out = [-into[0], 0, -into[2]], dark = [0.004, 0.004, 0.006];
  for (let k = 0; k < pts.length - 1; k++) discs.tri(W(0, sp, 0.03), W(pts[k][0], pts[k][1], 0.03), W(pts[k + 1][0], pts[k + 1][1], 0.03), out, { color: dark });
  discs.tri(W(0, sp, 0.03), W(R, -0.3, 0.03), W(-R, -0.3, 0.03), out, { color: dark });
}
