// The rider: a stylised ~1.78 m adult modelled as signed-distance shapes (smooth unions →
// no seams, no facets) and meshed with surface nets into ONE skinned BufferGeometry.
// Garments are separate closed pieces that overlap like real clothing (sleeve cuff over
// the glove, jacket hem over the trousers, beanie over the head), which gives crisp,
// natural colour boundaries.
//
// Bind pose: standing, facing +Z, left = +X, arms in a relaxed A-pose (ARM_A from vertical),
// legs ARM_B apart. Bones keep the old names/offsets (pose/IK code is unchanged); the arm
// and leg bones are bound rotated (see BIND_ROT) so the skin deforms well both with arms
// hanging and spread wide.
//
// Per-vertex attributes: position, normal, color, skinIndex/Weight, aRough (roughness),
// aFP (1 = hidden in first-person view: head, beanie, hair, eyes, collar, backpack + straps).

import * as THREE from 'three';
import { smoothstep } from '../core/noise.js';
import { ellipsoid, cone, rbox, half, scaled, L, U, I, S, X, dist, makeAttrEval, meshSDF, simplify } from './sdf.js';
import { strap, roundBox } from './builders.js';

export const COLORS = {
  jacket: 0x33598a, collar: 0x2b4d78,
  pants: 0x7b735f,
  shoe: 0x3a3d43, sole: 0xe6e1d5,
  glove: 0x2b2d32,
  skin: 0xdfa886, hair: 0x4a3426, eye: 0x1c1614,
  beanie: 0xcb6532, beanieCuff: 0xc05e2e,
  pack: 0x3c4945, packLid: 0x4a5853, strap: 0x25282c,
};

// [name, parent, restOffset]
export const BONES = [
  ['pelvis', null, [0, 0.94, 0]],
  ['spine', 'pelvis', [0, 0.12, 0]],
  ['chest', 'spine', [0, 0.20, 0]],
  ['neck', 'chest', [0, 0.24, 0]],
  ['head', 'neck', [0, 0.06, 0]],
  ['hood', 'chest', [0, 0.14, -0.09]],
  ['pack', 'chest', [0, 0.19, -0.13]],
  ['hem', 'pelvis', [0, -0.06, 0]],
  ['armL', 'chest', [0.19, 0.17, 0]], ['foreL', 'armL', [0, -0.30, 0]], ['handL', 'foreL', [0, -0.26, 0]],
  ['armR', 'chest', [-0.19, 0.17, 0]], ['foreR', 'armR', [0, -0.30, 0]], ['handR', 'foreR', [0, -0.26, 0]],
  ['thighL', 'pelvis', [0.09, 0, 0]], ['shinL', 'thighL', [0, -0.44, 0]], ['footL', 'shinL', [0, -0.42, 0]],
  ['thighR', 'pelvis', [-0.09, 0, 0]], ['shinR', 'thighR', [0, -0.44, 0]], ['footR', 'shinR', [0, -0.42, 0]],
];

export const LEN = { thigh: 0.44, shin: 0.42, upper: 0.30, fore: 0.26 };

const ARM_A = 0.62;   // bind abduction of the arms (rad)
const LEG_B = 0.06;   // bind abduction of the legs
/** Bind rotation (about +Z) of limb roots; children inherit it. */
export const BIND_ROT = { armL: ARM_A, armR: -ARM_A, thighL: LEG_B, thighR: -LEG_B };
/** Eye mid-point in head-bone space (for a first-person camera). */
export const EYE_OFFSET = [0, 0.088, 0.088];

const SH = { L: [0.19, 1.43, 0], R: [-0.19, 1.43, 0] };
const HIP = { L: [0.09, 0.94, 0], R: [-0.09, 0.94, 0] };
const ZA = [0, 0, 1];

/** Weights down a chain of bones along local y: [[bone, yCentre, halfWidth], ...] top→bottom. */
function chainY(base, blends) {
  return (x, y) => {
    const list = [[base, 1]];
    for (const [bone, yc, r] of blends) {
      const t = smoothstep(yc + r, yc - r, y);
      if (t <= 0) break;
      for (const e of list) e[1] *= 1 - t;
      list.push([bone, t]);
    }
    return list;
  };
}

const hex = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };

// ---- garment models (rest pose) ---------------------------------------------------------
const CLOTH = 0.9;

