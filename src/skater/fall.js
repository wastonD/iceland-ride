// Procedural crash: tumble (ejected, log-roll, slide) → lie → get up, fetch the board, step back on.
// Time inputs are per-phase seconds (`pt`). Everything is in rig space (see pose.js).
// The controller slides root with the body; the board flies out ahead in root-local space.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/noise.js';
import { GROUND } from './board.js';
import { qEuler, kf, easeInOut, chestPos, DIM } from './pose.js';

const GY = -GROUND;
const PI = Math.PI;
const V3 = THREE.Vector3;
export const FALL_T = { tumble: 1.8, lie: 0.8, getup: 1.8 };
const BOARD_REST = 2.4;

const vA = new V3(), vB = new V3(), vC = new V3();
const qr = new THREE.Quaternion(), qw = new THREE.Quaternion(), qe = new THREE.Euler();

/** Blend weight of the fall pose over the riding pose. */
export function fallWeight(phase, pt) {
  if (phase === 'tumble') return smoothstep(0, 0.12, pt);
  if (phase === 'lie') return 1;
  return 1 - smoothstep(1.3, 1.8, pt);
}

function liftTorso(P) {
  let d = Math.max(0, GY + 0.115 - P.pelvis.y);
  chestPos(P, vA);
  d = Math.max(d, GY + 0.13 - vA.y);
  vB.set(0, 0.30, 0).applyQuaternion(P.qC).add(vA);
  vB.addScaledVector(vC.set(0, 0.09, 0).applyQuaternion(P.qH), 1);
  d = Math.max(d, GY + 0.11 - vB.y);
  P.pelvis.y += d;
}

function bodyFrames(P, x, y, z, pitch, yaw, roll, cp, cy, cr, hp, hy) {
  P.pelvis.set(x, y, z);
  qEuler(P.qP, pitch, yaw, roll);
  qEuler(qr, cp, cy, cr);
  P.qC.copy(P.qP).multiply(qr);
  qEuler(qr, hp, hy, 0);
  P.qH.copy(P.qC).multiply(qr);
  liftTorso(P);
}

const fb = (a) => 0.0565 + 0.0445 * Math.cos(a) + 0.06 * Math.sin(a) * Math.sin(a); // origin height above ground for board rolled by a

function setBoard(P, x, y, z, pitch, yaw, roll) {
  P.boardPos.set(x, y, z);
  P.boardQ.setFromEuler(qe.set(pitch, yaw, roll, 'YXZ'));
}

function tumbleBoard(P, u, pt, s) {
  const flipped = s > 0;
  const total = flipped ? 3 * PI : 4 * PI;
  const z = BOARD_REST * (1 - Math.pow(1 - u, 2.4));
  const x = s * 0.7 * Math.pow(u, 1.2);
  const yaw = s * 1.1 * u;
  const a = s * total * (1 - Math.pow(1 - u, 2.0));
  const pitch = 0.5 * Math.sin(PI * 2 * u) * (1 - u);
  const hop = pt < 1.5 ? 0.42 * Math.exp(-2.6 * pt) * Math.abs(Math.sin((PI * pt) / 0.42)) : 0;
  setBoard(P, x, GY + fb(a) + hop, z, pitch, yaw, a);
}

