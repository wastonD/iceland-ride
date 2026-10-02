// Pure road geometry (no DOM): asphalt strip, pad, town street, markings and roadside
// furniture placements. Importable from node for numeric verification.
import * as THREE from 'three';
import { MeshBuilder, lin } from './builder.js';
import { clamp, smoothstep, mulberry32 } from '../../../core/noise.js';
import { SIGN_ATLAS, SIGN_DEFS } from './signLayout.js';

export const CROWN = 0.03;          // centre-line rise over the edges (m)
export const SKIRT_OUT = 0.55;      // asphalt edge bevel width
export const TEX_W = 8.6;           // metres of road covered by the asphalt texture across
export const TEX_V = 8;             // metres along
export const MARK_LIFT = 0.012;     // marking height above asphalt

export const camber = (lat, w) => {
  const k = clamp(Math.abs(lat) / (w / 2), 0, 1);
  return CROWN * (1 - k * k);
};

/* ------------------------------------------------------------------ frames */
/** Per-point frame: position, horizontal unit tangent, right vector, signed curvature (+ = turning right). */
export function computeFrames(points, k = 3) {
  const n = points.length, F = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - k)], b = points[Math.min(n - 1, i + k)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    F[i] = { x: points[i].x, y: points[i].y, z: points[i].z, tx, tz, rx: -tz, rz: tx, s: i, kappa: 0 };
  }
  const K = 5;
  for (let i = 0; i < n; i++) {
    const a = F[Math.max(0, i - K)], b = F[Math.min(n - 1, i + K)];
    const span = Math.max(1, Math.min(n - 1, i + K) - Math.max(0, i - K));
    // sin(angle) between tangents, positive when b turns to the right of a
    F[i].kappa = (b.tx * a.rx + b.tz * a.rz) / span;
  }
  return F;
}