function jacketNode() {
  const at = { col: COLORS.jacket, rough: CLOTH, skin: chainY('chest', [['spine', 1.17, 0.08], ['pelvis', 1.02, 0.07], ['hem', 0.905, 0.05]]) };
  const torso = U(0.085,
    L(ellipsoid(0, 1.315, -0.008, 0.176, 0.165, 0.114), at),
    L(ellipsoid(0, 1.10, 0.004, 0.162, 0.18, 0.106), at),
    L(scaled(cone(0, 0.87, 0.0, 0, 1.0, 0.0, 0.18, 0.168), 0, 0.9, 0, 1, 1, 0.7), at),
  );
  const yoke = [];
  for (const s of [1, -1]) {
    yoke.push(L(cone(s * 0.04, 1.455, -0.012, s * 0.18, 1.432, -0.006, 0.07, 0.066), { ...at, skin: 'chest' }));
  }
  const body = I(0.03, U(0.06, torso, ...yoke), L(half(0, -1, 0, -0.835), at));
  const sleeves = [];
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const x = s * 0.19;
    const sat = { col: COLORS.jacket, rough: CLOTH, skin: chainY('chest', [['arm' + side, 1.425, 0.05], ['fore' + side, 1.13, 0.05], ['hand' + side, 0.86, 0.01]]) };
    const sleeve = I(0.018,
      U(0.03,
        L(cone(x, 1.43, 0, x, 1.13, 0.004, 0.064, 0.054), sat),
        L(cone(x, 1.13, 0.004, x, 0.895, 0.006, 0.054, 0.05), sat),
      ),
      L(half(0, -1, 0, -0.884), sat));
    sleeves.push(X(SH[side], ZA, BIND_ROT['arm' + side], sleeve));
  }
  return U(0.028, body, ...sleeves);
}

function collarNode() {
  const at = { col: COLORS.collar, rough: CLOTH, fp: 1, skin: chainY('chest', [['neck', 1.53, 0.03]]) };
  const collar = S(0.012,
    I(0.012, L(cone(0, 1.44, -0.014, 0, 1.53, -0.006, 0.094, 0.08), at), L(half(0, 1, 0.16, 1.54), at)),
    L(cone(0, 1.47, -0.004, 0, 1.70, 0, 0.056, 0.056), at));
  const hood = L(ellipsoid(0, 1.488, -0.09, 0.104, 0.05, 0.06), { ...at, skin: 'hood' });
  return U(0.03, collar, hood);
}

function pantsNode() {
  const at = { col: COLORS.pants, rough: CLOTH, skin: 'pelvis' };
  const pelvis = L(ellipsoid(0, 0.915, 0.0, 0.152, 0.12, 0.097), at);   // closed top (hidden under the jacket)
  const legs = [];
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const x = s * 0.09;
    const lat = { col: COLORS.pants, rough: CLOTH, skin: chainY('pelvis', [['thigh' + side, 0.80, 0.07], ['shin' + side, 0.50, 0.07], ['foot' + side, 0.09, 0.02]]) };
    const leg = I(0.02,
      U(0.04,
        L(cone(x, 0.90, 0.0, x, 0.50, 0.008, 0.08, 0.064), lat),
        L(cone(x, 0.50, 0.008, x, 0.145, 0.0, 0.064, 0.058), lat),
      ),
      L(half(0, -1, 0, -0.112), lat));
    legs.push(X(HIP[side], ZA, BIND_ROT['thigh' + side], leg));
  }
  return U(0.05, pelvis, ...legs);
}

function shoeNodes(side) {
  const s = side === 'L' ? 1 : -1;
  const x = s * 0.09;
  const at = { col: COLORS.shoe, rough: 0.72, skin: chainY('foot' + side, [['shin' + side, 0.13, 0.025]]) };
  // sneaker upper: heel + toe box + ankle collar, clipped above the sole
  const upper = I(0.008,
    U(0.04,
      L(ellipsoid(x, 0.058, -0.036, 0.046, 0.05, 0.058), at),
      L(ellipsoid(x, 0.044, 0.105, 0.051, 0.04, 0.096), at),
      L(cone(x, 0.06, -0.024, x, 0.125, -0.016, 0.051, 0.049), at),
    ),
    L(half(0, -1, 0, -0.016), at));
  const sat = { col: COLORS.sole, rough: 0.85, skin: 'foot' + side };
  const sole = I(0.007,
    U(0.05,
      L(ellipsoid(x, 0.02, -0.035, 0.05, 0.04, 0.072), sat),
      L(ellipsoid(x, 0.02, 0.112, 0.056, 0.04, 0.104), sat),
    ),
    I(0.007, L(half(0, -1, 0, 0), sat), L(half(0, 1, 0, 0.03), sat)));
  const rot = (n) => X(HIP[side], ZA, BIND_ROT['thigh' + side], n);
  return { upper: rot(upper), sole: rot(sole) };
}

