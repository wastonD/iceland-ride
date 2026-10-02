// Icelandic turf-roof farm (torfbær), red barn, stone walls, timber fences and wrapped hay bales.
// Pure geometry + placement (node-testable). Materials/textures live in landmarks.js.
import * as THREE from 'three';
import { MeshBuilder, lin } from './builder.js';
import { mulberry32 } from '../../../core/noise.js';
import { beamBox } from './util.js';

const WHITE_T = lin('#ece8de'), BLACK_T = lin('#262220'), RED_D = lin('#a5281f'), GLASS = lin('#26333f'), STONE = lin('#8d877c'), STONE_D = lin('#77726a');

/** Gabled turf-roof house (n gables abreast, ridges run front->back). Origin = footprint centre at floor level. */
function turfHouse(m, spec) {
  const { n, gw = 4.2, d = 7.4, wallH = 1.75, rise = 1.9, colors, seed = 1, base = -0.5, roofCols } = spec;
  const rnd = mulberry32(seed);
  const Wt = n * gw, x0 = -Wt / 2, z0 = -d / 2, z1 = d / 2;
  const turfWall = lin('#5e6b3a');
  // stone plinth
  m.stone.box(x0 - 0.12, base, z0 - 0.12, x0 + Wt + 0.12, 0.45, z1 + 0.12, { color: STONE, top: false, su: 1 / 2.2, sv: 1 / 1.3 });
  // thick turf walls (side + back); the front is timber
  m.turf.box(x0, 0.4, z0, x0 + Wt, wallH, z1 - 0.02, { color: turfWall, top: false, su: 1 / 2, sv: 1 / 2 });
  for (let i = 0; i < n; i++) {
    const a = x0 + i * gw, b = a + gw, c = (a + b) / 2, roof = roofCols[i % roofCols.length];
    const ov = 0.22, yr = wallH + rise, ye = wallH - (ov * rise) / (gw / 2);
    // roof planes (sod)
    m.turf.quadU([a - ov, ye, z1 + 0.3], [a - ov, ye, z0 - 0.3], [c, yr, z0 - 0.3], [c, yr, z1 + 0.3], [-1, 1, 0], { color: roof, su: 1 / 2, sv: 1 / 2 });
    m.turf.quadU([b + ov, ye, z0 - 0.3], [b + ov, ye, z1 + 0.3], [c, yr, z1 + 0.3], [c, yr, z0 - 0.3], [1, 1, 0], { color: roof, su: 1 / 2, sv: 1 / 2, v0: 0.3 });
    // sod thickness edge at the eaves
    m.turf.quadU([a - ov, ye - 0.3, z0 - 0.3], [a - ov, ye - 0.3, z1 + 0.3], [a - ov, ye, z1 + 0.3], [a - ov, ye, z0 - 0.3], [-1, 0, 0], { color: lin('#4a4530'), su: 1 / 2, sv: 1 / 2 });
    m.turf.quadU([b + ov, ye - 0.3, z1 + 0.3], [b + ov, ye - 0.3, z0 - 0.3], [b + ov, ye, z0 - 0.3], [b + ov, ye, z1 + 0.3], [1, 0, 0], { color: lin('#4a4530'), su: 1 / 2, sv: 1 / 2 });
    // back gable
    m.turf.tri([b, wallH, z0], [a, wallH, z0], [c, yr, z0], [0, 0, -1], { color: turfWall, su: 1 / 2, sv: 1 / 2 });
    // timber front: wall + gable triangle
    const col = colors[i % colors.length];
    const zf = z1 + 0.03;
    m.wood.quadU([a + 0.05, 0.4, zf], [b - 0.05, 0.4, zf], [b - 0.05, wallH, zf], [a + 0.05, wallH, zf], [0, 0, 1], { color: col, su: 1 / 1.0, sv: 1 / 1.0 });
    m.wood.tri([a + 0.05, wallH, zf], [b - 0.05, wallH, zf], [c, yr - 0.05, zf], [0, 0, 1], { color: col, su: 1, sv: 1 });
    // barge boards
    beamBox(m.wood, [a - ov * 0.5, ye + 0.04, z1 + 0.32], [c, yr + 0.06, z1 + 0.32], 0.05, 0.22, lin('#eeeae0'));
    beamBox(m.wood, [c, yr + 0.06, z1 + 0.32], [b + ov * 0.5, ye + 0.04, z1 + 0.32], 0.05, 0.22, lin('#eeeae0'));
    // window in the gable, door / window on the wall
    const win = (cx, cy, w, h) => {
      m.wood.box(cx - w / 2 - 0.06, cy - h / 2 - 0.06, zf, cx + w / 2 + 0.06, cy + h / 2 + 0.06, zf + 0.07, { color: RED_D, top: true });
      m.wood.quadU([cx - w / 2, cy - h / 2, zf + 0.075], [cx + w / 2, cy - h / 2, zf + 0.075], [cx + w / 2, cy + h / 2, zf + 0.075], [cx - w / 2, cy + h / 2, zf + 0.075], [0, 0, 1], { color: GLASS, su: 0.1, sv: 0.1 });
      m.wood.box(cx - 0.025, cy - h / 2, zf + 0.075, cx + 0.025, cy + h / 2, zf + 0.09, { color: WHITE_T, top: true });
      m.wood.box(cx - w / 2, cy - 0.025, zf + 0.075, cx + w / 2, cy + 0.025, zf + 0.09, { color: WHITE_T, top: true });
    };
    if (i === Math.floor(n / 2) || n === 1) {
      m.wood.box(c - 0.55, 0.42, zf, c + 0.55, 1.75, zf + 0.09, { color: RED_D, top: true });
      m.wood.box(c - 0.45, 0.55, zf + 0.09, c + 0.45, 1.65, zf + 0.11, { color: lin('#8c1f17'), top: true });
    } else win(c, 1.15, 0.8, 0.85);
    win(c, wallH + rise * 0.32, 0.6, 0.6);
  }
  // chimney (black steel flue)
  const cc = x0 + Wt * (0.5 + 0.18);
  m.wood.box(cc - 0.18, wallH + rise * 0.6, -0.3, cc + 0.18, wallH + rise + 0.9, 0.06, { color: BLACK_T, top: true });
}

