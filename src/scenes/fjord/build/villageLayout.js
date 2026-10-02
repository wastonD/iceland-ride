// Pure village layout: street polylines, deterministic house placement, rainbow path, pier, lamps.
import * as THREE from 'three';
import { mulberry32, clamp } from '../../../core/noise.js';

export const PIER = { x: 6, z0: 962, z1: 1052, width: 3.6 };

/** Street centre lines (xz). The main street continues the road end (-80, 850). */
export function streetLines(world) {
  const E = world.path.points[world.path.points.length - 1];
  const t = world.path.tangentAt(world.path.length - 1);
  return {
    main: [[E.x, E.z], [E.x + t.x * 14, E.z + t.z * 14], [-52, 876], [-40, 899], [-31, 922], [-22, 946], [-4, 958], [26, 960], [46, 955]],
    west: [[-31, 922], [-58, 923], [-88, 924], [-118, 928]],
    // waterfront street: inland side houses face the fjord
    shore: [[-118, 928], [-110, 950], [-92, 966], [-64, 976], [-36, 978], [-14, 971], [-4, 958]],
    // short spur from the shore street to the pier root
    spur: [[PIER.x, 959], [PIER.x, 975]],
  };
}

/** Church: light-blue chapel; front faces the rainbow path / road end. */
export function churchPlacement(world) {
  const c = world.landmarks.church, E = world.landmarks.roadEnd;
  let fx = E.x + 3 - c.x, fz = E.z + 8 - c.z; const l = Math.hypot(fx, fz); fx /= l; fz /= l;
  return { x: c.x, z: c.z, yaw: Math.atan2(fx, fz), fx, fz };
}

export function rainbowPath(world) {
  const ch = churchPlacement(world), E = world.landmarks.roadEnd;
  const door = [ch.x + ch.fx * 8.9, ch.z + ch.fz * 8.9];
  const end = [door[0] + ch.fx * 1.3, door[1] + ch.fz * 1.3];
  return [[E.x + 1.5, E.z + 3.5], [E.x - 2.2, E.z + 11], [(E.x + end[0]) / 2 - 1.2, (E.z + end[1]) / 2 + 1.5], [end[0] + 1.6, end[1] - 6], end];
}

export function samplePolyline(xz, step) {
  const curve = new THREE.CatmullRomCurve3(xz.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const n = Math.max(2, Math.round(curve.getLength() / step));
  return curve.getSpacedPoints(n).map((p) => [p.x, p.z]);
}

function obb(x, z, yaw, w, d) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // local (u across, v depth) -> world; yaw rotates about Y: local +z -> (sin, cos)
  const to = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  return [to(-w / 2, -d / 2), to(w / 2, -d / 2), to(w / 2, d / 2), to(-w / 2, d / 2)];
}
function satOverlap(A, B, margin) {
  for (const P of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      let nx = -(b[1] - a[1]), nz = b[0] - a[0]; const l = Math.hypot(nx, nz); nx /= l; nz /= l;
      let minA = 1e9, maxA = -1e9, minB = 1e9, maxB = -1e9;
      for (const p of A) { const d = p[0] * nx + p[1] * nz; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const p of B) { const d = p[0] * nx + p[1] * nz; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA + margin < minB || maxB + margin < minA) return false;
    }
  }
  return true;
}

const WALLS = [
  ['#b0342b', 26], // corrugated red
  ['#d8a021', 15], // mustard
  ['#e9e8e1', 22], // white
  ['#5f9fd3', 19], // sky blue
  ['#2f6b53', 18], // dark green
];
const ROOFS = { '#b0342b': ['#3a3e45', '#22252a', '#e9e8e1'], '#d8a021': ['#3a3e45', '#8a2f27', '#22252a'], '#e9e8e1': ['#8a2f27', '#3a3e45', '#2e4a3f'], '#5f9fd3': ['#3a3e45', '#8a2f27', '#e9e8e1'], '#2f6b53': ['#3a3e45', '#22252a', '#8a2f27'] };

function pickWeighted(rnd, list) {
  const tot = list.reduce((a, b) => a + b[1], 0); let r = rnd() * tot;
  for (const [v, w] of list) { if ((r -= w) <= 0) return v; }
  return list[0][0];
}

