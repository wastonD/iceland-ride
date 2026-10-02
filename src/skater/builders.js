// Small procedural-geometry toolkit for the skater: lofted tubes with
// superellipse cross-sections, ellipsoids, tubes, and a merge Builder that bakes
// vertex colours + (optional) skin weights into one BufferGeometry.

import * as THREE from 'three';
import { smoothstep } from '../core/noise.js';

const CAP_STEPS = 4;

const spow = (c, e) => Math.sign(c) * Math.pow(Math.abs(c), e);

/**
 * Loft a closed superellipse ring along an axis.
 *   axis 'y': ring lives in (x,z);  axis 'z': ring lives in (x,y).
 *   sections: [{ p, r1, r2, c1?, c2?, n? }]  p = position along the axis,
 *             r1/r2 = radii in the first/second plane axis, c1/c2 = ring centre.
 *   capStart / capEnd: 0 = open, 'flat' = flat fan, number = rounded cap of that extent.
 */
export function loft({ axis = 'y', sections, n = 2, M = 20, capStart = 0, capEnd = 0 }) {
  const secs = sections.slice().sort((a, b) => a.p - b.p);
  const first = secs[0];
  const last = secs[secs.length - 1];
  const rings = [];
  if (typeof capStart === 'number' && capStart > 0) {
    for (let k = CAP_STEPS; k >= 1; k--) {
      const th = (k / CAP_STEPS) * Math.PI * 0.5;
      rings.push({ p: first.p - capStart * Math.sin(th), s: Math.cos(th), sec: first });
    }
  }
  for (const sec of secs) rings.push({ p: sec.p, s: 1, sec });
  if (typeof capEnd === 'number' && capEnd > 0) {
    for (let k = 1; k <= CAP_STEPS; k++) {
      const th = (k / CAP_STEPS) * Math.PI * 0.5;
      rings.push({ p: last.p + capEnd * Math.sin(th), s: Math.cos(th), sec: last });
    }
  }

  const pos = [];
  const idx = [];
  const flip = axis === 'z';
  const put = (a, b, p) => (axis === 'y' ? pos.push(a, p, b) : pos.push(a, b, p));

  for (const r of rings) {
    const sec = r.sec;
    const e = 2 / (sec.n ?? n);
    const c1 = sec.c1 ?? 0;
    const c2 = sec.c2 ?? 0;
    for (let i = 0; i < M; i++) {
      const a = (i / M) * Math.PI * 2;
      const u = spow(Math.cos(a), e);
      const v = spow(Math.sin(a), e);
      put(c1 + sec.r1 * r.s * u, c2 + sec.r2 * r.s * v, r.p);
    }
  }
  const tri = (a, b, c) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < M; i++) {
      const i1 = (i + 1) % M;
      const a = j * M + i, b = (j + 1) * M + i, c = j * M + i1, d = (j + 1) * M + i1;
      tri(a, b, c);
      tri(c, b, d);
    }
  }
  const capFan = (ringIdx, sec, atStart) => {
    const ci = pos.length / 3;
    put(sec.c1 ?? 0, sec.c2 ?? 0, rings[ringIdx].p);
    for (let i = 0; i < M; i++) {
      const i1 = (i + 1) % M;
      const a = ringIdx * M + i, b = ringIdx * M + i1;
      if (atStart) tri(ci, a, b); else tri(ci, b, a);
    }
  };
  if (capStart === 'flat') capFan(0, first, true);
  if (capEnd === 'flat') capFan(rings.length - 1, last, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Axis-aligned rounded box (superellipse ring, slightly inset top/bottom). */
export function roundBox(cx, cy, cz, sx, sy, sz, { n = 5, inset = 0.85, M = 24 } = {}) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const e = Math.min(hx, hz) * 0.25;
  return loft({
    axis: 'y', n, M, capStart: 'flat', capEnd: 'flat',
    sections: [
      { p: cy - hy, r1: hx * inset, r2: hz * inset, c1: cx, c2: cz },
      { p: cy - hy + e, r1: hx, r2: hz, c1: cx, c2: cz },
      { p: cy + hy - e, r1: hx, r2: hz, c1: cx, c2: cz },
      { p: cy + hy, r1: hx * inset, r2: hz * inset, c1: cx, c2: cz },
    ],
  });
}

export function ellipsoid(cx, cy, cz, rx, ry, rz, ws = 14, hs = 10) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, cy, cz).multiply(new THREE.Matrix4().makeScale(rx, ry, rz)));
  return g;
}

export function tube(points, radius, segs = 24, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const g = new THREE.TubeGeometry(curve, segs, radius, radial, false);
  g.deleteAttribute('uv');
  return g;
}

/**
 * Flat strap along a curve. `normalFn(p)` gives the surface normal the strap lies on;
 * the strap is `width` wide across the surface and `thick` thick along the normal.
 */
export function strap(points, width, thick, normalFn, segs = 48, M = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const pos = [], idx = [];
  const p = new THREE.Vector3(), t = new THREE.Vector3(), nn = new THREE.Vector3(), w = new THREE.Vector3();
  for (let j = 0; j <= segs; j++) {
    const u = j / segs;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    normalFn(p, nn);
    w.crossVectors(t, nn).normalize();
    nn.crossVectors(w, t).normalize();
    for (let i = 0; i < M; i++) {
      const a = (i / M) * Math.PI * 2;
      const cu = spow(Math.cos(a), 0.5), sv = spow(Math.sin(a), 0.5);
      pos.push(
        p.x + w.x * cu * width * 0.5 + nn.x * sv * thick * 0.5,
        p.y + w.y * cu * width * 0.5 + nn.y * sv * thick * 0.5,
        p.z + w.z * cu * width * 0.5 + nn.z * sv * thick * 0.5);
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < M; i++) {
      const i1 = (i + 1) % M;
      const a = j * M + i, b = (j + 1) * M + i, c = j * M + i1, d = (j + 1) * M + i1;
      idx.push(a, c, b, c, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Weights that blend down a chain of bones along y: [[bone, yCentre, halfWidth], ...] top→bottom. */
export function chainY(base, blends) {
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

/** Collects parts into one BufferGeometry (position, normal, colour, optional skin). */
export class Builder {
  constructor(boneIndex = null) {
    this.boneIndex = boneIndex;
    this.pos = []; this.nor = []; this.col = []; this.idx = [];
    this.si = []; this.sw = [];
    this.count = 0;
  }

  /** skin: bone name, or fn(x,y,z) → [[bone,w],...]. Ignored when boneIndex is null. */
  add(geo, colorHex, skin) {
    const p = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const c = new THREE.Color(colorHex);
    const base = this.count;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z);
      this.nor.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      this.col.push(c.r, c.g, c.b);
      if (this.boneIndex) {
        let list = typeof skin === 'function' ? skin(x, y, z) : [[skin, 1]];
        list = list.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
        let sum = 0;
        for (const e of list) sum += e[1];
        for (let k = 0; k < 4; k++) {
          const e = list[k];
          if (e) {
            const bi = this.boneIndex[e[0]];
            if (bi === undefined) throw new Error('unknown bone ' + e[0]);
            this.si.push(bi); this.sw.push(e[1] / sum);
          } else { this.si.push(0); this.sw.push(0); }
        }
      }
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) this.idx.push(geo.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) this.idx.push(i + base);
    this.count += p.count;
    geo.dispose();
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.boneIndex) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