function barn(m, x0 = 0) {
  const W = 12.5, D = 8.2, H = 4.3, rise = 2.1, ov = 0.4;
  const red = lin('#a52a22'), roof = lin('#454a50'), white = lin('#ecebe4');
  m.stone.box(-W / 2 - 0.1, -0.6, -D / 2 - 0.1, W / 2 + 0.1, 0.35, D / 2 + 0.1, { color: lin('#7d7a72'), top: false, su: 1 / 2.2, sv: 1 / 1.3 });
  m.barn.box(-W / 2, 0.3, -D / 2, W / 2, H, D / 2, { color: red, top: false });
  const yr = H + rise, ye = H - (ov * rise) / (D / 2);
  m.barn.tri([W / 2, H, -D / 2], [W / 2, H, D / 2], [W / 2, yr, 0], [1, 0, 0], { color: red });
  m.barn.tri([-W / 2, H, D / 2], [-W / 2, H, -D / 2], [-W / 2, yr, 0], [-1, 0, 0], { color: red });
  const rq = (a, b, c, d, o) => { m.barn.quadU(a, b, c, d, o, { color: roof }); };
  rq([-W / 2 - ov, ye, D / 2 + ov], [W / 2 + ov, ye, D / 2 + ov], [W / 2 + ov, yr, 0], [-W / 2 - ov, yr, 0], [0, 1, 1]);
  rq([W / 2 + ov, ye, -D / 2 - ov], [-W / 2 - ov, ye, -D / 2 - ov], [-W / 2 - ov, yr, 0], [W / 2 + ov, yr, 0], [0, 1, -1]);
  // underside of the eaves
  const up = (a) => [a[0], a[1] - 0.06, a[2]];
  m.barn.quadU(up([W / 2 + ov, ye, D / 2 + ov]), up([-W / 2 - ov, ye, D / 2 + ov]), up([-W / 2 - ov, yr, 0]), up([W / 2 + ov, yr, 0]), [0, -1, -1], { color: white });
  m.barn.quadU(up([-W / 2 - ov, ye, -D / 2 - ov]), up([W / 2 + ov, ye, -D / 2 - ov]), up([W / 2 + ov, yr, 0]), up([-W / 2 - ov, yr, 0]), [0, -1, 1], { color: white });
  // white corner boards + big front doors with X braces (front = +z)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.barn.box(sx * W / 2 - 0.09 + sx * 0.02, 0.3, sz * D / 2 - 0.09 + sz * 0.02, sx * W / 2 + 0.09 + sx * 0.02, H, sz * D / 2 + 0.09 + sz * 0.02, { color: white, top: false });
  const zf = D / 2 + 0.03;
  m.barn.box(-2.3, 0.32, zf, 2.3, 3.5, zf + 0.06, { color: lin('#8c231c'), top: true });
  m.barn.box(-2.4, 0.32, zf + 0.02, -2.25, 3.62, zf + 0.09, { color: white, top: true });
  m.barn.box(2.25, 0.32, zf + 0.02, 2.4, 3.62, zf + 0.09, { color: white, top: true });
  m.barn.box(-2.4, 3.5, zf + 0.02, 2.4, 3.65, zf + 0.09, { color: white, top: true });
  beamBox(m.barn, [-2.3, 0.4, zf + 0.07], [2.3, 3.45, zf + 0.07], 0.12, 0.05, white, [0, 0, 1]);
  beamBox(m.barn, [2.3, 0.4, zf + 0.07], [-2.3, 3.45, zf + 0.07], 0.12, 0.05, white, [0, 0, 1]);
  // hay loft hatch in the gable
  m.barn.box(-0.45, H + 0.7, D / 2 - 0.02 + 0.0, 0.45, H + 1.7, D / 2 + 0.04, { color: white, top: true });
  // side windows
  for (const sx of [-1, 1]) for (const z of [-2.2, 2.2]) m.barn.box(sx * W / 2 - 0.03 + (sx > 0 ? 0.04 : -0.04), 2.0, z - 0.45, sx * W / 2 + 0.03 + (sx > 0 ? 0.04 : -0.04), 2.9, z + 0.45, { color: white, top: true });
}

