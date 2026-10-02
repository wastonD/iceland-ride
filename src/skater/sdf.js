// Tiny signed-distance modelling kit + surface-nets mesher for the rider.
//
// Shapes are trees of nodes; smooth unions blend both the distance AND the per-vertex
// attributes (skin weights, colour, roughness, first-person mask), so fillets between a
// sleeve and the torso get smoothly blended skin weights for free.
//
//   const n = U(0.05, L(ellipsoid(...), attr), L(cone(...), attr));
//   const geo = meshSDF(n, [x0,y0,z0], [x1,y1,z1], h);   // {pos, nor, att, idx}
//
// Vertices are projected onto the true iso-surface (Newton steps along the gradient) and
// normals come from the SDF gradient, so the result shades perfectly smooth even at a
// coarse grid.

// ---- primitives: (x,y,z) → signed distance ------------------------------------------
export function ellipsoid(cx, cy, cz, rx, ry, rz) {
  return (x, y, z) => {
    const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
    const k0 = Math.sqrt(px * px + py * py + pz * pz);
    const qx = px / rx, qy = py / ry, qz = pz / rz;
    const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
    return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  };
}

/** Round cone (capsule with different end radii) from a to b. */
export function cone(ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az;
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const vx = pax * l2 - bax * yy, vy = pay * l2 - bay * yy, vz = paz * l2 - baz * yy;
    const x2 = vx * vx + vy * vy + vz * vz;
    const y2 = yy * yy * l2;
    const z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

/** Axis-aligned rounded box: centre, half extents, corner radius. */
export function rbox(cx, cy, cz, hx, hy, hz, r) {
  return (x, y, z) => {
    const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r, qz = Math.abs(z - cz) - hz + r;
    const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}

/** Half-space n·p <= o (n need not be normalised). */
export function half(nx, ny, nz, o) {
  const l = Math.hypot(nx, ny, nz);
  nx /= l; ny /= l; nz /= l; o /= l;
  return (x, y, z) => nx * x + ny * y + nz * z - o;
}

/** Evaluate `f` in a space scaled by (sx,sy,sz) about (cx,cy,cz) (approximate SDF). */
export function scaled(f, cx, cy, cz, sx, sy, sz) {
  const m = Math.min(sx, sy, sz);
  return (x, y, z) => f(cx + (x - cx) / sx, cy + (y - cy) / sy, cz + (z - cz) / sz) * m;
}

// ---- nodes -----------------------------------------------------------------------------
// attr: { col: hex|[r,g,b], rough, fp (0/1), skin: boneName | fn(x,y,z) → [[bone, w], ...] }
export const L = (d, attr) => ({ t: 'L', d, attr });
export const U = (k, ...ch) => ({ t: 'U', k, ch });
export const I = (k, a, b) => ({ t: 'I', k, a, b });           // a ∩ b, attributes of a
export const S = (k, a, b) => ({ t: 'S', k, a, b });           // a − b, attributes of a
/** Rigid rotation of a subtree: angle (rad) about axis (unit) through pivot. */
export function X(pivot, axis, angle, ch) {
  // inverse rotation (Rodrigues) as a 3x3 matrix
  const [ux, uy, uz] = axis;
  const c = Math.cos(-angle), s = Math.sin(-angle), t = 1 - c;
  const m = [
    t * ux * ux + c, t * ux * uy - s * uz, t * ux * uz + s * uy,
    t * ux * uy + s * uz, t * uy * uy + c, t * uy * uz - s * ux,
    t * ux * uz - s * uy, t * uy * uz + s * ux, t * uz * uz + c,
  ];
  return { t: 'X', p: pivot, m, ch };
}

function smin(a, b, k) {
  if (k <= 0) return [Math.min(a, b), a < b ? 1 : 0];
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return [b * (1 - h) + a * h - k * h * (1 - h), h];
}

function smax(a, b, k) {   // = -smin(-a, -b, k), allocation-free
  if (k <= 0) return Math.max(a, b);
  const h = Math.min(1, Math.max(0, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

export function dist(n, x, y, z) {
  switch (n.t) {
    case 'L': return n.d(x, y, z);
    case 'U': {
      let d = dist(n.ch[0], x, y, z);
      for (let i = 1; i < n.ch.length; i++) {
        const b = dist(n.ch[i], x, y, z);
        if (n.k <= 0) d = Math.min(d, b);
        else {
          const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - d)) / n.k));
          d = b * (1 - h) + d * h - n.k * h * (1 - h);
        }
      }
      return d;
    }
    case 'I': return smax(dist(n.a, x, y, z), dist(n.b, x, y, z), n.k);
    case 'S': return smax(dist(n.a, x, y, z), -dist(n.b, x, y, z), n.k);
    case 'X': {
      const dx = x - n.p[0], dy = y - n.p[1], dz = z - n.p[2], m = n.m;
      return dist(n.ch, n.p[0] + m[0] * dx + m[1] * dy + m[2] * dz, n.p[1] + m[3] * dx + m[4] * dy + m[5] * dz, n.p[2] + m[6] * dx + m[7] * dy + m[8] * dz);
    }
  }
  return 1e9;
}

/** Attribute vector layout: [w_0 .. w_{nb-1}, r, g, b, rough, fp]. */
export function makeAttrEval(boneIndex, nb, hexToRgb) {
  const NA = nb + 5;
  function leafAttr(n, x, y, z) {
    const a = new Float32Array(NA);
    const at = n.attr;
    let list = typeof at.skin === 'function' ? at.skin(x, y, z) : [[at.skin, 1]];
    for (const [b, w] of list) {
      const bi = boneIndex[b];
      if (bi === undefined) throw new Error('unknown bone ' + b);
      a[bi] += w;
    }
    const c = at._rgb || (at._rgb = hexToRgb(at.col));
    a[nb] = c[0]; a[nb + 1] = c[1]; a[nb + 2] = c[2];
    a[nb + 3] = at.rough ?? 0.8;
    a[nb + 4] = at.fp ? 1 : 0;
    return a;
  }
  function ev(n, x, y, z) {   // → { d, a }
    switch (n.t) {
      case 'L': return { d: n.d(x, y, z), a: leafAttr(n, x, y, z) };
      case 'U': {
        let r = ev(n.ch[0], x, y, z);
        for (let i = 1; i < n.ch.length; i++) {
          const q = ev(n.ch[i], x, y, z);
          const [d, h] = smin(r.d, q.d, n.k);
          const a = r.a;
          for (let j = 0; j < NA; j++) a[j] = q.a[j] + (a[j] - q.a[j]) * h;
          r = { d, a };
        }
        return r;
      }
      case 'I': case 'S': {
        const r = ev(n.a, x, y, z);
        return { d: dist(n, x, y, z), a: r.a };
      }
      case 'X': {
        const dx = x - n.p[0], dy = y - n.p[1], dz = z - n.p[2], m = n.m;
        return ev(n.ch, n.p[0] + m[0] * dx + m[1] * dy + m[2] * dz, n.p[1] + m[3] * dx + m[4] * dy + m[5] * dz, n.p[2] + m[6] * dx + m[7] * dy + m[8] * dz);
      }
    }
    return null;
  }
  return { ev, NA };
}

// ---- surface nets ----------------------------------------------------------------------
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],   // x
  [0, 2], [1, 3], [4, 6], [5, 7],   // y
  [0, 4], [1, 5], [2, 6], [3, 7],   // z
];

