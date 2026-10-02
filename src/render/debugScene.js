// Debug test scene for tuning the pipeline before real content lands: ?debug=forest
import * as THREE from 'three';
import { smoothstep } from '../core/noise.js';

export function createDebugForest(ctx) {
  const { world } = ctx;
  const g = new THREE.Group();
  const gm = ctx.prepareMaterial(new THREE.MeshStandardMaterial({ color: 0x3a3024, roughness: 0.9 }));
  const geo = new THREE.PlaneGeometry(320, 320, 160, 160).rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, world.heightAt(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, gm);
  ground.receiveShadow = true;
  g.add(ground);
  const tm = ctx.prepareMaterial(new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.8 }));
  const cm = ctx.prepareMaterial(new THREE.MeshStandardMaterial({ color: 0x2c4a2a, roughness: 0.7 }));
  let r = 1;
  const rnd = () => ((r = (r * 16807) % 2147483647), r / 2147483647);
  for (let i = 0; i < 260; i++) {
    const x = (rnd() - 0.5) * 260, z = (rnd() - 0.5) * 260;
    if (world.waterDistAt(x, z) < 3 || world.trailDistAt(x, z) < 3) continue;
    const y = world.heightAt(x, z), h = 25 + rnd() * 20, rad = 0.4 + rnd() * 1.2;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.7, rad, h, 10), tm);
    t.position.set(x, y + h / 2, z);
    t.castShadow = t.receiveShadow = true;
    g.add(t);
    const c = new THREE.Mesh(new THREE.SphereGeometry(4 + rnd() * 5, 10, 8), cm);
    c.scale.y = 0.45;
    c.position.set(x, y + h, z);
    c.castShadow = true;
    g.add(c);
  }
  ctx.scene.add(g);
  return {};
}

// Debug: quick slope-coloured terrain from world.heightGrid (?debug=terrain) to check composition.
export function createDebugTerrain(ctx) {
  const w = ctx.world, N = w.gridSize, H = w.WORLD_HALF, step = 2;
  const n = Math.floor((N - 1) / step) + 1;
  const geo = new THREE.PlaneGeometry(H * 2, H * 2, n - 1, n - 1).rotateX(-Math.PI / 2);
  const p = geo.attributes.position, col = new Float32Array(p.count * 3), nrm = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), h = w.heightAt(x, z);
    p.setY(i, h);
    w.normalAt(x, z, nrm);
    const rock = smoothstep(0.75, 0.55, nrm.y), road = 1 - smoothstep(3, 6, w.roadDistAt?.(x, z) ?? 99);
    const snow = smoothstep(560, 700, h);
    let c = new THREE.Color(0.2, 0.3, 0.1).lerp(new THREE.Color(0.28, 0.26, 0.23), rock).lerp(new THREE.Color(0.9, 0.92, 0.95), snow).lerp(new THREE.Color(0.08, 0.08, 0.09), road);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, ctx.prepareMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { wet: false }));
  m.receiveShadow = true; m.castShadow = true;
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(H * 4, H * 4).rotateX(-Math.PI / 2), ctx.prepareMaterial(new THREE.MeshStandardMaterial({ color: 0x0b2a3a, roughness: 0.15, metalness: 0 }), { wet: false }));
  ctx.scene.add(m, sea);
  return {};
}
