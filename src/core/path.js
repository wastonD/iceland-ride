// Rideable path helper: turns an XZ curve + height function into the `path`
// object the skate controller uses (same shape as the fjord road).
import * as THREE from 'three';
import { clamp } from './noise.js';

export function makePath(curve, heightFn, { closed = false, width = 3, step = 1, lift = 0.05, smooth = 6 } = {}) {
  const n = Math.max(2, Math.floor(curve.getLength() / step));
  const pts = curve.getSpacedPoints(n);
  const raw = pts.map((p) => heightFn(p.x, p.z));
  for (let i = 0; i < pts.length; i++) {
    let s = 0, c = 0;
    for (let k = -smooth; k <= smooth; k++) {
      let j = i + k;
      if (closed) j = (j + pts.length) % pts.length; else j = clamp(j, 0, pts.length - 1);
      s += raw[j]; c++;
    }
    pts[i].y = s / c + lift;
  }
  const len = (pts.length - 1) * step;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const wrap = (s) => (closed ? ((s % len) + len) % len : clamp(s, 0, len));
  const path = {
    closed, length: len, width, points: pts,
    pointAt(s, out = new THREE.Vector3()) {
      const f = Math.min(wrap(s) / step, pts.length - 1.001), i = Math.floor(f);
      return out.copy(pts[i]).lerp(pts[i + 1], f - i);
    },
    tangentAt(s, out = new THREE.Vector3()) {
      return out.subVectors(path.pointAt(s + 2, a), path.pointAt(s - 2, b)).normalize();
    },
    heightAt(s) { return path.pointAt(s, a).y; },
    nearestS(x, z) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      return bi * step;
    },
  };
  return path;
}