/* -------------------------------------------------------------- strip acc */
export class StripAcc {
  constructor() { this.pos = []; this.uv = []; this.idx = []; this.base = 0; }
  /** rows: array of arrays of {x,y,z,u,v}; cols ascend left->right, rows ascend forward. */
  add(rows) {
    const nc = rows[0].length, nr = rows.length;
    for (const r of rows) for (const p of r) { this.pos.push(p.x, p.y, p.z); this.uv.push(p.u, p.v); }
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc - 1; j++) {
      const a = this.base + i * nc + j, b = a + 1, c = a + nc, d = c + 1;
      this.idx.push(a, b, c, b, d, c);
    }
    this.base += nr * nc;
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(new THREE.Uint32BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Asphalt cross-section for one frame -> row of vertices. */
function asphaltRow(world, f, w, v, extra = 0) {
  const h = w / 2;
  const lats = [-h - SKIRT_OUT, -h, -h * 0.667, -h * 0.333, 0, h * 0.333, h * 0.667, h, h + SKIRT_OUT];
  return lats.map((lat, j) => {
    const x = f.x + f.rx * lat, z = f.z + f.rz * lat;
    let y = f.y + extra + camber(lat, w);
    if (j === 0 || j === lats.length - 1) {
      const th = world.heightAt(x, z);
      y = clamp(th - 0.05, f.y - 0.8, f.y - 0.08);
    }
    return { x, y, z, u: lat / TEX_W + 0.5, v };
  });
}

/* ------------------------------------------------------- centre-line curves */
/** Resample a Catmull-Rom polyline (xz) to ~step spacing -> frames (y from fn). */
export function polylineFrames(xz, step, yFn, closed = false) {
  const curve = new THREE.CatmullRomCurve3(xz.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'centripetal');
  const len = curve.getLength();
  const n = Math.max(2, Math.round(len / step));
  const pts = curve.getSpacedPoints(n);
  const F = computeFrames(pts.map((p) => ({ x: p.x, y: 0, z: p.z })), 1);
  for (let i = 0; i < F.length; i++) { F[i].y = yFn(F[i].x, F[i].z, i * (len / n)); F[i].s = i * (len / n); }
  F.length_m = len;
  return F;
}

/* ---------------------------------------------------------------- the road */
export const PAD = { s0: 6, s1: 64, side: 1, taper: 9 };

export function buildRoad(world) {
  const path = world.path, W = path.width;
  const F = computeFrames(path.points, 2);
  const acc = new StripAcc();

  // 1. main asphalt ribbon
  const rows = F.map((f, i) => asphaltRow(world, f, W, i / TEX_V));
  acc.add(rows);

  // 2. viewpoint pad (right side of travel at the very start)
  const padRows = [];
  const PL = [3.6, 4.6, 6.3, 8.0, 9.4, 9.95];
  for (let i = Math.floor(PAD.s0); i <= Math.ceil(PAD.s1); i++) {
    const f = F[i];
    const t = Math.max(0.04, smoothstep(PAD.s0, PAD.s0 + PAD.taper, i) * smoothstep(PAD.s1, PAD.s1 - PAD.taper, i));
    padRows.push(PL.map((L, j) => {
      const lat = PAD.side * (PL[0] + (L - PL[0]) * t);
      const x = f.x + f.rx * lat, z = f.z + f.rz * lat, dl = Math.abs(lat) - PL[0];
      let y = f.y + camber(PL[0], W) + 0.004 - dl * 0.014;
      if (j >= 2 && j < PL.length - 1) y = Math.max(y, world.heightAt(x, z) + 0.03);
      if (j === PL.length - 1) y = clamp(world.heightAt(x, z) - 0.05, f.y - 0.9, f.y - 0.1);
      return { x, y, z, u: lat / TEX_W + 0.5, v: i / TEX_V };
    }));
  }
  if (PAD.side > 0) acc.add(padRows);
  else acc.add(padRows.map((r) => r.slice().reverse()));

  return { F, acc, W, rows };
}

/** Town street strip that continues the road end into the village. */
export function buildStreet(world, acc, xz, width, startFrame, blendLen = 16, lift = 0) {
  const y0 = startFrame ? startFrame.y : 0;
  const F = polylineFrames(xz, 1.5, () => 0);
  // level = highest terrain across the street + a few cm, blended from the road-end level
  const raw = F.map((f) => {
    let m = -1e9;
    for (const l of [-width / 2, 0, width / 2]) m = Math.max(m, world.heightAt(f.x + f.rx * l, f.z + f.rz * l));
    return m + 0.05;
  });
  const sm = raw.map((_, i) => {
    let a = 0, c = 0;
    for (let k = -4; k <= 4; k++) { const j = clamp(i + k, 0, raw.length - 1); a += raw[j]; c++; }
    return Math.max(a / c, raw[i]);
  });
  F.forEach((f, i) => { const k = startFrame ? smoothstep(0, blendLen, f.s) : 1; f.y = y0 * (1 - k) + sm[i] * k + lift; });
  const rows = F.map((f) => {
    const wk = startFrame ? width + (7.5 - width) * (1 - smoothstep(0, 14, f.s)) : width;
    return asphaltRow(world, f, wk, f.s / TEX_V);
  });
  acc.add(rows);
  return F;
}

/* ------------------------------------------------------------- markings */
export function buildMarkings(world, F, W) {
  const mb = new MeshBuilder();
  const yel = lin('#e9b923'), wht = lin('#e4e3dc');
  const up = [0, 1, 0];
  const at = (i, lat, lift = MARK_LIFT) => {
    const f = F[i];
    return [f.x + f.rx * lat, f.y + camber(lat, W) + lift, f.z + f.rz * lat];
  };
  const strip = (i0, i1, l0, l1, color, uOff) => {
    for (let i = i0; i < i1; i++) {
      mb.quadU(at(i, l0), at(i, l1), at(i + 1, l1), at(i + 1, l0), up, { color, su: 0.5, sv: 1 / 5, u0: uOff, v0: i / 5 });
    }
  };
  const n = F.length;
  // centre line: 3 m dash / 9 m gap, solid through tight bends
  let rSmall = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Math.abs(F[i].kappa) > 1 / 60) rSmall[i] = 1;
  for (let i = 0; i < n; i++) { // dilate 12 m
    if (rSmall[i] === 1) for (let k = -12; k <= 12; k++) { const j = i + k; if (j >= 0 && j < n && !rSmall[j]) rSmall[j] = 2; }
  }
  for (let i = 4; i < n - 5; i++) {
    if (rSmall[i] > 0) { // no-passing double line through tight bends
      strip(i, i + 1, -0.19, -0.07, yel, 0.3);
      strip(i, i + 1, 0.07, 0.19, yel, 0.5);
    } else if ((i % 12) < 3) strip(i, i + 1, -0.07, 0.07, yel, 0.1);
  }
  // edge lines
  const e = W / 2 - 0.32;
  for (let side of [-1, 1]) {
    let i0 = 2, i1 = n - 3;
    if (side === PAD.side) {
      strip(i0, Math.floor(PAD.s0 + 4), side * (e - 0.08), side * (e + 0.08), wht, 0.7);
      strip(Math.ceil(PAD.s1 - 4), i1, side * (e - 0.08), side * (e + 0.08), wht, 0.7);
    } else strip(i0, i1, side * (e - 0.08), side * (e + 0.08), wht, side * 0.3 + 0.9);
  }
  // parking bay lines on the pad (perpendicular ticks)
  for (let i = Math.ceil(PAD.s0 + PAD.taper + 3); i < PAD.s1 - PAD.taper - 3; i += 4) {
    const l0 = PAD.side * 4.5, l1 = PAD.side * 8.6, a = at(i, l0, 0.02), b = at(i, l1, 0.02);
    const f = F[i], dx = f.tx * 0.06, dz = f.tz * 0.06;
    mb.quadU([a[0] - dx, a[1], a[2] - dz], [b[0] - dx, b[1], b[2] - dz], [b[0] + dx, b[1], b[2] + dz], [a[0] + dx, a[1], a[2] + dz], up, { color: wht, su: 0.25, sv: 1, u0: i * 0.13, v0: 0.4 });
  }
  return mb.toGeometry();
}

/* --------------------------------------------------------- roadside kit */
/** Sections needing a guard rail: sharp bends with a steep drop-off on the outer side. */
export function guardrailPlan(world, F, W) {
  const n = F.length, side = new Int8Array(n);
  const drop = (f, lat) => f.y - world.heightAt(f.x + f.rx * lat, f.z + f.rz * lat);
  for (let i = 0; i < n; i++) {
    if (world.path.isBridge?.(i) || world.path.isTunnel?.(i)) continue;      // bridge / tunnel carry their own parapets
    const f = F[i], dl = drop(f, -11), dr = drop(f, 11);
    const d = Math.max(dl, dr), sd = dr >= dl ? 1 : -1;
    const bend = Math.abs(f.kappa) > 1 / 110;
    if ((bend && d > 3.5) || d > 14) side[i] = sd;
  }
  // dilate along s while keeping the side, then close gaps < 12 m
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) if (side[i]) for (let k = -14; k <= 14; k++) { const j = i + k; if (j >= 0 && j < n && !out[j]) out[j] = side[i]; }
  // groups
  const groups = [];
  let i = 0;
  while (i < n) {
    if (!out[i]) { i++; continue; }
    let j = i; while (j + 1 < n && out[j + 1] === out[i]) j++;
    if (j - i >= 18) groups.push({ i0: i, i1: j, side: out[i] });
    i = j + 1;
  }
  return groups;
}