/**
 * Mesh the zero set of `node` inside the box [lo, hi] with grid spacing h.
 * Returns { pos: Float32Array, nor: Float32Array, idx: Uint32Array }.
 */
export function meshSDF(node, lo, hi, h) {
  const f = (x, y, z) => dist(node, x, y, z);
  const ox = lo[0] - h, oy = lo[1] - h, oz = lo[2] - h;
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 3, ny = Math.ceil((hi[1] - lo[1]) / h) + 3, nz = Math.ceil((hi[2] - lo[2]) / h) + 3;
  const v = new Float32Array(nx * ny * nz);
  for (let k = 0, q = 0; k < nz; k++) {
    const z = oz + k * h;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * h;
      for (let i = 0; i < nx; i++, q++) v[q] = f(ox + i * h, y, z);
    }
  }
  const G = (i, j, k) => i + nx * (j + ny * k);
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const P = [];
  const cv = new Float32Array(8);
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const val = v[G(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          cv[c] = val;
          if (val < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          n++;
        }
        cell[i + cx * (j + cy * k)] = P.length / 3;
        P.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h);
      }
    }
  }
  // project onto the iso-surface; gradient normals
  const nv = P.length / 3;
  const pos = new Float32Array(P);
  const nor = new Float32Array(nv * 3);
  const e = h * 0.08;
  const g = [0, 0, 0];
  const grad = (x, y, z) => {
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
    g[0] = (a - b - c + d) / (4 * e); g[1] = (-a - b + c + d) / (4 * e); g[2] = (-a + b - c + d) / (4 * e);
  };
  const maxStep = 0.6 * h;
  for (let q = 0; q < nv; q++) {
    let x = pos[q * 3], y = pos[q * 3 + 1], z = pos[q * 3 + 2];
    for (let it = 0; it < 4; it++) {
      const d = f(x, y, z);
      if (Math.abs(d) < h * 1e-3) break;
      grad(x, y, z);
      const gl2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (gl2 < 1e-8) break;
      let s = d / gl2;
      const len = Math.abs(s) * Math.sqrt(gl2);
      if (len > maxStep) s *= maxStep / len;
      x -= s * g[0]; y -= s * g[1]; z -= s * g[2];
    }
    pos[q * 3] = x; pos[q * 3 + 1] = y; pos[q * 3 + 2] = z;
    grad(x, y, z);
    const l = Math.hypot(g[0], g[1], g[2]) || 1;
    nor[q * 3] = g[0] / l; nor[q * 3 + 1] = g[1] / l; nor[q * 3 + 2] = g[2] / l;
  }
  // faces: one quad per sign-changing grid edge
  const idx = [];
  const C = (i, j, k) => cell[i + cx * (j + cy * k)];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // shorter diagonal
    const dac = (pos[a * 3] - pos[c * 3]) ** 2 + (pos[a * 3 + 1] - pos[c * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[c * 3 + 2]) ** 2;
    const dbd = (pos[b * 3] - pos[d * 3]) ** 2 + (pos[b * 3 + 1] - pos[d * 3 + 1]) ** 2 + (pos[b * 3 + 2] - pos[d * 3 + 2]) ** 2;
    if (dac <= dbd) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
  };
  const tri = (a, b, c) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const sn = (nor[a * 3] + nor[b * 3] + nor[c * 3]) * fx + (nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1]) * fy + (nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2]) * fz;
    if (sn >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const s0 = v[G(i, j, k)] < 0;
        if (s0 !== (v[G(i + 1, j, k)] < 0)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k));
        if (s0 !== (v[G(i, j + 1, k)] < 0)) quad(C(i - 1, j, k - 1), C(i, j, k - 1), C(i, j, k), C(i - 1, j, k));
        if (s0 !== (v[G(i, j, k + 1)] < 0)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k));
      }
    }
  }
  return { pos, nor, idx: new Uint32Array(idx) };
}