function handNode(side) {
  const s = side === 'L' ? 1 : -1;
  const x = s * 0.19;
  const at = { col: COLORS.glove, rough: 0.62, skin: 'hand' + side };
  const hand = U(0.03,
    L(cone(x, 0.905, 0.0, x, 0.86, 0.004, 0.033, 0.035), { ...at, skin: chainY('fore' + side, [['hand' + side, 0.875, 0.02]]) }),
    L(ellipsoid(x, 0.822, 0.006, 0.034, 0.05, 0.041), at),
    L(ellipsoid(x - s * 0.002, 0.795, 0.012, 0.032, 0.026, 0.038), at),
    L(cone(x - s * 0.018, 0.846, 0.028, x - s * 0.016, 0.818, 0.04, 0.014, 0.0125), at),
  );
  return X(SH[side], ZA, BIND_ROT['arm' + side], hand);
}

function headNode() {
  const at = { col: COLORS.skin, rough: 0.55, fp: 1, skin: 'head' };
  const neck = L(cone(0, 1.46, -0.014, 0, 1.585, 0.0, 0.05, 0.047), { ...at, skin: chainY('chest', [['neck', 1.50, 0.03], ['head', 1.565, 0.03]]) });
  const head = U(0.045,
    L(ellipsoid(0, 1.668, -0.004, 0.094, 0.106, 0.103), at),
    L(ellipsoid(0, 1.613, 0.024, 0.077, 0.068, 0.079), at),
  );
  const nose = L(ellipsoid(0, 1.63, 0.099, 0.0145, 0.018, 0.017), at);
  const ears = [1, -1].map((s) => L(ellipsoid(s * 0.091, 1.645, -0.006, 0.014, 0.025, 0.019), at));
  // the crown is hidden under the beanie: clip it away to save triangles
  return I(0.01, U(0.03, U(0.016, U(0.022, head, nose), ...ears), neck), L(half(0, 1, 0, 1.735), at));
}

const BEANIE_EDGE = (y, z) => y - 1.67 - 0.11 * z;   // >0 above the beanie's lower edge
function beanieNode() {
  const at = { col: COLORS.beanie, rough: 0.95, fp: 1, skin: 'head' };
  const cat = { ...at, col: COLORS.beanieCuff };
  const crown = U(0.05,
    L(ellipsoid(0, 1.676, -0.008, 0.103, 0.112, 0.112), at),
    L(ellipsoid(0, 1.752, -0.028, 0.068, 0.045, 0.07), at),
  );
  const dome = I(0.008, crown, L(half(0, -1, 0.11, -1.70), at));
  const cuffBody = L(ellipsoid(0, 1.676, -0.008, 0.111, 0.118, 0.12), cat);
  const cuff = I(0.008, I(0.008, cuffBody, L(half(0, -1, 0.11, -1.672), cat)), L(half(0, 1, -0.11, 1.712), cat));
  return U(0.006, dome, cuff);
}

function hairNode() {
  const at = { col: COLORS.hair, rough: 0.75, fp: 1, skin: 'head' };
  const cap = L(ellipsoid(0, 1.652, -0.012, 0.0985, 0.09, 0.106), at);
  return I(0.012, I(0.014, cap, L(half(0, 0.5, 1, -0.05 + 0.5 * 1.62), at)), L(half(0, -1, 0, -1.578), at));
}

const PZ = -0.188;
function packNode() {
  const at = { col: COLORS.pack, rough: 0.82, fp: 1, skin: 'pack' };
  return U(0.03,
    L(rbox(0, 1.255, PZ, 0.128, 0.155, 0.058, 0.05), at),
    L(ellipsoid(0, 1.19, PZ - 0.055, 0.092, 0.085, 0.022), at),
  );
}
function lidNode() {
  const at = { col: COLORS.packLid, rough: 0.82, fp: 1, skin: 'pack' };
  return I(0.01, L(rbox(0, 1.39, PZ - 0.002, 0.134, 0.035, 0.064, 0.034), at), L(half(0, -1, 0, -1.37), at));
}