export function railSegments(F, groups, W, offset = 0.8) {
  const segs = [];
  for (const g of groups) {
    const lat = g.side * (W / 2 + offset);
    const pt = (s) => {
      const i = Math.min(F.length - 2, Math.floor(s)), t = s - i, a = F[i], b = F[i + 1];
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      const rx = a.rx + (b.rx - a.rx) * t, rz = a.rz + (b.rz - a.rz) * t, rl = Math.hypot(rx, rz);
      return [x + (rx / rl) * lat, y - 0.3, z + (rz / rl) * lat];
    };
    let s = g.i0, last = pt(s), segStart = last, acc = 0, first = true;
    while (s < g.i1 - 0.2) {
      s += 0.25;
      const q = pt(s);
      acc += Math.hypot(q[0] - last[0], q[2] - last[2]);
      last = q;
      if (acc >= 4.0 || s >= g.i1 - 0.2) {
        segs.push({ a: segStart, b: q, first, last: s >= g.i1 - 0.2 });
        segStart = q; acc = 0; first = false;
      }
    }
  }
  return { segs };
}

/** Delineator post positions: every 50 m, both sides, skipping rail-covered stretches. */
export function delineatorPlan(world, F, W, groups) {
  const out = [];
  const covered = (i, sd) => groups.some((g) => g.side === sd && i >= g.i0 - 4 && i <= g.i1 + 4);
  for (let s = 50; s < F.length - 30; s += 50) {
    const f = F[s];
    for (const sd of [-1, 1]) {
      if (covered(s, sd) || world.path.isBridge?.(s) || world.path.isTunnel?.(s)) continue;
      if (sd === PAD.side && s > PAD.s0 - 3 && s < PAD.s1 + 3) continue;
      const lat = sd * (W / 2 + 1.15);
      const x = f.x + f.rx * lat, z = f.z + f.rz * lat;
      out.push({ x, z, y: Math.min(f.y - 0.05, world.heightAt(x, z)), s, side: sd });
    }
  }
  return out;
}

