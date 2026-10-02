// Tiny procedural mesh builder for the animals: lofted tubes (legs, neck, head, hair locks),
// noisy blobs (wool), everything merged into ONE BufferGeometry per species.
//
// Per-vertex attributes (consumed by skeleton.js):
//   color  (rgb)  static albedo, used where the tint weights don't cover the vertex
//   aA     (part, sway, phase, shade)   joint id, hair-sway weight 0..1, random phase, baked AO/brightness
//   aT     (wCoat, wMane, wPoints)      how much of the per-instance colours this vertex takes
import * as THREE from 'three';
import { noise2f } from '../../../core/noise.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class MeshBuilder {
  constructor() { this.P = []; this.N = []; this.C = []; this.A = []; this.T = []; this.I = []; }
  get count() { return this.P.length / 3; }
  vert(p, n, col, a, t) {
    this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]);
    this.C.push(col[0], col[1], col[2]); this.A.push(a[0], a[1], a[2], a[3]); this.T.push(t[0], t[1], t[2]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aA', new THREE.Float32BufferAttribute(this.A, 4));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(this.T, 3));
    g.setIndex(this.I.length > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// sRGB hex -> linear rgb array (static vertex colours must be linear like everything else)
const _c = new THREE.Color();
export const lin = (hex) => { _c.setHex(hex); return [_c.r, _c.g, _c.b]; };

/**
 * Loft an elliptical tube through `secs` = [{p:[x,y,z], rx, ry, col?, t?, sway?, shade?}].
 * rx runs along u (side), ry along v (the projection of `ref` perpendicular to the path).
 * opts: n radial segments, ref, part, phase, col, t, sway, shade, capStart/capEnd (rings of a
 *       rounded end cap, 0 = open), capLen, shadeFn(cos, sin, u01)
 */
export function loft(b, secs, o = {}) {
  const n = o.n ?? 10, ref = o.ref ?? [0, 1, 0];
  const S = secs.length;
  const base = { col: o.col ?? [0.5, 0.5, 0.5], t: o.t ?? [1, 0, 0], sway: o.sway ?? 0, shade: o.shade ?? 1 };
  const rings = [];
  const frame = [];
  for (let i = 0; i < S; i++) {
    const tan = norm(sub(secs[Math.min(i + 1, S - 1)].p, secs[Math.max(i - 1, 0)].p));
    let v = sub(ref, mul(tan, dot(ref, tan)));
    if (len(v) < 1e-4) v = sub([0, 0, 1], mul(tan, tan[2]));
    v = norm(v);
    const u = norm(cross(v, tan));
    frame.push({ tan, u, v });
  }
  const rAvg = secs.map((s) => (s.rx + s.ry) * 0.5);
  const mk = (i, p, scale, capA, outward) => {
    const s = secs[i], f = frame[i];
    const dr = (rAvg[Math.min(i + 1, S - 1)] - rAvg[Math.max(i - 1, 0)]) / Math.max(1e-4, len(sub(secs[Math.min(i + 1, S - 1)].p, secs[Math.max(i - 1, 0)].p)));
    return { p, s, f, scale, capA, outward, dr, i };
  };
  const capN = (cnt, atEnd) => {
    const i = atEnd ? S - 1 : 0, s = secs[i], f = frame[i], r = rAvg[i] * (o.capLen ?? 1);
    const out = atEnd ? f.tan : mul(f.tan, -1);
    const list = [];
    for (let j = 1; j <= cnt; j++) {
      const a = (j / cnt) * Math.PI * 0.5;
      list.push(mk(i, add(s.p, mul(out, r * Math.sin(a))), Math.cos(a), a, out));
    }
    return list; // from just outside the end ring to the tip
  };
  const cs = o.capStart ? capN(o.capStart, false).reverse() : [];
  const ce = o.capEnd ? capN(o.capEnd, true) : [];
  for (const r of cs) rings.push(r);
  for (let i = 0; i < S; i++) rings.push(mk(i, secs[i].p, 1, 0, null));
  for (const r of ce) rings.push(r);

  const v0 = b.count;
  for (const r of rings) {
    const { s, f } = r;
    const col = s.col ?? base.col, t = s.t ?? base.t, sway = s.sway ?? base.sway, shade0 = s.shade ?? base.shade;
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2, ct = Math.cos(th), st = Math.sin(th);
      const rx = s.rx * r.scale, ry = s.ry * r.scale;
      const p = [
        r.p[0] + f.u[0] * rx * ct + f.v[0] * ry * st,
        r.p[1] + f.u[1] * rx * ct + f.v[1] * ry * st,
        r.p[2] + f.u[2] * rx * ct + f.v[2] * ry * st,
      ];
      let ne = norm(add(mul(f.u, ct / Math.max(s.rx, 1e-4)), mul(f.v, st / Math.max(s.ry, 1e-4))));
      let nn;
      if (r.outward) nn = norm(add(mul(ne, Math.cos(r.capA)), mul(r.outward, Math.sin(r.capA))));
      else nn = norm(sub(ne, mul(f.tan, r.dr)));
      const shade = o.shadeFn ? shade0 * o.shadeFn(ct, st, r.i / Math.max(1, S - 1)) : shade0;
      b.vert(p, nn, col, [o.part ?? 0, sway, o.phase ?? 0, shade], t);
    }
  }
  const R = rings.length;
  const idx = [];
  for (let r = 0; r < R - 1; r++) for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const a = v0 + r * n + k, bb = v0 + r * n + k1, c = v0 + (r + 1) * n + k1, d = v0 + (r + 1) * n + k;
    idx.push([a, bb, c], [a, c, d]);
  }
  fixWinding(b, idx, v0);
  for (const t of idx) b.I.push(t[0], t[1], t[2]);
}