/** Farm layout in world space. Returns building placements (with terrain-fitted floors). */
export function layoutFarm(world) {
  const Fm = world.features.farm;
  const at = (dx, dz) => ({ x: Fm.x + dx, z: Fm.z + dz });
  const items = [
    { kind: 'house', ...at(0, 0), yaw: 0.08, w: 13.4, d: 8.4 },
    { kind: 'shed', ...at(17, -6), yaw: -0.15, w: 5.4, d: 5.2 },
    { kind: 'shed2', ...at(-15, -9), yaw: 0.2, w: 5.4, d: 5.2 },
    { kind: 'barn', ...at(-26, 13), yaw: 0.12, w: 13.2, d: 9 },
  ];
  for (const it of items) {
    const c = Math.cos(it.yaw), s = Math.sin(it.yaw), hs = [];
    for (const [lx, lz] of [[-it.w / 2, -it.d / 2], [it.w / 2, -it.d / 2], [it.w / 2, it.d / 2], [-it.w / 2, it.d / 2], [0, 0]]) hs.push(world.heightAt(it.x + lx * c + lz * s, it.z - lx * s + lz * c));
    it.hmin = Math.min(...hs); it.hmax = Math.max(...hs);
    it.floorY = it.hmax + 0.15;
  }
  return items;
}

export function buildFarm(world) {
  const items = layoutFarm(world);
  const m = { turf: new MeshBuilder(), wood: new MeshBuilder(), stone: new MeshBuilder(), barn: new MeshBuilder() };
  const roofG = [lin('#5f8a34'), lin('#6a9438'), lin('#557d30')];
  for (const it of items) {
    for (const k of Object.keys(m)) m[k].setPlace(it.x, it.floorY, it.z, it.yaw);
    const base = it.hmin - 0.35 - it.floorY;
    if (it.kind === 'house') turfHouse(m, { n: 3, colors: [WHITE_T, BLACK_T, WHITE_T], roofCols: roofG, seed: 5, base });
    else if (it.kind === 'shed') turfHouse(m, { n: 1, gw: 5.2, d: 4.8, wallH: 1.9, rise: 2.0, colors: [BLACK_T], roofCols: [roofG[1]], seed: 6, base });
    else if (it.kind === 'shed2') turfHouse(m, { n: 1, gw: 5.2, d: 4.8, wallH: 1.8, rise: 1.9, colors: [WHITE_T], roofCols: [roofG[2]], seed: 7, base });
    else barn(m);
  }
  // stone walls
  const walls = new MeshBuilder();
  const pts = [];
  return { items, m, walls, pts };
}

