// Pure geometry for the village: corrugated-iron houses, the blue church, the rainbow path,
// the wooden pier and a small fishing boat. No DOM — importable from node for verification.
import * as THREE from 'three';
import { MeshBuilder, lin } from './builder.js';
import { mulberry32, clamp } from '../../../core/noise.js';
import { WIN_CELLS } from './cellIds.js';

const UP = [0, 1, 0];
const WHITE = lin('#ecebe4'), CONCRETE = lin('#8d8c86'), BRICK = lin('#84463b'), DARKMETAL = lin('#2b2d31');

/* ------------------------------------------------------------ decal helper */
export class Decals {
  constructor() { this.mb = new MeshBuilder(); }
  place(x, y, z, yaw) { this.mb.setPlace(x, y, z, yaw); }
  /** centre c=[x,y,z] on a wall, `right` unit horizontal vector (u dir), w x h metres. */
  add(c, right, w, h, cell, lit, lift = 0.028) {
    // outward normal = right × up = (-rz, 0, rx)
    const on = [-right[2], 0, right[0]];
    const cx = c[0] + on[0] * lift, cy = c[1], cz = c[2] + on[2] * lift;
    const P = (dx, dy) => [cx + right[0] * dx, cy + dy, cz + right[2] * dx];
    const col = WIN_CELLS[cell];
    const eps = 0.0025;
    const u0 = col / 8 + eps, u1 = (col + 1) / 8 - eps;
    const v0 = (lit ? 0 : 0.5) + eps, v1 = (lit ? 0.5 : 1) - eps;
    this.mb.quadU(P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2), on, { uvs: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] });
  }
}

/* ------------------------------------------------------------ gable block */
/**
 * Box with a gable roof. Local frame: floor at y0, walls to y0+h, ridge along `ridge` ('x'|'z').
 * Returns roof geometry info (ridgeY, eaveY).
 */
export function gableBlock(mb, o) {
  const { w, d, h, rise, ridge, wall, roof } = o;
  const cx = o.cx ?? 0, cz = o.cz ?? 0, y0 = o.y0 ?? 0, ov = o.over ?? 0.3, under = o.under ?? WHITE;
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, yt = y0 + h, yr = yt + rise;
  mb.box(x0, y0, z0, x1, yt, z1, { color: wall, top: false });
  const roofQ = (a, b, c, d2, out) => {
    mb.quadU(a, b, c, d2, out, { color: roof, su: 1, sv: 1 });
    // underside (flat trim colour), slightly lower
    const dn = (p) => [p[0], p[1] - 0.05, p[2]];
    mb.quadU(dn(a), dn(b), dn(c), dn(d2), [-out[0], -out[1], -out[2]], { color: under, su: 1, sv: 1 });
  };
  if (ridge === 'x') {
    const ye = yt - (ov * rise) / (d / 2);
    mb.tri([x1, yt, z0], [x1, yt, z1], [x1, yr, cz], [1, 0, 0], { color: wall });
    mb.tri([x0, yt, z1], [x0, yt, z0], [x0, yr, cz], [-1, 0, 0], { color: wall });
    roofQ([x0 - ov, ye, z1 + ov], [x1 + ov, ye, z1 + ov], [x1 + ov, yr, cz], [x0 - ov, yr, cz], [0, 1, 1]);
    roofQ([x1 + ov, ye, z0 - ov], [x0 - ov, ye, z0 - ov], [x0 - ov, yr, cz], [x1 + ov, yr, cz], [0, 1, -1]);
  } else {
    const ye = yt - (ov * rise) / (w / 2);
    mb.tri([x0, yt, z1], [x1, yt, z1], [cx, yr, z1], [0, 0, 1], { color: wall });
    mb.tri([x1, yt, z0], [x0, yt, z0], [cx, yr, z0], [0, 0, -1], { color: wall });
    roofQ([x1 + ov, ye, z1 + ov], [x1 + ov, ye, z0 - ov], [cx, yr, z0 - ov], [cx, yr, z1 + ov], [1, 1, 0]);
    roofQ([x0 - ov, ye, z0 - ov], [x0 - ov, ye, z1 + ov], [cx, yr, z1 + ov], [cx, yr, z0 - ov], [-1, 1, 0]);
  }
  return { yt, yr };
}

