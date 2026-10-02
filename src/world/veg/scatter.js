// InstanceField: many instances of a few geometry variants, with CPU-side
// cell + frustum + distance culling, two LOD levels, a scale fade at the far
// edge, and quality-dependent thinning (by per-instance importance).
// One InstancedMesh per (variant, lod, part); parts of one (variant, lod) share
// the same instance buffers.

import * as THREE from 'three';

const CELL = 24;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class InstanceField {
  /**
   * variants: [ [lod0, lod1] ] where lod = { parts: [{geo, mat, cast}], bound: {y, r} }
   * opts: { maxDist, lodDist, shadowDist }
   */
  constructor(name, variants, mats, opts) {
    this.name = name;
    this.variants = variants;
    this.mats = mats;
    this.o = { maxDist: 60, lodDist: 20, shadowDist: 20, fade: 0.15, ...opts };
    this.list = [];
    this.meshes = [];
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
    this.lastQuat = new THREE.Quaternion();
    this.dirty = true;
    this.q = { keep: 1, dist: 1 };
  }

  add(x, y, z, rotY, scale, tint, variant, importance, tiltX = 0, tiltZ = 0) {
    this.list.push({ x, y, z, rotY, scale, tint, variant, importance, tiltX, tiltZ });
  }

  get count() { return this.list.length; }

  finalize(scene, depthFor) {
    const L = this.list;
    const n = L.length;
    // sort by cell, then importance
    const key = (it) => {
      const ci = Math.floor((it.x + 200) / CELL), cj = Math.floor((it.z + 200) / CELL);
      return ci * 64 + cj;
    };
    L.sort((a, b) => key(a) - key(b) || a.importance - b.importance);
    this.mat = new Float32Array(n * 16);
    this.col = new Float32Array(n * 3);
    this.pos = new Float32Array(n * 4); // x, y+boundY, z, boundR
    this.imp = new Float32Array(n);
    this.vari = new Uint8Array(n);
    const capacity = this.variants.map(() => 0);
    for (let i = 0; i < n; i++) {
      const it = L[i];
      _e.set(it.tiltX, it.rotY, it.tiltZ, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(it.x, it.y, it.z), _q, _s.setScalar(it.scale));
      _m.toArray(this.mat, i * 16);
      this.col.set(it.tint, i * 3);
      const b = this.variants[it.variant][0].bound;
      this.pos[i * 4] = it.x; this.pos[i * 4 + 1] = it.y + b.y * it.scale; this.pos[i * 4 + 2] = it.z; this.pos[i * 4 + 3] = b.r * it.scale;
      this.imp[i] = it.importance;
      this.vari[i] = it.variant;
      capacity[it.variant]++;
    }
    // cells
    this.cells = [];
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || key(L[i]) !== key(L[start])) {
        let cx = 0, cy = 0, cz = 0, maxB = 0;
        for (let k = start; k < i; k++) { cx += this.pos[k * 4]; cy += this.pos[k * 4 + 1]; cz += this.pos[k * 4 + 2]; maxB = Math.max(maxB, this.pos[k * 4 + 3]); }
        const c = i - start;
        cx /= c; cy /= c; cz /= c;
        let rad = 0;
        for (let k = start; k < i; k++) rad = Math.max(rad, Math.hypot(this.pos[k * 4] - cx, this.pos[k * 4 + 1] - cy, this.pos[k * 4 + 2] - cz));
        this.cells.push({ start, end: i, cx, cy, cz, r: rad + maxB });
        start = i;
      }
    }
    this.list = null;
    // meshes
    this.slots = this.variants.map((lods, v) => lods.map((lod, l) => {
      const cap = Math.max(1, capacity[v]);
      const im = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      im.setUsage(THREE.DynamicDrawUsage);
      const ic = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      ic.setUsage(THREE.DynamicDrawUsage);
      const meshes = lod.parts.map((part) => {
        const mat = this.mats[part.mat];
        const mesh = new THREE.InstancedMesh(part.geo, mat, cap);
        mesh.instanceMatrix = im;
        mesh.instanceColor = ic;
        mesh.frustumCulled = false;
        mesh.castShadow = !!part.cast && (l === 0 || this.o.farCast);
        mesh.receiveShadow = true;
        if (mesh.castShadow) mesh.customDepthMaterial = depthFor(mat);
        mesh.count = 0;
        mesh.visible = false;
        mesh.name = `${this.name}_v${v}_l${l}`;
        scene.add(mesh);
        this.meshes.push(mesh);
        return mesh;
      });
      return { im, ic, meshes, n: 0 };
    }));
  }

  setQuality(keep, dist) { this.q = { keep, dist }; this.dirty = true; }

  update(camera, frustumPlanes, force) {
    const cp = camera.position;
    if (!force && !this.dirty && cp.distanceToSquared(this.lastPos) < 0.36 && Math.abs(camera.quaternion.dot(this.lastQuat)) > 0.9995) return;
    this.lastPos.copy(cp); this.lastQuat.copy(camera.quaternion); this.dirty = false;
    const { maxDist, lodDist, shadowDist, fade } = this.o;
    const maxD = maxDist * this.q.dist, keep = this.q.keep;
    const lodD2 = (lodDist * Math.max(0.7, this.q.dist)) ** 2, shD2 = shadowDist * shadowDist;
    const fadeStart = maxD * (1 - fade);
    const planes = frustumPlanes;
    for (const lods of this.slots) for (const s of lods) s.n = 0;
    const px = cp.x, py = cp.y, pz = cp.z;
    const M = this.mat, C = this.col, P = this.pos, I = this.imp, VI = this.vari;
    for (const cell of this.cells) {
      const dcx = cell.cx - px, dcz = cell.cz - pz;
      const dc = Math.sqrt(dcx * dcx + dcz * dcz);
      if (dc - cell.r > maxD) continue;
      let cellIn = true, cellFull = true;
      for (let k = 0; k < 6; k++) {
        const pl = planes[k];
        const d = pl.normal.x * cell.cx + pl.normal.y * cell.cy + pl.normal.z * cell.cz + pl.constant;
        if (d < -cell.r) { cellIn = false; break; }
        if (d < cell.r) cellFull = false;
      }
      if (!cellIn && dc - cell.r > shadowDist) continue;
      for (let i = cell.start; i < cell.end; i++) {
        if (I[i] > keep) continue;
        const x = P[i * 4], y = P[i * 4 + 1], z = P[i * 4 + 2], r = P[i * 4 + 3];
        const dx = x - px, dy = y - py, dz = z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxD * maxD) continue;
        let vis = cellFull;
        if (!vis) {
          vis = true;
          for (let k = 0; k < 6; k++) {
            const pl = planes[k];
            if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -r) { vis = false; break; }
          }
        }
        if (!vis && d2 + dy * dy > shD2) continue;
        const lod = d2 < lodD2 ? 0 : 1;
        const slot = this.slots[VI[i]][lod];
        const o = slot.n++;
        const dst = slot.im.array;
        const d = Math.sqrt(d2);
        if (d > fadeStart) {
          const f = Math.max(0.001, 1 - (d - fadeStart) / (maxD - fadeStart));
          const k = i * 16, t = o * 16;
          for (let c = 0; c < 16; c++) dst[t + c] = M[k + c];
          dst[t] *= f; dst[t + 1] *= f; dst[t + 2] *= f;
          dst[t + 4] *= f; dst[t + 5] *= f; dst[t + 6] *= f;
          dst[t + 8] *= f; dst[t + 9] *= f; dst[t + 10] *= f;
        } else {
          dst.set(M.subarray(i * 16, i * 16 + 16), o * 16);
        }
        slot.ic.array[o * 3] = C[i * 3]; slot.ic.array[o * 3 + 1] = C[i * 3 + 1]; slot.ic.array[o * 3 + 2] = C[i * 3 + 2];
      }
    }
    for (const lods of this.slots) for (const s of lods) {
      s.im.needsUpdate = true; s.ic.needsUpdate = true;
      s.im.clearUpdateRanges(); s.ic.clearUpdateRanges();
      if (s.n) { s.im.addUpdateRange(0, s.n * 16); s.ic.addUpdateRange(0, s.n * 3); }
      for (const m of s.meshes) { m.count = s.n; m.visible = s.n > 0; }
    }
  }

  stats() {
    let inst = 0, tris = 0;
    for (const lods of this.slots) for (const s of lods) {
      inst += s.n;
      for (const m of s.meshes) tris += (m.geometry.index.count / 3) * s.n;
    }
    return { inst, tris };
  }
}