function tumblePose(P, pt, s, T, lieT) {
  const flail = 1 - smoothstep(1.3, 1.75, pt);
  const pitch = kf([[0, 0.12], [0.25, 0.6], [0.5, 1.3], [1.0, 1.5], [1.8, 1.69]], pt);
  const yaw = kf([[0, -1.3], [0.3, 0], [0.5, 0]], pt) + s * PI * easeInOut((pt - 0.5) / 1.2);
  const roll = s * 3 * PI * easeInOut((pt - 0.3) / 1.4);
  const px = s * 0.12 * easeInOut(pt / 0.8);
  const py = kf([[0, 0.88], [0.2, 0.95], [0.5, 0.30], [0.9, 0.10], [1.8, 0.05]], pt);
  const pz = kf([[0, 0], [0.5, 0.45], [1.0, 0.35], [1.8, 0.25]], pt);
  const cp = kf([[0, 0], [0.4, -0.25], [0.9, 0.35], [1.8, 0.0]], pt) + 0.04 * Math.sin(lieT * 2.4);
  const cy = 0.25 * Math.sin(pt * 5) * flail;
  const cr = 0.2 * Math.sin(pt * 4 + 1) * flail;
  const hp = kf([[0, 0], [0.3, -0.35], [1.0, 0.25], [1.8, 0.0]], pt);
  const hy = 0.5 * Math.sin(pt * 3.3) * flail + 0.3 * Math.sin(lieT * 0.9);
  bodyFrames(P, px, py, pz, pitch, yaw, roll, cp, cy, cr, hp, hy);

  const dive = 1 - smoothstep(0.35, 0.6, pt);
  const lie = smoothstep(1.3, 1.75, pt);
  const fl = Math.max(0, 1 - dive - lie);
  const wp = smoothstep(0.18, 0.32, pt) * (1 - smoothstep(0.42, 0.6, pt)); // hands planted
  chestPos(P, vA);
  for (let i = 0; i < 2; i++) {
    const si = i === 0 ? 1 : -1;
    // arms (chest frame)
    const hx = dive * si * 0.20 + fl * si * (0.42 + 0.10 * Math.sin(7 * pt + i)) + lie * si * 0.28;
    const hy2 = dive * 0.10 + fl * (0.05 + 0.28 * Math.sin(6 * pt + 1.7 * i)) + lie * -0.36;
    const hz = dive * 0.58 + fl * (0.15 + 0.30 * Math.cos(5 * pt + i)) + lie * 0.12;
    P.hand[i].set(hx, hy2, hz).applyQuaternion(P.qC).add(vA);
    P.hand[i].x = lerp(P.hand[i].x, si * 0.25, wp);
    P.hand[i].y = lerp(P.hand[i].y, GY + 0.035, wp);
    P.hand[i].z = lerp(P.hand[i].z, 0.62, wp);
    P.hand[i].y = Math.max(P.hand[i].y, GY + 0.04);
    P.elbowPole[i].set(si * 0.6, -0.2, -0.7).applyQuaternion(P.qC);
    // legs (pelvis frame)
    const ax = dive * si * 0.14 + fl * (si * 0.16 + 0.05 * Math.sin(5 * pt + i)) + lie * si * 0.11;
    const ay = dive * -0.62 + fl * (-0.45 - 0.2 * Math.sin(6 * pt + 2 * i)) + lie * -0.80;
    const az = dive * -0.28 + fl * (-0.18 + 0.15 * Math.sin(5 * pt + i)) + lie * 0.06;
    P.ankle[i].set(ax, ay, az).applyQuaternion(P.qP).add(P.pelvis);
    P.ankle[i].y = Math.max(P.ankle[i].y, GY + 0.075);
    qEuler(qr, 0.5, si * 0.15, 0);
    P.qFoot[i].copy(P.qP).multiply(qr);
    P.kneePole[i].set(si * 0.3, 0.1, 1).applyQuaternion(P.qP);
  }
  tumbleBoard(P, clamp(pt / 1.5, 0, 1), pt, s);
}