/** Sign placements along the road. `km` = distance to the village at that s (for text). */
export function signPlan(world, F, W) {
  const L = F.length - 1;
  const firstBend = F.findIndex((f, i) => i > 200 && Math.abs(f.kappa) > 1 / 40);
  const list = [
    { key: 'place', s: 210, side: 1 },
    { key: 'view', s: 16, side: PAD.side, pad: true },
    { key: 'hill', s: Math.max(120, firstBend - 90), side: -1 },
    { key: 'placeEnd', s: L - 430, side: 1 },
  ];
  // yellow sharp-bend advisory 70 m before every bend tighter than R = 40 m (outer side of the bend)
  for (const c of curvePlan(F)) list.push({ key: c.dir > 0 ? 'warnR' : 'warnL', s: Math.max(6, c.s0 - 70), side: c.dir > 0 ? -1 : 1, curve: c });
  const tn = world.path.tunnels?.[0];
  if (tn) list.push({ key: 'tunnel', s: Math.max(6, tn.s0 - 85), side: 1 });
  return list.map((d) => {
    const f = F[Math.round(d.s)];
    const lat = d.side * (W / 2 + (d.pad ? 3.4 : 2.6));
    const x = f.x + f.rx * lat, z = f.z + f.rz * lat;
    return { ...d, x, z, ground: world.heightAt(x, z), f, km: Math.max(0, (L - d.s) / 1000) };
  });
}

/** Bends tighter than R = 40 m (horizontal radius): merged runs [{s0, s1, minR, dir}] (dir +1 = right turn). */
export function curvePlan(F, R0 = 40, mergeGap = 40) {
  const out = []; let cur = null;
  for (let i = 8; i < F.length - 8; i++) {
    const a = F[i - 8], b = F[i], c = F[i + 8];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    const R = (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(c.x - a.x, c.z - a.z)) / (2 * Math.abs(cr) + 1e-9);
    if (R < R0) {
      if (!cur || i - cur.s1 > mergeGap) { cur = { s0: i, s1: i, minR: R, dir: Math.sign(cr) }; out.push(cur); }
      else { cur.s1 = i; if (R < cur.minR) { cur.minR = R; cur.dir = Math.sign(cr); } }
    }
  }
  return out;
}

