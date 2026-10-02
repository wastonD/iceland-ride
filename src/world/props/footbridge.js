// Rainforest: plain timber footbridges where the trail crosses the stream.
// The trail path already rides at deck height there (world.path.bridges = [{s0,s1}]).
// Exports createFootbridges(ctx) — registered by the rainforest scene as module "footbridges".
import * as THREE from 'three';
import { MeshBuilder, lin } from '../../scenes/fjord/build/builder.js';
import { beamBox } from '../../scenes/fjord/build/util.js';
import { mulberry32 } from '../../core/noise.js';

const DECK_W = 2.4, HALF = DECK_W / 2;

/** Pure geometry (node-testable). Returns { geometry, decks:[{s0,s1,rows:[{s,x,y,z}]}], piles }. */
export function buildFootbridgeGeometry(world) {
  const path = world.path, L = path.length, mb = new MeshBuilder();
  const deckC = lin('#8a7a66'), beamC = lin('#5c4c3b'), postC = lin('#6d5b48'), pileC = lin('#4a3c2f');
  const decks = [], piles = [];
  const wrapS = (s) => (path.closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s)));
  const frame = (s) => {
    const p = path.pointAt(wrapS(s)), t = path.tangentAt(wrapS(s));
    const h = Math.hypot(t.x, t.z) || 1, tx = t.x / h, tz = t.z / h;
    return { x: p.x, y: p.y, z: p.z, tx, tz, rx: -tz, rz: tx };
  };
  for (const b of path.bridges || []) {
    const s0 = b.s0, s1 = b.s1, rows = [];
    for (let s = s0; s <= s1 + 1e-6; s += 1) rows.push({ s, f: frame(s) });
    if (rows[rows.length - 1].s < s1) rows.push({ s: s1, f: frame(s1) });
    const P = (f, l, dy) => [f.x + f.rx * l, f.y + dy, f.z + f.rz * l];
    const TOP = -0.02;                                          // deck surface = path height (planks' top face)
    for (let k = 0; k < rows.length - 1; k++) {
      const a = rows[k].f, c = rows[k + 1].f, len = rows[k + 1].s - rows[k].s;
      // planks (top) — texture planks run across the deck
      mb.quadU(P(a, -HALF, TOP), P(a, HALF, TOP), P(c, HALF, TOP), P(c, -HALF, TOP), [0, 1, 0], { color: deckC, uvs: [[rows[k].s, 0], [rows[k].s, 2], [rows[k + 1].s, 2], [rows[k + 1].s, 0]] });
      // deck thickness / underside
      mb.quadU(P(a, -HALF, TOP - 0.1), P(a, HALF, TOP - 0.1), P(c, HALF, TOP - 0.1), P(c, -HALF, TOP - 0.1), [0, -1, 0], { color: beamC, su: 1, sv: 1 });
      for (const sg of [-1, 1]) {
        const hint = [sg * a.rx, 0, sg * a.rz];
        mb.quadU(P(a, sg * HALF, TOP - 0.1), P(c, sg * HALF, TOP - 0.1), P(c, sg * HALF, TOP), P(a, sg * HALF, TOP), hint, { color: beamC, su: 1, sv: 1 });
      }
      void len;
    }
    // stringers + cross beams
    for (const l of [-0.85, 0.85]) for (let k = 0; k < rows.length - 1; k++) beamBox(mb, P(rows[k].f, l, TOP - 0.24), P(rows[k + 1].f, l, TOP - 0.24), 0.16, 0.22, beamC, [0, 1, 0]);
    for (let k = 0; k < rows.length; k += 2) beamBox(mb, P(rows[k].f, -HALF - 0.12, TOP - 0.36), P(rows[k].f, HALF + 0.12, TOP - 0.36), 0.12, 0.13, beamC, [0, 1, 0]);
    // handrails: posts every ~1.6 m, top rail + mid rail
    const rnd = mulberry32(Math.floor(s0 * 7 + 3));
    for (const sg of [-1, 1]) {
      const l = sg * (HALF - 0.05);
      for (let k = 0; k < rows.length; k += 2) {
        const f = rows[k].f;
        beamBox(mb, P(f, l, TOP - 0.3), P(f, l, TOP + 1.02 + (rnd() - 0.5) * 0.04), 0.09, 0.09, postC, [0, 0, 1]);
      }
      for (let k = 0; k < rows.length - 1; k++) {
        beamBox(mb, P(rows[k].f, l, TOP + 1.0), P(rows[k + 1].f, l, TOP + 1.0), 0.08, 0.06, postC, [0, 1, 0]);
        beamBox(mb, P(rows[k].f, l, TOP + 0.52), P(rows[k + 1].f, l, TOP + 0.52), 0.06, 0.05, postC, [0, 1, 0]);
      }
    }
    // end sills
    for (const r of [rows[0], rows[rows.length - 1]]) beamBox(mb, P(r.f, -HALF - 0.2, TOP - 0.3), P(r.f, HALF + 0.2, TOP - 0.3), 0.3, 0.24, beamC, [0, 1, 0]);
    // piles into the stream bed, every ~3 m on both sides
    const dk = [];
    for (let k = 1; k < rows.length - 1; k += 3) for (const sg of [-1, 1]) {
      const f = rows[k].f, l = sg * (HALF - 0.15), x = f.x + f.rx * l, z = f.z + f.rz * l;
      const bed = world.heightAt(x, z), top = f.y + TOP - 0.3;
      if (top - bed < 0.15) continue;
      const bot = bed - 0.45;
      mb.cylinder(x, z, bot, top, 0.11, 6, { color: pileC, cap: false });
      piles.push({ x, z, bottom: bot, top, bed });
    }
    decks.push({ s0, s1, rows: rows.map((r) => ({ s: r.s, x: r.f.x, y: r.f.y + TOP, z: r.f.z })), piles: dk });
  }
  return { geometry: mb.toGeometry(), decks, piles };
}

function woodTex() {
  const S = 256, rnd = mulberry32(99), c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), P = 6, pw = S / P;
  for (let i = 0; i < P; i++) {
    const l = 92 + rnd() * 26; g.fillStyle = `rgb(${l * 1.02},${l * 0.94},${l * 0.84})`; g.fillRect(i * pw, 0, pw, S);
    for (let k = 0; k < 20; k++) { g.fillStyle = `rgba(20,14,8,${0.05 + rnd() * 0.09})`; g.fillRect(i * pw + rnd() * pw, 0, 1, S); }
    for (let k = 0; k < 10; k++) { g.fillStyle = `rgba(120,140,90,${0.05 + rnd() * 0.07})`; g.fillRect(i * pw + rnd() * pw, rnd() * S, 2, 10 + rnd() * 40); }   // damp moss streaks
    g.fillStyle = 'rgba(12,8,4,0.7)'; g.fillRect(i * pw, 0, 2, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

export function createFootbridges(ctx) {
  const { scene, world, prepareMaterial } = ctx;
  const { geometry } = buildFootbridgeGeometry(world);
  const tex = woodTex();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.85, metalness: 0 });
  prepareMaterial(mat);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = 'footbridges'; mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  return {
    update() {},
    dispose() { mesh.removeFromParent(); geometry.dispose(); mat.dispose(); tex.dispose(); },
  };
}