function pyramid(mb, cx, cz, y0, half, apexY, color) {
  const a = [cx - half, y0, cz + half], b = [cx + half, y0, cz + half], c = [cx + half, y0, cz - half], d = [cx - half, y0, cz - half], t = [cx, apexY, cz];
  mb.tri(a, b, t, [0, 0.5, 1], { color });
  mb.tri(b, c, t, [1, 0.5, 0], { color });
  mb.tri(c, d, t, [0, 0.5, -1], { color });
  mb.tri(d, a, t, [-1, 0.5, 0], { color });
}

const WALL_INFO = {
  front: (W, D) => ({ len: W, c: (t) => [t, 0, D / 2], right: [1, 0, 0] }),
  back: (W, D) => ({ len: W, c: (t) => [-t, 0, -D / 2], right: [-1, 0, 0] }),
  right: (W, D) => ({ len: D, c: (t) => [W / 2, 0, -t], right: [0, 0, -1] }),
  left: (W, D) => ({ len: D, c: (t) => [-W / 2, 0, t], right: [0, 0, 1] }),
};

/* ------------------------------------------------------------------ house */
export function buildHouse(walls, decals, H) {
  const rnd = mulberry32(H.seed);
  const { W, D, floors, kind } = H;
  const wall = lin(H.wall), roof = lin(H.roof);
  const wallH = kind === 'shed' ? 3.3 : floors === 2 ? 5.35 : 3.05;
  const pitch = kind === 'shed' ? 0.42 : 0.72 + rnd() * 0.08;
  const rise = ((H.ridge === 'x' ? D : W) / 2) * pitch;
  walls.setPlace(H.x, H.floorY, H.z, H.yaw);
  decals.place(H.x, H.floorY, H.z, H.yaw);
  // plinth to the lowest terrain corner
  const pb = H.baseY - H.floorY;
  walls.box(-W / 2 - 0.06, pb, -D / 2 - 0.06, W / 2 + 0.06, 0.0, D / 2 + 0.06, { color: CONCRETE, top: false, sv: 1 });
  gableBlock(walls, { w: W, d: D, h: wallH, rise, ridge: H.ridge, wall, roof, over: kind === 'shed' ? 0.4 : 0.32 });
  const yr = wallH + rise;

  // white corner boards
  if (H.wall !== '#e9e8e1') for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    walls.box(sx * W / 2 - 0.07 + sx * 0.03, 0, sz * D / 2 - 0.07 + sz * 0.03, sx * W / 2 + 0.07 + sx * 0.03, wallH, sz * D / 2 + 0.07 + sz * 0.03, { color: WHITE, top: false });
  }
  // porch on the front (houses only)
  let porchX = null;
  const PW = 2.3, PD = 1.55, PH = 2.55;
  if (H.porch) {
    porchX = (rnd() - 0.5) * (W - PW - 2.4);
    gableBlock(walls, { cx: porchX, cz: D / 2 + PD / 2 - 0.02, w: PW, d: PD, h: PH, rise: PW * 0.3, ridge: 'z', wall, roof, over: 0.22 });
    walls.box(porchX - 0.9, -0.02, D / 2 + PD - 0.02, porchX + 0.9, 0.12, D / 2 + PD + 0.6, { color: CONCRETE, top: true }); // step
  }
  // chimney
  if (H.chimney) {
    const cxp = H.ridge === 'x' ? (rnd() < 0.5 ? -1 : 1) * W * 0.22 : 0;
    const czp = H.ridge === 'z' ? (rnd() < 0.5 ? -1 : 1) * D * 0.22 : 0;
    walls.box(cxp - 0.26, yr - 0.9, czp - 0.26, cxp + 0.26, yr + 0.85, czp + 0.26, { color: rnd() < 0.5 ? BRICK : DARKMETAL, top: false });
    walls.box(cxp - 0.34, yr + 0.85, czp - 0.34, cxp + 0.34, yr + 1.0, czp + 0.34, { color: DARKMETAL, top: true });
  }

  // openings
  const lit = () => rnd() < 0.38;
  const doorWall = 'front';
  const doorX = porchX !== null ? porchX : (rnd() < 0.5 ? -1 : 1) * W * 0.22;
  const winCell = () => (rnd() < 0.35 ? 'win6' : 'win2');
  for (const name of ['front', 'back', 'right', 'left']) {
    const info = WALL_INFO[name](W, D);
    const nCol = Math.max(1, Math.floor((info.len - 1.1) / 2.5));
    for (let k = 0; k < nCol; k++) {
      const t = -info.len / 2 + (info.len * (k + 0.5)) / nCol;
      for (let f = 0; f < floors; f++) {
        if (name === 'front' && f === 0) {
          if (Math.abs(t - doorX) < 1.25) continue;               // door slot
          if (porchX !== null && Math.abs(t - porchX) < PW / 2 + 0.7) continue;
        }
        if (name === 'back' && f === 0 && k === 0 && rnd() < 0.5) continue;
        const cy = 1.68 + f * 2.7;
        const isShop = kind === 'shed';
        const cell = isShop ? 'shop' : winCell();
        const ww = isShop ? 2.1 : cell === 'win6' ? 1.1 : 0.95, wh = isShop ? 1.25 : cell === 'win6' ? 1.55 : 1.3;
        const c = info.c(t); c[1] = isShop ? 1.9 : cy;
        decals.add(c, info.right, ww, wh, cell, lit());
      }
    }
  }
  // door
  {
    const dw = kind === 'shed' ? 1.5 : 1.0, dh = 2.1;
    if (porchX !== null) decals.add([porchX, dh / 2 + 0.04, D / 2 + PD - 0.02], [1, 0, 0], dw, dh, 'door', false);
    else decals.add([doorX, dh / 2 + 0.04, D / 2], [1, 0, 0], dw, dh, 'door', false);
    if (kind === 'shed') decals.add([-doorX, 1.2, D / 2], [1, 0, 0], 2.4, 2.4, 'door', false);
  }
  // attic windows in the gable triangles
  if (kind !== 'shed') {
    if (H.ridge === 'z') {
      decals.add([0, wallH + rise * 0.34, D / 2], [1, 0, 0], 0.8, 0.8, 'attic', lit());
      decals.add([0, wallH + rise * 0.34, -D / 2], [-1, 0, 0], 0.8, 0.8, 'attic', lit());
    } else {
      decals.add([W / 2, wallH + rise * 0.34, 0], [0, 0, -1], 0.8, 0.8, 'attic', lit());
      decals.add([-W / 2, wallH + rise * 0.34, 0], [0, 0, 1], 0.8, 0.8, 'attic', lit());
    }
  }
}

