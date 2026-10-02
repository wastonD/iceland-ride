// Tiny flat-shaded mesh builder (positions / normals / uvs / vertex colours).
// Pure JS + three math — importable from node for numeric checks.
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

export class MeshBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = [];
    this.m = new THREE.Matrix4();
    this.nm = new THREE.Matrix3();
    this.color = [1, 1, 1];
  }

  /** Set the object->world transform applied to everything emitted after this call. */
  setMatrix(m) {
    this.m.copy(m);
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  /** Convenience: translate + yaw (rotation about Y, radians). */
  setPlace(x, y, z, yaw = 0) {
    return this.setMatrix(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
  }
  setColor(c) { this.color = c; return this; }

  get vertexCount() { return this.pos.length / 3; }

  /** Raw vertex (already in local space); returns its index. */
  vert(p, n, u, v, c) {
    _a.set(p[0], p[1], p[2]).applyMatrix4(this.m);
    _n.set(n[0], n[1], n[2]).applyMatrix3(this.nm).normalize();
    this.pos.push(_a.x, _a.y, _a.z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.uv.push(u, v);
    const cc = c || this.color;
    this.col.push(cc[0], cc[1], cc[2]);
    return this.pos.length / 3 - 1;
  }

  /** Quad given by explicit outward hint; u always along the *requested* a->b edge. */
  quadU(a, b, c, d, out, o = {}) {
    _a.fromArray(a); _b.fromArray(b); _c.fromArray(c); _d.fromArray(d);
    _e1.subVectors(_b, _a); _e2.subVectors(_d, _a);
    const su = o.su ?? 1, sv = o.sv ?? 1;
    const lu = _e1.length() * su, lv = _e2.length() * sv;
    const u0 = o.u0 ?? 0, v0 = o.v0 ?? 0;
    // uv for original order a,b,c,d
    let V = [[a, u0, v0], [b, u0 + lu, v0], [c, u0 + lu, v0 + lv], [d, u0, v0 + lv]];
    if (o.uvs) V = [a, b, c, d].map((p, i) => [p, o.uvs[i][0], o.uvs[i][1]]);          // explicit uv per corner (a,b,c,d order)
    const nrm = new THREE.Vector3().crossVectors(_e1, _e2).normalize();
    if (out && nrm.dot(_n.fromArray(out)) < 0) { V = [V[0], V[3], V[2], V[1]]; nrm.negate(); }
    const n = [nrm.x, nrm.y, nrm.z];
    const ii = V.map(([p, u, v]) => this.vert(p, n, u, v, o.color));
    this.idx.push(ii[0], ii[1], ii[2], ii[0], ii[2], ii[3]);
    return this;
  }

  /** Triangle with planar uv (u along a->b, v = height above a's y in metres). */
  tri(a, b, c, out, o = {}) {
    _a.fromArray(a); _b.fromArray(b); _c.fromArray(c);
    _e1.subVectors(_b, _a); _e2.subVectors(_c, _a);
    const nrm = new THREE.Vector3().crossVectors(_e1, _e2).normalize();
    let P = [a, b, c];
    if (out && nrm.dot(_n.fromArray(out)) < 0) { P = [a, c, b]; nrm.negate(); }
    const n = [nrm.x, nrm.y, nrm.z];
    const su = o.su ?? 1, sv = o.sv ?? 1;
    const dir = _e1.clone().setY(0).normalize();
    const ii = P.map((p) => {
      const rel = _d.set(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
      return this.vert(p, n, (o.u0 ?? 0) + rel.dot(dir) * su, (o.v0 ?? 0) + rel.y * sv, o.color);
    });
    this.idx.push(ii[0], ii[1], ii[2]);
    return this;
  }

  /** Axis-aligned box in local space (no bottom by default). Faces get u along horizontal edges. */
  box(x0, y0, z0, x1, y1, z1, o = {}) {
    const P = (x, y, z) => [x, y, z];
    const su = o.su ?? 1, sv = o.sv ?? 1;
    // front (+z)
    this.quadU(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1], { ...o, su, sv });
    // back (-z)
    this.quadU(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), [0, 0, -1], { ...o, su, sv });
    // right (+x)
    this.quadU(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), [1, 0, 0], { ...o, su, sv });
    // left (-x)
    this.quadU(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), [-1, 0, 0], { ...o, su, sv });
    // top
    if (o.top !== false) this.quadU(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), [0, 1, 0], { ...o, su, sv });
    if (o.bottom) this.quadU(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0], { ...o, su, sv });
    return this;
  }

  /** Upright n-gonal cylinder (radius r, y0..y1) centred at x,z. */
  cylinder(cx, cz, y0, y1, r, seg = 8, o = {}) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r];
      const am = (a0 + a1) / 2;
      this.quadU([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], [Math.cos(am), 0, Math.sin(am)], o);
    }
    if (o.cap !== false) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        this.tri([cx, y1, cz], [cx + Math.cos(a0) * r, y1, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, y1, cz + Math.sin(a1) * r], [0, 1, 0], o);
      }
    }
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** sRGB hex -> linear [r,g,b] */
export function lin(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
