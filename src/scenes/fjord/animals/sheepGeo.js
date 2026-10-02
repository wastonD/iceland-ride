// Icelandic sheep: fluffy wool cloud (noisy blobs), small dark/pale face, thin legs, optional curled horns.
// Rest pose, +Z forward, +X left, y up, origin on the ground below the body. Wool top ~0.8 m.
import { MeshBuilder, loft, blob, ball, spline, lin } from './geo.js';
import { mulberry32 } from '../../../core/noise.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

const DY = -0.07, LS = 0.86;               // body sits lower on shorter legs (applied to the built geometry)
const NECK_PIV = [0, 0.6, 0.27];
const POLL = [0, 0.64, 0.47];
const HA = norm([0, -0.34, 0.94]);
const HB = norm([0, 0.94, 0.34]);
const EAR_L = add(add(POLL, mul(HB, 0.06)), [0.06, 0, 0]);
const EAR_R = add(add(POLL, mul(HB, 0.06)), [-0.06, 0, 0]);
const HORN_PIV = add(add(POLL, mul(HB, 0.075)), mul(HA, 0.03));
const HIP = [[0.11, 0.44, 0.24], [-0.11, 0.44, 0.24], [0.11, 0.44, -0.27], [-0.11, 0.44, -0.27]];
const dn = (v) => [v[0], v[1] + DY, v[2]];

export const SHEEP_S = {
  name: 'sheep', neck: dn(NECK_PIV), poll: dn(POLL), earL: dn(EAR_L), earR: dn(EAR_R), tail: dn([0, 0.55, -0.44]), horn: dn(HORN_PIV),
  hip: HIP.map((h) => [h[0], h[1] * LS, h[2]]), knee: HIP.map((h) => [h[0], h[1] * LS, h[2]]), twoSeg: false, kneeGainF: 0, kneeGainH: 0, legLift: 0.06, legLen: 0.44 * LS,
  hairAmp: 0.0, maneHang: 0, patchCol: [0.1, 0.075, 0.06], aoLo: 0.3, aoHi: 0.65, aoMin: 0.72, fur: 0.2, sheep: true,
};