/* ----------------------------------------------------------------- church */
export function buildChurch(walls, decals, C) {
  const wall = lin('#93c5ea'), roof = lin('#5b3a3b'), trim = WHITE;
  walls.setPlace(C.x, C.floorY, C.z, C.yaw);
  decals.place(C.x, C.floorY, C.z, C.yaw);
  const W = 7, D = 11, H = 5.3, rise = 3.3;
  walls.box(-W / 2 - 0.08, C.baseY - C.floorY, -D / 2 - 0.08, W / 2 + 0.08, 0, D / 2 + 3.7, { color: CONCRETE, top: false });
  gableBlock(walls, { w: W, d: D, h: H, rise, ridge: 'z', wall, roof, over: 0.4 });
  // apse at the back
  gableBlock(walls, { cz: -D / 2 - 1.5, w: 3.8, d: 3.2, h: 3.9, rise: 1.9, ridge: 'z', wall, roof, over: 0.25 });
  // tower in front
  const tz0 = D / 2 - 0.2, tz1 = tz0 + 3.6, tw = 3.6, tH = 10.2;
  walls.box(-tw / 2, 0, tz0, tw / 2, tH, tz1, { color: wall, top: false });
  walls.box(-tw / 2 - 0.16, tH - 0.55, tz0 - 0.16, tw / 2 + 0.16, tH + 0.05, tz1 + 0.16, { color: trim, top: true });   // cornice
  walls.box(-tw / 2 - 0.1, 0, tz0 - 0.1, -tw / 2 + 0.0, tH - 0.55, tz0 + 0.2, { color: trim, top: false });              // corner boards (left/back)
  pyramid(walls, 0, (tz0 + tz1) / 2, tH + 0.05, tw / 2 + 0.18, tH + 7.4, roof);
  // cross
  const ay = tH + 7.4;
  walls.box(-0.06, ay - 0.1, (tz0 + tz1) / 2 - 0.06, 0.06, ay + 1.2, (tz0 + tz1) / 2 + 0.06, { color: trim, top: true });
  walls.box(-0.36, ay + 0.75, (tz0 + tz1) / 2 - 0.05, 0.36, ay + 0.87, (tz0 + tz1) / 2 + 0.05, { color: trim, top: true });
  // door
  decals.add([0, 1.35, tz1], [1, 0, 0], 1.85, 2.7, 'churchDoor', false, 0.03);
  // belfry openings (four faces)
  const mz = (tz0 + tz1) / 2;
  decals.add([0, 8.0, tz1], [1, 0, 0], 1.3, 2.1, 'louvre', false, 0.03);
  decals.add([tw / 2, 8.0, mz], [0, 0, -1], 1.3, 2.1, 'louvre', false, 0.03);
  decals.add([-tw / 2, 8.0, mz], [0, 0, 1], 1.3, 2.1, 'louvre', false, 0.03);
  // nave windows
  for (const zc of [-3.9, -1.55, 0.8, 3.15]) {
    decals.add([W / 2, 2.85, -zc], [0, 0, -1], 1.15, 2.8, 'churchWin', zc < 1 && Math.abs(zc) > 1.5);
    decals.add([-W / 2, 2.85, zc], [0, 0, 1], 1.15, 2.8, 'churchWin', zc < 1 && Math.abs(zc) > 1.5);
  }
  // little round-topped window above the tower door
  decals.add([0, 5.6, tz1], [1, 0, 0], 0.95, 1.9, 'churchWin', false, 0.03);
}

