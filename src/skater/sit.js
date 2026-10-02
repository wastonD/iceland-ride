// "Sit down and enjoy the view": blends the riding pose into a seated pose.
//
//   sitPose(out, ride, s, mode, look)   // s = ride.sitting (0..1), mode = 'board' | 'ground'
//
// 'board': sits on the parked deck facing the nose — front (left) leg stretched out past the
//          nose, rear (right) knee up with the foot flat on the deck, hands propped on the tail,
//          head tilted up a little. First-person friendly: legs + board are in front of the eyes.
// 'ground': steps off to the board's left side and sits on the ground hugging the knees.
// The transition is keyed on s (step the rear foot forward → turn → squat with the hands
// reaching back → settle and slide the feet out); standing up plays it in reverse.
// Everything is rig space (see pose.js).

import * as THREE from 'three';
import { smoothstep, clamp } from '../core/noise.js';
import { GROUND } from './board.js';
import { qEuler } from './pose.js';

const V3 = THREE.Vector3;
const Q = THREE.Quaternion;
const GY = -GROUND;
const deckKick = (z) => 0.030 * Math.pow(smoothstep(0.29, 0.5, Math.abs(z)), 1.6);

const tv = [new V3(), new V3(), new V3(), new V3(), new V3()];
const tq = [new Q(), new Q(), new Q(), new Q(), new Q()];
const vA = new V3(), qA = new Q();

/** Keyed vector path: keys = [[s, V3], ...] ascending; smoothstep between keys; optional lift arc. */
function pathV(out, keys, s, lift = null) {
  if (s <= keys[0][0]) return out.copy(keys[0][1]);
  for (let i = 0; i < keys.length - 1; i++) {
    const [s0, a] = keys[i], [s1, b] = keys[i + 1];
    if (s <= s1) {
      const u = smoothstep(s0, s1, s);
      out.lerpVectors(a, b, u);
      if (lift && lift[i]) out.y += lift[i] * Math.sin(Math.PI * u);
      return out;
    }
  }
  return out.copy(keys[keys.length - 1][1]);
}
function pathQ(out, keys, s) {
  if (s <= keys[0][0]) return out.copy(keys[0][1]);
  for (let i = 0; i < keys.length - 1; i++) {
    const [s0, a] = keys[i], [s1, b] = keys[i + 1];
    if (s <= s1) return out.copy(a).slerp(b, smoothstep(s0, s1, s));
  }
  return out.copy(keys[keys.length - 1][1]);
}

// fixed key poses (allocated once)
const K = {
  pel: [new V3(), new V3(), new V3(), new V3()],
  qP: [new Q(), new Q(), new Q(), new Q()],
  qC: [new Q(), new Q(), new Q(), new Q()],
  qH: [new Q(), new Q(), new Q()],
  hand: [[new V3(), new V3(), new V3()], [new V3(), new V3(), new V3()]],
  ank: [[new V3(), new V3(), new V3()], [new V3(), new V3(), new V3()]],
  qF: [[new Q(), new Q()], [new Q(), new Q()]],
};

/**
 * out: pose to write (must NOT alias `ride`); ride: riding pose; s: 0..1; mode; look: {yaw, pitch, breath}.
 */