// ---- quadric-error edge-collapse simplification (vertex-subset placement) ---------------
// Keeps a subset of the original vertices, so positions stay exactly on the iso-surface and
// the gradient normals stay valid. Rejects collapses that flip faces or break manifoldness.
export function simplify(m, targetTris) {
  const pos = m.pos, nor = m.nor;
  const nv = pos.length / 3;
  const F = Int32Array.from(m.idx);
  const nf = F.length / 3;
  let live = nf;
  if (live <= targetTris) return m;
  const fAlive = new Uint8Array(nf).fill(1);
  const vf = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) vf[F[f * 3 + k]].push(f);
  const Q = new Float64Array(nv * 10);
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-14) continue;
    const area = l * 0.5;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * pos[a * 3] + ny * pos[a * 3 + 1] + nz * pos[a * 3 + 2]);
    const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) for (let k = 0; k < 10; k++) Q[v * 10 + k] += q[k] * area;
  }
  const qerr = (u, v, p) => {   // (Qu+Qv) evaluated at vertex p
    const x = pos[p * 3], y = pos[p * 3 + 1], z = pos[p * 3 + 2];
    const A = (k) => Q[u * 10 + k] + Q[v * 10 + k];
    return A(0) * x * x + 2 * A(1) * x * y + 2 * A(2) * x * z + 2 * A(3) * x + A(4) * y * y + 2 * A(5) * y * z + 2 * A(6) * y + A(7) * z * z + 2 * A(8) * z + A(9);
  };
  const ver = new Int32Array(nv);
  // binary heap of [cost, u(removed), v(kept), verU, verV]
  const H = [];
  const push = (e) => { H.push(e); let i = H.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (H[p][0] <= e[0]) break; H[i] = H[p]; i = p; } H[i] = e; };
  const pop = () => {
    const top = H[0], last = H.pop();
    if (H.length) {
      let i = 0; const n = H.length;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && H[c + 1][0] < H[c][0]) c++;
        if (H[c][0] >= last[0]) break;
        H[i] = H[c]; i = c;
      }
      H[i] = last;
    }
    return top;
  };
  const edgeLen2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  const addEdge = (a, b) => {
    const ca = qerr(a, b, b), cb = qerr(a, b, a);
    // curvature guard: collapsing across a bend (a hem, a cuff, the nose) costs extra, so creases
    // stay clean lines instead of zig-zags; also keeps triangles evenly sized
    const L2 = edgeLen2(a, b);
    const nd = 1 - (nor[a * 3] * nor[b * 3] + nor[a * 3 + 1] * nor[b * 3 + 1] + nor[a * 3 + 2] * nor[b * 3 + 2]);
    const tiny = L2 * L2 * (1e-3 + 30 * nd * nd + 2 * nd);
    if (ca <= cb) push([ca + tiny, a, b, ver[a], ver[b]]); else push([cb + tiny, b, a, ver[b], ver[a]]);
  };
  const neigh = (v, out) => {
    out.clear();
    for (const f of vf[v]) if (fAlive[f]) for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v) out.add(w); }
    return out;
  };
  const NA = new Set(), NB = new Set();
  for (let v = 0; v < nv; v++) { neigh(v, NA); for (const w of NA) if (w > v) addEdge(v, w); }
  const fn = (f, out) => {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    out[0] = uy * wz - uz * wy; out[1] = uz * wx - ux * wz; out[2] = ux * wy - uy * wx;
    return out;
  };
  const n0 = [0, 0, 0], n1 = [0, 0, 0];
  while (live > targetTris && H.length) {
    const [, u, v, vu, vv] = pop();
    if (ver[u] !== vu || ver[v] !== vv || ver[u] < 0 || ver[v] < 0) continue;
    // link condition: exactly two shared neighbours
    neigh(u, NA); neigh(v, NB);
    if (!NA.has(v)) continue;
    let common = 0;
    for (const w of NA) if (NB.has(w)) common++;
    if (common !== 2) continue;
    // flip / orientation test on faces that keep existing
    let ok = true;
    for (const f of vf[u]) {
      if (!fAlive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === v || b === v || c === v) continue;
      fn(f, n0);
      const k = a === u ? 0 : b === u ? 1 : 2;
      F[f * 3 + k] = v;
      fn(f, n1);
      F[f * 3 + k] = u;
      const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
      if (l1 < 1e-12 || n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0.35 * l0 * l1) { ok = false; break; }
      // stay consistent with the smooth surface normals
      const sx = nor[a * 3] + nor[b * 3] + nor[c * 3] - nor[u * 3] + nor[v * 3];
      const sy = nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1] - nor[u * 3 + 1] + nor[v * 3 + 1];
      const sz = nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2] - nor[u * 3 + 2] + nor[v * 3 + 2];
      if (n1[0] * sx + n1[1] * sy + n1[2] * sz < 0.5 * l1 * Math.hypot(sx, sy, sz)) { ok = false; break; }
    }
    if (!ok) continue;
    // collapse u → v
    for (const f of vf[u]) {
      if (!fAlive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === v || b === v || c === v) { fAlive[f] = 0; live--; continue; }
      const k = a === u ? 0 : b === u ? 1 : 2;
      F[f * 3 + k] = v;
      vf[v].push(f);
    }
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    ver[u] = -1;
    ver[v]++;
    vf[v] = vf[v].filter((f) => fAlive[f]);
    neigh(v, NB);
    for (const w of NB) { ver[w]++; }
    for (const w of NB) { neigh(w, NA); for (const x of NA) addEdge(w, x); }
  }
  // compact
  const remap = new Int32Array(nv).fill(-1);
  const P = [], N = [], I = [];
  for (let f = 0; f < nf; f++) {
    if (!fAlive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = P.length / 3;
        P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        N.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
      }
      I.push(remap[v]);
    }
  }
  return { pos: new Float32Array(P), nor: new Float32Array(N), idx: new Uint32Array(I) };
}