/* --------------------------------------------------------------- rainbow */
export const RAINBOW = ['#e2352f', '#f28a2b', '#f5d13c', '#43a955', '#2f8fd8', '#4a4fb9', '#9a48b5'];
export function buildRainbow(world, pts, width = 3.2) {
  const mb = new MeshBuilder();
  const n = pts.length, bw = width / RAINBOW.length;
  const F = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    return { x: p[0], z: p[1], rx: -tz, rz: tx };
  });
  const cols = RAINBOW.map(lin);
  const Y = (x, z) => world.heightAt(x, z) + 0.05;
  for (let i = 0; i < n - 1; i++) for (let b = 0; b < RAINBOW.length; b++) {
    const l0 = -width / 2 + b * bw, l1 = l0 + bw;
    const A = (f, l) => [f.x + f.rx * l, Y(f.x + f.rx * l, f.z + f.rz * l), f.z + f.rz * l];
    mb.quadU(A(F[i], l0), A(F[i], l1), A(F[i + 1], l1), A(F[i + 1], l0), UP, { color: cols[b], su: 0.5, sv: 0.5, u0: b * 0.31, v0: i * 0.6 });
  }
  return mb.toGeometry();
}

/* ------------------------------------------------------------------- pier */
export const deckY = (z) => {
  const k = clamp((z - 984) / 16, 0, 1), ss = k * k * (3 - 2 * k);
  return 3.34 + (2.55 - 3.34) * ss;
};

/** Oriented thin beam between two points (used for rails). */
function beam(mb, p0, p1, w, h, color) {
  const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(w / 2);
  const up = new THREE.Vector3(0, h / 2, 0);
  const P = (base, sx, sy) => [base[0] + side.x * sx, base[1] + up.y * sy, base[2] + side.z * sx];
  const c = (base) => [P(base, -1, -1), P(base, 1, -1), P(base, 1, 1), P(base, -1, 1)];
  const A = c(p0), B = c(p1);
  const o = { color };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mid = [(A[i][0] + A[j][0]) / 2 - p0[0], (A[i][1] + A[j][1]) / 2 - p0[1], (A[i][2] + A[j][2]) / 2 - p0[2]];
    mb.quadU(A[i], A[j], B[j], B[i], mid, { ...o, su: 1, sv: 1 });
  }
  mb.quadU(A[0], A[1], A[2], A[3], [-d.x, -d.y, -d.z], o);
  mb.quadU(B[0], B[1], B[2], B[3], [d.x, d.y, d.z], o);
}