export function sitPose(out, ride, s, mode, look) {
  s = clamp(s, 0, 1);
  if (s <= 0) return out;
  const ground = mode === 'ground';
  const br = look.breath;
  const ox = ground ? 0.56 : 0;               // ground: sit beside the board (its left side)
  const oz = ground ? -0.02 : 0;

  // ---- final seated pose ----------------------------------------------------------
  const pelF = tv[0].set(ox, ground ? GY + 0.125 : 0.118, ground ? oz : -0.16);
  pelF.y += 0.002 * br;
  const qPF = qEuler(tq[0], ground ? 0.05 : -0.32, look.yaw * 0.08, 0);
  const qCF = qEuler(tq[1], (ground ? 0.12 : -0.42) - 0.022 * br, look.yaw * 0.25, 0);
  const qHF = qEuler(tq[2], (ground ? -0.06 : -0.1) + look.pitch + 0.012 * br, look.yaw, 0);

  // ---- key poses --------------------------------------------------------------------
  // pelvis: stand → slight knee bend → squat down/back → land → settle
  K.pel[0].copy(ride.pelvis);
  K.pel[1].set(ox * 0.45, 0.80, 0.0);
  K.pel[2].set(ox * 0.9, ground ? 0.12 : 0.30, ground ? oz + 0.05 : -0.08);
  K.pel[3].copy(pelF);
  pathV(out.pelvis, [[0, K.pel[0]], [0.3, K.pel[1]], [0.68, K.pel[2]], [1, K.pel[3]]], s);

  K.qP[0].copy(ride.qP); qEuler(K.qP[1], 0.12, 0, 0); qEuler(K.qP[2], 0.38, 0, 0); K.qP[3].copy(qPF);
  pathQ(out.qP, [[0, K.qP[0]], [0.32, K.qP[1]], [0.66, K.qP[2]], [1, K.qP[3]]], s);
  K.qC[0].copy(ride.qC); qEuler(K.qC[1], 0.2, 0, 0); qEuler(K.qC[2], 0.5, 0, 0); K.qC[3].copy(qCF);
  pathQ(out.qC, [[0, K.qC[0]], [0.32, K.qC[1]], [0.66, K.qC[2]], [1, K.qC[3]]], s);
  // head: glances down at where it sits, then up at the view
  K.qH[0].copy(ride.qH); qEuler(K.qH[1], 0.45, 0, 0); K.qH[2].copy(qHF);
  pathQ(out.qH, [[0, K.qH[0]], [0.55, K.qH[1]], [1, K.qH[2]]], s);

  for (let i = 0; i < 2; i++) {
    const si = i === 0 ? 1 : -1;
    // hands: reach out/back, then prop on the tail (board) / wrap the knees (ground)
    const H = K.hand[i];
    H[0].set(ox + si * 0.32, 0.42, -0.02);
    if (ground) {
      H[1].set(ox + si * 0.14, 0.28, 0.2);
      H[2].set(ox + si * 0.035, GY + 0.33 + 0.004 * br, oz + 0.27);
    } else {
      H[1].set(si * 0.13, 0.11, -0.40);
      H[2].set(si * 0.088, deckKick(-0.43) + 0.03, -0.43);
    }
    pathV(out.hand[i], [[0, vA.copy(ride.hand[i])], [0.45, H[0]], [0.8, H[1]], [1, H[2]]], s);
    // elbows: from the riding pole → pointing back (propped) / out (hugging)
    tv[3].set(si * (ground ? 1 : 0.45), ground ? 0.1 : 0.15, ground ? 0.1 : -1).normalize();
    out.elbowPole[i].copy(ride.elbowPole[i]).lerp(tv[3], smoothstep(0.3, 0.8, s)).normalize();

    // feet
    const A = K.ank[i], F = K.qF[i];
    if (ground) {
      A[0].set(ox * 0.6 + si * 0.12, GY + 0.08, i === 0 ? 0.12 : -0.08);
      A[1].set(ox + si * 0.13, GY + 0.08, A[0].z * 0.5 + 0.06);
      A[2].set(ox + si * 0.10, GY + 0.08, oz + 0.29);
      qEuler(F[0], 0, si * 0.12, 0);
      qEuler(F[1], 0, si * 0.15, 0);
    } else if (i === 0) {   // front foot: turns to the nose, then slides out past it (heel down, toes up)
      A[0].set(0.1, 0.08, 0.17);
      A[1].set(0.1, 0.08, 0.2);
      A[2].set(0.12, -0.022, 0.66);
      qEuler(F[0], 0, 0.1, 0);
      qEuler(F[1], -0.95, 0.28, 0);
    } else {                 // rear foot: steps forward beside it, ends flat on the deck, knee up
      A[0].set(-0.075, 0.08, 0.04);
      A[1].set(-0.08, 0.08, 0.10);
      A[2].set(-0.078, 0.081 + deckKick(0.2), 0.2);
      qEuler(F[0], 0, -0.1, 0);
      qEuler(F[1], 0, -0.16, 0);
    }
    const t0 = i === 0 ? 0.12 : 0.0, t1 = i === 0 ? 0.38 : 0.3;
    // (out must not alias ride)
    const lift = [ground ? 0.08 : 0.06, ground ? 0.05 : 0, ground ? 0 : 0.03];
    if (t0 > 0) pathV(out.ankle[i], [[0, ride.ankle[i]], [t0, ride.ankle[i]], [t1, A[0]], [0.62, A[1]], [1, A[2]]], s, [0, ...lift]);
    else pathV(out.ankle[i], [[0, ride.ankle[i]], [t1, A[0]], [0.62, A[1]], [1, A[2]]], s, lift);
    pathQ(out.qFoot[i], [[0, qA.copy(ride.qFoot[i])], [t1, F[0]], [0.62, F[0]], [1, F[1]]], s);
    // knees: up (and a little out) as they fold
    tv[4].set(si * (ground ? 0.25 : i === 0 ? 0.12 : 0.3), 1, ground ? 0.5 : 0.3).normalize();
    out.kneePole[i].copy(ride.kneePole[i]).lerp(tv[4], smoothstep(0.25, 0.75, s)).normalize();
  }
  // the board just sits still
  const wb = smoothstep(0, 0.3, s);
  out.boardPos.copy(ride.boardPos).multiplyScalar(1 - wb);
  out.boardQ.copy(ride.boardQ).slerp(qA.identity(), wb);
  return out;
}
