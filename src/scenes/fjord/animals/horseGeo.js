// Icelandic horse: short, stocky, thick neck, big fluffy mane and long tail.
// Rest pose, +Z forward, +X left, y up, origin on the ground below the barrel centre. Height at the withers ~1.25 m.
import { MeshBuilder, loft, lock, ball, spline, lin } from './geo.js';
import { mulberry32 } from '../../../core/noise.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const YS = 0.94;                            // final vertical squash: stockier, shorter legs
const TH = 1.14;                            // bone / leg thickness factor
const HS = 1.1;                             // head size factor
const H0 = [0, 1.5, 0.99];                 // poll (head pivot)
const HA = norm([0, -0.766, 0.643]);       // head axis (down-forward)
const HB = norm([0, 0.643, 0.766]);        // head "up"
const NECK_PIV = [0, 1.06, 0.5];
const TAIL_PIV = [0, 1.25, -0.66];
const EAR = { l: add(add(add(H0, mul(HA, 0.02)), mul(HB, 0.135 * HS)), [0.05, 0, 0]), r: add(add(add(H0, mul(HA, 0.02)), mul(HB, 0.135 * HS)), [-0.05, 0, 0]) };
const HIP = [[0.155, 0.96, 0.44], [-0.155, 0.96, 0.44], [0.17, 0.98, -0.46], [-0.17, 0.98, -0.46]];
const KNEE = [[0.145, 0.47, 0.45], [-0.145, 0.47, 0.45], [0.14, 0.52, -0.56], [-0.14, 0.52, -0.56]];
const sy = (v) => [v[0], v[1] * YS, v[2]];

export const HORSE_S = {
  name: 'horse', neck: sy(NECK_PIV), poll: sy(H0), earL: sy(EAR.l), earR: sy(EAR.r), tail: sy(TAIL_PIV), horn: [0, 0, 0],
  hip: HIP.map(sy), knee: KNEE.map(sy), twoSeg: true, kneeGainF: 1.9, kneeGainH: 1.6, legLift: 0, legLen: 0.95 * YS,
  hairAmp: 1.0, maneHang: 0.22, patchCol: [0.86, 0.84, 0.78], aoLo: 0.5, aoHi: 1.1, aoMin: 0.7, fur: 0.10,
};

