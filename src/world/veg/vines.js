// Hanging aerial roots, woody lianas (catenary loops between crowns and from
// the ground up into limbs) and leafy vine curtains. World-space, merged.

import * as THREE from 'three';
import { tube, card } from './geo.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Thin hanging root/rope from p down by len. */
export function hangingRoot(geo, R, p, len, baseBend, objPh, radius = 0.025) {
  const n = Math.max(4, Math.round(len / 1.4));
  const pts = [];
  const wx = (R() - 0.5) * 0.6, wz = (R() - 0.5) * 0.6, ph = R() * 6;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    pts.push(V(p.x + wx * s * s + Math.sin(s * 5 + ph) * 0.08, p.y - len * s, p.z + wz * s * s + Math.cos(s * 4 + ph) * 0.08));
  }
  const tint = 0.13 + R() * 0.08;
  tube(geo, pts, (t) => radius * (1 - 0.4 * t), {
    radial: 3,
    col: (t) => [tint * (1 + t * 0.3), tint * 0.95 * (1 + t * 0.4), tint * 0.75],
    wind: (t, q) => [baseBend + 0.035 * (p.y - q.y), 0, objPh, 0],
  });
}

/** Sagging liana between a and b (catenary approximated by a parabola). */
export function catenary(geo, R, a, b, sag, radius, bendA, bendB, objPh) {
  const n = 18;
  const pts = [];
  const side = V(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar((R() - 0.5) * 1.5);
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const p = a.clone().lerp(b, s);
    p.y -= sag * 4 * s * (1 - s);
    p.addScaledVector(side, Math.sin(s * Math.PI));
    pts.push(p);
  }
  const tint = 0.14 + R() * 0.06;
  tube(geo, pts, () => radius, {
    radial: 4,
    col: () => [tint * 1.05, tint, tint * 0.8],
    wind: (t) => [bendA * (1 - t) + bendB * t + sag * 0.06 * Math.sin(t * Math.PI), 0, objPh, 0],
  });
}

/** Leafy vine curtain: chain of vertical cards mapped to the vine slot. */
export function vineCurtain(geo, slot, R, p, len, baseBend, objPh) {
  const segLen = 1.8;
  const n = Math.max(1, Math.round(len / segLen));
  const az = R() * Math.PI;
  for (let rot = 0; rot < 2; rot++) {
    const a = az + rot * Math.PI * 0.5;
    const ax = V(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.28);
    const nrm = V(-Math.sin(a), 0.2, Math.cos(a)).normalize();
    for (let k = 0; k < n; k++) {
      const top = p.y - k * segLen;
      const c = V(p.x + Math.sin(k * 1.7 + az) * 0.05, top - segLen, p.z);
      const tint = 0.85 + R() * 0.25;
      card(geo, slot, c, ax, V(0, segLen + 0.05, 0), nrm, [tint, tint * 1.02, tint * 0.9],
        (y, v) => [baseBend + 0.035 * (p.y - y), 0.05, objPh, R()]);
    }
  }
}
