// Columnar-jointed basalt lining the canyon (features.gorge): instanced hexagonal prisms,
// stepped in rows up both walls with ragged tops; at the canyon head they hang from the
// rim like organ pipes around the Svartifoss-style fall.

import * as THREE from 'three';
import { addShaderPatch } from '../../../render/shaderPatch.js';
import { addBakedLight } from './terrainData.js';
import { FEATURES } from './features.js';
import { mulberry32, lerp } from '../../../core/noise.js';

function hexPrism() {
  // unit hexagon (circumradius 1), y 0..1, flat top with a slight rim bevel
  const pos = [], nrm = [], idx = [];
  const ring = (y, r) => { const o = pos.length / 3; for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; pos.push(Math.cos(a) * r, y, Math.sin(a) * r); } return o; };
  // sides (flat shaded: duplicate vertices per face)
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2, am = (a0 + a1) / 2;
    const o = pos.length / 3, nx = Math.cos(am), nz = Math.sin(am);
    pos.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1), Math.cos(a1), 0.97, Math.sin(a1), Math.cos(a0), 0.97, Math.sin(a0));
    for (let i = 0; i < 4; i++) nrm.push(nx, 0, nz);
    idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
  }
  // bevel ring + cap
  const r0 = ring(0.97, 1), r1 = ring(1, 0.88);
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; nrm.push(Math.cos(a) * 0.7, 0.7, Math.sin(a) * 0.7); }
  for (let k = 0; k < 6; k++) nrm.push(0, 1, 0);
  for (let k = 0; k < 6; k++) { const k1 = (k + 1) % 6; idx.push(r0 + k, r1 + k1, r0 + k1, r0 + k, r1 + k, r1 + k1); }
  const c = pos.length / 3; pos.push(0, 1, 0); nrm.push(0, 1, 0);
  for (let k = 0; k < 6; k++) idx.push(c, r1 + ((k + 1) % 6), r1 + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

const COL_FRAG = /* glsl */ `
  {
    vec3 N = normalize(vCW_N);
    float top = smoothstep(0.6, 0.9, N.y);
    // dark fine-grained basalt, faint vertical cooling striations, lighter weathered tops
    float st = tgn(vec2(vCW.x * 3.1 + vCW.z * 2.7, vCW.y * 0.25)) * 0.6 + tgn(vCW.xz * 7.0 + vCW.y * 0.7) * 0.4;
    vec3 c = vec3(0.042, 0.042, 0.045) * (0.75 + 0.5 * st) * diffuseColor.rgb;
    c = mix(c, vec3(0.1, 0.11, 0.08) * (0.7 + 0.6 * st), top * 0.8);                 // moss / lichen on the caps
    c = mix(c, vec3(0.09, 0.07, 0.05), smoothstep(0.7, 0.85, tgn(vCW.xz * 0.4 + vCW.y * 0.3)) * 0.35 * (1.0 - top)); // iron stain
    diffuseColor.rgb = c;
  }
`;

export function createGorgeColumns(ctx, td) {
  const G = FEATURES.gorge, world = ctx.world, GG = td.gorge;
  const rnd = mulberry32(2718);
  const ax = G.ax, az = G.az, L = GG.len, ux = GG.ux, uz = GG.uz, nx = -uz, nz = ux;
  const H = td.heightAt;
  const items = [];
  const floorY = (t) => GG.levelAt(t) - 0.55;
  // colonnade in front of the (vertical) canyon walls
  function column(x, z, rx, rz, t, w, row, head) {
    if (world.roadDistAt(x, z) < 6.5) return;
    const rim = H(x + rx * (w - GG.wallAt(t) + 3), z + rz * (w - GG.wallAt(t) + 3));
    const fl = floorY(t);
    if (rim - fl < 2) return;
    let top = rim + (rnd() - 0.75) * 1.4;
    if (rnd() < 0.22) top -= 1.5 + rnd() * 5;                      // broken, stepped heads
    if (row === 1) top -= rnd() * 3.5;
    let bot = fl - 1.0;
    if (head && row === 0 && rim - fl > 12) bot = Math.max(bot, top - (7 + rnd() * 9));   // organ pipes hanging over the plunge pool
    if (top - bot < 0.8) return;
    items.push({ x, z, y0: bot, y1: top, r: 0.42 + rnd() * 0.22, rot: rnd() * Math.PI, v: 0.8 + rnd() * 0.45, tilt: 0 });
  }
  function rubble(x, z, t) {
    if (world.roadDistAt(x, z) < 6.5) return;
    const y = H(x, z), h = 0.5 + rnd() * 1.2;
    items.push({ x, z, y0: y - 0.35, y1: y - 0.35 + h, r: 0.4 + rnd() * 0.2, rot: rnd() * Math.PI, v: 0.75 + rnd() * 0.4, tilt: 0.3 + rnd() * 0.9, tiltDir: rnd() * Math.PI * 2 });
  }
  const STEP = 0.95;
  for (let s = 0; s <= L; s += STEP) {
    const t = s / L, w = lerp(G.wTopHead, G.wTopMouth, t), wall = GG.wallAt(t);
    const cx = ax + ux * s, cz = az + uz * s;
    for (const side of [-1, 1]) {
      const rx = nx * side, rz = nz * side;
      for (let row = 0; row < 2; row++) {
        const d = wall - 0.45 - row * 0.85 + (rnd() - 0.5) * 0.2, j = (rnd() - 0.5) * 0.3;
        column(cx + rx * d + ux * j, cz + rz * d + uz * j, rx, rz, t, w, row, false);
      }
      if (rnd() < 0.3) { const d = wall - 1.8 - rnd() * 2.2; rubble(cx + rx * d, cz + rz * d, t); }
    }
  }
  // head amphitheatre: half ring behind point a, with a slot for the fall
  const wall0 = GG.wallAt(0);
  for (let row = 0; row < 2; row++) {
    const d = wall0 - 0.45 - row * 0.85, n = Math.ceil((Math.PI * d) / STEP);
    for (let k = 0; k <= n; k++) {
      const th = -Math.PI / 2 + (k / n) * Math.PI;
      const dx = -ux * Math.cos(th) + nx * Math.sin(th), dz = -uz * Math.cos(th) + nz * Math.sin(th);
      if (Math.cos(th) > 0 && Math.abs(Math.sin(th)) * d < 2.8) continue;       // keep the fall's slot open
      column(ax + dx * d, az + dz * d, dx, dz, 0, G.wTopHead, row, true);
    }
  }
  const geo = hexPrism();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  addShaderPatch(mat, 'fjordColumns', (shader) => {
    Object.assign(shader.uniforms, td.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCW; varying vec3 vCW_N;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { mat4 cm = modelMatrix * instanceMatrix; vCW = (cm * vec4(transformed, 1.0)).xyz; vCW_N = normalize(mat3(cm) * objectNormal); }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + td.GLSL + 'varying vec3 vCW; varying vec3 vCW_N;\n')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + COL_FRAG);
  });
  addBakedLight(mat, td, { aoStrength: 1 });
  ctx.prepareMaterial(mat);   // rain makes them glisten

  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const e = new THREE.Euler();
  items.forEach((it, i) => {
    if (it.tilt) q.setFromEuler(e.set(Math.cos(it.tiltDir) * it.tilt, it.rot, Math.sin(it.tiltDir) * it.tilt));
    else q.setFromAxisAngle(up, it.rot);
    m4.compose(p.set(it.x, it.y0, it.z), q, sc.set(it.r, it.y1 - it.y0, it.r));
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, col.setRGB(it.v, it.v, it.v * 1.02));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'gorgeColumns';
  mesh.computeBoundingSphere();
  return { mesh, count: items.length, dispose() { geo.dispose(); mat.dispose(); mesh.dispose(); } };
}