export function buildSheep() {
  const b = new MeshBuilder();
  const rnd = mulberry32(777);
  const T_COAT = [1, 0, 0], T_PTS = [0, 0, 1], T_NONE = [0, 0, 0];
  const DARK = lin(0x14100e), NOSE = lin(0x2a1f1d), HORN = lin(0xc9b48c), HOOF = lin(0x1c1614);

  // ---- wool (part 0): cloud of lumpy blobs
  const W = [
    [[0, 0.5, -0.02], [0.26, 0.25, 0.34]], [[0, 0.53, -0.24], [0.25, 0.24, 0.24]], [[0, 0.53, 0.2], [0.23, 0.23, 0.23]],
    [[0.15, 0.47, -0.02], [0.17, 0.2, 0.26]], [[-0.15, 0.47, -0.02], [0.17, 0.2, 0.26]],
    [[0, 0.66, -0.02], [0.22, 0.16, 0.3]], [[0, 0.4, 0.0], [0.22, 0.15, 0.3]],
    [[0.13, 0.58, -0.3], [0.15, 0.16, 0.16]], [[-0.13, 0.58, -0.3], [0.15, 0.16, 0.16]],
    [[0, 0.6, 0.3], [0.17, 0.17, 0.15]], [[0.1, 0.6, 0.22], [0.12, 0.13, 0.12]], [[-0.1, 0.6, 0.22], [0.12, 0.13, 0.12]],
  ];
  W.forEach(([c, r], i) => blob(b, c, r, { part: 0, t: T_COAT, lon: 9, lat: 6, amp: 0.2, freq: 3.4, seed: i * 1.7, lump: 0.32, bottomAO: 0.32 }));

  // ---- neck (part 1) hidden mostly in the wool ruff, then head (part 2)
  loft(b, [{ p: [0, 0.6, 0.27], rx: 0.085, ry: 0.1 }, { p: [0, 0.62, 0.4], rx: 0.07, ry: 0.085 }, { p: [0, 0.64, 0.47], rx: 0.062, ry: 0.078 }],
    { n: 8, part: 1, ref: [0, 1, 0], t: T_PTS, capStart: 1 });
  const hp = (s, o) => add(add(POLL, mul(HA, s)), mul(HB, o));
  loft(b, [
    { p: hp(-0.02, 0.0), rx: 0.065, ry: 0.085, t: T_PTS },
    { p: hp(0.07, 0.005), rx: 0.078, ry: 0.098, t: T_PTS },
    { p: hp(0.16, -0.004), rx: 0.056, ry: 0.07, t: T_PTS },
    { p: hp(0.23, -0.012), rx: 0.038, ry: 0.048, t: [0, 0, 0.55], col: NOSE },
    { p: hp(0.27, -0.016), rx: 0.03, ry: 0.036, t: [0, 0, 0.2], col: NOSE },
  ], { n: 8, part: 2, ref: HB, capEnd: 2, capLen: 1, col: NOSE, t: T_PTS });
  for (const sg of [1, -1]) {
    ball(b, add(hp(0.12, 0.028), [sg * 0.062, 0, 0]), [0.015, 0.016, 0.014], { part: 2, col: DARK, t: T_NONE, lon: 6, lat: 4 });
    // ears (part 3 L / 4 R): leaf, pointing out and slightly down
    const base = sg > 0 ? EAR_L : EAR_R;
    const dir = norm([sg * 0.9, -0.12, -0.42]);
    const pts = [0, 0.5, 1].map((f) => add(base, mul(dir, 0.1 * f)));
    loft(b, pts.map((p, i) => ({ p, rx: [0.012, 0.011, 0.004][i], ry: [0.03, 0.032, 0.008][i] })), { n: 5, part: sg > 0 ? 3 : 4, ref: [0, 0, 1], t: T_PTS, capEnd: 1, capLen: 0.5, shadeFn: () => 0.95 });
    // horns (part 7): curl back, out and forward
    const B = add(HORN_PIV, [sg * 0.035, 0, 0]);
    const rel = [[0, 0, 0], [0.018, 0.045, -0.02], [0.05, 0.085, -0.05], [0.09, 0.098, -0.09], [0.12, 0.07, -0.105], [0.13, 0.02, -0.08], [0.118, -0.018, -0.03], [0.1, -0.03, 0.02]];
    const path = spline(rel.map((r) => add(B, [sg * r[0], r[1], r[2]])), 9);
    loft(b, path.map((p, i) => { const u = i / 8; return { p, rx: 0.03 * (1 - 0.8 * u) + 0.005, ry: 0.03 * (1 - 0.8 * u) + 0.005 }; }), { n: 5, part: 7, ref: [0, 1, 0], t: T_NONE, col: HORN, capEnd: 1, capLen: 0.6 });
  }
  // woolly forehead tuft (moves with the head)
  blob(b, hp(0.02, 0.085), [0.055, 0.04, 0.06], { part: 2, t: T_COAT, lon: 7, lat: 4, amp: 0.25, seed: 41, lump: 0.3, bottomAO: 0 });

  // ---- legs (single joint; part 10 FL, 12 FR, 14 HL, 16 HR)
  for (let li = 0; li < 4; li++) {
    const h = HIP[li], part = 10 + li * 2;
    loft(b, [
      { p: [h[0], 0.44, h[2]], rx: 0.055, ry: 0.06, t: T_PTS },
      { p: [h[0], 0.3, h[2] + 0.005], rx: 0.036, ry: 0.038, t: T_PTS },
      { p: [h[0], 0.12, h[2] + 0.005], rx: 0.028, ry: 0.032, t: T_PTS },
      { p: [h[0], 0.05, h[2] + 0.01], rx: 0.034, ry: 0.04, t: T_NONE, col: HOOF },
      { p: [h[0], 0.0, h[2] + 0.018], rx: 0.036, ry: 0.048, t: T_NONE, col: HOOF },
    ], { n: 6, part, ref: [0, 0, 1], t: T_PTS, capEnd: 1, capLen: 0.3, col: HOOF });
  }
  // ---- tail (part 20): little wool tail
  blob(b, [0, 0.52, -0.47], [0.07, 0.11, 0.06], { part: 20, t: T_COAT, lon: 7, lat: 5, amp: 0.2, seed: 5, lump: 0.25, sway: 0.0, bottomAO: 0.2 });
  const geometry = b.build();
  const pos = geometry.attributes.position, aA = geometry.attributes.aA;
  for (let i = 0; i < pos.count; i++) {
    const part = Math.round(aA.getX(i));
    pos.setY(i, part >= 10 && part < 20 ? pos.getY(i) * LS : pos.getY(i) + DY);
  }
  geometry.computeBoundingSphere();
  return { geometry, S: SHEEP_S };
}