export function buildPier(world, P) {
  const mb = new MeshBuilder();
  const x0 = P.x - P.width / 2, x1 = P.x + P.width / 2;
  const wood = lin('#b9a58a'), dark = lin('#4a3d31'), rail = lin('#a8927a');
  const dz = 2;
  const zEnd = P.z1;
  // deck top + fascia
  for (let z = P.z0; z < zEnd; z += dz) {
    const za = z, zb = Math.min(zEnd, z + dz), ya = deckY(za), yb = deckY(zb);
    mb.quadU([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], UP, { color: wood, su: 1, sv: 1 / 3, u0: 0, v0: (za - P.z0) / 3 });
    mb.quadU([x0, ya - 0.3, za], [x0, ya - 0.3, zb], [x0, yb, zb], [x0, ya, za], [-1, 0, 0], { color: dark, su: 1, sv: 1 });
    mb.quadU([x1, ya - 0.3, zb], [x1, ya - 0.3, za], [x1, ya, za], [x1, yb, zb], [1, 0, 0], { color: dark, su: 1, sv: 1 });
  }
  // end platform
  const pw = 3, y = deckY(zEnd);
  mb.quadU([x0 - pw, y, zEnd], [x1 + pw, y, zEnd], [x1 + pw, y, zEnd + 5], [x0 - pw, y, zEnd + 5], UP, { color: wood, su: 1, sv: 1 / 3, v0: 30 });
  for (const [a, b, out] of [[[x0 - pw, zEnd], [x1 + pw, zEnd], [0, 0, -1]], [[x1 + pw, zEnd + 5], [x0 - pw, zEnd + 5], [0, 0, 1]]]) {
    mb.quadU([a[0], y - 0.3, a[1]], [b[0], y - 0.3, b[1]], [b[0], y, b[1]], [a[0], y, a[1]], out, { color: dark });
  }
  mb.quadU([x0 - pw, y - 0.3, zEnd + 5], [x0 - pw, y - 0.3, zEnd], [x0 - pw, y, zEnd], [x0 - pw, y, zEnd + 5], [-1, 0, 0], { color: dark });
  mb.quadU([x1 + pw, y - 0.3, zEnd], [x1 + pw, y - 0.3, zEnd + 5], [x1 + pw, y, zEnd + 5], [x1 + pw, y, zEnd], [1, 0, 0], { color: dark });
  // railings along both sides (over the water only)
  for (const sx of [x0 + 0.06, x1 - 0.06]) {
    for (let z = 990; z < zEnd; z += 3) {
      const zb = Math.min(zEnd, z + 3);
      const ya = deckY(z), yb = deckY(zb);
      mb.box(sx - 0.05, ya, z - 0.05, sx + 0.05, ya + 1.05, z + 0.05, { color: rail });
      beam(mb, [sx, ya + 1.0, z], [sx, yb + 1.0, zb], 0.09, 0.07, rail);
      beam(mb, [sx, ya + 0.55, z], [sx, yb + 0.55, zb], 0.06, 0.05, rail);
    }
    const yq = deckY(zEnd);
    mb.box(sx - 0.05, yq, zEnd - 0.05, sx + 0.05, yq + 1.05, zEnd + 0.05, { color: rail });
  }
  // bollards + crates + barrels on the platform
  const yq = deckY(zEnd);
  for (const [bx, bz] of [[x0 - 2.2, zEnd + 1.2], [x1 + 2.2, zEnd + 1.2], [x0 - 2.2, zEnd + 4.2], [x1 + 2.2, zEnd + 4.2]]) mb.cylinder(bx, bz, yq, yq + 0.45, 0.13, 7, { color: DARKMETAL });
  const crate = lin('#8a6a45');
  mb.box(x0 - 2.6, yq, zEnd + 2.0, x0 - 1.6, yq + 0.8, zEnd + 3.0, { color: crate });
  mb.box(x0 - 2.5, yq + 0.8, zEnd + 2.1, x0 - 1.7, yq + 1.5, zEnd + 2.9, { color: crate });
  mb.cylinder(x1 + 2.0, zEnd + 2.6, yq, yq + 0.95, 0.32, 8, { color: lin('#b0342b') });
  mb.cylinder(x1 + 1.3, zEnd + 3.2, yq, yq + 0.95, 0.32, 8, { color: lin('#2f6b9a') });
  // fuel-store shed at the pier root (small), skipped — houses provide the fish-house
  // piles: instanced separately; return their positions
  const piles = [];
  for (let z = 966; z <= zEnd + 4.5; z += 4) for (const sx of [x0 + 0.3, x1 - 0.3]) {
    const seabed = world.heightAt(sx, z);
    const top = deckY(Math.min(z, zEnd)) - 0.05, bot = Math.max(seabed - 0.4, -30);
    if (top - seabed < 0.55) continue;            // deck sits on the ground here
    piles.push({ x: sx, z, y: bot, h: top - bot });
  }
  for (const sx of [x0 - pw + 0.3, x1 + pw - 0.3]) for (const z of [zEnd + 0.4, zEnd + 4.6]) {
    const seabed = world.heightAt(sx, z);
    piles.push({ x: sx, z, y: seabed - 0.4, h: yq - 0.05 - (seabed - 0.4) });
  }
  return { geometry: mb.toGeometry(), piles };
}