/** Panel geometry with atlas UVs. */
export function buildSignPanels(signs) {
  const mb = new MeshBuilder();
  const { w: AW, h: AH } = SIGN_ATLAS;
  const poles = [];
  for (const s of signs) {
    const def = SIGN_DEFS[s.key];
    const [rx0, ry0, rw, rh] = def.rect, [sw, sh] = def.size;
    const u0 = rx0 / AW, u1 = (rx0 + rw) / AW, v1 = 1 - ry0 / AH, v0 = 1 - (ry0 + rh) / AH;
    const f = s.f;
    const bottom = s.ground + 1.75, cy = bottom + sh / 2;
    const cx = s.x, cz = s.z;
    const r = [f.rx, 0, f.rz];
    const P = (dx, dy) => [cx + r[0] * dx, cy + dy, cz + r[2] * dx];
    mb.quadU(P(-sw / 2, -sh / 2), P(sw / 2, -sh / 2), P(sw / 2, sh / 2), P(-sw / 2, sh / 2), [-f.tx, 0, -f.tz], {
      uvs: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
    });
    // matching back face (grey) so the panel is not see-through from behind
    const bk = [0.55, 0.57, 0.6];
    mb.quadU(P(sw / 2, -sh / 2), P(-sw / 2, -sh / 2), P(-sw / 2, sh / 2), P(sw / 2, sh / 2), [f.tx, 0, f.tz], {
      uvs: [[0.99, 0.01], [0.99, 0.01], [0.99, 0.01], [0.99, 0.01]], color: bk,
    });
    poles.push({ x: cx + f.tx * 0.07, z: cz + f.tz * 0.07, y: s.ground - 0.15, h: bottom - s.ground + 0.15 + sh * (def.kind === 'hill' || def.kind === 'bend' || def.kind === 'warn' ? 0.5 : 0.85) });
  }
  return { geometry: mb.toGeometry(), poles };
}

/* -------------------------------------------------- reusable small geometry */
/** Delineator post: white body + reflective yellow head with black band (vertex-coloured). */
export function delineatorGeometry() {
  const mb = new MeshBuilder();
  const white = lin('#eeeeea'), yel = lin('#f2c118'), blk = lin('#1a1a1a');
  mb.cylinder(0, 0, -0.15, 0.82, 0.045, 6, { color: white, cap: false });
  mb.cylinder(0, 0, 0.82, 0.90, 0.048, 6, { color: blk, cap: false });
  mb.cylinder(0, 0, 0.90, 1.12, 0.050, 6, { color: yel });
  return mb.toGeometry();
}

/** W-beam rail, 1 m along +z, centred at y = 0.6 (ground at y = 0). Symmetric profile. */
export function railBeamGeometry() {
  const mb = new MeshBuilder();
  const c = lin('#b9bcc0');
  const N = 14, lo = 0.45, hi = 0.755;
  const prof = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    prof.push([0.038 * (1 - Math.cos(t * Math.PI * 4)) * 0.5, lo + (hi - lo) * t]);
  }
  for (let i = 0; i < N; i++) {
    const [x0, y0] = prof[i], [x1, y1] = prof[i + 1];
    // facing +x-ish; material is DoubleSide
    mb.quadU([x0, y0, 0], [x0, y0, 1], [x1, y1, 1], [x1, y1, 0], [1, 0, 0], { color: c, su: 1, sv: 1 });
  }
  return mb.toGeometry();
}
export function railPostGeometry() {
  const mb = new MeshBuilder();
  const c = lin('#8b8f94');
  mb.box(-0.035, -0.45, -0.045, 0.035, 0.74, 0.045, { color: c });
  return mb.toGeometry();
}
