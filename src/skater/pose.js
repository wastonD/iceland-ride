// Pose container + small helpers shared by the riding and fall animators.
// Everything is expressed in "rig space" (board space at rest: origin = deck top
// centre, +Z = nose, +Y = up, ground at y = -GROUND).
//
// Index convention for two-sided arrays: 0 = left (+X in rest pose), 1 = right.

import * as THREE from 'three';
import { clamp, smoothstep } from '../core/noise.js';

const V3 = THREE.Vector3;
const Q = THREE.Quaternion;
const _e = new THREE.Euler();
const _q = new Q();

export const DIM = { spine: 0.12, chest: 0.20, shoulderX: 0.19, shoulderY: 0.17, hipX: 0.09, neck: 0.24 };

/** out = Rz(roll) * Ry(yaw) * Rx(pitch) */
export const qEuler = (out, pitch, yaw, roll = 0) => out.setFromEuler(_e.set(pitch, yaw, roll, 'ZYX'));

export function makePose() {
  return {
    pelvis: new V3(),
    qP: new Q(), qC: new Q(), qH: new Q(),
    hand: [new V3(), new V3()],
    elbowPole: [new V3(0, 0, -1), new V3(0, 0, -1)],
    ankle: [new V3(), new V3()],
    kneePole: [new V3(0, 0, 1), new V3(0, 0, 1)],
    qFoot: [new Q(), new Q()],
    boardPos: new V3(),
    boardQ: new Q(),
  };
}

export function copyPose(d, s) {
  d.pelvis.copy(s.pelvis);
  d.qP.copy(s.qP); d.qC.copy(s.qC); d.qH.copy(s.qH);
  for (let i = 0; i < 2; i++) {
    d.hand[i].copy(s.hand[i]); d.elbowPole[i].copy(s.elbowPole[i]);
    d.ankle[i].copy(s.ankle[i]); d.kneePole[i].copy(s.kneePole[i]); d.qFoot[i].copy(s.qFoot[i]);
  }
  d.boardPos.copy(s.boardPos); d.boardQ.copy(s.boardQ);
  return d;
}

/** out = a + (b - a) * w  (out may alias a) */
export function blendPose(out, a, b, w) {
  out.pelvis.lerpVectors(a.pelvis, b.pelvis, w);
  out.qP.copy(a.qP).slerp(b.qP, w);
  out.qC.copy(a.qC).slerp(b.qC, w);
  out.qH.copy(a.qH).slerp(b.qH, w);
  for (let i = 0; i < 2; i++) {
    out.hand[i].lerpVectors(a.hand[i], b.hand[i], w);
    out.elbowPole[i].lerpVectors(a.elbowPole[i], b.elbowPole[i], w);
    out.ankle[i].lerpVectors(a.ankle[i], b.ankle[i], w);
    out.kneePole[i].lerpVectors(a.kneePole[i], b.kneePole[i], w);
    out.qFoot[i].copy(a.qFoot[i]).slerp(b.qFoot[i], w);
  }
  out.boardPos.lerpVectors(a.boardPos, b.boardPos, w);
  out.boardQ.copy(a.boardQ).slerp(b.boardQ, w);
  return out;
}

export function spinePos(P, out) {
  return out.set(0, DIM.spine, 0).applyQuaternion(P.qP).add(P.pelvis);
}
const _sq = new Q();
export function chestPos(P, out) {
  spinePos(P, out);
  _sq.copy(P.qP).slerp(P.qC, 0.5);
  return out.add(_tmp.set(0, DIM.chest, 0).applyQuaternion(_sq));
}
const _tmp = new V3();
/** i: 0 left, 1 right */
export function shoulderPos(P, i, out) {
  chestPos(P, out);
  const s = i === 0 ? 1 : -1;
  return out.add(_tmp.set(s * DIM.shoulderX, DIM.shoulderY, 0).applyQuaternion(P.qC));
}
export function hipPos(P, i, out) {
  const s = i === 0 ? 1 : -1;
  return out.set(s * DIM.hipX, 0, 0).applyQuaternion(P.qP).add(P.pelvis);
}

/** Smooth keyframe curve: keys = [[t, v], ...] ascending, smoothstep between keys. */
export function kf(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = smoothstep(t0, t1, t);
      return v0 + (v1 - v0) * u;
    }
  }
  return keys[keys.length - 1][1];
}

export const easeOut = (u, p = 2.2) => 1 - Math.pow(1 - clamp(u, 0, 1), p);
export const easeInOut = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
export { _q as tmpQ };