export function buildHorse() {
  const b = new MeshBuilder();
  const rnd = mulberry32(1234);
  const T_COAT = [1, 0, 0], T_MANE = [0, 1, 0], T_PTS = [0, 0, 1], T_NONE = [0, 0, 0];
  const HOOF = lin(0x2a2320), DARK = lin(0x1a1412), MUZ = lin(0x3a2c28);

  // ---- barrel + rump + chest (one smooth loft)
  const body = [
    { p: [0, 0.98, -0.70], rx: 0.17, ry: 0.21 },
    { p: [0, 1.01, -0.55], rx: 0.265, ry: 0.295 },
    { p: [0, 1.0, -0.33], rx: 0.285, ry: 0.32 },
    { p: [0, 0.985, -0.1], rx: 0.275, ry: 0.31 },
    { p: [0, 0.965, 0.12], rx: 0.295, ry: 0.34 },
    { p: [0, 0.97, 0.32], rx: 0.295, ry: 0.355 },
    { p: [0, 0.95, 0.52], rx: 0.26, ry: 0.34 },
    { p: [0, 0.93, 0.66], rx: 0.19, ry: 0.28 },
  ];
  loft(b, body, { n: 14, part: 0, t: T_COAT, capStart: 3, capEnd: 3, shadeFn: (c, s) => 0.8 + 0.2 * ss(-0.9, 0.4, s) });

  // ---- neck (part 1)
  const neckSec = (u) => {
    const p = [0, lerp(1.1, 1.5, u) + 0.035 * Math.sin(Math.PI * u), lerp(0.46, 0.99, u)];
    return { p, rx: lerp(0.165, 0.105, Math.pow(u, 0.8)), ry: lerp(0.26, 0.16, u) };
  };
  loft(b, [0, 0.33, 0.66, 1].map((u) => neckSec(u)), { n: 10, part: 1, t: T_COAT, capStart: 2, ref: [0, 1, 0] });

  // ---- head (part 2)
  const hp = (s, o) => add(add(H0, mul(HA, s * HS)), mul(HB, o * HS));
  const headSecs = [
    { s: -0.04, o: 0.02, rx: 0.085, ry: 0.125, t: T_COAT },
    { s: 0.06, o: 0.02, rx: 0.102, ry: 0.142, t: T_COAT },
    { s: 0.20, o: 0.008, rx: 0.086, ry: 0.112, t: T_COAT },
    { s: 0.33, o: -0.005, rx: 0.066, ry: 0.084, t: [0.55, 0, 0], col: MUZ },
    { s: 0.43, o: -0.01, rx: 0.062, ry: 0.07, t: [0.25, 0, 0], col: MUZ },
    { s: 0.49, o: -0.014, rx: 0.056, ry: 0.062, t: [0.1, 0, 0], col: MUZ },
  ].map((h) => ({ p: hp(h.s, h.o), rx: h.rx * HS, ry: h.ry * HS, t: h.t, col: h.col }));
  loft(b, headSecs, { n: 10, part: 2, ref: HB, capEnd: 2, capLen: 1.0, col: MUZ });
  for (const sg of [1, -1]) {
    ball(b, add(hp(0.17, 0.045), [sg * 0.083 * HS, 0, 0]), [0.023, 0.024, 0.022], { part: 2, col: DARK, t: T_NONE, lon: 7, lat: 5 });
    ball(b, add(hp(0.505, -0.004), [sg * 0.03 * HS, 0, 0]), [0.012, 0.011, 0.012], { part: 2, col: DARK, t: T_NONE, lon: 5, lat: 3 });
  }

  // ---- ears (part 3 left / 4 right)
  for (const sg of [1, -1]) {
    const base = sg > 0 ? EAR.l : EAR.r;
    const dir = norm([sg * 0.22, 0.95, 0.30]);
    const pts = [0, 0.4, 1].map((f) => add(base, mul(dir, 0.14 * f)));
    loft(b, pts.map((p, i) => ({ p, rx: [0.02, 0.017, 0.004][i], ry: [0.036, 0.03, 0.006][i] })), { n: 6, part: sg > 0 ? 3 : 4, ref: [0, 0, 1], t: T_COAT, capEnd: 1, capLen: 0.5, shadeFn: () => 0.95 });
  }

  // ---- mane (part 5): crest roll + many fluffy locks that fall to both sides (root of each lock stored in `color`)
  const up = [0, 1, 0];
  const crestAt = (u) => {
    const s0 = neckSec(Math.max(0, u - 0.02)), s1 = neckSec(Math.min(1, u + 0.02));
    const s = neckSec(u);
    const tan = norm([s1.p[0] - s0.p[0], s1.p[1] - s0.p[1], s1.p[2] - s0.p[2]]);
    const vup = norm([up[0] - tan[0] * dotp(up, tan), up[1] - tan[1] * dotp(up, tan), up[2] - tan[2] * dotp(up, tan)]);
    return { c: add(s.p, mul(vup, s.ry * 0.9)), tan, vup, rx: s.rx };
  };
  {
    const secs = [];
    for (let i = 0; i <= 6; i++) { const u = 0.03 + i / 6 * 0.97; const cr = crestAt(u); const p = add(cr.c, mul(cr.vup, 0.01)); secs.push({ p, rx: 0.06, ry: 0.045, col: p }); }
    loft(b, secs, { n: 8, part: 5, ref: [1, 0, 0], t: T_MANE, capStart: 2, capEnd: 2, shade: 0.9 });
  }
  const NM = 34;
  for (let i = 0; i < NM + 12; i++) {
    const short = i >= NM;                                   // extra short, fluffy tufts standing up along the crest
    const u = short ? 0.05 + rnd() * 0.93 : 0.02 + (i / (NM - 1)) * 0.98 + (rnd() - 0.5) * 0.02;
    const cr = crestAt(Math.min(1, Math.max(0, u)));
    const sg = i % 2 ? 1 : -1;
    const L = short ? 0.14 + rnd() * 0.08 : (0.24 + rnd() * 0.26) * (1 - 0.1 * u);
    const s = [sg, 0, 0], g = [0, -1, 0];
    const wob = (rnd() - 0.5) * 0.05, back = -0.02 - rnd() * 0.07 - (short ? 0.02 : 0);
    const ctrl = [
      cr.c,
      add(cr.c, mul(cr.vup, short ? 0.07 : 0.05)),
      add(add(cr.c, mul(cr.vup, short ? 0.07 : 0.04)), mul(s, cr.rx * 0.6 + 0.03 + (short ? 0.02 : 0))),
      add(add(add(cr.c, mul(s, cr.rx + 0.05 + wob)), mul(g, L * 0.35)), mul(cr.tan, back * 0.4)),
      add(add(add(cr.c, mul(s, cr.rx + 0.065 + wob)), mul(g, L * 0.7)), mul(cr.tan, back * 0.8)),
      add(add(add(cr.c, mul(s, cr.rx + 0.06 + wob * 2)), mul(g, L)), mul(cr.tan, back * 1.2 - rnd() * 0.03)),
    ];
    lock(b, spline(ctrl, 6), short ? 0.05 : 0.055 + rnd() * 0.04, short ? 0.03 : 0.03, { part: 5, phase: rnd(), shade: 0.78 + rnd() * 0.36, ref: norm([1, (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7]), root: cr.c });
  }
  // forelock (moves with the head)
  for (let i = 0; i < 5; i++) {
    const st = add(add(add(H0, mul(HA, 0.02)), mul(HB, 0.15 * HS)), [(rnd() - 0.5) * 0.06, 0, 0]);
    const x = (rnd() - 0.5) * 0.06;
    const ctrl = [st, add(st, add(mul(HB, 0.03), mul(HA, 0.05))), add(add(st, mul(HA, 0.15)), add(mul(HB, -0.005), [x, 0, 0])), add(add(st, mul(HA, 0.25)), add(mul(HB, -0.07), [x * 1.6, 0, 0]))];
    lock(b, spline(ctrl, 4), 0.03, 0.02, { part: 2, phase: rnd(), shade: 0.85 + rnd() * 0.25, ref: [1, 0, 0] });
  }

  // ---- tail (part 20): thick, long, reaching almost to the ground
  loft(b, [
    { p: [0, 1.2, -0.6], rx: 0.05, ry: 0.055 }, { p: [0, 1.19, -0.7], rx: 0.055, ry: 0.06 }, { p: [0, 1.12, -0.77], rx: 0.055, ry: 0.055 },
  ], { n: 8, part: 20, ref: [0, 1, 0], t: T_COAT, capStart: 2, capEnd: 2, shade: 0.9 });
  const NT = 30;
  for (let i = 0; i < NT; i++) {
    const x0 = (rnd() - 0.5) * 0.14, y0 = (rnd() - 0.5) * 0.06, z0 = (rnd() - 0.5) * 0.09;
    const st = [x0 * 0.6, 1.17 + y0 * 0.6, -0.68 + z0 * 0.3];
    const yEnd = 0.14 + rnd() * 0.16, xs = x0 * (1.3 + rnd() * 0.8);
    const ctrl = [
      st,
      [st[0] + x0 * 0.3, st[1] - 0.01, -0.78 + z0 * 0.5],
      [xs * 0.5, 1.04 + y0 * 0.5, -0.88 - rnd() * 0.03 + z0],
      [xs * 0.9, 0.9, -0.95 - rnd() * 0.04 + z0],
      [xs * 1.1, 0.68, -0.99 - rnd() * 0.05 + z0 * 1.2],
      [xs * 1.2 + (rnd() - 0.5) * 0.06, lerp(0.68, yEnd, 0.6), -0.99 - rnd() * 0.06 + z0 * 1.3],
      [xs * 1.3 + (rnd() - 0.5) * 0.08, yEnd, -0.96 - rnd() * 0.07 + z0 * 1.3],
    ];
    lock(b, spline(ctrl, 7), 0.066 + rnd() * 0.03, 0.05, { part: 20, phase: rnd(), shade: 0.78 + rnd() * 0.34, ref: norm([1, (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.5]) });
  }

  // ---- legs: part 10/11 FL, 12/13 FR, 14/15 HL, 16/17 HR
  for (const sg of [1, -1]) {
    const li = sg > 0 ? 0 : 1;
    const X = (x) => sg * x;
    // front
    loft(b, [
      { p: [X(0.155), 1.0, 0.44], rx: 0.125 * TH, ry: 0.135 * TH }, { p: [X(0.15), 0.8, 0.445], rx: 0.078 * TH, ry: 0.092 * TH }, { p: [X(0.145), 0.47, 0.45], rx: 0.058 * TH, ry: 0.064 * TH },
    ], { n: 8, part: 10 + li * 2, ref: [0, 0, 1], t: T_COAT });
    const lowF = [
      [0.47, 0.058, 0.062, 0.45, T_COAT], [0.38, 0.044, 0.054, 0.45, [0.6, 0, 0.4]], [0.18, 0.042, 0.052, 0.45, T_PTS],
      [0.105, 0.052, 0.058, 0.455, T_PTS], [0.07, 0.042, 0.048, 0.468, T_PTS],
    ].map(([y, rx, ry, z, t]) => ({ p: [X(0.145), y, z], rx: rx * TH, ry: ry * TH, t }));
    lowF.push({ p: [X(0.145), 0.048, 0.48], rx: 0.054 * TH, ry: 0.064 * TH, t: T_NONE, col: HOOF }, { p: [X(0.145), 0.0, 0.495], rx: 0.064 * TH, ry: 0.078 * TH, t: T_NONE, col: HOOF });
    loft(b, lowF, { n: 8, part: 11 + li * 2, ref: [0, 0, 1], capStart: 2, capEnd: 1, capLen: 0.6, col: HOOF });
    // hind
    loft(b, [
      { p: [X(0.18), 1.0, -0.44], rx: 0.15 * TH, ry: 0.185 * TH }, { p: [X(0.165), 0.76, -0.5], rx: 0.095 * TH, ry: 0.125 * TH }, { p: [X(0.14), 0.52, -0.56], rx: 0.062 * TH, ry: 0.085 * TH },
    ], { n: 8, part: 14 + li * 2, ref: [0, 0, 1], t: T_COAT });
    const lowH = [
      [0.52, 0.058, 0.078, -0.56, T_COAT], [0.42, 0.044, 0.06, -0.555, [0.55, 0, 0.45]], [0.2, 0.042, 0.054, -0.535, T_PTS],
      [0.105, 0.052, 0.06, -0.52, T_PTS], [0.07, 0.042, 0.049, -0.508, T_PTS],
    ].map(([y, rx, ry, z, t]) => ({ p: [X(0.14), y, z], rx: rx * TH, ry: ry * TH, t }));
    lowH.push({ p: [X(0.14), 0.048, -0.49], rx: 0.054 * TH, ry: 0.064 * TH, t: T_NONE, col: HOOF }, { p: [X(0.14), 0.0, -0.475], rx: 0.064 * TH, ry: 0.078 * TH, t: T_NONE, col: HOOF });
    loft(b, lowH, { n: 8, part: 15 + li * 2, ref: [0, 0, 1], capStart: 2, capEnd: 1, capLen: 0.6, col: HOOF });
  }

  // vertical squash (positions, normals) - also the mane roots stored in the colour attribute
  const geometry = b.build();
  geometry.scale(1, YS, 1);
  const col = geometry.attributes.color, aA = geometry.attributes.aA;
  for (let i = 0; i < col.count; i++) if (Math.round(aA.getX(i)) === 5) col.setY(i, col.getY(i) * YS);
  return { geometry, S: HORSE_S };
}
