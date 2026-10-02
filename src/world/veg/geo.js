// Geometry accumulation helpers for procedural plants.
// Every vertex carries: position, normal, uv, color (rgb, AO/tint), aWind (vec4).

import * as THREE from 'three';

export class Geo {
  constructor(cap = 1024) {
    this.cap = cap; this.icap = cap * 3;
    this.p = new Float32Array(cap * 3); this.n = new Float32Array(cap * 3); this.uv = new Float32Array(cap * 2);
    this.c = new Float32Array(cap * 3); this.w = new Float32Array(cap * 4); this.i = new Uint32Array(this.icap);
    this.nv = 0; this.ni = 0;
  }
  grow() {
    const cap = this.cap * 2;
    const g = (a, k) => { const b = new Float32Array(cap * k); b.set(a); return b; };
    this.p = g(this.p, 3); this.n = g(this.n, 3); this.uv = g(this.uv, 2); this.c = g(this.c, 3); this.w = g(this.w, 4);
    this.cap = cap;
  }
  v(x, y, z, nx, ny, nz, u, v, r, g, b, w0, w1, w2, w3) {
    if (this.nv >= this.cap) this.grow();
    const k = this.nv, k3 = k * 3;
    const P = this.p, N = this.n, C = this.c, W = this.w;
    P[k3] = x; P[k3 + 1] = y; P[k3 + 2] = z;
    N[k3] = nx; N[k3 + 1] = ny; N[k3 + 2] = nz;
    this.uv[k * 2] = u; this.uv[k * 2 + 1] = v;
    C[k3] = r; C[k3 + 1] = g; C[k3 + 2] = b;
    W[k * 4] = w0; W[k * 4 + 1] = w1; W[k * 4 + 2] = w2; W[k * 4 + 3] = w3;
    return this.nv++;
  }
  _idx(n) {
    if (this.ni + n > this.icap) { this.icap *= 2; const b = new Uint32Array(this.icap); b.set(this.i); this.i = b; }
  }
  tri(a, b, c) { this._idx(3); const I = this.i; I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c; }
  quad(a, b, c, d) {
    this._idx(6); const I = this.i;
    I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c; I[this.ni++] = a; I[this.ni++] = c; I[this.ni++] = d;
  }
  get triCount() { return this.ni / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    const n = this.nv;
    g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.slice(0, n * 3), 3));
    g.setAttribute('aWind', new THREE.BufferAttribute(this.w.slice(0, n * 4), 4));
    const idx = this.i.subarray(0, this.ni);
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(idx.slice(), 1) : new THREE.BufferAttribute(Uint16Array.from(idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();

/**
 * Emit a rows×cols grid surface. P is Float32Array rows*(cols)*3 (no seam dup).
 * closed: columns wrap (a tube) — a seam column is duplicated for UVs.
 * Normals = cross(dCol, dRow) (outward for CCW-in-(N,B) rings).
 * cb.uv(i,j) → [u,v], cb.col(i,j) → [r,g,b], cb.wind(i,j) → [4]
 */
export function emitGrid(geo, P, rows, cols, closed, cb, flip = false) {
  const base = geo.nv;
  const cc = closed ? cols + 1 : cols;
  const at = (i, j) => (i * cols + j) * 3;
  for (let i = 0; i < rows; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(rows - 1, i + 1);
    for (let jj = 0; jj < cc; jj++) {
      const j = closed ? jj % cols : jj;
      let j0, j1;
      if (closed) { j0 = (j - 1 + cols) % cols; j1 = (j + 1) % cols; } else { j0 = Math.max(0, j - 1); j1 = Math.min(cols - 1, j + 1); }
      const kc0 = at(i, j0), kc1 = at(i, j1), kr0 = at(i0, j), kr1 = at(i1, j);
      _a.set(P[kc1] - P[kc0], P[kc1 + 1] - P[kc0 + 1], P[kc1 + 2] - P[kc0 + 2]);
      _b.set(P[kr1] - P[kr0], P[kr1 + 1] - P[kr0 + 1], P[kr1 + 2] - P[kr0 + 2]);
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
      _n.normalize();
      if (flip) _n.negate();
      const k = at(i, j);
      const uv = cb.uv(i, jj), c = cb.col(i, j), w = cb.wind(i, j);
      geo.v(P[k], P[k + 1], P[k + 2], _n.x, _n.y, _n.z, uv[0], uv[1], c[0], c[1], c[2], w[0], w[1], w[2], w[3]);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cc - 1; j++) {
      const a = base + i * cc + j, b = a + 1, c = a + cc + 1, d = a + cc;
      if (flip) geo.quad(a, d, c, b); else geo.quad(a, b, c, d);
    }
  }
}

/**
 * Tube along a polyline with parallel-transport frames.
 * path: array of THREE.Vector3; radius(t, ang, i) → r; opts: radial, uRep, texLen (m per v unit),
 * col(t, ang, p) → [r,g,b]; wind(t, p) → [4]; shape(t, ang) → [sx, sy] optional elliptic factors
 */
export function tube(geo, path, radius, o) {
  const rows = path.length, cols = o.radial;
  const T = [], N = [], B = [];
  for (let i = 0; i < rows; i++) {
    const t = new THREE.Vector3();
    if (i === 0) t.subVectors(path[1], path[0]);
    else if (i === rows - 1) t.subVectors(path[i], path[i - 1]);
    else t.subVectors(path[i + 1], path[i - 1]);
    T.push(t.normalize());
  }
  const n0 = new THREE.Vector3();
  if (o.n0) n0.copy(o.n0);
  else n0.set(Math.abs(T[0].y) < 0.9 ? 0 : 1, Math.abs(T[0].y) < 0.9 ? 1 : 0, 0);
  n0.sub(T[0].clone().multiplyScalar(n0.dot(T[0]))).normalize();
  N.push(n0); B.push(new THREE.Vector3().crossVectors(T[0], n0));
  for (let i = 1; i < rows; i++) {
    const n = N[i - 1].clone();
    n.sub(T[i].clone().multiplyScalar(n.dot(T[i]))).normalize();
    N.push(n); B.push(new THREE.Vector3().crossVectors(T[i], n));
  }
  // arc length
  const L = [0];
  for (let i = 1; i < rows; i++) L.push(L[i - 1] + path[i].distanceTo(path[i - 1]));
  const total = L[rows - 1] || 1;
  const P = new Float32Array(rows * cols * 3);
  const pts = [];
  for (let i = 0; i < rows; i++) {
    const t = L[i] / total;
    for (let j = 0; j < cols; j++) {
      const ang = (j / cols) * Math.PI * 2;
      const r = radius(t, ang, i);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const k = (i * cols + j) * 3;
      P[k] = path[i].x + (N[i].x * ca + B[i].x * sa) * r;
      P[k + 1] = path[i].y + (N[i].y * ca + B[i].y * sa) * r;
      P[k + 2] = path[i].z + (N[i].z * ca + B[i].z * sa) * r;
    }
  }
  const tmp = new THREE.Vector3();
  const texLen = o.texLen || 1;
  emitGrid(geo, P, rows, cols, true, {
    uv: (i, jj) => {
      const u = (jj / cols) * (o.uRep || 1) + (o.uOff || 0), v = L[i] / texLen + (o.vOff || 0);
      return o.uvMap ? o.uvMap(jj / cols, L[i] / total) : [u, v];
    },
    col: (i, j) => {
      const k = (i * cols + j) * 3;
      tmp.set(P[k], P[k + 1], P[k + 2]);
      return o.col ? o.col(L[i] / total, (j / cols) * Math.PI * 2, tmp, i) : [1, 1, 1];
    },
    wind: (i, j) => {
      const k = (i * cols + j) * 3;
      tmp.set(P[k], P[k + 1], P[k + 2]);
      return o.wind ? o.wind(L[i] / total, tmp) : [0, 0, 0, 0];
    },
  });
  return { T, N, B, L, total };
}

/**
 * Bent leaf blade mapped to an atlas slot.
 * o: origin (Vector3), dir (unit Vector3, initial heading), length, width,
 *    segL, segW, droop (rad of downward curl along length), fold (m, edges up),
 *    attach (0..1, where along the slot the origin sits), col [r,g,b], ao (0..1 base darkening),
 *    bend (m sway at tip), flutter (m), objPh, leafPh, twist (rad), uFlip
 */
const UP = new THREE.Vector3(0, 1, 0);
export function leafBlade(geo, slot, o) {
  const segL = o.segL || 6, segW = o.segW || 2;
  const rows = segL + 1, cols = segW * 2 + 1;
  const attach = o.attach || 0;
  const P = new Float32Array(rows * cols * 3);
  // midrib by integrating heading with increasing downward pitch
  const heading = o.dir.clone().normalize();
  const horiz = new THREE.Vector3(heading.x, 0, heading.z);
  if (horiz.lengthSq() < 1e-6) horiz.set(1, 0, 0);
  horiz.normalize();
  const side0 = new THREE.Vector3().crossVectors(horiz, UP).normalize(); // right-hand side
  const pitch0 = Math.asin(THREE.MathUtils.clamp(heading.y, -1, 1));
  const mid = [], tan = [];
  const ds = 1 / segL;
  // start at s=0 (slot bottom) placed behind origin by attach*length
  let pos = o.origin.clone();
  const stepDir = (s) => {
    const q = Math.max(0, (s - attach) / Math.max(1e-3, 1 - attach));
    const p = s < attach ? pitch0 - 0.35 : pitch0 - (o.droop || 0) * Math.pow(q, 1.3);
    return new THREE.Vector3().copy(horiz).multiplyScalar(Math.cos(p)).addScaledVector(UP, Math.sin(p));
  };
  // walk back from origin to s=0
  const back = [];
  let bp = o.origin.clone();
  const nBack = Math.round(attach * segL);
  for (let k = 0; k < nBack; k++) {
    const s = attach - (k + 0.5) * ds;
    bp = bp.clone().addScaledVector(stepDir(s), -ds * o.length);
    back.push(bp);
  }
  back.reverse();
  for (const b of back) mid.push(b);
  pos = o.origin.clone();
  mid.push(pos.clone());
  for (let i = nBack + 1; i < rows; i++) {
    const s = (i - 0.5) * ds;
    pos = pos.clone().addScaledVector(stepDir(s), ds * o.length);
    mid.push(pos);
  }
  for (let i = 0; i < rows; i++) {
    const a = mid[Math.max(0, i - 1)], b = mid[Math.min(rows - 1, i + 1)];
    tan.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const twist = o.twist || 0;
  for (let i = 0; i < rows; i++) {
    const s = i / segL;
    const nrm = new THREE.Vector3().crossVectors(side0, tan[i]).normalize(); // leaf "up"
    const side = side0.clone().applyAxisAngle(tan[i], twist * s);
    const nn = nrm.clone().applyAxisAngle(tan[i], twist * s);
    for (let j = 0; j < cols; j++) {
      const w = (j / (cols - 1)) * 2 - 1;
      const hw = o.width * 0.5;
      const k = (i * cols + j) * 3;
      const fold = (o.fold || 0) * Math.pow(Math.abs(w), 1.5) * Math.sin(Math.PI * Math.min(1, s * 1.1 + 0.05));
      const x = mid[i].x + side.x * w * hw + nn.x * fold;
      const y = mid[i].y + side.y * w * hw + nn.y * fold;
      const z = mid[i].z + side.z * w * hw + nn.z * fold;
      P[k] = x; P[k + 1] = y; P[k + 2] = z;
    }
  }
  const col = o.col || [1, 1, 1];
  emitGrid(geo, P, rows, cols, false, {
    uv: (i, j) => {
      const u = o.uFlip ? 1 - j / (cols - 1) : j / (cols - 1);
      return [slot.u0 + (slot.u1 - slot.u0) * u, slot.v0 + (slot.v1 - slot.v0) * (i / segL)];
    },
    col: (i) => {
      const s = i / segL;
      const ao = 1 - (o.ao || 0) * (1 - s);
      return [col[0] * ao, col[1] * ao, col[2] * ao];
    },
    wind: (i, j) => {
      const s = i / segL;
      const w = Math.abs((j / (cols - 1)) * 2 - 1);
      const k = (i * cols + j) * 3;
      const hb = o.bendFn ? o.bendFn(P[k + 1]) : (o.bend || 0);
      return [hb, (o.flutter || 0) * Math.max(0, s - attach) * (0.7 + 0.3 * w), o.objPh || 0, o.leafPh || 0];
    },
  });
}

/**
 * Flat card (quad) mapped to an atlas slot. c = centre-bottom anchor, ax = right (half width),
 * ay = up (full height). nrm: per-card normal (can be bent). wind per corner via fn(y, isTop).
 */
export function card(geo, slot, c, ax, ay, nrm, col, windFn, nrmTop) {
  const nt = nrmTop || nrm;
  const P = [
    [c.x - ax.x, c.y - ax.y, c.z - ax.z, 0, 0, nrm],
    [c.x + ax.x, c.y + ax.y, c.z + ax.z, 1, 0, nrm],
    [c.x + ax.x + ay.x, c.y + ax.y + ay.y, c.z + ax.z + ay.z, 1, 1, nt],
    [c.x - ax.x + ay.x, c.y - ax.y + ay.y, c.z - ax.z + ay.z, 0, 1, nt],
  ];
  const ids = P.map(([x, y, z, u, v, n], k) => {
    const w = windFn(y, v);
    const cc = Array.isArray(col[0]) ? col[k] : col;
    return geo.v(x, y, z, n.x, n.y, n.z,
      slot.u0 + (slot.u1 - slot.u0) * u, slot.v0 + (slot.v1 - slot.v0) * v,
      cc[0], cc[1], cc[2], w[0], w[1], w[2], w[3]);
  });
  geo.quad(ids[0], ids[1], ids[2], ids[3]);
}
