// Shared helpers for the set-piece builders (pure, no DOM).
import * as THREE from 'three';

/** Oriented box between two points (cross-section w wide horizontally x h tall). */
export function beamBox(mb, p0, p1, w, h, color, up = [0, 1, 0]) {
  const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const U = new THREE.Vector3(up[0], up[1], up[2]);
  let side = new THREE.Vector3().crossVectors(d, U);
  if (side.lengthSq() < 1e-9) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const upv = new THREE.Vector3().crossVectors(side, d).normalize(); // perpendicular to beam & side
  side.multiplyScalar(w / 2); upv.multiplyScalar(h / 2);
  const corner = (b, sx, sy) => [b[0] + side.x * sx + upv.x * sy, b[1] + side.y * sx + upv.y * sy, b[2] + side.z * sx + upv.z * sy];
  const A = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => corner(p0, sx, sy));
  const B = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => corner(p1, sx, sy));
  const o = { color };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mid = [(A[i][0] + A[j][0]) / 2 - p0[0], (A[i][1] + A[j][1]) / 2 - p0[1], (A[i][2] + A[j][2]) / 2 - p0[2]];
    mb.quadU(A[i], A[j], B[j], B[i], mid, { ...o, su: 1, sv: 1 });
  }
  mb.quadU(A[0], A[1], A[2], A[3], [-d.x, -d.y, -d.z], o);
  mb.quadU(B[0], B[1], B[2], B[3], [d.x, d.y, d.z], o);
}

/** Local frame at a path frame f: point(l, y, d) = centre + right*l + up*y + horizontalTangent*d. */
export function localPoint(f, l, y, d) {
  return [f.x + f.rx * l + f.tx * d, f.y + y, f.z + f.rz * l + f.tz * d];
}

/** Interpolated frame at fractional index. */
export function frameAtIndex(F, s) {
  const i = Math.max(0, Math.min(F.length - 2, Math.floor(s))), t = s - i, a = F[i], b = F[i + 1];
  const tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t, l = Math.hypot(tx, tz) || 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, tx: tx / l, tz: tz / l, rx: -tz / l, rz: tx / l, s };
}

/** Quad-strip mesh between two rows of points (row arrays of [x,y,z]); `out` hint per strip. */
export function stripQuads(mb, rowA, rowB, out, o = {}) {
  for (let k = 0; k < rowA.length - 1; k++) mb.quadU(rowA[k], rowA[k + 1], rowB[k + 1], rowB[k], out, o);
}