/* ------------------------------------------------------------------- boat */
export function buildBoat() {
  const mb = new MeshBuilder();
  const L = 7.6, N = 12;
  const hullDark = lin('#23557f'), hullUp = lin('#f0efe8'), deck = lin('#a98f6a'), stripe = lin('#c23a2f');
  const halfBeam = (t) => 1.3 * (t < 0.15 ? 0.86 + (t / 0.15) * 0.14 : Math.pow(1 - Math.pow((t - 0.15) / 0.85, 2.2), 0.55));
  const deckH = (t) => 0.62 + 0.42 * t * t;
  const keel = (t) => -0.72 + 0.5 * t * t;
  const sec = (t) => {
    const z = -L / 2 + t * L, w = halfBeam(t), yd = deckH(t), yk = keel(t), ym = (yd + yk) * 0.4;
    return [[-w, yd, z], [-w * 0.9, ym, z], [-w * 0.4, yk, z], [w * 0.4, yk, z], [w * 0.9, ym, z], [w, yd, z]];
  };
  const S = []; for (let i = 0; i <= N; i++) S.push(sec(i / N));
  for (let i = 0; i < N; i++) for (let j = 0; j < 5; j++) {
    const a = S[i][j], b = S[i][j + 1], c = S[i + 1][j + 1], d = S[i + 1][j];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.2, 0];
    const col = j === 0 || j === 4 ? (i % 2 || true ? hullUp : hullUp) : hullDark;
    mb.quadU(a, b, c, d, mid, { color: col });
  }
  // sheer stripe: a thin red band along the top of the hull
  // deck
  for (let i = 0; i < N; i++) {
    const a = S[i][0], b = S[i][5], c = S[i + 1][5], d = S[i + 1][0];
    mb.quadU([a[0] + 0.02, a[1] + 0.01, a[2]], [b[0] - 0.02, b[1] + 0.01, b[2]], [c[0] - 0.02, c[1] + 0.01, c[2]], [d[0] + 0.02, d[1] + 0.01, d[2]], UP, { color: deck });
  }
  // wheelhouse
  const y0 = deckH(0.32) + 0.02;
  mb.box(-0.9, y0, -1.9, 0.9, y0 + 1.45, -0.2, { color: hullUp, top: true });
  mb.box(-1.0, y0 + 1.45, -2.0, 1.0, y0 + 1.6, -0.1, { color: stripe, top: true });
  mb.box(-0.93, y0 + 0.75, -0.6, 0.93, y0 + 1.25, -0.19, { color: lin('#1a2733'), top: false }); // dark windows band (front)
  mb.box(-0.93, y0 + 0.75, -1.85, 0.93, y0 + 1.25, -0.6, { color: lin('#1a2733'), top: false });
  // mast
  mb.cylinder(0, -1.0, y0 + 1.6, y0 + 3.9, 0.05, 6, { color: lin('#d9d7cf') });
  mb.box(-0.6, y0 + 3.0, -1.02, 0.6, y0 + 3.06, -0.98, { color: lin('#d9d7cf') });
  // gunwale rail (red)
  for (let i = 0; i < N; i++) for (const s of [0, 5]) {
    const a = S[i][s], b = S[i + 1][s];
    beam(mb, [a[0], a[1] + 0.02, a[2]], [b[0], b[1] + 0.02, b[2]], 0.09, 0.07, stripe);
  }
  return mb.toGeometry();
}

/* ------------------------------------------------------------------ lamps */
export function lampPoleGeometry() {
  const mb = new MeshBuilder();
  mb.cylinder(0, 0, 0, 1, 0.055, 6, { color: lin('#3a3d42'), cap: false });
  return mb.toGeometry();
}
export function lampHeadGeometry() {
  const g = new THREE.IcosahedronGeometry(0.26, 1);
  return g;
}