// flip all triangles of a piece if they disagree with the analytic vertex normals
function fixWinding(b, tris, v0) {
  let agree = 0, dis = 0;
  for (const [a, bb, c] of tris) {
    const pa = b.P.slice(a * 3, a * 3 + 3), pb = b.P.slice(bb * 3, bb * 3 + 3), pc = b.P.slice(c * 3, c * 3 + 3);
    const fn = cross(sub(pb, pa), sub(pc, pa));
    if (len(fn) < 1e-9) continue;
    const nn = [0, 0, 0];
    for (const v of [a, bb, c]) { nn[0] += b.N[v * 3]; nn[1] += b.N[v * 3 + 1]; nn[2] += b.N[v * 3 + 2]; }
    if (dot(fn, nn) >= 0) agree++; else dis++;
  }
  if (dis > agree) for (const t of tris) { const x = t[1]; t[1] = t[2]; t[2] = x; }
}

/**
 * Lumpy blob (wool). Numeric smooth normals, brightness baked from the lump height.
 */
export function blob(b, c, r, o = {}) {
  const lon = o.lon ?? 12, lat = o.lat ?? 8, amp = o.amp ?? 0.16, fr = o.freq ?? 3.2, seed = o.seed ?? 0;
  const v0 = b.count;
  const P = [];
  for (let j = 0; j <= lat; j++) {
    const phi = (j / lat) * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let k = 0; k < lon; k++) {
      const th = (k / lon) * Math.PI * 2;
      const d = [Math.cos(th) * sp, -cp, Math.sin(th) * sp];
      const q = noise2f(d[0] * fr + d[1] * fr * 0.7 + seed * 5.1, d[2] * fr - d[1] * fr * 0.9 + seed * 2.3, seed) * 0.7
        + noise2f(d[0] * fr * 2.3 - seed, d[2] * fr * 2.1 + d[1] * 3.0, seed + 9) * 0.3;
      const k1 = 1 + amp * q;
      const p = [c[0] + d[0] * r[0] * k1, c[1] + d[1] * r[1] * k1, c[2] + d[2] * r[2] * k1];
      P.push({ p, d, q });
    }
  }
  const idx = [];
  for (let j = 0; j < lat; j++) for (let k = 0; k < lon; k++) {
    const k1 = (k + 1) % lon;
    const a = j * lon + k, bb = j * lon + k1, cc = (j + 1) * lon + k1, dd = (j + 1) * lon + k;
    idx.push([a, bb, cc], [a, cc, dd]);
  }
  // orient outward
  for (const t of idx) {
    const pa = P[t[0]].p, pb = P[t[1]].p, pc = P[t[2]].p;
    const fn = cross(sub(pb, pa), sub(pc, pa));
    const ctr = mul(add(add(pa, pb), pc), 1 / 3);
    if (dot(fn, sub(ctr, c)) < 0) { const x = t[1]; t[1] = t[2]; t[2] = x; }
  }
  const N = P.map(() => [0, 0, 0]);
  for (const [a, bb, cc] of idx) {
    const fn = cross(sub(P[bb].p, P[a].p), sub(P[cc].p, P[a].p));
    for (const v of [a, bb, cc]) { N[v][0] += fn[0]; N[v][1] += fn[1]; N[v][2] += fn[2]; }
  }
  const col = o.col ?? [0.5, 0.5, 0.5], t = o.t ?? [1, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const nn = len(N[i]) > 1e-9 ? norm(N[i]) : P[i].d;
    const dy = P[i].d[1];
    const ao = 1 - (o.bottomAO ?? 0.3) * Math.min(1, Math.max(0, (0.1 - dy) / 0.9));
    const shade = (o.shade ?? 1) * Math.min(1.12, Math.max(0.68, 0.94 + (o.lump ?? 0.3) * P[i].q)) * ao;
    b.vert(P[i].p, nn, col, [o.part ?? 0, o.sway ?? 0, o.phase ?? 0, shade], t);
  }
  for (const t2 of idx) b.I.push(v0 + t2[0], v0 + t2[1], v0 + t2[2]);
}

// Catmull-Rom through control points, `m` samples
export function spline(pts, m) {
  const out = [];
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const segs = pts.length - 1;
  for (let s = 0; s < m; s++) {
    const f = (s / (m - 1)) * segs, i = Math.min(segs - 1, Math.floor(f)), u = f - i;
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const q = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      q[a] = 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * u + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * u * u + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * u * u * u);
    }
    out.push(q);
  }
  return out;
}

/** Tapered hair lock along `pts` (flat ribbon: width `w` along u, thickness `th` along ref). */
export function lock(b, pts, w, th, o = {}) {
  const m = pts.length;
  const secs = pts.map((p, i) => {
    const u = i / (m - 1), tp = 1 - 0.9 * Math.pow(u, 1.3);
    return { p, rx: w * tp, ry: th * tp, sway: (o.swayBase ?? 0) + u * (1 - (o.swayBase ?? 0)) };
  });
  loft(b, secs, { n: o.n ?? 3, ref: o.ref ?? [1, 0, 0], part: o.part ?? 0, phase: o.phase ?? 0, col: o.root ?? o.col, t: o.t ?? [0, 1, 0], shade: o.shade ?? 1 });
}

/** Small smooth ellipsoid (eyes, nostrils, hooves...). */
export function ball(b, c, r, o = {}) {
  blob(b, c, r, { lon: o.lon ?? 8, lat: o.lat ?? 5, amp: 0, ...o });
}