/** Dry-stone wall along a polyline (array of [x,z]); skips ranges via keep(x,z). */
export function stoneWall(world, mb, poly, keep = () => true, height = 1.05) {
  const col = STONE, colD = STONE_D;
  let count = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    if (!keep(a[0], a[1]) || !keep(b[0], b[1])) continue;
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L;
    const ha = world.heightAt(a[0], a[1]), hb = world.heightAt(b[0], b[1]);
    if (ha < 0.3 || hb < 0.3) continue;
    const bw = 0.42, tw = 0.28;
    const P = (p, h, off, y) => [p[0] + nx * off, h + y, p[1] + nz * off];
    const seg = (side) => mb.quadU(P(a, ha, side * bw, -0.35), P(b, hb, side * bw, -0.35), P(b, hb, side * tw, height), P(a, ha, side * tw, height), [side * nx, 0.15, side * nz], { color: (i % 2 ? col : colD), su: 1 / 2.2, sv: 1 / 1.3, u0: i * 0.7 });
    seg(1); seg(-1);
    mb.quadU(P(a, ha, -tw, height), P(b, hb, -tw, height), P(b, hb, tw, height), P(a, ha, tw, height), [0, 1, 0], { color: colD, su: 1 / 2.2, sv: 1 / 2.2, u0: i * 0.7 });
    count++;
  }
  return count;
}

/** Fence posts & rails along a polyline: returns instance placements. */
export function fencePlan(world, poly, keep = () => true, gap = 3) {
  const posts = [], rails = [];
  // resample polyline every `gap` metres
  const pts = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 0; s < L; s += gap) pts.push([a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]);
  }
  pts.push(poly[poly.length - 1]);
  const ok = pts.map((p) => keep(p[0], p[1]) && world.heightAt(p[0], p[1]) > 0.4);
  const Y = pts.map((p) => world.heightAt(p[0], p[1]));
  for (let i = 0; i < pts.length; i++) if (ok[i]) posts.push({ x: pts[i][0], y: Y[i], z: pts[i][1], yaw: 0 });
  for (let i = 0; i < pts.length - 1; i++) if (ok[i] && ok[i + 1]) for (const h of [0.5, 0.95]) rails.push({ a: [pts[i][0], Y[i] + h, pts[i][1]], b: [pts[i + 1][0], Y[i + 1] + h, pts[i + 1][1]] });
  return { posts, rails };
}

/** Wrapped bales: mostly clustered near the farm, some dotted around the pasture. */
export function balePlan(world) {
  const rnd = mulberry32(777), Fm = world.features.farm, Pz = world.features.pasture, out = [];
  const add = (x, z, stackY = 0, yaw = rnd() * Math.PI, r = 0.62) => out.push({ x, z, y: world.heightAt(x, z) + r + stackY, yaw, r });
  // pyramid beside the barn
  const bx = Fm.x - 44, bz = Fm.z + 24;
  for (let i = 0; i < 3; i++) add(bx + i * 1.35, bz, 0, 0.1);
  add(bx + 0.68, bz, 1.05, 0.1); add(bx + 2.0, bz, 1.05, 0.1); add(bx + 1.35, bz, 2.0, 0.1);
  // a row by the farm gate and scattered ones in the field
  for (let i = 0; i < 4; i++) add(Fm.x + 26 + i * 1.5, Fm.z + 14, 0, 1.3);
  for (let i = 0; i < 12; i++) {
    const x = Pz.x0 + 25 + rnd() * (Pz.x1 - Pz.x0 - 60), z = Pz.z0 + 30 + rnd() * (Pz.z1 - Pz.z0 - 100);
    if (world.heightAt(x, z) < 2 || Math.hypot(x - Fm.x, z - Fm.z) < 22) continue;
    add(x, z);
  }
  return out;
}

export function baleGeometry() {
  const g = new THREE.CylinderGeometry(0.62, 0.62, 1.2, 20, 1, false);
  g.rotateZ(Math.PI / 2);
  return g;
}
