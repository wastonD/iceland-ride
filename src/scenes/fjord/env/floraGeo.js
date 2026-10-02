// Geometry builders for the fjord flora (all in metres, origin at the ground).

import * as THREE from 'three';
import { mulberry32, noise2 } from '../../../core/noise.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Tundra grass tuft: `blades` curved blades (3 tris each). color = multiplier on the terrain tint.
export function grassTuft({ blades = 7, height = 0.26, seed = 1 } = {}) {
  const rnd = mulberry32(seed);
  const pos = [], nrm = [], col = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2, r = rnd() * 0.06;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const hb = height * (0.55 + rnd() * 0.5), wb = 0.012 + rnd() * 0.012;
    const la = rnd() * Math.PI * 2, lean = (0.15 + rnd() * 0.45) * hb;
    const lx = Math.cos(la), lz = Math.sin(la);
    const px = -lz, pz = lx;                 // blade width direction
    const straw = rnd() < 0.1;
    const tipC = straw ? [1.25, 1.08, 1.0] : [0.95 + rnd() * 0.15, 1.05 + rnd() * 0.12, 0.8];
    const base = pos.length / 3;
    const rows = [[0, 1], [0.55, 0.75], [1, 0]];
    for (const [t, w] of rows) {
      const cx = bx + lx * lean * t * t, cy = hb * t, cz = bz + lz * lean * t * t;
      const ww = wb * w;
      const c = [0.7 + (tipC[0] - 0.7) * t, 0.7 + (tipC[1] - 0.7) * t, 0.7 + (tipC[2] - 0.7) * t];
      if (w > 0) {
        pos.push(cx - px * ww, cy, cz - pz * ww, cx + px * ww, cy, cz + pz * ww);
        col.push(...c, ...c);
      } else { pos.push(cx, cy, cz); col.push(...c); }
    }
    // normals: blade face normal bent strongly upward (soft, grass-like lighting)
    const fn = new THREE.Vector3(lx, 0.0, lz).normalize().multiplyScalar(0.45).add(new THREE.Vector3(0, 1, 0)).normalize();
    for (let k = 0; k < 5; k++) nrm.push(fn.x, fn.y, fn.z);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// Nootka lupine: stem, 4-sided flower spike (florets drawn in the fragment shader),
// palmate leaves. aLup = (part: 0 green / 1 spike, u around, v along spike).
export function lupinePlant({ seed = 3, leaves = 2, spikeSides = 4, spikeSegs = 2, stem = true } = {}) {
  const rnd = mulberry32(seed);
  const pos = [], nrm = [], col = [], lup = [], idx = [];
  const add = (p, n, c, l) => { pos.push(...p); nrm.push(...n); col.push(...c); lup.push(...l); return pos.length / 3 - 1; };
  const H0 = 0.40, H1 = 0.86, R0 = 0.05, R1 = 0.012;
  const leanX = (rnd() - 0.5) * 0.08, leanZ = (rnd() - 0.5) * 0.08;
  if (stem) {
    const r = 0.007, base = pos.length / 3;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      add([c * r, 0, s * r], [c, 0, s], [0.35, 0.5, 0.25], [0, 0, 0]);
      add([c * r + leanX * 0.5, H0 + 0.02, s * r + leanZ * 0.5], [c, 0, s], [0.45, 0.6, 0.3], [0, 0, 0]);
    }
    for (let k = 0; k < 3; k++) {
      const a = base + k * 2, b = base + ((k + 1) % 3) * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // spike
  {
    const base = pos.length / 3, S = spikeSides;
    for (let j = 0; j <= spikeSegs; j++) {
      const t = j / spikeSegs, y = H0 + (H1 - H0) * t, r = R0 + (R1 - R0) * Math.pow(t, 1.3);
      const ox = leanX * (0.5 + t), oz = leanZ * (0.5 + t);
      for (let k = 0; k <= S; k++) {
        const a = (k / S) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        add([ox + c * r, y, oz + s * r], [c * 0.8, 0.35, s * 0.8], [1, 1, 1], [1, k / S, t]);
      }
    }
    // tip
    const tip = add([leanX * 1.5, H1 + 0.04, leanZ * 1.5], [0, 1, 0], [1, 1, 1], [1, 0.5, 1]);
    for (let j = 0; j < spikeSegs; j++) for (let k = 0; k < S; k++) {
      const a = base + j * (S + 1) + k, b = a + 1, c = a + S + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const top = base + spikeSegs * (S + 1);
    for (let k = 0; k < S; k++) idx.push(top + k, tip, top + k + 1);
  }
  // palmate leaves: stars of leaflets forming a low mound around the stem
  for (let L = 0; L < leaves; L++) {
    const ring = L === 0 ? 0 : 0.05 + rnd() * 0.09, ra = rnd() * 6.28;
    const cx = Math.cos(ra) * ring, cz = Math.sin(ra) * ring;
    const y = 0.08 + rnd() * 0.24, n = 7, rot = rnd() * 6.28, len = 0.15 + rnd() * 0.09;
    const g0 = 0.8 + rnd() * 0.35;
    const c0 = add([cx, y + 0.012, cz], [0, 1, 0], [0.34 * g0, 0.5 * g0, 0.25 * g0], [0, 0, 0]);
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * Math.PI * 2, w = 0.17;
      const droop = -0.03 - rnd() * 0.04, nx = Math.cos(a) * 0.35, nz = Math.sin(a) * 0.35;
      const c = [0.3 * g0, 0.47 * g0, 0.22 * g0];
      const p1 = add([cx + Math.cos(a - w) * len, y + droop, cz + Math.sin(a - w) * len], [nx, 1, nz], c, [0, 0, 0]);
      const p2 = add([cx + Math.cos(a + w) * len, y + droop, cz + Math.sin(a + w) * len], [nx, 1, nz], c, [0, 0, 0]);
      idx.push(c0, p2, p1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aLup', new THREE.Float32BufferAttribute(lup, 3));
  g.setIndex(idx);
  return g;
}

// Angular basalt stone / boulder: displaced icosahedron, flat-ish base, faceted.
export function stoneGeo({ detail = 1, seed = 5, flat = 0.62, smooth = false } = {}) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  if (smooth) { g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g); }
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = noise2(v.x * 1.3 + seed, v.z * 1.3 + v.y * 0.7, seed) * 0.28 + noise2(v.x * 3.1, v.y * 3.1 + v.z, seed + 9) * 0.1;
    v.multiplyScalar(1 + n);
    v.y *= flat;
    if (v.y < -0.25) v.y = -0.25 - (v.y + 0.25) * 0.2;
    v.y += 0.18;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// Downy-birch scrub: a few lumpy blobs merged (vertex colour darkens toward the core/base).
export function shrubGeo({ seed = 9, lumps = 3 } = {}) {
  const rnd = mulberry32(seed);
  const parts = [];
  for (let k = 0; k < lumps; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position, v = new THREE.Vector3();
    const s = k === 0 ? 1 : 0.55 + rnd() * 0.3;
    const ox = k === 0 ? 0 : (rnd() - 0.5) * 1.2, oz = k === 0 ? 0 : (rnd() - 0.5) * 1.2, oy = k === 0 ? 0.75 : 0.5 + rnd() * 0.6;
    const col = [];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = noise2(v.x * 2.1 + seed + k, v.z * 2.1 + v.y * 1.7, seed) * 0.35;
      v.multiplyScalar(s * (1 + n));
      v.y *= 0.8;
      v.x += ox; v.z += oz; v.y += oy;
      p.setXYZ(i, v.x, Math.max(v.y, 0.05), v.z);
      const shade = 0.55 + 0.45 * Math.min(1, Math.max(0, v.y / 1.6));
      col.push(shade, shade, shade);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    parts.push(g);
  }
  // merge (non-indexed icosahedra)
  const count = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3), colr = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); colr.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  m.computeVertexNormals();
  // soften normals outward from the centre (reads as foliage mass, not a rock)
  const nr = m.attributes.normal, v = new THREE.Vector3(), c = new THREE.Vector3(0, 0.8, 0), n = new THREE.Vector3();
  for (let i = 0; i < nr.count; i++) {
    v.fromBufferAttribute(m.attributes.position, i).sub(c).normalize();
    n.fromBufferAttribute(nr, i).lerp(v, 0.6).normalize();
    nr.setXYZ(i, n.x, n.y, n.z);
  }
  return m;
}

// Photo grass tuft: `cards` alpha-cut blade cards, each mapped to one blade of the
// grass_medium_02 atlas (rects from env/photoAssets.js: {u0,u1,v0,v1,horiz,len,aspect}, v0 = tip
// side for upright blades). 2 segments per card (6 verts), curved by a random lean.
// color = AO-ish multiplier (dark base → full tip) on top of the terrain tint.
export function bladeCardTuft({ cards = 6, height = 0.3, seed = 1, blades, spread = 0.07 } = {}) {
  const rnd = mulberry32(seed);
  const pos = [], nrm = [], col = [], uv = [], idx = [];
  const maxLen = Math.max(...blades.map((b) => b.len));
  for (let c = 0; c < cards; c++) {
    const B = blades[Math.floor(rnd() * blades.length)];
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * spread;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const H = height * (0.55 + 0.45 * B.len / maxLen) * (0.75 + rnd() * 0.5);
    const Wd = H * B.aspect * 1.05;
    const fa = rnd() * Math.PI * 2, fx = Math.cos(fa), fz = Math.sin(fa);   // facing (card normal)
    const wx = -fz, wz = fx;                                                 // card width direction
    const lean = (0.12 + rnd() * 0.35) * H, flip = rnd() < 0.5;
    const base = pos.length / 3;
    for (const t of [0, 0.5, 1]) {
      const cx = bx + fx * lean * t * t, cy = H * t * (1 - 0.12 * t * (lean / H)), cz = bz + fz * lean * t * t;
      const shade = 0.62 + 0.38 * t;
      for (const sgn of [-1, 1]) {
        pos.push(cx + wx * Wd * 0.5 * sgn, cy, cz + wz * Wd * 0.5 * sgn);
        col.push(shade, shade, shade);
        const across = (sgn + 1) / 2, ac = flip ? 1 - across : across;
        if (!B.horiz) uv.push(B.u0 + (B.u1 - B.u0) * ac, B.v1 + (B.v0 - B.v1) * t);
        else uv.push(B.u1 + (B.u0 - B.u1) * t, B.v0 + (B.v1 - B.v0) * ac);
      }
    }
    // soft, grass-like lighting: face normal bent strongly upward
    const fn = new THREE.Vector3(fx, 0, fz).multiplyScalar(0.4).add(new THREE.Vector3(0, 1, 0)).normalize();
    for (let k = 0; k < 6; k++) nrm.push(fn.x, fn.y, fn.z);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4, base + 3, base + 5, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