function getupPose(P, g, s, T) {
  g = clamp(g, 0, FALL_T.getup);
  const px = s * 0.12 * (1 - easeInOut((g - 0.9) / 0.4));
  const pz = kf([[0, 0.25], [0.9, 0.27], [1.3, 0.55]], g);
  const py = kf([[0, 0.02], [0.55, 0.02], [0.8, 0.40], [1.0, 0.70], [1.3, 0.86]], g);
  const pitch = kf([[0, -1.45], [0.55, -1.15], [1.0, 0.30], [1.8, 0.2]], g);
  const cp = kf([[0, 0], [0.55, 1.1], [1.0, -0.1], [1.8, 0]], g);
  const hp = kf([[0, 0], [0.55, -0.4], [1.0, -0.2], [1.8, 0]], g);
  bodyFrames(P, px, py, pz, pitch, 0, 0, cp, 0, 0, hp, 0);

  const v = clamp((g - 0.95) / 0.35, 0, 1);
  const gait = Math.sin(PI * 2 * v);
  const fw = smoothstep(0.55, 0.85, g);
  const pull = smoothstep(0.55, 0.95, g);
  const feetZ = lerp(pz + 0.75, pz + 0.05, pull);
  const hw = smoothstep(0.05, 0.3, g) * (1 - smoothstep(0.55, 0.8, g));
  chestPos(P, vA);
  for (let i = 0; i < 2; i++) {
    const si = i === 0 ? 1 : -1;
    // arms: local relaxed/swinging vs planted behind the hips
    P.hand[i].set(si * 0.27, -0.35, 0.10 + 0.18 * Math.sin(PI * 2 * v + i * PI) * smoothstep(0.7, 1.0, g)).applyQuaternion(P.qC).add(vA);
    vB.set(si * 0.24, GY + 0.04, pz - 0.22);
    P.hand[i].lerp(vB, hw);
    P.hand[i].y = Math.max(P.hand[i].y, GY + 0.04);
    P.elbowPole[i].set(si * 0.6, -0.2, -0.7).applyQuaternion(P.qC);
    // feet: sitting (pelvis frame) → planted → gait
    vB.set(si * 0.11, -0.80, 0.06).applyQuaternion(P.qP).add(P.pelvis);
    const ph = i === 0 ? 0 : PI;
    const zStep = (i === 0 ? 0.12 : -0.12) + 0.20 * Math.sin(PI * 2 * v + ph) * smoothstep(0.9, 1.0, g);
    const lift = 0.10 * Math.max(0, Math.cos(PI * 2 * v + ph)) * smoothstep(0.9, 1.0, g) * (1 - smoothstep(1.3, 1.4, g));
    vC.set(si * 0.11, GY + 0.08 + lift, feetZ + zStep);
    P.ankle[i].lerpVectors(vB, vC, fw);
    P.ankle[i].y = Math.max(P.ankle[i].y, GY + 0.075);
    qEuler(qr, 0.5, si * 0.15, 0);
    qw.copy(P.qP).multiply(qr);
    qEuler(qr, 0.0, si * -0.15, 0);
    P.qFoot[i].copy(qw).slerp(qr, fw);
    P.kneePole[i].set(si * 0.3, 0.1, 1).applyQuaternion(P.qP).lerp(vA.set(si * 0.15, 0.2, 1), fw);
    chestPos(P, vA);
  }
  // board: rests ahead, gets pulled back and flipped upright
  const flipped = s > 0;
  const zb = lerp(BOARD_REST, 0.85, easeInOut((g - 0.5) / 0.7));
  const xb = lerp(s * 0.7, 0, easeInOut((g - 0.5) / 0.8));
  const yawb = lerp(s * 1.1, 0, easeInOut((g - 0.8) / 0.6));
  const fu = clamp((g - 1.0) / 0.3, 0, 1);
  const a = (flipped ? 3 * PI : 4 * PI) * s + (flipped ? s * PI * easeInOut(fu) : 0);
  const hop = flipped ? 0.22 * Math.sin(PI * fu) : 0;
  setBoard(P, xb, GY + fb(a) + hop, zb, 0, yawb, a);
}

/** Fill P with the fall pose for (phase, per-phase time pt). */
export function fallPose(P, phase, pt, side, T) {
  const s = side >= 0 ? 1 : -1;
  if (phase === 'getup') getupPose(P, pt, s, T);
  else if (phase === 'lie') tumblePose(P, FALL_T.tumble, s, T, pt);
  else tumblePose(P, clamp(pt, 0, FALL_T.tumble), s, T, 0);
}