// ---- merge ------------------------------------------------------------------------------
class Merger {
  constructor(nb) {
    this.nb = nb;
    this.pos = []; this.nor = []; this.col = []; this.si = []; this.sw = []; this.rough = []; this.fp = []; this.idx = [];
    this.count = 0;
  }
  /** m = {pos, nor, idx}; attrAt(x,y,z) → Float32Array [w..., r,g,b, rough, fp] */
  add(m, attrAt) {
    const nb = this.nb, base = this.count, nv = m.pos.length / 3;
    for (let i = 0; i < nv; i++) {
      const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
      this.pos.push(x, y, z);
      this.nor.push(m.nor[i * 3], m.nor[i * 3 + 1], m.nor[i * 3 + 2]);
      const a = attrAt(x, y, z);
      const ws = [];
      for (let b = 0; b < nb; b++) if (a[b] > 1e-4) ws.push([b, a[b]]);
      ws.sort((p, q) => q[1] - p[1]);
      ws.length = Math.min(ws.length, 4);
      let sum = 0;
      for (const w of ws) sum += w[1];
      for (let k = 0; k < 4; k++) {
        if (ws[k]) { this.si.push(ws[k][0]); this.sw.push(ws[k][1] / sum); } else { this.si.push(0); this.sw.push(0); }
      }
      this.col.push(a[nb], a[nb + 1], a[nb + 2]);
      this.rough.push(a[nb + 3]);
      this.fp.push(a[nb + 4] > 0.5 ? 1 : 0);
    }
    for (let i = 0; i < m.idx.length; i++) this.idx.push(m.idx[i] + base);
    this.count += nv;
  }
  /** Plain THREE geometry with constant attributes. */
  addGeo(g, bone, colHex, rough, fp, boneIndex) {
    const p = g.attributes.position, n = g.attributes.normal;
    const a = new Float32Array(this.nb + 5);
    a[boneIndex[bone]] = 1;
    const c = hex(colHex);
    a[this.nb] = c[0]; a[this.nb + 1] = c[1]; a[this.nb + 2] = c[2]; a[this.nb + 3] = rough; a[this.nb + 4] = fp;
    const idx = g.index ? Array.from(g.index.array) : Array.from({ length: p.count }, (_, i) => i);
    this.add({ pos: p.array, nor: n.array, idx }, () => a);
    g.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(this.rough, 1));
    g.setAttribute('aFP', new THREE.Float32BufferAttribute(this.fp, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Rotate a geometry about +Z through a pivot (bind A-pose for hand-held parts). */
function rotZ(g, pivot, a) {
  g.translate(-pivot[0], -pivot[1], -pivot[2]);
  g.rotateZ(a);
  g.translate(pivot[0], pivot[1], pivot[2]);
  return g;
}

// project a point onto a node's surface, pushed `off` outward
function onSurface(node, p, off) {
  let [x, y, z] = p;
  const e = 0.001;
  for (let it = 0; it < 8; it++) {
    const d = dist(node, x, y, z) - off;
    const gx = (dist(node, x + e, y, z) - dist(node, x - e, y, z)) / (2 * e);
    const gy = (dist(node, x, y + e, z) - dist(node, x, y - e, z)) / (2 * e);
    const gz = (dist(node, x, y, z + e) - dist(node, x, y, z - e)) / (2 * e);
    const gl = gx * gx + gy * gy + gz * gz || 1;
    x -= (d * gx) / gl; y -= (d * gy) / gl; z -= (d * gz) / gl;
    if (Math.abs(d) < 1e-5) break;
  }
  return [x, y, z];
}

export function buildBodyGeometry() {
  const boneIndex = {};
  BONES.forEach((b, i) => { boneIndex[b[0]] = i; });
  const nb = BONES.length;
  const { ev } = makeAttrEval(boneIndex, nb, hex);
  const M = new Merger(nb);
  const piece = (node, lo, hi, h, tris) => {
    const t0 = performance.now();
    const m0 = meshSDF(node, lo, hi, h);
    const t1 = performance.now();
    const m = simplify(m0, tris);
    const t2 = performance.now();
    M.add(m, (x, y, z) => ev(node, x, y, z).a);
    if (globalThis.__pieceLog) globalThis.__pieceLog.push([h, m0.idx.length / 3, m.idx.length / 3, (t1 - t0) | 0, (t2 - t1) | 0, (performance.now() - t2) | 0]);
    return m;
  };

  const jacket = jacketNode();
  piece(jacket, [-0.6, 0.8, -0.16], [0.6, 1.53, 0.14], 0.019, 3300);
  piece(collarNode(), [-0.12, 1.42, -0.16], [0.12, 1.56, 0.1], 0.0105, 900);
  piece(pantsNode(), [-0.26, 0.1, -0.13], [0.26, 1.05, 0.13], 0.018, 2500);
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const { upper, sole } = shoeNodes(side);
    const lo = [s > 0 ? 0.06 : -0.26, -0.005, -0.12], hi = [s > 0 ? 0.26 : -0.06, 0.18, 0.23];
    piece(upper, lo, hi, 0.0095, 1000);
    piece(sole, lo, [hi[0], 0.04, hi[2]], 0.0075, 650);
    const hlo = s > 0 ? [0.42, 0.8, -0.07] : [-0.67, 0.8, -0.07];
    const hhi = s > 0 ? [0.67, 1.06, 0.09] : [-0.42, 1.06, 0.09];
    piece(handNode(side), hlo, hhi, 0.0072, 750);
  }
  const head = headNode();
  piece(head, [-0.12, 1.45, -0.12], [0.12, 1.75, 0.13], 0.0085, 1800);
  piece(beanieNode(), [-0.13, 1.63, -0.14], [0.13, 1.81, 0.14], 0.0085, 1300);
  piece(hairNode(), [-0.11, 1.56, -0.13], [0.11, 1.70, 0.06], 0.009, 650);
  piece(packNode(), [-0.15, 1.08, -0.29], [0.15, 1.42, -0.13], 0.0135, 1000);
  piece(lidNode(), [-0.15, 1.35, -0.29], [0.15, 1.44, -0.12], 0.0095, 480);

  // eyes: tiny dark lenses set into the face
  for (const s of [1, -1]) {
    const [ex, ey, ez] = onSurface(head, [s * 0.034, 1.651, 0.12], -0.0015);
    const g = new THREE.SphereGeometry(1, 12, 8);
    g.deleteAttribute('uv');
    g.scale(0.0078, 0.0098, 0.0045);
    g.rotateY(s * 0.32);
    g.translate(ex, ey, ez);
    M.addGeo(g, 'head', COLORS.eye, 0.25, 1, boneIndex);
  }

  // throttle remote (pistol grip) in the right fist, built hanging then rotated into the bind A-pose
  {
    const cx = -0.19;
    const parts = [
      [roundBox(cx - 0.002, 0.808, 0.024, 0.03, 0.076, 0.032, { n: 3, inset: 0.86, M: 16 }), 0x33363c, 0.5],
      [roundBox(cx - 0.002, 0.861, 0.062, 0.036, 0.03, 0.118, { n: 3, inset: 0.86, M: 16 }), 0xb9bec6, 0.4],
      [roundBox(cx - 0.002, 0.879, 0.047, 0.012, 0.008, 0.026, { n: 3, inset: 0.8, M: 12 }), 0xd8732f, 0.5],
      [roundBox(cx - 0.002, 0.862, 0.122, 0.012, 0.012, 0.004, { n: 3, inset: 0.8, M: 12 }), 0x35d6ff, 0.3],
    ];
    for (const [g, c, r] of parts) { g.deleteAttribute('uv'); rotZ(g, SH.R, BIND_ROT.armR); M.addGeo(g, 'handR', c, r, 0, boneIndex); }
  }

  // backpack shoulder straps: flat webbing laid on the jacket surface
  for (const s of [1, -1]) {
    const raw = [
      [s * 0.105, 1.40, -0.17], [s * 0.112, 1.47, -0.11], [s * 0.118, 1.50, -0.03], [s * 0.115, 1.49, 0.04],
      [s * 0.112, 1.43, 0.10], [s * 0.115, 1.32, 0.112], [s * 0.128, 1.22, 0.1], [s * 0.15, 1.15, 0.07],
      [s * 0.168, 1.13, 0.0], [s * 0.15, 1.12, -0.13],
    ];
    const pts = raw.map((p, i) => (i === 0 || i === raw.length - 1 ? p : onSurface(jacket, p, 0.011)));
    const e = 0.001;
    const nfn = (p, o) => {
      const gx = dist(jacket, p.x + e, p.y, p.z) - dist(jacket, p.x - e, p.y, p.z);
      const gy = dist(jacket, p.x, p.y + e, p.z) - dist(jacket, p.x, p.y - e, p.z);
      const gz = dist(jacket, p.x, p.y, p.z + e) - dist(jacket, p.x, p.y, p.z - e);
      return o.set(gx, gy, gz).normalize();
    };
    const g = strap(pts, 0.04, 0.011, nfn, 30, 8);
    M.addGeo(g, 'chest', COLORS.strap, 0.7, 1, boneIndex);
  }

  return { geometry: M.build(), boneIndex };
}