/** Deterministic layout. Returns { streets, houses, church, rainbow, pier, lamps, stats }. */
export function computeVillage(world) {
  const rnd = mulberry32(20260929);
  const lines = streetLines(world);
  const streets = {};
  for (const k of Object.keys(lines)) streets[k] = samplePolyline(lines[k], 2);
  const rainbow = samplePolyline(rainbowPath(world), 1.2);
  const church = churchPlacement(world);
  const P = world.path.points;
  const roadNear = P.slice(-400);

  const allStreet = [...streets.main, ...streets.west, ...streets.shore, ...streets.spur];
  const minDist = (p, pts) => { let m = 1e9; for (const q of pts) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < m) m = d; } return m; };

  const houses = [];
  const stats = { tried: 0, rejected: { terrain: 0, road: 0, street: 0, overlap: 0, church: 0, rainbow: 0, pier: 0 } };
  const TARGET = 19;

  const tryPlace = (cx, cz, faceX, faceZ, kind) => {
    stats.tried++;
    let W, D, floors;
    if (kind === 'shed') { W = 9 + rnd() * 3; D = 6.5 + rnd() * 1.5; floors = 1; }
    else if (kind === 'small') { W = 5.2 + rnd() * 1.2; D = 4.8 + rnd(); floors = 1; }
    else { W = 6.8 + rnd() * 2.6; D = 5.6 + rnd() * 2.2; floors = rnd() < 0.55 ? 2 : 1; }
    const yaw = Math.atan2(faceX, faceZ);
    const foot = obb(cx, cz, yaw, W + 0.8, D + 0.8);
    const hs = [];
    for (const [x, z] of [...foot, [cx, cz]]) hs.push(world.heightAt(x, z));
    const hmin = Math.min(...hs), hmax = Math.max(...hs);
    if (hmin < 1.8 || hmax - hmin > 0.9) { stats.rejected.terrain++; return null; }
    for (const p of [...foot, [cx, cz]]) if (minDist(p, roadNear.map((q) => [q.x, q.z])) < 9) { stats.rejected.road++; return null; }
    for (const p of foot) if (minDist(p, allStreet) < 4.4) { stats.rejected.street++; return null; }
    for (const p of foot) if (minDist(p, rainbow) < 3.4) { stats.rejected.rainbow++; return null; }
    if (Math.hypot(cx - church.x, cz - church.z) < 15) { stats.rejected.church++; return null; }
    if (cx > PIER.x - 9 && cx < PIER.x + 9 && cz > PIER.z0 - 6) { stats.rejected.pier++; return null; }
    for (const h of houses) if (satOverlap(foot, h.foot, 1.2)) { stats.rejected.overlap++; return null; }
    const wall = pickWeighted(rnd, WALLS);
    const roofs = ROOFS[wall];
    const roof = roofs[Math.floor(rnd() * roofs.length)];
    const H = { x: cx, z: cz, yaw, W, D, floors, kind, wall, roof,
      ridge: kind === 'shed' ? 'x' : (rnd() < 0.5 ? 'x' : 'z'),
      porch: kind === 'house' && rnd() < 0.42, chimney: kind !== 'shed' && rnd() < 0.55,
      seed: Math.floor(rnd() * 1e9), foot,
      floorY: hmax + 0.2, baseY: hmin - 0.3 };
    houses.push(H);
    return H;
  };

  // candidates along every street/lane, both sides; shuffled so the streets fill evenly
  const lanes = [
    { pts: streets.main, half: 3.2, from: 20, step: 12, key: 'main' },
    { pts: streets.west, half: 3.2, from: 8, step: 12, key: 'west' },
    { pts: streets.shore, half: 3.2, from: 6, step: 12, key: 'shore' },
    { pts: rainbow, half: 1.6, from: 6, step: 13, key: 'rainbow', tight: true },
  ];
  const cands = [];
  for (const lane of lanes) {
    const n = lane.pts.length;
    let acc = 0; const arc = [0];
    for (let i = 1; i < n; i++) { acc += Math.hypot(lane.pts[i][0] - lane.pts[i - 1][0], lane.pts[i][1] - lane.pts[i - 1][1]); arc.push(acc); }
    for (let s = lane.from; s < acc - 4; s += lane.step * (0.85 + rnd() * 0.3)) {
      const i = arc.findIndex((a) => a >= s); if (i < 1) continue;
      const a = lane.pts[i - 1], b = lane.pts[i];
      let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
      for (const side of [-1, 1]) cands.push({ lane, b, tx, tz, rx: -tz, rz: tx, side, r: rnd() });
    }
  }
  cands.sort((p, q) => p.r - q.r);
  for (const c of cands) {
    if (houses.length >= TARGET) break;
    const kind = rnd() < 0.12 ? 'shed' : rnd() < 0.3 ? 'small' : 'house';
    const D = kind === 'small' ? 5.2 : 6.6;
    const setback = (c.lane.tight ? 2.6 : 3.4) + rnd() * 2.6;
    const off = c.lane.half + setback + D / 2;
    const cx = c.b[0] + c.rx * off * c.side + c.tx * (rnd() - 0.5) * 3, cz = c.b[1] + c.rz * off * c.side + c.tz * (rnd() - 0.5) * 3;
    // face the street (waterfront row: houses on the inland side face south to the fjord)
    let fx = -c.rx * c.side, fz = -c.rz * c.side;
    tryPlace(cx, cz, fx, fz, kind);
  }
  // a few extra houses in the block between the streets / by the shore, if the target is not met
  let guard = 0;
  while (houses.length < 14 && guard++ < 400) {
    const cx = -150 + rnd() * 190, cz = 875 + rnd() * 90;
    tryPlace(cx, cz, rnd() < 0.5 ? 0 : (rnd() < 0.5 ? -1 : 1), rnd() < 0.5 ? 1 : 0.2, rnd() < 0.3 ? 'small' : 'house');
  }
  // a big fish-house by the pier root (waterfront)
  {
    const H = tryPlace(PIER.x - 16, 968, 0, 1, 'shed');
    if (!H) tryPlace(PIER.x - 19, 970, 0, 1, 'shed');
  }

  // lamps: every ~30 m along the streets, alternating sides
  const lamps = [];
  const lampAlong = (pts, off, spacing, from = 10) => {
    let acc = 0, next = from, side = 1;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      acc += d;
      if (acc >= next) {
        let tx = (b[0] - a[0]) / d, tz = (b[1] - a[1]) / d;
        const x = b[0] - tz * off * side, z = b[1] + tx * off * side;
        lamps.push({ x, z, tx, tz, side });
        side = -side; next += spacing;
      }
    }
  };
  lampAlong(streets.main, 3.9, 32, 14);
  lampAlong(streets.west, 3.9, 34, 10);
  lampAlong(streets.shore, 3.9, 36, 12);

  return { streets, rainbow, church, houses, lamps, pier: PIER, stats };
}
