// Lighthouse on the far promontory: white tower, gallery, red lantern roof, keeper's hut,
// glowing lantern glass and a rotating light beam (additive cones).
import * as THREE from 'three';
import { MeshBuilder, lin } from './builder.js';
import { beamBox } from './util.js';

export const LH = { h: 12.6, r0: 2.15, r1: 1.55, gallery: 10.7 };

export function lighthouseSite(world) {
  const L = world.features.lighthouse, hs = [];
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; hs.push(world.heightAt(L.x + Math.cos(a) * 3.2, L.z + Math.sin(a) * 3.2)); }
  hs.push(world.heightAt(L.x, L.z));
  return { x: L.x, z: L.z, hmin: Math.min(...hs), hmax: Math.max(...hs), floorY: Math.max(...hs) + 0.25 };
}

export function buildLighthouse(world) {
  const site = lighthouseSite(world);
  const mb = new MeshBuilder(), glass = new MeshBuilder();
  const white = lin('#efeee8'), red = lin('#c2361f'), redD = lin('#992a19'), black = lin('#26282b'), conc = lin('#9c9a93');
  mb.setPlace(site.x, site.floorY, site.z, 0);
  glass.setPlace(site.x, site.floorY, site.z, 0);
  const seg = 16, { h, r0, r1, gallery } = LH;
  // concrete plinth down to the lowest terrain
  const pb = site.hmin - 0.4 - site.floorY;
  mb.cylinder(0, 0, pb, 0.5, r0 + 0.8, seg, { color: conc, cap: true });
  // tapered tower: frustum, with a red band and a dark base ring
  const rAt = (y) => r0 + (r1 - r0) * (y / h);
  const ringY = [0.5, 1.4, 4.2, 5.2, gallery - 0.4];
  const ringCol = [black, white, red, white];
  for (let k = 0; k < ringY.length - 1; k++) {
    const y0 = ringY[k], y1 = ringY[k + 1];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const P = (a, y) => [Math.cos(a) * rAt(y), y, Math.sin(a) * rAt(y)];
      mb.quadU(P(a0, y0), P(a1, y0), P(a1, y1), P(a0, y1), [Math.cos(am), 0, Math.sin(am)], { color: ringCol[k], su: 1, sv: 1 });
    }
  }
  // door (west) + two small windows
  const door = (a, y0, y1, w, col) => {
    const R = rAt((y0 + y1) / 2) + 0.03, dx = -Math.sin(a), dz = Math.cos(a);
    const cx = Math.cos(a) * R, cz = Math.sin(a) * R;
    mb.quadU([cx - dx * w / 2, y0, cz - dz * w / 2], [cx + dx * w / 2, y0, cz + dz * w / 2], [cx + dx * w / 2, y1, cz + dz * w / 2], [cx - dx * w / 2, y1, cz - dz * w / 2], [Math.cos(a), 0, Math.sin(a)], { color: col });
  };
  door(Math.PI, 0.5, 2.5, 1.0, redD);
  door(Math.PI * 0.5, 6.5, 7.6, 0.45, black); door(Math.PI * 1.5, 7.6, 8.7, 0.45, black); door(0, 6.2, 7.3, 0.45, black);
  // gallery deck (dark) + railing
  const gy = gallery;
  mb.cylinder(0, 0, gy - 0.4, gy, r1 + 0.85, seg, { color: black, cap: true });
  mb.cylinder(0, 0, gy - 0.4, gy - 0.05, r1 + 0.85, seg, { color: black, cap: false });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, x = Math.cos(a) * (r1 + 0.8), z = Math.sin(a) * (r1 + 0.8);
    mb.box(x - 0.03, gy, z - 0.03, x + 0.03, gy + 1.05, z + 0.03, { color: black, top: true });
  }
  for (let i = 0; i < 24; i++) {
    const a0 = (i / 24) * Math.PI * 2, a1 = ((i + 1) / 24) * Math.PI * 2, R = r1 + 0.8;
    beamBox(mb, [Math.cos(a0) * R, gy + 1.03, Math.sin(a0) * R], [Math.cos(a1) * R, gy + 1.03, Math.sin(a1) * R], 0.06, 0.06, black);
  }
  // lantern room: red base ring, glass cylinder (emissive mesh), red roof + finial
  const lr = 1.05, ly0 = gy, ly1 = gy + 1.9;
  mb.cylinder(0, 0, ly0, ly0 + 0.35, lr + 0.12, 12, { color: red, cap: true });
  for (let i = 0; i < 6; i++) { const a = ((i + 0.5) / 6) * Math.PI * 2; beamBox(mb, [Math.cos(a) * lr, ly0 + 0.3, Math.sin(a) * lr], [Math.cos(a) * lr * 0.95, ly1, Math.sin(a) * lr * 0.95], 0.07, 0.07, red); }
  glass.cylinder(0, 0, ly0 + 0.35, ly1, lr - 0.04, 12, { color: [1, 1, 1], cap: false });
  // roof cone
  const rs = 12;
  for (let i = 0; i < rs; i++) {
    const a0 = (i / rs) * Math.PI * 2, a1 = ((i + 1) / rs) * Math.PI * 2, am = (a0 + a1) / 2;
    mb.tri([Math.cos(a0) * (lr + 0.28), ly1, Math.sin(a0) * (lr + 0.28)], [Math.cos(a1) * (lr + 0.28), ly1, Math.sin(a1) * (lr + 0.28)], [0, ly1 + 1.05, 0], [Math.cos(am), 0.6, Math.sin(am)], { color: red });
  }
  mb.cylinder(0, 0, ly1 + 1.0, ly1 + 1.3, 0.09, 6, { color: black, cap: true });
  beamBox(mb, [-0.5, ly1 + 1.25, 0], [0.5, ly1 + 1.25, 0], 0.05, 0.05, black);
  // keeper's hut (white walls, red roof) beside the tower
  const hutX = -8.2, hutZ = 3.5, hw = 6.2, hd = 4.4, hh = 2.9, rise = 1.5;
  const hs = [world.heightAt(site.x + hutX - hw / 2, site.z + hutZ - hd / 2), world.heightAt(site.x + hutX + hw / 2, site.z + hutZ - hd / 2), world.heightAt(site.x + hutX - hw / 2, site.z + hutZ + hd / 2), world.heightAt(site.x + hutX + hw / 2, site.z + hutZ + hd / 2)];
  const hutFloor = Math.max(...hs) + 0.2 - site.floorY, hutBase = Math.min(...hs) - 0.35 - site.floorY;
  mb.box(hutX - hw / 2 - 0.05, hutBase, hutZ - hd / 2 - 0.05, hutX + hw / 2 + 0.05, hutFloor, hutZ + hd / 2 + 0.05, { color: conc, top: false });
  mb.box(hutX - hw / 2, hutFloor, hutZ - hd / 2, hutX + hw / 2, hutFloor + hh, hutZ + hd / 2, { color: white, top: false });
  const yt = hutFloor + hh, yr = yt + rise, ov = 0.35, ye = yt - (ov * rise) / (hd / 2);
  mb.quadU([hutX - hw / 2 - ov, ye, hutZ + hd / 2 + ov], [hutX + hw / 2 + ov, ye, hutZ + hd / 2 + ov], [hutX + hw / 2 + ov, yr, hutZ], [hutX - hw / 2 - ov, yr, hutZ], [0, 1, 1], { color: red });
  mb.quadU([hutX + hw / 2 + ov, ye, hutZ - hd / 2 - ov], [hutX - hw / 2 - ov, ye, hutZ - hd / 2 - ov], [hutX - hw / 2 - ov, yr, hutZ], [hutX + hw / 2 + ov, yr, hutZ], [0, 1, -1], { color: red });
  mb.tri([hutX + hw / 2, yt, hutZ - hd / 2], [hutX + hw / 2, yt, hutZ + hd / 2], [hutX + hw / 2, yr, hutZ], [1, 0, 0], { color: white });
  mb.tri([hutX - hw / 2, yt, hutZ + hd / 2], [hutX - hw / 2, yt, hutZ - hd / 2], [hutX - hw / 2, yr, hutZ], [-1, 0, 0], { color: white });
  // hut door + windows (front +z)
  const zf = hutZ + hd / 2 + 0.03;
  mb.box(hutX - 0.5, hutFloor, zf - 0.02, hutX + 0.5, hutFloor + 2.0, zf + 0.06, { color: redD, top: true });
  for (const dx of [-2.1, 2.1]) mb.box(hutX + dx - 0.55, hutFloor + 1.1, zf - 0.02, hutX + dx + 0.55, hutFloor + 2.0, zf + 0.05, { color: black, top: true });
  return { site, tower: mb.toGeometry(), glass: glass.toGeometry(), lanternY: site.floorY + (ly0 + ly1) / 2 };
}

/** Two opposite additive light cones (apex at the origin, pointing +x / -x). Alpha fades with distance. */
export function beamGeometry(length = 220, radius = 9) {
  // Build manually for control of colours (apex bright, end transparent)
  const pos = [], col = [], idx = [];
  const N = 12;
  for (const dir of [1, -1]) {
    const base = pos.length / 3;
    pos.push(0, 0, 0); col.push(1, 1, 1, 0.9);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pos.push(dir * length, Math.cos(a) * radius, Math.sin(a) * radius * 0.7); col.push(1, 1, 1, 0);
    }
    for (let i = 0; i < N; i++) idx.push(base, base + 1 + i, base + 1 + ((i + 1) % N));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
